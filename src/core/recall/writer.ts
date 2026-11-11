// The lore the writer sees (DESIGN §24.3). `write_reply` names entries to add to the writer's
// request and entries to take out of it, by the ids the tools show: the main agent decides entry by
// entry and retypes none of it. `planWriterLore` resolves what was named against the chat's lore and
// the prompt, under Settings, when the tool is called; `writerLore` applies the plan to the
// request's messages when the writer's request is made. Neither holds a reply: what can't be done
// is said back with why, and the writer writes with the rest.

import type { RequestMessage } from "../ports";
import { TEXT } from "../texts";
import { clip, errorText } from "../util";
import { listArg } from "./answers";
import { type LoreCorpus, type LoreDoc, refId } from "./lore";
import type { HeldLore } from "./prompt";
import type { RecallRun, WriterPlan } from "./recall";
import type { LoreChange } from "./shapes";

const W = TEXT.recall.writer;

/**
 * Plans what `write_reply` named for the writer's request: `add` and `drop` are lists of entry ids
 * as the tools show them. An entry is added whole where Settings let the main agent add, it is not
 * in the prompt already, and the reply's caps have room for it; one is dropped where Settings let
 * it drop and the request shows the entry's text. Everything else is refused with why, in words for
 * the main agent. The plan is the run's (`RecallRun.writer`; none where nothing is added or
 * dropped), and what it changes is kept with how the chat's lore stood at this turn. Never rejects.
 */
export async function planWriterLore(run: RecallRun, asked: { add: unknown; drop: unknown }): Promise<LoreChange> {
  const { settings, texts } = run.env;
  const { lineChars } = settings.tools;
  const limits = settings.recall.writer;
  const adds = listArg(asked.add);
  const drops = listArg(asked.drop);
  const change: LoreChange = { added: [], dropped: [], refused: [] };
  // A reference is said back as given, a line of it at most: an id is never longer, and what isn't one may be.
  const refuse = (ref: string, reason: string): void => {
    change.refused.push({ entryId: clip(ref, lineChars), reason });
  };
  const keep = (): Promise<void> => run.wrote(change).catch((error: unknown) => run.host.log("warn", `[LumiAH] what write_reply added to and dropped from the writer's lore couldn't be kept (${errorText(error)})`));
  const stood = run.writer !== null;
  run.writer = null;
  // The common reply names nothing: then nothing is read, and nothing is kept unless an earlier call of this run had planned otherwise.
  if (adds.length === 0 && drops.length === 0) {
    if (stood) await keep();
    return change;
  }

  let corpus: LoreCorpus;
  let held: HeldLore | null;
  try {
    corpus = await run.lore();
    held = await run.held();
  } catch (error) {
    run.host.log("warn", `[LumiAH] the lore write_reply named couldn't be read (${errorText(error)}): the writer's request stays as Lumiverse assembled it`);
    const reason = texts.render(W.unread, { error: clip(errorText(error), lineChars) });
    for (const ref of [...adds, ...drops]) refuse(ref, reason);
    if (stood) await keep();
    return change;
  }
  const messages = run.env.turn?.messages ?? [];
  const several = (named: readonly LoreDoc[]): string => texts.render(W.ambiguous, { entries: clip(named.map((doc) => `[${doc.short}] ${doc.entry.title}`).join(", "), lineChars) });

  // What is named to drop is resolved first: an entry named to add as well is left alone.
  const dropNamed = drops.map((ref): { ref: string; id: string } | { ref: string; reason: string } => {
    if (!limits.drop) return { ref, reason: texts.render(W.dropOff) };
    const named = corpus.named(ref);
    const [doc] = named;
    if (named.length > 1) return { ref, reason: several(named) };
    if (doc) return { ref, id: doc.entry.id };
    // An entry of a book the tools don't read is in the prompt under the id Lumiverse gave, and is named by that.
    const id = refId(ref);
    if (held?.byId.has(id)) return { ref, id };
    return { ref, reason: texts.render(held?.unseen.some((entry) => entry.entryId === id) ? W.unseen : W.unknown) };
  });
  const dropping = new Set(dropNamed.flatMap((one) => ("id" in one ? [one.id] : [])));

  const plan: WriterPlan = { add: [], drop: [] };
  const adding = new Set<string>();
  let chars = 0;
  for (const ref of adds) {
    if (!limits.add) {
      refuse(ref, texts.render(W.addOff));
      continue;
    }
    const named = corpus.named(ref);
    const [doc] = named;
    if (!doc || named.length > 1) {
      refuse(ref, doc ? several(named) : texts.render(W.unknown));
      continue;
    }
    const { id, content } = doc.entry;
    // Named again by another form of its id: it is added once.
    if (adding.has(id)) continue;
    adding.add(id);
    if (dropping.delete(id)) refuse(ref, texts.render(W.twice));
    else if (held?.byId.has(id)) refuse(ref, texts.render(W.held));
    // An entry the user switched off is the main agent's to add only where Settings list such entries to it.
    else if (!doc.entry.enabled && !settings.recall.prompt.indexOff) refuse(ref, texts.render(W.off));
    else if (content.trim() === "") refuse(ref, texts.render(W.empty));
    else if (plan.add.length >= limits.addEntries) refuse(ref, texts.render(W.capEntries, { limit: texts.counted(limits.addEntries, TEXT.recall.word.entry) }));
    else if (chars + content.length > limits.addChars) refuse(ref, texts.render(W.capChars, { limit: String(limits.addChars) }));
    else {
      chars += content.length;
      plan.add.push(doc);
      change.added.push({ entryId: id, bookId: doc.book.id, title: doc.entry.title, chars: content.length });
    }
  }

  for (const one of dropNamed) {
    if ("reason" in one) {
      refuse(one.ref, one.reason);
      continue;
    }
    // Named again, or named to add as well: it was answered once.
    if (!dropping.delete(one.id)) continue;
    const places = held?.entries.filter((entry) => entry.entryId === one.id) ?? [];
    // Its text can be taken out where it is a message of its own, or stands inside a message that is plain text: a message of parts can't be cut by where its text stands.
    const taken = places.filter((entry) => {
      if (entry.message !== null) return true;
      const block = entry.inline ? messages[entry.inline.at] : undefined;
      return block !== undefined && block.parts === undefined;
    });
    const [first] = taken;
    if (!first) {
      const inside = places.find((entry) => entry.inline !== null)?.inline;
      // One Lumiverse activated whose text the request doesn't show has nothing to take out, and is told as that.
      const unseen = held?.unseen.some((entry) => entry.entryId === one.id) ?? false;
      refuse(one.ref, inside ? texts.render(W.inline, { n: String(inside.at + 1) }) : texts.render(unseen ? W.unseen : W.notHeld));
      continue;
    }
    plan.drop.push(...taken);
    change.dropped.push({ entryId: one.id, bookId: first.bookId ?? "", title: first.title, chars: taken.reduce((n, entry) => n + entry.chars, 0) });
  }

  run.writer = plan.add.length > 0 || plan.drop.length > 0 ? plan : null;
  await keep();
  return change;
}

/** `text` without the stretches `cuts` name, each from its first character to the one after its last; stretches that overlap are one. */
function without(text: string, cuts: readonly (readonly [number, number])[]): string {
  let out = "";
  let from = 0;
  for (const [start, end] of [...cuts].sort((a, b) => a[0] - b[0])) {
    if (start > from) out += text.slice(from, start);
    from = Math.max(from, end);
  }
  return out + text.slice(from);
}

/**
 * The request's messages as the writer is sent them, with the run's plan applied (`planWriterLore`).
 * A dropped entry's message is taken out; one a preset's macro put inside a block has exactly its
 * text cut out of that block. An added entry's own text goes in as a message of its own after the
 * last message Lumiverse flagged as World Info, as that message's role unless the entry has its
 * own; where the request has no such message, the added texts come back in `beside`, in the order
 * named, for the caller to put before the brief. Without a plan the messages are as they came.
 */
export function writerLore(run: RecallRun | undefined, messages: readonly RequestMessage[]): { messages: RequestMessage[]; beside: string[] } {
  const plan = run?.writer;
  if (!plan) return { messages: [...messages], beside: [] };
  // Where Lumiverse puts world info, found before anything is taken out: dropping every entry still leaves the place.
  const place = messages.findLastIndex((m) => m.source?.kind === "lore");
  const neighbour = place < 0 ? undefined : messages[place];
  const gone = new Set<number>();
  const cuts = new Map<number, [number, number][]>();
  for (const held of plan.drop) {
    if (held.message !== null) {
      // Only a message Lumiverse flagged as an entry is ever taken out whole: the plan names messages by their place, and a request that isn't the one it was made for loses nothing else.
      if (messages[held.message - 1]?.source?.kind === "lore") gone.add(held.message - 1);
    } else if (held.inline) {
      const list = cuts.get(held.inline.at);
      if (list) list.push([held.inline.start, held.inline.end]);
      else cuts.set(held.inline.at, [[held.inline.start, held.inline.end]]);
    }
  }
  const out: RequestMessage[] = [];
  messages.forEach((m, at) => {
    const cut = m.parts === undefined ? cuts.get(at) : undefined;
    if (!gone.has(at)) {
      if (!cut) out.push(m);
      else {
        const content = without(m.content, cut);
        // A block that held nothing but the entry is no message once the entry is out: a request carries no empty one.
        if (content.trim() !== "") out.push({ ...m, content });
      }
    }
    if (neighbour && at === place) for (const doc of plan.add) out.push({ role: doc.entry.role ?? neighbour.role, content: doc.entry.content, source: { kind: "lore", entryId: doc.entry.id } });
  });
  return { messages: out, beside: neighbour ? [] : plan.add.map((doc) => doc.entry.content) };
}
