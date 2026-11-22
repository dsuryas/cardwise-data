import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyCardCheck, cleanOffers, mergeOffers, offerId } from "../src/apply.ts";
import { acceptOffer, numbersBackedByQuote, type CardCheck, type Extractor, type ProposedOffer } from "../src/extract.ts";
import { htmlToText, isAllowedByRobots, pageContainsQuote, type Fetcher } from "../src/fetch.ts";
import { runPipeline, type Source } from "../src/run.ts";
import { nextVersion, validateCatalog, type Catalog } from "../src/schema.ts";
import { generateKeys, publicKeyFromPrivate, signBytes, verifyBytes } from "../src/sign.ts";

const load = (): Catalog => JSON.parse(readFileSync("catalog/catalog.json", "utf8"));
const TODAY = "2026-11-20";

describe("schema", () => {
  it("accepts the shipped catalog", () => {
    expect(validateCatalog(load()).problems).toEqual([]);
  });
  it("catches cross-reference and sanity problems", () => {
    const c = load();
    c.cards[0].rules[0].merchants = ["nope"];
    c.cards[1].rules[0].percent = 60;
    c.offers[0].validTo = "2000-01-01";
    const p = validateCatalog(c).problems.join("\n");
    expect(p).toMatch(/unknown merchant nope/);
    expect(p).toMatch(/implausible rate|less than or equal/);
    expect(p).toMatch(/ends before it starts/);
  });
  it("bumps versions per day", () => {
    expect(nextVersion("2026.11.18-1", "2026-11-18")).toBe("2026.11.18-2");
    expect(nextVersion("2026.11.18-9", "2026-11-20")).toBe("2026.11.20-1");
  });
});

describe("fetch helpers", () => {
  it("respects robots.txt", () => {
    const robots = "User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: BadBot\nDisallow: /";
    expect(isAllowedByRobots(robots, "/offers")).toBe(true);
    expect(isAllowedByRobots(robots, "/private/x")).toBe(false);
    expect(isAllowedByRobots(robots, "/private/ok/1")).toBe(true);
    expect(isAllowedByRobots("User-agent: CardWiseDataBot\nDisallow: /", "/x")).toBe(false);
    expect(isAllowedByRobots("", "/anything")).toBe(true);
  });
  it("turns html into text and finds quotes loosely", () => {
    const t = htmlToText("<div><script>x()</script><p>5% CashBack on&nbsp;Swiggy</p><td>Cap</td><td>Rs. 1,500</td></div>");
    expect(t).toContain("5% CashBack on Swiggy");
    expect(pageContainsQuote(t, "5%   cashback on SWIGGY")).toBe(true);
    expect(pageContainsQuote(t, "10% cashback on Swiggy")).toBe(false);
  });
  it("requires numbers to be in the quote", () => {
    expect(numbersBackedByQuote("10% instant discount up to ₹1,500 on min ₹5,000", [10, 1500, 5000])).toBe(true);
    expect(numbersBackedByQuote("10% instant discount", [10, 2000])).toBe(false);
  });
});

const page = `ICICI Bank Credit Card offers. Get 10% instant discount up to ₹1,500 on Amazon with ICICI Bank Credit Cards on a minimum purchase of ₹5,000. Valid till 30 Nov 2026.
Amazon Prime members can earn 5% back on purchases carried out on Amazon India. Get 1% back for all other payments. Earn 2% back on 100+ Amazon Pay merchant websites.`;

const goodOffer: ProposedOffer = {
  title: "10% off on Amazon with ICICI", merchantId: "amazon", issuer: "ICICI", percent: 10, maxBenefit: 1500, minTxn: 5000,
  validFrom: "2026-11-15", validTo: "2026-11-30", quote: "Get 10% instant discount up to ₹1,500 on Amazon with ICICI Bank Credit Cards on a minimum purchase of ₹5,000",
};

describe("offers", () => {
  it("accepts a well-backed offer and rejects invented ones", () => {
    expect(acceptOffer(page, goodOffer, TODAY).ok).toBe(true);
    expect(acceptOffer(page, { ...goodOffer, maxBenefit: 3000 }, TODAY).why).toMatch(/numbers/);
    expect(acceptOffer(page, { ...goodOffer, quote: "Flat 50% off everything" }, TODAY).why).toMatch(/quote/);
    expect(acceptOffer(page, { ...goodOffer, validTo: "2026-11-01" }, TODAY).why).toMatch(/expired/);
  });
  it("merges with stable ids and cleans expired + sample offers", () => {
    const c = load();
    const before = c.offers.length;
    const changes = mergeOffers(c, [goodOffer, goodOffer], page, "https://example.com/offers", TODAY);
    expect(changes.filter((x) => x.level === "SAFE")).toHaveLength(1);
    expect(c.offers).toHaveLength(before + 1);
    expect(c.offers.find((o) => o.id === offerId(goodOffer))?.issuers).toEqual(["ICICI"]);
    const cleaned = cleanOffers(c, TODAY, true);
    expect(c.offers.every((o) => !o.title.startsWith("Sample:"))).toBe(true);
    expect(cleaned.length).toBe(before);
    expect(validateCatalog(c).problems).toEqual([]);
  });
});

describe("card checks", () => {
  const same: CardCheck = {
    checks: [
      { ruleId: "apicici_amazon", status: "same", quote: "Amazon Prime members can earn 5% back on purchases carried out on Amazon India" },
      { ruleId: "apicici_base", status: "same", quote: "Get 1% back for all other payments" },
    ],
    newBenefits: [],
  };
  it("re-confirms unchanged rules safely", () => {
    const c = load();
    const ch = applyCardCheck(c, "amazon_pay_icici", same, page, "https://icici.example/faq", TODAY);
    expect(ch.map((x) => x.level)).toEqual(["SAFE"]);
    expect(c.cards.find((x) => x.id === "amazon_pay_icici")?.checkedOn).toBe(TODAY);
  });
  it("flags real changes as risky and applies them for review", () => {
    const c = load();
    const changedPage = page.replace("5% back on purchases", "3% back on purchases");
    const check: CardCheck = { checks: [{ ruleId: "apicici_amazon", status: "changed", percent: 3, quote: "Amazon Prime members can earn 3% back on purchases carried out on Amazon India" }], newBenefits: [] };
    const ch = applyCardCheck(c, "amazon_pay_icici", check, changedPage, "https://icici.example/faq", TODAY);
    expect(ch[0].level).toBe("RISKY");
    expect(c.cards.find((x) => x.id === "amazon_pay_icici")!.rules[0].percent).toBe(3);
  });
  it("ignores a hallucinated change", () => {
    const c = load();
    const check: CardCheck = { checks: [{ ruleId: "apicici_amazon", status: "changed", percent: 7, quote: "Prime members earn 7% back on Amazon" }], newBenefits: [] };
    const ch = applyCardCheck(c, "amazon_pay_icici", check, page, "https://icici.example/faq", TODAY);
    expect(ch[0].level).toBe("INFO");
    expect(c.cards.find((x) => x.id === "amazon_pay_icici")!.rules[0].percent).toBe(5);
  });
});

describe("end to end", () => {
  const fetcher: Fetcher = async (url) =>
    url.endsWith("/robots.txt") ? { status: 200, body: "User-agent: *\nDisallow: /blocked", contentType: "text/plain" }
      : { status: 200, body: `<html><body><p>${page.repeat(2)}</p></body></html>`, contentType: "text/html" };
  const fake: Extractor = {
    async checkCard() {
      return { checks: [{ ruleId: "apicici_amazon", status: "same", quote: "Amazon Prime members can earn 5% back on purchases carried out on Amazon India" }], newBenefits: [] };
    },
    async listOffers() {
      return [goodOffer];
    },
  };
  const sources: Source[] = [
    { id: "a", kind: "card", cardId: "amazon_pay_icici", url: "https://icici.example/faq" },
    { id: "b", kind: "offers", issuer: "ICICI", url: "https://icici.example/offers" },
    { id: "c", kind: "offers", issuer: "ICICI", url: "https://icici.example/blocked/page" },
  ];
  it("produces a valid, bumped catalog and a report", async () => {
    const r = await runPipeline(load(), sources, fake, TODAY, fetcher);
    expect(r.changed).toBe(true);
    expect(r.risky).toBe(0);
    expect(r.catalog.version).toBe("2026.11.20-1");
    expect(r.reportMd).toMatch(/new offer: 10% off on Amazon with ICICI/);
    expect(r.reportMd).toMatch(/robots.txt disallows/);
    expect(validateCatalog(r.catalog).problems).toEqual([]);
  });
  it("skips the AI for pages that haven't changed", async () => {
    const hashes = new Map<string, string>();
    let calls = 0;
    const counting: Extractor = { checkCard: async (...a) => (calls++, fake.checkCard(...a)), listOffers: async (...a) => (calls++, fake.listOffers(...a)) };
    await runPipeline(load(), sources, counting, TODAY, fetcher, hashes);
    const first = calls;
    const r2 = await runPipeline(load(), sources, counting, "2026-11-21", fetcher, hashes);
    expect(first).toBe(2);
    expect(calls).toBe(2); // second run: no AI calls
    expect(r2.reportMd).toMatch(/page unchanged since last check/);
  });
});

describe("signing", () => {
  it("round-trips and rejects tampering", () => {
    const k = generateKeys();
    expect(publicKeyFromPrivate(k.privateKeyB64)).toBe(k.publicKeyRawB64);
    const bytes = readFileSync("catalog/catalog.json");
    const sig = signBytes(bytes, k.privateKeyB64);
    expect(verifyBytes(bytes, sig, k.publicKeyRawB64)).toBe(true);
    expect(verifyBytes(Buffer.concat([bytes, Buffer.from(" ")]), sig, k.publicKeyRawB64)).toBe(false);
  });
});

it("a hanging source is abandoned after the deadline and the run continues", async () => {
  process.env.SOURCE_TIMEOUT_MS = "50";
  try {
    const catalog = JSON.parse(readFileSync("catalog/catalog.json", "utf8")) as Catalog;
    const before = JSON.stringify(catalog.offers);
    const hang = () => new Promise<never>(() => {});
    const fetcher: Fetcher = async () => ({ status: 200, body: "<p>" + "offer text ".repeat(50) + "</p>", contentType: "text/html" });
    const sources = [{ id: "slow", kind: "offers", url: "https://slow.example/x", issuer: "HDFC Bank" }] as Source[];
    const res = await runPipeline(catalog, sources, { checkCard: hang, listOffers: hang }, "2026-11-22", fetcher);
    expect(res.reportMd).toMatch(/slow skipped: gave up/);
    expect(JSON.stringify(res.catalog.offers)).toBe(before);
  } finally {
    delete process.env.SOURCE_TIMEOUT_MS;
  }
});
