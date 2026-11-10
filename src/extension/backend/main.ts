// The extension backend's entry (dist/backend.js): Lumiverse's Spindle worker imports it, and it
// starts the backend over the real host. Everything it does is in backend.ts; everything that
// touches Lumiverse is in spindle.ts.

import { startBackend } from "./backend";
import { createSpindleHost } from "./spindle";

/** The build this bundle came from: `bun run build` defines it into every bundle; "dev" run from source. */
const BUILD: string = process.env.LAH_BUILD_ID ?? "dev";

/**
 * How often the backend looks at what waits on time alone. Every such timing is a setting of its
 * user's (how long a runtime may stay quiet, a record wait, a stream be kept); this is only the grain
 * they are checked at, one timer for every user, so it is none.
 */
const TICK_MS = 1_000;

const host = createSpindleHost();
const backend = startBackend(host, {
  now: () => Date.now(),
  later: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  build: BUILD,
});

setInterval(() => {
  backend.tick().catch((error: unknown) => host.log("warn", `[LumiAH] the backend's tick failed: ${error instanceof Error ? error.message : String(error)}`));
}, TICK_MS);

host.log("info", `[LumiAH] backend ${BUILD} started`);
