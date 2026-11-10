// The loopback key (DESIGN §6: the second of the three secrets). It goes in the loopback connection,
// so every completion request Lumiverse sends the runtime carries it, and the extension checks it
// before a request becomes a turn or is passed on. Only its SHA-256 is stored: the key is shown once,
// when it is minted. Spindle gives an extension no way to make or change a connection, so the user's
// linked runtime puts the new key in the loopback connection with its own Lumiverse session, making
// the connection when there is none; with no runtime linked, the user pastes it themselves.

import { KEY_PREFIX, LINK } from "../../link/contract";
import { randomHex, sha256 } from "./docs";
import type { RegistryStore } from "./registry";
import type { Relays } from "./relays";
import type { SettingsStore } from "./settings";
import type { BackendHost } from "./spindle";

interface Made {
  connection: { id: string; name: string } | null;
  problem: string | null;
}

export interface KeysDeps {
  registry: RegistryStore;
  relays: Relays;
  settings: SettingsStore;
  now(): number;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
}

export class Keys {
  /** The `connection` pushes still unanswered, by user and ref. */
  private readonly waiting = new Map<string, (made: Made | null) => void>();

  constructor(
    private readonly host: Pick<BackendHost, "log">,
    private readonly deps: KeysDeps,
  ) {}

  /**
   * Mints the user's loopback key (in place of the one they had, which stops working at once) and has
   * their linked runtime put it in the loopback connection. `connection` is the connection it went
   * into; null when no runtime was linked, or the one asked didn't do it in time.
   */
  async mint(userId: string): Promise<{ key: string; connection: { id: string; name: string } | null }> {
    const { registry, relays, settings, now, later } = this.deps;
    const key = `${KEY_PREFIX}${randomHex(256)}`;
    const hash = await sha256(key);
    // The fingerprint the page shows is the start of the hash: it tells two keys apart and gives nothing of either away.
    await registry.change(userId, (r) => {
      r.key = { hash, print: hash.slice(0, 8), at: now() };
    });
    const relay = (await relays.linked(userId))[0];
    if (relay === undefined) return { key, connection: null };
    const ref = randomHex(64);
    const waitMs = (await settings.transport(userId)).link.connectionMs;
    const k = `${userId}\u0000${ref}`;
    const { promise, resolve } = Promise.withResolvers<Made | null>();
    const cancel = later(waitMs, () => {
      this.waiting.delete(k);
      resolve(null);
    });
    this.waiting.set(k, (answer) => {
      cancel();
      this.waiting.delete(k);
      resolve(answer);
    });
    // With nowhere to push it, there is nothing to wait for.
    if (!relays.push(userId, relay.id, { link: LINK, type: "connection", ref, key })) this.waiting.get(k)?.(null);
    const made = await promise;
    if (made === null) this.host.log("warn", `[LumiAH] runtime "${relay.name}" didn't say it put the new loopback key in a connection`);
    else if (made.problem !== null) this.host.log("warn", `[LumiAH] runtime "${relay.name}" couldn't put the new loopback key in a connection: ${made.problem}`);
    return { key, connection: made?.connection ?? null };
  }

  /** Forgets the user's loopback key: no request is admitted until a new one is minted. */
  async forget(userId: string): Promise<{ key: null; connection: null }> {
    await this.deps.registry.change(userId, (r) => {
      r.key = null;
    });
    return { key: null, connection: null };
  }

  /** `setup.connection`: a runtime says what became of a `connection` push. */
  made(userId: string, ref: string, connection: { id: string; name: string } | null, problem: string | null): void {
    this.waiting.get(`${userId}\u0000${ref}`)?.({ connection, problem });
  }
}
