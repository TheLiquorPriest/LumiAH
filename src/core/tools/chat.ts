// The history tools (DESIGN §24.4): the chat from coarse to exact. chat_outline is the story as a
// table of contents, chat_about the trail of a name through it, chat_search and chat_grep find by
// words and by exact text, chat_read and chat_around give the messages themselves. Each reads the
// chat as the run's own path has it (`RecallRun.chat`): every message before the reply that counts
// as the story, those the request doesn't hold among them. A message is named by its number in the
// chat, as the request names it, and every message an answer prints carries its citation
// (`[#412 a3f9c27e]`), which an agent copies into the chronicle and `chronicle_check` reads back
// (§24.7). A message the story leaves out is never listed, found or read: an answer whose span holds
// some says in one line how many and why, so their numbers aren't taken for gaps.

import { bestLines, queryTerms } from "../lexical";
import type { JsonObject } from "../ports";
import { grepBound, grepTexts, hitLines, lateAnswer, lineMatch, lineRoom, namedArgs, type QueryPart, readAnswer, type ReadItem, restNote, searchAnswer, spanText, whenText } from "../recall/answers";
import { type ChatDoc, type ChatRun, citeDoc, speakersOf, whoOf } from "../recall/chat";
import { type ChatFound, type ChatStretch, searchChat } from "../recall/chat-search";
import { checkCitation, namedMessage, placesOf } from "../recall/cite";
import { outlineHead, outlineOf, partLine, readerStretches, stretchesHead, stretchLine } from "../recall/outline";
import { type RecallRun, recallOf } from "../recall/recall";
import { type TrailLine, trailOf } from "../recall/trail";
import type { LeftOutWhy } from "../story";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { AgentTool, ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, textArg, wholeArg } from "../util";
import { around, fitted, listPage, needs, type Pager, pagerOf, readCursor, saidBack } from "./paging";

const A = TEXT.recall.answer;
const WORD = TEXT.recall.word;

/** The run's chat as a tool reads it: its messages, and the first and the last of them. */
interface Chat {
  run: RecallRun;
  chat: ChatRun;
  first: ChatDoc;
  last: ChatDoc;
}

/**
 * The line an answer says how many messages with numbers from `from` to `to` the story leaves out,
 * and why; "" where it leaves out none.
 */
function leftNote(texts: Pager["texts"], chat: ChatRun, from: number, to: number): string {
  const count = chat.leftIn(from, to);
  const parts = [...(count.hidden > 0 ? [texts.render(A.chatLeftHidden, { count: texts.counted(count.hidden, WORD.message) })] : []), ...(count.direction > 0 ? [texts.render(A.chatLeftDirections, { count: texts.counted(count.direction, WORD.message) })] : [])];
  return parts.length === 0 ? "" : texts.render(A.chatLeftOut, { parts: parts.join(", and ") });
}

/** The answer to a message the story leaves out, named alone: why it isn't read. */
function leftOne(p: Pager, index: number, why: LeftOutWhy): ToolOutcome {
  const { texts } = p;
  return { text: texts.render(A.chatLeftOne, { index: String(index), why: texts.render(why === "hidden" ? A.chatLeftOneHidden : A.chatLeftOneDirection) }), error: true };
}

/** The chat a tool is called on, or the answer for a chat with no message of the story yet. */
async function chatOf(env: ToolEnv): Promise<Chat | ToolOutcome> {
  const run = recallOf(env);
  const chat = await run.chat();
  const { first, last } = chat;
  if (first && last) return { run, chat, first, last };
  const left = leftNote(env.texts, chat, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  return { text: left === "" ? env.texts.render(A.chatEmpty) : env.texts.render(A.chatNoStory, { left }) };
}

/** A history tool before the run holds it: what it is offered as, and how it answers a call. */
interface Offered extends Pick<AgentTool, "name" | "description" | "parameters"> {
  answer(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome>;
}

/**
 * A tool as the run holds it. Every part of an answer is fitted to the page where it is made; this
 * holds the whole to Answer length as well, for Settings that leave a page too short for its own
 * heading.
 */
function held(p: Pager, { answer, ...offered }: Offered): AgentTool {
  return {
    ...offered,
    run: async (args, ctx) => {
      const said = await answer(args, ctx);
      return said.text.length <= p.pageChars ? said : { ...said, text: clip(said.text, p.pageChars) };
    },
  };
}

/** The answer to a message argument that is neither a number nor a citation. */
function notNamed(p: Pager, value: unknown): ToolOutcome {
  return { text: saidBack(p, typeof value === "string" ? value : (JSON.stringify(value) ?? ""), (said) => p.texts.render(A.chatNotNamed, { given: said })), error: true };
}

const given = (value: unknown): boolean => value !== undefined && value !== null && value !== "";

// ---------------------------------------------------------------- the filters search, grep, about and outline share

/** The messages a call's `from`, `to` and `speaker` leave. */
interface Scope {
  /** Those messages, oldest first. */
  docs: readonly ChatDoc[];
  /** Whether a message is one of them; absent where the call narrows nothing. */
  keep?: (doc: ChatDoc) => boolean;
  /** The places of the range among the run's messages, from `start` up to `end`, whoever speaks. */
  start: number;
  end: number;
  /** The call gave `from` or `to`. */
  ranged: boolean;
  /** How many messages of the range the story leaves out, and why, as the answer says it; "" for none. */
  left: string;
}

/**
 * A call's filters, read: `from` and `to` are message numbers, both inside the range (a citation
 * names its number); `speaker` is a name as the chat shows it, in any letter case, or a role. A
 * range that holds no message and a speaker nobody goes by are answered with what there is, and
 * with what the story leaves out there.
 */
function scopeOf(p: Pager, { chat, first, last }: Chat, args: JsonObject, speakers: boolean): Scope | ToolOutcome {
  const { texts } = p;
  const bounds: (number | null)[] = [];
  for (const value of [args.from, args.to]) {
    const named = given(value) ? namedMessage(value) : null;
    if (given(value) && !named) return notNamed(p, value);
    bounds.push(named?.index ?? null);
  }
  const [from = null, to = null] = bounds;
  let low = from ?? first.index;
  let high = to ?? last.index;
  // Both given the wrong way round still name one range; a lone bound past the chat's end names none.
  if (from !== null && to !== null && low > high) [low, high] = [high, low];
  const ranged = from !== null || to !== null;
  const left = ranged ? leftNote(texts, chat, low, high) : leftNote(texts, chat, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  const start = chat.place(low);
  const end = chat.place(high + 1);
  if (start >= end) return { text: [left, texts.render(A.chatBadRange, { from: String(low), to: String(high), first: String(first.index), last: String(last.index) })].filter((part) => part !== "").join("\n"), error: true };
  const inRange = ranged ? chat.messages.slice(start, end) : chat.messages;
  const speaker = speakers ? textArg(args.speaker) : null;
  if (speaker === null) return { docs: inRange, ...(ranged ? { keep: (doc: ChatDoc) => doc.index >= low && doc.index <= high } : {}), start, end, ranged, left };
  const wanted = speaker.toLowerCase();
  const spoken = (doc: ChatDoc): boolean => doc.role === wanted || whoOf(doc).trim().toLowerCase() === wanted;
  if (!chat.messages.some(spoken)) {
    const all = speakersOf(chat.messages).map(([who, count]) => `${who} (${texts.counted(count, WORD.message)})`);
    const whole = leftNote(texts, chat, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
    const said = fitted(p, all.join(", "), (list) => saidBack(p, speaker, (named) => texts.render(A.chatNoSpeaker, { speaker: named, speakers: list })));
    return { text: [whole, said].filter((part) => part !== "").join("\n"), error: true };
  }
  return { docs: inRange.filter(spoken), keep: (doc) => doc.index >= low && doc.index <= high && spoken(doc), start, end, ranged, left };
}

// ---------------------------------------------------------------- reading messages

/**
 * The message an argument names (`namedMessage`), by its number, with what an answer says first
 * where it was named by a citation that doesn't hold as written. A citation is checked against the
 * chat as it stands (`checkCitation`), and the answer says what was compared, never what may have
 * happened to the chat: the message at its number reads otherwise (it is read all the same, and the
 * answer says so); only its number is wrong, since exactly one other message reads as cited (that
 * one is read); or the chat has no message at its number and no single message reads as cited.
 * Where several messages read as cited none of them is taken for the one meant. A message the story
 * leaves out is never read: named alone, the answer says why; as a bound of a range (`bound`), the
 * range runs over it.
 */
function located({ chat, first, last }: Chat, p: Pager, named: { index: number; hash: string | null }, bound = false): { index: number; note: string } | ToolOutcome {
  const { texts } = p;
  const span = { first: String(first.index), last: String(last.index) };
  const index = String(named.index);
  /** A number that names no message of the story: one it leaves out, or none at all. */
  const elsewhere = (number: number): { index: number; note: string } | ToolOutcome => {
    const why = chat.leftAt(number);
    if (why === undefined) return { text: texts.render(A.chatNoMessage, { index: String(number), ...span }), error: true };
    return bound ? { index: number, note: "" } : leftOne(p, number, why);
  };
  if (named.hash === null) return chat.at(named.index) ? { index: named.index, note: "" } : elsewhere(named.index);
  const hashes = chat.hashes();
  const state = checkCitation({ index: named.index, hash: named.hash }, hashes, placesOf(hashes));
  // The citation as it is said back: written as the tools write one, whatever space or length of hash the call gave it.
  const cited = citeDoc({ index: named.index, hash: named.hash });
  const where = state.state === "ok" || state.state === "moved" ? "" : state.several.length === 0 ? texts.render(A.chronicleNowhere) : texts.render(A.chronicleSeveral, { messages: clip(state.several.map((n) => texts.render(TEXT.recall.message, { index: String(n) })).join(", "), p.lineChars) });
  if (state.state === "gone") return { text: texts.render(A.chatCiteGone, { given: cited, index, where, ...span }), error: true };
  const target = state.state === "moved" ? state.now : named.index;
  const doc = chat.at(target);
  if (!doc) return elsewhere(target);
  if (state.state === "ok") return { index: target, note: "" };
  if (state.state === "moved") return { index: target, note: texts.render(A.chatCiteMoved, { given: cited, index, now: String(target), cite: citeDoc(doc) }) };
  return { index: target, note: texts.render(A.chatCiteChanged, { given: cited, index, where, cite: citeDoc(doc) }) };
}

/** Messages read whole, a page at a time, each under its citation, who wrote it and when. `notes` lead the answer: what became of a citation the call named, and what the story leaves out between the messages read. */
function readMessages(p: Pager, args: JsonObject, docs: readonly ChatDoc[], notes: readonly string[]): ToolOutcome {
  const { texts } = p;
  const head = texts.render(A.chatRead, { from: String(docs[0]?.index ?? 0), to: String(docs.at(-1)?.index ?? 0), count: String(docs.length) });
  const items = docs.map(
    (doc): ReadItem => ({
      key: doc.index,
      text: doc.text,
      frame: (part) => texts.render(A.chatMessage, { cite: citeDoc(doc), index: String(doc.index), who: whoOf(doc), when: whenText(texts, doc.at), from: String(part.from), to: String(part.to), chars: String(doc.text.length), text: part.text }),
    }),
  );
  return readAnswer(p, args, items, [...new Set(notes.filter((note) => note !== "")), head].join("\n"));
}

const chatRead: ToolDefinition = {
  name: TOOL.chatRead,
  family: FAMILY.chat,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatRead);
    const arg = (name: string): string => texts.render(TEXT.toolArg(TOOL.chatRead, name));
    return held(p, {
      name: TOOL.chatRead,
      description: texts.render(TEXT.tool(TOOL.chatRead)),
      // A number or a citation: both are written as text, and a bare number is read as one.
      parameters: { type: "object", properties: { from: { type: "string", description: arg("from") }, to: { type: "string", description: arg("to") }, cursor: { type: "string", description: arg("cursor") } }, required: ["from"] },
      async answer(args: JsonObject): Promise<ToolOutcome> {
        const from = namedMessage(args.from);
        if (!from) return needs(p, "from");
        const to = given(args.to) ? namedMessage(args.to) : from;
        if (!to) return notNamed(p, args.to);
        const read = await chatOf(env);
        if ("text" in read) return read;
        // A range runs over what the story leaves out; one message named alone that it leaves out is answered with why.
        const ranged = to !== from;
        const a = located(read, p, from, ranged);
        if ("text" in a) return a;
        const b = ranged ? located(read, p, to, true) : a;
        if ("text" in b) return b;
        const { chat } = read;
        const low = Math.min(a.index, b.index);
        const high = Math.max(a.index, b.index);
        const docs = chat.messages.slice(chat.place(low), chat.place(high + 1));
        const left = leftNote(texts, chat, low, high);
        if (docs.length === 0) return { text: texts.render(A.chatAllLeftOut, { left, from: String(low), to: String(high) }) };
        return readMessages(p, args, docs, [a.note, b.note, left]);
      },
    });
  },
};

const chatAround: ToolDefinition = {
  name: TOOL.chatAround,
  family: FAMILY.chat,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatAround);
    const arg = (name: string): string => texts.render(TEXT.toolArg(TOOL.chatAround, name));
    return held(p, {
      name: TOOL.chatAround,
      description: texts.render(TEXT.tool(TOOL.chatAround)),
      parameters: {
        type: "object",
        properties: { message: { type: "string", description: arg("message") }, before: { type: "integer", description: arg("before") }, after: { type: "integer", description: arg("after") }, cursor: { type: "string", description: arg("cursor") } },
        required: ["message"],
      },
      async answer(args: JsonObject): Promise<ToolOutcome> {
        if (!given(args.message)) return needs(p, "message");
        const named = namedMessage(args.message);
        if (!named) return notNamed(p, args.message);
        const read = await chatOf(env);
        if ("text" in read) return read;
        const centre = located(read, p, named);
        if ("text" in centre) return centre;
        const { chat } = read;
        const each = env.settings.recall.chat.around;
        const place = chat.place(centre.index);
        const docs = chat.messages.slice(Math.max(0, place - Math.max(0, wholeArg(args.before) ?? each)), place + 1 + Math.max(0, wholeArg(args.after) ?? each));
        return readMessages(p, args, docs, [centre.note, leftNote(texts, chat, docs[0]?.index ?? centre.index, docs.at(-1)?.index ?? centre.index)]);
      },
    });
  },
};

// ---------------------------------------------------------------- finding

const chatGrep: ToolDefinition = {
  name: TOOL.chatGrep,
  family: FAMILY.chat,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatGrep);
    const arg = (name: string): string => texts.render(TEXT.toolArg(TOOL.chatGrep, name));
    return held(p, {
      name: TOOL.chatGrep,
      description: texts.render(TEXT.tool(TOOL.chatGrep)),
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: arg("text") },
          regex: { type: "boolean", description: arg("regex") },
          from: { type: "integer", description: arg("from") },
          to: { type: "integer", description: arg("to") },
          speaker: { type: "string", description: arg("speaker") },
          cursor: { type: "string", description: arg("cursor") },
        },
        required: ["text"],
      },
      async answer(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const needle = textArg(args.text);
        if (needle === null) return needs(p, "text");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const match = lineMatch(p, needle, args.regex === true || args.regex === "true", env.settings.recall.grep.pieceChars);
        if ("text" in match) return match;
        const read = await chatOf(env);
        if ("text" in read) return read;
        const scope = scopeOf(p, read, args, true);
        if ("text" in scope) return scope;
        const bodies = scope.docs.map((doc) => doc.text);
        // The search gives way as it goes and stops at its time (Settings), so no text and no pattern holds the turn.
        const bound = grepBound(env, ctx.signal);
        const found = await grepTexts(bodies, match, bound);
        if ("late" in found) return lateAnswer(p, bound, found, texts.counted(bodies.length, WORD.message));
        if (found.length === 0) return { text: [scope.left, saidBack(p, needle, (said) => texts.render(A.chatGrepNothing, { query: said }))].filter((part) => part !== "").join("\n") };
        return listPage(p, {
          total: found.length,
          noun: WORD.line,
          cursor,
          item: (i) => {
            const line = found[i];
            const doc = line ? scope.docs[line.key] : undefined;
            return line && doc ? texts.render(A.chatLine, { cite: citeDoc(doc), index: String(doc.index), who: whoOf(doc), line: String(line.line), text: around(line.text, line.at, line.length, p.lineChars) }) : "";
          },
          ...(scope.left !== "" ? { lead: scope.left } : {}),
        });
      },
    });
  },
};

/** Message numbers as an answer lists them: each run of neighbours as one span. */
function numbersText(p: Pager, docs: readonly ChatDoc[]): string {
  const runs: [number, number][] = [];
  for (const { index } of docs) {
    const run = runs.at(-1);
    if (run && index === run[1] + 1) run[1] = index;
    else runs.push([index, index]);
  }
  return clip(runs.map(([from, to]) => spanText(p.texts, from, to)).join(", "), p.lineChars);
}

/** One query's part of chat_search's answer: its stretches of the chat, the best first, each with its best hits under it. */
function searchPart(p: Pager, env: ToolEnv, found: ChatFound): QueryPart {
  const { texts, settings } = env;
  const lines = Math.max(1, settings.recall.chat.lines);
  const room = lineRoom(settings.tools.excerptChars, lines);
  const terms = queryTerms(found.query);
  const said = clip(found.query, p.lineChars);
  const stretchText = (stretch: ChatStretch): string => {
    const first = stretch.hits[0]?.doc;
    const last = stretch.hits.at(-1)?.doc;
    if (!first || !last) return "";
    const out = [texts.render(A.chatStretch, { span: spanText(texts, first.index, last.index), when: whenText(texts, first.at, last.at), hits: texts.counted(stretch.hits.length, WORD.hit) })];
    for (const { doc, by, similarity } of stretch.shown) {
      const best = bestLines(doc.text, terms, lines, room);
      // A hit the words found says nothing of how: its lines show the words. One found by its meaning alone holds none of them, so it says so.
      const why = by.includes("word") ? "" : ` · ${texts.render(A.byMeaning, { score: (similarity ?? 0).toFixed(2) })}`;
      out.push(texts.render(A.chatHit, { cite: citeDoc(doc), index: String(doc.index), who: whoOf(doc), chars: String(doc.text.length), why, lines: hitLines(texts, best), excerpt: best[0]?.text ?? "" }));
    }
    const rest = stretch.rest.map((hit) => hit.doc);
    if (rest.length > 0) out.push(texts.render(A.chatStretchMore, { count: String(rest.length), messages: numbersText(p, rest) }));
    return out.join("\n");
  };
  return {
    query: found.query,
    total: found.stretches.length,
    head: (from, to) => texts.render(A.chatSearchHead, { query: said, messages: texts.counted(found.messages, WORD.message), stretches: texts.counted(found.stretches.length, WORD.stretch), from: String(from), to: String(to) }),
    item: (i) => {
      const stretch = found.stretches[i];
      return stretch ? stretchText(stretch) : "";
    },
    nothing: saidBack(p, found.query, (query) => texts.render(A.chatSearchNothing, { query })),
  };
}

const chatSearch: ToolDefinition = {
  name: TOOL.chatSearch,
  family: FAMILY.chat,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatSearch);
    const arg = (name: string): string => texts.render(TEXT.toolArg(TOOL.chatSearch, name));
    return held(p, {
      name: TOOL.chatSearch,
      description: texts.render(TEXT.tool(TOOL.chatSearch)),
      parameters: {
        type: "object",
        properties: {
          queries: { type: "array", items: { type: "string" }, description: arg("queries") },
          from: { type: "integer", description: arg("from") },
          to: { type: "integer", description: arg("to") },
          speaker: { type: "string", description: arg("speaker") },
          cursor: { type: "string", description: arg("cursor") },
        },
        required: ["queries"],
      },
      async answer(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const limit = env.settings.recall.chat.queries;
        const { named: queries, rest } = namedArgs(args, "queries", "query", limit);
        if (queries.length === 0) return needs(p, "queries");
        const read = await chatOf(env);
        if ("text" in read) return read;
        const scope = scopeOf(p, read, args, true);
        if ("text" in scope) return scope;
        const { run, chat } = read;
        const searched = await searchChat(run, chat, queries, { ...(scope.keep ? { keep: scope.keep } : {}), signal: ctx.signal });
        const wordOnly = run.wordOnlyNote(searched.state);
        const parts = searched.queries.map((found) => searchPart(p, env, found));
        const answer = searchAnswer(p, args, parts, [restNote(p, Math.max(1, limit), rest), wordOnly, scope.left]);
        // That search is by word is said once a run: an answer that failed didn't say it, so the next one does.
        if (answer.error && wordOnly !== "") run.saidWordOnly = false;
        return answer;
      },
    });
  },
};

// ---------------------------------------------------------------- the trail of a name

/**
 * chat_about's answer for one name, within `room` characters. The trail's lines are as long as Line
 * length allows, and as many of them are shown as the room holds: several names share one page, and
 * each one's lines are then fewer, still spread over the whole span the name appears in. Where not
 * even one line between the first and the latest fits, the lines are narrowed instead.
 */
function aboutText(p: Pager, env: ToolEnv, chat: ChatRun, scope: Scope, name: string, room: number): string {
  const { texts, settings } = env;
  const { lineChars } = p;
  const most = Math.max(1, settings.recall.chat.trail);
  const trail = trailOf(scope.docs, name);
  const said = clip(name, lineChars);
  const line = (doc: ChatDoc, text: string): string => texts.render(A.trailLine, { cite: citeDoc(doc), who: whoOf(doc), when: whenText(texts, doc.at), text });
  const shown = (one: TrailLine, width: number): string => line(one.doc, around(one.text, one.at, trail.name.length, width));
  const [first] = trail.held;
  const latest = trail.held.at(-1);
  if (!first || !latest) {
    // Nothing as written: the messages that hold the name's words apart, the closest first, which is where a name written another way turns up.
    // As few of them as a search shows of one stretch: enough to see how the chat writes it, and chat_search finds the rest.
    const terms = queryTerms(name);
    const close = terms.length === 0 ? [] : chat.index.search(name, { keep: (id) => chat.has(id) && (scope.keep === undefined || scope.keep(chat.byId(id) as ChatDoc)) }).slice(0, Math.max(1, settings.recall.chat.stretchHits));
    const near = close.flatMap((hit) => {
      const doc = chat.byId(hit.key);
      return doc ? [line(doc, bestLines(doc.text, terms, 1, lineChars)[0]?.text ?? "")] : [];
    });
    const nothing = (lines: readonly string[]): string => texts.render(A.chatAboutNothing, { name: said, near: lines.length === 0 ? "" : texts.render(A.chatAboutNear, { lines: lines.join("\n") }) });
    let count = near.length;
    while (count > 0 && nothing(near.slice(0, count)).length > room) count--;
    return clip(nothing(near.slice(0, count)), room);
  }
  const mentions = texts.counted(trail.mentions, WORD.mention);
  if (first === latest) {
    const once = (width: number): string => texts.render(A.chatAboutOnce, { name: said, mentions, line: shown(trail.line(first), width) });
    return clip(once(Math.max(1, Math.min(lineChars, room - once(0).length))), room);
  }
  const whole = (between: number, width: number): string => {
    const lines = trail.between(between).map((one) => shown(one, width));
    return texts.render(A.chatAbout, {
      name: said,
      mentions,
      messages: texts.counted(trail.held.length, WORD.message),
      span: spanText(texts, first.index, latest.index),
      first: shown(trail.line(first), width),
      latest: shown(trail.line(latest), width),
      lines: lines.length === 0 ? texts.render(TEXT.recall.none) : lines.join("\n"),
    });
  };
  // The first and the latest are two of the lines Settings allow; the rest lie between them.
  const inner = Math.min(most - 2, trail.held.length - 2);
  for (let between = inner; between > 0; between--) {
    const text = whole(between, lineChars);
    if (text.length <= room) return text;
  }
  // Not even one line between them fits at Line length. A trail never says there is nothing between two mentions when there is: where there is, one line stays, and the lines are each as wide as their share of the room.
  const least = Math.max(0, Math.min(1, inner));
  return clip(whole(least, Math.max(1, Math.min(lineChars, Math.floor((room - whole(least, 0).length) / (2 + least))))), room);
}

const chatAbout: ToolDefinition = {
  name: TOOL.chatAbout,
  family: FAMILY.chat,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatAbout);
    const arg = (name: string): string => texts.render(TEXT.toolArg(TOOL.chatAbout, name));
    return held(p, {
      name: TOOL.chatAbout,
      description: texts.render(TEXT.tool(TOOL.chatAbout)),
      parameters: { type: "object", properties: { names: { type: "array", items: { type: "string" }, description: arg("names") }, from: { type: "integer", description: arg("from") }, to: { type: "integer", description: arg("to") } }, required: ["names"] },
      async answer(args: JsonObject): Promise<ToolOutcome> {
        const limit = env.settings.recall.chat.queries;
        const { named: names, rest } = namedArgs(args, "names", "name", limit);
        if (names.length === 0) return needs(p, "names");
        const read = await chatOf(env);
        if ("text" in read) return read;
        const scope = scopeOf(p, read, args, false);
        if ("text" in scope) return scope;
        const tail = [restNote(p, Math.max(1, limit), rest), scope.left].filter((note) => note !== "");
        // Each name's trail has an equal share of the page, less the line break that ends it.
        const share = Math.max(1, Math.floor((p.pageChars - tail.reduce((n, note) => n + note.length + 1, 0)) / names.length) - 1);
        return { text: [...names.map((name) => aboutText(p, env, read.chat, scope, name, share)), ...tail].join("\n") };
      },
    });
  },
};

// ---------------------------------------------------------------- the outline

const chatOutline: ToolDefinition = {
  name: TOOL.chatOutline,
  family: FAMILY.chat,
  tier: "read",
  build(env: ToolEnv) {
    if (env.run.chatId === "") return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatOutline);
    const arg = (name: string): string => texts.render(TEXT.toolArg(TOOL.chatOutline, name));
    return held(p, {
      name: TOOL.chatOutline,
      description: texts.render(TEXT.tool(TOOL.chatOutline)),
      parameters: { type: "object", properties: { from: { type: "integer", description: arg("from") }, to: { type: "integer", description: arg("to") }, stretches: { type: "boolean", description: arg("stretches") }, cursor: { type: "string", description: arg("cursor") } } },
      async answer(args: JsonObject): Promise<ToolOutcome> {
        const read = await chatOf(env);
        if ("text" in read) return read;
        const scope = scopeOf(p, read, args, false);
        if ("text" in scope) return scope;
        const { run, chat } = read;
        // A model may write the flag as text.
        if (args.stretches === true || args.stretches === "true") {
          const stretches = await readerStretches(run, chat, scope);
          const size = stretchesHead(texts, env.settings, stretches.length);
          // What the story leaves out of the range heads the cut with its size: the readers see it again in what they read.
          const top = scope.left === "" ? size : `${size}\n${scope.left}`;
          // The cut and nothing else: whoever asked for it hands each line on, and a note of what to call next would be read as one more.
          const cut: QueryPart = {
            query: "",
            total: stretches.length,
            head: () => top,
            item: (i) => {
              const stretch = stretches[i];
              return stretch ? stretchLine(texts, stretch) : "";
            },
            nothing: top,
          };
          return searchAnswer(p, args, [cut]);
        }
        const outline = await outlineOf(run, chat, { start: scope.start, end: scope.end, opened: scope.ranged });
        const head = outlineHead(texts, chat, outline);
        // One listing under its own heading, which says how many parts there are: it pages as one query's hits do (no query is said back), and what to call next closes every page.
        const listing: QueryPart = {
          query: "",
          total: outline.parts.length,
          head: () => head,
          item: (i) => {
            const part = outline.parts[i];
            return part ? partLine(texts, chat, part, env.settings) : "";
          },
          nothing: head,
        };
        return searchAnswer(p, args, [listing], [texts.render(outline.leaf ? A.outlineLeaf : A.outlineNext), scope.left]);
      },
    });
  },
};

export const CHAT_TOOLS: readonly ToolDefinition[] = [chatOutline, chatAbout, chatSearch, chatGrep, chatRead, chatAround];
