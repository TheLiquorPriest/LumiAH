// The runtime's copy of chat and lore, as the stand-in backend tells Runtime → Chat data of a linked
// runtime (`lah.runtime.chatdata`), and the database reader's switch (`lah.runtime.database`). The
// preview's user is this Lumiverse's operator, so the switch is shown; it starts off, as it ships, and
// switched on the preview's runtime reads Lumiverse's file.

import type { ChatDataView, DatabaseSwitchView } from "../../../src/shared/ui";
import type { Handlers } from "./ctx";

type Requests = "lah.runtime.chatdata" | "lah.runtime.database";

/** Where the preview's Lumiverse keeps its database, as the extension's install path places it. */
const DATABASE = "/srv/lumiverse/data/lumiverse.db";

export function chatDataMock(now: () => number): Handlers<Requests> {
  let on = false;
  const database = (): DatabaseSwitchView => ({ operator: true, on, path: DATABASE });
  const state = (): ChatDataView => {
    const at = now();
    const source = on ? "database" : "http";
    return {
      road: "copy",
      why: "The agents read chats and world books from the runtime's own copy; anything it can't vouch for is asked of the extension.",
      source,
      sourceWhy: on ? "The operator switched the database reader on, and the runtime reads Lumiverse's file itself." : "The runtime reads Lumiverse as its signed-in user: the database reader is off.",
      signIn: null,
      reader: on ? { path: DATABASE, on: true, why: null, open: true, schema: { checkedAt: at - 60_000, matches: true, difference: null }, lastRead: { at: at - 40_000, what: "chat chat-harbour", rows: 412, chars: 386_120, ms: 9, outcome: "read" }, lastCheck: { at: at - 2_000, what: "the file's change counter", rows: 0, chars: 0, ms: 0, outcome: "read" } } : null,
      memory: { kept: 401_388, most: 32_000_000, limit: "768M", note: null },
      chats: [
        {
          id: "chat-harbour",
          from: source,
          rows: 412,
          chars: 386_120,
          read: { at: at - 40_000, why: "it was first wanted" },
          checkedAt: at - 2_000,
          check: on ? { saw: "the number of messages, the newest message, the chat's own fields and the source's fingerprint of the whole chat", missed: null } : { saw: "the number of messages, the newest message and the chat's own fields", missed: "a change Lumiverse makes with no event to a message before the newest isn't seen until the chat is read again" },
          stale: null,
        },
      ],
      books: [{ id: "book-harbour", from: source, rows: 18, chars: 15_268, read: { at: at - 39_000, why: "it was first wanted" }, checkedAt: at - 39_000, check: { saw: "all of it, read whole", missed: null }, stale: null }],
      tooLarge: { chats: [], books: [] },
      reads: [
        { at: at - 40_000, what: "chat", id: "chat-harbour", why: "it was first wanted", outcome: "read" },
        { at: at - 39_000, what: "book", id: "book-harbour", why: "it was first wanted", outcome: "read" },
      ],
      fallbacks: { total: 1, latest: [{ at: at - 30_000, what: "chat", id: "chat-harbour", why: "the runtime wrote on it, and Lumiverse hasn't told of that write yet" }] },
      routes: { total: 0, latest: [] },
      events: { heard: 27, gaps: 0, lastGap: null },
    };
  };
  return {
    "lah.runtime.chatdata": () => ({ state: state(), database: database() }),
    "lah.runtime.database": (r) => {
      on = r.on;
      return { database: database() };
    },
  };
}
