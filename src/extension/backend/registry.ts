// What LumiAH keeps of a user's runtimes and their loopback key (DESIGN §6: "three secrets, three
// jobs"), in that user's own storage. The relay secret, minted when a runtime registers, proves a
// request comes from that runtime; the loopback key, which goes in the loopback connection, proves a
// completion request comes from that user's Lumiverse. Only their SHA-256 hashes are stored: neither
// can be read back, here or from the file. (The third secret, the runtime's Lumiverse session, never
// reaches the extension at all: Lumiverse checks it before a frame gets here.)
//
// A request reaches the extension already attributed to its user (the runtime signed in as them), so
// each user's registry is their own file and no key or secret is ever looked up across users.

import type { RuntimeReport } from "../../link/contract";
import { runtimeReportOf } from "../../link/frames";
import { isRecord } from "../../link/json";
import { UserDocs, sha256 } from "./docs";
import type { BackendHost } from "./spindle";

/** A runtime LumiAH registered (`register`). */
export interface RelayRecord {
  id: string;
  name: string;
  /** SHA-256 of its secret, hex. */
  secret: string;
  build: string;
  host: string;
  listen: string;
  port: number;
  registeredAt: number;
  /** What it said of itself on its last hello. */
  report: RuntimeReport | null;
}

/** A user's loopback key: its hash, its fingerprint for the page, and when it was made. */
export interface KeyRecord {
  hash: string;
  print: string;
  at: number;
}

export interface Registry {
  v: 1;
  key: KeyRecord | null;
  relays: Record<string, RelayRecord>;
  /** A reply of the user's has been answered: first-time setup's last step. */
  replied: boolean;
}

const FILE = "registry.json";

const port = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;

function registryOf(raw: unknown): Registry | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  const out: Registry = { v: 1, key: null, relays: {}, replied: raw.replied === true };
  const k = raw.key;
  if (isRecord(k) && typeof k.hash === "string" && typeof k.print === "string" && typeof k.at === "number") out.key = { hash: k.hash, print: k.print, at: k.at };
  if (isRecord(raw.relays)) {
    for (const [id, x] of Object.entries(raw.relays)) {
      if (!isRecord(x) || typeof x.name !== "string" || typeof x.secret !== "string" || !port(x.port)) continue;
      out.relays[id] = { id, name: x.name, secret: x.secret, build: typeof x.build === "string" ? x.build : "", host: typeof x.host === "string" ? x.host : "", listen: typeof x.listen === "string" ? x.listen : "127.0.0.1", port: x.port, registeredAt: typeof x.registeredAt === "number" ? x.registeredAt : 0, report: runtimeReportOf(x.report) };
    }
  }
  return out;
}

export class RegistryStore {
  private readonly docs: UserDocs<Registry>;

  constructor(host: Pick<BackendHost, "storage" | "log">) {
    this.docs = new UserDocs<Registry>(host, FILE, registryOf, () => ({ v: 1, key: null, relays: {}, replied: false }));
  }

  read(userId: string): Promise<Registry> {
    return this.docs.get(userId);
  }

  change<R>(userId: string, fn: (registry: Registry) => R): Promise<R> {
    return this.docs.change(userId, fn);
  }

  /** Whether `key` is the user's loopback key. */
  async keyIs(userId: string, key: string): Promise<boolean> {
    const stored = (await this.read(userId)).key;
    return stored !== null && stored.hash === (await sha256(key));
  }

  /** Resolves once every write is done (tests). */
  settle(): Promise<void> {
    return this.docs.settle();
  }
}
