import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { StoreConflictError, type GraphDoc, type GraphStoreConnector, type SaveOptions } from "@apgraph/core";

/**
 * File-backed graph store (registry name "file"): one `{graphId}.apg.json`
 * holding the latest version, plus `{graphId}@{version}.apg.json` snapshots.
 * CAS is advisory across processes (version read + atomic rename, no flock) —
 * true cross-process CAS is a database-store concern.
 */
export class FileGraphStore implements GraphStoreConnector {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async load(graphId: string, version?: string): Promise<GraphDoc> {
    const file = version ? `${graphId}@${version}.apg.json` : `${graphId}.apg.json`;
    try {
      return JSON.parse(readFileSync(join(this.dir, file), "utf8")) as GraphDoc;
    } catch (err) {
      throw new Error(`FileGraphStore: cannot load ${file}: ${(err as Error).message}`);
    }
  }

  async save(doc: GraphDoc, opts: SaveOptions = {}): Promise<void> {
    if (opts.expectedVersion !== undefined) {
      const latestPath = join(this.dir, `${doc.graphId}.apg.json`);
      const latest = existsSync(latestPath)
        ? (JSON.parse(readFileSync(latestPath, "utf8")) as GraphDoc).version
        : undefined;
      if (opts.expectedVersion === null && latest !== undefined) {
        throw new StoreConflictError(`graph ${doc.graphId} already exists (latest ${latest})`);
      }
      if (opts.expectedVersion !== null && latest !== opts.expectedVersion) {
        throw new StoreConflictError(`graph ${doc.graphId} moved: expected ${opts.expectedVersion}, found ${latest}`);
      }
    }
    const body = JSON.stringify(doc, null, 2) + "\n";
    // temp + rename: a crash mid-write can never leave a truncated graph file
    this.atomicWrite(`${doc.graphId}.apg.json`, body);
    if (doc.version) {
      this.atomicWrite(`${doc.graphId}@${doc.version}.apg.json`, body);
    }
  }

  private atomicWrite(name: string, body: string): void {
    const tmp = join(this.dir, `.${name}.tmp`);
    writeFileSync(tmp, body);
    renameSync(tmp, join(this.dir, name));
  }

  async listVersions(graphId: string): Promise<string[]> {
    const prefix = `${graphId}@`;
    return readdirSync(this.dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".apg.json"))
      .map((f) => f.slice(prefix.length, -".apg.json".length))
      .sort();
  }
}
