// Next.js only auto-loads .env from the app directory; this example lives in
// a monorepo where the key sits in the repo-root .env. Load it once, without
// overriding anything already set in the environment. Server-side only.
import { readFileSync } from "node:fs";
import { join } from "node:path";

let loaded = false;

export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const candidate of [
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", "..", ".env"),
  ]) {
    let text: string;
    try {
      text = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]!] === undefined) {
        process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
      }
    }
  }
}

loadRootEnv();
