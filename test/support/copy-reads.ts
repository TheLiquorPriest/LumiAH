// What a test of the runtime's copy of chat and lore reads on the rig (src/runtime/reads.ts): the copy
// as Runtime → Chat data shows it, the link requests the runtime sent the extension, and the core's own
// harness with its host kept for the test to read through as the core does.

import { createHarness } from "../../src/core/index";
import type { HarnessHost } from "../../src/core/ports";
import { isRecord } from "../../src/link/json";
import type { RuntimeDeps } from "../../src/runtime/runtime";
import type { ChatDataView } from "../../src/shared/ui";
import type { FakeLumiverse } from "./fake-lumiverse";
import { type Rig, until } from "./rig";

/** The core's own harness, its host kept for the test to read through as the core does. */
export function holding(held: { host: HarnessHost | null }): RuntimeDeps["harness"] {
  return (host, settings, extension) => {
    held.host = host;
    return createHarness(host, { settings, extension });
  };
}

/** The runtime's copy as Runtime → Chat data shows it. */
export async function chatData(it: Rig): Promise<ChatDataView> {
  return (await it.page.request("lah.runtime.chatdata", { relay: it.registration.relay })).state;
}

/** The link requests the runtime sent the extension since `from` (an index into the socket's frames): each by its type, a read of the extension's host by its port and member too (`host.read chats.get`). */
export function sent(lumiverse: FakeLumiverse, from = 0): string[] {
  return lumiverse.frames.slice(from).flatMap((frame) => {
    if (frame.to !== "lumiverse") return [];
    const wire: unknown = JSON.parse(frame.text);
    const data = isRecord(wire) && isRecord(wire.payload) ? wire.payload : null;
    if (!isRecord(data) || typeof data.type !== "string" || typeof data.id !== "string") return [];
    return [data.type === "host.read" ? `host.read ${String(data.port)}.${String(data.method)}` : data.type];
  });
}

/** Asks the runtime's copy for its state until `holds` says it is as wanted, as `until` waits on the rig: the copy's reads and the extension's pushes have no one promise to await. */
export async function copyHolds(it: Rig, holds: (state: ChatDataView) => boolean, what: string): Promise<ChatDataView> {
  let state: ChatDataView | null = null;
  let asking = false;
  await until(() => {
    if (state !== null && holds(state)) return true;
    if (!asking) {
      asking = true;
      void chatData(it)
        .then((now) => {
          state = now;
        })
        .catch(() => undefined)
        .finally(() => {
          asking = false;
        });
    }
    return false;
  }, what);
  return state as unknown as ChatDataView;
}
