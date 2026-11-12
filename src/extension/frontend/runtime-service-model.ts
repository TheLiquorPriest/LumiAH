// What the Runtime page says of how one runtime is run and kept (runtime-service.tsx draws it): its
// update (taken by itself once nothing is under way, or at once from the button, which ends what
// is under way), its memory limit and what holds it there, and what a restart would or did cut off.
// A runtime that can't take the extension's offer keeps its update line, with the reason.

import type { RelayView, ServiceView, UnderWay } from "../../shared/ui";
import { counted } from "./format";

/** What is under way, in words: "1 reply, 2 jobs and 1 side session's answer"; null when nothing is. */
export function underWayWords(u: UnderWay): string | null {
  const parts = [...(u.replies > 0 ? [counted(u.replies, "reply", "replies")] : u.requests > 0 ? [counted(u.requests, "request from Lumiverse", "requests from Lumiverse")] : []), ...(u.jobs > 0 ? [counted(u.jobs, "job")] : []), ...(u.sides > 0 ? [counted(u.sides, "side session's answer", "side sessions' answers")] : [])];
  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] ?? null) : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** What the button's restart ended, as the page says it once it is pressed. */
export function cutWords(cut: UnderWay, build: string | null): string {
  const what = underWayWords(cut);
  const head = build !== null ? `Updating to build ${build}: the runtime restarts now` : "The runtime restarts now";
  if (what === null) return `${head}, and nothing was under way.`;
  const after = [cut.replies > 0 || cut.requests > 0 ? "a reply it ended keeps what it had written, and Retry writes it again" : null, cut.jobs > 0 ? "a job it ended shows as interrupted on Jobs, where it can be started again" : null].filter((part): part is string => part !== null);
  return `${head}. It ended ${what}${after.length > 0 ? `: ${after.join("; ")}` : ""}.`;
}

/** Where the runtime's update stands, as the page shows it. */
export type UpdateStanding =
  /** It runs the extension's build. */
  | { at: "current" }
  /** It is linked, and the page is asking it how its update stands. */
  | { at: "asking" }
  /** It is taking an update, or restarting. */
  | { at: "updating" }
  /** An update waits: `why` it isn't taken yet; the button takes it now, ending what is under way (`ends`). */
  | { at: "waiting"; build: string; why: string; ends: string | null }
  /** It can't take the extension's offer: the update line does it, for `why`. */
  | { at: "line"; why: string };

/**
 * How a runtime's update stands: from its row (whether it is linked now, whether it runs the
 * extension's build), what it says of itself (`service`; null while it hasn't said), why it gave no
 * answer when asked (`unread`, in the words the asking failed with; null while nothing failed), and
 * what the extension knows. A linked runtime that hasn't said yet is being asked, not unlinked.
 */
export function updateStanding(relay: RelayView, service: ServiceView | null, extension: { build: string; selfUpdate: boolean; name: string }, unread: string | null = null): UpdateStanding {
  if (service?.updating === true) return { at: "updating" };
  if (service !== null && service.waiting !== null) {
    const ends = underWayWords(service.underWay);
    const why = !service.autoUpdate ? "Updates are taken from this button only (it doesn't update by itself)." : ends !== null ? `It waits for what is under way to end (${ends}), then updates by itself.` : "It updates by itself in a moment.";
    return { at: "waiting", build: service.waiting.build, why, ends };
  }
  if (!relay.update) return { at: "current" };
  if (relay.link !== "linked") return { at: "line", why: `It isn't linked, so ${extension.name} can't offer it the update: run this on the machine it runs on.` };
  if (service === null) return unread === null ? { at: "asking" } : { at: "line", why: `It didn't say how its update stands (${unread}), so it may be a build that can't take ${extension.name}'s by itself: run this on the machine it runs on.` };
  if (service.problem !== null) return { at: "line", why: service.problem };
  if (service.source === null) return { at: "line", why: "It was set up before it could update itself: run this once on the machine it runs on, and from then on it updates by itself." };
  if (!extension.selfUpdate) return { at: "line", why: `This build of ${extension.name} offers runtimes no update of their own (a development build, or one whose folder isn't known): run this on the machine it runs on.` };
  return { at: "line", why: `It hasn't taken ${extension.name}'s build yet. If it doesn't within a minute, run this on the machine it runs on.` };
}

/** What holds the runtime to its memory limit, in plain words. */
export function memoryWords(service: ServiceView): string {
  if (service.memoryNote !== null) return service.memoryNote;
  return `Its systemd service ${service.unit ?? ""} holds it to this limit (MemoryMax): past it, systemd stops the runtime and starts it again.`.replace("  ", " ");
}

/** What the page says of how this process came to run, and of a copy that waits beside it; none when there is nothing to say. */
export function copyWords(service: ServiceView, now: number): string[] {
  const words: string[] = [];
  if (service.handedOver) words.push("It restarted by starting a new copy of itself (this system can't restart a process in place), so a task or service wrapper that ran the old one doesn't watch this one: stop and start it there to have it watched again.");
  if (service.waitingCopy !== null) words.push(`Another copy of it (process ${service.waitingCopy.pid}) has waited ${Math.max(1, Math.round((now - service.waitingCopy.since) / 60_000))} minute(s) to serve on its port, started by something else while this one serves, such as the task or service wrapper that runs it. It serves nothing until this one stops; stop it there if it shouldn't run.`);
  return words;
}
