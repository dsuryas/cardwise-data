// LLM extraction with guardrails (Gemini by default; Grok or Claude optional). The model never edits the catalog freely:
//  - card pages: it CHECKS each existing rule (same / changed / not found) and must quote the page
//  - offer pages: it lists offers using only ids we give it, each with a verbatim quote
// Every quote is then checked against the page text, and every number against its quote.
import Anthropic from "@anthropic-ai/sdk";
import type { Card, Catalog, Rule } from "./schema.ts";
import { pageContainsQuote } from "./fetch.ts";

export interface RuleCheck {
  ruleId: string;
  status: "same" | "changed" | "not_found";
  percent?: number;
  units?: number;
  perRupees?: number;
  capLimit?: number;
  minTxn?: number;
  quote: string;
}

export interface CardCheck {
  checks: RuleCheck[];
  /** Benefits on the page that no rule covers yet; for a human to consider. */
  newBenefits: { description: string; quote: string }[];
}

export interface ProposedOffer {
  title: string;
  merchantId: string;
  issuer?: string;
  cardIds?: string[];
  percent?: number;
  flat?: number;
  maxBenefit?: number;
  minTxn?: number;
  validFrom: string;
  validTo: string;
  paymentModes?: ("FULL" | "EMI")[];
  days?: string[];
  quote: string;
  /** Verbatim page text stating when the offer ends ("Valid till 31st Dec 2026", "34 days left"). */
  dateQuote?: string;
}

export interface OfferHint { issuer?: string; merchantId?: string }
export interface OfferVerdict { index: number; ok: boolean; reason: string }

/**
 * Workers the orchestrator (run.ts) dispatches. Only checkCard and listOffers are required;
 * the rest strengthen recall and precision when the provider supports them.
 */
export interface Extractor {
  checkCard(card: Card, catalog: Catalog, pageText: string): Promise<CardCheck>;
  listOffers(catalog: Catalog, pageText: string, today: string, hint: OfferHint): Promise<ProposedOffer[]>;
  /** Recall worker: an independent second read, told what was already found, asked only for what's missing. */
  listMissedOffers?(catalog: Catalog, pageText: string, today: string, hint: OfferHint, found: ProposedOffer[]): Promise<ProposedOffer[]>;
  /** Verifier: adversarially re-checks each offer against the page. */
  verifyOffers?(catalog: Catalog, pageText: string, today: string, offers: ProposedOffer[]): Promise<OfferVerdict[]>;
  /** Link scout: picks which offer-detail pages are worth opening. */
  pickOfferLinks?(catalog: Catalog, links: { href: string; text: string }[], hint: OfferHint, max: number): Promise<string[]>;
}

const MAX_PAGE_CHARS = 60_000;

function describeRule(card: Card, r: Rule): string {
  const cap = r.cap ? card.caps?.find((c) => c.id === r.cap) : undefined;
  const rate = r.percent !== undefined ? `${r.percent}%` : `${r.units} per ₹${r.perRupees}`;
  const scope = [r.merchants?.length ? `merchants=${r.merchants.join(",")}` : "", r.categories?.length ? `categories=${r.categories.join(",")}` : "", r.channels?.length ? `channels=${r.channels.join(",")}` : ""]
    .filter(Boolean).join(" ") || "base rate (everything else)";
  return `- ${r.id}: "${r.label}" ${rate} ${scope}${cap ? ` cap=${cap.limit}/${cap.period}` : ""}${r.minTxn ? ` minTxn=${r.minTxn}` : ""}`;
}

/** Shared prompts and schemas; each provider only implements one forced tool call. */
abstract class LlmExtractor implements Extractor {
  protected abstract tool<T>(name: string, description: string, schema: Record<string, unknown>, prompt: string): Promise<T>;

  async checkCard(card: Card, _catalog: Catalog, pageText: string): Promise<CardCheck> {
    const prompt = [
      `You are checking a credit card's reward rules against the issuer's own web page. Card: ${card.name} (${card.issuer}).`,
      `Our current rules:`,
      ...card.rules.map((r) => describeRule(card, r)),
      ``,
      `For EACH rule id, report whether the page states the same rate/cap/minimum ("same"), different values ("changed", give the new numbers), or doesn't mention it ("not_found").`,
      `"quote" must be copied character-for-character from the page (one sentence or table row that states the numbers). Never invent or paraphrase quotes.`,
      `Also list reward benefits on the page that none of our rules cover, each with a verbatim quote. Ignore welcome gifts, lounges and insurance.`,
      ``,
      `PAGE TEXT:`,
      pageText.slice(0, MAX_PAGE_CHARS),
    ].join("\n");
    return this.tool<CardCheck>("report_rule_checks", "Report the result of checking each rule", {
      type: "object",
      required: ["checks", "newBenefits"],
      properties: {
        checks: {
          type: "array",
          items: {
            type: "object",
            required: ["ruleId", "status", "quote"],
            properties: {
              ruleId: { type: "string", enum: card.rules.map((r) => r.id) },
              status: { type: "string", enum: ["same", "changed", "not_found"] },
              percent: { type: "number" }, units: { type: "number" }, perRupees: { type: "number" },
              capLimit: { type: "number" }, minTxn: { type: "number" },
              quote: { type: "string" },
            },
          },
        },
        newBenefits: { type: "array", items: { type: "object", required: ["description", "quote"], properties: { description: { type: "string" }, quote: { type: "string" } } } },
      },
    }, prompt);
  }

  private offerSchema(catalog: Catalog): Record<string, unknown> {
    const issuers = [...new Set(catalog.cards.map((c) => c.issuer))];
    return {
      type: "object",
      required: ["offers"],
      properties: {
        offers: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "merchantId", "validFrom", "validTo", "quote", "dateQuote"],
            properties: {
              title: { type: "string" },
              merchantId: { type: "string", enum: catalog.merchants.map((m) => m.id) },
              issuer: { type: "string", enum: issuers },
              cardIds: { type: "array", items: { type: "string", enum: catalog.cards.map((c) => c.id) } },
              percent: { type: "number" }, flat: { type: "number" }, maxBenefit: { type: "number" }, minTxn: { type: "number" },
              validFrom: { type: "string" }, validTo: { type: "string" },
              paymentModes: { type: "array", items: { type: "string", enum: ["FULL", "EMI"] } },
              days: { type: "array", items: { type: "string", enum: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] } },
              quote: { type: "string" },
              dateQuote: { type: "string" },
            },
          },
        },
      },
    };
  }

  private offerRules(catalog: Catalog, today: string, hint: OfferHint): string[] {
    const issuers = [...new Set(catalog.cards.map((c) => c.issuer))];
    return [
      hint.issuer ? `The page belongs to the card issuer "${hint.issuer}".` : "",
      hint.merchantId ? `The page belongs to the merchant id "${hint.merchantId}".` : "",
      `Use ONLY these merchant ids (skip offers for other merchants): ${catalog.merchants.map((m) => `${m.id}=${m.name}`).join(", ")}.`,
      `Use ONLY these issuer names: ${issuers.join(", ")}. If an offer is limited to specific cards, use these card ids: ${catalog.cards.map((c) => `${c.id}=${c.name}`).join(", ")}.`,
      `Only credit-card offers (skip offers that are debit-card or net-banking only).`,
      `Today is ${today}. Dates as YYYY-MM-DD. If the page says "N days left", validTo = today + N days. If it gives no end date at all, skip the offer.`,
      `"quote" must be copied character-for-character from the page and contain the offer's numbers. "dateQuote" must be copied character-for-character from the page and state the end date or the days left.`,
    ].filter(Boolean);
  }

  /** Extractor worker. */
  async listOffers(catalog: Catalog, pageText: string, today: string, hint: OfferHint): Promise<ProposedOffer[]> {
    const prompt = [
      `List the credit-card offers on this page that are still valid on ${today}.`,
      ...this.offerRules(catalog, today, hint),
      ``, `PAGE TEXT:`, pageText.slice(0, MAX_PAGE_CHARS),
    ].join("\n");
    const out = await this.tool<{ offers: ProposedOffer[] }>("report_offers", "Report the offers found", this.offerSchema(catalog), prompt);
    return out.offers ?? [];
  }

  /** Recall worker. */
  async listMissedOffers(catalog: Catalog, pageText: string, today: string, hint: OfferHint, found: ProposedOffer[]): Promise<ProposedOffer[]> {
    const prompt = [
      `Another reader already extracted the offers listed below from this page. Your only job is to find credit-card offers it MISSED.`,
      `Read the whole page carefully, including tables and fine print. Return only offers that are not already in the list (an empty list is fine).`,
      ...this.offerRules(catalog, today, hint),
      ``, `ALREADY FOUND:`,
      found.length ? found.map((o) => `- ${o.title} | ${o.merchantId} | ${o.percent ?? ""}${o.percent !== undefined ? "%" : ""}${o.flat !== undefined ? `₹${o.flat}` : ""} | ends ${o.validTo}`).join("\n") : "(nothing)",
      ``, `PAGE TEXT:`, pageText.slice(0, MAX_PAGE_CHARS),
    ].join("\n");
    const out = await this.tool<{ offers: ProposedOffer[] }>("report_missed_offers", "Report only the offers that were missed", this.offerSchema(catalog), prompt);
    return out.offers ?? [];
  }

  /** Verifier worker. */
  async verifyOffers(catalog: Catalog, pageText: string, today: string, offers: ProposedOffer[]): Promise<OfferVerdict[]> {
    if (!offers.length) return [];
    const prompt = [
      `You are an auditor. Each offer below was extracted from the page by someone else and may be wrong.`,
      `For each, check against the page: is it really a credit-card offer; is the merchant right; are the percent / flat amount / maximum benefit / minimum transaction exactly as the page states;`,
      `is the end date right (today is ${today}; "N days left" means today + N); if issuer or card ids are given, does the page support them.`,
      `ok=true only if every given field is supported by the page. Give a short reason either way.`,
      ``, `OFFERS:`,
      offers.map((o, i) => `${i}. ${JSON.stringify({ title: o.title, merchantId: o.merchantId, issuer: o.issuer, cardIds: o.cardIds, percent: o.percent, flat: o.flat, maxBenefit: o.maxBenefit, minTxn: o.minTxn, validFrom: o.validFrom, validTo: o.validTo, paymentModes: o.paymentModes, days: o.days })}`).join("\n"),
      ``, `Merchant ids: ${catalog.merchants.map((m) => `${m.id}=${m.name}`).join(", ")}`,
      ``, `PAGE TEXT:`, pageText.slice(0, MAX_PAGE_CHARS),
    ].join("\n");
    const out = await this.tool<{ verdicts: OfferVerdict[] }>("report_verdicts", "Report a verdict for every offer", {
      type: "object", required: ["verdicts"],
      properties: { verdicts: { type: "array", items: { type: "object", required: ["index", "ok", "reason"], properties: { index: { type: "integer" }, ok: { type: "boolean" }, reason: { type: "string" } } } } },
    }, prompt);
    return out.verdicts ?? [];
  }

  /** Link scout worker. */
  async pickOfferLinks(catalog: Catalog, links: { href: string; text: string }[], hint: OfferHint, max: number): Promise<string[]> {
    if (!links.length || max <= 0) return [];
    const prompt = [
      `These links are from a${hint.issuer ? ` ${hint.issuer}` : ""} credit-card offers listing page. Pick up to ${max} links that open a SINGLE offer's detail/terms page`,
      `for one of these merchants: ${catalog.merchants.map((m) => m.name).join(", ")}. Prefer credit-card offers and bigger brands. Skip category, filter, login and generic pages.`,
      `Return the hrefs exactly as given.`,
      ``, links.slice(0, 300).map((l) => `- ${l.href} | ${l.text.slice(0, 100)}`).join("\n"),
    ].join("\n");
    const out = await this.tool<{ links: string[] }>("pick_links", "Return the chosen hrefs", {
      type: "object", required: ["links"], properties: { links: { type: "array", items: { type: "string" } } },
    }, prompt);
    const allowed = new Set(links.map((l) => l.href));
    return (out.links ?? []).filter((h) => allowed.has(h)).slice(0, max);
  }
}

/** Any OpenAI-compatible Chat Completions API with function calling (Gemini, Grok). */
export class OpenAICompatExtractor extends LlmExtractor {
  constructor(
    private label: string,
    private model: string,
    private apiKey: string | undefined,
    private baseUrl: string,
    /** "named" forces the one tool by name; "required" forces some tool call (we only offer one). */
    private forceStyle: "named" | "required" = "named",
    /** Provider-specific request fields, e.g. Gemini's reasoning_effort. */
    private extraBody: Record<string, unknown> = {},
  ) {
    super();
    if (!apiKey) throw new Error(`${label} API key is not set`);
  }

  protected async tool<T>(name: string, description: string, schema: Record<string, unknown>, prompt: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 8192,
            messages: [{ role: "user", content: prompt }],
            tools: [{ type: "function", function: { name, description, parameters: schema } }],
            tool_choice: this.forceStyle === "named" ? { type: "function", function: { name } } : "required",
            ...this.extraBody,
          }),
          signal: AbortSignal.timeout(90_000),
        });
        if (!process.env.VITEST) console.log(`    ${this.label} ${this.model} attempt ${attempt + 1}: HTTP ${res.status} in ${Math.round((Date.now() - t0) / 1000)}s`);
        if (res.status === 429 || res.status >= 500) throw new Error(`${this.label} API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        if (!res.ok) throw new FatalApiError(`${this.label} API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const body = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
        const call = body.choices?.[0]?.message?.tool_calls?.find((c) => c.function?.name === name);
        if (!call?.function?.arguments) throw new Error("model returned no structured answer");
        return JSON.parse(call.function.arguments) as T;
      } catch (e) {
        if (e instanceof FatalApiError) throw e;
        if (!process.env.VITEST) console.log(`    ${this.label} attempt ${attempt + 1} failed after ${Math.round((Date.now() - t0) / 1000)}s: ${(e as Error).message}`);
        lastError = e;
        // free tiers rate-limit per minute: back off generously
        await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
      }
    }
    throw lastError;
  }

  retryDelayMs = 15_000;
}

/**
 * Google Gemini via AI Studio's free tier, using Gemini's own JSON-output mode
 * (generateContent + responseJsonSchema). Forced function calls through the
 * OpenAI-compatibility layer were timing out; native structured output is the supported path.
 */
export class GeminiExtractor extends LlmExtractor {
  retryDelayMs = 20_000;
  /** Free tier allows ~15 requests/minute on Flash-Lite: keep calls at least this far apart. */
  minGapMs = 6_000;
  private lastCall = 0;
  private noThinking = new Set<string>();
  private exhausted = new Set<string>();
  private models: string[];
  constructor(
    models = process.env.GEMINI_MODEL || "gemini-flash-lite-latest,gemini-3.1-flash-lite",
    private apiKey = process.env.GEMINI_API_KEY,
    private baseUrl = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
  ) {
    super();
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    this.models = models.split(",").map((m) => m.trim()).filter(Boolean);
  }

  /** Tries each model in order; a model that's over quota, missing, or persistently overloaded hands over to the next. */
  protected async tool<T>(_name: string, description: string, schema: Record<string, unknown>, prompt: string): Promise<T> {
    const errors: string[] = [];
    for (const model of this.models) {
      if (this.exhausted.has(model)) continue;
      try {
        return await this.callModel<T>(model, description, schema, prompt);
      } catch (e) {
        errors.push(`${model}: ${(e as Error).message}`);
        if (e instanceof FatalApiError && !(e as FatalApiError).nextModel) throw e;
      }
    }
    throw new Error(errors.join(" | ") || "no Gemini model available");
  }

  private async callModel<T>(model: string, description: string, schema: Record<string, unknown>, prompt: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = this.lastCall + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      const t0 = Date.now();
      const thinking = !this.noThinking.has(model);
      try {
        const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey! },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `${prompt}\n\nRespond with JSON only: ${description}.` }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: schema,
              maxOutputTokens: 8192,
              temperature: 0,
              ...(thinking ? { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING ?? "low" } } : {}),
            },
          }),
          signal: AbortSignal.timeout(90_000),
        });
        if (!process.env.VITEST) console.log(`    Gemini ${model} attempt ${attempt + 1}: HTTP ${res.status} in ${Math.round((Date.now() - t0) / 1000)}s`);
        if (res.ok) {
          const body = (await res.json()) as { candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[]; promptFeedback?: { blockReason?: string } };
          if (body.promptFeedback?.blockReason) throw new FatalApiError(`Gemini blocked the prompt: ${body.promptFeedback.blockReason}`);
          const cand = body.candidates?.[0];
          const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
          if (!text) throw new Error(`no answer (finishReason ${cand?.finishReason ?? "unknown"})`);
          return JSON.parse(text) as T;
        }
        const errText = (await res.text()).slice(0, 400);
        if (res.status === 400 && thinking && /thinking/i.test(errText)) { this.noThinking.add(model); attempt--; continue; }
        if (res.status === 404) { this.exhausted.add(model); throw new FatalApiError(`model not found`, true); }
        // Daily quota gone: no point retrying this model today.
        if (res.status === 429 && /PerDay|per day/i.test(errText)) { this.exhausted.add(model); throw new FatalApiError(`daily quota used up`, true); }
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}: ${errText.replace(/\s+/g, " ").slice(0, 160)}`);
        throw new FatalApiError(`Gemini API ${res.status}: ${errText}`);
      } catch (e) {
        if (e instanceof FatalApiError) throw e;
        if (!process.env.VITEST) console.log(`    Gemini ${model} attempt ${attempt + 1} failed after ${Math.round((Date.now() - t0) / 1000)}s: ${(e as Error).message}`);
        lastError = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
      }
    }
    throw new FatalApiError(`still failing after 3 tries: ${(lastError as Error)?.message}`, true);
  }
}

/** xAI Grok (paid API credits). */
export class GrokExtractor extends OpenAICompatExtractor {
  constructor(model = process.env.GROK_MODEL || "grok-4-1-fast-reasoning", apiKey = process.env.XAI_API_KEY,
    baseUrl = process.env.XAI_BASE_URL || "https://api.x.ai/v1") {
    super("xAI", model, apiKey, baseUrl, "named");
  }
}

class FatalApiError extends Error {
  /** true = this model can't help, but the next one might. */
  constructor(message: string, public nextModel = false) { super(message); }
}

/** Anthropic Claude. Used only when no Gemini or xAI key is set. */
export class ClaudeExtractor extends LlmExtractor {
  private client: Anthropic;
  constructor(private model = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5", apiKey = process.env.ANTHROPIC_API_KEY) {
    super();
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.client = new Anthropic({ apiKey });
  }

  protected async tool<T>(name: string, description: string, schema: Record<string, unknown>, prompt: string): Promise<T> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      tools: [{ name, description, input_schema: schema as never }],
      tool_choice: { type: "tool", name },
      messages: [{ role: "user", content: prompt }],
    });
    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new Error("model returned no structured answer");
    return block.input as T;
  }
}

/** First configured of: Gemini (free), Grok, Claude. */
export function extractorFromEnv(): Extractor {
  if (process.env.GEMINI_API_KEY) return new GeminiExtractor();
  if (process.env.XAI_API_KEY) return new GrokExtractor();
  if (process.env.ANTHROPIC_API_KEY) return new ClaudeExtractor();
  throw new Error("Set GEMINI_API_KEY (free, from aistudio.google.com), XAI_API_KEY or ANTHROPIC_API_KEY");
}

// ---------- Hallucination guards ----------

/** Every number we keep must literally appear in the quote (₹1,500 / 1500 / 5% all count). */
export function numbersBackedByQuote(quote: string, values: (number | undefined)[]): boolean {
  const inQuote = new Set((quote.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  return values.filter((v): v is number => v !== undefined).every((v) => inQuote.has(v));
}

export function acceptCheck(pageText: string, c: RuleCheck): { ok: boolean; why?: string } {
  if (!pageContainsQuote(pageText, c.quote)) return { ok: false, why: "quote not found on page" };
  if (c.status === "changed" && !numbersBackedByQuote(c.quote, [c.percent, c.units, c.perRupees, c.capLimit, c.minTxn])) {
    return { ok: false, why: "new numbers not present in the quote" };
  }
  return { ok: true };
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every end date a snippet of page text could mean, as YYYY-MM-DD. Handles "34 days left", "31st Dec 2026", "Dec 31, 2026", "31/12/2026", "31 Dec'26". */
export function datesInText(text: string, today: string): string[] {
  const out = new Set<string>();
  const t = text.replace(/[’‘]/g, "'");
  const iso = (y: number, m: number, d: number) => (y < 100 ? 2000 + y : y) + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  for (const m of t.matchAll(/(\d+)\s*days?\s*(left|remaining|to go)/gi)) out.add(addDays(today, Number(m[1])));
  for (const m of t.matchAll(/(\d{1,2})(?:st|nd|rd|th)?[\s\-]*([A-Za-z]{3,9})[\s,'\-]*(\d{2,4})/g)) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith("sept") ? 4 : 3)];
    if (mo) out.add(iso(Number(m[3]), mo, Number(m[1])));
  }
  for (const m of t.matchAll(/([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*'?(\d{2,4})/g)) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mo) out.add(iso(Number(m[3]), mo, Number(m[2])));
  }
  for (const m of t.matchAll(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/g)) out.add(iso(Number(m[3]), Number(m[2]), Number(m[1])));
  return [...out];
}

/** How much to trust an offer's end date. Unbacked dates aren't rejected, but cut to a week so they're re-read soon. */
export function checkOfferDate(pageText: string, o: ProposedOffer, today: string): { backed: boolean; validTo: string } {
  const evidence = o.dateQuote && pageContainsQuote(pageText, o.dateQuote) ? o.dateQuote : "";
  if (evidence && datesInText(evidence, today).includes(o.validTo)) return { backed: true, validTo: o.validTo };
  const capped = addDays(today, 7);
  return { backed: false, validTo: o.validTo < capped ? o.validTo : capped };
}

/** True when an extracted offer is missing the terms that would make it safe to use (a cap for "up to" offers). */
export function needsTerms(o: ProposedOffer): boolean {
  const text = `${o.title} ${o.quote}`;
  return (o.percent !== undefined && o.maxBenefit === undefined && /up\s*to/i.test(text)) || !o.dateQuote;
}

export function acceptOffer(pageText: string, o: ProposedOffer, today: string): { ok: boolean; why?: string } {
  if (!pageContainsQuote(pageText, o.quote)) return { ok: false, why: "quote not found on page" };
  if (!numbersBackedByQuote(o.quote, [o.percent, o.flat, o.maxBenefit, o.minTxn])) return { ok: false, why: "numbers not present in the quote" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.validFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(o.validTo)) return { ok: false, why: "bad dates" };
  if (o.validTo < today) return { ok: false, why: "already expired" };
  if (o.validTo < o.validFrom) return { ok: false, why: "ends before it starts" };
  if (o.percent === undefined && o.flat === undefined) return { ok: false, why: "no benefit amount" };
  if ((o.percent ?? 0) > 50 || (o.flat ?? 0) > 50_000) return { ok: false, why: "implausible benefit" };
  if (!o.issuer && !o.cardIds?.length) return { ok: false, why: "no issuer or card" };
  const text = `${o.title} ${o.quote}`;
  // "Up to 15%" is a ceiling, not a rate: without the cap we'd be promising the maximum on every purchase.
  if (o.percent !== undefined && o.maxBenefit === undefined && /up\s*to\s*\d+(?:\.\d+)?\s*%/i.test(text)) return { ok: false, why: "\"up to\" percentage with no cap stated (needs the offer's terms page)" };
  if (o.percent === undefined && o.flat !== undefined && o.minTxn === undefined && /up\s*to\s*(?:₹|rs\.?|inr)/i.test(text)) return { ok: false, why: "\"up to\" amount with no minimum spend stated (needs the offer's terms page)" };
  return { ok: true };
}
