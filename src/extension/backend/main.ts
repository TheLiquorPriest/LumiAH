// The extension backend's entry (dist/backend.js): Lumiverse's Spindle worker imports it, and it
// starts the backend over the real host. Everything it does is in backend.ts; everything that
// touches Lumiverse is in spindle.ts.

import { createBackend } from "./backend";
import { createSpindleHost } from "./spindle";

/** The build this bundle came from: `bun run build` defines it into every bundle; "dev" run from source. */
const BUILD: string = process.env.LAH_BUILD_ID ?? "dev";

/**
 * The runtime this build ships beside its backend (`dist/lumiah.js`): its sha256 and its size, which
 * `bun run build` writes into this bundle beside the build id. A runtime on another build is offered
 * it. A backend built without them (development) offers none.
 */
const RUNTIME_SHA256: string = process.env.LAH_RUNTIME_SHA256 ?? "";
const RUNTIME_SIZE: string = process.env.LAH_RUNTIME_SIZE ?? "";

/**
 * How often the backend looks at what waits on time alone. Every such timing is a setting of its
 * user's (how long a runtime may stay quiet, a record wait, a stream be kept); this is only the grain
 * they are checked at, one timer for every user, so it is none.
 */
const TICK_MS = 1_000;

const host = createSpindleHost();
const backend = createBackend(host, {
  now: () => Date.now(),
  later: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  build: BUILD,
  runtime: { sha256: RUNTIME_SHA256, size: Number(RUNTIME_SIZE) },
});

setInterval(() => {
  backend.tick().catch((error: unknown) => host.log("warn", `[LumiAH] the backend's tick failed: ${error instanceof Error ? error.message : String(error)}`));
}, TICK_MS);

host.log("info", `[LumiAH] backend ${BUILD} started`);
