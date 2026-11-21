// LLM extraction with guardrails (Grok by default, Claude optional). The model never edits the catalog freely:
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
}

export interface Extractor {
  checkCard(card: Card, catalog: Catalog, pageText: string): Promise<CardCheck>;
  listOffers(catalog: Catalog, pageText: string, today: string, hint: { issuer?: string; merchantId?: string }): Promise<ProposedOffer[]>;
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

  async listOffers(catalog: Catalog, pageText: string, today: string, hint: { issuer?: string; merchantId?: string }): Promise<ProposedOffer[]> {
    const issuers = [...new Set(catalog.cards.map((c) => c.issuer))];
    const prompt = [
      `List the credit-card offers on this page that are valid on or after ${today}.`,
      hint.issuer ? `The page belongs to the card issuer "${hint.issuer}".` : "",
      hint.merchantId ? `The page belongs to the merchant id "${hint.merchantId}".` : "",
      `Use ONLY these merchant ids (skip offers for other merchants): ${catalog.merchants.map((m) => `${m.id}=${m.name}`).join(", ")}.`,
      `Use ONLY these issuer names: ${issuers.join(", ")}. If an offer is limited to specific cards, use these card ids: ${catalog.cards.map((c) => `${c.id}=${c.name}`).join(", ")}.`,
      `Dates as YYYY-MM-DD. Skip offers without a clear end date. "quote" must be copied character-for-character from the page and contain the offer's numbers.`,
      ``,
      `PAGE TEXT:`,
      pageText.slice(0, MAX_PAGE_CHARS),
    ].filter(Boolean).join("\n");
    const out = await this.tool<{ offers: ProposedOffer[] }>("report_offers", "Report the offers found", {
      type: "object",
      required: ["offers"],
      properties: {
        offers: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "merchantId", "validFrom", "validTo", "quote"],
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
            },
          },
        },
      },
    }, prompt);
    return out.offers ?? [];
  }
}

/** xAI Grok via its OpenAI-compatible Chat Completions API. Default for the daily run. */
export class GrokExtractor extends LlmExtractor {
  constructor(
    private model = process.env.GROK_MODEL || "grok-4-1-fast-reasoning",
    private apiKey = process.env.XAI_API_KEY,
    private baseUrl = process.env.XAI_BASE_URL || "https://api.x.ai/v1",
  ) {
    super();
    if (!apiKey) throw new Error("XAI_API_KEY is not set");
  }

  protected async tool<T>(name: string, description: string, schema: Record<string, unknown>, prompt: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 8192,
            messages: [{ role: "user", content: prompt }],
            tools: [{ type: "function", function: { name, description, parameters: schema } }],
            tool_choice: { type: "function", function: { name } },
          }),
          signal: AbortSignal.timeout(180_000),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`xAI API ${res.status}`);
        if (!res.ok) throw new FatalApiError(`xAI API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const body = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
        const call = body.choices?.[0]?.message?.tool_calls?.find((c) => c.function?.name === name);
        if (!call?.function?.arguments) throw new Error("model returned no structured answer");
        return JSON.parse(call.function.arguments) as T;
      } catch (e) {
        if (e instanceof FatalApiError) throw e;
        lastError = e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw lastError;
  }
}

class FatalApiError extends Error {}

/** Anthropic Claude. Used only if XAI_API_KEY is absent and ANTHROPIC_API_KEY is set. */
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

/** Grok when XAI_API_KEY is set, else Claude when ANTHROPIC_API_KEY is set. */
export function extractorFromEnv(): Extractor {
  if (process.env.XAI_API_KEY) return new GrokExtractor();
  if (process.env.ANTHROPIC_API_KEY) return new ClaudeExtractor();
  throw new Error("Set XAI_API_KEY (Grok) or ANTHROPIC_API_KEY (Claude)");
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

export function acceptOffer(pageText: string, o: ProposedOffer, today: string): { ok: boolean; why?: string } {
  if (!pageContainsQuote(pageText, o.quote)) return { ok: false, why: "quote not found on page" };
  if (!numbersBackedByQuote(o.quote, [o.percent, o.flat, o.maxBenefit, o.minTxn])) return { ok: false, why: "numbers not present in the quote" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.validFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(o.validTo)) return { ok: false, why: "bad dates" };
  if (o.validTo < today) return { ok: false, why: "already expired" };
  if (o.validTo < o.validFrom) return { ok: false, why: "ends before it starts" };
  if (o.percent === undefined && o.flat === undefined) return { ok: false, why: "no benefit amount" };
  if ((o.percent ?? 0) > 50 || (o.flat ?? 0) > 50_000) return { ok: false, why: "implausible benefit" };
  if (!o.issuer && !o.cardIds?.length) return { ok: false, why: "no issuer or card" };
  return { ok: true };
}
