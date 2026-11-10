// The lore tools (DESIGN §4.3): an index, search, grep and read over the world books that apply to
// the chat, every entry of them, those Lumiverse didn't activate among them; and the entries it did
// activate for this turn. An entry is named by the start of its id (`LoreItem.short`), which
// `lore_read` takes, as it takes the id whole.

import type { JsonObject } from "../ports";
import { TEXT, TOOL, type Texts } from "../texts";
import type { LoreItem, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, textArg } from "../util";
import { loreExcerpt } from "../views";
import { around, fitted, grepLines, listPage, needs, pagerOf, readCursor, textPage } from "./paging";

/** What marks an entry in an answer: that it is switched off, that its book always sends it, or nothing. */
function flags(item: LoreItem, texts: Texts): string {
  return `${item.entry.enabled ? "" : texts.render(TEXT.answer.loreOff)}${item.entry.constant ? texts.render(TEXT.answer.loreAlways) : ""}`;
}

function keys(item: LoreItem, texts: Texts): string {
  const all = [...item.entry.keys, ...item.entry.secondaryKeys];
  return all.length > 0 ? all.join(", ") : texts.render(TEXT.session.none);
}

/**
 * The entries `ref` names: one by its whole id, by the short id the tools show, or by the start of
 * its id; several when the start names more than one. A model may copy the id with its brackets, or
 * with its book before a slash.
 */
function named(items: readonly LoreItem[], ref: string): LoreItem[] {
  const id = ref.replace(/^\[|\]$/g, "").split("/").at(-1)?.trim() ?? "";
  if (id === "") return [];
  const exact = items.filter((item) => item.entry.id === id || item.short === id);
  return exact.length > 0 ? exact.slice(0, 1) : items.filter((item) => item.entry.id.startsWith(id));
}

const loreIndex: ToolDefinition = {
  name: TOOL.loreIndex,
  build(env: ToolEnv) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreIndex);
    return {
      name: TOOL.loreIndex,
      description: texts.render(TEXT.tool(TOOL.loreIndex)),
      parameters: { type: "object", properties: { book: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreIndex, "book")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreIndex, "cursor")) } } },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const books = await env.lore.books();
        if (books.length === 0) return { text: texts.render(TEXT.answer.loreNoBooks) };
        const wanted = textArg(args.book);
        const shown = wanted === null ? books : books.filter((b) => b.id === wanted || b.name.trim().toLowerCase() === wanted.toLowerCase());
        if (shown.length === 0) return { text: fitted(p, books.map((b) => `“${b.name}” [${b.id}]`).join(", "), (list) => texts.render(TEXT.answer.loreNoBook, { book: wanted ?? "", books: list })), error: true };
        const items = (await env.lore.items()).filter((item) => shown.some((b) => b.id === item.book.id));
        const heading = (bookId: string): string => {
          const book = shown.find((b) => b.id === bookId);
          const count = items.filter((item) => item.book.id === bookId).length;
          return book ? texts.render(TEXT.answer.loreBook, { name: book.name, id: book.id, count: texts.counted(count, TEXT.word.entry), description: book.description.trim() === "" ? "" : ` — ${clip(book.description.trim(), env.settings.tools.lineChars)}` }) : "";
        };
        // Books with no entry have no line of their own to hang a heading on: they are listed alone.
        if (items.length === 0) return { text: shown.map((b) => heading(b.id)).join("\n") };
        return listPage(p, {
          total: items.length,
          noun: TEXT.word.entry,
          cursor,
          item: (i, first) => {
            const item = items[i];
            if (!item) return "";
            const line = texts.render(TEXT.answer.loreEntry, { id: item.short, title: item.entry.title, flags: flags(item, texts), keys: clip(keys(item, texts), env.settings.tools.lineChars), chars: String(item.entry.content.length) });
            // A book's heading leads its first entry, and the page when the page starts inside the book.
            return first || items[i - 1]?.book.id !== item.book.id ? `${heading(item.book.id)}\n${line}` : line;
          },
        });
      },
    };
  },
};

const loreSearch: ToolDefinition = {
  name: TOOL.loreSearch,
  build(env: ToolEnv) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreSearch);
    return {
      name: TOOL.loreSearch,
      description: texts.render(TEXT.tool(TOOL.loreSearch)),
      parameters: { type: "object", properties: { query: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreSearch, "query")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreSearch, "cursor")) } }, required: ["query"] },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const query = textArg(args.query);
        if (query === null) return needs(p, "query");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const items = await env.lore.items();
        if (items.length === 0) return { text: texts.render(TEXT.answer.loreNoBooks) };
        const hits = (await env.lore.index()).search(query);
        if (hits.length === 0) return { text: texts.render(TEXT.answer.loreSearchNothing, { query }) };
        return listPage(p, {
          total: hits.length,
          noun: TEXT.word.entry,
          cursor,
          item: (i) => {
            const hit = hits[i];
            const item = hit ? items[hit.key] : undefined;
            return hit && item ? texts.render(TEXT.answer.loreHit, { id: item.short, title: item.entry.title, flags: flags(item, texts), book: item.book.name, chars: String(item.entry.content.length), excerpt: loreExcerpt(item, hit.piece, env.settings.tools.excerptChars) }) : "";
          },
        });
      },
    };
  },
};

const loreGrep: ToolDefinition = {
  name: TOOL.loreGrep,
  build(env: ToolEnv) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreGrep);
    return {
      name: TOOL.loreGrep,
      description: texts.render(TEXT.tool(TOOL.loreGrep)),
      parameters: { type: "object", properties: { text: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreGrep, "text")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreGrep, "cursor")) } }, required: ["text"] },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const needle = textArg(args.text);
        if (needle === null) return needs(p, "text");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const items = await env.lore.items();
        if (items.length === 0) return { text: texts.render(TEXT.answer.loreNoBooks) };
        const found = grepLines(items.map((item) => item.entry.content), needle);
        if (found.length === 0) return { text: texts.render(TEXT.answer.loreGrepNothing, { query: needle }) };
        return listPage(p, {
          total: found.length,
          noun: TEXT.word.line,
          cursor,
          item: (i) => {
            const line = found[i];
            const item = line ? items[line.key] : undefined;
            return line && item ? texts.render(TEXT.answer.loreLine, { id: item.short, title: item.entry.title, line: String(line.line), text: around(line.text, line.at, needle.length, env.settings.tools.lineChars) }) : "";
          },
        });
      },
    };
  },
};

const loreRead: ToolDefinition = {
  name: TOOL.loreRead,
  build(env: ToolEnv) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreRead);
    return {
      name: TOOL.loreRead,
      description: texts.render(TEXT.tool(TOOL.loreRead)),
      parameters: { type: "object", properties: { id: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreRead, "id")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreRead, "cursor")) } }, required: ["id"] },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const ref = textArg(args.id);
        if (ref === null) return needs(p, "id");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const found = named(await env.lore.items(), ref);
        const [item] = found;
        if (!item) return { text: texts.render(TEXT.answer.loreNoEntry, { id: ref }), error: true };
        if (found.length > 1) return { text: fitted(p, found.map((x) => `[${x.short}] ${x.entry.title}`).join(", "), (list) => texts.render(TEXT.answer.loreAmbiguous, { id: ref, entries: list })), error: true };
        return textPage(p, {
          text: item.entry.content,
          from: cursor.at,
          given: cursor.given,
          frame: (part) => texts.render(TEXT.answer.loreRead, { id: item.short, title: item.entry.title, flags: flags(item, texts), book: item.book.name, keys: clip(keys(item, texts), env.settings.tools.lineChars), from: String(part.from), to: String(part.to), chars: String(item.entry.content.length), text: part.text }),
        });
      },
    };
  },
};

const activeLore: ToolDefinition = {
  name: TOOL.activeLore,
  build(env: ToolEnv) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.activeLore);
    return {
      name: TOOL.activeLore,
      description: texts.render(TEXT.tool(TOOL.activeLore)),
      parameters: { type: "object", properties: { cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.activeLore, "cursor")) } } },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const active = await env.lore.activated();
        if (active.length === 0) return { text: texts.render(TEXT.answer.activeNone) };
        const items = await env.lore.items();
        return listPage(p, {
          total: active.length,
          noun: TEXT.word.entry,
          cursor,
          item: (i) => {
            const entry = active[i];
            if (!entry) return "";
            // An entry of a book the tools read goes by the id they show; one from elsewhere by its own.
            const item = items.find((x) => x.entry.id === entry.entryId);
            return texts.render(TEXT.answer.activeEntry, { id: item?.short ?? entry.entryId, title: entry.title, book: item?.book.name ?? entry.bookId, chars: String(entry.content.length), excerpt: clip(entry.content.replace(/\s+/g, " ").trim(), env.settings.tools.excerptChars) });
          },
        });
      },
    };
  },
};

export const LORE_TOOLS: readonly ToolDefinition[] = [loreIndex, loreSearch, loreGrep, loreRead, activeLore];
