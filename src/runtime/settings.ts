// The user's settings and texts as the runtime holds them. The extension keeps them (user storage)
// and says their revision on every hello, every turn it begins and whenever they change; the runtime
// reads them again (`settings.get`) only when it holds another revision. Its own limits and timings
// are a part of them (`transport.runtime`, src/link/settings.ts): until it has read them it uses the
// ones it last read, which its config keeps.

import type { SettingsSnapshot } from "../link/contract";
import type { RuntimeTuning } from "../link/settings";
import { runtimeTuningOf } from "../link/settings";
import type { RuntimeLink } from "./link";
import { LOST_WAIT } from "./link";

export interface SettingsEnv {
  /** The limits and timings to start with: the config's, as last read. */
  tuning: RuntimeTuning;
  /** The user's limits and timings differ from the ones the config holds: keep them. */
  keep(tuning: RuntimeTuning): void;
  log(text: string): void;
}

export class RuntimeSettings {
  private held: SettingsSnapshot | null = null;
  /** The revision the extension last named; null before it named any. */
  private latest: number | null = null;
  /** How many times it has named one: a read knows by it whether one was named while it was out. */
  private named = 0;
  private reading: Promise<SettingsSnapshot> | null = null;
  private current: RuntimeTuning;

  constructor(
    private readonly link: RuntimeLink,
    private readonly env: SettingsEnv,
  ) {
    this.current = env.tuning;
  }

  /** The runtime's limits and timings now. */
  readonly tuning = (): RuntimeTuning => this.current;

  /** The extension's settings stand at `revision`: read before they are next needed, when another is held. */
  note(revision: number): void {
    this.latest = revision;
    this.named++;
    // Its own limits apply as soon as they change, not only when a turn next reads the settings.
    if (this.held?.revision !== revision) void this.get().catch((error: unknown) => this.env.log(`couldn't read the settings yet: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** The settings and texts, read from the extension when none are held or it named another revision since. */
  get(): Promise<SettingsSnapshot> {
    if (this.held !== null && (this.latest === null || this.held.revision === this.latest)) return Promise.resolve(this.held);
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async read(): Promise<SettingsSnapshot> {
    const named = this.named;
    const snapshot = await this.link.request("settings.get", {}, this.current.lostMs, LOST_WAIT);
    this.held = snapshot;
    // What was just read is the latest, unless the extension named another revision while it was out.
    if (named === this.named) this.latest = snapshot.revision;
    const tuning = runtimeTuningOf(snapshot.values);
    if (JSON.stringify(tuning) !== JSON.stringify(this.current)) {
      this.current = tuning;
      this.env.keep(tuning);
    }
    return snapshot;
  }
}
