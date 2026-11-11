// The workspace tools (DESIGN §11): list, read, grep, write, edit, move, delete and pin over the files
// the agents keep. A path says which area it is in by how it starts (`resolvePath`), and every change
// names the version it was based on: a file's version is the start of its body's hash (`versionOf`),
// which a listing and a read give.
//
// The tools decide nothing about who holds which area or what may be written: the run gives each
// agent its view of the workspace (`ToolEnv.workspace`), and the view's areas and its guard say.

import type { JsonObject, WorkspaceArea } from "../ports";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, textArg } from "../util";
import { type AreaAccess, type AreaRefusal, type AreaResult, type FileEntry, fileAt, filesIn, pinnedFiles, resolvePath, sameVersion, showFolder, showPath, versionOf, WORKSPACE_AREAS, type WorkspaceView } from "../workspace";
import { around, grepLines, listPage, needs, type Pager, pagerOf, readCursor, textPage } from "./paging";

type Vars = Readonly<Record<string, string>>;

/** A path a call named, read: its area as the agent holds it, the path within that area, and the path as answers write it. */
interface Place {
  kind: WorkspaceArea;
  area: AreaAccess;
  path: string;
  shown: string;
}

/** The text that names each area, where an answer says which areas there are. */
const AREA_TEXT: Readonly<Record<WorkspaceArea, string>> = { chat: TEXT.workspace.areaChat, learned: TEXT.workspace.areaLearned, user: TEXT.workspace.areaUser };

/** The answer to a path that can't be read, by why it can't. */
const PATH_REFUSED = { bad: TEXT.workspace.pathBad, outside: TEXT.workspace.pathOutside, long: TEXT.workspace.pathLong } as const;

/**
 * What a write gives as its base for a file that isn't there yet. Fixed, neither a setting nor a
 * text: it is part of what the tool takes, like the names of its arguments.
 */
const NEW = "new";

/** A yes or a no as a model's arguments give it, or written as text ("true"); null for anything else. */
function flagArg(v: unknown): boolean | null {
  return v === true || v === "true" ? true : v === false || v === "false" ? false : null;
}

/**
 * Leaves a call that changes something once its agent was cancelled or its time ran out (the turn
 * was stopped, the reply came due): nothing is changed after that, and the loop says why the call
 * ended. Asked when the call begins and again right before its change, since reading the file comes
 * between the two.
 */
function live(ctx: ToolCtx): void {
  ctx.signal.throwIfAborted();
}

/**
 * A text filled within Answer length whatever it names: each of `long` (a path as long as Path length
 * allows, the text a call looked for) is clipped to an even share of the room the rest of the text
 * leaves, so what the text says to do next is never what is cut.
 */
function bounded(p: Pager, id: string, vars: Vars, long: Vars): string {
  const parts = Object.entries(long);
  const frame = p.texts.render(id, { ...vars, ...Object.fromEntries(parts.map(([name]) => [name, ""])) }).length;
  const share = Math.max(1, Math.floor((p.pageChars - frame) / Math.max(1, parts.length)));
  return clip(p.texts.render(id, { ...vars, ...Object.fromEntries(parts.map(([name, value]) => [name, clip(value, share)])) }), p.pageChars);
}

/**
 * What every workspace tool is built with, so the eight read a path and say what went wrong alike:
 * the tool's pager, and its answers for one agent's view of the workspace.
 */
function deskOf(env: ToolEnv, view: WorkspaceView, tool: string) {
  const { texts, settings } = env;
  const p = pagerOf(env, tool);
  const say = (id: string, vars: Vars = {}, long: Vars = {}): string => bounded(p, id, vars, long);
  const fail = (id: string, vars: Vars = {}, long: Vars = {}): ToolOutcome => ({ text: bounded(p, id, vars, long), error: true });
  /** A refusal in its holder's own words (what an agent may not write, a job whose turn left the path), as the tool's answer. */
  const inWords = (reason: string): ToolOutcome => ({ text: clip(reason, p.pageChars), error: true });

  /** An area's refusal, as the model is told it: what stands in the way, and what to do next. */
  const refused = (kind: WorkspaceArea, why: AreaRefusal): ToolOutcome => {
    switch (why.code) {
      case "missing":
        return fail(TEXT.workspace.noFile, {}, { path: showPath(kind, why.path) });
      case "exists":
        return fail(TEXT.workspace.exists, { version: versionOf(why.version) }, { path: showPath(kind, why.path) });
      case "stale":
        return fail(TEXT.workspace.stale, { version: versionOf(why.version) }, { path: showPath(kind, why.path) });
      case "file_chars":
        return fail(TEXT.workspace.fileChars, { chars: String(why.chars), limit: String(why.limit) });
      case "files":
        return fail(TEXT.workspace.files, { limit: texts.counted(why.limit, TEXT.workspace.wordFile) });
      case "area_chars":
        return fail(TEXT.workspace.areaChars, { chars: String(why.chars), limit: String(why.limit) });
      case "refused":
        return inWords(why.reason);
    }
  };

  return {
    p,
    say,
    fail,
    refused,

    /** The place a path names; or the error that says why it names none: it can't be read, or it is in an area this run doesn't have. */
    place(raw: string): Place | ToolOutcome {
      const at = resolvePath(raw, settings.workspace.pathChars);
      if ("refused" in at) return fail(PATH_REFUSED[at.refused], { limit: String(settings.workspace.pathChars) });
      const area = view.areas[at.area];
      if (area) return { kind: at.area, area, path: at.path, shown: showPath(at.area, at.path) };
      const there = WORKSPACE_AREAS.filter((kind) => view.areas[kind] !== null).map((kind) => texts.render(AREA_TEXT[kind], { root: showFolder(kind, "") }));
      return fail(TEXT.workspace.noArea, { area: showFolder(at.area, ""), areas: there.length > 0 ? there.join(", ") : texts.render(TEXT.session.none) });
    },

    /** The file at a place, as its area's index holds it now; or the error that says there is none, or that the place is a folder. */
    async file(at: Place): Promise<FileEntry | ToolOutcome> {
      const index = await at.area.index();
      const entry = fileAt(index, at.path);
      if (entry) return entry;
      const folder = at.path === "" || Object.keys(index.files).some((path) => path.startsWith(`${at.path}/`));
      return folder ? fail(TEXT.workspace.isFolder, {}, { path: showFolder(at.kind, at.path) }) : fail(TEXT.workspace.noFile, {}, { path: at.shown });
    },

    /** Why the agent may not change one of `paths`, in its holder's words, as the tool's answer; null when it may change them all. */
    barred(kind: WorkspaceArea, ...paths: string[]): ToolOutcome | null {
      for (const path of paths) {
        const reason = view.guard(kind, path);
        if (reason !== null) return inWords(reason);
      }
      return null;
    },

    /** What a write or an edit answers once its area was asked: its refusal; that nothing changed, where the file already held the text; else `said` of the version made, with the files changed for the trace. */
    written(at: Place, result: AreaResult, said: (entry: FileEntry) => string): ToolOutcome {
      if (!result.ok) return refused(at.kind, result.why);
      const { entry, changes } = result;
      if (!entry) return refused(at.kind, { code: "missing", path: at.path });
      return changes.length === 0 ? { text: say(TEXT.workspace.unchanged, { version: versionOf(entry.hash) }, { path: at.shown }) } : { text: said(entry), files: changes };
    },
  };
}

/** What a listing shows of one thing directly in a folder: a folder with how many files it holds at any depth, or a file. */
type Listed = { shown: string; files: number } | { shown: string; entry: FileEntry };

const workspaceList: ToolDefinition = {
  name: TOOL.workspaceList,
  family: FAMILY.workspace,
  tier: "read",
  build(env: ToolEnv) {
    const view = env.workspace;
    if (!view) return null;
    const { texts } = env;
    const d = deskOf(env, view, TOOL.workspaceList);
    const pinned = (entry: FileEntry): string => (entry.pins.includes(view.role) ? texts.render(TEXT.workspace.listPinned) : "");
    return {
      name: TOOL.workspaceList,
      description: texts.render(TEXT.tool(TOOL.workspaceList)),
      parameters: { type: "object", properties: { path: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceList, "path")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceList, "cursor")) } } },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(d.p, args);
        if ("text" in cursor) return cursor;
        const at = d.place(textArg(args.path) ?? showFolder("chat", ""));
        if ("text" in at) return at;
        const index = await at.area.index();
        const prefix = at.path === "" ? "" : `${at.path}/`;
        const inside = filesIn(index).filter(([path]) => path.startsWith(prefix));
        if (inside.length === 0 && at.path !== "") {
          const file = fileAt(index, at.path);
          return file ? { text: d.say(TEXT.workspace.listIsFile, { chars: String(file.chars), version: versionOf(file.hash), pinned: pinned(file) }, { path: at.shown }) } : d.fail(TEXT.workspace.listNothing, {}, { path: at.shown });
        }
        const folders = new Map<string, number>();
        const files: Listed[] = [];
        for (const [path, entry] of inside) {
          const rest = path.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash < 0) files.push({ shown: showPath(at.kind, path), entry });
          else folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1);
        }
        // From its top, the chat's area shows what is kept beside it as one more folder, and says where the user's own files are.
        const top = at.kind === "chat" && at.path === "";
        const beside = top && view.areas.learned ? Object.keys((await view.areas.learned.index()).files).length : 0;
        const listed: Listed[] = [
          ...(beside > 0 ? [{ shown: showFolder("learned", ""), files: beside }] : []),
          ...[...folders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, count]) => ({ shown: showFolder(at.kind, `${prefix}${name}`), files: count })),
          ...files,
        ];
        const lead = top && view.areas.user ? texts.render(TEXT.workspace.listLead) : undefined;
        if (listed.length === 0) return { text: clip([lead ?? "", d.say(TEXT.workspace.listEmpty, {}, { path: at.shown })].filter((part) => part !== "").join("\n"), d.p.pageChars) };
        return listPage(d.p, {
          total: listed.length,
          noun: TEXT.workspace.wordListed,
          cursor,
          lead,
          item: (i) => {
            const one = listed[i];
            if (!one) return "";
            return "entry" in one ? texts.render(TEXT.workspace.listFile, { path: one.shown, chars: String(one.entry.chars), version: versionOf(one.entry.hash), pinned: pinned(one.entry) }) : texts.render(TEXT.workspace.listFolder, { path: one.shown, files: texts.counted(one.files, TEXT.workspace.wordFile) });
          },
        });
      },
    };
  },
};

const workspaceRead: ToolDefinition = {
  name: TOOL.workspaceRead,
  family: FAMILY.workspace,
  tier: "read",
  build(env: ToolEnv) {
    const view = env.workspace;
    if (!view) return null;
    const { texts } = env;
    const d = deskOf(env, view, TOOL.workspaceRead);
    return {
      name: TOOL.workspaceRead,
      description: texts.render(TEXT.tool(TOOL.workspaceRead)),
      parameters: { type: "object", properties: { path: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceRead, "path")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceRead, "cursor")) } }, required: ["path"] },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const path = textArg(args.path);
        if (path === null) return needs(d.p, "path");
        const cursor = readCursor(d.p, args);
        if ("text" in cursor) return cursor;
        const at = d.place(path);
        if ("text" in at) return at;
        const entry = await d.file(at);
        if ("text" in entry) return entry;
        const text = await at.area.text(entry.hash);
        if (text === null) return d.fail(TEXT.workspace.readGone, { version: versionOf(entry.hash) }, { path: at.shown });
        const frame = (path: string, part: { from: number; to: number; text: string }): string => texts.render(TEXT.workspace.readPage, { path, from: String(part.from), to: String(part.to), total: String(text.length), version: versionOf(entry.hash), text: part.text });
        // A path too long for the page is shown cut, to half the room the heading and the footer leave: the other half is the text's, so every page holds a fair piece of it.
        const spare = d.p.pageChars - frame("", { from: text.length, to: text.length, text: "" }).length - texts.render(TEXT.answer.more, { tool: d.p.tool, cursor: String(text.length) }).length;
        const shown = clip(at.shown, Math.max(1, Math.floor(spare / 2)));
        return textPage(d.p, { text, from: cursor.at, given: cursor.given, frame: (part) => frame(shown, part) });
      },
    };
  },
};

const workspaceGrep: ToolDefinition = {
  name: TOOL.workspaceGrep,
  family: FAMILY.workspace,
  tier: "read",
  build(env: ToolEnv) {
    const view = env.workspace;
    if (!view) return null;
    const { texts } = env;
    const d = deskOf(env, view, TOOL.workspaceGrep);
    return {
      name: TOOL.workspaceGrep,
      description: texts.render(TEXT.tool(TOOL.workspaceGrep)),
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceGrep, "text")) }, path: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceGrep, "path")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceGrep, "cursor")) } },
        required: ["text"],
      },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const needle = textArg(args.text);
        if (needle === null) return needs(d.p, "text");
        const cursor = readCursor(d.p, args);
        if ("text" in cursor) return cursor;
        const at = d.place(textArg(args.path) ?? showFolder("chat", ""));
        if ("text" in at) return at;
        // Searched from its top, the chat's area is searched with what is kept beside it.
        const beside = at.kind === "chat" && at.path === "" ? view.areas.learned : null;
        const places: Place[] = beside ? [at, { kind: "learned", area: beside, path: "", shown: showFolder("learned", "") }] : [at];
        const files = (
          await Promise.all(
            places.map(async (place) =>
              filesIn(await place.area.index())
                .filter(([path]) => place.path === "" || path === place.path || path.startsWith(`${place.path}/`))
                .map(([path, entry]) => ({ place, path, entry })),
            ),
          )
        ).flat();
        // A file whose text the store no longer has holds no line to find.
        const bodies = await Promise.all(files.map(async (file) => (await file.place.area.text(file.entry.hash)) ?? ""));
        const found = grepLines(bodies, needle);
        if (found.length === 0) return { text: d.say(TEXT.workspace.grepNothing, { files: texts.counted(files.length, TEXT.workspace.wordFile) }, { query: needle, where: places.map((place) => place.shown).join(", ") }) };
        return listPage(d.p, {
          total: found.length,
          noun: TEXT.word.line,
          cursor,
          item: (i) => {
            const line = found[i];
            const file = line ? files[line.key] : undefined;
            return line && file ? texts.render(TEXT.workspace.grepLine, { path: showPath(file.place.kind, file.path), line: String(line.line), text: around(line.text, line.at, needle.length, env.settings.tools.lineChars) }) : "";
          },
        });
      },
    };
  },
};

const workspaceWrite: ToolDefinition = {
  name: TOOL.workspaceWrite,
  family: FAMILY.workspace,
  tier: "write",
  build(env: ToolEnv) {
    const view = env.workspace;
    if (!view) return null;
    const { texts } = env;
    const d = deskOf(env, view, TOOL.workspaceWrite);
    return {
      name: TOOL.workspaceWrite,
      description: texts.render(TEXT.tool(TOOL.workspaceWrite)),
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceWrite, "path")) }, content: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceWrite, "content")) }, base: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceWrite, "base")) } },
        required: ["path", "content", "base"],
      },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        live(ctx);
        const path = textArg(args.path);
        if (path === null) return needs(d.p, "path");
        // A file's text is taken as it is written, an empty one too: never trimmed.
        const { content } = args;
        if (typeof content !== "string") return needs(d.p, "content");
        const base = textArg(args.base);
        if (base === null) return needs(d.p, "base");
        const at = d.place(path);
        if ("text" in at) return at;
        if (at.path === "") return d.fail(TEXT.workspace.isFolder, {}, { path: at.shown });
        const barred = d.barred(at.kind, at.path);
        if (barred) return barred;
        const result = await at.area.write({ path: at.path, text: content, base: base.toLowerCase() === NEW ? null : base, by: view.author });
        // A base given for a file that isn't there is most often a new file written without saying so: the answer says how.
        if (!result.ok && result.why.code === "missing") return d.fail(TEXT.workspace.noFileToWrite, {}, { path: at.shown });
        return d.written(at, result, (entry) => d.say(TEXT.workspace.wrote, { chars: String(entry.chars), version: versionOf(entry.hash) }, { path: at.shown }));
      },
    };
  },
};

const workspaceEdit: ToolDefinition = {
  name: TOOL.workspaceEdit,
  family: FAMILY.workspace,
  tier: "write",
  build(env: ToolEnv) {
    const view = env.workspace;
    if (!view) return null;
    const { texts } = env;
    const d = deskOf(env, view, TOOL.workspaceEdit);
    return {
      name: TOOL.workspaceEdit,
      description: texts.render(TEXT.tool(TOOL.workspaceEdit)),
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceEdit, "path")) },
          find: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceEdit, "find")) },
          replace: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceEdit, "replace")) },
          base: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceEdit, "base")) },
          all: { type: "boolean", description: texts.render(TEXT.toolArg(TOOL.workspaceEdit, "all")) },
        },
        required: ["path", "find", "replace", "base"],
      },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        live(ctx);
        const path = textArg(args.path);
        if (path === null) return needs(d.p, "path");
        // What is looked for and what takes its place are taken as they are written: a space or a line break at either end counts.
        const { find, replace } = args;
        if (typeof find !== "string" || find === "") return needs(d.p, "find");
        if (typeof replace !== "string") return needs(d.p, "replace");
        const base = textArg(args.base);
        if (base === null) return needs(d.p, "base");
        const at = d.place(path);
        if ("text" in at) return at;
        const barred = d.barred(at.kind, at.path);
        if (barred) return barred;
        const entry = await d.file(at);
        if ("text" in entry) return entry;
        // The version is checked before the text is looked for: a text copied from an older version is told that the file changed, not that it isn't there.
        if (!sameVersion(base, entry.hash)) return d.refused(at.kind, { code: "stale", path: at.path, version: entry.hash });
        const text = await at.area.text(entry.hash);
        if (text === null) return d.fail(TEXT.workspace.readGone, { version: versionOf(entry.hash) }, { path: at.shown });
        const pieces = text.split(find);
        const matches = pieces.length - 1;
        if (matches === 0) return d.fail(TEXT.workspace.editNotFound, { version: versionOf(entry.hash) }, { path: at.shown });
        if (matches > 1 && flagArg(args.all) !== true) return d.fail(TEXT.workspace.editSeveral, { count: texts.counted(matches, TEXT.word.time) }, { path: at.shown });
        live(ctx);
        // Joined, never put through a replace pattern: what takes the text's place is written as it is, a `$` too. The write is based on the version just read, so a change made meanwhile refuses it.
        const result = await at.area.write({ path: at.path, text: pieces.join(replace), base: entry.hash, by: view.author });
        return d.written(at, result, (now) => d.say(TEXT.workspace.edited, { count: texts.counted(matches, TEXT.workspace.wordMatch), chars: String(now.chars), version: versionOf(now.hash) }, { path: at.shown }));
      },
    };
  },
};

const workspaceMove: ToolDefinition = {
  name: TOOL.workspaceMove,
  family: FAMILY.workspace,
  tier: "write",
  build(env: ToolEnv) {
    const view = env.workspace;
    if (!view) return null;
    const { texts } = env;
    const d = deskOf(env, view, TOOL.workspaceMove);
    return {
      name: TOOL.workspaceMove,
      description: texts.render(TEXT.tool(TOOL.workspaceMove)),
      parameters: {
        type: "object",
        properties: { from: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceMove, "from")) }, to: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceMove, "to")) }, base: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceMove, "base")) } },
        required: ["from", "to", "base"],
      },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        live(ctx);
        const from = textArg(args.from);
        if (from === null) return needs(d.p, "from");
        const to = textArg(args.to);
        if (to === null) return needs(d.p, "to");
        const base = textArg(args.base);
        if (base === null) return needs(d.p, "base");
        const source = d.place(from);
        if ("text" in source) return source;
        const target = d.place(to);
        if ("text" in target) return target;
        // An area's index moves a file within itself; across two it would be a write and a delete, which the agent makes itself so each is its own versioned change.
        if (source.kind !== target.kind) return d.fail(TEXT.workspace.moveAcross, {}, { from: source.shown, to: target.shown });
        if (target.path === "") return d.fail(TEXT.workspace.isFolder, {}, { path: target.shown });
        const barred = d.barred(source.kind, source.path, target.path);
        if (barred) return barred;
        const entry = await d.file(source);
        if ("text" in entry) return entry;
        live(ctx);
        const moved = await source.area.move({ from: source.path, to: target.path, base, by: view.author });
        if (!moved.ok) return d.refused(source.kind, moved.why);
        return { text: d.say(TEXT.workspace.moved, { version: versionOf((moved.entry ?? entry).hash) }, { from: source.shown, to: target.shown }), files: moved.changes };
      },
    };
  },
};

const workspaceDelete: ToolDefinition = {
  name: TOOL.workspaceDelete,
  family: FAMILY.workspace,
  tier: "write",
  build(env: ToolEnv) {
    const view = env.workspace;
    if (!view) return null;
    const { texts } = env;
    const d = deskOf(env, view, TOOL.workspaceDelete);
    return {
      name: TOOL.workspaceDelete,
      description: texts.render(TEXT.tool(TOOL.workspaceDelete)),
      parameters: { type: "object", properties: { path: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceDelete, "path")) }, base: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspaceDelete, "base")) } }, required: ["path", "base"] },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        live(ctx);
        const path = textArg(args.path);
        if (path === null) return needs(d.p, "path");
        const base = textArg(args.base);
        if (base === null) return needs(d.p, "base");
        const at = d.place(path);
        if ("text" in at) return at;
        const barred = d.barred(at.kind, at.path);
        if (barred) return barred;
        const entry = await d.file(at);
        if ("text" in entry) return entry;
        live(ctx);
        const gone = await at.area.remove({ path: at.path, base, by: view.author });
        if (!gone.ok) return d.refused(at.kind, gone.why);
        return { text: d.say(TEXT.workspace.deleted, { version: versionOf(gone.changes[0]?.before ?? entry.hash) }, { path: at.shown }), files: gone.changes };
      },
    };
  },
};

const workspacePin: ToolDefinition = {
  name: TOOL.workspacePin,
  family: FAMILY.workspace,
  tier: "write",
  build(env: ToolEnv) {
    const view = env.workspace;
    if (!view) return null;
    const { texts } = env;
    const d = deskOf(env, view, TOOL.workspacePin);
    return {
      name: TOOL.workspacePin,
      description: texts.render(TEXT.tool(TOOL.workspacePin)),
      parameters: { type: "object", properties: { path: { type: "string", description: texts.render(TEXT.toolArg(TOOL.workspacePin, "path")) }, pinned: { type: "boolean", description: texts.render(TEXT.toolArg(TOOL.workspacePin, "pinned")) } }, required: ["path", "pinned"] },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        live(ctx);
        const path = textArg(args.path);
        if (path === null) return needs(d.p, "path");
        const pinned = flagArg(args.pinned);
        if (pinned === null) return needs(d.p, "pinned");
        const at = d.place(path);
        if ("text" in at) return at;
        // A pin in ~/ leads what the agent is sent in every chat of the user's, so a text planted in one chat (a card, a lore entry, a tool's result) could stay in all of them: it is the user's to set and to lift, unless Settings let agents.
        if (at.kind === "user" && !env.settings.workspace.agentsPinUser) return d.fail(TEXT.workspace.pinUser, {}, { path: at.shown });
        const entry = await d.file(at);
        if ("text" in entry) return entry;
        live(ctx);
        // A pin is no version of the file, so the guard that says what an agent may write isn't asked.
        const result = await at.area.pin({ path: at.path, role: view.role, pinned });
        if (!result.ok) return d.refused(at.kind, result.why);
        if (!pinned) return { text: d.say(TEXT.workspace.unpinned, {}, { path: at.shown }) };
        // What the agent's pins hold together now, against what a turn gives of them: so it knows whether this one will come whole.
        const held = (await pinnedFiles(view)).reduce((sum, file) => sum + file.entry.chars, 0);
        return { text: d.say(TEXT.workspace.pinned, { chars: String(held), limit: String(env.settings.workspace.pinChars) }, { path: at.shown }) };
      },
    };
  },
};

export const WORKSPACE_TOOLS: readonly ToolDefinition[] = [workspaceList, workspaceRead, workspaceGrep, workspaceWrite, workspaceEdit, workspaceMove, workspaceDelete, workspacePin];
