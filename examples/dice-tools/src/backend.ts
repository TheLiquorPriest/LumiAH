// The backend's entry (`dist/backend.js`), which Lumiverse's Spindle worker imports: LumiAH's
// backend over Lumiverse, given what Dice Tools adds.

import { createBackend, createSpindleHost } from "lumi-ah/extension/backend";
import { diceTools, IDENTIFIER } from "./dice";

/** This build of the extension (`build.ts` puts it in). A runtime linked to it says which build it is, and the Runtime page says when the two differ. */
const BUILD: string = process.env.LAH_BUILD_ID ?? "dev";

/** The runtime this build ships beside its backend (`dist/lumiah.js`): its sha256 and size, which `build.ts` puts in. A runtime on another build is offered that file, and updates itself from it. */
const RUNTIME = { sha256: process.env.LAH_RUNTIME_SHA256 ?? "", size: Number(process.env.LAH_RUNTIME_SIZE ?? "0") };

const host = createSpindleHost(IDENTIFIER);
const backend = createBackend(
  host,
  {
    now: () => Date.now(),
    later: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    build: BUILD,
    runtime: RUNTIME,
  },
  diceTools({ random: Math.random, log: (line) => host.log("info", line) }),
);

// The backend keeps no timer of its own: once a second it is asked to look at what waits on time alone.
setInterval(() => {
  backend.tick().catch((error: unknown) => host.log("warn", `[Dice Tools] the backend's tick failed: ${String(error)}`));
}, 1_000);
