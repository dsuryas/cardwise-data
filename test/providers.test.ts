import { afterEach, expect, test, vi } from "vitest";
import { GeminiExtractor, GrokExtractor, extractorFromEnv } from "../src/extract.ts";
import type { Catalog } from "../src/schema.ts";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync("catalog/catalog.json", "utf8")) as Catalog;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test("Grok: forces the tool, sends the schema, parses arguments", async () => {
  const offer = { title: "10% off", merchantId: catalog.merchants[0].id, issuer: catalog.cards[0].issuer, percent: 10, validFrom: "2026-11-20", validTo: "2026-11-30", quote: "Get 10% off" };
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("grok-test");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "report_offers" } });
    expect(body.tools[0].function.parameters.required).toContain("offers");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "report_offers", arguments: JSON.stringify({ offers: [offer] }) } }] } }] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const offers = await new GrokExtractor("grok-test", "k", "https://example.test/v1").listOffers(catalog, "Get 10% off", "2026-11-20", {});
  expect(offers).toEqual([offer]);
  expect(fetchMock.mock.calls[0][0]).toBe("https://example.test/v1/chat/completions");
});

test("Grok: a 401 fails fast instead of retrying", async () => {
  const fetchMock = vi.fn(async () => new Response("bad key", { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(new GrokExtractor("m", "k").listOffers(catalog, "x", "2026-11-20", {})).rejects.toThrow(/401/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

const geminiReply = (obj: unknown) => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking...", thought: true }, { text: JSON.stringify(obj) }] } }] }));

test("Gemini: native JSON mode with the schema, key in header, thoughts ignored", async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.required).toContain("offers");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g");
    return geminiReply({ offers: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  expect(await new GeminiExtractor("gemini-test", "g").listOffers(catalog, "x", "2026-11-20", {})).toEqual([]);
  expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
});

test("Gemini: retries a 429 then succeeds", async () => {
  let n = 0;
  vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? new Response("slow down", { status: 429 }) : geminiReply({ offers: [] }))));
  const g = new GeminiExtractor("m", "g"); g.retryDelayMs = 1;
  expect(await g.listOffers(catalog, "x", "2026-11-20", {})).toEqual([]);
  expect(n).toBe(2);
});

test("Gemini: drops thinkingLevel for models that don't support it", async () => {
  const seen: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
    const cfg = JSON.parse(String(init.body)).generationConfig;
    seen.push(cfg.thinkingConfig);
    return cfg.thinkingConfig ? new Response("thinking_level is not supported for this model", { status: 400 }) : geminiReply({ offers: [] });
  }));
  expect(await new GeminiExtractor("old", "g").listOffers(catalog, "x", "2026-11-20", {})).toEqual([]);
  expect(seen).toEqual([{ thinkingLevel: "low" }, undefined]);
});

test("provider choice: Gemini first, then Grok", () => {
  vi.stubEnv("GEMINI_API_KEY", "g"); vi.stubEnv("XAI_API_KEY", "x");
  expect(extractorFromEnv()).toBeInstanceOf(GeminiExtractor);
  vi.stubEnv("GEMINI_API_KEY", "");
  expect(extractorFromEnv()).toBeInstanceOf(GrokExtractor);
});
