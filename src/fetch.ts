// Fetching source pages politely: robots.txt respected, one request at a time, a clear user agent.
export const USER_AGENT = "CardWiseDataBot/1.0 (+https://github.com/; daily check of public card terms)";

export interface PageText {
  url: string;
  text: string;
  fetchedAt: string;
}

export type Fetcher = (url: string) => Promise<{ status: number; body: string; contentType: string }>;

export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,application/pdf;q=0.9,*/*;q=0.5" }, redirect: "follow" });
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("pdf") ? "" : await res.text();
  return { status: res.status, body, contentType };
};

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

export async function fetchPage(url: string, fetcher: Fetcher = httpFetcher, robotsCache = new Map<string, string>()): Promise<PageText> {
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
  const page = process.env.USE_BROWSER === "1" ? await browserFetch(url) : await fetcher(url);
  if (page.status >= 400) throw new Error(`HTTP ${page.status} for ${url}`);
  if (page.contentType.includes("pdf")) throw new Error(`PDF sources need the browser-less PDF step (not supported yet): ${url}`);
  return { url, text: htmlToText(page.body), fetchedAt: new Date().toISOString() };
}

/** JS-heavy pages (bank offer portals) render in headless Chromium when USE_BROWSER=1. */
async function browserFetch(url: string): Promise<{ status: number; body: string; contentType: string }> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    return { status: res?.status() ?? 0, body: await page.content(), contentType: "text/html" };
  } finally {
    await browser.close();
  }
}
