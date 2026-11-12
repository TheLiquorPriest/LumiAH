// What Runtime → System says of a runtime's working store (`lah.runtime.store`): the core's documents
// and blobs on the runtime's own disk, this extension's storage as their mirror; or, for a runtime
// that keeps no copy of its own (one runtime at a time does), that it works straight on the storage,
// and why. Each line in plain words, with a tone where something needs the user's eye.

import type { StoreStateView } from "../../shared/ui";
import { ago, counted } from "./format";

export interface StoreLine {
  text: string;
  tone: "neutral" | "warn" | "neg";
}

/** Bytes as a person reads them: B, KB, MB or GB, one decimal past the first. */
export function sizeOf(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${n} B` : `${n.toFixed(1)} ${units[unit]}`;
}

/** What the section says first: where what the agents keep is, as the runtime keeps it now (before its state is known: as a runtime with its own copy keeps it). */
export function storeLead(state: StoreStateView | null, name: string): string {
  return state?.mode === "direct" ? `What its agents keep (their files, jobs, sessions, transcripts) it reads and saves straight in ${name}'s storage.` : `What its agents keep (their files, jobs, sessions, transcripts) is on its own disk first, and in ${name}'s storage behind it.`;
}

/** The store's state as lines, in the order the section shows them. */
export function storeLines(state: StoreStateView, now: number, name: string): StoreLine[] {
  const lines: StoreLine[] = [];
  if (state.mode === "direct") {
    const { lost } = state;
    if (lost !== null) {
      lines.push({ text: `It runs without a copy of its own since ${ago(now, lost.at)}: ${lost.to ?? "another runtime"} keeps ${name}'s storage now, and one runtime at a time keeps a copy. It reads and saves straight in the storage, which is slower, until it starts again.`, tone: "warn" });
      if (lost.dropped > 0) lines.push({ text: `${counted(lost.dropped, "change")} it hadn't sent to the storage gave way there to another runtime's later save of the same file (its log names each).`, tone: "neg" });
    } else if (state.holder !== null) lines.push({ text: `It runs without a copy of its own: ${state.holder} keeps ${name}'s storage, and one runtime at a time keeps a copy. It reads and saves straight in the storage, which is slower.`, tone: "neutral" });
    else lines.push({ text: `It runs without a copy of its own: ${name} gave it none, so it reads and saves straight in the storage, which is slower.`, tone: "neutral" });
    if (state.lastError !== null && (state.lastSent === null || state.lastError.at >= state.lastSent)) lines.push({ text: `The storage last failed ${ago(now, state.lastError.at)}: ${state.lastError.words}`, tone: "warn" });
    for (const refused of state.refused) lines.push({ text: `${ago(now, refused.at)}: ${refused.words}`, tone: "neg" });
    return lines;
  }
  if (state.mode === "waiting") lines.push({ text: `It hasn't heard from ${name} whether it keeps a copy of its own, so it doesn't yet read or save what the agents keep.`, tone: "warn" });
  else if (!state.open) lines.push({ text: `It hasn't reached ${name}'s storage since it started, so it doesn't yet read or save what the agents keep.`, tone: "warn" });
  lines.push(
    state.waiting === 0 || state.behindSince === null
      ? { text: `${name}'s storage holds everything it saved.`, tone: "neutral" }
      : { text: `${counted(state.waiting, "change")} wait to reach ${name}'s storage, the oldest from ${ago(now, state.behindSince)}. Nothing is lost: they are on its disk.`, tone: "warn" },
  );
  if (state.lastError !== null && (state.lastSent === null || state.lastError.at >= state.lastSent)) lines.push({ text: `The storage last failed ${ago(now, state.lastError.at)}: ${state.lastError.words}`, tone: "warn" });
  lines.push({ text: `Its copy takes ${sizeOf(state.bytes)} on its disk${state.counting ? " so far (still counting)" : ""}.`, tone: "neutral" });
  if (state.takeover !== null) lines.push({ text: `${ago(now, state.takeover.at)} it found ${state.takeover.from === null ? "a storage that named no runtime" : `the storage kept by ${state.takeover.from}`}, threw its own copy away${state.takeover.dropped > 0 ? ` with ${counted(state.takeover.dropped, "change")} the storage never had` : ""}, and keeps the storage since.`, tone: state.takeover.dropped > 0 ? "neg" : "warn" });
  for (const refused of state.refused) lines.push({ text: `${ago(now, refused.at)}: ${refused.words}`, tone: "neg" });
  return lines;
}
