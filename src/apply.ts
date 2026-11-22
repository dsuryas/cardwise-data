// Turning checked extractions into catalog changes, classified for review.
//  SAFE  → published automatically (re-confirmed rules, new/updated/expired offers, sample offers removed)
//  RISKY → opened as a pull request for a human (any change to a card's rates, caps or minimums)
//  INFO  → noted in the report only (rule not found on page, benefits we don't model, rejected extractions)
import { createHash } from "node:crypto";
import { pageContainsQuote } from "./fetch.ts";
import type { Catalog, Offer } from "./schema.ts";
import { acceptCheck, acceptOffer, checkOfferDate, type CardCheck, type ProposedOffer } from "./extract.ts";

export type Level = "SAFE" | "RISKY" | "INFO";
export interface Change {
  level: Level;
  what: string;
  quote?: string;
  source?: string;
}

export function applyCardCheck(c: Catalog, cardId: string, check: CardCheck, pageText: string, sourceUrl: string, today: string): Change[] {
  const card = c.cards.find((x) => x.id === cardId);
  if (!card) return [{ level: "INFO", what: `source points at unknown card ${cardId}` }];
  const changes: Change[] = [];
  let confirmed = 0;
  for (const chk of check.checks) {
    const rule = card.rules.find((r) => r.id === chk.ruleId);
    if (!rule) continue;
    const verdict = acceptCheck(pageText, chk);
    if (!verdict.ok) {
      changes.push({ level: "INFO", what: `${card.name} · ${rule.id}: extraction rejected (${verdict.why})`, quote: chk.quote, source: sourceUrl });
      continue;
    }
    if (chk.status === "same") {
      confirmed++;
      continue;
    }
    if (chk.status === "not_found") {
      changes.push({ level: "INFO", what: `${card.name} · ${rule.id} ("${rule.label}") not found on the page; check by hand`, source: sourceUrl });
      continue;
    }
    // changed → apply on the review branch, flagged RISKY so a human approves it.
    const before = JSON.stringify({ percent: rule.percent, units: rule.units, perRupees: rule.perRupees, minTxn: rule.minTxn, cap: rule.cap && card.caps?.find((x) => x.id === rule.cap)?.limit });
    if (chk.percent !== undefined) { rule.percent = chk.percent; delete rule.units; delete rule.perRupees; }
    if (chk.units !== undefined && chk.perRupees !== undefined) { rule.units = chk.units; rule.perRupees = chk.perRupees; delete rule.percent; }
    if (chk.minTxn !== undefined) rule.minTxn = chk.minTxn;
    if (chk.capLimit !== undefined && rule.cap) {
      const cap = card.caps?.find((x) => x.id === rule.cap);
      if (cap) cap.limit = chk.capLimit;
    }
    rule.source = sourceUrl;
    const after = JSON.stringify({ percent: rule.percent, units: rule.units, perRupees: rule.perRupees, minTxn: rule.minTxn, cap: rule.cap && card.caps?.find((x) => x.id === rule.cap)?.limit });
    changes.push({ level: "RISKY", what: `${card.name} · ${rule.id} ("${rule.label}") changed: ${before} → ${after}`, quote: chk.quote, source: sourceUrl });
  }
  for (const b of check.newBenefits) changes.push({ level: "INFO", what: `${card.name}: benefit not modelled yet: ${b.description}`, quote: b.quote, source: sourceUrl });
  if (confirmed > 0 && !changes.some((x) => x.level === "RISKY")) {
    const wasVerified = card.verified;
    card.verified = true;
    card.checkedOn = today;
    for (const r of card.rules) r.source ??= sourceUrl;
    changes.push({ level: "SAFE", what: `${card.name}: ${confirmed} rule(s) re-confirmed${wasVerified ? "" : " (now verified)"}`, source: sourceUrl });
  }
  return changes;
}

export function offerId(o: ProposedOffer): string {
  const h = createHash("sha256").update(`${o.merchantId}|${o.issuer ?? ""}|${(o.cardIds ?? []).join(",")}|${o.title.toLowerCase()}|${o.validTo}`).digest("hex").slice(0, 8);
  return `${o.merchantId}_${(o.issuer ?? "card").toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${h}`;
}

export function mergeOffers(c: Catalog, proposed: ProposedOffer[], pageText: string, sourceUrl: string, today: string): Change[] {
  const changes: Change[] = [];
  for (let p of proposed) {
    const stableId = offerId(p); // from the extracted offer, so capping an unconfirmed date doesn't change its id
    const verdict = acceptOffer(pageText, p, today);
    if (!verdict.ok) {
      changes.push({ level: "INFO", what: `offer "${p.title}" rejected (${verdict.why})`, quote: p.quote, source: sourceUrl });
      continue;
    }
    if (!c.merchants.some((m) => m.id === p.merchantId)) {
      changes.push({ level: "INFO", what: `offer "${p.title}" for unknown merchant ${p.merchantId}`, source: sourceUrl });
      continue;
    }
    const date = checkOfferDate(pageText, p, today);
    if (!date.backed) {
      changes.push({ level: "INFO", what: `offer "${p.title}": end date ${p.validTo} not confirmed on the page; kept until ${date.validTo} and re-read daily`, quote: p.dateQuote, source: sourceUrl });
      p = { ...p, validTo: date.validTo };
    }
    const offer: Offer = {
      id: stableId,
      title: p.title,
      merchants: [p.merchantId],
      ...(p.cardIds?.length ? { cards: p.cardIds } : { issuers: [p.issuer!] }),
      ...(p.percent !== undefined ? { percent: p.percent } : {}),
      ...(p.flat !== undefined ? { flat: p.flat } : {}),
      ...(p.maxBenefit !== undefined ? { maxBenefit: p.maxBenefit } : {}),
      ...(p.minTxn !== undefined ? { minTxn: p.minTxn } : {}),
      ...(p.paymentModes?.length ? { paymentModes: p.paymentModes } : {}),
      ...(p.days?.length ? { days: p.days as Offer["days"] } : {}),
      validFrom: p.validFrom,
      validTo: p.validTo,
      source: sourceUrl,
      quote: p.quote,
      checkedOn: today,
    };
    const idx = c.offers.findIndex((x) => x.id === offer.id);
    if (idx >= 0) {
      c.offers[idx] = offer;
    } else {
      c.offers.push(offer);
      changes.push({ level: "SAFE", what: `new offer: ${offer.title}`, quote: p.quote, source: sourceUrl });
    }
  }
  return changes;
}

/** An offer whose page was re-read today but no longer carries its wording has been withdrawn. */
export function dropVanishedOffers(c: Catalog, sourceUrl: string, pageText: string): Change[] {
  const changes: Change[] = [];
  c.offers = c.offers.filter((o) => {
    if (o.source !== sourceUrl || !o.quote || o.title.startsWith("Sample:")) return true;
    if (pageContainsQuote(pageText, o.quote)) return true;
    changes.push({ level: "SAFE", what: `offer no longer listed, removed: ${o.title}`, source: sourceUrl });
    return false;
  });
  return changes;
}

/** Drop expired offers, and the placeholder "Sample:" offers once real ones are flowing. */
export function cleanOffers(c: Catalog, today: string, dropSamples: boolean): Change[] {
  const changes: Change[] = [];
  c.offers = c.offers.filter((o) => {
    if (o.validTo < today) {
      changes.push({ level: "SAFE", what: `expired offer removed: ${o.title}` });
      return false;
    }
    if (dropSamples && o.title.startsWith("Sample:")) {
      changes.push({ level: "SAFE", what: `sample offer removed: ${o.title}` });
      return false;
    }
    return true;
  });
  return changes;
}

export function report(changes: Change[], version: string): string {
  const section = (level: Level, title: string) => {
    const xs = changes.filter((c) => c.level === level);
    if (!xs.length) return "";
    return `### ${title} (${xs.length})\n\n` + xs.map((c) => `- ${c.what}${c.quote ? `\n  > ${c.quote.replace(/\n/g, " ").slice(0, 300)}` : ""}${c.source ? `\n  [source](${c.source})` : ""}`).join("\n") + "\n\n";
  };
  return `## CardWise data update ${version}\n\n` +
    section("RISKY", "Needs your review: card terms changed") +
    section("SAFE", "Applied automatically") +
    section("INFO", "For information") +
    (changes.length ? "" : "No changes today.\n");
}
