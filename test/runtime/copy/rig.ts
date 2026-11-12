// The runtime's copy of chat and lore set up over the made-up Lumiverse (lumiverse.ts): its HTTP source
// as the user's session, and for its fallback the extension's own host (`createSpindleHost`, the real
// code) over the same Lumiverse's `spindle` global, which is also what every answer of the copy is held
// against. The copy's clock is the test's to move; events reach the copy only when the test forwards
// them, as the extension would.

import type { JsonValue } from "../../../src/core/ports";
import { type BackendHost, createSpindleHost } from "../../../src/extension/backend/spindle";
import { createHostCopy, type HostCopy, type HostReads } from "../../../src/runtime/copy";
import { createHttpSource } from "../../../src/runtime/copy/http";
import type { CopySource } from "../../../src/runtime/copy/source";
import { Lumiverse } from "./lumiverse";

export const USER = "user-mara";
export const OTHER = "user-ilse";
/** LumiAH's own identifier: its entry in a message's extension metadata is the one the copy reads. */
export const LUMIAH = "lumi_ah";

const scope = globalThis as Record<string, unknown>;

export interface CopyRig {
  lumiverse: Lumiverse;
  copy: HostCopy;
  /** The extension's own host over the same Lumiverse. */
  host: BackendHost;
  /** Each read the fallback answered, as `port.method id`. */
  fellBack: string[];
  /** The permissions the extension holds; the test may take one away. */
  granted: Set<string>;
  /** The copy's clock, in ms. */
  clock: { now: number };
  /** The waits the source took before it asked again. */
  waits: number[];
  logs: string[];
  /** Hands the copy every event Lumiverse sent since the last time, in order, as the extension forwards them. */
  forward(): void;
  /** Lets the events sent since the last forward go unheard, as a link that was down would. */
  lose(): void;
}

export interface RigOptions {
  lumiverse?: Lumiverse;
  identifier?: string;
  own?: (chatId: string) => Promise<ReadonlyMap<string, JsonValue>>;
  declinesLore?: boolean;
  keepChars?: number;
  /** The source the copy reads from; the HTTP source over the user's session when not given. */
  source?: (rig: { lumiverse: Lumiverse; waits: number[] }) => CopySource;
  parallel?: number;
  /** The HTTP source's deadline for one request, in ms. */
  requestMs?: number;
}

/** Counts each call the fallback answers. */
function counted(host: BackendHost, fellBack: string[]): HostReads {
  const wrap = <T extends object>(port: string, members: T): T =>
    new Proxy(members, {
      get(target, name: string) {
        const member = (target as Record<string, unknown>)[name];
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          fellBack.push(`${port}.${name} ${String(args[0])}`);
          return (member as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return { chats: wrap("chats", host.chats), lore: wrap("lore", host.lore) };
}

export function rigCopy(options: RigOptions = {}): CopyRig {
  const lumiverse = options.lumiverse ?? new Lumiverse();
  const identifier = options.identifier ?? LUMIAH;
  const granted = new Set(["chats", "chat_mutation", "world_books", "characters", "personas"]);
  scope.spindle = lumiverse.spindle(identifier, (permission) => granted.has(permission));
  const host = createSpindleHost(identifier);
  const fellBack: string[] = [];
  const clock = { now: Date.UTC(2026, 10, 12, 9, 0, 0) };
  const waits: number[] = [];
  const logs: string[] = [];
  const source =
    options.source?.({ lumiverse, waits }) ??
    createHttpSource({
      fetch: lumiverse.session(USER),
      identifier,
      sleep: async (ms) => {
        waits.push(ms);
      },
      ...(options.parallel !== undefined ? { parallel: options.parallel } : {}),
      ...(options.requestMs !== undefined ? { requestMs: options.requestMs } : {}),
    });
  const copy = createHostCopy({
    source,
    fallback: counted(host, fellBack),
    userId: USER,
    identifier,
    granted: (permission) => granted.has(permission),
    ...(options.own !== undefined ? { own: options.own } : {}),
    ...(options.declinesLore === true ? { declinesLore: true } : {}),
    ...(options.keepChars !== undefined ? { keepChars: () => options.keepChars as number } : {}),
    now: () => clock.now,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  let forwarded = 0;
  return {
    lumiverse,
    copy,
    host,
    fellBack,
    granted,
    clock,
    waits,
    logs,
    forward() {
      for (const event of lumiverse.emitted.slice(forwarded)) copy.apply(event);
      forwarded = lumiverse.emitted.length;
    },
    lose() {
      forwarded = lumiverse.emitted.length;
    },
  };
}

/** What the `spindle` global was before a test set its own. */
export const SPINDLE_BEFORE = scope.spindle;

export function restoreSpindle(): void {
  scope.spindle = SPINDLE_BEFORE;
}
