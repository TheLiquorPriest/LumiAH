// The lore tools (DESIGN §24.2): an index, a search, a grep and a read over every entry of the world
// books that apply to the chat, those Lumiverse didn't activate among them; one hop along the lore's
// own links; everything the books hold on a name; and the entries the prompt holds. Each answers
// from the run's view of the lore (`recallOf`): the books as they stood when the run first asked,
// indexed once and kept between turns, so a tool call reads nothing from the host that the run has
// read before. An entry is named by the short id every answer shows, which every tool takes as it
// takes the id whole. Nothing here asks a model.

import type { JsonObject, RequestMessage } from "../ports";
import { grepBound, grepTexts, hitLines, lateAnswer, lineMatch, namedArgs, type QueryPart, readAnswer, type ReadItem, restNote, searchAnswer } from "../recall/answers";
import { findName, keysOf, lineAt, type LoreCorpus, type LoreDoc, type LoreLink, lowerOf, mentionedBy, mentionsOf, namesOf } from "../recall/lore";
import { hitDetail, type HitField, type LoreHit, searchLore } from "../recall/lore-search";
import type { LoreBookRecord } from "../recall/ports";
import { type HeldDetail, type HeldLore, messageText, shownId } from "../recall/prompt";
import { flagsOf, recallOf, type RecallRun } from "../recall/recall";
import { FAMILY, TEXT, type Texts, TOOL } from "../texts";
import type { AgentTool, ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, textArg } from "../util";
import { around, fitted, listPage, needs, type Pager, pagerOf, readCursor, saidBack } from "./paging";

const A = TEXT.recall.answer;
const ENTRY = TEXT.recall.word.entry;

/**
 * The share of its room that one of two parts of an answer may take where both must fit a page: a
 * query's heading beside its hits, what a read says of an entry beside its text, the notes of what
 * wasn't read or run beside what was, and each of two lists of linked entries. Fixed, not a
 * setting: it divides one page between the two, and the page's length is the setting (Answer
 * length).
 */
const HALF = 0.5;

/** How an entry may stand, as `lore_index` filters by it. The values are the tool's own, as its argument's text names them, so they aren't texts. */
const STATES = ["in_prompt", "not_in_prompt", "always", "off"] as const;
type EntryState = (typeof STATES)[number];

/** The text that names each place a query's words matched. */
const FIELD: Record<HitField, string> = { title: A.fieldTitle, key: A.fieldKey, text: A.fieldText };

/** How much an answer shows of each of `parts` names (a title, a book's name, an entry's keys) that stand beside a text: a line each at most, and half the page together, so the text keeps the rest. */
function nameRoom(p: Pager, parts: number): number {
  return Math.max(1, Math.min(p.lineChars, Math.floor((p.pageChars * HALF) / parts)));
}

/** A lore tool before the run holds it: what it is offered as, and how it answers a call. */
interface Offered extends Pick<AgentTool, "name" | "description" | "parameters"> {
  answer(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome>;
}

/**
 * A tool as the run holds it. Every answer below is built to fit its page; this holds the whole to
 * Answer length as well, where a page is set too short for an answer's own words (a heading, a
 * cursor, a note) to fit it: the answer is cut there, since a page too short for them is still a
 * page.
 */
function toolOf(p: Pager, { answer, ...offered }: Offered): AgentTool {
  return {
    ...offered,
    run: async (args, ctx) => {
      const said = await answer(args, ctx);
      return said.text.length <= p.pageChars ? said : { ...said, text: clip(said.text, p.pageChars) };
    },
  };
}

/** The run's lore as a tool reads it; or the tool's answer where there is none to read: no world book applies to the chat, or (`entries`) the books that do hold no entry. */
async function loreOf(env: ToolEnv, entries = true): Promise<{ run: RecallRun; corpus: LoreCorpus } | ToolOutcome> {
  const run = recallOf(env);
  const corpus = await run.lore();
  if (corpus.books.length === 0 || (entries && corpus.docs.length === 0)) return { text: env.texts.render(A.loreNoBooks) };
  return { run, corpus };
}

/**
 * The books a call's `book` names: the book with that id, or the books with that name in any letter
 * case (a model may copy either with its brackets or its quotes); `only` null where the call names
 * none, which means every book. Where it names none of the books that apply, the error that lists
 * them.
 */
function booksNamed(p: Pager, corpus: LoreCorpus, value: unknown): { only: ReadonlySet<string> | null } | ToolOutcome {
  const wanted = textArg(value);
  if (wanted === null) return { only: null };
  const bare = wanted.replace(/^[[“"]|[\]”"]$/g, "").trim();
  const lower = bare.toLowerCase();
  const named = corpus.books.filter((book) => book.id === bare || book.name.trim().toLowerCase() === lower);
  if (named.length > 0) return { only: new Set(named.map((book) => book.id)) };
  return { text: fitted(p, corpus.books.map((book) => `“${book.name}” [${book.id}]`).join(", "), (books) => saidBack(p, wanted, (book) => p.texts.render(A.loreNoBook, { book, books }))), error: true };
}

/** The error for a reference that names no entry, or several: what to give instead. */
function notOne(p: Pager, ref: string, named: readonly LoreDoc[]): ToolOutcome {
  if (named.length === 0) return { text: saidBack(p, ref, (id) => p.texts.render(A.loreNoEntry, { id })), error: true };
  return { text: fitted(p, named.map((one) => nameOf(one, p.lineChars)).join(", "), (entries) => saidBack(p, ref, (id) => p.texts.render(A.loreAmbiguous, { id, entries }))), error: true };
}

/** An entry as a list of entries names it: its id as the tools take it, and its title. */
function nameOf(doc: LoreDoc, max: number): string {
  return `[${doc.short}] ${clip(doc.entry.title, max)}`;
}

/** An entry's keys as the answers show them, `max` characters at most; the text for nothing where it has none. */
function keysText(doc: LoreDoc, texts: Texts, max: number): string {
  const keys = keysOf(doc.entry).join(", ");
  return keys === "" ? texts.render(TEXT.recall.none) : clip(keys, max);
}

/** An entry as `lore_index` and `lore_about` list it. */
function entryLine(doc: LoreDoc, held: HeldLore | null, env: ToolEnv): string {
  const { texts } = env;
  const { lineChars } = env.settings.tools;
  return texts.render(A.loreEntry, { id: doc.short, title: clip(doc.entry.title, lineChars), flags: flagsOf(doc, held, texts), keys: keysText(doc, texts, lineChars), chars: String(doc.entry.content.length) });
}

/** Whether an entry stands as a `state` filter asks. In a run that answers no generation nothing is in a prompt. */
function stands(doc: LoreDoc, held: HeldLore | null, state: EntryState): boolean {
  if (state === "always") return doc.entry.constant;
  if (state === "off") return !doc.entry.enabled;
  return (held?.byId.has(doc.entry.id) ?? false) === (state === "in_prompt");
}

/** The state a call's `state` names (a model may write it with spaces or hyphens); null where the call names none; the error that lists what it can be where it names none of those. */
function stateNamed(p: Pager, value: unknown): EntryState | null | ToolOutcome {
  if (value === undefined || value === null) return null;
  const given = typeof value === "string" ? value.trim() : (JSON.stringify(value) ?? "");
  if (given === "") return null;
  const wanted = given.toLowerCase().replace(/[\s-]+/g, "_");
  return STATES.find((state) => state === wanted) ?? { text: saidBack(p, given, (said) => p.texts.render(A.badFilter, { tool: p.tool, arg: "state", values: STATES.join(", "), given: said })), error: true };
}

const loreIndex: ToolDefinition = {
  name: TOOL.loreIndex,
  family: FAMILY.lore,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const { lineChars } = env.settings.tools;
    const p = pagerOf(env, TOOL.loreIndex);
    const arg = (name: string): string => texts.render(TEXT.toolArg(TOOL.loreIndex, name));
    return toolOf(p, {
      name: TOOL.loreIndex,
      description: texts.render(TEXT.tool(TOOL.loreIndex)),
      parameters: { type: "object", properties: { book: { type: "string", description: arg("book") }, state: { type: "string", enum: [...STATES], description: arg("state") }, text: { type: "string", description: arg("text") }, cursor: { type: "string", description: arg("cursor") } } },
      async answer(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const state = stateNamed(p, args.state);
        if (state !== null && typeof state !== "string") return state;
        const lore = await loreOf(env, false);
        if ("text" in lore) return lore;
        const { run, corpus } = lore;
        const books = booksNamed(p, corpus, args.book);
        if ("text" in books) return books;
        const { only } = books;
        const text = textArg(args.text);
        const lower = text?.toLowerCase() ?? null;
        const held = await run.held();
        const listed = corpus.docs.filter((doc) => (only === null || only.has(doc.book.id)) && (state === null || stands(doc, held, state)) && (lower === null || doc.entry.title.toLowerCase().includes(lower) || keysOf(doc.entry).some((key) => key.toLowerCase().includes(lower))));
        // A heading counts the entries its book has, whatever the filters let through: the line above the list counts those.
        const counts = new Map<string, number>();
        for (const doc of corpus.docs) counts.set(doc.book.id, (counts.get(doc.book.id) ?? 0) + 1);
        const heading = (book: LoreBookRecord): string => {
          const description = book.description.trim();
          return texts.render(A.loreBook, { name: clip(book.name, lineChars), id: book.id, count: texts.counted(counts.get(book.id) ?? 0, ENTRY), description: description === "" ? "" : ` — ${clip(description, lineChars)}` });
        };
        if (listed.length === 0) {
          if (state !== null || text !== null) {
            const given: [string, string | null][] = [["book", textArg(args.book)], ["state", state], ["text", text]];
            const filters = given.flatMap(([name, value]) => (value === null ? [] : [`${name}: ${clip(value, lineChars)}`]));
            return { text: fitted(p, filters.join(", "), (filter) => texts.render(A.loreIndexNothing, { filter })) };
          }
          // Books without an entry have no line to hang a heading on: they are listed alone.
          const shown = corpus.books.filter((book) => only === null || only.has(book.id));
          return listPage(p, { total: shown.length, noun: TEXT.recall.word.worldBook, cursor, item: (i) => heading(shown[i] as LoreBookRecord) });
        }
        return listPage(p, {
          total: listed.length,
          noun: ENTRY,
          cursor,
          item: (i, first) => {
            const doc = listed[i];
            if (!doc) return "";
            const line = entryLine(doc, held, env);
            // A book's heading leads its first entry, and the page when the page starts inside the book.
            return first || listed[i - 1]?.book.id !== doc.book.id ? `${heading(doc.book)}\n${line}` : line;
          },
        });
      },
    });
  },
};

/** A hit as `lore_search` shows it: the entry, how it stands, how it matched, and its best lines. */
function hitText(hit: LoreHit, query: string, held: HeldLore | null, env: ToolEnv): string {
  const { texts, settings } = env;
  const { lineChars } = settings.tools;
  const { doc } = hit;
  const detail = hitDetail(doc, query, settings);
  const words = texts.render(A.byWords, { fields: detail.fields.map((field) => texts.render(FIELD[field])).join(", "), words: clip(detail.words.join(", "), lineChars) });
  const score = hit.similarity?.toFixed(2);
  // A hit that holds none of the query's words was found by its meaning alone.
  const why = score === undefined ? words : detail.words.length === 0 ? texts.render(A.byMeaning, { score }) : texts.render(A.byBoth, { words, score });
  const said = texts.render(A.loreHit, { id: doc.short, title: clip(doc.entry.title, lineChars), flags: flagsOf(doc, held, texts), book: clip(doc.book.name, lineChars), chars: String(doc.entry.content.length), why, lines: hitLines(texts, detail.lines), excerpt: detail.lines[0]?.text ?? "" });
  // An entry without text has no line to show: its hit ends with how it matched.
  return detail.lines.length === 0 ? said.trimEnd() : said;
}

const loreSearch: ToolDefinition = {
  name: TOOL.loreSearch,
  family: FAMILY.lore,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreSearch);
    const most = env.settings.recall.lore.queries;
    const arg = (name: string): string => texts.render(TEXT.toolArg(TOOL.loreSearch, name));
    return toolOf(p, {
      name: TOOL.loreSearch,
      description: texts.render(TEXT.tool(TOOL.loreSearch)),
      parameters: { type: "object", properties: { queries: { type: "array", items: { type: "string" }, description: arg("queries") }, book: { type: "string", description: arg("book") }, cursor: { type: "string", description: arg("cursor") } }, required: ["queries"] },
      async answer(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const { named: queries, rest } = namedArgs(args, "queries", "query", most);
        if (queries.length === 0) return needs(p, "queries");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const lore = await loreOf(env);
        if ("text" in lore) return lore;
        const { run, corpus } = lore;
        const books = booksNamed(p, corpus, args.book);
        if ("text" in books) return books;
        const { only } = books;
        const { meaning, found } = await searchLore(run, queries, { ...(only ? { keep: (doc: LoreDoc): boolean => only.has(doc.book.id) } : {}), signal: ctx.signal });
        const held = await run.held();
        // What wasn't run is said within half a page, so the queries that were keep the rest.
        const wordOnly = run.wordOnlyNote(meaning);
        const tail = [restNote({ ...p, pageChars: Math.floor(p.pageChars * HALF) }, most, rest), wordOnly];
        // A heading says its query back within a line, and within a quarter of the query's share of the page: half of the half its heading may take beside its hits, whose other half is the heading's own words.
        const share = (p.pageChars - tail.reduce((n, note) => n + (note === "" ? 0 : note.length + 1), 0)) / found.length;
        const said = Math.max(1, Math.min(p.lineChars, Math.floor(share * HALF * HALF)));
        const above = new Set<LoreDoc>();
        const parts = found.map(({ query, hits }): QueryPart => {
          const asked: (LoreDoc | undefined)[] = [];
          return {
            query,
            total: hits.length,
            head: (from, to) => {
              // A heading is written once its hits are, and names the ones the page shows: a later query that finds one of those says so, and doesn't show it again.
              for (let i = from - 1; i < to; i++) {
                const doc = asked[i];
                if (doc) above.add(doc);
              }
              return texts.render(A.queryHead, { query: clip(query, said), total: texts.counted(hits.length, ENTRY), from: String(from), to: String(to) });
            },
            item: (i) => {
              const hit = hits[i];
              if (!hit) return "";
              if (above.has(hit.doc)) return texts.render(A.hitAbove, { name: nameOf(hit.doc, p.lineChars) });
              asked[i] = hit.doc;
              return hitText(hit, query, held, env);
            },
            nothing: saidBack(p, query, (asking) => texts.render(A.loreSearchNothing, { query: asking })),
          };
        });
        const answer = searchAnswer(p, args, parts, tail);
        // The error for a cursor carries no note: the run's next search still owes that it is by word.
        if (answer.error && wordOnly !== "") run.saidWordOnly = false;
        return answer;
      },
    });
  },
};

const loreGrep: ToolDefinition = {
  name: TOOL.loreGrep,
  family: FAMILY.lore,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const { lineChars } = env.settings.tools;
    const p = pagerOf(env, TOOL.loreGrep);
    const arg = (name: string): string => texts.render(TEXT.toolArg(TOOL.loreGrep, name));
    return toolOf(p, {
      name: TOOL.loreGrep,
      description: texts.render(TEXT.tool(TOOL.loreGrep)),
      parameters: { type: "object", properties: { text: { type: "string", description: arg("text") }, regex: { type: "boolean", description: arg("regex") }, book: { type: "string", description: arg("book") }, cursor: { type: "string", description: arg("cursor") } }, required: ["text"] },
      async answer(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const needle = textArg(args.text);
        if (needle === null) return needs(p, "text");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        // A model may write the flag as text.
        const match = lineMatch(p, needle, args.regex === true || (typeof args.regex === "string" && args.regex.trim().toLowerCase() === "true"), env.settings.recall.grep.pieceChars);
        if ("text" in match) return match;
        const lore = await loreOf(env);
        if ("text" in lore) return lore;
        const { corpus } = lore;
        const books = booksNamed(p, corpus, args.book);
        if ("text" in books) return books;
        const { only } = books;
        const docs = only === null ? corpus.docs : corpus.docs.filter((doc) => only.has(doc.book.id));
        // The search gives way as it goes and stops at its time (Settings), so no text and no pattern holds the turn.
        const bound = grepBound(env, ctx.signal);
        const found = await grepTexts(docs.map((doc) => doc.entry.content), match, bound);
        if ("late" in found) return lateAnswer(p, bound, found, texts.counted(docs.length, ENTRY));
        if (found.length === 0) return { text: saidBack(p, needle, (said) => texts.render(A.loreGrepNothing, { query: said })) };
        return listPage(p, {
          total: found.length,
          noun: TEXT.recall.word.line,
          cursor,
          item: (i) => {
            const line = found[i];
            const doc = line ? docs[line.key] : undefined;
            // A match longer than a line is shown from where it starts.
            return line && doc ? texts.render(A.loreLine, { id: doc.short, title: clip(doc.entry.title, lineChars), line: String(line.line), text: around(line.text, line.at, Math.min(line.length, lineChars), lineChars) }) : "";
          },
        });
      },
    });
  },
};

const loreRead: ToolDefinition = {
  name: TOOL.loreRead,
  family: FAMILY.lore,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreRead);
    const most = env.settings.recall.lore.reads;
    const arg = (name: string): string => texts.render(TEXT.toolArg(TOOL.loreRead, name));
    return toolOf(p, {
      name: TOOL.loreRead,
      description: texts.render(TEXT.tool(TOOL.loreRead)),
      parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: arg("ids") }, cursor: { type: "string", description: arg("cursor") } }, required: ["ids"] },
      async answer(args: JsonObject): Promise<ToolOutcome> {
        const { named: refs, rest } = namedArgs(args, "ids", "id", most);
        if (refs.length === 0) return needs(p, "ids");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const lore = await loreOf(env);
        if ("text" in lore) return lore;
        const { run, corpus } = lore;
        const docs: LoreDoc[] = [];
        const missing: { ref: string; named: LoreDoc[] }[] = [];
        for (const ref of refs) {
          const named = corpus.named(ref);
          const [doc] = named;
          if (!doc || named.length > 1) missing.push({ ref, named });
          else if (!docs.includes(doc)) docs.push(doc);
        }
        // One id, and it names no entry or several: the answer is what to give instead.
        const [only] = missing;
        if (only && refs.length === 1 && rest.length === 0) return notOne(p, only.ref, only.named);
        // What wasn't read and what wasn't run are said within half a page together, so the entries read keep the rest. What wasn't read has a line of it at most, and each id its share of that, so one long id doesn't hide the others.
        const notes = Math.floor(p.pageChars * HALF);
        const room = Math.max(1, Math.min(p.lineChars, Math.floor(notes * HALF)));
        const each = Math.max(1, Math.floor(room / Math.max(1, missing.length) / 2));
        const unread = missing.map(({ ref, named }) => `${clip(ref, each)}: ${named.length === 0 ? texts.render(TEXT.recall.writer.unknown) : texts.render(TEXT.recall.writer.ambiguous, { entries: clip(named.map((one) => nameOf(one, each)).join(", "), each) })}`);
        const lead = unread.length === 0 ? "" : texts.render(A.loreMissing, { ids: clip(unread.join("; "), room) });
        const more = restNote({ ...p, pageChars: Math.max(1, notes - lead.length - 1) }, most, rest);
        // No id named an entry: the answer is what wasn't read, and why.
        if (docs.length === 0) return { text: [lead, more].filter((part) => part !== "").join("\n"), error: true };
        const held = await run.held();
        const name = nameRoom(p, 3);
        const items = docs.map((doc, i): ReadItem => {
          const head = { id: doc.short, title: clip(doc.entry.title, name), flags: flagsOf(doc, held, texts), book: clip(doc.book.name, name), keys: keysText(doc, texts, name), chars: String(doc.entry.content.length) };
          return { key: i + 1, text: doc.entry.content, frame: (part) => texts.render(A.loreRead, { ...head, from: String(part.from), to: String(part.to), text: part.text }) };
        });
        // What wasn't read, and what wasn't run, are said once: with the page the read starts on.
        return cursor.given ? readAnswer(p, args, items, "") : readAnswer(p, args, items, lead, [more]);
      },
    });
  },
};

/**
 * A linked entry as `lore_related` and `lore_about` list it: the entry, the name the link was found
 * by, and the line that holds the name in `holder`'s text (the entry asked about where it mentions
 * the other, the other where that mentions it).
 */
function linkText(link: LoreLink, holder: LoreDoc, held: HeldLore | null, env: ToolEnv): string {
  const { texts } = env;
  const { lineChars } = env.settings.tools;
  // The link was found in the text's lower case, whose lines are the text's own: the line is counted there and shown as the entry writes it.
  const { line } = lineAt(lowerOf(holder), link.at);
  const words = (holder.entry.content.split("\n")[line - 1] ?? "").replace(/\s+/g, " ").trim();
  const at = Math.max(0, findName(words.toLowerCase(), link.by));
  return texts.render(A.loreLink, { id: link.doc.short, title: clip(link.doc.entry.title, lineChars), flags: flagsOf(link.doc, held, texts), chars: String(link.doc.entry.content.length), by: clip(link.by, lineChars), line: String(line), text: around(words, at, Math.min(link.by.length, lineChars), lineChars) });
}

/**
 * A list of an answer, one line under the other: the first `most` of `items`, as many of them as
 * fit `room` characters together with the line that counts the rest; the text for nothing where
 * there is none. A line that doesn't fit is counted, never cut.
 */
function listed<T>(texts: Texts, items: readonly T[], line: (item: T) => string, most: number, room: number): string {
  if (items.length === 0) return texts.render(TEXT.recall.none);
  const more = (left: number): string => texts.render(A.loreLinksMore, { count: String(left) });
  const kept: string[] = [];
  let used = 0;
  for (const [i, item] of items.slice(0, Math.max(1, most)).entries()) {
    const said = line(item);
    const after = items.length - i - 1;
    if (used + said.length + 1 + (after > 0 ? more(after).length + 1 : 0) > room) break;
    kept.push(said);
    used += said.length + 1;
  }
  return [...kept, ...(kept.length < items.length ? [more(items.length - kept.length)] : [])].join("\n");
}

const loreRelated: ToolDefinition = {
  name: TOOL.loreRelated,
  family: FAMILY.lore,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreRelated);
    return toolOf(p, {
      name: TOOL.loreRelated,
      description: texts.render(TEXT.tool(TOOL.loreRelated)),
      parameters: { type: "object", properties: { id: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreRelated, "id")) } }, required: ["id"] },
      async answer(args: JsonObject): Promise<ToolOutcome> {
        const ref = textArg(args.id);
        if (ref === null) return needs(p, "id");
        const lore = await loreOf(env);
        if ("text" in lore) return lore;
        const { run, corpus } = lore;
        const named = corpus.named(ref);
        const [doc] = named;
        if (!doc || named.length > 1) return notOne(p, ref, named);
        const held = await run.held();
        const out = mentionsOf(corpus, doc);
        const into = mentionedBy(corpus, namesOf(doc.entry), doc);
        const { links } = env.settings.recall.lore;
        const name = nameRoom(p, 2);
        const said = (outLines: string, inLines: string): string =>
          texts.render(A.loreRelated, { id: doc.short, title: clip(doc.entry.title, name), flags: flagsOf(doc, held, texts), book: clip(doc.book.name, name), chars: String(doc.entry.content.length), out: texts.counted(out.length, ENTRY), outLines, in: texts.counted(into.length, ENTRY), inLines });
        // Each list has half of what the answer's own words leave, so neither is lost to the other.
        const room = Math.floor((p.pageChars - said("", "").length) * HALF);
        const outLines = listed(texts, out, (link) => linkText(link, doc, held, env), links, room);
        const inLines = listed(texts, into, (link) => linkText(link, link.doc, held, env), links, room);
        return { text: said(outLines, inLines) };
      },
    });
  },
};

const loreAbout: ToolDefinition = {
  name: TOOL.loreAbout,
  family: FAMILY.lore,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreAbout);
    return toolOf(p, {
      name: TOOL.loreAbout,
      description: texts.render(TEXT.tool(TOOL.loreAbout)),
      parameters: { type: "object", properties: { name: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreAbout, "name")) } }, required: ["name"] },
      async answer(args: JsonObject): Promise<ToolOutcome> {
        const name = textArg(args.name);
        if (name === null) return needs(p, "name");
        const lore = await loreOf(env);
        if ("text" in lore) return lore;
        const { run, corpus } = lore;
        // An entry's names are in lower case, one space between their words: the name asked for is read the same way.
        const wanted = name.replace(/\s+/g, " ").toLowerCase();
        const own = corpus.docs.filter((doc) => namesOf(doc.entry).some((known) => known === wanted || findName(known, wanted) >= 0));
        const owned = new Set(own);
        const others = mentionedBy(corpus, [wanted]).filter((link) => !owned.has(link.doc));
        if (own.length === 0 && others.length === 0) return { text: saidBack(p, name, (said) => texts.render(A.loreAboutNothing, { name: said })) };
        const held = await run.held();
        const { links } = env.settings.recall.lore;
        const said = (ownLines: string, otherLines: string): string => texts.render(A.loreAbout, { name: clip(name, nameRoom(p, 1)), own: texts.counted(own.length, ENTRY), ownLines, others: texts.counted(others.length, ENTRY), otherLines });
        // Each list has half of what the answer's own words leave, so neither is lost to the other.
        const room = Math.floor((p.pageChars - said("", "").length) * HALF);
        const ownLines = listed(texts, own, (one) => entryLine(one, held, env), links, room);
        const otherLines = listed(texts, others, (link) => linkText(link, link.doc, held, env), links, room);
        return { text: said(ownLines, otherLines) };
      },
    });
  },
};

/** The text the prompt holds of an entry: the message that is the entry, or the part of a block a preset's macro put it in; the entry's own where the request shows neither. */
function heldText(held: HeldDetail, messages: readonly RequestMessage[]): string {
  const own = held.message === null ? undefined : messages[held.message - 1];
  if (own) return messageText(own);
  const block = held.inline ? messages[held.inline.at] : undefined;
  if (block && held.inline) return messageText(block).slice(held.inline.start, held.inline.end);
  return held.doc?.entry.content ?? "";
}

const activeLore: ToolDefinition = {
  name: TOOL.activeLore,
  family: FAMILY.lore,
  tier: "read",
  build(env: ToolEnv) {
    // What a prompt holds is a generation's: a job's run and a side session's turn answer none.
    const { texts, turn } = env;
    if (env.run.chatId === "" || !turn) return null;
    const { lineChars, excerptChars } = env.settings.tools;
    const p = pagerOf(env, TOOL.activeLore);
    return toolOf(p, {
      name: TOOL.activeLore,
      description: texts.render(TEXT.tool(TOOL.activeLore)),
      parameters: { type: "object", properties: { cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.activeLore, "cursor")) } } },
      async answer(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const lore = await recallOf(env).held();
        const entries = lore?.entries ?? [];
        // Those Lumiverse activated whose text the request doesn't show are named apart, in one line with the first page: the writer doesn't have them.
        const unseen = lore?.unseen ?? [];
        const apart = unseen.length > 0 && cursor.at === 0 ? clip(texts.render(A.activeUnseen, { entries: unseen.map((entry) => `[${shownId(entry)}] ${entry.title}`).join(", ") }), lineChars) : "";
        if (entries.length === 0) return { text: apart || texts.render(A.activeNone) };
        return listPage(p, {
          total: entries.length,
          noun: ENTRY,
          cursor,
          ...(apart === "" ? {} : { lead: apart }),
          item: (i) => {
            const held = entries[i];
            if (!held) return "";
            // An entry of a book the tools read goes by the id they show and its book's name; one from elsewhere by what Lumiverse gave.
            const book = held.doc?.book.name ?? held.bookId ?? texts.render(TEXT.recall.none);
            return texts.render(A.activeEntry, { id: shownId(held), title: clip(held.title, lineChars), book: clip(book, lineChars), chars: String(held.chars), excerpt: clip(heldText(held, turn.messages).replace(/\s+/g, " ").trim(), excerptChars) });
          },
        });
      },
    });
  },
};

export const LORE_TOOLS: readonly ToolDefinition[] = [loreIndex, loreSearch, loreGrep, loreRead, loreRelated, loreAbout, activeLore];
