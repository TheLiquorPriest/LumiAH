// The card of a tool call that asks permission (ux B4): it says who wants to do what to what in
// words, shows a file tool's change as two texts for the Workspace's diff, lists any other tool's
// arguments shortly, and keeps the call as the agent made it for the fold.

import { describe, expect, test } from "bun:test";
import { TOOL } from "../../src/core/text-def";
import { argRows, ASK_MARKS, askOf, changeOf, fileAsk, FILE_TOOL_NAMES, forChatWords, needsFile, placeOf, type Standing, waitWords } from "../../src/extension/frontend/approval-model";
import { diffLines, diffWords } from "../../src/extension/frontend/workspace-model";

const LEDGER = "# The pilot's ledger\n\n- Kept in the harbour office.";
const standing = (text: string): Standing => ({ status: "ready", text });

describe("a file tool's call, in words and as a change", () => {
  test("a write that adds a line says so, and gives the file before and after for the diff", () => {
    const call = { role: "chronicler", tool: "workspace_write", args: { path: "notes/ledger.md", content: `${LEDGER}\n- Okoro signed it on the first.`, base: "9f".repeat(32) } };
    const ask = askOf(call, standing(LEDGER));
    expect(ask.sentence).toBe("The chronicler wants to add a line to notes/ledger.md.");
    expect(ask.pieces.find((p) => p.code)?.text).toBe("notes/ledger.md");
    expect(ask.change).toEqual({ before: LEDGER, after: `${LEDGER}\n- Okoro signed it on the first.`, whole: true, note: null });
    // The diff says the change, so no argument is listed, and none of them is lost: the fold holds the call as it was made.
    expect(ask.args).toEqual([]);
    expect(JSON.parse(ask.json)).toEqual(call.args);
    expect(ask.sentence).not.toContain("9f9f");
    const diff = diffLines(ask.change?.before ?? "", ask.change?.after ?? "");
    expect(diffWords(diff, ASK_MARKS)).toBe("1 line would be added.");
  });

  test("the verb follows what the change comes to", () => {
    const write = (content: string, text: string): string => askOf({ role: "main", tool: "workspace_write", args: { path: "notes/ledger.md", content } }, standing(text)).sentence;
    expect(write("a\nb\nc", "a")).toBe("The main agent wants to add 2 lines to notes/ledger.md.");
    expect(write("a", "a\nb")).toBe("The main agent wants to remove a line from notes/ledger.md.");
    expect(write("a\nx", "a\nb")).toBe("The main agent wants to change a line of notes/ledger.md.");
    expect(write("a\nx\ny", "a\nb")).toBe("The main agent wants to change notes/ledger.md.");
    expect(write("a", "a")).toBe("The main agent wants to write notes/ledger.md again, with the text it already holds.");
  });

  test("a file that isn't there yet is made, and one still being read says so", () => {
    const call = { role: "archivist", tool: "workspace_write", args: { path: "learned/people/okoro.md", content: "Okoro reads everything twice." } };
    const made = askOf(call, { status: "none" });
    expect(made.sentence).toBe("The archivist wants to make the file learned/people/okoro.md.");
    expect(made.change).toEqual({ before: "", after: "Okoro reads everything twice.", whole: true, note: null });
    const reading = askOf(call, { status: "reading" });
    expect(reading.change).toBeNull();
    expect(reading.note).toBe("Reading the file as it stands…");
    expect(reading.sentence).toBe("The archivist wants to change learned/people/okoro.md.");
  });

  test("a file that couldn't be read shows what the agent sent, and says why", () => {
    const ask = askOf({ role: "archivist", tool: "workspace_write", args: { path: "notes/ledger.md", content: "Brann keeps the day key.", base: "new" } }, { status: "failed", message: "The extension didn't answer in time." });
    expect(ask.change).toBeNull();
    expect(ask.note).toBe("The file as it stands couldn't be read (The extension didn't answer in time), so this is what the agent sent rather than what would change.");
    expect(ask.args.map((row) => row.name)).toEqual(["content"]);
  });

  test("an edit is placed in the file; one that can't be placed shows the two texts and says the tool will turn it down", () => {
    const edit = (args: Record<string, string | boolean>, text: string) => askOf({ role: "archivist", tool: "workspace_edit", args: { path: "notes/ledger.md", ...args } }, standing(text));
    const placed = edit({ find: "day key", replace: "night key" }, "Brann keeps the day key.");
    expect(placed.change).toEqual({ before: "Brann keeps the day key.", after: "Brann keeps the night key.", whole: true, note: null });
    expect(placed.sentence).toBe("The archivist wants to change a line of notes/ledger.md.");
    const twice = edit({ find: "key", replace: "lamp" }, "The key.\nThe key again.");
    expect(twice.change?.whole).toBe(false);
    expect(twice.change?.before).toBe("key");
    expect(twice.note).toContain("holds that text 2 times");
    expect(edit({ find: "key", replace: "lamp", all: true }, "The key.\nThe key again.").change?.after).toBe("The lamp.\nThe lamp again.");
    expect(edit({ find: "ledger", replace: "log" }, "Nothing of it here.").note).toContain("doesn't hold that text");
  });

  test("a move, a delete and a pin need no file read and say what they do", () => {
    const of = (tool: string, args: Record<string, string | boolean>) => askOf({ role: "archivist", tool, args }, { status: "reading" });
    expect(of("workspace_move", { from: "notes/ledger.md", to: "learned/ledger.md" }).sentence).toBe("The archivist wants to move notes/ledger.md to learned/ledger.md.");
    expect(of("workspace_delete", { path: "~/GUIDANCE.md" }).sentence).toBe("The archivist wants to delete ~/GUIDANCE.md.");
    expect(of("workspace_pin", { path: "notes/ledger.md", pinned: true }).sentence).toBe("The archivist wants to be given notes/ledger.md with every reply it works on.");
    expect(of("workspace_pin", { path: "notes/ledger.md", pinned: "false" }).sentence).toBe("The archivist wants to stop being given notes/ledger.md with every reply.");
    expect(needsFile(fileAsk({ tool: "workspace_delete", args: { path: "notes/ledger.md" } }))).toBe(false);
    expect(of("workspace_delete", { path: "notes/ledger.md" }).note).toBeNull();
  });

  test("a path is read as the workspace reads it, and what names no one file gets no diff", () => {
    expect(placeOf("notes/ledger.md")).toEqual({ area: "chat", path: "notes/ledger.md", shown: "notes/ledger.md" });
    expect(placeOf("/notes/./ledger.md")?.path).toBe("notes/ledger.md");
    expect(placeOf("learned/chronicle/facts.md")).toEqual({ area: "learned", path: "chronicle/facts.md", shown: "learned/chronicle/facts.md" });
    expect(placeOf("~/GUIDANCE.md")).toEqual({ area: "user", path: "GUIDANCE.md", shown: "~/GUIDANCE.md" });
    for (const bad of ["", "~", "learned", "notes/../../x.md", "notes\\ledger.md", 7, null]) expect(placeOf(bad)).toBeNull();
    // With no file to name, the call shows as any other tool's: its arguments, listed.
    const ask = askOf({ role: "archivist", tool: "workspace_write", args: { path: "../x.md", content: "x" } }, { status: "reading" });
    expect(ask.change).toBeNull();
    expect(ask.args.map((row) => row.name)).toEqual(["path", "content"]);
    expect(changeOf(null, standing("x"))).toBeNull();
  });

  test("the tools read here are the core's own, by its names for them", () => {
    expect([...FILE_TOOL_NAMES].sort()).toEqual([TOOL.workspaceDelete, TOOL.workspaceEdit, TOOL.workspaceMove, TOOL.workspacePin, TOOL.workspaceWrite].sort());
  });
});

describe("any other tool's call", () => {
  test("its arguments show as a short list, a long value by its opening", () => {
    const long = "Bring notes/timeline.md up to date with the last ten replies, one line a reply, and say in your report which replies you could not place and why, so the next job can pick them up from there.";
    const ask = askOf({ role: "main", tool: "job_start", args: { agent: "archivist", task: long, when: "after_reply" } }, { status: "reading" });
    expect(ask.sentence).toBe("The main agent wants to give the archivist a job, to run once the reply is written.");
    // What the sentence already says is not listed again.
    expect(ask.args.map((row) => row.name)).toEqual(["task"]);
    expect(ask.args[0]?.value).toBe(long);
    expect(ask.args[0]?.short?.endsWith("…")).toBe(true);
    expect((ask.args[0]?.short ?? "").length).toBeLessThan(long.length);
    expect(ask.change).toBeNull();
    expect(JSON.parse(ask.json)).toEqual({ agent: "archivist", task: long, when: "after_reply" });
  });

  test("a value is said as text: a number and a yes or no as written, anything deeper as JSON", () => {
    expect(argRows({ limit: 5, deep: true, nothing: null, queries: ["night key"] })).toEqual([
      { name: "limit", value: "5", short: null },
      { name: "deep", value: "yes", short: null },
      { name: "nothing", value: "nothing", short: null },
      { name: "queries", value: '[\n  "night key"\n]', short: null },
    ]);
  });

  test("a web search, an MCP server's tool, a reading tool and an unknown one each read as a sentence", () => {
    const said = (tool: string, args: Record<string, string>) => askOf({ role: "reader", tool, args }, { status: "reading" });
    const search = said("web_search", { query: "tide tables" });
    expect(search.sentence).toBe("The reader wants to search the web for “tide tables”.");
    expect(search.args).toEqual([]);
    expect(said("mcp:charts:find_quay", { name: "north quay" }).sentence).toBe("The reader wants to use find_quay of the MCP server charts.");
    expect(said("chat_search", { query: "night key" }).sentence).toBe("The reader wants to read the chat with chat_search.");
    expect(said("lore_read", { id: "lore-night-key" }).sentence).toBe("The reader wants to read your lore with lore_read.");
    expect(said("tide_table", { day: "tomorrow" }).sentence).toBe("The reader wants to use the tool tide_table.");
    expect(said("tide_table", { day: "tomorrow" }).args).toEqual([{ name: "day", value: "tomorrow", short: null }]);
  });
});

describe("the wait and the answers", () => {
  test("how long the call still waits is said in seconds, then minutes, and what happens after", () => {
    expect(waitWords(null)).toBe("It waits for your permission for as long as the agent works.");
    expect(waitWords(0)).toBe("Its wait has run out.");
    expect(waitWords(41_200)).toBe("It waits 42 s more for your permission. After that the call is refused, and the agent is told the wait ran out.");
    expect(waitWords(125_000)).toContain("2 min 5 s more");
  });

  test("“for this chat” says it is the tool that is approved, not this one call", () => {
    expect(
      forChatWords("workspace_write")
        .map((p) => p.text)
        .join(""),
    ).toBe("“For this chat” lets every later call of workspace_write in this chat go ahead without asking.");
  });
});
