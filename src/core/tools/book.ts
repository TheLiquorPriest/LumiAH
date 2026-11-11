// The book tools (DESIGN §23): book_outline and book_read, over the chat's LumiBooks book as the run
// read it (`ToolEnv.book`, worked out by `book.ts`). Neither asks a model, and neither is offered
// where the chat has no book. An entry is named by the short id the outline shows, which both tools
// take as they take the id whole.
//
// The outline's coverage is the book's as a whole, so it is said once: it leads the page the outline
// starts with, where every reader of the outline passes, and no page after it.

import type { Book, BookNode } from "../book";
import type { JsonObject } from "../ports";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, textArg } from "../util";
import { fitted, listPage, needs, pagerOf, readCursor, textPage } from "./paging";

/**
 * The share of a page the coverage may take where it leads the outline: half, so the tree's lines
 * have the rest. Fixed, not a setting: it divides one page between the two, and the page's length
 * is the setting (Answer length).
 */
const COVERAGE_SHARE = 0.5;

/** A tree's entries in the order an outline lists them, each above the entries under it, with how deep it sits. */
function rowsOf(nodes: readonly BookNode[], depth = 0): { node: BookNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...rowsOf(node.children, depth + 1)]);
}

/**
 * The entry `ref` names: by its whole id, by the short id the outline shows, or by a start of its id
 * that no other entry of the book shares. A model may copy the id with its brackets.
 */
function named(nodes: readonly BookNode[], ref: string): BookNode | undefined {
  const id = ref.replace(/^\[|\]$/g, "").trim();
  if (id === "") return undefined;
  const starts = nodes.filter((node) => node.id.startsWith(id));
  return nodes.find((node) => node.id === id || node.short === id) ?? (starts.length === 1 ? starts[0] : undefined);
}

/**
 * The call's arguments with its cursor, where that is no number, a line long at most: the answer to
 * a cursor no tool gave repeats it, and a cursor a tool gave is far shorter.
 */
function bounded(args: JsonObject, max: number): JsonObject {
  const { cursor } = args;
  if (cursor === undefined || cursor === null || typeof cursor === "number") return args;
  return { ...args, cursor: clip(typeof cursor === "string" ? cursor : JSON.stringify(cursor), max) };
}

/** Messages as the runs they make, each by its first and last message's number as the chat tools name them, `max` characters long at most. */
function runsText(runs: readonly (readonly [number, number])[], env: ToolEnv, max: number): string {
  const { texts } = env;
  const said = runs.map(([from, to]) => (from === to ? texts.render(TEXT.book.message, { index: String(from) }) : texts.render(TEXT.book.span, { from: String(from), to: String(to) })));
  return clip(said.join(", "), max);
}

/** An entry as every answer names it: its id, what it is, its title and the messages it spans. */
function head(node: BookNode, env: ToolEnv): string {
  const { texts } = env;
  return texts.render(TEXT.book.head, {
    id: node.short,
    kind: texts.noun(1, TEXT.book.level[node.level]),
    title: node.title === "" ? texts.render(TEXT.book.untitled) : clip(node.title, env.settings.tools.lineChars),
    span: node.span === null ? texts.render(TEXT.book.spanNone) : runsText([node.span], env, env.settings.tools.lineChars),
  });
}

/**
 * How the book stands against the chat, in words `max` characters long at most: how much of the
 * chat it covers, where it is silent and where it is out of date. Each list of runs follows how
 * many messages it holds, and the two lists share what the other words leave of `max`, each a line
 * long at most: a long list is clipped, and neither is lost to the other.
 */
function coverageText(book: Book, env: ToolEnv, max: number): string {
  const { texts } = env;
  const { covered, messages, uncovered, changed } = book.coverage;
  const said = (room: number): string =>
    texts.render(TEXT.book.coverage, {
      covered: String(covered),
      messages: texts.counted(messages, TEXT.word.message),
      uncovered: uncovered.count === 0 ? texts.render(TEXT.book.uncoveredNone) : texts.render(TEXT.book.uncovered, { count: texts.counted(uncovered.count, TEXT.word.message), ranges: runsText(uncovered.runs, env, room) }),
      changed: changed === null ? texts.render(TEXT.book.changedUnknown) : changed.count === 0 ? texts.render(TEXT.book.changedNone) : texts.render(TEXT.book.changed, { count: texts.counted(changed.count, TEXT.word.message), ranges: runsText(changed.runs, env, room) }),
    });
  const room = Math.floor((max - said(0).length) / 2);
  return clip(said(Math.min(env.settings.tools.lineChars, Math.max(1, room))), max);
}

const bookOutline: ToolDefinition = {
  name: TOOL.bookOutline,
  family: FAMILY.book,
  tier: "read",
  build(env: ToolEnv) {
    const { texts, book } = env;
    if (!book) return null;
    const p = pagerOf(env, TOOL.bookOutline);
    const { lineChars } = env.settings.tools;
    const all = rowsOf(book.nodes);
    const nodes = all.map((row) => row.node);
    return {
      name: TOOL.bookOutline,
      description: texts.render(TEXT.tool(TOOL.bookOutline)),
      parameters: { type: "object", properties: { entry: { type: "string", description: texts.render(TEXT.toolArg(TOOL.bookOutline, "entry")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.bookOutline, "cursor")) } } },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(p, bounded(args, lineChars));
        if ("text" in cursor) return cursor;
        const ref = textArg(args.entry);
        const under = ref === null ? undefined : named(nodes, ref);
        if (ref !== null && !under) return { text: fitted(p, clip(ref, lineChars), (id) => texts.render(TEXT.book.noEntry, { id })), error: true };
        if (under && under.children.length === 0) return { text: texts.render(TEXT.book.leaf, { head: head(under, env), id: under.short }) };
        const listed = under ? under.children.map((node) => ({ node, depth: 0 })) : all;
        const lead = under ? texts.render(TEXT.book.under, { head: head(under, env) }) : cursor.at === 0 ? coverageText(book, env, Math.floor(p.pageChars * COVERAGE_SHARE)) : undefined;
        return listPage(p, {
          total: listed.length,
          noun: TEXT.word.entry,
          cursor,
          lead,
          item: (i) => {
            const row = listed[i];
            return row ? texts.render(TEXT.book.line, { indent: "  ".repeat(row.depth), head: head(row.node, env), chars: String(row.node.chars) }) : "";
          },
        });
      },
    };
  },
};

const bookRead: ToolDefinition = {
  name: TOOL.bookRead,
  family: FAMILY.book,
  tier: "read",
  build(env: ToolEnv) {
    const { texts, book } = env;
    if (!book) return null;
    const p = pagerOf(env, TOOL.bookRead);
    const { lineChars } = env.settings.tools;
    const nodes = rowsOf(book.nodes).map((row) => row.node);
    return {
      name: TOOL.bookRead,
      description: texts.render(TEXT.tool(TOOL.bookRead)),
      parameters: { type: "object", properties: { entry: { type: "string", description: texts.render(TEXT.toolArg(TOOL.bookRead, "entry")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.bookRead, "cursor")) } }, required: ["entry"] },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const ref = textArg(args.entry);
        if (ref === null) return needs(p, "entry");
        const cursor = readCursor(p, bounded(args, lineChars));
        if ("text" in cursor) return cursor;
        const node = named(nodes, ref);
        const text = node === undefined ? undefined : book.contents.get(node.id);
        if (node === undefined || text === undefined) return { text: fitted(p, clip(ref, lineChars), (id) => texts.render(TEXT.book.noEntry, { id })), error: true };
        return textPage(p, {
          text,
          from: cursor.at,
          given: cursor.given,
          frame: (part) => texts.render(TEXT.book.read, { head: head(node, env), from: String(part.from), to: String(part.to), chars: String(text.length), text: part.text }),
        });
      },
    };
  },
};

export const BOOK_TOOLS: readonly ToolDefinition[] = [bookOutline, bookRead];
