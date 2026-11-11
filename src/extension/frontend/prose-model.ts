// An agent's words as a reader sees them: a report, an answer, a brief are written as markdown, and
// shown raw they read as "## What I did" and "**bold**". This reads the little of markdown agents
// use (headings, lists, a code block, bold, italic, code) into blocks to draw; anything else stays
// the text it is, so nothing an agent wrote is lost. Pure, so it is tested without a DOM.

/** A run of words within a line: plain, bold, italic, or code. */
export type Inline = { text: string } | { strong: string } | { em: string } | { code: string };

/** A block of prose: a heading, a list, a block of code kept as written, or a paragraph (its lines kept apart). */
export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string }
  | { kind: "para"; lines: Inline[][] };

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s*(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const FENCE = /^\s*```/;
// Bold before italic, so `**word**` isn't read as two italics; code first, so marks inside it stay as written.
const MARKS = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\s][^*\n]*?)\*|\b_([^_\s][^_\n]*?)_\b/g;

/** A line's words with its marks read: `**bold**`, `*italic*`, and code between backticks. */
export function inlineOf(line: string): Inline[] {
  const out: Inline[] = [];
  let from = 0;
  for (const found of line.matchAll(MARKS)) {
    const at = found.index ?? 0;
    if (at > from) out.push({ text: line.slice(from, at) });
    const [whole, code, strong, strong2, em, em2] = found;
    if (code !== undefined) out.push({ code });
    else if (strong !== undefined || strong2 !== undefined) out.push({ strong: strong ?? strong2 ?? "" });
    else out.push({ em: em ?? em2 ?? "" });
    from = at + whole.length;
  }
  if (from < line.length) out.push({ text: line.slice(from) });
  return out;
}

/** A text as blocks to draw. */
export function proseOf(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      // The closing fence, where the text has one.
      i += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: (heading[1] ?? "#").length, inline: inlineOf(heading[2] ?? "") });
      i += 1;
      continue;
    }
    const first = ITEM.exec(line);
    if (first) {
      const ordered = first[2] !== undefined;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const item = ITEM.exec(lines[i] ?? "");
        if (!item || (item[2] !== undefined) !== ordered) break;
        items.push(inlineOf(item[3] ?? ""));
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const para: Inline[][] = [];
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.trim() === "" || FENCE.test(next) || HEADING.test(next) || ITEM.test(next)) break;
      para.push(inlineOf(next));
      i += 1;
    }
    blocks.push({ kind: "para", lines: para });
  }
  return blocks;
}

const wordsOf = (inline: readonly Inline[]): string => inline.map((piece) => ("text" in piece ? piece.text : "strong" in piece ? piece.strong : "em" in piece ? piece.em : piece.code)).join("");

/** A text's first line of words, with no marks: what a notice or a row says of a report in one line. Empty for a text with no words. */
export function plainLine(text: string): string {
  for (const block of proseOf(text)) {
    if (block.kind === "heading") {
      const words = wordsOf(block.inline).trim();
      if (words !== "") return words;
    } else if (block.kind === "list") {
      const words = wordsOf(block.items[0] ?? []).trim();
      if (words !== "") return words;
    } else if (block.kind === "para") {
      const words = wordsOf(block.lines[0] ?? []).trim();
      if (words !== "") return words;
    } else if (block.text.trim() !== "") return (block.text.trim().split("\n")[0] ?? "").trim();
  }
  return "";
}

/** A sentence that carries markdown marks (a notice quoting a report's opening), with the marks taken out and the line breaks made spaces. */
export function plainWords(text: string): string {
  return proseOf(text)
    .map((block) => (block.kind === "heading" ? wordsOf(block.inline) : block.kind === "list" ? block.items.map(wordsOf).join("; ") : block.kind === "para" ? block.lines.map(wordsOf).join(" ") : block.text))
    // A heading's marks quoted mid-sentence ("finished: ## What I did") go too; "#17" is a reply's number and stays.
    .map((words) => words.replace(/(^|\s)#{1,6}\s+(?=\S)/g, "$1").replace(/\s+/g, " ").trim())
    .filter((words) => words !== "")
    .join(" ");
}
