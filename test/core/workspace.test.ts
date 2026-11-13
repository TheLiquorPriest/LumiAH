// The workspace (DESIGN §11) on an in-memory host: how a path is read, what an area keeps and
// refuses, what the eight tools answer, and what the page is told. A file's version is the start of
// its body's hash, so the tests work it out from the text they wrote.

import { describe, expect, test } from "bun:test";
import { Blobs } from "../../src/core/blobs";
import { textHash } from "../../src/core/hash";
import { DOC, ROOT_AREA } from "../../src/core/paths";
import type { FileAuthor, JsonObject, WorkspaceArea } from "../../src/core/ports";
import { HarnessRefusal } from "../../src/core/refusal";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { Texts } from "../../src/core/texts";
import type { AgentTool, ToolEnv, ToolOutcome } from "../../src/core/tools";
import { WORKSPACE_TOOLS } from "../../src/core/tools/workspace";
import { chatView, loreView } from "../../src/core/views";
import { Area, type AreaIndex, changesBetween, type FileEntry, pageWorkspace, pinnedFiles, readFile, resolvePath, sameVersion, showPath, storeHead, VERSION_CHARS, versionOf, Workspace, type WorkspaceDeps, type WorkspaceView } from "../../src/core/workspace";
import { MemoryHost } from "./support/host";

const CHAT = "chat-1";
const MAIN: FileAuthor = { who: "agent", id: "agent_main", role: "main" };
const SCOUT: FileAuthor = { who: "agent", id: "agent_scout", role: "summarizer" };
const USER: FileAuthor = { who: "user" };

const PLAN = "Mara wants the lighthouse lit before the storm.\nBrann holds the key.\nIlse owes Okoro a boat.";
const BRANN = "Brann mends nets by the quay and trusts nobody.";
const LOG = "Day one: the storm turned back.";
const FACTS = "Mara likes short replies.\nJoss never swears.";
const STYLE = "Write plainly. Brann speaks in short lines.";

/** A version as the tools write it, for a text. */
const versionFor = async (text: string): Promise<string> => versionOf(await textHash(text));

/**
 * A host, the settings a test changes, and the three areas of one chat's workspace over heads kept
 * in the store; with the tools as an agent holds them (`agent`: another agent's view of the same
 * areas, with its own author, role and guard).
 */
function rig(change: (s: Settings) => void = () => undefined, own: Record<string, string> = {}) {
  const host = new MemoryHost();
  const settings = defaultSettings();
  change(settings);
  const blobs = new Blobs(host, () => settings.keep.blobChars);
  const deps: WorkspaceDeps = { host, blobs, limits: () => settings.workspace };
  const areas = {
    chat: new Area(deps, "chat", storeHead(host, DOC.chatArea(CHAT, ROOT_AREA))),
    learned: new Area(deps, "learned", storeHead(host, DOC.learned(CHAT))),
    user: new Area(deps, "user", storeHead(host, DOC.userArea)),
  };
  const agent = (as: Partial<WorkspaceView> = {}) => {
    const view: WorkspaceView = { author: MAIN, role: "main", areas, guard: () => null, ...as };
    const env: ToolEnv = { host, run: { id: "gen-now", kind: "new", chatId: CHAT }, settings, story: { hidden: "leave_out", from: "everyone", newest: "directive" }, texts: new Texts(own), agent: view.role, depth: 0, chat: chatView(host, CHAT, [], settings.tools), lore: loreView(host, { chatId: CHAT, generationId: "gen-now" }, settings.tools), past: [], workspace: view };
    const tools = new Map(WORKSPACE_TOOLS.flatMap((d) => d.build(env) ?? []).map((t): [string, AgentTool] => [t.name, t]));
    const run = (name: string, args: JsonObject = {}): Promise<ToolOutcome> => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.run(args, { signal: new AbortController().signal, agentId: "agent_test", role: view.role, callId: "c1" });
    };
    return { view, env, tools, run };
  };
  return { host, settings, blobs, deps, areas, agent, ...agent() };
}

/** A workspace with a few files in each area, written through the tools. */
async function stocked(change: (s: Settings) => void = () => undefined, own: Record<string, string> = {}) {
  const r = rig(change, own);
  for (const [path, content] of [["/notes/plan.md", PLAN], ["/notes/people/brann.md", BRANN], ["/log.md", LOG], ["learned/facts.md", FACTS], ["~/style.md", STYLE]] as const) {
    expect((await r.run("workspace_write", { path, content, base: "new" })).error).toBeUndefined();
  }
  return r;
}

/** The cursor an answer ends with, or null when it has none. */
const cursorOf = (text: string): string | null => /cursor "([^"]+)"\.\]$/.exec(text)?.[1] ?? null;

/** Every page of a tool's answer to `args`, read by following each page's cursor. */
async function pages(run: (name: string, args?: JsonObject) => Promise<ToolOutcome>, name: string, args: JsonObject): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const page: ToolOutcome = await run(name, cursor === null ? args : { ...args, cursor });
    out.push(page.text);
    cursor = cursorOf(page.text);
  } while (cursor !== null && out.length < 200);
  return out;
}

/** What a request of the page was refused with. */
async function refusal(asked: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await asked;
  } catch (error) {
    if (error instanceof HarnessRefusal) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("the request wasn't refused");
}

const fileOf = async (area: Area, path: string): Promise<FileEntry> => {
  const entry = (await area.index()).files[path];
  if (!entry) throw new Error(`no file ${path}`);
  return entry;
};

describe("a path", () => {
  test("says which area it is in by how it starts", () => {
    expect(resolvePath("/notes/plan.md", 200)).toEqual({ area: "chat", path: "notes/plan.md" });
    expect(resolvePath("notes/plan.md", 200)).toEqual({ area: "chat", path: "notes/plan.md" });
    expect(resolvePath("learned/facts.md", 200)).toEqual({ area: "learned", path: "facts.md" });
    expect(resolvePath("/learned/facts.md", 200)).toEqual({ area: "learned", path: "facts.md" });
    expect(resolvePath("~/style.md", 200)).toEqual({ area: "user", path: "style.md" });
    expect(resolvePath("~x/style.md", 200)).toEqual({ area: "chat", path: "~x/style.md" });
    expect(resolvePath("Learned/facts.md", 200)).toEqual({ area: "chat", path: "Learned/facts.md" });
  });

  test("is trimmed and normalized, and an area's root is the empty path", () => {
    expect(resolvePath("  //notes/./people//brann.md/  ", 200)).toEqual({ area: "chat", path: "notes/people/brann.md" });
    expect(resolvePath("/", 200)).toEqual({ area: "chat", path: "" });
    expect(resolvePath("", 200)).toEqual({ area: "chat", path: "" });
    expect(resolvePath("learned", 200)).toEqual({ area: "learned", path: "" });
    expect(resolvePath("learned/", 200)).toEqual({ area: "learned", path: "" });
    expect(resolvePath("~", 200)).toEqual({ area: "user", path: "" });
    expect(resolvePath("~/", 200)).toEqual({ area: "user", path: "" });
  });

  test("may climb inside its area, and is refused when it would leave it", () => {
    expect(resolvePath("/notes/../plan.md", 200)).toEqual({ area: "chat", path: "plan.md" });
    expect(resolvePath("learned/a/../b.md", 200)).toEqual({ area: "learned", path: "b.md" });
    expect(resolvePath("~/a/b/../../c.md", 200)).toEqual({ area: "user", path: "c.md" });
    expect(resolvePath("/notes/..", 200)).toEqual({ area: "chat", path: "" });
    for (const outside of ["/../plan.md", "..", "learned/../notes/plan.md", "~/..", "~/a/../../b", "/notes/../learned/facts.md"]) expect({ outside, at: resolvePath(outside, 200) }).toEqual({ outside, at: { refused: "outside" } });
  });

  test("is refused past Path length, counted within its area, and when it holds what no path may", () => {
    expect(resolvePath(`/${"a".repeat(20)}`, 20)).toEqual({ area: "chat", path: "a".repeat(20) });
    expect(resolvePath(`learned/${"a".repeat(20)}`, 20)).toEqual({ area: "learned", path: "a".repeat(20) });
    expect(resolvePath(`/${"a".repeat(21)}`, 20)).toEqual({ refused: "long" });
    expect(resolvePath(`~/notes/${"a".repeat(15)}`, 20)).toEqual({ refused: "long" });
    for (const bad of ["notes\\plan.md", "/notes/pl\nan.md", "/a\tb", "~/a\u0000b", "/a\u0085b"]) expect({ bad, at: resolvePath(bad, 200) }).toEqual({ bad, at: { refused: "bad" } });
  });

  test("is written back as agents read it, and read back names the same place", () => {
    expect([showPath("chat", "notes/a.md"), showPath("learned", "a.md"), showPath("user", "a.md")]).toEqual(["/notes/a.md", "learned/a.md", "~/a.md"]);
    expect([showPath("chat", ""), showPath("learned", ""), showPath("user", "")]).toEqual(["/", "learned/", "~/"]);
    for (const area of ["chat", "learned", "user"] as WorkspaceArea[]) for (const path of ["", "a.md", "notes/people/brann.md", "~/odd name.md"]) expect(resolvePath(showPath(area, path), 200)).toEqual({ area, path });
  });
});

describe("a version", () => {
  test("is the start of the body's hash, and a base names it by the whole hash or a start of it", async () => {
    const hash = await textHash(PLAN);
    expect(VERSION_CHARS).toBe(12);
    expect(versionOf(hash)).toBe(hash.slice(0, 12));
    expect(sameVersion(hash, hash)).toBe(true);
    expect(sameVersion(versionOf(hash), hash)).toBe(true);
    expect(sameVersion(`  ${versionOf(hash).toUpperCase()} `, hash)).toBe(true);
    expect(sameVersion(hash.slice(0, 8), hash)).toBe(true);
    expect(sameVersion(hash.slice(0, 7), hash)).toBe(false);
    expect(sameVersion("", hash)).toBe(false);
    expect(sameVersion(versionOf(await textHash(LOG)), hash)).toBe(false);
  });
});

describe("the workspace tools", () => {
  test("are eight, each described, the ones that change a file in the write tier; none is offered without a workspace", () => {
    const r = rig();
    expect([...r.tools.keys()]).toEqual(["workspace_list", "workspace_read", "workspace_grep", "workspace_write", "workspace_edit", "workspace_move", "workspace_delete", "workspace_pin"]);
    expect(WORKSPACE_TOOLS.map((d) => [d.family, d.tier])).toEqual([["workspace", "read"], ["workspace", "read"], ["workspace", "read"], ["workspace", "write"], ["workspace", "write"], ["workspace", "write"], ["workspace", "write"], ["workspace", "write"]]);
    for (const tool of r.tools.values()) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters.type).toBe("object");
      for (const arg of Object.values(tool.parameters.properties as Record<string, { description: string }>)) expect(arg.description.length).toBeGreaterThan(10);
    }
    // What a model must know before it writes: the three areas, and that a change names its version.
    const told = [...r.tools.values()].map((t) => t.description).join("\n");
    for (const said of ["/ is this chat's own, and follows the story", "learned/ is kept with the chat whatever path the story takes", "~/ is the user's own, shared by all their chats", "Every change names the version it was based on"]) expect(told).toContain(said);
    const { workspace: _none, ...bare } = r.env;
    expect(WORKSPACE_TOOLS.map((d) => d.build(bare))).toEqual([null, null, null, null, null, null, null, null]);
  });

  test("write a file, read it back and list it", async () => {
    const r = rig();
    const hash = await textHash(PLAN);
    const version = versionOf(hash);
    expect(await r.run("workspace_write", { path: "/notes/plan.md", content: PLAN, base: "new" })).toEqual({
      text: `Wrote /notes/plan.md: ${PLAN.length} characters, now at version ${version}. Your next change to it takes that version as base.`,
      files: [{ area: "chat", path: "notes/plan.md", before: null, after: hash }],
    });
    expect(await r.run("workspace_read", { path: "notes/plan.md" })).toEqual({ text: `[/notes/plan.md: characters 0 to ${PLAN.length} of ${PLAN.length}, version ${version}. A write, an edit, a move or a delete of this file takes that version as base.]\n${PLAN}` });
    expect((await r.run("workspace_list")).text).toBe(["This is /, the chat's own area. ~/ is the user's own area, shared by all their chats: list it with path ~/.", "1 folder or file found; showing 1 to 1.", "- /notes/ (folder, 1 file)"].join("\n"));
    expect((await r.run("workspace_list", { path: "/notes" })).text).toBe(`1 folder or file found; showing 1 to 1.\n- /notes/plan.md (${PLAN.length} characters, version ${version})`);
    // The write is recorded as the agent's own, at the host's time.
    expect(await fileOf(r.areas.chat, "notes/plan.md")).toEqual({ hash, chars: PLAN.length, at: r.host.clock.now(), by: MAIN, was: [], pins: [] });
  });

  test("workspace_list shows what is directly in a folder: its folders with their files counted, then its files", async () => {
    const r = await stocked();
    expect((await r.run("workspace_list", {})).text).toBe(
      [
        "This is /, the chat's own area. ~/ is the user's own area, shared by all their chats: list it with path ~/.",
        "3 folders and files found; showing 1 to 3.",
        "- learned/ (folder, 1 file)",
        "- /notes/ (folder, 2 files)",
        `- /log.md (${LOG.length} characters, version ${await versionFor(LOG)})`,
      ].join("\n"),
    );
    expect((await r.run("workspace_list", { path: "/notes/" })).text).toBe(["2 folders and files found; showing 1 to 2.", "- /notes/people/ (folder, 1 file)", `- /notes/plan.md (${PLAN.length} characters, version ${await versionFor(PLAN)})`].join("\n"));
    expect((await r.run("workspace_list", { path: "learned/" })).text).toBe(`1 folder or file found; showing 1 to 1.\n- learned/facts.md (${FACTS.length} characters, version ${await versionFor(FACTS)})`);
    expect((await r.run("workspace_list", { path: "~" })).text).toBe(`1 folder or file found; showing 1 to 1.\n- ~/style.md (${STYLE.length} characters, version ${await versionFor(STYLE)})`);
    // A long listing comes a page at a time, like every listing.
    const small = await stocked((s) => (s.tools.pageItems = 2));
    const lead = "This is /, the chat's own area. ~/ is the user's own area, shared by all their chats: list it with path ~/.";
    expect(await pages(small.run, "workspace_list", {})).toEqual([
      [lead, "3 folders and files found; showing 1 to 2.", "- learned/ (folder, 1 file)", "- /notes/ (folder, 2 files)", '[There is more: call workspace_list again with the same arguments and cursor "2".]'].join("\n"),
      [lead, "3 folders and files found; showing 3 to 3.", `- /log.md (${LOG.length} characters, version ${await versionFor(LOG)})`, "[That is the end.]"].join("\n"),
    ]);
  });

  test("workspace_list says what to do with a path that names a file, nothing, or an empty area", async () => {
    const r = await stocked();
    expect(await r.run("workspace_list", { path: "/log.md" })).toEqual({ text: `/log.md is a file, not a folder: ${LOG.length} characters, version ${await versionFor(LOG)}. workspace_read reads it.` });
    expect(await r.run("workspace_list", { path: "/drafts" })).toEqual({ text: "There is nothing at /drafts: no file, and no folder that holds one. workspace_list without a path lists the workspace from the top.", error: true });
    const empty = rig();
    expect(await empty.run("workspace_list", { path: "~/" })).toEqual({ text: "~/ holds no files yet." });
    expect(await empty.run("workspace_list")).toEqual({ text: "This is /, the chat's own area. ~/ is the user's own area, shared by all their chats: list it with path ~/.\n/ holds no files yet." });
  });

  test("workspace_read pages a long file by cursor, and says what to do with a folder or a path that names nothing", async () => {
    const r = rig((s) => (s.tools.pageChars = 400));
    const long = Array.from({ length: 60 }, (_, i) => `Line ${i}: Okoro trims the lamp.`).join("\n");
    await r.run("workspace_write", { path: "~/lamp.md", content: long, base: "new" });
    const all = await pages(r.run, "workspace_read", { path: "~/lamp.md" });
    expect(all.length).toBeGreaterThan(4);
    expect(all[0]).toStartWith(`[~/lamp.md: characters 0 to `);
    expect(all.at(-1)).toEndWith("[That is the end.]");
    expect(all.map((page) => page.split("\n").slice(1).join("\n").replace(/\n\[(There is more|That is the end)[^\]]*\]$/, "")).join("")).toBe(long);
    expect(await r.run("workspace_read", { path: "~/lamp.md", cursor: "999999" })).toEqual({ text: "“999999” isn't a cursor workspace_read gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.", error: true });
    expect(await r.run("workspace_read", { path: "~/lamps.md" })).toEqual({ text: "There's no file ~/lamps.md. workspace_list shows the files there are.", error: true });
    expect(await r.run("workspace_read", { path: "~/" })).toEqual({ text: "~/ is a folder, and this takes one file. workspace_list with that path lists the files in it.", error: true });
    expect(await r.run("workspace_read", {})).toEqual({ text: "workspace_read needs path: The file's path, as workspace_list writes it: /notes/plan.md in this chat's own area, learned/… kept with the chat, ~/… the user's own. Call it again with path.", error: true });
  });

  test("a page is never longer than Tool results clipped past, whatever Answer length says, so a long file is paged and never clipped", async () => {
    const r = rig((s) => {
      s.tools.pageChars = 8000;
      s.loop.clipChars = 400;
    });
    const long = Array.from({ length: 60 }, (_, i) => `Line ${i}: Okoro trims the lamp.`).join("\n");
    await r.run("workspace_write", { path: "~/lamp.md", content: long, base: "new" });
    const all = await pages(r.run, "workspace_read", { path: "~/lamp.md" });
    expect(all.length).toBeGreaterThan(4);
    for (const page of all) expect(page.length).toBeLessThanOrEqual(400);
    expect(all.map((page) => page.split("\n").slice(1).join("\n").replace(/\n\[(There is more|That is the end)[^\]]*\]$/, "")).join("")).toBe(long);
  });

  test("a file whose text the store lost says so, and comes back when the same text is written again", async () => {
    // Nothing kept in memory, so a read goes to the store.
    const r = await stocked((s) => (s.keep.blobChars = 0));
    const version = await versionFor(LOG);
    r.host.blobStore.delete(await textHash(LOG));
    expect(await r.run("workspace_read", { path: "/log.md" })).toEqual({ text: `The text of /log.md (version ${version}) is no longer in the store, so it can't be read. If you know what it held, write it again with workspace_write and base ${version}; else say in your answer that it is lost.`, error: true });
    expect((await r.run("workspace_edit", { path: "/log.md", find: "storm", replace: "calm", base: version })).text).toStartWith("The text of /log.md");
    // A search reads past it.
    expect((await r.run("workspace_grep", { text: "storm" })).text).toBe("1 line found; showing 1 to 1.\n- /notes/plan.md, line 1: Mara wants the lighthouse lit before the storm.");
    expect(await r.run("workspace_write", { path: "/log.md", content: LOG, base: version })).toEqual({ text: `/log.md already holds exactly this text, so nothing changed. It is at version ${version}.` });
    expect((await r.run("workspace_read", { path: "/log.md" })).text).toEndWith(LOG);
  });

  test("a write based on a version that is no longer the file's is refused with the version there is, then taken on that version", async () => {
    const r = await stocked();
    const first = await versionFor(PLAN);
    const second = `${PLAN}\nThe key is under the third step.`;
    expect((await r.run("workspace_write", { path: "/notes/plan.md", content: second, base: first })).error).toBeUndefined();
    // Another agent still holds the first version.
    const scout = r.agent({ author: SCOUT, role: "summarizer" });
    const third = `${PLAN}\nThe key is lost.`;
    expect(await scout.run("workspace_write", { path: "/notes/plan.md", content: third, base: first })).toEqual({
      text: `Nothing was changed: /notes/plan.md is at version ${await versionFor(second)} now, and that isn't the version you gave as base: it was changed since you read it, or the base was miscopied. Read it again with workspace_read and make your change on what it holds now.`,
      error: true,
    });
    expect((await r.run("workspace_read", { path: "/notes/plan.md" })).text).toEndWith(second);
    const taken = await scout.run("workspace_write", { path: "/notes/plan.md", content: third, base: await versionFor(second) });
    expect(taken.text).toBe(`Wrote /notes/plan.md: ${third.length} characters, now at version ${await versionFor(third)}. Your next change to it takes that version as base.`);
    expect(taken.files).toEqual([{ area: "chat", path: "notes/plan.md", before: await textHash(second), after: await textHash(third) }]);
    // Each version is recorded as whoever wrote it.
    const entry = await fileOf(r.areas.chat, "notes/plan.md");
    expect([entry.by, ...entry.was.map((was) => was.by)]).toEqual([SCOUT, MAIN, MAIN]);
  });

  test("new is refused where a file is, a base where none is, and the same text makes no version", async () => {
    const r = await stocked();
    const version = await versionFor(LOG);
    expect(await r.run("workspace_write", { path: "/log.md", content: "Day two.", base: "new" })).toEqual({
      text: `Nothing was changed: there is already a file /log.md, at version ${version}. To replace its text, read it with workspace_read and write with that version as base; else choose another path.`,
      error: true,
    });
    expect(await r.run("workspace_write", { path: "/diary.md", content: "Day two.", base: version })).toEqual({ text: "Nothing was written: there's no file /diary.md, so there is no version to base it on. To make the file, call workspace_write again with base new. workspace_list shows the files there are.", error: true });
    expect(await r.run("workspace_write", { path: "/log.md", content: LOG, base: version })).toEqual({ text: `/log.md already holds exactly this text, so nothing changed. It is at version ${version}.` });
    expect((await fileOf(r.areas.chat, "log.md")).was).toEqual([]);
    expect((await r.run("workspace_write", { path: "/log.md", content: "", base: version })).text).toStartWith("Wrote /log.md: 0 characters");
    expect(await r.run("workspace_write", { path: "/log.md", base: version })).toEqual({ text: "workspace_write needs content: The file's whole text, as it is to stand. Call it again with content.", error: true });
    expect((await r.run("workspace_write", { path: "/log.md", content: "Day two." })).text).toStartWith("workspace_write needs base: new for a file that isn't there yet;");
    expect(await r.run("workspace_write", { path: "learned/", content: "x", base: "new" })).toEqual({ text: "learned/ is a folder, and this takes one file. workspace_list with that path lists the files in it.", error: true });
  });

  test("workspace_edit replaces one exact match, and says what to do when the text isn't there or is there several times", async () => {
    const r = await stocked();
    const version = await versionFor(PLAN);
    // What takes the text's place is written as it is: no part of it is read as a replace pattern.
    const edited = PLAN.replace("Brann holds the key.", () => "Brann lost the key: $& and $1 stay as written.");
    expect(await r.run("workspace_edit", { path: "/notes/plan.md", find: "Brann holds the key.", replace: "Brann lost the key: $& and $1 stay as written.", base: version })).toEqual({
      text: `Edited /notes/plan.md: 1 match replaced. It holds ${edited.length} characters now, at version ${await versionFor(edited)}. Your next change to it takes that version as base.`,
      files: [{ area: "chat", path: "notes/plan.md", before: await textHash(PLAN), after: await textHash(edited) }],
    });
    expect((await r.run("workspace_read", { path: "/notes/plan.md" })).text).toEndWith(edited);
    const now = await versionFor(edited);
    expect(await r.run("workspace_edit", { path: "/notes/plan.md", find: "Joss holds the key.", replace: "x", base: now })).toEqual({
      text: `Nothing was changed: /notes/plan.md (version ${now}) doesn't hold that text, character for character. Read the file again with workspace_read and copy the text to replace from what it gives.`,
      error: true,
    });
    expect(await r.run("workspace_edit", { path: "/notes/plan.md", find: "the", replace: "a", base: now })).toEqual({
      text: "Nothing was changed: that text is in /notes/plan.md 3 times. Give more of the text around the one you mean, until find matches once, or pass all: true to replace every one.",
      error: true,
    });
    const every = edited.split("the").join("a");
    const all = await r.run("workspace_edit", { path: "/notes/plan.md", find: "the", replace: "a", base: now, all: true });
    expect(all.text).toBe(`Edited /notes/plan.md: 3 matches replaced. It holds ${every.length} characters now, at version ${await versionFor(every)}. Your next change to it takes that version as base.`);
    expect((await r.run("workspace_read", { path: "/notes/plan.md" })).text).toEndWith(every);
    // An edit based on a version the file no longer has is told that, whatever it looks for.
    expect((await r.run("workspace_edit", { path: "/notes/plan.md", find: "Brann", replace: "Joss", base: version })).text).toStartWith(`Nothing was changed: /notes/plan.md is at version ${await versionFor(every)} now`);
    expect((await r.run("workspace_edit", { path: "/notes/plan.md", find: "", replace: "x", base: now })).text).toStartWith("workspace_edit needs find:");
    // Taking the text out is an edit too.
    expect((await r.run("workspace_edit", { path: "/log.md", find: " turned back", replace: "", base: await versionFor(LOG) })).text).toStartWith("Edited /log.md: 1 match replaced. It holds 19 characters now");
  });

  test("workspace_move moves a file within its area, its history and pins with it; across areas it says how", async () => {
    const r = await stocked();
    const version = await versionFor(BRANN);
    await r.run("workspace_pin", { path: "/notes/people/brann.md", pinned: true });
    const hash = await textHash(BRANN);
    expect(await r.run("workspace_move", { from: "/notes/people/brann.md", to: "/people/brann.md", base: version })).toEqual({
      text: `Moved /notes/people/brann.md to /people/brann.md. Its text is the same, so its version is still ${version}.`,
      files: [
        { area: "chat", path: "notes/people/brann.md", before: hash, after: null },
        { area: "chat", path: "people/brann.md", before: null, after: hash },
      ],
    });
    expect((await r.areas.chat.index()).files["notes/people/brann.md"]).toBeUndefined();
    expect((await fileOf(r.areas.chat, "people/brann.md")).pins).toEqual(["main"]);
    expect(await r.run("workspace_move", { from: "/people/brann.md", to: "~/brann.md", base: version })).toEqual({
      text: "Nothing was moved: a move stays inside one area, and /people/brann.md and ~/brann.md are in two. To take the file across, read it, write it there with workspace_write and base new, then delete it here with workspace_delete.",
      error: true,
    });
    expect((await r.run("workspace_move", { from: "/people/brann.md", to: "/log.md", base: version })).text).toStartWith(`Nothing was changed: there is already a file /log.md, at version ${await versionFor(LOG)}.`);
    expect((await r.run("workspace_move", { from: "/people/brann.md", to: "/people/b.md", base: await versionFor(LOG) })).text).toStartWith(`Nothing was changed: /people/brann.md is at version ${version} now`);
    expect(await r.run("workspace_move", { from: "/people", to: "/folk", base: version })).toEqual({ text: "/people/ is a folder, and this takes one file. workspace_list with that path lists the files in it.", error: true });
    expect(await r.run("workspace_move", { from: "/nobody.md", to: "/folk.md", base: version })).toEqual({ text: "There's no file /nobody.md. workspace_list shows the files there are.", error: true });
  });

  test("workspace_delete deletes the version it names, and no other", async () => {
    const r = await stocked();
    const version = await versionFor(LOG);
    expect((await r.run("workspace_delete", { path: "/log.md", base: await versionFor(PLAN) })).text).toStartWith(`Nothing was changed: /log.md is at version ${version} now`);
    expect(await r.run("workspace_delete", { path: "/log.md", base: version })).toEqual({ text: `Deleted /log.md. It was at version ${version}.`, files: [{ area: "chat", path: "log.md", before: await textHash(LOG), after: null }] });
    expect(await r.run("workspace_read", { path: "/log.md" })).toEqual({ text: "There's no file /log.md. workspace_list shows the files there are.", error: true });
    expect((await r.run("workspace_delete", { path: "/log.md", base: version })).error).toBe(true);
  });

  test("workspace_pin pins a file for the agent's own definition and lifts the pin; pins are read in the areas' order", async () => {
    const r = await stocked((s) => {
      s.workspace.pinChars = 500;
      // The user let agents pin in ~/ too: the three areas' pins are read in order.
      s.workspace.agentsPinUser = true;
    });
    expect(await r.run("workspace_pin", { path: "~/style.md", pinned: true })).toEqual({
      text: `Pinned ~/style.md: it leads what you are sent each turn, as it stands then. Your pinned files hold ${STYLE.length} characters together now; up to 500 are given in full (Pinned files in context), and a file past that is only named.`,
    });
    await r.run("workspace_pin", { path: "learned/facts.md", pinned: "true" });
    const pinned = await r.run("workspace_pin", { path: "/notes/plan.md", pinned: true });
    expect(pinned.text).toContain(`Your pinned files hold ${STYLE.length + FACTS.length + PLAN.length} characters together now`);
    // A pin is no version: nothing is traced as changed, and the file's history is as it was.
    expect(pinned.files).toBeUndefined();
    expect(await fileOf(r.areas.chat, "notes/plan.md")).toMatchObject({ hash: await textHash(PLAN), was: [], pins: ["main"] });
    // Another definition's pins are its own.
    const scout = r.agent({ author: SCOUT, role: "summarizer" });
    await scout.run("workspace_pin", { path: "/log.md", pinned: true });
    expect((await pinnedFiles(r.view)).map((pin) => showPath(pin.area, pin.path))).toEqual(["/notes/plan.md", "learned/facts.md", "~/style.md"]);
    expect((await pinnedFiles(scout.view)).map((pin) => showPath(pin.area, pin.path))).toEqual(["/log.md"]);
    expect((await r.run("workspace_list", { path: "/notes" })).text).toContain(`- /notes/plan.md (${PLAN.length} characters, version ${await versionFor(PLAN)}, pinned for you)`);
    expect((await scout.run("workspace_list", { path: "/notes" })).text).not.toContain("pinned for you");
    // A pin stays through a write.
    await r.run("workspace_write", { path: "/notes/plan.md", content: `${PLAN}\nMore.`, base: await versionFor(PLAN) });
    expect((await fileOf(r.areas.chat, "notes/plan.md")).pins).toEqual(["main"]);
    expect(await r.run("workspace_pin", { path: "/notes/plan.md", pinned: false })).toEqual({ text: "Lifted the pin on /notes/plan.md: it no longer leads what you are sent. workspace_read still reads it." });
    expect((await pinnedFiles(r.view)).map((pin) => showPath(pin.area, pin.path))).toEqual(["learned/facts.md", "~/style.md"]);
    expect(await r.run("workspace_pin", { path: "/nobody.md", pinned: true })).toEqual({ text: "There's no file /nobody.md. workspace_list shows the files there are.", error: true });
    expect((await r.run("workspace_pin", { path: "/log.md", pinned: "yes" })).text).toStartWith("workspace_pin needs pinned: true to pin the file, false to lift its pin.");
  });

  test("an agent's pin in ~/ is refused in words unless Settings let agents pin there; the user's own pin on the page stands", async () => {
    const r = await stocked();
    const refused = {
      text: "Nothing was changed: ~/style.md is in ~/, the user's own area, and a pin there leads what you are sent in every chat of theirs, so pins there are the user's to set and to lift, on the Workspace page (Agents may pin your own files). To have this text each turn in this chat, keep it in a file in / or learned/ and pin that.",
      error: true as const,
    };
    expect(await r.run("workspace_pin", { path: "~/style.md", pinned: true })).toEqual(refused);
    expect((await fileOf(r.areas.user, "style.md")).pins).toEqual([]);
    expect(await pinnedFiles(r.view)).toEqual([]);
    // The chat's own two areas are the agent's to pin in.
    expect((await r.run("workspace_pin", { path: "/log.md", pinned: true })).error).toBeUndefined();
    expect((await r.run("workspace_pin", { path: "learned/facts.md", pinned: true })).error).toBeUndefined();
    // The user pins it on the page: the agent is given it, and may not lift what the user set.
    const page = pageWorkspace({ author: USER, role: "main", areas: r.areas, guard: () => null }, () => r.settings.workspace);
    await page.pin({ area: "user", path: "style.md", on: true });
    expect((await pinnedFiles(r.view)).map((pin) => showPath(pin.area, pin.path))).toEqual(["/log.md", "learned/facts.md", "~/style.md"]);
    expect(await r.run("workspace_pin", { path: "~/style.md", pinned: false })).toEqual(refused);
    expect((await fileOf(r.areas.user, "style.md")).pins).toEqual(["main"]);
    // The refusal is a text of the registry: the user's own words for it are the ones said.
    const own = await stocked(undefined, { "workspace.pin.user": "{{path}}: pins in ~/ are the user's." });
    expect(await own.run("workspace_pin", { path: "~/style.md", pinned: true })).toEqual({ text: "~/style.md: pins in ~/ are the user's.", error: true });
    // Settings let agents pin there.
    r.settings.workspace.agentsPinUser = true;
    expect((await r.run("workspace_pin", { path: "~/style.md", pinned: false })).text).toStartWith("Lifted the pin on ~/style.md");
    expect((await r.run("workspace_pin", { path: "~/style.md", pinned: true })).text).toStartWith("Pinned ~/style.md");
  });

  test("the tools that change things change nothing once the agent's signal has ended", async () => {
    const r = await stocked();
    await r.run("workspace_pin", { path: "/log.md", pinned: true });
    const before = { documents: structuredClone([...r.host.documents]), blobs: r.host.blobStore.size };
    const stopped = new AbortController();
    const why = new Error("the turn was stopped");
    stopped.abort(why);
    const ctx = { signal: stopped.signal, agentId: "agent_test", role: "main", callId: "c1" };
    const version = await versionFor(LOG);
    const calls: [string, JsonObject][] = [
      ["workspace_write", { path: "/late.md", content: "Written after the stop.", base: "new" }],
      ["workspace_write", { path: "/log.md", content: "Day two.", base: version }],
      ["workspace_edit", { path: "/log.md", find: "storm", replace: "calm", base: version }],
      ["workspace_move", { from: "/log.md", to: "/moved.md", base: version }],
      ["workspace_delete", { path: "/log.md", base: version }],
      ["workspace_pin", { path: "/log.md", pinned: false }],
      ["workspace_pin", { path: "/notes/plan.md", pinned: true }],
    ];
    for (const [name, args] of calls) {
      // The call ends with why its agent did: the loop says so in the agent's stop.
      const ended = await r.tools.get(name)?.run(args, ctx).then(
        () => null,
        (error: unknown) => error,
      );
      expect([name, ended]).toEqual([name, why]);
    }
    expect({ documents: [...r.host.documents], blobs: r.host.blobStore.size }).toEqual(before);
    expect(Object.keys((await r.areas.chat.index()).files).sort()).toEqual(["log.md", "notes/people/brann.md", "notes/plan.md"]);
    // Reading goes on being answered: nothing is changed by it.
    expect((await r.tools.get("workspace_read")?.run({ path: "/log.md" }, ctx))?.text).toEndWith(LOG);
  });

  test("a change whose agent is stopped while the tool reads the file is not made", async () => {
    const r = await stocked();
    const version = await versionFor(LOG);
    for (const [name, args] of [
      ["workspace_edit", { path: "/log.md", find: "storm", replace: "calm", base: version }],
      ["workspace_move", { from: "/log.md", to: "/moved.md", base: version }],
      ["workspace_delete", { path: "/log.md", base: version }],
      ["workspace_pin", { path: "/log.md", pinned: true }],
    ] as [string, JsonObject][]) {
      const stop = new AbortController();
      // The stop lands while the area's index is being read, after the call began.
      const index = r.areas.chat.index.bind(r.areas.chat);
      r.areas.chat.index = async () => {
        stop.abort(new Error("the turn was stopped"));
        return index();
      };
      const ended = await r.tools.get(name)?.run(args, { signal: stop.signal, agentId: "agent_test", role: "main", callId: "c1" }).then(
        () => null,
        (error: unknown) => error,
      );
      r.areas.chat.index = index;
      expect([name, ended]).toEqual([name, stop.signal.reason]);
    }
    expect(await fileOf(r.areas.chat, "log.md")).toMatchObject({ hash: await textHash(LOG), was: [], pins: [] });
  });

  test("workspace_grep finds lines in any letter case, in the chat's area and learned/ unless told where, and pages by cursor", async () => {
    const r = await stocked((s) => (s.tools.pageItems = 2));
    expect(await pages(r.run, "workspace_grep", { text: "T" })).toEqual([
      ["6 lines found; showing 1 to 2.", "- /log.md, line 1: Day one: the storm turned back.", "- /notes/people/brann.md, line 1: Brann mends nets by the quay and trusts nobody.", '[There is more: call workspace_grep again with the same arguments and cursor "2".]'].join("\n"),
      ["6 lines found; showing 3 to 4.", "- /notes/plan.md, line 1: Mara wants the lighthouse lit before the storm.", "- /notes/plan.md, line 2: Brann holds the key.", '[There is more: call workspace_grep again with the same arguments and cursor "4".]'].join("\n"),
      ["6 lines found; showing 5 to 6.", "- /notes/plan.md, line 3: Ilse owes Okoro a boat.", "- learned/facts.md, line 1: Mara likes short replies.", "[That is the end.]"].join("\n"),
    ]);
    expect(await r.run("workspace_grep", { text: "T", cursor: "6" })).toEqual({ text: "“6” isn't a cursor workspace_grep gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.", error: true });
  });

  test("workspace_grep searches the user's area, a folder or one file when told to, and says where it looked when it finds nothing", async () => {
    const r = await stocked();
    expect((await r.run("workspace_grep", { text: "BRANN", path: "~/" })).text).toBe("1 line found; showing 1 to 1.\n- ~/style.md, line 1: Write plainly. Brann speaks in short lines.");
    expect((await r.run("workspace_grep", { text: "swears" })).text).toBe("1 line found; showing 1 to 1.\n- learned/facts.md, line 2: Joss never swears.");
    expect((await r.run("workspace_grep", { text: "brann", path: "/notes/people" })).text).toBe("1 line found; showing 1 to 1.\n- /notes/people/brann.md, line 1: Brann mends nets by the quay and trusts nobody.");
    expect((await r.run("workspace_grep", { text: "key", path: "/notes/plan.md" })).text).toBe("1 line found; showing 1 to 1.\n- /notes/plan.md, line 2: Brann holds the key.");
    expect(await r.run("workspace_grep", { text: "dragon" })).toEqual({ text: "No line holds “dragon” in /, learned/ (4 files searched). Try a shorter piece of it, or look elsewhere: without a path the search covers / and learned/, and path ~/ searches the user's own files." });
    expect((await r.run("workspace_grep", { text: "swears", path: "/notes" })).text).toStartWith("No line holds “swears” in /notes (2 files searched).");
    expect((await r.run("workspace_grep", {})).text).toStartWith("workspace_grep needs text:");
  });

  test("a path that can't be read is answered with what a path may be", async () => {
    const r = await stocked((s) => (s.workspace.pathChars = 30));
    expect(await r.run("workspace_read", { path: "/notes/../../plan.md" })).toEqual({ text: "That path climbs out of its area: .. may go up inside an area, never above it. Say which area by how the path starts: / for this chat's own, learned/, or ~/ for the user's.", error: true });
    expect(await r.run("workspace_write", { path: "notes\\plan.md", content: "x", base: "new" })).toEqual({ text: "That path can't be used: a path holds no backslash and no control character. Put / between its folders, as in /notes/plan.md.", error: true });
    expect(await r.run("workspace_write", { path: `/notes/${"long-".repeat(8)}name.md`, content: "x", base: "new" })).toEqual({ text: "That path is too long: within its area Path length (Settings → The workspace) lets a path hold 30 characters at most. Use shorter names or fewer folders.", error: true });
  });

  test("each limit refuses in words that name its setting and the numbers", async () => {
    const r = await stocked((s) => (s.workspace = { ...s.workspace, fileChars: 120, files: 4, areaChars: 200 }));
    expect(await r.run("workspace_write", { path: "/log.md", content: "x".repeat(121), base: await versionFor(LOG) })).toEqual({ text: "Nothing was changed: the file would hold 121 characters, and File length (Settings → The workspace) lets a file hold 120 at most. Split it over several files.", error: true });
    // The chat's area holds three files; one more of forty characters would take it past Area size.
    const before = PLAN.length + BRANN.length + LOG.length;
    expect(await r.run("workspace_write", { path: "/more.md", content: "x".repeat(40), base: "new" })).toEqual({
      text: `Nothing was changed: with it this area's files would hold ${before + 40} characters together, and Area size (Settings → The workspace) lets an area hold 200 at most. Delete or shorten files nobody needs any more first.`,
      error: true,
    });
    expect((await r.run("workspace_write", { path: "/more.md", content: "x", base: "new" })).error).toBeUndefined();
    expect(await r.run("workspace_write", { path: "/fifth.md", content: "x", base: "new" })).toEqual({ text: "Nothing was changed: this area already holds the 4 files Files per area (Settings → The workspace) allows. Delete files nobody needs any more, or add to one there is.", error: true });
    // An edit that would take the file past File length is refused like a write.
    expect((await r.run("workspace_edit", { path: "/log.md", find: "Day one", replace: "y".repeat(100), base: await versionFor(LOG) })).text).toContain("File length (Settings → The workspace)");
    // Each area has its own count and size.
    expect((await r.run("workspace_write", { path: "~/more.md", content: "x".repeat(40), base: "new" })).error).toBeUndefined();
  });

  test("an area over a limit that was lowered can still be brought down", async () => {
    const r = await stocked();
    r.settings.workspace.areaChars = 100;
    const shorter = "Mara wants the lighthouse lit.";
    expect((await r.run("workspace_write", { path: "/notes/plan.md", content: shorter, base: await versionFor(PLAN) })).error).toBeUndefined();
    expect((await r.run("workspace_write", { path: "/notes/plan.md", content: `${shorter}!`, base: await versionFor(shorter) })).text).toContain("Area size (Settings → The workspace)");
  });

  test("what the agent may not write is refused in its holder's words, before anything is changed", async () => {
    // Agents may pin in ~/ here, so the last line asks the guard alone.
    const r = await stocked((s) => {
      s.workspace.agentsPinUser = true;
    });
    const guarded = r.agent({ guard: (area, path) => (area === "user" && path === "style.md" ? "~/style.md is the user's to write: ask them to change it." : area === "chat" && path === "frozen.md" ? "/frozen.md may not be written." : null) });
    const version = await versionFor(STYLE);
    const refused = { text: "~/style.md is the user's to write: ask them to change it.", error: true as const };
    expect(await guarded.run("workspace_write", { path: "~/style.md", content: "x", base: version })).toEqual(refused);
    expect(await guarded.run("workspace_edit", { path: "~/style.md", find: "plainly", replace: "well", base: version })).toEqual(refused);
    expect(await guarded.run("workspace_delete", { path: "~/style.md", base: version })).toEqual(refused);
    expect(await guarded.run("workspace_move", { from: "~/style.md", to: "~/voice.md", base: version })).toEqual(refused);
    // A move is refused for where it goes as for where it comes from.
    expect(await guarded.run("workspace_move", { from: "/log.md", to: "/frozen.md", base: await versionFor(LOG) })).toEqual({ text: "/frozen.md may not be written.", error: true });
    expect((await guarded.run("workspace_read", { path: "~/style.md" })).text).toEndWith(STYLE);
    expect((await guarded.run("workspace_pin", { path: "~/style.md", pinned: true })).error).toBeUndefined();
    expect(await fileOf(r.areas.user, "style.md")).toMatchObject({ hash: await textHash(STYLE), was: [] });
  });

  test("a run without a chat has the user's area alone, and is told so", async () => {
    const r = await stocked();
    const side = r.agent({ areas: { chat: null, learned: null, user: r.areas.user } });
    const told = { text: "Your workspace has no / here. It has: ~/ (the user's own files). Give a path in one of those.", error: true as const };
    expect(await side.run("workspace_list")).toEqual(told);
    expect(await side.run("workspace_grep", { text: "Brann" })).toEqual(told);
    expect(await side.run("workspace_write", { path: "learned/facts.md", content: "x", base: "new" })).toEqual({ text: "Your workspace has no learned/ here. It has: ~/ (the user's own files). Give a path in one of those.", error: true });
    expect((await side.run("workspace_list", { path: "~/" })).text).toContain("- ~/style.md");
    const chatOnly = r.agent({ areas: { chat: r.areas.chat, learned: r.areas.learned, user: null } });
    expect(await chatOnly.run("workspace_read", { path: "~/style.md" })).toEqual({ text: "Your workspace has no ~/ here. It has: / (this chat's own files), learned/ (kept with the chat). Give a path in one of those.", error: true });
    // Without the user's area there is nothing to point to from the chat's top.
    expect((await chatOnly.run("workspace_list")).text).toStartWith("3 folders and files found; showing 1 to 3.");
  });

  test("answers within Answer length, whatever it is asked", async () => {
    for (const pageChars of [600, 300]) {
      const r = rig((s) => {
        s.tools = { ...s.tools, pageChars, pageItems: 50 };
        // Paths longer than a small page has room for: an answer names them cut, never past the page.
        s.workspace.pathChars = 400;
      });
      const deep = `/${"a-long-folder-name/".repeat(15)}the-file.md`;
      const far = `~/${"another-long-folder/".repeat(15)}the-file.md`;
      const long = Array.from({ length: 80 }, (_, i) => `Line ${i}: Okoro trims the lamp while Ilse counts the boats coming in.`).join("\n");
      for (const path of [deep, far, "/lamp.md", "learned/lamp.md"]) expect((await r.run("workspace_write", { path, content: long, base: "new" })).text.length).toBeLessThanOrEqual(pageChars);
      for (let i = 0; i < 30; i++) await r.run("workspace_write", { path: `/many/note-${i}.md`, content: `Note ${i}: Brann mends a net.`, base: "new" });
      const version = await versionFor(long);
      const guarded = r.agent({ guard: () => `No: ${"this run may not write here. ".repeat(40)}` });
      const asks: [string, JsonObject, typeof r.run?][] = [
        ["workspace_list", {}],
        ["workspace_list", { path: "/many" }],
        ["workspace_list", { path: deep.slice(0, 58) }],
        ["workspace_list", { path: deep }],
        ["workspace_list", { path: `${deep}/nothing` }],
        ["workspace_read", { path: deep }],
        ["workspace_read", { path: `${deep}x` }],
        ["workspace_read", { path: deep.slice(0, 58) }],
        ["workspace_grep", { text: "okoro" }],
        ["workspace_grep", { text: "Okoro trims the lamp while Ilse counts the boats coming in. ".repeat(20) }],
        ["workspace_grep", { text: "dragon", path: deep }],
        ["workspace_write", { path: deep, content: "x", base: "0123456789ab" }],
        ["workspace_write", { path: deep, content: "x", base: "new" }],
        ["workspace_write", { path: `${deep}x`, content: "x", base: version }],
        ["workspace_write", { path: deep, content: long, base: version }],
        ["workspace_write", { path: deep, content: "x", base: version }, guarded.run],
        ["workspace_edit", { path: deep, find: "dragon", replace: "x", base: version }],
        ["workspace_edit", { path: deep, find: "Okoro", replace: "x", base: version }],
        ["workspace_move", { from: deep, to: far, base: version }],
        ["workspace_move", { from: deep, to: "/lamp.md", base: version }],
        ["workspace_move", { from: deep, to: `${deep}.moved`, base: version }],
        ["workspace_pin", { path: `${deep}.moved`, pinned: true }],
        ["workspace_pin", { path: `${deep}.moved`, pinned: false }],
        ["workspace_delete", { path: `${deep}.moved`, base: version }],
        ["workspace_delete", { path: far, base: "0123456789ab" }],
        ["workspace_read", { path: "\\" }],
        ["workspace_read", { path: `/${"x".repeat(900)}` }],
        ["workspace_pin", { path: far }],
      ];
      const paged: Record<string, number> = {};
      for (const [name, args, run = r.run] of asks) {
        let cursor: string | null = null;
        let read = 0;
        do {
          const page: ToolOutcome = await run(name, cursor === null ? args : { ...args, cursor });
          expect({ pageChars, name, args, within: page.text.length <= pageChars }).toEqual({ pageChars, name, args, within: true });
          cursor = cursorOf(page.text);
        } while (cursor !== null && ++read < 400);
        // Every answer that comes in pages comes to its end.
        expect(read).toBeLessThan(400);
        paged[name] = Math.max(paged[name] ?? 0, read);
      }
      // The long file, the long listing and the search were read over several pages each.
      expect([paged.workspace_list, paged.workspace_read, paged.workspace_grep].every((most) => (most ?? 0) > 1)).toBe(true);
      // The file with the long path was read whole, in pages that each held a fair piece of it.
      const all = await pages(r.run, "workspace_read", { path: far });
      expect(all.map((page) => page.split("\n").slice(1).join("\n").replace(/\n\[(There is more|That is the end)[^\]]*\]$/, "")).join("")).toBe(long);
      expect(all.length).toBeLessThan(long.length / 20);
    }
  });

  test("a replaced text is what the model reads", async () => {
    const r = await stocked(undefined, { "tool.workspace_read": "Read a file.", "workspace.no_file": "Nothing at {{path}}.", "workspace.list.file": "* {{path}} @ {{version}}", "word.folder_or_file": "thing|things" });
    expect(r.tools.get("workspace_read")?.description).toBe("Read a file.");
    expect(await r.run("workspace_read", { path: "/nobody.md" })).toEqual({ text: "Nothing at /nobody.md.", error: true });
    expect((await r.run("workspace_list", { path: "~/" })).text).toBe(`1 thing found; showing 1 to 1.\n* ~/style.md @ ${await versionFor(STYLE)}`);
  });
});

describe("an area", () => {
  test("keeps as many earlier versions as Versions kept, the newest first", async () => {
    const r = rig((s) => (s.workspace.versions = 2));
    const texts = ["one", "two", "three", "four"];
    let base = "new";
    for (const [i, content] of texts.entries()) {
      r.host.clock.advance(1000);
      expect((await r.agent({ author: i % 2 === 0 ? MAIN : SCOUT }).run("workspace_write", { path: "/count.md", content, base })).error).toBeUndefined();
      base = await versionFor(content);
    }
    const entry = await fileOf(r.areas.chat, "count.md");
    expect(entry).toEqual({
      hash: await textHash("four"),
      chars: 4,
      at: r.host.clock.now(),
      by: SCOUT,
      was: [
        { hash: await textHash("three"), chars: 5, at: r.host.clock.now() - 1000, by: MAIN },
        { hash: await textHash("two"), chars: 3, at: r.host.clock.now() - 2000, by: SCOUT },
      ],
      pins: [],
    });
    // An earlier version's text is still read by its hash.
    expect(await r.areas.chat.text(entry.was[1]?.hash ?? "")).toBe("two");
    r.settings.workspace.versions = 0;
    await r.run("workspace_write", { path: "/count.md", content: "five", base });
    expect((await fileOf(r.areas.chat, "count.md")).was).toEqual([]);
  });

  test("is one object for one path, so two writers of one version take turns: the second is refused as stale", async () => {
    const host = new MemoryHost();
    const settings = defaultSettings();
    const workspace = new Workspace({ host, blobs: new Blobs(host, () => settings.keep.blobChars), limits: () => settings.workspace });
    const mine = workspace.area("user", DOC.userArea);
    const yours = workspace.area("user", DOC.userArea);
    expect(yours).toBe(mine);
    expect(workspace.area("learned", DOC.learned(CHAT))).not.toBe(mine);
    await mine.write({ path: "style.md", text: STYLE, base: null, by: USER });
    const base = await textHash(STYLE);
    const [first, second] = await Promise.all([mine.write({ path: "style.md", text: "Mara's way.", base, by: MAIN }), yours.write({ path: "style.md", text: "Joss's way.", base, by: SCOUT })]);
    expect(first).toMatchObject({ ok: true, changes: [{ area: "user", path: "style.md", before: base, after: await textHash("Mara's way.") }] });
    expect(second).toEqual({ ok: false, why: { code: "stale", path: "style.md", version: await textHash("Mara's way.") } });
    expect(await mine.text((await fileOf(mine, "style.md")).hash)).toBe("Mara's way.");
    // Changes to different files, asked at once, all land.
    await Promise.all(["a.md", "b.md", "c.md"].map((path) => workspace.area("user", DOC.userArea).write({ path, text: path, base: null, by: MAIN })));
    expect(Object.keys((await mine.index()).files)).toEqual(["a.md", "b.md", "c.md", "style.md"]);
  });

  test("is read by a second workspace over the same store as the first left it", async () => {
    const host = new MemoryHost();
    const settings = defaultSettings();
    const first = new Workspace({ host, blobs: new Blobs(host, () => settings.keep.blobChars), limits: () => settings.workspace });
    await first.area("learned", DOC.learned(CHAT)).write({ path: "facts.md", text: FACTS, base: null, by: MAIN });
    // As after a restart: nothing kept in memory.
    const blobs = new Blobs(host, () => 0);
    const second = new Workspace({ host, blobs, limits: () => settings.workspace });
    const area = second.area("learned", DOC.learned(CHAT));
    const entry = await fileOf(area, "facts.md");
    expect(await area.text(entry.hash)).toBe(FACTS);
    expect(await area.headHash()).toBe(await first.area("learned", DOC.learned(CHAT)).headHash());
    expect(await second.index(await area.headHash())).toEqual(await area.index());
    // And a holder that wrote meanwhile is seen at the next change: its head is read first.
    await area.write({ path: "facts.md", text: "Mara likes long replies.", base: entry.hash, by: USER });
    expect(await first.area("learned", DOC.learned(CHAT)).write({ path: "facts.md", text: "x", base: entry.hash, by: MAIN })).toEqual({ ok: false, why: { code: "stale", path: "facts.md", version: await textHash("Mara likes long replies.") } });
    expect(await second.index(null)).toEqual({ v: 1, kind: "index", files: {} });
  });

  test("starts from its head's seed until it first changes, and leaves what it was seeded from as it was", async () => {
    const r = await stocked();
    const before = await r.areas.chat.headHash();
    let asked = 0;
    const head = storeHead(r.host, DOC.chatArea(CHAT, "gen-2"), async () => {
      asked++;
      return before;
    });
    expect(await head.read()).toBe(before);
    const turn = new Area(r.deps, "chat", head);
    expect(Object.keys((await turn.index()).files)).toEqual(["log.md", "notes/people/brann.md", "notes/plan.md"]);
    expect(r.host.documents.has(DOC.chatArea(CHAT, "gen-2"))).toBe(false);
    r.host.clock.advance(5000);
    expect((await turn.write({ path: "log.md", text: "Day two.", base: await textHash(LOG), by: MAIN })).ok).toBe(true);
    expect(r.host.documents.get(DOC.chatArea(CHAT, "gen-2"))).toEqual({ v: 1, kind: "area", head: await turn.headHash(), at: r.host.clock.now() });
    // Once it has a document of its own the seed is no longer asked.
    const seeded = asked;
    expect(await turn.text((await fileOf(turn, "log.md")).hash)).toBe("Day two.");
    expect(asked).toBe(seeded);
    // The area it started from is where it was.
    expect(await r.areas.chat.headHash()).toBe(before);
    expect((await fileOf(r.areas.chat, "log.md")).hash).toBe(await textHash(LOG));
    // Without a seed, an area with no document has never held a file.
    expect(await storeHead(r.host, DOC.chatArea(CHAT, "gen-3")).read()).toBeNull();
    expect(await new Area(r.deps, "chat", storeHead(r.host, DOC.chatArea(CHAT, "gen-3"))).headHash()).toBeNull();
  });

  test("reads as empty, with a line in the log, when its index is gone from the store or isn't one", async () => {
    const r = await stocked();
    const head = await r.areas.user.headHash();
    r.host.blobStore.delete(head ?? "");
    const fresh = new Area({ ...r.deps, blobs: new Blobs(r.host, () => 0) }, "user", storeHead(r.host, DOC.userArea));
    expect(await fresh.index()).toEqual({ v: 1, kind: "index", files: {} });
    expect(await fresh.index()).toEqual({ v: 1, kind: "index", files: {} });
    expect(r.host.logs).toEqual([{ level: "warn", message: `the workspace index ${head} is gone from the store, so the area reads as holding no files` }]);
    const notOne = await r.blobs.put("Brann's letter, which is no index.");
    await r.host.store.write(DOC.learned(CHAT), { v: 1, kind: "area", head: notOne, at: 1 });
    expect(Object.keys((await r.areas.learned.index()).files)).toEqual([]);
    expect(r.host.logs.at(-1)).toEqual({ level: "warn", message: `the stored blob ${notOne} isn't a workspace index, so the area reads as holding no files` });
  });

  test("takes a forced change whatever version is there", async () => {
    const r = await stocked();
    const forced = await r.areas.chat.write({ path: "log.md", text: "Day nine.", base: null, by: USER, force: true });
    expect(forced).toMatchObject({ ok: true, entry: { hash: await textHash("Day nine."), was: [{ hash: await textHash(LOG) }] } });
    expect((await r.areas.chat.write({ path: "new.md", text: "x", base: "0123456789ab", by: USER, force: true })).ok).toBe(true);
    expect((await r.areas.chat.move({ from: "new.md", to: "newer.md", base: "0123456789ab", by: USER, force: true })).ok).toBe(true);
    expect((await r.areas.chat.remove({ path: "newer.md", base: "0123456789ab", by: USER, force: true })).ok).toBe(true);
    // There is still nothing to move or remove where no file is.
    expect(await r.areas.chat.remove({ path: "newer.md", base: "0123456789ab", by: USER, force: true })).toEqual({ ok: false, why: { code: "missing", path: "newer.md" } });
  });

  test("holds a file under any name", async () => {
    const r = rig();
    for (const path of ["constructor", "__proto__", "toString/hasOwnProperty"]) {
      expect(await r.areas.user.remove({ path, base: "0123456789ab", by: USER })).toEqual({ ok: false, why: { code: "missing", path } });
      expect((await r.areas.user.write({ path, text: `Ilse's ${path}`, base: null, by: USER })).ok).toBe(true);
    }
    const again = new Area({ ...r.deps, blobs: new Blobs(r.host, () => 0) }, "user", storeHead(r.host, DOC.userArea));
    expect(Object.keys((await again.index()).files)).toEqual(["__proto__", "constructor", "toString/hasOwnProperty"]);
    expect((await r.run("workspace_read", { path: "~/__proto__" })).text).toEndWith("Ilse's __proto__");
    expect((await r.run("workspace_read", { path: "~/valueOf" })).error).toBe(true);
  });
});

describe("what goes into an agent's context", () => {
  test("a file is read by its path as an agent writes it; null when there is none, or its area isn't there", async () => {
    const r = await stocked();
    expect(await readFile(r.view, "learned/facts.md", 200)).toEqual({ area: "learned", path: "facts.md", entry: await fileOf(r.areas.learned, "facts.md"), text: FACTS });
    expect((await readFile(r.view, " notes/./plan.md ", 200))?.text).toBe(PLAN);
    expect(await readFile(r.view, "/notes/nobody.md", 200)).toBeNull();
    expect(await readFile(r.view, "/notes", 200)).toBeNull();
    expect(await readFile(r.view, "/../plan.md", 200)).toBeNull();
    expect(await readFile(r.view, "/notes/plan.md", 5)).toBeNull();
    expect(await readFile({ ...r.view, areas: { chat: null, learned: null, user: r.areas.user } }, "/notes/plan.md", 200)).toBeNull();
  });
});

describe("a change set", () => {
  test("names each file added, changed or gone between two indexes, by path, with who wrote it", async () => {
    const r = await stocked();
    const before: AreaIndex = await r.areas.chat.index();
    const scout = r.agent({ author: SCOUT, role: "summarizer" });
    await scout.run("workspace_write", { path: "/notes/plan.md", content: "Plan B.", base: await versionFor(PLAN) });
    await r.run("workspace_write", { path: "/added.md", content: "Okoro's list.", base: "new" });
    await scout.run("workspace_delete", { path: "/log.md", base: await versionFor(LOG) });
    await scout.run("workspace_move", { from: "/notes/people/brann.md", to: "/people/brann.md", base: await versionFor(BRANN) });
    // A pin changes no file.
    await r.run("workspace_pin", { path: "/added.md", pinned: true });
    const after = await r.areas.chat.index();
    expect(changesBetween("chat", before, after)).toEqual([
      { area: "chat", path: "added.md", before: null, after: await textHash("Okoro's list."), by: MAIN },
      { area: "chat", path: "log.md", before: await textHash(LOG), after: null, by: MAIN },
      { area: "chat", path: "notes/people/brann.md", before: await textHash(BRANN), after: null, by: MAIN },
      { area: "chat", path: "notes/plan.md", before: await textHash(PLAN), after: await textHash("Plan B."), by: SCOUT },
      { area: "chat", path: "people/brann.md", before: null, after: await textHash(BRANN), by: MAIN },
    ]);
    expect(changesBetween("chat", after, after)).toEqual([]);
    expect(changesBetween("learned", { v: 1, kind: "index", files: {} }, await r.areas.learned.index())).toEqual([{ area: "learned", path: "facts.md", before: null, after: await textHash(FACTS), by: MAIN }]);
  });
});

describe("the page", () => {
  /** The page's side of the stocked workspace, as the user. */
  async function paged(change: (s: Settings) => void = () => undefined, guard: WorkspaceView["guard"] = () => null) {
    const r = await stocked(change);
    return { ...r, page: pageWorkspace({ author: USER, role: "main", areas: r.areas, guard }, () => r.settings.workspace) };
  }

  test("lists an area, and reads, writes, moves, pins and deletes a file as the user, with its history", async () => {
    const r = await paged();
    const row = { path: "notes/plan.md", hash: await textHash(PLAN), chars: PLAN.length, at: r.host.clock.now(), by: MAIN, pins: [] };
    expect(await r.page.list({ area: "chat" })).toEqual({
      area: "chat",
      files: [
        { path: "log.md", hash: await textHash(LOG), chars: LOG.length, at: r.host.clock.now(), by: MAIN, pins: [] },
        { path: "notes/people/brann.md", hash: await textHash(BRANN), chars: BRANN.length, at: r.host.clock.now(), by: MAIN, pins: [] },
        row,
      ],
      chars: LOG.length + BRANN.length + PLAN.length,
      limits: { fileChars: 200_000, files: 400, areaChars: 4_000_000, pinChars: 24_000 },
    });
    expect(await r.page.read({ area: "chat", path: "notes/plan.md" })).toEqual({ file: row, text: PLAN, version: { hash: row.hash, chars: PLAN.length, at: r.host.clock.now(), by: MAIN } });
    r.host.clock.advance(60_000);
    const edited = `${PLAN}\nThe user's own line.`;
    const written = { path: "notes/plan.md", hash: await textHash(edited), chars: edited.length, at: r.host.clock.now(), by: USER, pins: [] };
    // A write answers with the file as it stands and what it changed; a write of the text the file holds changes nothing.
    expect(await r.page.write({ area: "chat", path: "notes/plan.md", text: edited, base: row.hash })).toEqual({ file: written, changes: [{ area: "chat", path: "notes/plan.md", before: row.hash, after: written.hash }] });
    expect(await r.page.write({ area: "chat", path: "notes/plan.md", text: edited, base: written.hash })).toEqual({ file: written, changes: [] });
    expect(await r.page.write({ area: "user", path: "new.md", text: "Mine.", base: null })).toEqual({ file: { path: "new.md", hash: await textHash("Mine."), chars: 5, at: r.host.clock.now(), by: USER, pins: [] }, changes: [{ area: "user", path: "new.md", before: null, after: await textHash("Mine.") }] });
    expect(await r.page.history({ area: "chat", path: "notes/plan.md" })).toEqual({
      versions: [
        { hash: written.hash, chars: edited.length, at: r.host.clock.now(), by: USER },
        { hash: row.hash, chars: PLAN.length, at: r.host.clock.now() - 60_000, by: MAIN },
      ],
    });
    // An earlier version is read by its hash or a start of it, with the file as it stands beside it; one the file doesn't keep is refused.
    expect(await r.page.read({ area: "chat", path: "notes/plan.md", version: versionOf(row.hash) })).toEqual({ file: written, text: PLAN, version: { hash: row.hash, chars: PLAN.length, at: r.host.clock.now() - 60_000, by: MAIN } });
    expect(await refusal(r.page.read({ area: "chat", path: "notes/plan.md", version: await textHash(LOG) }))).toEqual({ code: "not_found", message: "/notes/plan.md has no such version among the 2 it keeps (Versions kept): it may have been dropped since the page listed them." });
    expect(await r.page.pin({ area: "chat", path: "notes/plan.md", on: true })).toEqual({ file: { ...written, pins: ["main"] } });
    expect(await r.page.pin({ area: "chat", path: "notes/plan.md", on: true, role: "summarizer" })).toEqual({ file: { ...written, pins: ["main", "summarizer"] } });
    expect(await r.page.pin({ area: "chat", path: "notes/plan.md", on: false })).toEqual({ file: { ...written, pins: ["summarizer"] } });
    expect(await r.page.move({ area: "chat", from: "notes/plan.md", to: "plan.md", base: versionOf(written.hash) })).toEqual({ file: { ...written, path: "plan.md", pins: ["summarizer"] } });
    expect(await r.page.delete({ area: "chat", path: "plan.md", base: written.hash })).toEqual({ deleted: true });
    expect((await r.page.list({ area: "chat" })).files.map((file) => file.path)).toEqual(["log.md", "notes/people/brann.md"]);
    // The agents see the user's writes as they see each other's.
    expect((await r.run("workspace_read", { path: "~/new.md" })).text).toEndWith("Mine.");
  });

  test("is refused with not_found for a file or an area that isn't there", async () => {
    const r = await paged();
    expect(await refusal(r.page.read({ area: "chat", path: "nobody.md" }))).toEqual({ code: "not_found", message: "There is no file /nobody.md: it may have been moved or deleted since the page read it." });
    expect((await refusal(r.page.history({ area: "user", path: "nobody.md" }))).code).toBe("not_found");
    expect((await refusal(r.page.pin({ area: "learned", path: "nobody.md", on: true }))).code).toBe("not_found");
    expect((await refusal(r.page.delete({ area: "chat", path: "nobody.md", base: await textHash(LOG) }))).code).toBe("not_found");
    expect((await refusal(r.page.write({ area: "chat", path: "nobody.md", text: "x", base: await textHash(LOG) }))).code).toBe("not_found");
    const side = pageWorkspace({ author: USER, role: "main", areas: { chat: null, learned: null, user: r.areas.user }, guard: () => null }, () => r.settings.workspace);
    expect(await refusal(side.list({ area: "chat" }))).toEqual({ code: "not_found", message: "That area isn't there: the chat's own files and learned/ need a chat." });
    expect((await side.list({ area: "user" })).files).toHaveLength(1);
  });

  test("is refused with conflict, naming the version there is, for a file already there or changed since", async () => {
    const r = await paged();
    const version = await versionFor(LOG);
    expect(await refusal(r.page.write({ area: "chat", path: "log.md", text: "x", base: null }))).toEqual({ code: "conflict", message: `There is already a file /log.md, at version ${version}.` });
    expect(await refusal(r.page.write({ area: "chat", path: "log.md", text: "x", base: await textHash(PLAN) }))).toEqual({ code: "conflict", message: `/log.md has changed since it was read: it is at version ${version} now. Read it again, then make the change on that.` });
    expect((await refusal(r.page.delete({ area: "chat", path: "log.md", base: await textHash(PLAN) }))).code).toBe("conflict");
    expect(await refusal(r.page.move({ area: "chat", from: "log.md", to: "notes/plan.md", base: version }))).toEqual({ code: "conflict", message: `There is already a file /notes/plan.md, at version ${await versionFor(PLAN)}.` });
  });

  test("is refused with invalid for a limit, in words that name its setting", async () => {
    const r = await paged((s) => (s.workspace = { ...s.workspace, fileChars: 120, files: 4, areaChars: 200, pathChars: 30 }));
    const base = await textHash(LOG);
    expect(await refusal(r.page.write({ area: "chat", path: "log.md", text: "x".repeat(121), base }))).toEqual({ code: "invalid", message: "The text is 121 characters, and File length (Settings → The workspace) lets a file hold 120 at most." });
    expect(await refusal(r.page.write({ area: "chat", path: "more.md", text: "x".repeat(40), base: null }))).toEqual({ code: "invalid", message: `With this the area's files would hold ${PLAN.length + BRANN.length + LOG.length + 40} characters together, and Area size (Settings → The workspace) lets an area hold 200 at most.` });
    await r.page.write({ area: "chat", path: "more.md", text: "x", base: null });
    expect(await refusal(r.page.write({ area: "chat", path: "fifth.md", text: "x", base: null }))).toEqual({ code: "invalid", message: "The area already holds as many files as Files per area (Settings → The workspace) lets it: 4." });
    expect(await refusal(r.page.write({ area: "user", path: `notes/${"long-".repeat(8)}name.md`, text: "x", base: null }))).toEqual({ code: "invalid", message: "Path length (Settings → The workspace) lets a path hold 30 characters at most." });
    // The refusal says which value of the request it is about, for the page to show it there.
    const refused = await r.page.write({ area: "chat", path: "log.md", text: "x".repeat(121), base }).catch((error: unknown) => error);
    expect(refused instanceof HarnessRefusal ? refused.problems : null).toEqual([{ path: ["text"], message: "The text is 121 characters, and File length (Settings → The workspace) lets a file hold 120 at most." }]);
  });

  test("is refused with bad_request for a path that can't be one, or a request that isn't one", async () => {
    const r = await paged();
    expect(await refusal(r.page.read({ area: "chat", path: "notes\\plan.md" }))).toEqual({ code: "bad_request", message: "A path can't hold a backslash or a control character." });
    expect(await refusal(r.page.read({ area: "learned", path: "../notes/plan.md" }))).toEqual({ code: "bad_request", message: "A path can't leave its area: “..” may climb within it, never out of it." });
    expect(await refusal(r.page.write({ area: "chat", path: "learned/facts.md", text: "x", base: null }))).toEqual({ code: "bad_request", message: "In the chat's own area a path can't start with learned: learned/ is an area of its own." });
    expect(await refusal(r.page.write({ area: "user", path: "/", text: "x", base: null }))).toEqual({ code: "bad_request", message: "A file's path needs a name." });
    // What a page sends is never taken on trust.
    const loose = r.page as unknown as Record<"list" | "read" | "write" | "pin" | "delete", (input: unknown) => Promise<unknown>>;
    expect(await refusal(loose.list({ area: "attic" }))).toEqual({ code: "bad_request", message: "A workspace request's area must be chat, learned or user." });
    expect(await refusal(loose.read({ area: "chat" }))).toEqual({ code: "bad_request", message: "A workspace request's path must be a path within its area." });
    expect(await refusal(loose.write({ area: "chat", path: "log.md", text: 7, base: null }))).toEqual({ code: "bad_request", message: "A workspace request's text must be the file's text." });
    expect(await refusal(loose.write({ area: "chat", path: "log.md", text: "x" }))).toEqual({ code: "bad_request", message: "A workspace request's base must be the version the change was based on, or null for a new file." });
    expect(await refusal(loose.pin({ area: "chat", path: "log.md", on: "yes" }))).toEqual({ code: "bad_request", message: "A workspace request's on must be true to pin the file, false to lift its pin." });
    expect(await refusal(loose.delete({ area: "chat", path: "log.md" }))).toEqual({ code: "bad_request", message: "A workspace request's base must be the version the change was based on." });
    // A file in the user's area may sit under any folder name, learned among them.
    expect((await r.page.write({ area: "user", path: "learned/own.md", text: "x", base: null })).file.path).toBe("learned/own.md");
  });

  test("is refused with forbidden, in the guard's words, for a file its holder may not write", async () => {
    const r = await paged(undefined, (area, path) => (area === "learned" && path === "facts.md" ? "Joss keeps this file: it can't be changed here." : null));
    const base = await textHash(FACTS);
    const told = { code: "forbidden", message: "Joss keeps this file: it can't be changed here." };
    expect(await refusal(r.page.write({ area: "learned", path: "facts.md", text: "x", base }))).toEqual(told);
    expect(await refusal(r.page.delete({ area: "learned", path: "facts.md", base }))).toEqual(told);
    expect(await refusal(r.page.move({ area: "learned", from: "facts.md", to: "f.md", base }))).toEqual(told);
    expect((await r.page.read({ area: "learned", path: "facts.md" })).text).toBe(FACTS);
    expect((await r.page.write({ area: "learned", path: "other.md", text: "x", base: null })).file.by).toEqual(USER);
  });
});
