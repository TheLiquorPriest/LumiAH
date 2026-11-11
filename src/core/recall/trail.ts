// The trail of a name or a phrase through a chat (DESIGN §24.4: chat_about): every message that
// holds it as written, how often, its first and its latest mention, and its most telling lines in
// between. All of it is worked out by code. "Telling" is counted, not judged: a message speaks of a
// name through the line that says it most often, and the messages between the first mention and
// the latest are cut into equal runs, each of which gives its best line, so the lines shown are
// spread over the whole span the name appears in and not gathered where it is said most.

import { tokenize } from "../lexical";
import type { ChatDoc } from "./chat";
import { countName, findName } from "./lore";

/** The line of a message that says the most of a name. */
export interface TrailLine {
  doc: ChatDoc;
  /** The line's words. */
  text: string;
  /** Where in the line the name first stands. */
  at: number;
  /** How often the line holds the name. */
  count: number;
}

export class Trail {
  /** Each message's line and how many different index words it has, worked out when first asked for: a trail is cut more than once where it has to fit a share of a page. */
  private readonly lines = new Map<ChatDoc, TrailLine>();
  private readonly words = new Map<ChatDoc, number>();

  constructor(
    /** The name as it is looked for: in lower case, on one line. */
    readonly name: string,
    /** The messages that hold it as written, in chat order. */
    readonly held: readonly ChatDoc[],
    /** How often it stands in them, in all. */
    readonly mentions: number,
  ) {}

  /** The line of one of `held` that holds the name most often; of lines that hold it as often, the first. */
  line(doc: ChatDoc): TrailLine {
    const known = this.lines.get(doc);
    if (known) return known;
    // A text and its lower case break into lines at the same places, so a line's number is the same in both.
    const lower = (doc.lower ??= doc.text.toLowerCase()).split("\n");
    let place = 0;
    let count = 0;
    lower.forEach((words, i) => {
      const n = countName(words, this.name);
      if (n > count) {
        place = i;
        count = n;
      }
    });
    const text = doc.text.split("\n")[place] ?? "";
    // A few letters grow in lower case: where the name stands is then a place near it, which is all the line shown around it needs.
    const made: TrailLine = { doc, text, at: Math.min(text.length, Math.max(0, findName(lower[place] ?? "", this.name))), count };
    this.lines.set(doc, made);
    return made;
  }

  private wordsOf(line: TrailLine): number {
    let n = this.words.get(line.doc);
    if (n === undefined) this.words.set(line.doc, (n = new Set(tokenize(line.text)).size));
    return n;
  }

  /**
   * The most telling lines between the first mention and the latest, `most` at most, in chat order:
   * the messages between the two are cut into that many runs of equal count, and each run gives the
   * line that holds the name most often; of lines that hold it as often, the one with the most
   * different index words, then the first.
   */
  between(most: number): TrailLine[] {
    const inner = this.held.slice(1, -1);
    const runs = Math.min(Math.max(0, Math.floor(most)), inner.length);
    const out: TrailLine[] = [];
    for (let i = 0; i < runs; i++) {
      let best: TrailLine | null = null;
      for (const doc of inner.slice(Math.floor((i * inner.length) / runs), Math.floor(((i + 1) * inner.length) / runs))) {
        const line = this.line(doc);
        if (best === null || line.count > best.count || (line.count === best.count && this.wordsOf(line) > this.wordsOf(best))) best = line;
      }
      if (best) out.push(best);
    }
    return out;
  }
}

/**
 * Where `name` stands in `docs` (a chat's messages, or those of a range, oldest first) as a word or
 * a phrase of its own, in any letter case. White space in the name counts as one space, so a name
 * is always looked for within one line.
 */
export function trailOf(docs: readonly ChatDoc[], name: string): Trail {
  const wanted = name.replace(/\s+/g, " ").trim().toLowerCase();
  const held: ChatDoc[] = [];
  let mentions = 0;
  if (wanted !== "") {
    for (const doc of docs) {
      const n = countName((doc.lower ??= doc.text.toLowerCase()), wanted);
      if (n === 0) continue;
      held.push(doc);
      mentions += n;
    }
  }
  return new Trail(wanted, held, mentions);
}
