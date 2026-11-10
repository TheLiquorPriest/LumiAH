// What the backend refuses, in words a person can act on. A link request's handler throws
// `LinkRefused` (its code goes back to the runtime as the error frame's); a page's request throws
// `UiRefused`. Anything else thrown is the backend's own failure and is answered `internal`.

import type { LinkErrorCode } from "../../link/contract";
import type { UiErrorCode, UiProblem } from "../../shared/ui";

export class LinkRefused extends Error {
  constructor(
    readonly code: LinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LinkRefused";
  }
}

export class UiRefused extends Error {
  constructor(
    readonly code: UiErrorCode,
    message: string,
    readonly problems?: UiProblem[],
  ) {
    super(message);
    this.name = "UiRefused";
  }
}

/** A failure's own words. */
export function wordsOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
