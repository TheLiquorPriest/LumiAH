// The stand-in backend's workspace and guidance (DESIGN §11, §12): the three areas of each chat as
// indexes of versioned files, whose bodies `lah.ws.read` alone gives, as a file stands or as one of
// its versions held it; a turn's change set for the stored replies the Sessions page lists; and the
// three levels of guidance, of which the user's and the chat's are workspace files and the middle
// one is the chat's character's. A write names the version it was based on and is refused when that
// is no longer the file's; the bounds are the settings' own, read when a request is answered, so
// the Settings page changes them here too.

import { defaultSettings } from "../../../src/core/settings";
import { type ChangedFile, type FileAuthor, type FileVersion, type GuidanceLevel, type GuidanceLevelId, type GuidanceView, isRecord, type WorkspaceArea, type WorkspaceFile, type WorkspaceView } from "../../../src/shared/ui";
import { fakeHash, NOTE_FILES } from "../fixtures";
import { type Handlers, hashOf, MOCK_AGENTS, type MockCtx, Refusal } from "./ctx";

type Requests = "lah.ws.list" | "lah.ws.read" | "lah.ws.write" | "lah.ws.move" | "lah.ws.delete" | "lah.ws.pin" | "lah.ws.history" | "lah.ws.changes" | "lah.guidance.get" | "lah.guidance.set";

/** A path of an area as it is kept: every version written there, newest first (a deletion among them), and the agent definitions the file is pinned for. */
interface Kept {
  versions: FileVersion[];
  pins: string[];
}

type AreaFiles = Map<string, Kept>;

const USER: FileAuthor = { who: "user" };
const MAIN: FileAuthor = { who: "agent", id: "main-1", role: "main" };
const ARCHIVIST: FileAuthor = { who: "agent", id: "archivist-1", role: "archivist" };
const TIMELINE_JOB: FileAuthor = { who: "job", id: "job-timeline-1", role: "archivist" };
const TIMELINE_JOB_AGAIN: FileAuthor = { who: "job", id: "job-timeline-2", role: "archivist" };

const SIGN: Readonly<Record<WorkspaceArea, string>> = { chat: "", learned: "learned/", user: "~/" };
const GUIDANCE_PATH = "GUIDANCE.md";

/** The character each made-up chat is with: whose the middle level of its guidance is. */
const CHARACTER: Readonly<Record<string, string>> = { "chat-mara": "Joss", "chat-brann": "Brann", "chat-okoro": "Okoro" };

/**
 * How long after the page first reads notes/timeline.md a job writes it again. It is the preview's
 * own stage direction and no bound: long enough to press Edit and type a word, short enough that a
 * save meets the conflict while the user still remembers what they changed.
 */
const REWRITE_AFTER_MS = 4000;

const LEDGER = [
  "# The pilot's ledger\n\n- Kept in the harbour office.",
  "# The pilot's ledger\n\n- Kept in the harbour office, back room cabinet (#41).\n- Okoro signed it on the first (#38).",
  "# The pilot's ledger\n\n- Kept in the harbour office, back room cabinet (#41).\n- Okoro signed it on the first (#38).\n- A page is missing; it went missing after the first (#43).",
  "# The pilot's ledger\n\n- Kept in the harbour office, back room cabinet (#41).\n- Okoro signed it on the first (#38).\n- A page is missing; it went missing after the first (#43).\n- Ilse holds the night key and asks what Joss thinks is in the office (#47).",
] as const;

/** What the turn Live plays wrote of the ledger (fixtures.ts, `workingTurn`): the version its held call was based on, and the one its result's link names. */
const TURN_LEDGER = { before: fakeHash("ws:ledger:3"), after: fakeHash("ws:ledger:4") } as const;

const TIMELINE = `# Timeline

- #17 Mara comes off the packet boat at dusk and takes a room over the Gull.
- #19 Joss tells her the pilot's ledger is kept at the harbour office.
- #21 Ilse mends nets on the quay and will not talk about the pilot.
- #23 Brann turns Mara away from the office door: closed for the count.
- #25 Mara pays the pilot's tab at the Gull and does not say why.
- #27 Okoro arrives for the monthly audit a day early.
- #29 Mara asks Okoro who signs the ledger. He does, on the first.
- #31 Ilse: "Ask Okoro. He reads everything twice."
- #33 A lamp is seen lit in the office back room after six.
- #35 Joss learns that Mara paid the tab.
- #37 Rain since noon. Brann stands in the office door with his arms folded.
- #38 Okoro signs the ledger on the first.
- #41 Joss: the office shuts at six, and the ledger is in the back room cabinet.
- #43 A page of the ledger is missing. Brann keeps the key by day.`;

const TIMELINE_AGAIN = TIMELINE.replace("- #33 A lamp is seen lit in the office back room after six.", "- #33 A lamp is seen lit in the office back room after six (Ilse had the night key).").concat("\n- #45 Joss lights the lamp and walks Mara down to the office before it shuts.\n- #47 At the door Ilse asks what Joss thinks is in the office. Nobody answers her.");

const JOSS = [
  "# Joss\n\nKeeps the Gull, the inn over the quay. Slow to answer, quick to pour.",
  "# Joss\n\nKeeps the Gull, the inn over the quay. Slow to answer, quick to pour.\n\n- Never lies to Mara, though he leaves things out.\n- Knows the harbour office shuts at six (#41).\n- Learned that Mara paid the pilot's tab (#35) and has not let it go.",
] as const;

const BRANN = "# Brann\n\nHarbourmaster's clerk. Keeps the office key by day (#43).\n\n- Turned Mara away from the office once (#23).\n- Mara does not trust him and has not said why.";

const OFFICE = [
  "# The harbour office\n\nOn the quay, past the net sheds. Shuts at six.",
  "# The harbour office\n\nOn the quay, past the net sheds. Shuts at six (#41).\n\n- Front room: the counter, the tide tables, Brann by day.\n- Back room: the cabinet where the pilot's ledger is kept (#41).\n- Two keys: Brann has the day key, Ilse the night key (#47).",
] as const;

const OKORO = "# Okoro\n\nAudits the ledgers on the first of each month and signs the last page he read. Reads everything twice (Ilse, #31).";

const PROSE = "# Prose\n\n- Past tense, close on whoever Mara is watching.\n- Weather and tide in a clause, never a paragraph.\n- A reply ends on something said or done, not on a question to Mara.";

const USER_GUIDANCE = [
  "# How I like these told\n\n- Keep replies under four paragraphs.\n- Never speak or act for Mara.",
  "# How I like these told\n\n- Keep replies under four paragraphs.\n- Never speak or act for Mara.\n- When a note would help later, write it to the workspace and say that you did.\n- Say what you don't know. Don't make up a fact the story hasn't given.",
] as const;

const CHAT_GUIDANCE = [
  "# This story\n\n- It is a harbour town in late autumn. Nobody has a telephone.",
  "# This story\n\n- It is a harbour town in late autumn. Nobody has a telephone.\n- The missing ledger page is the thread: don't settle who took it before Mara finds out.\n- Okoro is owed an answer by the first of the month.",
] as const;

const CHARACTER_GUIDANCE: Readonly<Record<string, string>> = {
  Joss: "# Joss\n\n- Speaks in short sentences and wipes something down while he thinks.\n- Never lies to Mara, though he leaves things out.\n- Calls the harbourmaster's clerk by his name, Brann, and nobody else by theirs.",
  Brann: "# Brann\n\n- Answers a question with the rule that covers it.\n- Stands in doorways.",
  Okoro: "# Okoro\n\n- Reads everything twice before he says anything about it.\n- Signs the last page he read, and only that one.",
};

/** A path as a request names it, made the path it is kept under; refused in words that say what to change. */
function soundPath(raw: string, pathChars: number): string {
  let path = raw.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  const parts = path.split("/");
  const why = path.startsWith("/")
    ? "A path starts inside its area: leave out the slash at its start."
    : parts.includes("..")
      ? "A path may not leave its area: take the “..” out."
      : parts.some((part) => part === "" || part === "." || part.trim() !== part)
        ? "Every folder and the file need a name, with no space at its start or end."
        : /[\u0000-\u001f\u007f]/.test(path)
          ? "A path can't hold a line break or another control character."
          : path.length > pathChars
            ? `A path holds ${pathChars} characters at most (Settings, the workspace); this one has ${path.length}.`
            : null;
  if (why !== null) throw new Refusal("invalid", `That path can't be used. ${why}`, [{ path: ["path"], message: why }]);
  return path;
}

export function workspaceMock(ctx: MockCtx): Handlers<Requests> {
  const start = ctx.now();
  const minutes = (n: number): number => start - n * 60_000;
  const days = (n: number): number => start - n * 86_400_000;
  /** The areas' files: the user's own under one key, a chat's two under the chat's id. */
  const areas = new Map<string, AreaFiles>();
  /** The middle level of each chat's guidance: its character's, kept apart from the workspace. */
  const middles = new Map<string, { text: string; hash: string; at: number; by: FileAuthor }>();
  const changeSets = new Map<string, ChangedFile[]>();
  let rewrite: "waiting" | "set" | "done" = "waiting";

  const filesOf = (chatId: string | null, area: WorkspaceArea): AreaFiles => {
    if (area !== "user" && chatId === null) throw new Refusal("invalid", "The chat's area and learned/ belong to a chat: name the chat.");
    const key = area === "user" ? "user" : `${chatId ?? ""}|${area}`;
    let files = areas.get(key);
    if (!files) {
      files = new Map();
      areas.set(key, files);
    }
    return files;
  };
  const bounds = () => {
    const base = defaultSettings();
    const values = ctx.state().settings.values;
    const workspace = isRecord(values.workspace) ? values.workspace : {};
    const guidance = isRecord(values.guidance) ? values.guidance : {};
    // The sample settings (`?settings=sample`) hold no workspace section: the defaults then stand.
    const whole = (value: unknown, otherwise: number): number => (typeof value === "number" && Number.isFinite(value) ? value : otherwise);
    return {
      fileChars: whole(workspace.fileChars, base.workspace.fileChars),
      files: whole(workspace.files, base.workspace.files),
      areaChars: whole(workspace.areaChars, base.workspace.areaChars),
      pathChars: whole(workspace.pathChars, base.workspace.pathChars),
      versions: whole(workspace.versions, base.workspace.versions),
      pinChars: whole(workspace.pinChars, base.workspace.pinChars),
      guidanceChars: whole(guidance.chars, base.guidance.chars),
      agentsEdit: typeof guidance.agentsEdit === "boolean" ? guidance.agentsEdit : base.guidance.agentsEdit,
    };
  };
  const nameOf = (area: WorkspaceArea, path: string): string => `${SIGN[area]}${path}`;
  const fileOf = (path: string, kept: Kept | undefined): WorkspaceFile | null => {
    const now = kept?.versions[0];
    return kept && now && now.hash !== null ? { path, hash: now.hash, chars: now.chars, at: now.at, by: now.by, pins: [...kept.pins] } : null;
  };
  const listOf = (files: AreaFiles): WorkspaceFile[] => [...files].flatMap(([path, kept]) => fileOf(path, kept) ?? []).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  /** A version put on top of a path's history, which keeps the file as it stands and as many earlier versions as Settings say. */
  const push = (files: AreaFiles, path: string, version: FileVersion): Kept => {
    const kept = files.get(path) ?? { versions: [], pins: [] };
    kept.versions = [version, ...kept.versions].slice(0, bounds().versions + 1);
    files.set(path, kept);
    return kept;
  };
  /** Every version's text by its hash, kept here and not among the texts `lah.blob.get` gives: the real backend gives a workspace body through `lah.ws.read` alone. */
  const bodies = new Map<string, string>();
  /** Keeps a text and answers its hash: its own, or the one the made-up data names it by elsewhere (a version a turn's result points at). */
  const keep = (text: string, hash: string = hashOf(text)): string => {
    bodies.set(hash, text);
    return hash;
  };
  const versionOf = (text: string, by: FileAuthor, at: number, turn: FileVersion["turn"] = null, hash?: string): FileVersion => ({ hash: keep(text, hash), chars: text.length, at, by, turn });
  /** The file a request names as it stands; refused where there is none. */
  const standing = (files: AreaFiles, area: WorkspaceArea, path: string): { kept: Kept; file: WorkspaceFile } => {
    const kept = files.get(path);
    const file = fileOf(path, kept);
    if (!kept || !file) throw new Refusal("not_found", `There is no file ${nameOf(area, path)}: it may have been moved or deleted since the page read it.`);
    return { kept, file };
  };
  const stale = (area: WorkspaceArea, path: string): Refusal => new Refusal("conflict", `${nameOf(area, path)} was written again since the version this is based on. Read it again, then decide what to keep.`);
  /** Writes a text as a path's newest version, as the user: versioned, and within the bounds. */
  const write = (chatId: string | null, area: WorkspaceArea, rawPath: string, text: string, base: string | null): WorkspaceFile => {
    const limits = bounds();
    const files = filesOf(chatId, area);
    const path = soundPath(rawPath, limits.pathChars);
    const now = fileOf(path, files.get(path));
    if (base === null && now !== null) throw new Refusal("conflict", `There is a file at ${nameOf(area, path)} already. Read it again: to change it, base the write on the version it has.`);
    if (base !== null && now === null) throw new Refusal("conflict", `${nameOf(area, path)} was deleted since the version this is based on. Read the area again: writing it as a new file puts it back.`);
    if (base !== null && now !== null && now.hash !== base) throw stale(area, path);
    const all = listOf(files);
    if (now === null) {
      const under = all.find((f) => f.path.startsWith(`${path}/`) || path.startsWith(`${f.path}/`));
      if (under) {
        const why = `${nameOf(area, under.path)} is in the way: a file and a folder can't share a name.`;
        throw new Refusal("invalid", `That path can't be used. ${why}`, [{ path: ["path"], message: why }]);
      }
    }
    const problems = [
      ...(text.length > limits.fileChars ? [`A file holds ${limits.fileChars} characters at most; this text has ${text.length}. Shorten it, or split it into two files.`] : []),
      ...(now === null && all.length >= limits.files ? [`This area holds all the files Settings allow it (${limits.files}). Delete one first.`] : []),
      ...(all.reduce((sum, f) => sum + f.chars, 0) - (now?.chars ?? 0) + text.length > limits.areaChars ? [`With this the area would hold more than the ${limits.areaChars} characters Settings allow it. Shorten it, or delete a file first.`] : []),
    ];
    if (problems.length > 0) throw new Refusal("invalid", "The workspace's bounds don't allow this write.", problems.map((message) => ({ path: ["text"], message })));
    // The same text again is the version the file has: nothing is written, as the real store keeps a body once.
    const hash = keep(text);
    const kept = now !== null && now.hash === hash ? files.get(path) : push(files, path, { hash, chars: text.length, at: ctx.now(), by: USER, turn: null });
    const file = fileOf(path, kept);
    if (!file) throw new Refusal("internal", "The write was kept and can't be read back.");
    return file;
  };

  if (ctx.ready) {
    const turn = (index: number, swipe = 0): NonNullable<FileVersion["turn"]> => ({ messageId: `msg-${String(index).padStart(4, "0")}`, swipe, index });
    const mara = filesOf("chat-mara", "chat");
    const learned = filesOf("chat-mara", "learned");
    const mine = filesOf(null, "user");
    const ledger = (n: 1 | 2 | 3): string => fakeHash(`ws:ledger:${n}`);
    push(mara, NOTE_FILES.ledger.path, versionOf(LEDGER[0], USER, minutes(52), null, ledger(1)));
    push(mara, NOTE_FILES.ledger.path, versionOf(LEDGER[1], MAIN, minutes(9), turn(41, 1), ledger(2)));
    push(mara, NOTE_FILES.ledger.path, versionOf(LEDGER[2], ARCHIVIST, minutes(3), turn(43), ledger(3)));
    const timeline = push(mara, NOTE_FILES.timeline.path, versionOf(TIMELINE, TIMELINE_JOB, minutes(3)));
    timeline.pins = ["main"];
    push(mara, "people/joss.md", versionOf(JOSS[0], USER, days(2)));
    push(mara, "people/joss.md", versionOf(JOSS[1], MAIN, minutes(71))).pins = ["main", "writer"];
    push(mara, "people/brann.md", versionOf(BRANN, MAIN, minutes(26)));
    // The office's note was made at the area's root and moved under places/ by reply #37's turn: the old path's history ends in a deletion.
    const office = versionOf(OFFICE[0], USER, days(2));
    push(mara, "harbour-office.md", office);
    push(mara, "harbour-office.md", { hash: null, chars: 0, at: minutes(44), by: MAIN, turn: turn(37) });
    push(mara, "places/harbour-office.md", { ...office, at: minutes(44), by: MAIN, turn: turn(37) });
    push(mara, "places/harbour-office.md", versionOf(OFFICE[1], ARCHIVIST, minutes(3), turn(43)));
    const okoro = versionOf(OKORO, ARCHIVIST, minutes(3), turn(43), fakeHash("ws:okoro:1"));
    push(learned, NOTE_FILES.okoro.path, okoro).pins = ["archivist"];
    push(learned, GUIDANCE_PATH, versionOf(CHAT_GUIDANCE[0], USER, days(5)));
    push(learned, GUIDANCE_PATH, versionOf(CHAT_GUIDANCE[1], USER, days(1)));
    push(mine, GUIDANCE_PATH, versionOf(USER_GUIDANCE[0], USER, days(21)));
    push(mine, GUIDANCE_PATH, versionOf(USER_GUIDANCE[1], USER, days(6)));
    push(mine, "style/prose.md", versionOf(PROSE, USER, days(6))).pins = ["writer"];
    for (const [chatId, who] of Object.entries(CHARACTER)) {
      const text = CHARACTER_GUIDANCE[who] ?? "";
      middles.set(chatId, { text, hash: hashOf(text), at: days(12), by: USER });
    }
    // What each stored reply's turn changed (fixtures.ts, `STORED_CHANGES`): #43's agents wrote two notes and the job it started a third; #41 changed one; #37 moved one.
    changeSets.set("msg-0043:0", [
      { ...NOTE_FILES.ledger, before: ledger(2), after: ledger(3), by: ARCHIVIST },
      { ...NOTE_FILES.okoro, before: null, after: okoro.hash, by: ARCHIVIST },
      { ...NOTE_FILES.timeline, before: null, after: timeline.versions[0]?.hash ?? null, by: TIMELINE_JOB },
    ]);
    changeSets.set("msg-0041:1", [{ ...NOTE_FILES.ledger, before: ledger(1), after: ledger(2), by: MAIN }]);
    changeSets.set("msg-0037:0", [
      { area: "chat", path: "harbour-office.md", before: office.hash, after: null, by: MAIN },
      { area: "chat", path: "places/harbour-office.md", before: null, after: office.hash, by: MAIN },
    ]);
  }

  const viewOf = (chatId: string | null, area: WorkspaceArea): WorkspaceView => {
    const files = listOf(filesOf(chatId, area));
    const limits = bounds();
    // The chat's area stands on the newest reply whose turn left a record; in the made-up data only one chat has any.
    const basis = area === "chat" && chatId === "chat-mara" && ctx.ready ? { messageId: "msg-0043", swipe: 0, index: 43 } : null;
    return { area, files, chars: files.reduce((sum, f) => sum + f.chars, 0), limits: { fileChars: limits.fileChars, files: limits.files, areaChars: limits.areaChars, pinChars: limits.pinChars }, agents: MOCK_AGENTS.map((a) => ({ ...a })), basis };
  };
  const levelOf = (id: GuidanceLevelId, chatId: string | null): GuidanceLevel => {
    if (id === "middle") {
      const who = chatId !== null ? CHARACTER[chatId] : undefined;
      const kept = chatId !== null ? middles.get(chatId) : undefined;
      const head = { id, text: kept?.text ?? "", hash: kept?.hash ?? null, at: kept?.at ?? null, by: kept?.by ?? null };
      if (who === undefined) return { ...head, label: "The character's", note: "This chat's character: every chat with that character is given it.", editable: true };
      // One chat's middle level is an extension's, to show a level the page may read and not write.
      if (chatId === "chat-okoro") return { ...head, label: "The audit's", note: "Named by the extension that runs this chat's world, in place of the character's.", editable: false, locked: "The extension that names this level keeps it: change it there. This page can only show it." };
      return { ...head, label: `${who}'s`, note: `This chat's character is ${who}: every chat with ${who} is given it.`, editable: true };
    }
    const area: WorkspaceArea = id === "user" ? "user" : "learned";
    const file = fileOf(GUIDANCE_PATH, filesOf(chatId, area).get(GUIDANCE_PATH));
    const head = { id, text: file ? (bodies.get(file.hash) ?? "") : "", hash: file?.hash ?? null, at: file?.at ?? null, by: file?.by ?? null, editable: true };
    return id === "user" ? { ...head, label: "Yours", note: "~/GUIDANCE.md: every agent of every chat of yours is given it." } : { ...head, label: "This chat's", note: "learned/GUIDANCE.md: kept with this chat, whatever path its story takes." };
  };
  const guidanceOf = (chatId: string | null): GuidanceView => {
    const limits = bounds();
    const ids: GuidanceLevelId[] = chatId === null ? ["user"] : ["user", "middle", "chat"];
    return { levels: ids.map((id) => levelOf(id, chatId)), limit: limits.guidanceChars, agentsEdit: limits.agentsEdit };
  };

  return {
    "lah.ws.list": (r) => viewOf(r.chatId, r.area),
    "lah.ws.read": (r) => {
      const files = filesOf(r.chatId, r.area);
      let { kept, file } = standing(files, r.area, r.path);
      // The made-up job that brings the timeline up to date finishes a moment after the page first reads the file, so an edit begun at once meets it on Save.
      if (rewrite === "waiting" && r.chatId === "chat-mara" && r.area === NOTE_FILES.timeline.area && r.path === NOTE_FILES.timeline.path) {
        rewrite = "set";
        ctx.later(() => {
          rewrite = "done";
          if (fileOf(r.path, files.get(r.path))) push(files, r.path, versionOf(TIMELINE_AGAIN, TIMELINE_JOB_AGAIN, ctx.now()));
        }, REWRITE_AFTER_MS);
      }
      // The turn under way writes the ledger once its held call is approved, and no request here says when that was. Only its result's link names the version it wrote, so the first read that asks for that version finds the write done, on the version the call was based on.
      if (r.version === TURN_LEDGER.after && r.chatId === "chat-mara" && r.area === NOTE_FILES.ledger.area && r.path === NOTE_FILES.ledger.path && file.hash === TURN_LEDGER.before) {
        push(files, r.path, versionOf(LEDGER[3], ARCHIVIST, ctx.now(), null, TURN_LEDGER.after));
        ({ kept, file } = standing(files, r.area, r.path));
      }
      const version = r.version ?? file.hash;
      const text = kept.versions.some((v) => v.hash === version) ? bodies.get(version) : undefined;
      if (text === undefined) throw new Refusal("not_found", `${nameOf(r.area, r.path)} has no such version among the ${kept.versions.filter((v) => v.hash !== null).length} it keeps (Versions kept): it may have been dropped since the page listed them.`);
      return { file, text, version };
    },
    "lah.ws.write": (r) => ({ file: write(r.chatId, r.area, r.path, r.text, r.base) }),
    "lah.ws.move": (r) => {
      const limits = bounds();
      const files = filesOf(r.chatId, r.area);
      const { kept, file } = standing(files, r.area, r.from);
      if (file.hash !== r.base) throw stale(r.area, r.from);
      const to = soundPath(r.to, limits.pathChars);
      if (to === r.from) throw new Refusal("invalid", "That is where the file is now: give another path.", [{ path: ["to"], message: "That is where the file is now." }]);
      const taken = listOf(files).find((f) => f.path === to || f.path.startsWith(`${to}/`) || (f.path !== r.from && to.startsWith(`${f.path}/`)));
      if (taken) throw new Refusal("conflict", `${nameOf(r.area, taken.path)} is in the way of ${nameOf(r.area, to)}: pick another path, or move that one first.`);
      const at = ctx.now();
      const pins = kept.pins;
      kept.pins = [];
      push(files, r.from, { hash: null, chars: 0, at, by: USER, turn: null });
      const moved = push(files, to, { hash: file.hash, chars: file.chars, at, by: USER, turn: null });
      moved.pins = pins;
      return { file: { ...file, path: to, at, by: USER } };
    },
    "lah.ws.delete": (r) => {
      const files = filesOf(r.chatId, r.area);
      const { kept, file } = standing(files, r.area, r.path);
      if (file.hash !== r.base) throw stale(r.area, r.path);
      kept.pins = [];
      push(files, r.path, { hash: null, chars: 0, at: ctx.now(), by: USER, turn: null });
      return { deleted: true };
    },
    "lah.ws.pin": (r) => {
      const { kept, file } = standing(filesOf(r.chatId, r.area), r.area, r.path);
      if (!MOCK_AGENTS.some((a) => a.id === r.agent)) throw new Refusal("not_found", `There is no agent definition ${r.agent}: it may have been removed. Pick another.`);
      kept.pins = r.on ? [...new Set([...kept.pins, r.agent])] : kept.pins.filter((id) => id !== r.agent);
      return { file: { ...file, pins: [...kept.pins] } };
    },
    "lah.ws.history": (r) => ({ versions: (filesOf(r.chatId, r.area).get(r.path)?.versions ?? []).map((v) => ({ ...v })) }),
    "lah.ws.changes": (r) => ({ changes: (r.chatId === "chat-mara" ? (changeSets.get(`${r.messageId}:${r.swipe}`) ?? []) : []).map((c) => ({ ...c })) }),
    "lah.guidance.get": (r) => guidanceOf(r.chatId),
    "lah.guidance.set": (r) => {
      if (r.level !== "user" && r.chatId === null) throw new Refusal("invalid", "Only your own level can be written with no chat: name the chat.");
      const level = levelOf(r.level, r.chatId);
      if (!level.editable) throw new Refusal("forbidden", level.locked ?? "This level can't be edited here.");
      if (r.level === "middle") {
        if (level.hash !== r.base) throw new Refusal("conflict", `${level.label} guidance was written again since the version this is based on. Read it again, then decide what to keep.`);
        const limits = bounds();
        if (r.text.length > limits.fileChars) throw new Refusal("invalid", "The workspace's bounds don't allow this write.", [{ path: ["text"], message: `A level holds ${limits.fileChars} characters at most; this text has ${r.text.length}.` }]);
        if (r.chatId !== null) middles.set(r.chatId, { text: r.text, hash: hashOf(r.text), at: ctx.now(), by: USER });
      } else write(r.chatId, r.level === "user" ? "user" : "learned", GUIDANCE_PATH, r.text, r.base);
      return guidanceOf(r.chatId);
    },
  };
}
