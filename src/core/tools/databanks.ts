// The databank tools (DESIGN §24.4): databank_list, databank_search and databank_read, over the
// user's databanks that apply to the chat, as the host's databanks port gives them. None is offered
// where the host has no such port, where the run has no chat, or where no databank applies to it.
//
// A search needs the documents' text, which Lumiverse keeps: the index of it is kept for the host
// between runs (§24.6), one for each chat worked on last, and each call brings it up to date from
// the list of documents. A document's text is read once for each version it has; a document that is
// gone leaves the index; and the documents are read in the list's order until Documents read in is
// reached, with the rest named in the answer as not searched.
//
// What the port answers is outside data: its shape is checked before a word of it is used.

import { bestLines, LexicalIndex, queryTerms } from "../lexical";
import type { JsonObject } from "../ports";
import { isRecord } from "../ports";
import { hitLines, lineRoom, namedArgs, type QueryPart, restNote, searchAnswer } from "../recall/answers";
import type { DatabanksPort } from "../recall/ports";
import { recallOf } from "../recall/recall";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, errorText, textArg } from "../util";
import { badCursor, listPage, needs, type Pager, pagerOf, readCursor, saidBack, textPage } from "./paging";

const A = TEXT.recall.answer;
const W = TEXT.recall.word;

/** A databank as the port gave it, read; `scope` is whatever the host says it applies to. */
interface Bank {
  id: string;
  name: string;
  description: string;
  scope: string;
  /** How many of its documents the list holds. */
  listed: number;
}

/** A document as the port gave it, read, with its databank. `version` empty: the host named none, so its text can't be told unchanged. */
interface Doc {
  id: string;
  name: string;
  version: string;
  bytes: number | null;
  status: string;
  bank: Bank;
  /** Its databank's place among the chat's. */
  bankAt: number;
}

/** The chat's databanks and their documents: each databank's documents together, in the order the port lists them, each document once. */
interface Catalogue {
  banks: Bank[];
  docs: Doc[];
}

/** A text of the databanks on one line, `max` characters at most. */
const flat = (text: string, max: number): string => clip(text.replace(/\s+/g, " ").trim(), max);

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** Reads the databanks that apply to the chat, then each one's documents. */
async function catalogueOf(port: DatabanksPort, chatId: string): Promise<Catalogue> {
  const listed: unknown = await port.list(chatId);
  const banks = (Array.isArray(listed) ? listed : []).flatMap((raw: unknown): Bank[] => (isRecord(raw) && typeof raw.id === "string" && raw.id !== "" ? [{ id: raw.id, name: textOf(raw.name), description: textOf(raw.description), scope: textOf(raw.scope), listed: 0 }] : []));
  const lists: unknown[] = await Promise.all(banks.map((bank) => port.documents(bank.id)));
  const docs: Doc[] = [];
  const seen = new Set<string>();
  banks.forEach((bank, bankAt) => {
    const list = lists[bankAt];
    for (const raw of Array.isArray(list) ? (list as unknown[]) : []) {
      if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "" || seen.has(raw.id)) continue;
      seen.add(raw.id);
      bank.listed++;
      docs.push({
        id: raw.id,
        name: textOf(raw.name),
        version: typeof raw.version === "string" ? raw.version : typeof raw.version === "number" ? String(raw.version) : "",
        bytes: typeof raw.bytes === "number" && Number.isFinite(raw.bytes) && raw.bytes >= 0 ? raw.bytes : null,
        status: textOf(raw.status),
        bank,
        bankAt,
      });
    }
  });
  return { banks, docs };
}

/** What a databank tool is built over: the port, the run's chat, and how the tool pages. */
interface Reach {
  port: DatabanksPort;
  chatId: string;
  p: Pager;
}

/** The databanks where a tool may rest on them; null where the host has none, the run has no chat, or no databank applies to the chat. */
function reachOf(env: ToolEnv, tool: string): Reach | null {
  const port = env.host.recall?.databanks;
  if (!port || env.run.chatId === "" || recallOf(env).available?.databanks === false) return null;
  return { port, chatId: env.run.chatId, p: pagerOf(env, tool) };
}

/**
 * What a call reads from the databanks, or the tool's error where the port failed: what failed,
 * and what doesn't rest on them. A call the run's end overtook throws on: the loop says why it ended.
 */
async function ask<T>(reach: Reach, ctx: ToolCtx, read: () => Promise<T>): Promise<{ got: T } | ToolOutcome> {
  try {
    return { got: await read() };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { text: saidBack(reach.p, errorText(error), (why) => reach.p.texts.render(A.databankFailed, { error: why })), error: true };
  }
}

/** A document's id and name, as the answers write a document. */
function named(env: ToolEnv, doc: Doc): { id: string; name: string } {
  const { lineChars } = env.settings.tools;
  return { id: clip(doc.id, lineChars), name: flat(doc.name, lineChars) || env.texts.render(TEXT.recall.none) };
}

// ---------------------------------------------------------------- databank_list

/** A size in bytes as a listing writes it, in the unit that keeps it short. The units are 1024 apart: what a byte count is read in, not a limit. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const databankList: ToolDefinition = {
  name: TOOL.databankList,
  family: FAMILY.databanks,
  tier: "read",
  build(env: ToolEnv) {
    const reach = reachOf(env, TOOL.databankList);
    if (!reach) return null;
    const { texts } = env;
    const { port, chatId, p } = reach;
    const { lineChars } = env.settings.tools;
    const heading = (bank: Bank): string =>
      texts.render(A.databank, {
        name: flat(bank.name, lineChars),
        id: clip(bank.id, lineChars),
        scope: flat(bank.scope, lineChars) || texts.render(TEXT.recall.none),
        count: texts.counted(bank.listed, W.document),
        description: bank.description.trim() === "" ? "" : ` — ${flat(bank.description, lineChars)}`,
      });
    return {
      name: TOOL.databankList,
      description: texts.render(TEXT.tool(TOOL.databankList)),
      parameters: { type: "object", properties: { cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.databankList, "cursor")) } } },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const read = await ask(reach, ctx, () => catalogueOf(port, chatId));
        if ("text" in read) return read;
        const { banks, docs } = read.got;
        if (banks.length === 0) return { text: texts.render(A.databankNone) };
        // Databanks without a document have no line to hang a heading on: they are listed alone.
        if (docs.length === 0) return { text: clip(banks.map(heading).join("\n"), p.pageChars) };
        return listPage(p, {
          total: docs.length,
          noun: W.document,
          cursor,
          item: (i, first) => {
            const doc = docs[i];
            if (!doc) return "";
            // A databank's heading leads its first document, and the first document of a page; an empty databank's stands where the list passes it.
            const after = docs[i - 1]?.bankAt ?? -1;
            const above = banks.slice(Math.min(after + 1, doc.bankAt), doc.bankAt + (after < doc.bankAt || first ? 1 : 0));
            const below = i === docs.length - 1 ? banks.slice(doc.bankAt + 1) : [];
            const line = texts.render(A.databankDoc, { ...named(env, doc), size: doc.bytes === null ? "" : ` · ${sizeText(doc.bytes)}`, status: doc.status === "ready" ? "" : ` [${flat(doc.status, lineChars) || texts.render(TEXT.recall.none)}]` });
            return [...above.map(heading), line, ...below.map(heading)].join("\n");
          },
        });
      },
    };
  },
};

// ---------------------------------------------------------------- databank_search

/** A document as the index knows it: the version read, its name as indexed, its length, and its text while it is in the index (null: it was read and is past Documents read in). */
interface Read {
  version: string;
  name: string;
  chars: number;
  text: string | null;
}

/** A chat's documents as they were last read: the index of their text by document id, with each document's name as a head, and what was read of each. */
interface Shelf {
  size: number;
  index: LexicalIndex<string>;
  read: Map<string, Read>;
  /** The update under way: a call waits for the one before it, so two calls of one round read no document twice. */
  busy: Promise<unknown>;
}

/** Each host's shelves by chat, the chat worked on last at the end: kept as long as the host is. */
const SHELVES = new WeakMap<object, Map<string, Shelf>>();

/** The chat's shelf, made on first ask, and anew where Search piece changed. As many chats' are kept as Settings keep chat indexes; the one unused longest goes first. */
function shelfOf(env: ToolEnv): Shelf {
  let shelves = SHELVES.get(env.host);
  if (!shelves) SHELVES.set(env.host, (shelves = new Map()));
  const { pieceChars } = env.settings.tools;
  let shelf = shelves.get(env.run.chatId);
  shelves.delete(env.run.chatId);
  if (!shelf || shelf.size !== pieceChars) shelf = { size: pieceChars, index: new LexicalIndex<string>(pieceChars, 1), read: new Map(), busy: Promise.resolve() };
  shelves.set(env.run.chatId, shelf);
  const most = Math.max(1, env.settings.recall.chat.kept);
  for (const id of shelves.keys()) {
    if (shelves.size <= most) break;
    shelves.delete(id);
  }
  return shelf;
}

/**
 * Brings a shelf up to date with the chat's documents and gives those it doesn't hold: the ones
 * Lumiverse hasn't finished reading, the ones without text, and, from the first whose text would
 * pass `most` characters on, every one after it in the list's order. Only a document that is new,
 * or whose version changed, is read from the host.
 */
async function update(shelf: Shelf, port: DatabanksPort, docs: readonly Doc[], most: number): Promise<Doc[]> {
  const listed = new Set(docs.map((doc) => doc.id));
  for (const id of [...shelf.read.keys()]) {
    if (listed.has(id)) continue;
    shelf.index.remove(id);
    shelf.read.delete(id);
  }
  const unread: Doc[] = [];
  let used = 0;
  // Once a document doesn't fit, none after it is read: which documents are searched follows the list's order alone.
  let full = false;
  for (const doc of docs) {
    const known = shelf.read.get(doc.id);
    // A document with no version can't be told unchanged: it is read at every call.
    const same = known !== undefined && doc.version !== "" && known.version === doc.version;
    if (doc.status !== "ready" || (full && !same)) {
      shelf.index.remove(doc.id);
      shelf.read.delete(doc.id);
      unread.push(doc);
      continue;
    }
    if (same) {
      // Its length is known from when it was read: past the limit, it isn't read again to learn that.
      if (full || used + known.chars > most) {
        shelf.index.remove(doc.id);
        known.text = null;
        full = true;
        unread.push(doc);
        continue;
      }
      if (known.text !== null) {
        if (known.name !== doc.name) shelf.index.add(doc.id, known.text, [doc.name]);
        known.name = doc.name;
        used += known.chars;
        continue;
      }
      // It was past the limit and fits now (documents before it went, or shrank): it is read again.
    }
    const text: unknown = await port.content(doc.id);
    if (typeof text !== "string") {
      shelf.index.remove(doc.id);
      shelf.read.delete(doc.id);
      unread.push(doc);
      continue;
    }
    const fits = used + text.length <= most;
    if (fits) shelf.index.add(doc.id, text, [doc.name]);
    else shelf.index.remove(doc.id);
    shelf.read.set(doc.id, { version: doc.version, name: doc.name, chars: text.length, text: fits ? text : null });
    if (fits) used += text.length;
    else {
      full = true;
      unread.push(doc);
    }
  }
  return unread;
}

const databankSearch: ToolDefinition = {
  name: TOOL.databankSearch,
  family: FAMILY.databanks,
  tier: "read",
  build(env: ToolEnv) {
    const reach = reachOf(env, TOOL.databankSearch);
    if (!reach) return null;
    const { texts } = env;
    const { port, chatId, p } = reach;
    const { excerptChars, lineChars } = env.settings.tools;
    const { chat, lore, databanks } = env.settings.recall;
    return {
      name: TOOL.databankSearch,
      description: texts.render(TEXT.tool(TOOL.databankSearch)),
      parameters: {
        type: "object",
        properties: { queries: { type: "array", items: { type: "string" }, description: texts.render(TEXT.toolArg(TOOL.databankSearch, "queries")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.databankSearch, "cursor")) } },
        required: ["queries"],
      },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const { named: queries, rest } = namedArgs(args, "queries", "query", chat.queries);
        if (queries.length === 0) return needs(p, "queries");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const shelf = shelfOf(env);
        const read = await ask(reach, ctx, () => {
          const turn = shelf.busy.then(async () => {
            const catalogue = await catalogueOf(port, chatId);
            return { catalogue, unread: await update(shelf, port, catalogue.docs, databanks.indexChars) };
          });
          // A failed update is this call's to report: the next call starts from what the shelf holds.
          shelf.busy = turn.catch(() => undefined);
          return turn;
        });
        if ("text" in read) return read;
        const { catalogue, unread } = read.got;
        if (catalogue.banks.length === 0) return { text: texts.render(A.databankNone) };
        const byId = new Map(catalogue.docs.map((doc) => [doc.id, doc]));
        const parts = queries.map((query): QueryPart => {
          const terms = queryTerms(query);
          // A document's name says what it is about, as an entry's title does: it weighs as a title does. Its best lines are as many as a lore hit's.
          const hits = shelf.index.search(query, { weights: [lore.titleWeight] }).filter((hit) => byId.has(hit.key) && typeof shelf.read.get(hit.key)?.text === "string");
          return {
            query,
            total: hits.length,
            head: (from, to) => saidBack(p, query, (said) => texts.render(A.queryHead, { query: said, total: texts.counted(hits.length, W.document), from: String(from), to: String(to) })),
            item: (i) => {
              const hit = hits[i];
              const doc = hit ? byId.get(hit.key) : undefined;
              const held = hit ? shelf.read.get(hit.key) : undefined;
              if (!doc || !held || held.text === null) return "";
              return texts.render(A.databankHit, { ...named(env, doc), bank: flat(doc.bank.name, lineChars), chars: String(held.chars), lines: hitLines(texts, bestLines(held.text, terms, lore.lines, lineRoom(excerptChars, lore.lines))) });
            },
            nothing: saidBack(p, query, (said) => texts.render(A.databankNothing, { query: said })),
          };
        });
        const notSearched = (documents: string): string => texts.render(A.databankUnread, { documents });
        const unreadNote =
          unread.length === 0
            ? ""
            : notSearched(
                clip(
                  unread
                    .map((doc) => {
                      const { id, name } = named(env, doc);
                      return `[${id}] ${name}`;
                    })
                    .join("; "),
                  Math.max(1, Math.min(lineChars, p.pageChars - notSearched("").length)),
                ),
              );
        return searchAnswer(p, args, parts, [restNote(p, Math.max(1, chat.queries), rest), unreadNote]);
      },
    };
  },
};

// ---------------------------------------------------------------- databank_read

const databankRead: ToolDefinition = {
  name: TOOL.databankRead,
  family: FAMILY.databanks,
  tier: "read",
  build(env: ToolEnv) {
    const reach = reachOf(env, TOOL.databankRead);
    if (!reach) return null;
    const { texts } = env;
    const { port, chatId, p } = reach;
    const { lineChars } = env.settings.tools;
    // The document read last, so the pages of a long one are one read of its text.
    let last: { id: string; version: string; text: string } | null = null;
    return {
      name: TOOL.databankRead,
      description: texts.render(TEXT.tool(TOOL.databankRead)),
      parameters: { type: "object", properties: { id: { type: "string", description: texts.render(TEXT.toolArg(TOOL.databankRead, "id")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.databankRead, "cursor")) } }, required: ["id"] },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const given = textArg(args.id);
        if (given === null) return needs(p, "id");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        if (cursor.within !== 0) return badCursor(p, args.cursor);
        const read = await ask(reach, ctx, async () => {
          const { banks, docs } = await catalogueOf(port, chatId);
          // A model may copy the id with its brackets; a start of an id names the document where no other shares it.
          const id = given.replace(/^\[|\]$/g, "").trim();
          const starts = id === "" ? [] : docs.filter((one) => one.id.startsWith(id));
          const doc = docs.find((one) => one.id === id) ?? (starts.length === 1 ? starts[0] : undefined);
          if (!doc || doc.status !== "ready") return { banks, doc, text: null };
          const kept = SHELVES.get(env.host)?.get(chatId)?.read.get(doc.id);
          if (doc.version !== "" && kept?.version === doc.version && kept.text !== null) return { banks, doc, text: kept.text };
          if (doc.version !== "" && last?.id === doc.id && last.version === doc.version) return { banks, doc, text: last.text };
          const text: unknown = await port.content(doc.id);
          if (typeof text !== "string") return { banks, doc, text: null };
          last = { id: doc.id, version: doc.version, text };
          return { banks, doc, text };
        });
        if ("text" in read) return read;
        const { banks, doc, text } = read.got;
        if (banks.length === 0) return { text: texts.render(A.databankNone), error: true };
        if (!doc) return { text: saidBack(p, given, (id) => texts.render(A.databankNoDoc, { id })), error: true };
        const { id, name } = named(env, doc);
        if (text === null) return { text: texts.render(A.databankNotReady, { name, status: flat(doc.status, lineChars) || texts.render(TEXT.recall.none) }), error: true };
        return textPage(p, {
          text,
          from: cursor.at,
          given: cursor.given,
          frame: (part) => texts.render(A.databankRead, { id, name, bank: flat(doc.bank.name, lineChars), from: String(part.from), to: String(part.to), chars: String(text.length), text: part.text }),
        });
      },
    };
  },
};

export const DATABANK_TOOLS: readonly ToolDefinition[] = [databankList, databankSearch, databankRead];
