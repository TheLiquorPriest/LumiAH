// The texts of a story's book (DESIGN §23): what book_outline and book_read say and answer, and how
// an entry of the book, the messages it spans and the book's coverage of the chat are put in words.

import { CURSOR_ARG, GROUP, type TextDef, TOOL, toolTexts, v, word } from "../text-def";

export const BOOK_TEXT = {
  head: "book.head",
  span: "book.span",
  message: "book.span.one",
  spanNone: "book.span.none",
  untitled: "book.untitled",
  line: "book.line",
  under: "book.under",
  leaf: "book.leaf",
  read: "book.read",
  noEntry: "book.no_entry",
  coverage: "book.coverage",
  uncovered: "book.coverage.uncovered",
  uncoveredNone: "book.coverage.uncovered.none",
  changed: "book.coverage.changed",
  changedNone: "book.coverage.changed.none",
  changedUnknown: "book.coverage.changed.unknown",
  /** What an entry is, by its level (`BookLevel`). */
  level: {
    chapter: "word.chapter",
    arc: "word.arc",
    volume: "word.volume",
  },
} as const;

const BOOK = GROUP.book;
const ANSWERS = GROUP.answers;

/** What the answers that name one entry say of the placeholder that names it. */
const HEAD = v("head", "the entry, as An entry of the book names it", true);

export const BOOK_TEXTS: TextDef[] = [
  ...toolTexts(
    TOOL.bookOutline,
    "List this chat's book: the summaries LumiBooks keeps of the chat's older messages. A chapter sums up a run of messages, an arc a run of chapters, a volume a run of arcs. Each entry is one line, with the entries it sums up indented under it: the id book_read takes, what it is, its title, the chat messages it spans and its length. The first page opens with the book's coverage: how many of the chat's messages it covers, which messages no chapter covers (there the book is silent), and which changed since they were summarized (there it is out of date). A summary is somebody's reading of the chat, and the chat itself is the source: chat_read reads the messages an entry spans. Give entry to list only the entries under one.",
    { entry: "An entry's id, as the outline gives it, to list only the entries under that one.", cursor: CURSOR_ARG },
  ),
  ...toolTexts(
    TOOL.bookRead,
    "Read one entry of this chat's book whole, by the id book_outline gives: a chapter, an arc or a volume of the summaries LumiBooks keeps of the chat's older messages. A long entry comes a page at a time. A summary is somebody's reading of the chat, not the chat: where the wording or a detail matters, or book_outline says its messages changed since, read the messages it spans with chat_read.",
    { entry: "The entry's id, as book_outline gives it.", cursor: CURSOR_ARG },
  ),
  {
    id: BOOK_TEXT.head,
    group: BOOK,
    label: "An entry of the book",
    note: "Names an entry wherever the book tools name one: in book_outline's lines and headings, and in book_read's.",
    text: "[{{id}}] {{kind}}: {{title}} · {{span}}",
    vars: [v("id", "the entry's id, as book_read takes it", true), v("kind", "what it is: a chapter, an arc or a volume, by the word for it"), v("title", "its title, as LumiBooks labels it"), v("span", "the chat messages it spans, as the three texts below say it")],
  },
  { id: BOOK_TEXT.span, group: BOOK, label: "A run of messages", note: "How the book tools write a run of chat messages: the messages an entry spans, and each run the coverage lists.", text: "#{{from}} to #{{to}}", vars: [v("from", "the first message's number", true), v("to", "the last message's number", true)] },
  { id: BOOK_TEXT.message, group: BOOK, label: "A run of one message", note: "As A run of messages, where the run is one message.", text: "#{{index}}", vars: [v("index", "the message's number", true)] },
  { id: BOOK_TEXT.spanNone, group: BOOK, label: "An entry from before this chat", note: "Stands where an entry's messages would, for an entry LumiBooks carried over from another chat: it spans none of this chat's.", text: "from before this chat", vars: [] },
  { id: BOOK_TEXT.untitled, group: BOOK, label: "An entry without a title", note: "Stands where an entry's title would, for one LumiBooks gave no label.", text: "(untitled)", vars: [] },
  { id: BOOK_TEXT.line, group: ANSWERS, label: "book_outline: an entry", note: "One entry in book_outline's answer.", text: "{{indent}}- {{head}} · {{chars}} characters", vars: [v("indent", "two spaces for each entry it sits under"), HEAD, v("chars", "its length")] },
  { id: BOOK_TEXT.under, group: ANSWERS, label: "book_outline: under one entry", note: "Leads book_outline's answer for one entry: the entries under it follow, one line each.", text: "{{head}}. The entries under it:", vars: [HEAD] },
  { id: BOOK_TEXT.leaf, group: ANSWERS, label: "book_outline: nothing under an entry", note: "book_outline's answer for an entry that sums up no other.", text: "{{head}}. No entry is under it: book_read with entry {{id}} reads its text.", vars: [HEAD, v("id", "the entry's id, as book_read takes it")] },
  {
    id: BOOK_TEXT.read,
    group: ANSWERS,
    label: "book_read: its answer",
    note: "book_read's answer: an entry, or the part of it a page holds.",
    text: "{{head}} · characters {{from}} to {{to}} of {{chars}}:\n{{text}}",
    vars: [HEAD, v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the entry's length"), v("text", "the text", true)],
  },
  { id: BOOK_TEXT.noEntry, group: ANSWERS, label: "No such entry of the book", note: "The answer of book_read and book_outline to an id that names no entry of the chat's book.", text: "There's no entry {{id}} in this chat's book. book_outline without entry lists its entries, each with the id to give.", vars: [v("id", "the id asked for", true)] },
  {
    id: BOOK_TEXT.coverage,
    group: ANSWERS,
    label: "book_outline: the coverage",
    note: "Leads book_outline's first page: how the book stands against the chat.",
    text: "Coverage: the book covers {{covered}} of this chat's {{messages}}. {{uncovered}} {{changed}}",
    vars: [
      v("covered", "how many of the chat's messages an entry covers"),
      v("messages", 'how many messages the chat has, with the word: "203 messages"'),
      v("uncovered", "which messages no chapter covers, as the two texts below say it", true),
      v("changed", "which messages changed since they were summarized, as the three texts after those say it", true),
    ],
  },
  { id: BOOK_TEXT.uncovered, group: ANSWERS, label: "The coverage: messages without a chapter", note: "Fills {{uncovered}} when some of the chat's messages have no chapter.", text: "No chapter covers {{count}} ({{ranges}}), so the book is silent there.", vars: [v("count", 'how many, with the word: "23 messages"'), v("ranges", "the messages, as runs of message numbers, clipped where they are many", true)] },
  { id: BOOK_TEXT.uncoveredNone, group: ANSWERS, label: "The coverage: no message without a chapter", note: "Fills {{uncovered}} when a chapter covers every message of the chat.", text: "No message is without a chapter.", vars: [] },
  { id: BOOK_TEXT.changed, group: ANSWERS, label: "The coverage: messages that changed", note: "Fills {{changed}} when some messages changed since LumiBooks summarized them.", text: "{{count}} changed since being summarized ({{ranges}}), so the book is out of date there.", vars: [v("count", 'how many, with the word: "2 messages"'), v("ranges", "the messages, as runs of message numbers, clipped where they are many", true)] },
  { id: BOOK_TEXT.changedNone, group: ANSWERS, label: "The coverage: no message changed", note: "Fills {{changed}} when every message LumiBooks summarized stands as it did.", text: "None changed since being summarized.", vars: [] },
  { id: BOOK_TEXT.changedUnknown, group: ANSWERS, label: "The coverage: changes it can't tell", note: "Fills {{changed}} for a book that keeps no hash of the messages it summarized, as LumiBooks' own book for a chat keeps none.", text: "The book keeps no hash of the messages it summarized, so it can't tell whether any changed since.", vars: [] },
  word(BOOK_TEXT.level.chapter, "chapter", "chapters"),
  word(BOOK_TEXT.level.arc, "arc", "arcs"),
  word(BOOK_TEXT.level.volume, "volume", "volumes"),
];
