// The working store's part of the stand-in backend: what Runtime → System is told of a linked
// runtime's store (`lah.runtime.store`). The preview's runtime keeps the extension's storage (its
// own copy) and has sent it everything it saved.

import type { Handlers } from "./ctx";

type Requests = "lah.runtime.store";

export function storeMock(now: () => number): Handlers<Requests> {
  return {
    "lah.runtime.store": () => ({ state: { open: true, mode: "held", holder: null, lost: null, waiting: 0, behindSince: null, lastError: null, lastSent: now() - 4_000, bytes: 3_276_800, counting: false, takeover: null, refused: [] } }),
  };
}
