// Vendors the language-neutral /schema JSON into the published package so
// @apgraph/schema is self-contained after `npm install`.
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoSchema = join(here, "..", "..", "..", "..", "schema");
const dest = join(here, "..", "schemas");
mkdirSync(dest, { recursive: true });
for (const f of ["apg.schema.json", "session.schema.json", "routing-result.schema.json", "changeset.schema.json", "transcript.schema.json", "profiles.json"]) {
  cpSync(join(repoSchema, f), join(dest, f));
}
console.log("schemas vendored");
