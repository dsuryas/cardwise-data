// Catalog format shared with the CardWise app (core/catalog/CatalogParser.kt).
// The app re-validates everything it downloads; these checks catch problems before publishing.
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9_]+$/, "ids are lowercase letters, digits and _");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const channel = z.enum(["ONLINE", "IN_STORE", "UPI_QR", "INTERNATIONAL"]);
const network = z.enum(["VISA", "MASTERCARD", "RUPAY", "AMEX", "DINERS"]);

export const Rule = z
  .object({
    id,
    label: z.string().min(1),
    merchants: z.array(id).optional(),
    categories: z.array(id).optional(),
    channels: z.array(channel).optional(),
    percent: z.number().min(0).max(100).optional(),
    units: z.number().min(0).optional(),
    perRupees: z.number().positive().optional(),
    cap: id.optional(),
    minTxn: z.number().min(0).optional(),
    stackable: z.boolean().optional(),
    validFrom: isoDate.optional(),
    validTo: isoDate.optional(),
    source: z.string().url().optional(),
  })
  .refine((r) => r.percent !== undefined || (r.units !== undefined && r.perRupees !== undefined), "needs percent or units/perRupees");

export const Cap = z.object({
  id,
  period: z.enum(["TRANSACTION", "STATEMENT_CYCLE", "CALENDAR_MONTH", "QUARTER", "YEAR"]),
  limit: z.number().positive(),
});

export const Card = z.object({
  id,
  issuer: z.string().min(1),
  name: z.string().min(1),
  network,
  currency: id,
  annualFee: z.number().min(0).optional(),
  feeWaiverSpend: z.number().min(0).optional(),
  family: id.optional(),
  tier: z.number().int().min(0).optional(),
  excludes: z.array(id).optional(),
  aliases: z.array(z.string()).optional(),
  verified: z.boolean().optional(),
  checkedOn: isoDate.optional(),
  caps: z.array(Cap).optional(),
  rules: z.array(Rule).min(1),
});

export const Offer = z.object({
  id,
  title: z.string().min(1),
  merchants: z.array(id).min(1),
  cards: z.array(id).optional(),
  issuers: z.array(z.string()).optional(),
  networks: z.array(network).optional(),
  type: z.enum(["INSTANT_DISCOUNT", "CASHBACK"]).optional(),
  percent: z.number().min(0).max(100).optional(),
  flat: z.number().min(0).optional(),
  minTxn: z.number().min(0).optional(),
  maxBenefit: z.number().positive().optional(),
  paymentModes: z.array(z.enum(["FULL", "EMI"])).optional(),
  days: z.array(z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"])).optional(),
  validFrom: isoDate,
  validTo: isoDate,
  event: z.string().optional(),
  source: z.string().url().optional(),
  /** Verbatim text from the source page that backs this offer (kept for audit, ignored by the app). */
  quote: z.string().optional(),
  checkedOn: isoDate.optional(),
});

export const Catalog = z
  .object({
    version: z.string().regex(/^\d{4}\.\d{2}\.\d{2}-\d+$/),
    note: z.string().optional(),
    currencies: z.array(z.object({ id, name: z.string(), kind: z.enum(["CASHBACK", "POINTS", "MILES"]), rupeesPerUnit: z.number().positive() })),
    categories: z.array(z.object({ id, name: z.string(), parent: id.optional(), keywords: z.array(z.string()).optional() })),
    merchants: z.array(
      z.object({ id, name: z.string(), category: id, online: z.boolean().optional(), aliases: z.array(z.string()).optional(), acceptsAmex: z.boolean().optional(), acceptsDiners: z.boolean().optional() }),
    ),
    cards: z.array(Card),
    offers: z.array(Offer),
    fees: z.array(
      z.object({
        id, label: z.string(), percent: z.number().min(0).max(10),
        categories: z.array(id).optional(), channels: z.array(channel).optional(), cards: z.array(id).optional(),
        waivedBetween: z.tuple([z.number(), z.number()]).optional(),
      }),
    ),
  })
  .passthrough();

export type Catalog = z.infer<typeof Catalog>;
export type Card = z.infer<typeof Card>;
export type Rule = z.infer<typeof Rule>;
export type Offer = z.infer<typeof Offer>;

/** Reward rate as an effective percent in rupees, the same sanity bound the app applies (≤ 33%). */
export function effectivePercent(c: Catalog, card: Card, r: Rule): number {
  const units = r.percent !== undefined ? r.percent / 100 : (r.units ?? 0) / (r.perRupees ?? 1);
  const value = c.currencies.find((x) => x.id === card.currency)?.rupeesPerUnit ?? 1;
  return units * value * 100;
}

/** Full structural + cross-reference validation. Returns a list of problems (empty = valid). */
export function validateCatalog(raw: unknown): { catalog?: Catalog; problems: string[] } {
  const parsed = Catalog.safeParse(raw);
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const c = parsed.data;
  const problems: string[] = [];
  const dup = (xs: string[], what: string) => {
    const seen = new Set<string>();
    for (const x of xs) {
      if (seen.has(x)) problems.push(`duplicate ${what} ${x}`);
      seen.add(x);
    }
  };
  const merchants = new Set(c.merchants.map((m) => m.id));
  const categories = new Set(c.categories.map((x) => x.id));
  const currencies = new Set(c.currencies.map((x) => x.id));
  const cards = new Set(c.cards.map((x) => x.id));
  dup(c.cards.map((x) => x.id), "card");
  dup(c.merchants.map((x) => x.id), "merchant");
  dup(c.categories.map((x) => x.id), "category");
  dup(c.offers.map((x) => x.id), "offer");
  dup(c.cards.flatMap((x) => x.rules.map((r) => r.id)), "rule");
  for (const cat of c.categories) if (cat.parent && !categories.has(cat.parent)) problems.push(`category ${cat.id}: unknown parent ${cat.parent}`);
  for (const m of c.merchants) if (!categories.has(m.category)) problems.push(`merchant ${m.id}: unknown category ${m.category}`);
  for (const card of c.cards) {
    if (!currencies.has(card.currency)) problems.push(`card ${card.id}: unknown currency`);
    for (const x of card.excludes ?? []) if (!categories.has(x)) problems.push(`card ${card.id}: unknown excluded category ${x}`);
    const caps = new Set((card.caps ?? []).map((x) => x.id));
    if (!card.rules.some((r) => !r.merchants?.length && !r.categories?.length && !r.channels?.length)) problems.push(`card ${card.id}: no base rule`);
    if (card.verified && !card.checkedOn) problems.push(`card ${card.id}: verified without checkedOn`);
    for (const r of card.rules) {
      const pct = effectivePercent(c, card, r);
      if (pct < 0 || pct > 33) problems.push(`rule ${r.id}: implausible rate ${pct.toFixed(2)}%`);
      if (r.cap && !caps.has(r.cap)) problems.push(`rule ${r.id}: cap ${r.cap} not on this card`);
      for (const m of r.merchants ?? []) if (!merchants.has(m)) problems.push(`rule ${r.id}: unknown merchant ${m}`);
      for (const x of r.categories ?? []) if (!categories.has(x)) problems.push(`rule ${r.id}: unknown category ${x}`);
      if (card.verified && !r.source) problems.push(`rule ${r.id}: verified card rule without source`);
    }
  }
  for (const o of c.offers) {
    if (o.validTo < o.validFrom) problems.push(`offer ${o.id}: ends before it starts`);
    for (const m of o.merchants) if (!merchants.has(m)) problems.push(`offer ${o.id}: unknown merchant ${m}`);
    for (const k of o.cards ?? []) if (!cards.has(k)) problems.push(`offer ${o.id}: unknown card ${k}`);
    if (!o.cards?.length && !o.issuers?.length) problems.push(`offer ${o.id}: needs cards or issuers`);
    if (o.percent === undefined && o.flat === undefined) problems.push(`offer ${o.id}: needs percent or flat`);
  }
  return { catalog: c, problems };
}

/** "2026.11.18-2" → next version for `today` (bumps the counter on the same day). */
export function nextVersion(current: string, today: string): string {
  const d = today.replaceAll("-", ".");
  const m = current.match(/^(\d{4}\.\d{2}\.\d{2})-(\d+)$/);
  if (m && m[1] === d) return `${d}-${Number(m[2]) + 1}`;
  return `${d}-1`;
}
