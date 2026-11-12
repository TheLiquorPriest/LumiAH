// What Runtime → Chat data says of a runtime's copy of chat and lore (chat-data-model.ts). Every chat,
// book and number is made up.

import { describe, expect, test } from "bun:test";
import type { ChatDataView } from "../../src/shared/ui";
import { chatDataLines, fallbackLines, keptLines, readerLines, readLines, switchWords } from "../../src/extension/frontend/chat-data-model";
import { clock } from "../../src/extension/frontend/format";

const NOW = 1_700_000_000_000;

const copied: ChatDataView = {
  road: "copy",
  why: "The agents read chats and world books from the runtime's own copy, which Lumiverse's events keep current; whatever the copy can't vouch for is asked of LumiAH.",
  source: "http",
  sourceWhy: "The copy reads Lumiverse as the runtime's signed-in user: the database reader isn't switched on for this runtime.",
  signIn: null,
  reader: null,
  memory: { kept: 401_388, most: 32_000_000, limit: "768M", note: null },
  chats: [{ id: "chat-harbour", from: "http", rows: 412, chars: 386_120, read: { at: NOW - 40_000, why: "it wasn't kept" }, checkedAt: NOW - 2_000, check: { saw: "the number of messages, the newest message and the chat's own fields", missed: "a change Lumiverse makes with no event to a message before the newest isn't seen until the chat is read again" }, stale: null }],
  books: [{ id: "book-harbour", from: "http", rows: 1, chars: 64, read: { at: NOW - 39_000, why: "it wasn't kept" }, checkedAt: NOW - 39_000, check: { saw: "all of it, read whole", missed: null }, stale: "Lumiverse changed the book as a whole" }],
  tooLarge: { chats: [], books: [] },
  reads: [
    { at: NOW - 40_000, what: "chat", id: "chat-harbour", why: "it wasn't kept", outcome: "kept" },
    { at: NOW - 39_000, what: "book", id: "book-harbour", why: "it wasn't kept", outcome: "failed: Lumiverse answered 500" },
  ],
  fallbacks: { total: 1, latest: [{ at: NOW - 30_000, what: "chat", id: "chat-harbour", why: "the runtime wrote on it, and Lumiverse hasn't told of that write yet" }] },
  routes: { total: 0, latest: [] },
  events: { heard: 27, gaps: 0, lastGap: null },
};

describe("Runtime → Chat data", () => {
  test("says where the reads go and why, what the copy reads from, what it holds beside its cap and the memory limit, its events and its fallbacks", () => {
    expect(chatDataLines(copied, NOW, "LumiAH")).toEqual([
      { text: copied.why, tone: "neutral" },
      { text: copied.sourceWhy as string, tone: "neutral" },
      { text: 'The copy holds 401,388 characters of the 32,000,000 it may keep ("Chat data kept"), beside the runtime\'s memory limit of 768M.', tone: "neutral" },
      { text: "27 events of Lumiverse's heard; none was lost on the way.", tone: "neutral" },
      { text: "1 read went to LumiAH because the copy couldn't vouch for its answer; the latest below.", tone: "neutral" },
    ]);
  });

  test("without a copy, a sign-in to renew, a chat too large, events lost and a limit nothing holds: each said, with the tone it needs", () => {
    const lines = chatDataLines(
      {
        ...copied,
        road: "link",
        why: "The runtime couldn't ask Lumiverse whose session it holds (it expired), so chats and world books are read through LumiAH until it can.",
        source: null,
        sourceWhy: null,
        signIn: "The runtime's Lumiverse session for http://127.0.0.1:7860 is no longer valid (it expired, or was signed out). Sign it in again: lumiah login",
        memory: { kept: 0, most: 0, limit: "512M", note: "Nothing holds the runtime to this limit on macOS." },
        tooLarge: { chats: [{ id: "chat-saga", chars: 40_000_000 }], books: [] },
        events: { heard: 30, gaps: 2, lastGap: { at: NOW - 120_000, why: "push 31 of LumiAH's never reached the runtime" } },
        fallbacks: { total: 0, latest: [] },
      },
      NOW,
      "LumiAH",
    );
    expect(lines.map((line) => line.tone)).toEqual(["warn", "neg", "neutral", "warn", "warn", "warn", "neutral"]);
    expect(lines[1]?.text).toStartWith("The runtime's sign-in to Lumiverse needs renewing, so the copy's reads over Lumiverse's routes go to LumiAH instead:");
    expect(lines[2]?.text).toBe('The copy keeps nothing ("Chat data kept" is 0): every read goes to LumiAH. The runtime\'s memory limit is 512M.');
    expect(lines[3]?.text).toBe("Nothing holds the runtime to this limit on macOS.");
    expect(lines[4]?.text).toBe('Chat chat-saga has 40,000,000 characters, more than all the copy may keep: it is read from LumiAH every time, until "Chat data kept" is raised past it.');
    expect(lines[5]?.text).toBe("30 events of Lumiverse's heard; 2 times something was lost on the way, the last 2 min ago (push 31 of LumiAH's never reached the runtime), and the copy read again what it held.");
    expect(lines[6]?.text).toBe("No read went to LumiAH for want of the copy vouching for it.");
  });

  test("Lumiverse's own routes not answering as the runtime expects: said plainly, with the latest route and what it answered, and the while that route is asked nothing", () => {
    const why = "reading it failed: Lumiverse answered 404 when it was asked for chat chat-harbour's messages, which the runtime doesn't take for an answer of GET /api/v1/chats/:id/messages, so the extension is asked instead";
    const answering = chatDataLines({ ...copied, routes: { total: 2, latest: [{ at: NOW - 5_000, what: "chat", id: "chat-harbour", why, route: "GET /api/v1/chats/:id/messages", status: 404, until: null }] } }, NOW, "LumiAH");
    expect(answering.at(-1)).toEqual({ text: "Lumiverse's own routes aren't answering as the runtime expects, so 2 reads of chats and world books went to LumiAH instead, the slower way. The latest, 5 s ago: GET /api/v1/chats/:id/messages answered 404 for chat chat-harbour.", tone: "warn" });
    const until = NOW + 50_000;
    const paused = chatDataLines({ ...copied, routes: { total: 9, latest: [{ at: NOW - 1_000, what: "book", id: "book-harbour", why, route: "GET /api/v1/world-books/:id", status: 404, until }] } }, NOW, "LumiAH");
    expect(paused.at(-1)?.text).toBe(`Lumiverse's own routes aren't answering as the runtime expects, so 9 reads of chats and world books went to LumiAH instead, the slower way. The latest, 1 s ago: GET /api/v1/world-books/:id answered 404 for world book book-harbour. Until ${clock(until)} the runtime asks that route nothing and reads everything it would give through LumiAH; then it tries the route again.`);
    // A while that is over isn't said, and with none of them nothing is.
    expect(chatDataLines({ ...copied, routes: { total: 9, latest: [{ at: NOW - 70_000, what: "book", id: "book-harbour", why, route: "GET /api/v1/world-books/:id", status: 404, until: NOW - 10_000 }] } }, NOW, "LumiAH").at(-1)?.text).not.toContain("Until");
    expect(chatDataLines(copied, NOW, "LumiAH").some((line) => line.text.includes("Lumiverse's own routes"))).toBe(false);
  });

  test("shown by an extension LumiAH is built into: every line that says where a read goes names that extension, never LumiAH", () => {
    const lines = chatDataLines(
      {
        ...copied,
        why: "The agents read chats and world books from the runtime's own copy, which Lumiverse's events keep current; whatever the copy can't vouch for is asked of LumiRPEngine.",
        signIn: "The runtime's Lumiverse session for http://127.0.0.1:7860 is no longer valid (it expired, or was signed out). Sign it in again: lumiah login",
        memory: { kept: 0, most: 0, limit: "512M", note: null },
        tooLarge: { chats: [{ id: "chat-saga", chars: 40_000_000 }], books: [] },
        events: { heard: 30, gaps: 1, lastGap: { at: NOW - 120_000, why: "push 31 of LumiRPEngine's never reached the runtime" } },
        routes: { total: 9, latest: [{ at: NOW - 1_000, what: "book", id: "book-harbour", why: "reading it failed", route: "GET /api/v1/world-books/:id", status: 404, until: NOW + 50_000 }] },
      },
      NOW,
      "LumiRPEngine",
    );
    for (const line of lines) expect(line.text).not.toContain("LumiAH");
    expect(lines.map((line) => line.text).filter((text) => text.includes("LumiRPEngine"))).toEqual([
      "The agents read chats and world books from the runtime's own copy, which Lumiverse's events keep current; whatever the copy can't vouch for is asked of LumiRPEngine.",
      "The runtime's sign-in to Lumiverse needs renewing, so the copy's reads over Lumiverse's routes go to LumiRPEngine instead: The runtime's Lumiverse session for http://127.0.0.1:7860 is no longer valid (it expired, or was signed out). Sign it in again: lumiah login",
      'The copy keeps nothing ("Chat data kept" is 0): every read goes to LumiRPEngine. The runtime\'s memory limit is 512M.',
      'Chat chat-saga has 40,000,000 characters, more than all the copy may keep: it is read from LumiRPEngine every time, until "Chat data kept" is raised past it.',
      "30 events of Lumiverse's heard; 1 time something was lost on the way, the last 2 min ago (push 31 of LumiRPEngine's never reached the runtime), and the copy read again what it held.",
      "1 read went to LumiRPEngine because the copy couldn't vouch for its answer; the latest below.",
      `Lumiverse's own routes aren't answering as the runtime expects, so 9 reads of chats and world books went to LumiRPEngine instead, the slower way. The latest, 1 s ago: GET /api/v1/world-books/:id answered 404 for world book book-harbour. Until ${clock(NOW + 50_000)} the runtime asks that route nothing and reads everything it would give through LumiRPEngine; then it tries the route again.`,
    ]);
  });

  test("each chat and book it holds: what, from where, its last read and why, what its last check saw and couldn't see, and a read to come", () => {
    expect(keptLines(copied.chats[0] as ChatDataView["chats"][number], "chat", NOW)).toEqual({
      title: "Chat chat-harbour",
      lines: [
        { text: "412 messages, 386,120 characters, from Lumiverse's routes.", tone: "neutral" },
        { text: "Read whole 40 s ago: it wasn't kept.", tone: "neutral" },
        { text: "Last found current 2 s ago, by the number of messages, the newest message and the chat's own fields.", tone: "neutral" },
        { text: "That couldn't see: a change Lumiverse makes with no event to a message before the newest isn't seen until the chat is read again.", tone: "warn" },
      ],
    });
    expect(keptLines({ ...(copied.books[0] as ChatDataView["books"][number]), from: "database" }, "book", NOW).lines).toEqual([
      { text: "1 entry, 64 characters, from Lumiverse's own file.", tone: "neutral" },
      { text: "Read whole 39 s ago: it wasn't kept.", tone: "neutral" },
      { text: "Last found current 39 s ago, by all of it, read whole.", tone: "neutral" },
      { text: "To be read again before it is next used: Lumiverse changed the book as a whole.", tone: "neutral" },
    ]);
  });

  test("the latest reads and fallbacks, the newest first", () => {
    expect(readLines(copied, NOW)).toEqual([
      { text: "39 s ago: world book book-harbour, as it wasn't kept: failed: Lumiverse answered 500.", tone: "warn" },
      { text: "40 s ago: chat chat-harbour, as it wasn't kept: kept.", tone: "neutral" },
    ]);
    expect(fallbackLines(copied, NOW)).toEqual([{ text: "30 s ago: chat chat-harbour, as the runtime wrote on it, and Lumiverse hasn't told of that write yet.", tone: "neutral" }]);
  });

  test("the database reader: on with its file and its check of Lumiverse's tables, or off and why", () => {
    const reader: NonNullable<ChatDataView["reader"]> = { path: "/srv/lumiverse/data/lumiverse.db", on: true, why: null, open: true, schema: { checkedAt: NOW - 60_000, matches: true, difference: null }, lastRead: { at: NOW - 40_000, what: "chat chat-harbour", rows: 412, chars: 386_120, ms: 9, outcome: "read" }, lastCheck: null };
    expect(readerLines(reader, NOW)).toEqual([
      { text: "The database reader is on, with the file open.", tone: "neutral" },
      { text: "Lumiverse's tables were as it reads them 1 min ago.", tone: "neutral" },
      { text: "Last read: chat chat-harbour, 40 s ago: read (412 rows, 386,120 characters, 9 ms).", tone: "neutral" },
    ]);
    const off = readerLines({ ...reader, on: false, open: false, why: 'The database reader is off: table "messages" in Lumiverse\'s database has no column "revision".', schema: { checkedAt: NOW - 5_000, matches: false, difference: 'table "messages" has no column "revision"' } }, NOW);
    expect(off.map((line) => line.tone)).toEqual(["warn", "neg", "neutral"]);
    expect(off[1]?.text).toBe("Lumiverse's tables weren't as it reads them 5 s ago: table \"messages\" has no column \"revision\".");
  });

  test("the operator's switch is offered to the operator alone, and the file is named to them alone", () => {
    expect(switchWords({ operator: false, on: false, path: null })).toBeNull();
    const offered = switchWords({ operator: true, on: false, path: "/srv/lumiverse/data/lumiverse.db" });
    expect(offered?.label).toBe("Read Lumiverse's database directly");
    expect(offered?.help).toContain("Lumiverse's database: /srv/lumiverse/data/lumiverse.db.");
    expect(switchWords({ operator: true, on: false, path: null })?.help).toContain("can't be told from where the extension is installed");
  });
});
