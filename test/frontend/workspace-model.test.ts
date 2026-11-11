// What the Workspace and Guidance pages decide before they draw: how a file is named, how its
// area's files make a tree, which path the page refuses before the backend does, what is pinned
// for whom, what two texts differ by, what a turn changed, which versions are compared, when typed
// text is unsaved or overtaken, and where the page goes when another page leads to it.

import { describe, expect, test } from "bun:test";
import type { FileTarget } from "../../src/extension/frontend/app";
import {
  agentsEditWords,
  areaRowWords,
  areaSummary,
  authorWords,
  basisWords,
  boundOf,
  changeRows,
  changesSummary,
  type Draft,
  diffLines,
  diffWords,
  draftKey,
  draftPlace,
  draftsElsewhere,
  fileFacts,
  foldDiff,
  followNav,
  fullPath,
  guidanceCutWords,
  guidanceDraftKey,
  isDirty,
  isStale,
  levelFacts,
  levelName,
  newDraftKey,
  normalizePath,
  pathProblem,
  pickedPair,
  pickVersion,
  pinChoices,
  pinGroups,
  pinMark,
  pinnedCount,
  pinnedWords,
  refusalWords,
  START_KEPT,
  type TreeRow,
  treeOf,
  treeRows,
  versionFacts,
  versionRows,
  waitingWords,
  writeProblem,
  wroteWords,
} from "../../src/extension/frontend/workspace-model";
import type { ChangedFile, FileAuthor, FileVersion, WorkspaceArea, WorkspaceFile, WorkspaceView } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const USER: FileAuthor = { who: "user" };
const ARCHIVIST: FileAuthor = { who: "agent", id: "archivist-1", role: "archivist" };
const JOB: FileAuthor = { who: "job", id: "job-timeline-1", role: "archivist" };
const AGENTS = [
  { id: "main", name: "Main agent" },
  { id: "writer", name: "Writer" },
  { id: "archivist", name: "Archivist" },
];
const LIMITS = { fileChars: 1000, files: 4, areaChars: 2000, pinChars: 500 };

const file = (path: string, over: Partial<WorkspaceFile> = {}): WorkspaceFile => ({ path, hash: `h:${path}`, chars: 100, at: T0 - 180_000, by: ARCHIVIST, pins: [], ...over });
const view = (area: WorkspaceArea, files: WorkspaceFile[], over: Partial<WorkspaceView> = {}): WorkspaceView => ({ area, files, chars: files.reduce((n, f) => n + f.chars, 0), limits: LIMITS, agents: AGENTS, basis: null, ...over });
const version = (hash: string | null, at: number, over: Partial<FileVersion> = {}): FileVersion => ({ hash, chars: 40, at, by: USER, turn: null, ...over });

describe("how a file and its author are said", () => {
  test("a file is named as agents write its path", () => {
    expect(fullPath("chat", "notes/ledger.md")).toBe("notes/ledger.md");
    expect(fullPath("learned", "people/okoro.md")).toBe("learned/people/okoro.md");
    expect(fullPath("user", "GUIDANCE.md")).toBe("~/GUIDANCE.md");
  });

  test("an author is you, an agent by its role, or a job by its role", () => {
    expect(authorWords(USER)).toBe("you");
    expect(authorWords({ who: "agent", id: "main-1", role: "main" })).toBe("Main agent");
    expect(authorWords(ARCHIVIST)).toBe("Archivist (agent)");
    expect(authorWords(JOB)).toBe("Archivist (job)");
  });

  test("a file's row says its length, when it was written and by whom", () => {
    expect(fileFacts({ chars: 1200, at: T0 - 180_000, by: JOB }, T0)).toBe("1,200 characters · 3 min ago · by Archivist (job)");
  });

  test("the chat's area says which reply it stands on", () => {
    expect(basisWords({ messageId: "msg-0043", swipe: 0, index: 43 })).toContain("reply #43");
    expect(basisWords({ messageId: "msg-0041", swipe: 1, index: 41 })).toContain("reply #41, swipe 2");
    expect(basisWords(null)).toContain("No reply has written here yet");
  });

  test("a refusal is said in the backend's words, with what it said of each value once", () => {
    expect(refusalWords("The bounds don't allow this write.", [{ message: "A file holds 1,000 characters at most." }])).toBe("The bounds don't allow this write. A file holds 1,000 characters at most.");
    expect(refusalWords("That path can't be used. Take the dots out.", [{ message: "Take the dots out." }])).toBe("That path can't be used. Take the dots out.");
  });
});

describe("bounds", () => {
  test("a bound says how much of it is used, and by how much it is passed", () => {
    expect(boundOf(5, 10, "file")).toMatchObject({ words: "5 of 10 files", over: 0, share: 0.5 });
    expect(boundOf(12, 10, "character")).toMatchObject({ words: "12 of 10 characters, 2 over", over: 2, share: 1 });
    expect(boundOf(1, 1, "file").words).toBe("1 of 1 file");
  });

  test("an area's row says what swiping and editing do to its files, or why its files don't show", () => {
    expect(areaSummary(view("chat", [file("a.md"), file("b.md", { chars: 250 })]))).toBe("2 of 4 files · 350 of 2,000 characters");
    expect(areaRowWords("user", { status: "ready", view: view("user", []) })).toBe("The same in all your chats.");
    expect(areaRowWords("chat", { status: "ready", view: view("chat", []) })).toBe("Go back when you swipe or edit.");
    expect(areaRowWords("chat", { status: "no-chat" })).toContain("Belongs to a chat");
    expect(areaRowWords("learned", { status: "failed", message: "The store didn't answer." })).toBe("Couldn't be read: The store didn't answer.");
  });

  test("a text the bounds refuse is said before it is sent", () => {
    const full = view("chat", [file("a.md", { chars: 900 }), file("b.md", { chars: 900 }), file("c.md"), file("d.md")]);
    expect(writeProblem(view("chat", []), "x".repeat(1001), null)).toContain("1 character over what one file may hold");
    expect(writeProblem(full, "short", null)).toContain("holds all the files Settings allow");
    // Replacing a file counts its old length out: 900 of the area's 2,000 go, 950 come.
    expect(writeProblem(full, "x".repeat(950), full.files[0] ?? null)).toContain("would hold 2,050 characters");
    expect(writeProblem(view("chat", [file("a.md")]), "short", null)).toBeNull();
  });
});

describe("a path typed for a new file or a move", () => {
  const files = [file("notes/ledger.md"), file("people/joss.md")];

  test("what is typed is made ready before it is checked", () => {
    expect(normalizePath("  ./notes\\plan.md ")).toBe("notes/plan.md");
    expect(pathProblem("chat", " notes/plan.md ", files)).toBeNull();
  });

  test("each unsound path is refused in words that say what to change", () => {
    expect(pathProblem("chat", "", files)).toContain("Give the file a path");
    expect(pathProblem("chat", "/notes/plan.md", files)).toContain("leave out the slash");
    expect(pathProblem("chat", "notes/", files)).toContain("names a folder");
    expect(pathProblem("chat", "notes//plan.md", files)).toContain("Two slashes");
    expect(pathProblem("chat", "notes/../plan.md", files)).toContain("can't climb out");
    expect(pathProblem("chat", "~/plan.md", files)).toContain("pick the area Yours");
    expect(pathProblem("chat", "learned/plan.md", files)).toContain("pick that area");
    expect(pathProblem("learned", "learned/plan.md", files)).toBeNull();
  });

  test("a path that is taken, a folder's, or under a file is refused", () => {
    expect(pathProblem("chat", "notes/ledger.md", files)).toBe("There is a file at notes/ledger.md already: pick another path.");
    expect(pathProblem("user", "notes", files)).toBe("~/notes is a folder here, and a file can't take a folder's name.");
    expect(pathProblem("chat", "notes/ledger.md/page", files)).toBe("notes/ledger.md is a file, so nothing can be kept under it.");
  });

  test("a file being moved may not stay where it is", () => {
    expect(pathProblem("chat", "notes/ledger.md", files, "notes/ledger.md")).toBe("That is where the file is now.");
    expect(pathProblem("chat", "notes/pilot-ledger.md", files, "notes/ledger.md")).toBeNull();
  });
});

describe("an area's files as a tree", () => {
  const files = [file("README.md"), file("notes/timeline.md", { chars: 300 }), file("people/joss.md"), file("notes/old/10.md"), file("notes/ledger.md"), file("notes/old/2.md")];
  const names = (rows: readonly TreeRow[]): string[] => rows.map((r) => (r.kind === "folder" ? `${r.node.path}/` : r.node.path));

  test("folders come first at each level, then files, each by name as a person lists them", () => {
    expect(names(treeRows(treeOf(files), new Set(), false))).toEqual(["notes/", "notes/old/", "notes/old/2.md", "notes/old/10.md", "notes/ledger.md", "notes/timeline.md", "people/", "people/joss.md", "README.md"]);
  });

  test("a folder says how many files are under it and their characters together", () => {
    const notes = treeOf(files)[0];
    expect(notes).toMatchObject({ kind: "folder", path: "notes", files: 4, chars: 600, depth: 0 });
  });

  test("a folded folder hides what is under it", () => {
    expect(names(treeRows(treeOf(files), new Set(["notes"]), false))).toEqual(["notes/", "people/", "people/joss.md", "README.md"]);
  });

  test("a filter keeps the files whose path holds every word, and opens the folders that lead to them", () => {
    const found = treeOf(files, "NOTES led");
    expect(names(treeRows(found, new Set(["notes"]), true))).toEqual(["notes/", "notes/ledger.md"]);
    expect(found[0]).toMatchObject({ files: 1 });
    expect(treeOf(files, "harbour")).toEqual([]);
  });
});

describe("pins", () => {
  const chat = view("chat", [file("notes/ledger.md", { pins: ["main"], chars: 200 }), file("people/joss.md", { pins: ["main", "writer"], chars: 400 }), file("people/brann.md")]);
  const mine = view("user", [file("style/prose.md", { pins: ["writer", "scribe"] })]);

  test("what is pinned shows by agent, the main agent first, each against its room", () => {
    const groups = pinGroups([chat, mine]);
    expect(groups.map((g) => g.name)).toEqual(["Main agent", "Writer", "scribe"]);
    expect(groups[0]?.files.map((f) => fullPath(f.area, f.file.path))).toEqual(["notes/ledger.md", "people/joss.md"]);
    expect(groups[0]?.bound.words).toBe("600 of 500 characters, 100 over");
    expect(groups[1]?.files.map((f) => fullPath(f.area, f.file.path))).toEqual(["people/joss.md", "~/style/prose.md"]);
    // A definition removed since still shows what is pinned for it, by its id.
    expect(groups[2]).toMatchObject({ agent: "scribe", known: false });
    expect(pinnedCount([chat, mine])).toBe(3);
  });

  test("a file offers the main agent with one press and every other definition by name", () => {
    const choices = pinChoices(file("a.md", { pins: ["writer", "scribe"] }), AGENTS);
    expect(choices.main).toBe(false);
    expect(choices.others).toEqual([
      { id: "writer", name: "Writer", on: true },
      { id: "archivist", name: "Archivist", on: false },
      { id: "scribe", name: "scribe", on: true },
    ]);
  });

  test("a pinned file is marked in the tree and says whom it is pinned for", () => {
    expect(pinMark(file("a.md"))).toBeNull();
    expect(pinMark(file("a.md", { pins: ["main"] }))).toBe("always given");
    expect(pinMark(file("a.md", { pins: ["main", "writer"] }))).toBe("always given ×2");
    expect(pinnedWords(file("a.md", { pins: ["main", "writer"] }), AGENTS)).toBe("Always given to Main agent and Writer: it is in their prompt at every reply.");
    expect(pinnedWords(file("a.md"), AGENTS)).toContain("No agent is always given this file");
  });
});

describe("the line diff", () => {
  test("a rewritten line shows as the old one removed, then the new one added", () => {
    const diff = diffLines("a\nb\nc", "a\nx\nc");
    expect(diff.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["same:a", "removed:b", "added:x", "same:c"]);
    expect(diff.lines[1]).toMatchObject({ before: 2, after: null });
    expect(diff.lines[2]).toMatchObject({ before: null, after: 2 });
    expect(diffWords(diff)).toBe("1 line added, 1 line removed.");
  });

  test("lines added at the end and a whole new text", () => {
    expect(diffLines("a\nb", "a\nb\nc\nd")).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines("", "a\nb")).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines("a\nb", "")).toMatchObject({ added: 0, removed: 2 });
  });

  test("two texts that are the same say so", () => {
    expect(diffWords(diffLines("a\nb", "a\nb"))).toBe("No difference: the two texts are the same.");
  });

  test("long unchanged runs fold, keeping the lines next to a change, and open on request", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const after = before.map((l, i) => (i === 9 ? "line ten" : l));
    const diff = diffLines(before.join("\n"), after.join("\n"));
    const rows = foldDiff(diff);
    expect(rows.map((r) => (r.kind === "fold" ? `fold ${r.lines.length}` : r.line.kind))).toEqual(["fold 6", "same", "same", "same", "removed", "added", "same", "same", "same", "fold 7"]);
    const first = rows[0];
    const opened = foldDiff(diff, new Set(first?.kind === "fold" ? [first.id] : []));
    expect(opened.filter((r) => r.kind === "line")).toHaveLength(14);
    expect(opened.filter((r) => r.kind === "fold")).toHaveLength(1);
  });

  test("a fold never hides a single line", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["A", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
    // Seven unchanged lines between two changes: three stay on each side, and one line alone isn't worth a fold's row.
    expect(foldDiff(diffLines(before, after)).every((r) => r.kind === "line")).toBe(true);
  });
});

describe("a turn's change set", () => {
  const changes: ChangedFile[] = [
    { area: "chat", path: "notes/ledger.md", before: "h1", after: "h2", by: ARCHIVIST },
    { area: "chat", path: "harbour-office.md", before: "h3", after: null, by: ARCHIVIST },
    { area: "chat", path: "places/harbour-office.md", before: null, after: "h3", by: ARCHIVIST },
    { area: "learned", path: "people/okoro.md", before: null, after: "h4", by: JOB },
    { area: "chat", path: "old.md", before: "h5", after: null, by: USER },
  ];

  test("a file gone and a file there with the same text are one file that moved", () => {
    const rows = changeRows(changes);
    expect(rows.map((r) => `${r.kind} ${fullPath(r.area, r.path)}`)).toEqual(["changed notes/ledger.md", "removed old.md", "moved places/harbour-office.md", "added learned/people/okoro.md"]);
    expect(rows[2]).toMatchObject({ from: "harbour-office.md", before: "h3", after: "h3" });
    expect(changesSummary(rows)).toBe("4 files: 1 added, 1 changed, 1 moved, 1 removed.");
  });

  test("a file gone in one area and one there in another are not a move", () => {
    const rows = changeRows([
      { area: "chat", path: "a.md", before: "h", after: null, by: USER },
      { area: "learned", path: "a.md", before: null, after: "h", by: USER },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["removed", "added"]);
  });

  test("a turn that changed nothing says so", () => {
    expect(changesSummary([])).toBe("This reply changed no file.");
  });
});

describe("a file's history", () => {
  const versions = [version("h3", T0), version("h2", T0 - 60_000, { by: ARCHIVIST, turn: { messageId: "msg-0041", swipe: 1, index: 41 } }), version("h1", T0 - 120_000)];

  test("the first version is the file as it stands, unless it is a deletion", () => {
    expect(versionRows(versions).map((r) => r.current)).toEqual([true, false, false]);
    const gone = versionRows([version(null, T0 + 1), ...versions]);
    expect(gone.map((r) => r.current)).toEqual([false, false, false, false]);
    expect(gone[0]).toMatchObject({ deleted: true });
  });

  test("a version says its length, who wrote it and the reply whose turn made it", () => {
    expect(versionFacts(versions[1] ?? version("x", T0))).toBe("40 characters · by Archivist (agent) · reply #41, swipe 2");
    expect(versionFacts(version(null, T0))).toBe("deleted · by you");
  });

  test("two versions are picked to compare: a third takes the first one's place, and a press lets one go", () => {
    expect(pickVersion([], "a")).toEqual(["a"]);
    expect(pickVersion(["a"], "b")).toEqual(["a", "b"]);
    expect(pickVersion(["a", "b"], "c")).toEqual(["b", "c"]);
    expect(pickVersion(["a", "b"], "a")).toEqual(["b"]);
  });

  test("the pair compared is older first, whichever was picked first", () => {
    const rows = versionRows(versions);
    const [newest, , oldest] = rows;
    const pair = pickedPair(rows, [oldest?.key ?? "", newest?.key ?? ""]);
    expect(pair?.older.version.hash).toBe("h1");
    expect(pair?.newer.version.hash).toBe("h3");
    expect(pickedPair(rows, [newest?.key ?? ""])).toBeNull();
    expect(pickedPair(rows, [newest?.key ?? "", "a version the history dropped"])).toBeNull();
  });
});

describe("text typed and not yet saved", () => {
  const draft = (over: Partial<Draft> = {}): Draft => ({ base: "h1", from: "as saved", text: "as saved", ...over });

  test("a draft is unsaved once its text differs, or a path is typed for a new file", () => {
    expect(isDirty(draft())).toBe(false);
    expect(isDirty(draft({ text: "as typed" }))).toBe(true);
    expect(isDirty(draft({ base: null, from: "", text: "", path: "notes/plan.md" }))).toBe(true);
    expect(isDirty(draft({ base: null, from: "", text: "", path: "  " }))).toBe(false);
  });

  test("a draft is overtaken when the file has another version, or is gone", () => {
    expect(isStale(draft(), "h1")).toBe(false);
    expect(isStale(draft(), "h2")).toBe(true);
    expect(isStale(draft(), null)).toBe(true);
  });

  test("a draft is kept under its chat, except in the user's own area and level, which every chat shares", () => {
    expect(draftKey("chat-mara", "chat", "a.md")).not.toBe(draftKey("chat-brann", "chat", "a.md"));
    expect(draftKey("chat-mara", "user", "a.md")).toBe(draftKey("chat-brann", "user", "a.md"));
    expect(guidanceDraftKey("chat-mara", "user")).toBe(guidanceDraftKey(null, "user"));
    expect(guidanceDraftKey("chat-mara", "chat")).not.toBe(guidanceDraftKey("chat-brann", "chat"));
  });

  test("a key says where its draft belongs, whatever the path or the chat's id holds", () => {
    expect(draftPlace(draftKey("chat|mara", "chat", "odd|name.md"))).toEqual({ kind: "file", chatId: "chat|mara", area: "chat", path: "odd|name.md" });
    expect(draftPlace(newDraftKey("chat-mara", "learned"))).toEqual({ kind: "new", chatId: "chat-mara", area: "learned" });
    expect(draftPlace(guidanceDraftKey("chat-mara", "middle"))).toEqual({ kind: "guidance", chatId: "chat-mara", level: "middle" });
    expect(draftPlace("something else")).toBeNull();
  });

  test("the page says when unsaved text waits in another chat", () => {
    const drafts = new Map<string, Draft>([
      [draftKey("chat-brann", "chat", "a.md"), draft({ text: "typed" })],
      [guidanceDraftKey("chat-brann", "chat"), draft({ text: "typed" })],
      [draftKey("chat-okoro", "chat", "b.md"), draft()],
      [draftKey("chat-mara", "user", "c.md"), draft({ text: "typed" })],
    ]);
    // Two places of one other chat; the untouched draft and the user's own area don't count.
    expect(draftsElsewhere(drafts, "chat-mara")).toHaveLength(2);
    expect(waitingWords(draftsElsewhere(drafts, "chat-mara"))).toBe("Text you typed and didn't save is waiting in 1 other chat: pick it above to go on with it.");
    expect(waitingWords(draftsElsewhere(drafts, "chat-brann"))).toBeNull();
  });
});

describe("where the page goes when nav moves", () => {
  const ledger: FileTarget = { area: "chat", path: "notes/ledger.md", hash: null };
  const okoro: FileTarget = { area: "learned", path: "people/okoro.md", hash: "h9" };
  const prose: FileTarget = { area: "user", path: "style/prose.md", hash: null };
  const reply = { messageId: "msg-0043", swipe: 0 };
  const looked = followNav(START_KEPT, { file: null, changes: null }, "chat-mara").kept;

  test("the first look shows the list, and nothing moves until nav does", () => {
    expect(looked).toMatchObject({ area: "chat", pane: "none" });
    expect(followNav(looked, { file: null, changes: null }, "chat-mara").kept).toBe(looked);
  });

  test("a file that arrives from another page comes to the front and brings its area", () => {
    const next = followNav(looked, { file: okoro, changes: null }, "chat-mara");
    expect(next.kept).toMatchObject({ area: "learned", pane: "file" });
    expect(next.file).toBe(okoro);
  });

  test("a change set that arrives comes to the front; a file opened from it leads back to it", () => {
    const withChanges = followNav(looked, { file: null, changes: reply }, "chat-mara").kept;
    expect(withChanges.pane).toBe("changes");
    const withFile = followNav(withChanges, { file: ledger, changes: reply }, "chat-mara").kept;
    expect(withFile.pane).toBe("file");
    expect(followNav(withFile, { file: null, changes: reply }, "chat-mara").kept.pane).toBe("changes");
    expect(followNav(withChanges, { file: null, changes: null }, "chat-mara").kept.pane).toBe("none");
  });

  test("another chat closes the file and the change set that belonged to the last one", () => {
    const open = followNav(looked, { file: ledger, changes: reply }, "chat-mara").kept;
    const moved = followNav({ ...open, filter: "led", folded: new Set(["chat:notes"]) }, { file: ledger, changes: reply }, "chat-brann");
    expect(moved.file).toBeNull();
    expect(moved.changes).toBeNull();
    expect(moved.kept).toMatchObject({ pane: "none", filter: "" });
    expect(moved.kept.folded.size).toBe(0);
  });

  test("a file of the user's own area stays open through a change of chat", () => {
    const open = followNav(looked, { file: prose, changes: null }, "chat-mara").kept;
    const moved = followNav(open, { file: prose, changes: null }, "chat-brann");
    expect(moved.file).toBe(prose);
    expect(moved.kept).toMatchObject({ pane: "file", area: "user" });
  });

  test("a file that arrives together with its chat is opened, not closed", () => {
    const moved = followNav(looked, { file: okoro, changes: null }, "chat-brann");
    expect(moved.file).toBe(okoro);
    expect(moved.kept.pane).toBe("file");
  });

  test("with no chat only the user's own area shows", () => {
    expect(followNav(START_KEPT, { file: null, changes: null }, null).kept.area).toBe("user");
    expect(followNav(looked, { file: null, changes: null }, null).kept.area).toBe("user");
  });
});

describe("guidance", () => {
  test("a level over the bound says what is cut", () => {
    expect(guidanceCutWords("x".repeat(8000), 8000)).toBeNull();
    expect(guidanceCutWords("x".repeat(8012), 8000)).toBe("12 characters over: an agent is given the first 8,000 and told the rest was cut. Shorten it, or raise the limit in Settings.");
  });

  test("a level says when it was last written and by whom; one with nothing written says so in its own words", () => {
    expect(levelFacts({ hash: "h", at: T0 - 7_200_000, by: USER }, T0)).toBe("Last written 2 h ago by you.");
    expect(levelFacts({ hash: null, at: null, by: null }, T0)).toBeNull();
  });

  test("a level is named by whose it is, never by its file", () => {
    expect(levelName({ id: "user", label: "Yours" })).toBe("your guidance");
    expect(levelName({ id: "chat", label: "This chat's" })).toBe("this chat's guidance");
    expect(levelName({ id: "middle", label: "Joss's" })).toBe("Joss's guidance");
  });

  test("the page says whether agents may write the chat's level, and who overtook a save", () => {
    expect(agentsEditWords(true)).toContain("Agents may write here too");
    expect(agentsEditWords(false)).toContain("Only you write here");
    expect(wroteWords({ at: T0 - 60_000, by: JOB }, T0)).toBe("Archivist (job) wrote it 1 min ago.");
    expect(wroteWords({ at: T0 - 60_000, by: USER }, T0)).toBe("You wrote it 1 min ago.");
    expect(wroteWords({ at: null, by: null }, T0)).toBe("It was written again.");
  });
});
