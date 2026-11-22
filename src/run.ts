// Daily run: fetch each source, extract with guardrails, apply, validate, bump version, write report.
// Outputs: catalog/catalog.json (updated), out/report.md, out/summary.json ({ changed, risky }).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyCardCheck, cleanOffers, dropVanishedOffers, mergeOffers, report, type Change } from "./apply.ts";
import { acceptCheck, extractorFromEnv, needsTerms, type Extractor, type ProposedOffer } from "./extract.ts";

const offerKey = (o: ProposedOffer) => `${o.merchantId}|${o.percent ?? ""}|${o.flat ?? ""}|${o.maxBenefit ?? ""}`;
import { fetchPage, httpFetcher, sitemapUrls, type Fetcher, type PageText } from "./fetch.ts";
import { nextVersion, validateCatalog, type Catalog } from "./schema.ts";

export interface Source {
  id: string;
  kind: "card" | "offers";
  url: string;
  /** Tried in order if `url` is blocked, empty, or (for cards) doesn't state the card's rates, e.g. the bank's terms PDF. */
  fallbackUrls?: string[];
  /** Offer listing pages: open up to `max` single-offer pages whose URL contains `pattern` (picked by the link scout). */
  followLinks?: { max: number; pattern?: string };
  /** Page draws its offers with scripts: render it in the browser straight away. */
  render?: boolean;
  /**
   * Discover offer pages from the bank's sitemap instead of a listing page: URLs containing `include`
   * and naming a merchant we track, most recently modified first, at most `max` a day.
   */
  sitemap?: { include: string; max: number };
  cardId?: string;
  issuer?: string;
  merchantId?: string;
  enabled?: boolean;
  note?: string;
}

/** Per-source outcome, kept across runs so a source that's been blocked for days stands out. */
export interface SourceHealth {
  ok: boolean;
  via?: string;
  usedUrl?: string;
  chars?: number;
  seconds: number;
  /** Offer detail pages opened via the link scout. */
  detailPages?: number;
  error?: string;
  lastOk?: string;
  failStreak: number;
}

export interface RunResult {
  catalog: Catalog;
  changes: Change[];
  changed: boolean;
  risky: number;
  reportMd: string;
  health: Record<string, SourceHealth>;
  /** Live catalog plus the RISKY changes, for the review pull request (null when nothing needs review). */
  reviewCatalog: Catalog | null;
}

/**
 * `pageHashes` (source id → hash of page text) lets unchanged pages skip the AI step entirely:
 * an unchanged card page just re-confirms the card; an unchanged offers page adds nothing new.
 */
async function fetchFirstWorking(s: Source, fetcher: Fetcher, robots: Map<string, string>, log: (m: string) => void): Promise<PageText> {
  const errors: string[] = [];
  for (const url of [s.url, ...(s.fallbackUrls ?? [])]) {
    try {
      log(`${s.id}: fetching ${url}`);
      const page = await fetchPage(url, fetcher, robots, { render: s.render });
      if (page.text.length < 200) throw new Error(`only ${page.text.length} chars of text`);
      return page;
    } catch (e) {
      errors.push(`${new URL(url).hostname}${new URL(url).pathname.slice(-40)}: ${(e as Error).message}`);
      log(`${s.id}:   failed: ${(e as Error).message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

function healthTable(sources: Source[], health: Record<string, SourceHealth>): string {
  const rows = sources.filter((x) => x.enabled !== false).map((s) => {
    const h = health[s.id];
    if (!h) return `| ${s.id} | – | not run | |`;
    if (h.ok) return `| ${s.id} | ✅ | ${h.via}, ${h.chars} chars, ${h.seconds}s${h.detailPages ? `, ${h.detailPages} offer pages` : ""} | ${h.usedUrl !== s.url ? "used fallback" : ""} |`;
    const since = h.failStreak > 1 ? `failing ${h.failStreak} runs${h.lastOk ? `, last OK ${h.lastOk}` : ""}` : "";
    return `| ${s.id} | ❌ | ${(h.error ?? "").slice(0, 160).replace(/\|/g, "/")} | ${since} |`;
  });
  return ["## Sources", "", "| source | ok | detail | note |", "|---|---|---|---|", ...rows, ""].join("\n");
}

/** Newest sitemap URLs under `include` whose slug names a merchant we track. */
export function pickFromSitemap(catalog: Catalog, urls: { loc: string; lastmod?: string }[], include: string, max: number): string[] {
  const tokens = catalog.merchants.flatMap((m) => [m.id.replace(/_/g, "-"), m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")])
    .filter((t) => t.length >= 3);
  return urls
    .filter((u) => u.loc.includes(include))
    .filter((u) => { const slug = new URL(u.loc).pathname.toLowerCase(); return tokens.some((t) => slug.includes(t)); })
    .sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""))
    .slice(0, max)
    .map((u) => u.loc);
}

/** Links on a listing page that name the merchant of an offer still missing its terms (cap, end date). */
export function termsLinks(catalog: Catalog, offers: ProposedOffer[], links: { href: string; text: string }[], exclude: Set<string>, max: number): string[] {
  const out: string[] = [];
  for (const o of offers.filter(needsTerms)) {
    const m = catalog.merchants.find((x) => x.id === o.merchantId);
    if (!m) continue;
    const words = [m.id.replace(/_/g, "-"), m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")].filter((w) => w.length >= 3);
    const hit = links.find((l) => !exclude.has(l.href) && !out.includes(l.href) &&
      words.some((w) => l.href.toLowerCase().includes(w) || l.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").includes(w)));
    if (hit) out.push(hit.href);
    if (out.length >= max) break;
  }
  return out;
}

/** One slow or hanging site must never stall the whole run. */
const sourceTimeoutMs = () => Number(process.env.SOURCE_TIMEOUT_MS ?? 360_000);

export async function runPipeline(
  catalog: Catalog, sources: Source[], extractor: Extractor, today: string,
  fetcher: Fetcher = httpFetcher, pageHashes: Map<string, string> = new Map(),
  previousHealth: Record<string, SourceHealth> = {},
): Promise<RunResult> {
  const health: Record<string, SourceHealth> = {};
  const before = JSON.stringify(catalog);
  const changes: Change[] = [];
  const robots = new Map<string, string>();
  let offerPagesRead = 0;

  const log = (msg: string) => { if (!process.env.VITEST) console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); };
  const secs = (t: number) => Math.round((Date.now() - t) / 1000);
  const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

  // ---- Orchestrator: code decides what runs; Gemini workers only read and judge pages. ----
  for (const s of sources.filter((x) => x.enabled !== false)) {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abandoned = false; // set when the deadline wins; late results must not touch the catalog
    const budgetMs = sourceTimeoutMs() + (s.followLinks?.max ?? 0) * 90_000 + (s.sitemap?.max ?? 0) * 60_000;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`gave up after ${Math.round(budgetMs / 1000)}s`)), budgetMs); });
    // Work is staged here and applied to the catalog only once the whole source has finished.
    const staged: (() => Change[])[] = [];
    const stagedHashes: [string, string][] = [];
    try {
      await Promise.race([deadline, (async () => {
        if (s.kind === "card" && s.cardId) {
          const card = catalog.cards.find((c) => c.id === s.cardId);
          if (!card) throw new Error(`unknown card ${s.cardId}`);
          const errors: string[] = [];
          let lastWeak: (() => Change[]) | undefined;
          let done = false;
          for (const url of [s.url, ...(s.fallbackUrls ?? [])]) {
            let page: PageText;
            try {
              log(`${s.id}: fetching ${url}`);
              page = await fetchPage(url, fetcher, robots);
              if (page.text.length < 200) throw new Error(`only ${page.text.length} chars of text`);
            } catch (e) {
              errors.push(`${new URL(url).hostname}: ${(e as Error).message}`);
              log(`${s.id}:   failed: ${(e as Error).message}`);
              continue;
            }
            log(`${s.id}: got ${page.text.length} chars via ${page.via} in ${secs(started)}s`);
            health[s.id] = { ok: true, via: page.via, usedUrl: page.url, chars: page.text.length, seconds: 0, failStreak: 0, lastOk: today };
            const key = `${s.id}@${url}`, hash = hashOf(page.text);
            if (pageHashes.get(key) === hash) {
              log(`${s.id}: page unchanged since it last confirmed the card, AI skipped`);
              staged.push(() => {
                if (!card.verified || card.checkedOn === today) return [];
                card.checkedOn = today;
                return [{ level: "SAFE", what: `${card.name}: page unchanged since last check, re-confirmed`, source: url }];
              });
              done = true;
              break;
            }
            const check = await extractor.checkCard(card, catalog, page.text);
            const strong = check.checks.filter((c) => c.status !== "not_found" && acceptCheck(page.text, c).ok).length;
            const apply = () => applyCardCheck(catalog, card.id, check, page.text, url, today);
            if (strong > 0) {
              staged.push(apply);
              stagedHashes.push([key, hash]);
              done = true;
              break;
            }
            log(`${s.id}: page doesn't state this card's rates; trying the next source`);
            lastWeak = apply;
          }
          if (!done) {
            if (lastWeak) staged.push(lastWeak);
            else throw new Error(errors.join(" | ") || "no source worked");
          }
          return;
        }

        if (s.kind === "offers" && s.sitemap) {
          const hint = { issuer: s.issuer, merchantId: s.merchantId };
          const all = await sitemapUrls(s.url, fetcher, robots);
          const picked = pickFromSitemap(catalog, all, s.sitemap.include, s.sitemap.max);
          log(`${s.id}: sitemap has ${all.length} URLs; reading the ${picked.length} newest offer pages for merchants we track`);
          health[s.id] = { ok: true, via: "sitemap", usedUrl: s.url, chars: all.length, seconds: 0, failStreak: 0, lastOk: today, detailPages: 0 };
          staged.push(() => { offerPagesRead++; return []; });
          for (const href of picked) {
            try {
              const detail = await fetchPage(href, fetcher, robots);
              health[s.id].detailPages = (health[s.id].detailPages ?? 0) + 1;
              const key = `${s.id}@${href}`, hash = hashOf(detail.text);
              if (pageHashes.get(key) === hash) continue;
              const found = await extractor.listOffers(catalog, detail.text, today, hint);
              let kept = found;
              const notes: Change[] = [];
              if (found.length && extractor.verifyOffers) {
                const verdicts = new Map((await extractor.verifyOffers(catalog, detail.text, today, found)).map((v) => [v.index, v]));
                kept = found.filter((o, i) => {
                  const v = verdicts.get(i);
                  if (v && !v.ok) { notes.push({ level: "INFO", what: `verifier rejected offer "${o.title}": ${v.reason}`, quote: o.quote, source: href }); return false; }
                  return true;
                });
              }
              staged.push(() => [...notes, ...mergeOffers(catalog, kept, detail.text, href, today), ...dropVanishedOffers(catalog, href, detail.text)]);
              stagedHashes.push([key, hash]);
            } catch (e) {
              staged.push(() => [{ level: "INFO", what: `offer page skipped: ${(e as Error).message}`, source: href }]);
            }
          }
          return;
        }

        if (s.kind === "offers") {
          const hint = { issuer: s.issuer, merchantId: s.merchantId };
          const page = await fetchFirstWorking(s, fetcher, robots, log);
          log(`${s.id}: got ${page.text.length} chars via ${page.via} in ${secs(started)}s`);
          health[s.id] = { ok: true, via: page.via, usedUrl: page.url, chars: page.text.length, seconds: 0, failStreak: 0, lastOk: today };
          staged.push(() => { offerPagesRead++; return []; });

          const readOffers = async (pg: PageText, recall: boolean) => {
            const found = await extractor.listOffers(catalog, pg.text, today, hint);
            let all = found;
            if (recall && extractor.listMissedOffers) {
              const missed = await extractor.listMissedOffers(catalog, pg.text, today, hint, found);
              const seen = new Set(found.map(offerKey));
              const fresh = missed.filter((o) => !seen.has(offerKey(o)));
              if (fresh.length) log(`${s.id}:   recall pass found ${fresh.length} more`);
              all = [...found, ...fresh];
            }
            const notes: Change[] = [];
            if (all.length && extractor.verifyOffers) {
              const verdicts = await extractor.verifyOffers(catalog, pg.text, today, all);
              const byIndex = new Map(verdicts.map((v) => [v.index, v]));
              all = all.filter((o, i) => {
                const v = byIndex.get(i);
                if (v && !v.ok) { notes.push({ level: "INFO", what: `verifier rejected offer "${o.title}": ${v.reason}`, quote: o.quote, source: pg.url }); return false; }
                return true;
              });
            }
            log(`${s.id}:   ${all.length} offer(s) kept from ${pg.url}`);
            return { offers: all, notes };
          };

          let listingOffers: ProposedOffer[] = [];
          const listingKey = `${s.id}@${page.url}`, listingHash = hashOf(page.text);
          if (pageHashes.get(listingKey) === listingHash) {
            log(`${s.id}: listing unchanged, AI skipped`);
          } else {
            const { offers, notes } = await readOffers(page, true);
            listingOffers = offers;
            staged.push(() => [...notes, ...mergeOffers(catalog, offers, page.text, page.url, today), ...dropVanishedOffers(catalog, page.url, page.text)]);
            stagedHashes.push([listingKey, listingHash]);
          }

          // Link scout → detail pages (each: extractor + verifier), plus targeted follow-ups for offers missing terms.
          if (s.followLinks && page.links?.length && extractor.pickOfferLinks) {
            const candidates = page.links.filter((l) => l.href !== page.url && (!s.followLinks!.pattern || l.href.includes(s.followLinks!.pattern)));
            const scouted = await extractor.pickOfferLinks(catalog, candidates, hint, s.followLinks.max);
            const followUps = termsLinks(catalog, listingOffers, page.links.filter((l) => l.href !== page.url), new Set(scouted), 3);
            if (followUps.length) log(`${s.id}: following ${followUps.length} link(s) for offers missing their terms`);
            const picked = [...scouted, ...followUps];
            log(`${s.id}: link scout picked ${picked.length} of ${candidates.length} links`);
            let opened = 0;
            for (const href of picked) {
              try {
                const detail = await fetchPage(href, fetcher, robots);
                opened++;
                const key = `${s.id}@${href}`, hash = hashOf(detail.text);
                if (pageHashes.get(key) === hash) { log(`${s.id}:   ${href} unchanged, AI skipped`); continue; }
                const { offers, notes } = await readOffers(detail, false);
                staged.push(() => [...notes, ...mergeOffers(catalog, offers, detail.text, href, today), ...dropVanishedOffers(catalog, href, detail.text)]);
                stagedHashes.push([key, hash]);
              } catch (e) {
                staged.push(() => [{ level: "INFO", what: `offer page skipped: ${(e as Error).message}`, source: href }]);
              }
            }
            health[s.id].detailPages = opened;
          }
        }
      })()]);
      if (abandoned) continue;
      for (const run of staged) changes.push(...run());
      // Only remember pages once fully processed, so a failed run retries them tomorrow.
      for (const [k, h] of stagedHashes) pageHashes.set(k, h);
      log(`${s.id}: done in ${secs(started)}s`);
      if (health[s.id]) health[s.id].seconds = secs(started);
    } catch (e) {
      abandoned = true;
      log(`${s.id}: skipped after ${secs(started)}s: ${(e as Error).message}`);
      changes.push({ level: "INFO", what: `source ${s.id} skipped: ${(e as Error).message}`, source: s.url });
      const prev = previousHealth[s.id];
      health[s.id] = { ...(health[s.id] ?? {}), ok: false, error: (e as Error).message, seconds: secs(started),
        failStreak: (prev?.failStreak ?? 0) + 1, lastOk: prev?.lastOk };
    } finally {
      clearTimeout(timer);
    }
  }
  changes.push(...cleanOffers(catalog, today, offerPagesRead > 0));

  const changed = JSON.stringify(catalog) !== before;
  if (changed) catalog.version = nextVersion(catalog.version, today);
  const { problems } = validateCatalog(catalog);
  if (problems.length) throw new Error("Updated catalog is invalid, nothing written:\n" + problems.join("\n"));
  const riskyChanges = changes.filter((c) => c.level === "RISKY");
  const risky = riskyChanges.length;
  let reviewCatalog: Catalog | null = null;
  if (risky) {
    reviewCatalog = structuredClone(catalog);
    for (const ch of riskyChanges) ch.applyTo?.(reviewCatalog);
    reviewCatalog.version = nextVersion(catalog.version, today);
    const review = validateCatalog(reviewCatalog);
    if (review.problems.length) {
      changes.push({ level: "INFO", what: "proposed card-term changes would make the catalog invalid; not opened for review: " + review.problems.join("; ") });
      reviewCatalog = null;
    }
  }
  return { catalog, changes, changed, risky: reviewCatalog ? risky : 0, reportMd: report(changes, catalog.version) + "\n" + healthTable(sources, health), health, reviewCatalog };
}

async function main() {
  const today = process.env.TODAY ?? new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // IST date
  const catalog = JSON.parse(readFileSync("catalog/catalog.json", "utf8")) as Catalog;
  const sources = JSON.parse(readFileSync("sources/sources.json", "utf8")).sources as Source[];
  const cachePath = process.env.PAGE_CACHE ?? ".cache/pages.json";
  // The page cache is only valid for the catalog it produced. If the live catalog differs (a run whose
  // results went to an unmerged review PR, or a manual edit), forget it so every page is read again.
  const cached = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const cacheValid = cached && cached.catalogVersion === catalog.version && cached.hashes;
  if (!cacheValid && existsSync(cachePath)) console.log(`page cache is for catalog ${cached?.catalogVersion ?? "unknown"}, live is ${catalog.version}: re-reading every page`);
  const hashes = new Map<string, string>(cacheValid ? Object.entries(cached.hashes) : []);
  const healthPath = ".cache/health.json";
  const prevHealth = existsSync(healthPath) ? JSON.parse(readFileSync(healthPath, "utf8")) : {};
  const result = await runPipeline(catalog, sources, extractorFromEnv(), today, httpFetcher, hashes, prevHealth);
  mkdirSync(".cache", { recursive: true });
  writeFileSync(healthPath, JSON.stringify(result.health, null, 2));
  mkdirSync(dirname(cachePath), { recursive: true });
  // Remember which catalog these hashes describe: the one now going live.
  writeFileSync(cachePath, JSON.stringify({ catalogVersion: result.catalog.version, hashes: Object.fromEntries(hashes) }, null, 2));
  mkdirSync("out", { recursive: true });
  if (result.changed) writeFileSync("catalog/catalog.json", JSON.stringify(result.catalog, null, 2) + "\n");
  writeFileSync("out/report.md", result.reportMd);
  if (result.reviewCatalog) writeFileSync("out/catalog.review.json", JSON.stringify(result.reviewCatalog, null, 2) + "\n");
  writeFileSync("out/summary.json", JSON.stringify({ changed: result.changed, risky: result.risky, version: result.catalog.version }));
  writeFileSync("out/health.json", JSON.stringify(result.health, null, 2));
  console.log(result.reportMd);
  process.exit(0); // don't wait on any abandoned request still winding down
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
