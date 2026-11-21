// Daily run: fetch each source, extract with guardrails, apply, validate, bump version, write report.
// Outputs: catalog/catalog.json (updated), out/report.md, out/summary.json ({ changed, risky }).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyCardCheck, cleanOffers, mergeOffers, report, type Change } from "./apply.ts";
import { ClaudeExtractor, type Extractor } from "./extract.ts";
import { fetchPage, httpFetcher, type Fetcher } from "./fetch.ts";
import { nextVersion, validateCatalog, type Catalog } from "./schema.ts";

export interface Source {
  id: string;
  kind: "card" | "offers";
  url: string;
  cardId?: string;
  issuer?: string;
  merchantId?: string;
  enabled?: boolean;
  note?: string;
}

export interface RunResult {
  catalog: Catalog;
  changes: Change[];
  changed: boolean;
  risky: number;
  reportMd: string;
}

/**
 * `pageHashes` (source id → hash of page text) lets unchanged pages skip the AI step entirely:
 * an unchanged card page just re-confirms the card; an unchanged offers page adds nothing new.
 */
export async function runPipeline(
  catalog: Catalog, sources: Source[], extractor: Extractor, today: string,
  fetcher: Fetcher = httpFetcher, pageHashes: Map<string, string> = new Map(),
): Promise<RunResult> {
  const before = JSON.stringify(catalog);
  const changes: Change[] = [];
  const robots = new Map<string, string>();
  let offerPagesRead = 0;

  for (const s of sources.filter((x) => x.enabled !== false)) {
    try {
      const page = await fetchPage(s.url, fetcher, robots);
      if (page.text.length < 200) throw new Error("page has almost no text (needs USE_BROWSER=1?)");
      const hash = createHash("sha256").update(page.text).digest("hex");
      const unchanged = pageHashes.get(s.id) === hash;
      if (unchanged) {
        if (s.kind === "card" && s.cardId) {
          const card = catalog.cards.find((c) => c.id === s.cardId);
          if (card?.verified && card.checkedOn !== today) {
            card.checkedOn = today;
            changes.push({ level: "SAFE", what: `${card.name}: page unchanged since last check, re-confirmed`, source: s.url });
          }
        }
        if (s.kind === "offers") offerPagesRead++;
        continue;
      }
      if (s.kind === "card" && s.cardId) {
        const card = catalog.cards.find((c) => c.id === s.cardId);
        if (!card) throw new Error(`unknown card ${s.cardId}`);
        const check = await extractor.checkCard(card, catalog, page.text);
        changes.push(...applyCardCheck(catalog, s.cardId, check, page.text, s.url, today));
      } else if (s.kind === "offers") {
        const offers = await extractor.listOffers(catalog, page.text, today, { issuer: s.issuer, merchantId: s.merchantId });
        changes.push(...mergeOffers(catalog, offers, page.text, s.url, today));
        offerPagesRead++;
      }
      // Only remember the page once it was fully processed, so a failed run retries it tomorrow.
      pageHashes.set(s.id, hash);
    } catch (e) {
      changes.push({ level: "INFO", what: `source ${s.id} skipped: ${(e as Error).message}`, source: s.url });
    }
  }
  changes.push(...cleanOffers(catalog, today, offerPagesRead > 0));

  const changed = JSON.stringify(catalog) !== before;
  if (changed) catalog.version = nextVersion(catalog.version, today);
  const { problems } = validateCatalog(catalog);
  if (problems.length) throw new Error("Updated catalog is invalid, nothing written:\n" + problems.join("\n"));
  const risky = changes.filter((c) => c.level === "RISKY").length;
  return { catalog, changes, changed, risky, reportMd: report(changes, catalog.version) };
}

async function main() {
  const today = process.env.TODAY ?? new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // IST date
  const catalog = JSON.parse(readFileSync("catalog/catalog.json", "utf8")) as Catalog;
  const sources = JSON.parse(readFileSync("sources/sources.json", "utf8")).sources as Source[];
  const cachePath = process.env.PAGE_CACHE ?? ".cache/pages.json";
  const hashes = new Map<string, string>(existsSync(cachePath) ? Object.entries(JSON.parse(readFileSync(cachePath, "utf8"))) : []);
  const result = await runPipeline(catalog, sources, new ClaudeExtractor(), today, httpFetcher, hashes);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(Object.fromEntries(hashes), null, 2));
  mkdirSync("out", { recursive: true });
  if (result.changed) writeFileSync("catalog/catalog.json", JSON.stringify(result.catalog, null, 2) + "\n");
  writeFileSync("out/report.md", result.reportMd);
  writeFileSync("out/summary.json", JSON.stringify({ changed: result.changed, risky: result.risky, version: result.catalog.version }));
  console.log(result.reportMd);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
