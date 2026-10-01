// File-backed changeset + layer + transcript + agent-state stores: one JSON
// file per record, atomic temp+rename writes, ids sanitized against path
// traversal.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentStateStoreConnector,
  Changeset,
  ChangesetStoreConnector,
  GraphLayer,
  LayerStoreConnector,
  Transcript,
  TranscriptStoreConnector,
  TranscriptTurn,
} from "@apgraph/core";

function safeName(id: string): string {
  if (!/^[A-Za-z0-9:_-]+$/.test(id)) throw new Error(`Invalid store id: ${id}`);
  return id.replace(/:/g, "__");
}

class JsonDir<T extends object> {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  put(id: string, value: T): void {
    const name = `${safeName(id)}.json`;
    const tmp = join(this.dir, `.${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, join(this.dir, name));
  }
  get(id: string): T | null {
    const path = join(this.dir, `${safeName(id)}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }
  all(): T[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as T);
  }
  delete(id: string): void {
    const path = join(this.dir, `${safeName(id)}.json`);
    if (existsSync(path)) unlinkSync(path);
  }
}

/** Registry name "file-changesets": `{dir}/changesets/{id}.json`. */
export class FileChangesetStore implements ChangesetStoreConnector {
  private store: JsonDir<Changeset>;
  constructor(dir: string) {
    this.store = new JsonDir<Changeset>(join(dir, "changesets"));
  }
  async put(cs: Changeset): Promise<void> {
    this.store.put(cs.id, cs);
  }
  async get(id: string): Promise<Changeset | null> {
    return this.store.get(id);
  }
  async list(graphId?: string, status?: Changeset["status"]): Promise<Changeset[]> {
    void graphId; // Changeset carries baseGraphVersion, not graphId — hosts filter via convention
    return this.store.all().filter((c) => status === undefined || c.status === status);
  }
}

/** Registry name "file-transcripts": `{dir}/transcripts/{id}.json`. */
export class FileTranscriptStore implements TranscriptStoreConnector {
  private store: JsonDir<Transcript>;
  constructor(dir: string) {
    this.store = new JsonDir<Transcript>(join(dir, "transcripts"));
  }
  async put(t: Transcript): Promise<void> {
    this.store.put(t.id, t);
  }
  async get(id: string): Promise<Transcript | null> {
    return this.store.get(id);
  }
  async list(graphId?: string): Promise<Transcript[]> {
    return this.store.all().filter((t) => graphId === undefined || t.graphId === graphId);
  }
  async appendTurns(id: string, turns: TranscriptTurn[]): Promise<Transcript> {
    const existing = this.store.get(id) ?? { id, turns: [] };
    existing.turns = [...existing.turns, ...turns];
    this.store.put(id, existing);
    return existing;
  }
}

/** Registry name "file-state": `{dir}/state/{agentId}.json`. */
export class FileAgentStateStore implements AgentStateStoreConnector {
  private store: JsonDir<Record<string, unknown>>;
  constructor(dir: string) {
    this.store = new JsonDir<Record<string, unknown>>(join(dir, "state"));
  }
  async getState(agentId: string): Promise<Record<string, unknown> | null> {
    return this.store.get(agentId);
  }
  async putState(agentId: string, state: Record<string, unknown>): Promise<void> {
    this.store.put(agentId, state);
  }
}

/** Registry name "file-layers": `{dir}/layers/{layerId}.json`. */
export class FileLayerStore implements LayerStoreConnector {
  private store: JsonDir<GraphLayer>;
  constructor(dir: string) {
    this.store = new JsonDir<GraphLayer>(join(dir, "layers"));
  }
  async putLayer(layer: GraphLayer): Promise<void> {
    this.store.put(layer.layerId, layer);
  }
  async getLayer(layerId: string): Promise<GraphLayer | null> {
    return this.store.get(layerId);
  }
  async listLayers(graphId: string, scope?: GraphLayer["scope"]): Promise<GraphLayer[]> {
    return this.store.all().filter((l) => l.baseGraphId === graphId && (scope === undefined || l.scope === scope));
  }
  async deleteLayer(layerId: string): Promise<void> {
    this.store.delete(layerId);
  }
}
