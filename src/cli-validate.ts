// npm run validate → checks catalog/catalog.json (used in CI before signing).
import { readFileSync } from "node:fs";
import { validateCatalog } from "./schema.ts";

const { problems } = validateCatalog(JSON.parse(readFileSync(process.argv[2] ?? "catalog/catalog.json", "utf8")));
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("catalog OK");
