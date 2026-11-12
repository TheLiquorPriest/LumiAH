// A read refused in words a person can act on, by the extension's backend and by the runtime alike:
// the shared reads (chat.ts, lore.ts, recall.ts) refuse a chat that isn't the user's with the same
// words wherever they run. Over the link the code goes back to the runtime as the error frame's.

import type { LinkErrorCode } from "../link/contract";

export class LinkRefused extends Error {
  constructor(
    readonly code: LinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LinkRefused";
  }
}
