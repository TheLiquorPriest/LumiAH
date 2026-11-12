// A wait's words where it runs out: its setting's name, and where the user changes it (the
// Timeouts page, `shared/timeouts.ts`), so a timeout says what to change and where.

import { type SettingsOwner, timeoutPlace } from "../shared/timeouts";
import { isRecord } from "./json";
import { TRANSPORT_KEY, TRANSPORT_SCHEMA } from "./settings";

/** Where one of the transport's waits is changed: `path` is its place within the transport's section (`["pages", "askMs"]`), `owner` whose Settings hold it (`timeoutPlace`). */
export function transportWait(path: readonly string[], owner: SettingsOwner): string {
  let at: unknown = TRANSPORT_SCHEMA;
  for (const key of path) at = isRecord(at) && isRecord(at.properties) ? at.properties[key] : undefined;
  const title = isRecord(at) && typeof at.title === "string" ? at.title : path.join(".");
  return timeoutPlace([TRANSPORT_KEY, ...path], title, owner);
}

/** A span of time as a timeout's words say it: "250 ms", "30 seconds", "2 minutes", "1.5 seconds". */
export function spanWords(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
