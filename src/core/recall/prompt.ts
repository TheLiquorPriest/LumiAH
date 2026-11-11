// What the prompt already holds (DESIGN §24.1): which lore entries Lumiverse put in the request and
// how each got there, which entries of the chat's books it left out, and which of the chat's
// messages the request holds word for word. All of it is worked out by code from the flags
// Lumiverse puts on the prompt's messages, the entries it says it activated, and the chat's path:
// nothing here asks a model.
//
// The main agent is given it as three notes with the request (`promptNotes`), so the common turn
// needs no lookup call to know what exists; the lore tools mark each entry with the same state.

import type { Book } from "../book";
import type { PathMessage, PresetBlock, RequestMessage } from "../ports";
import type { Settings } from "../settings";
import type { Texts } from "../texts";
import { RECALL_TEXT } from "../texts/recall";
import { clip, tokensOf } from "../util";
import { keysOf, type LoreCorpus, type LoreDoc } from "./lore";
import type { ActivatedEntry } from "./ports";
import type { HeldEntry, HeldWhy, HistoryStandIn, ListedEntry, PromptHeld } from "./shapes";

/** A message's text as a note or a match reads it: its text, or each text part's in order. */
export function messageText(m: RequestMessage): string {
  if (!m.parts) return m.content;
  return m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

/** An entry the prompt holds, with what the core knows of it beyond what the trace is told. */
export interface HeldDetail extends HeldEntry {
  /** The entry among those that apply; null for one of a book the tools don't read, and for a World Info message Lumiverse didn't name whose text is no entry's. */
  doc: LoreDoc | null;
  /** For an entry with no message of its own whose text stands inside one: that message, from 0, and where in its text. */
  inline: { at: number; start: number; end: number } | null;
}

/** The lore of one generation's prompt. */
export interface HeldLore {
  /** The entries whose text the request shows, in its order: those with a message of their own, then those inside a block. */
  entries: HeldDetail[];
  /** Those entries by their ids. An entry Lumiverse activated whose text the request doesn't show is not among them: the writer doesn't have it. */
  byId: ReadonlyMap<string, HeldDetail>;
  /** The entry each world-info message of the request is, by the message's place from 0. */
  byMessage: ReadonlyMap<number, HeldDetail>;
  /** The entries Lumiverse says it activated whose text no message of the request shows: listed apart, and the main agent's to add. */
  unseen: HeldDetail[];
}

/** The shortest text that is looked for inside another: a shorter one would be found by chance. Fixed, not a setting: it decides whether an entry's text is in a message, never how much is shown. */
const LEAST_INLINE = 24;

/**
 * How much of a World Info message's opening names it where Lumiverse didn't say which entry it is
 * and no entry has its text, in characters. Fixed, not a setting: it stands in for a title in the
 * note's one line, whose length is the setting (Lore in the prompt: length); a title is about as
 * long.
 */
const OPENING_CHARS = 60;

/**
 * Which lore the request holds, told only as far as Lumiverse says or the request itself shows:
 * - A message Lumiverse flagged as a World Info entry is the entry Lumiverse names for it. One it
 *   didn't name is an entry only where its text is exactly that entry's (the blanks around it
 *   aside): the text Lumiverse says it put in the prompt for an activated entry, else an entry's own.
 *   Any other is a World Info message of no known entry, and is told as that.
 * - How an entry got there is what Lumiverse says: by a key (which, only where Lumiverse names it),
 *   by a vector match, or not said; an entry its book always sends is told as that. Nothing is
 *   worked out from the chat's words.
 * - An activated entry without a message is looked for, by its exact text, inside the messages that
 *   are neither lore nor chat, where a preset's macro may have put it. One whose text the request
 *   shows nowhere is not in the prompt: it is kept apart (`unseen`).
 */
export function heldLore(input: { messages: readonly RequestMessage[]; activated: readonly ActivatedEntry[]; corpus: LoreCorpus; charsPerToken: number }): HeldLore {
  const { messages, corpus } = input;
  const texts = messages.map(messageText);
  const flagged = messages.flatMap((m, at) => (m.source?.kind === "lore" ? [{ at, text: (texts[at] ?? "").trim(), entryId: m.source.entryId }] : []));
  const open = new Map<string, { a: ActivatedEntry; doc: LoreDoc | null; text: string }>();
  for (const a of input.activated) {
    const doc = corpus.get(a.entryId) ?? null;
    if (!open.has(a.entryId)) open.set(a.entryId, { a, doc, text: (a.content ?? doc?.entry.content ?? "").trim() });
  }
  /** What each flagged message is: the entry's id (empty: none is known), the entry among those that apply, and what Lumiverse says of its activation. */
  const placed = new Map<number, { id: string; doc: LoreDoc | null; a: ActivatedEntry | null }>();
  const take = (at: number, entryId: string): void => {
    const known = open.get(entryId);
    placed.set(at, { id: entryId, doc: known?.doc ?? corpus.get(entryId) ?? null, a: known?.a ?? null });
    open.delete(entryId);
  };
  // Named by Lumiverse: it is that entry, whether or not the tools read its book.
  for (const f of flagged) if (f.entryId !== undefined && f.entryId !== "") take(f.at, f.entryId);
  // Not named: the activated entry with exactly this text, then the entry of the books with exactly this text. Each activated entry is taken once.
  const unnamed = flagged.filter((f) => !placed.has(f.at) && f.text !== "");
  for (const f of unnamed) {
    for (const [id, known] of open) {
      if (known.text !== f.text) continue;
      take(f.at, id);
      break;
    }
  }
  const left = unnamed.filter((f) => !placed.has(f.at));
  if (left.length > 0) {
    const byText = new Map<string, LoreDoc>();
    for (const doc of corpus.docs) byText.set(doc.entry.content.trim(), doc);
    for (const f of left) {
      const doc = byText.get(f.text);
      if (doc) placed.set(f.at, { id: doc.entry.id, doc, a: null });
    }
  }

  const why = (doc: LoreDoc | null, a: ActivatedEntry | null): HeldWhy => {
    if (doc?.entry.constant) return { by: "constant" };
    if (a?.how === "vector") return { by: "vector", score: a.score ?? null };
    if (a?.how === "key") return { by: "key", key: a.key ?? null };
    return { by: "unknown" };
  };
  const entry = (id: string, doc: LoreDoc | null, a: ActivatedEntry | null, shown: string, message: number | null, inline: HeldDetail["inline"]): HeldDetail => ({
    entryId: id,
    bookId: doc?.book.id ?? a?.bookId ?? null,
    // An entry of no book the tools read is named by what Lumiverse calls it, else by how its text opens.
    title: doc?.entry.title || a?.title || clip(shown.replace(/\s+/g, " ").trim(), OPENING_CHARS),
    chars: shown.length,
    tokens: tokensOf(shown, input.charsPerToken),
    why: why(doc, a),
    message,
    doc,
    inline,
  });

  const entries: HeldDetail[] = [];
  const byMessage = new Map<number, HeldDetail>();
  for (const f of flagged) {
    const at = placed.get(f.at);
    const held = entry(at?.id ?? "", at?.doc ?? null, at?.a ?? null, texts[f.at] ?? "", f.at + 1, null);
    entries.push(held);
    byMessage.set(f.at, held);
  }
  const inside: HeldDetail[] = [];
  const unseen: HeldDetail[] = [];
  for (const [id, known] of open) {
    const { text } = known;
    let inline: HeldDetail["inline"] = null;
    if (text.length >= LEAST_INLINE) {
      for (let at = 0; at < messages.length && inline === null; at++) {
        if (messages[at]?.source?.kind === "lore" || messages[at]?.source?.kind === "history") continue;
        const start = (texts[at] ?? "").indexOf(text);
        if (start >= 0) inline = { at, start, end: start + text.length };
      }
    }
    (inline ? inside : unseen).push(entry(id, known.doc, known.a, text, null, inline));
  }
  inside.sort((a, b) => (a.inline?.at ?? 0) - (b.inline?.at ?? 0) || (a.inline?.start ?? 0) - (b.inline?.start ?? 0));
  entries.push(...inside);
  const byId = new Map<string, HeldDetail>();
  for (const held of entries) if (held.entryId !== "" && !byId.has(held.entryId)) byId.set(held.entryId, held);
  return { entries, byId, byMessage, unseen };
}

/**
 * The entries of the chat's books the prompt doesn't hold, in the order the main agent is shown
 * them: those that match the chat's latest messages first, the best match leading, then the rest in
 * the books' order. Entries the user switched off are left out unless Settings list them, and so
 * are those Lumiverse activated whose text the request doesn't show: they are listed apart.
 */
export function unheldLore(input: { messages: readonly RequestMessage[]; corpus: LoreCorpus; held: HeldLore; settings: Readonly<Settings["recall"]> }): LoreDoc[] {
  const { corpus, held, settings } = input;
  const apart = new Set(held.unseen.map((entry) => entry.entryId));
  const listed = (doc: LoreDoc): boolean => !held.byId.has(doc.entry.id) && !apart.has(doc.entry.id) && (doc.entry.enabled || settings.prompt.indexOff);
  const chat = input.messages.filter((m) => m.source?.kind === "history");
  // A request with no message traced to the chat is still about its last messages.
  const recent = (chat.length > 0 ? chat : input.messages.filter((m) => m.role !== "system")).slice(-settings.prompt.recent).map(messageText).join("\n");
  const ranked = corpus.index.search(recent, {
    keep: (id) => {
      const doc = corpus.get(id);
      return doc !== undefined && listed(doc);
    },
    weights: [settings.lore.titleWeight, settings.lore.keyWeight],
  });
  const first = ranked.flatMap((hit) => corpus.get(hit.key) ?? []);
  const leading = new Set(first);
  return [...first, ...corpus.docs.filter((doc) => listed(doc) && !leading.has(doc))];
}

/** The runs a set of the path's messages makes, each from its first message's number to its last's. */
function runsOf(path: readonly PathMessage[], has: (m: PathMessage) => boolean): [number, number][] {
  const runs: [number, number][] = [];
  let open = false;
  for (const m of path) {
    if (!has(m)) {
      open = false;
      continue;
    }
    const last = runs.at(-1);
    if (open && last) last[1] = m.index;
    else runs.push([m.index, m.index]);
    open = true;
  }
  return runs;
}

/** What a block of the preset carries that stands in for chat messages, by what its marker or its text names; null for any other block. */
function standIn(block: PresetBlock): HistoryStandIn["kind"] | null {
  const said = `${block.marker ?? ""} ${block.content}`;
  if (/memor/i.test(said)) return "memories";
  return /summar/i.test(said) ? "summary" : null;
}

/**
 * Which of the chat's messages the request holds word for word, which it doesn't, and what stands
 * in the request for those: the chat's book where it has one, and each block of the preset that is
 * in the request and carries Lumiverse's summary or its memories.
 */
export function heldHistory(input: { messages: readonly RequestMessage[]; path: readonly PathMessage[]; blocks: readonly PresetBlock[]; book: Book | null }): PromptHeld["history"] {
  const ids = new Set<string>();
  const sent = new Set<string>();
  for (const m of input.messages) {
    if (m.source?.kind === "history") ids.add(m.source.messageId);
    if (m.source?.kind === "block") sent.add(m.source.blockId);
  }
  const stands: HistoryStandIn[] = input.book ? [{ kind: "book", name: "LumiBooks" }] : [];
  for (const block of input.blocks) {
    const kind = block.enabled && sent.has(block.id) ? standIn(block) : null;
    if (kind) stands.push({ kind, name: block.name });
  }
  return { held: runsOf(input.path, (m) => ids.has(m.id)), missing: runsOf(input.path, (m) => !ids.has(m.id)), stands };
}

// ---------------------------------------------------------------- the three notes

/** Lines one under the other while they fit `room` characters with the line that counts the rest (`more`): the lines kept (none where not even the first fits), and how many were left out. */
function fit(lines: readonly string[], room: number, more: (left: number) => string): { kept: string[]; left: number } {
  const kept: string[] = [];
  let used = 0;
  for (const [i, line] of lines.entries()) {
    const after = lines.length - i - 1;
    if (used + line.length + 1 + (after > 0 ? more(after).length + 1 : 0) > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  return { kept, left: lines.length - kept.length };
}

/** Runs of message numbers as the notes write them: "#3 to #40, #52". */
function runsText(runs: readonly (readonly [number, number])[], texts: Texts): string {
  return runs.map(([from, to]) => (from === to ? texts.render(RECALL_TEXT.prompt.message, { index: String(from) }) : texts.render(RECALL_TEXT.prompt.span, { from: String(from), to: String(to) }))).join(", ");
}

function whyText(why: HeldWhy, texts: Texts): string {
  if (why.by === "constant") return texts.render(RECALL_TEXT.prompt.whyConstant);
  if (why.by === "vector") return why.score === null ? texts.render(RECALL_TEXT.prompt.whyVector) : texts.render(RECALL_TEXT.prompt.whyVectorScore, { score: why.score.toFixed(2) });
  if (why.by === "key") return why.key === null ? texts.render(RECALL_TEXT.prompt.whyKeyUnknown) : texts.render(RECALL_TEXT.prompt.whyKey, { key: why.key });
  return texts.render(RECALL_TEXT.prompt.whyUnknown);
}

/** How an entry got into the prompt, in the words the notes and the lore tools use. */
export function heldWhyText(why: HeldWhy, texts: Texts): string {
  return whyText(why, texts);
}

/** The id an entry is shown by: its short id among the entries that apply, else the id Lumiverse gave. */
export function shownId(held: HeldDetail): string {
  return held.doc?.short ?? (held.entryId === "" ? "?" : held.entryId);
}

export interface PromptNotes {
  /** The notes, one under the other; empty when every one is switched off or has nothing to say. */
  text: string;
  held: PromptHeld;
  /** For each world-info message of the request, by its place from 0: what says which entry it is where the request's document names where a message came from. */
  fromLore: Map<number, string>;
}

/**
 * The three notes the main agent is given with the request, each within its size setting and left
 * out where Settings switch it off, and the same as plain data for the trace. `briefs`: the main
 * agent hands a writer a brief, so it may be told that `write_reply` adds entries.
 *
 * The first note says of each entry only what Lumiverse said of it or the request shows (`heldLore`).
 * The entries Lumiverse activated whose text the request doesn't show follow it, apart, within the
 * same length: the writer doesn't have them, and the main agent may add them.
 */
export function promptNotes(input: { messages: readonly RequestMessage[]; lore: HeldLore; corpus: LoreCorpus; path: readonly PathMessage[]; blocks: readonly PresetBlock[]; book: Book | null; settings: Readonly<Settings>; texts: Texts; briefs: boolean }): PromptNotes {
  const { lore, corpus, texts } = input;
  const settings = input.settings.recall;
  const { lineChars } = input.settings.tools;
  const P = RECALL_TEXT.prompt;
  const notes: string[] = [];
  const fromLore = new Map<number, string>();
  for (const [at, held] of lore.byMessage) fromLore.set(at, held.entryId === "" ? texts.render(P.fromUnnamed) : texts.render(P.from, { id: shownId(held), title: clip(held.title, lineChars) }));

  if (settings.prompt.lore) {
    const room = settings.prompt.loreChars;
    // The entries apart, in half the note's length at most: each on a line, with how to give the writer one.
    let apart = "";
    if (lore.unseen.length > 0) {
      const lines = lore.unseen.map((held) => texts.render(P.unseenLine, { id: shownId(held), title: clip(held.title, lineChars), chars: String(held.chars), why: whyText(held.why, texts) }));
      const more = (left: number): string => texts.render(P.unseenMore, { count: String(left) });
      const add = input.briefs && settings.writer.add ? texts.render(P.unseenAdd) : "";
      const head = (shown: string): string => texts.render(P.unseen, { count: texts.counted(lines.length, RECALL_TEXT.word.entry), add, entries: shown });
      const { kept, left } = fit(lines, Math.floor(room / 2) - head("").length, more);
      apart = clip(head([...kept, ...(left > 0 ? [more(left)] : [])].join("\n")), Math.floor(room / 2));
    }
    const own = room - (apart === "" ? 0 : apart.length + 1);
    const lines = lore.entries.map((held) => {
      const where = held.message !== null ? texts.render(P.whereMessage, { n: String(held.message) }) : texts.render(P.whereInside, { n: String((held.inline?.at ?? 0) + 1) });
      // A World Info message Lumiverse didn't name, whose text is no entry's: told as that, by how it opens.
      if (held.entryId === "") return texts.render(P.loreUnnamed, { opening: clip(held.title, lineChars), chars: String(held.chars), where });
      return texts.render(P.loreLine, { id: shownId(held), title: clip(held.title, lineChars), chars: String(held.chars), why: whyText(held.why, texts), where });
    });
    let said = "";
    if (lines.length > 0) {
      const more = (left: number): string => texts.render(P.loreMore, { count: String(left) });
      const head = (shown: string): string => texts.render(P.lore, { count: texts.counted(lines.length, RECALL_TEXT.word.entry), tokens: String(lore.entries.reduce((n, held) => n + held.tokens, 0)), entries: shown });
      const { kept, left } = fit(lines, own - head("").length, more);
      // The size is a cap whatever the texts are: a note longer than it even with no entry listed is clipped.
      said = clip(head([...kept, ...(left > 0 ? [more(left)] : [])].join("\n")), Math.max(1, own));
    }
    // A chat with no world book has no lore to speak of: saying so every turn would only cost. Where Lumiverse activated entries and the request shows none of them, that is what is said.
    else if (apart !== "") said = clip(texts.render(P.loreNoneShown), Math.max(1, own));
    else if (corpus.docs.length > 0) said = texts.render(P.loreNone);
    const note = [said, apart].filter((part) => part !== "").join("\n");
    if (note !== "") notes.push(note);
  }

  const unheld = unheldLore({ messages: input.messages, corpus, held: lore, settings });
  let listed: ListedEntry[] = [];
  let left = unheld.length;
  if (settings.prompt.index && unheld.length > 0) {
    const lines = unheld.map((doc) => texts.render(RECALL_TEXT.prompt.indexLine, { id: doc.short, title: clip(doc.entry.title, lineChars), keys: clip(keysOf(doc.entry).join(", ") || texts.render(RECALL_TEXT.none), lineChars), chars: String(doc.entry.content.length), off: doc.entry.enabled ? "" : texts.render(RECALL_TEXT.prompt.indexOff) }));
    const more = (rest: number): string => texts.render(RECALL_TEXT.prompt.indexMore, { count: String(rest) });
    const add = input.briefs && settings.writer.add ? texts.render(RECALL_TEXT.prompt.indexAdd) : "";
    const head = (shown: string): string => texts.render(RECALL_TEXT.prompt.index, { count: texts.counted(unheld.length, RECALL_TEXT.word.entry), add, entries: shown });
    const fitted = fit(lines, settings.prompt.indexChars - head("").length, more);
    left = fitted.left;
    listed = unheld.slice(0, fitted.kept.length).map((doc) => ({ entryId: doc.entry.id, bookId: doc.book.id, title: doc.entry.title, keys: keysOf(doc.entry), chars: doc.entry.content.length }));
    notes.push(clip(head([...fitted.kept, ...(left > 0 ? [more(left)] : [])].join("\n")), settings.prompt.indexChars));
  }

  const history = heldHistory(input);
  if (settings.prompt.history && input.path.length > 0) {
    const count = (runs: readonly (readonly [number, number])[]): number => input.path.filter((m) => runs.some(([from, to]) => m.index >= from && m.index <= to)).length;
    // Each list of runs gets half of what the note's own words leave, so neither is lost to the other.
    const said = (room: number): string => {
      if (history.held.length === 0) return texts.render(RECALL_TEXT.prompt.historyNone, { total: texts.counted(input.path.length, RECALL_TEXT.word.message) });
      const stands = history.stands.map((s) => texts.render(RECALL_TEXT.prompt.stand[s.kind], { name: s.name })).join(", ");
      return texts.render(RECALL_TEXT.prompt.history, {
        held: clip(runsText(history.held, texts), room),
        count: String(count(history.held)),
        total: texts.counted(input.path.length, RECALL_TEXT.word.message),
        missing: history.missing.length === 0 ? texts.render(RECALL_TEXT.prompt.historyAll) : texts.render(RECALL_TEXT.prompt.historyMissing, { missing: clip(runsText(history.missing, texts), room), stands: stands === "" ? texts.render(RECALL_TEXT.prompt.standNone) : texts.render(RECALL_TEXT.prompt.stands, { stands }) }),
      });
    };
    const room = Math.max(1, Math.floor((settings.prompt.historyChars - said(0).length) / 2));
    notes.push(clip(said(room), settings.prompt.historyChars));
  }

  const entries: HeldEntry[] = lore.entries.map(({ doc: _doc, inline: _inline, ...held }) => held);
  return { text: notes.join("\n\n"), held: { lore: entries, index: { listed, more: left }, history }, fromLore };
}
