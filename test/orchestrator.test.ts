import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dropVanishedOffers } from "../src/apply.ts";
import { checkOfferDate, datesInText, type Extractor, type ProposedOffer } from "../src/extract.ts";
import type { Fetcher } from "../src/fetch.ts";
import { runPipeline, type Source } from "../src/run.ts";
import type { Catalog } from "../src/schema.ts";

const TODAY = "2026-11-22";
const load = () => JSON.parse(readFileSync("catalog/catalog.json", "utf8")) as Catalog;
const html = (body: string) => `<html><body>${body}</body></html>`;
const pad = " Terms and conditions apply to all offers listed on this page. ".repeat(8);

describe("end dates", () => {
  it("reads the formats Indian bank pages use", () => {
    expect(datesInText("34 days left", TODAY)).toContain("2026-12-26");
    expect(datesInText("Valid till 31st Dec 2026", TODAY)).toContain("2026-12-31");
    expect(datesInText("Offer valid until December 31, 2026", TODAY)).toContain("2026-12-31");
    expect(datesInText("Offer period: 01/11/2026 to 31/12/2026", TODAY)).toContain("2026-12-31");
    expect(datesInText("till 15 Jan'27", TODAY)).toContain("2027-01-15");
  });
  it("keeps a date the page backs, and cuts an unbacked one to a week", () => {
    const page = "Get 10% off on Myntra. Valid till 31st Dec 2026.";
    const o = { title: "x", merchantId: "myntra", issuer: "ICICI", percent: 10, validFrom: TODAY, validTo: "2026-12-31", quote: "Get 10% off on Myntra", dateQuote: "Valid till 31st Dec 2026" } as ProposedOffer;
    expect(checkOfferDate(page, o, TODAY)).toEqual({ backed: true, validTo: "2026-12-31" });
    expect(checkOfferDate(page, { ...o, dateQuote: "Valid till 31st Jan 2027", validTo: "2027-01-31" }, TODAY)).toEqual({ backed: false, validTo: "2026-11-29" });
    expect(checkOfferDate(page, { ...o, dateQuote: undefined }, TODAY).backed).toBe(false);
  });
});

describe("card sources", () => {
  it("moves on to the terms PDF/fallback when the card page doesn't state the rates", async () => {
    const c = load();
    const card = c.cards.find((x) => x.id === "sbi_pulse")!;
    const fetcher: Fetcher = async (url) => url.endsWith("/robots.txt")
      ? { status: 404, body: "", contentType: "text/plain" }
      : { status: 200, body: html(url.includes("terms") ? `<p>Earn 10 Reward Points per Rs. 100 spent on Chemist, Pharmacy, Dining and Movies.</p>${pad}` : `<p>Apply for SBI Card PULSE today.</p>${pad}`), contentType: "text/html" };
    const pages: string[] = [];
    const ext: Extractor = {
      checkCard: async (_card, _cat, text) => {
        pages.push(text.includes("Earn 10") ? "terms" : "landing");
        return text.includes("Earn 10")
          ? { checks: [{ ruleId: card.rules[0].id, status: "same", quote: "Earn 10 Reward Points per Rs. 100 spent on Chemist, Pharmacy, Dining and Movies" }], newBenefits: [] }
          : { checks: card.rules.map((r) => ({ ruleId: r.id, status: "not_found" as const, quote: "" })), newBenefits: [] };
      },
      listOffers: async () => [],
    };
    const sources: Source[] = [{ id: "sbi_pulse", kind: "card", cardId: "sbi_pulse", url: "https://sbi.example/card", fallbackUrls: ["https://sbi.example/terms.html"] }];
    const res = await runPipeline(c, sources, ext, TODAY, fetcher);
    expect(pages).toEqual(["landing", "terms"]);
    expect(res.health.sbi_pulse.usedUrl).toBe("https://sbi.example/terms.html");
    expect(res.catalog.cards.find((x) => x.id === "sbi_pulse")?.checkedOn).toBe(TODAY);
  });
});

describe("offer orchestration", () => {
  const listing = html(`<p>Myntra: Get 10% off up to Rs 500. 34 days left</p><p>Swiggy: Flat Rs 100 off. 10 days left</p>
    <p>BookMyShow: 25% off. 5 days left</p><a href="/offers/croma-sale">Croma Sale</a><a href="/offers/login">Login</a>${pad}`);
  const detail = html(`<p>Croma: 10% instant discount up to Rs 3000 on ICICI Bank Credit Cards. Offer valid till 31st Dec 2026.</p>${pad}`);
  const fetcher: Fetcher = async (url) => url.endsWith("/robots.txt")
    ? { status: 404, body: "", contentType: "text/plain" }
    : { status: 200, body: url.includes("croma") ? detail : listing, contentType: "text/html" };
  const myntra: ProposedOffer = { title: "Myntra", merchantId: "myntra", issuer: "ICICI", percent: 10, maxBenefit: 500, validFrom: TODAY, validTo: "2026-12-26", quote: "Myntra: Get 10% off up to Rs 500", dateQuote: "Rs 500. 34 days left" };
  const swiggy: ProposedOffer = { title: "Swiggy", merchantId: "swiggy", issuer: "ICICI", flat: 100, validFrom: TODAY, validTo: "2026-12-02", quote: "Swiggy: Flat Rs 100 off", dateQuote: "100 off. 10 days left" };
  const bms: ProposedOffer = { title: "BMS", merchantId: "bookmyshow", issuer: "ICICI", percent: 50, validFrom: TODAY, validTo: "2026-11-27", quote: "BookMyShow: 25% off", dateQuote: "25% off. 5 days left" };
  const croma: ProposedOffer = { title: "Croma", merchantId: "croma", issuer: "ICICI", percent: 10, maxBenefit: 3000, validFrom: TODAY, validTo: "2026-12-31", quote: "Croma: 10% instant discount up to Rs 3000 on ICICI Bank Credit Cards", dateQuote: "Offer valid till 31st Dec 2026" };

  it("extractor + recall + verifier + link scout each do their part", async () => {
    const calls: string[] = [];
    const ext: Extractor = {
      checkCard: async () => ({ checks: [], newBenefits: [] }),
      listOffers: async (_c, text) => { calls.push("extract"); return text.includes("Croma:") ? [croma] : [myntra, bms]; },
      listMissedOffers: async (_c, _t, _d, _h, found) => { calls.push(`recall(${found.length})`); return [swiggy, myntra]; },
      verifyOffers: async (_c, _t, _d, offers) => { calls.push(`verify(${offers.length})`); return offers.map((o, i) => ({ index: i, ok: o.merchantId !== "bookmyshow", reason: o.merchantId === "bookmyshow" ? "page says 25%, not 50%" : "matches" })); },
      pickOfferLinks: async (_c, links) => { calls.push(`scout(${links.length})`); return links.filter((l) => l.href.includes("croma")).map((l) => l.href); },
    };
    const c = load();
    const sources: Source[] = [{ id: "offers_icici", kind: "offers", issuer: "ICICI", url: "https://bank.example/offers", followLinks: { max: 3, pattern: "/offers/" } }];
    const res = await runPipeline(c, sources, ext, TODAY, fetcher);
    expect(calls).toEqual(["extract", "recall(2)", "verify(3)", "scout(2)", "extract", "verify(1)"]);
    const titles = res.catalog.offers.filter((o) => !o.title.startsWith("Sample:")).map((o) => o.title).sort();
    expect(titles).toEqual(["Croma", "Myntra", "Swiggy"]);
    expect(res.catalog.offers.find((o) => o.title === "Croma")?.source).toBe("https://bank.example/offers/croma-sale");
    expect(res.reportMd).toMatch(/verifier rejected offer "BMS": page says 25%/);
    expect(res.health.offers_icici.detailPages).toBe(1);
  });

  it("removes an offer whose page no longer carries it", () => {
    const c = load();
    c.offers.push({ id: "gone", title: "Old Myntra deal", merchants: ["myntra"], issuers: ["ICICI"], percent: 10, validFrom: TODAY, validTo: "2026-12-31", source: "https://bank.example/offers", quote: "Myntra: Get 15% off up to Rs 900" } as never);
    const ch = dropVanishedOffers(c, "https://bank.example/offers", "Myntra: Get 10% off up to Rs 500");
    expect(ch.map((x) => x.what)).toEqual(["offer no longer listed, removed: Old Myntra deal"]);
    expect(c.offers.some((o) => o.id === "gone")).toBe(false);
  });
});
