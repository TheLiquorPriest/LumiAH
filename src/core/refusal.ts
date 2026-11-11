// How the core says no to whoever calls it on the user's behalf (the page, through the runtime): an
// error with a code the caller acts on and a message in plain words the user reads.

/**
 * Why a request was refused: it is malformed; what it names isn't there; it isn't allowed; it can't
 * be done now; a value was refused (`problems` says which and why); or a write was based on a
 * version that is no longer the file's.
 */
export type RefusalCode = "bad_request" | "not_found" | "forbidden" | "unavailable" | "invalid" | "conflict";

/** A value a request held that was refused: where it is, and why. */
export interface RefusalProblem {
  path: (string | number)[];
  message: string;
}

export class HarnessRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly problems?: readonly RefusalProblem[],
  ) {
    super(message);
    this.name = "HarnessRefusal";
  }
}
