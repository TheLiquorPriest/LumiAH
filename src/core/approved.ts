// What the user approved "for this chat" (DESIGN §17), as the store keeps it: one document for each
// chat (`DOC.approvals`), holding the tools whose calls run in that chat without asking again, and
// when the user said so. The gate (`approval.ts`) keeps a tool here when the user answers "for this
// chat"; the user reads what is kept and takes a tool out again on the page.
//
// Every change reads the document again and writes it whole, one change at a time for a host's
// store: several runs may be under way in one chat (a turn, and jobs beside it) while the user
// forgets an approval on the page, and none writes over what another kept or took out.

import { DOC } from "./paths";
import type { HarnessHost, JsonObject } from "./ports";
import { isRecord } from "./ports";
import { hasOwn } from "./util";

/** A tool the user approved for a chat, and when (`null`: it was kept before the time was). */
export interface KeptApproval {
  tool: string;
  at: number | null;
}

/** The tools the user approved for one chat, as stored (`DOC.approvals`), in the order they were approved. `at`: when, by tool. A stored format: `tools` is read by every build. */
interface ApprovalsDoc {
  v: 1;
  kind: "approvals";
  tools: string[];
  at?: Record<string, number>;
}

/** The changes to approvals in one host's store, one at a time: kept by the store, which is what everything that changes them has in common. */
const writes = new WeakMap<object, Promise<unknown>>();

/** What the store holds for a chat now, in the order approved: none for a document that isn't one. Rejects when the store can't be read. */
export async function keptApprovals(store: Pick<HarnessHost["store"], "read">, chatId: string): Promise<KeptApproval[]> {
  const raw = await store.read(DOC.approvals(chatId));
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "approvals" || !Array.isArray(raw.tools)) return [];
  const times = isRecord(raw.at) ? raw.at : {};
  const tools = [...new Set(raw.tools.filter((tool): tool is string => typeof tool === "string"))];
  return tools.map((tool) => {
    const at = hasOwn(times, tool) ? times[tool] : null;
    return { tool, at: typeof at === "number" && Number.isFinite(at) ? at : null };
  });
}

/** One change to a chat's approvals, after those before it: what `make` gives of what the store holds then is written (the same list: nothing is), and comes back. A chat left with none has no document. */
function change(store: HarnessHost["store"], chatId: string, make: (kept: KeptApproval[]) => KeptApproval[]): Promise<KeptApproval[]> {
  const done = (writes.get(store) ?? Promise.resolve()).then(async () => {
    const kept = await keptApprovals(store, chatId);
    const next = make(kept);
    if (next === kept) return kept;
    if (next.length === 0) await store.remove(DOC.approvals(chatId));
    else {
      const doc: ApprovalsDoc = { v: 1, kind: "approvals", tools: next.map((k) => k.tool), at: Object.fromEntries(next.flatMap((k) => (k.at === null ? [] : [[k.tool, k.at]]))) };
      await store.write(DOC.approvals(chatId), doc as unknown as JsonObject);
    }
    return next;
  });
  // Whoever changes them next waits for this change, whatever comes of it.
  writes.set(store, done.catch(() => undefined));
  return done;
}

/** Keeps a tool as approved for a chat from now on, beside what the store holds then; the chat's approvals after. One kept already keeps the time it was first approved. */
export function keepApproval(host: Pick<HarnessHost, "store" | "clock">, chatId: string, tool: string): Promise<KeptApproval[]> {
  return change(host.store, chatId, (kept) => (kept.some((k) => k.tool === tool) ? kept : [...kept, { tool, at: host.clock.now() }]));
}

/** Takes a tool out of what is approved for a chat; the chat's approvals after. Every run that begins from then on asks about it again. */
export function forgetApproval(host: Pick<HarnessHost, "store">, chatId: string, tool: string): Promise<KeptApproval[]> {
  return change(host.store, chatId, (kept) => (kept.some((k) => k.tool === tool) ? kept.filter((k) => k.tool !== tool) : kept));
}
