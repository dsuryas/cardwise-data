// Fetching source pages politely: robots.txt respected, one request at a time, a clear user agent.
export const USER_AGENT = "CardWiseDataBot/1.0 (+https://github.com/; daily check of public card terms)";

export interface PageText {
  url: string;
  text: string;
  fetchedAt: string;
  /** How we got it: plain HTTP, headless browser, or a PDF. */
  via: "http" | "browser" | "pdf";
  /** Same-site links on the page (for following offer detail pages). */
  links?: { href: string; text: string }[];
}

/** Same-host links with their visible text, de-duplicated. */
export function extractLinks(html: string, baseUrl: string): { href: string; text: string }[] {
  const base = new URL(baseUrl);
  const seen = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u: URL;
    try { u = new URL(m[1].replace(/&amp;/g, "&"), base); } catch { continue; }
    if (u.host !== base.host || !/^https?:$/.test(u.protocol)) continue;
    u.hash = "";
    const href = u.toString();
    if (href === base.toString()) continue;
    const text = htmlToText(m[2]).replace(/\s+/g, " ").trim();
    if (!seen.has(href) || (text && !seen.get(href))) seen.set(href, text);
  }
  return [...seen].map(([href, text]) => ({ href, text }));
}

export interface Fetched { status: number; body: string; contentType: string; bytes?: Uint8Array }
export type Fetcher = (url: string) => Promise<Fetched>;

const MAX_DOWNLOAD = 15 * 1024 * 1024;

export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,application/pdf;q=0.9,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  const contentType = res.headers.get("content-type") ?? "";
  if (isPdf(url, contentType)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_DOWNLOAD) throw new Error(`PDF too large (${buf.byteLength} bytes)`);
    return { status: res.status, body: "", contentType, bytes: buf };
  }
  return { status: res.status, body: await res.text(), contentType };
};

function isPdf(url: string, contentType: string): boolean {
  return contentType.includes("pdf") || /\.pdf($|\?)/i.test(url);
}

/** Text from a PDF (bank MITC / terms documents). Lines kept so table rows stay together. */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) throw new Error("not a PDF (likely a block page)");
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text.join("\n") : text).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** Minimal robots.txt check for our user agent / "*" group. Missing robots.txt = allowed. */
export function isAllowedByRobots(robotsTxt: string, path: string, agent = "CardWiseDataBot"): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      if (value || key === "allow") current.rules.push({ allow: key === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)));
  const group = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } = { allow: true, len: -1 };
  for (const g of group)
    for (const r of g.rules) {
      if (r.path === "") continue;
      const pattern = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
      if (pattern.test(path) && r.path.length > best.len) best = { allow: r.allow, len: r.path.length };
    }
  return best.allow;
}

/** Strip a page down to readable text: drop scripts/styles/nav noise, keep table cells apart. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/td|\/th)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#8377;|&#x20b9;/gi, "₹")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Whitespace/punctuation-insensitive containment, used to check that a quoted line really is on the page. */
export function normalizeForQuote(s: string): string {
  return s.toLowerCase().replace(/rs\.?\s*/g, "₹").replace(/[^\p{L}\p{N}₹%]+/gu, " ").trim();
}

export function pageContainsQuote(pageText: string, quote: string): boolean {
  const q = normalizeForQuote(quote);
  return q.length >= 12 && normalizeForQuote(pageText).includes(q);
}

export async function fetchPage(url: string, fetcher: Fetcher = httpFetcher, robotsCache = new Map<string, string>(), opts: { render?: boolean } = {}): Promise<PageText> {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    try {
      const r = await fetcher(`${u.origin}/robots.txt`);
      robotsCache.set(u.origin, r.status === 200 ? r.body : "");
    } catch {
      robotsCache.set(u.origin, "");
    }
  }
  if (!isAllowedByRobots(robotsCache.get(u.origin) ?? "", u.pathname + u.search)) {
    throw new Error(`robots.txt disallows ${url}`);
  }
  // Pages known to draw their content with scripts go straight to the browser.
  if (opts.render && process.env.USE_BROWSER === "1") {
    const rendered = await browserFetch(url);
    if (rendered.status >= 400) throw new Error(`HTTP ${rendered.status} in browser${rendered.status === 403 ? " (blocked)" : ""}`);
    const text = htmlToText(rendered.body);
    if (looksBlocked(text)) throw new Error("bot-check page returned in browser (blocked)");
    return { url, text, fetchedAt: new Date().toISOString(), via: "browser", links: extractLinks(rendered.body, url) };
  }
  // Plain request first (fast, honest). Fall back to a real browser only for script-rendered pages.
  const page = await fetcher(url);
  if (page.status >= 400) throw new Error(`HTTP ${page.status}${page.status === 403 ? " (blocked)" : ""}`);
  if (isPdf(url, page.contentType)) {
    if (!page.bytes) throw new Error("PDF had no content");
    return { url, text: await pdfToText(page.bytes), fetchedAt: new Date().toISOString(), via: "pdf" };
  }
  let text = htmlToText(page.body);
  if (looksBlocked(text)) throw new Error("bot-check page returned (blocked)");
  if (text.length < MIN_TEXT && process.env.USE_BROWSER === "1") {
    const rendered = await browserFetch(url);
    if (rendered.status >= 400) throw new Error(`HTTP ${rendered.status} in browser${rendered.status === 403 ? " (blocked)" : ""}`);
    text = htmlToText(rendered.body);
    if (looksBlocked(text)) throw new Error("bot-check page returned in browser (blocked)");
    return { url, text, fetchedAt: new Date().toISOString(), via: "browser", links: extractLinks(rendered.body, url) };
  }
  return { url, text, fetchedAt: new Date().toISOString(), via: "http", links: extractLinks(page.body, url) };
}

/** URLs (with last-modified dates) from a sitemap, after the same robots.txt check as pages. */
export async function sitemapUrls(url: string, fetcher: Fetcher = httpFetcher, robotsCache = new Map<string, string>()): Promise<{ loc: string; lastmod?: string }[]> {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    try { const r = await fetcher(`${u.origin}/robots.txt`); robotsCache.set(u.origin, r.status === 200 ? r.body : ""); } catch { robotsCache.set(u.origin, ""); }
  }
  if (!isAllowedByRobots(robotsCache.get(u.origin) ?? "", u.pathname)) throw new Error(`robots.txt disallows ${url}`);
  const r = await fetcher(url);
  if (r.status >= 400) throw new Error(`HTTP ${r.status} for sitemap`);
  return [...r.body.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
    loc: (m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/) ?? [])[1] ?? "",
    lastmod: (m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/) ?? [])[1],
  })).filter((x) => x.loc);
}

/** Below this much text a page is a shell that needs scripts (or a block page). */
export const MIN_TEXT = 400;

/** Common bot-protection interstitials. We stop; we never try to get past them. */
export function looksBlocked(text: string): boolean {
  return text.length < 3000 && /access denied|request blocked|attention required|are you a robot|verify you are human|captcha|reference #\s*\d+\.[0-9a-f]+|incapsula incident|pardon our interruption/i.test(text);
}

/** JS-heavy pages (bank offer portals) render in headless Chromium when USE_BROWSER=1. */
async function browserFetch(url: string): Promise<{ status: number; body: string; contentType: string }> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    // Bank portals keep analytics connections open, so "networkidle" may never come: load the DOM, then give scripts a moment.
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    return { status: res?.status() ?? 0, body: await page.content(), contentType: "text/html" };
  } finally {
    await browser.close();
  }
}
