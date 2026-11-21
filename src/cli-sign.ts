// npm run sign → writes public/catalog.json + public/catalog.json.sig (CATALOG_SIGNING_KEY env, base64 PKCS#8).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { publicKeyFromPrivate, signBytes, verifyBytes } from "./sign.ts";
import { validateCatalog } from "./schema.ts";

const key = process.env.CATALOG_SIGNING_KEY;
if (!key) throw new Error("CATALOG_SIGNING_KEY is not set");
const bytes = readFileSync("catalog/catalog.json");
const { problems, catalog } = validateCatalog(JSON.parse(bytes.toString("utf8")));
if (problems.length) throw new Error("refusing to sign an invalid catalog:\n" + problems.join("\n"));
const sig = signBytes(bytes, key);
const pub = publicKeyFromPrivate(key);
if (!verifyBytes(bytes, sig, pub)) throw new Error("self-check failed");
mkdirSync("public", { recursive: true });
copyFileSync("catalog/catalog.json", "public/catalog.json");
writeFileSync("public/catalog.json.sig", sig + "\n");
writeFileSync("public/.nojekyll", "");
writeFileSync("public/index.html", `<!doctype html><meta charset="utf-8"><title>CardWise data</title><p>CardWise catalog ${catalog!.version}. Public key: <code>${pub}</code></p>\n`);
console.log(`signed ${catalog!.version} with key ${pub}`);
