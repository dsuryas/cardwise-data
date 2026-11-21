import { afterEach, expect, test, vi } from "vitest";
import { GrokExtractor, extractorFromEnv } from "../src/extract.ts";
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

test("provider choice: Grok wins when its key is set", () => {
  vi.stubEnv("XAI_API_KEY", "x"); vi.stubEnv("ANTHROPIC_API_KEY", "a");
  expect(extractorFromEnv()).toBeInstanceOf(GrokExtractor);
});
