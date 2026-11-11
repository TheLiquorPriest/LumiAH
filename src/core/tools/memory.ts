// The memory tools (DESIGN §24.4): memory_search, memory_entity and memory_arcs, over Lumiverse's
// Memory Cortex as the host's memory port gives it. LumiAH keeps nothing of it: each call asks the
// Cortex. None is offered where the host has no memory port, where the run has no chat, or where
// the user has the Cortex off for the chat; where that wasn't read when the run began, the call
// asks, and says so itself.
//
// What the port answers is outside data: its shape is checked before a word of it is shown, and
// every text of it is put on one line and clipped, so an answer stays within Answer length whatever
// the Cortex holds.

import type { JsonObject } from "../ports";
import { isRecord } from "../ports";
import { listArg, namedArgs, restNote, spanText, whenText } from "../recall/answers";
import type { MemoryArc, MemoryEntity, MemoryEntityBrief, MemoryHit, MemoryPort, MemoryRelation } from "../recall/ports";
import { recallOf } from "../recall/recall";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, errorText, textArg } from "../util";
import { fitted, listPage, needs, type Pager, pagerOf, readCursor, saidBack } from "./paging";

const A = TEXT.recall.answer;
const W = TEXT.recall.word;

/**
 * The share of an entity's page its relations may take: half, so its facts have the rest. Fixed,
 * not a setting: it divides one page between the two, and the page's length is the setting (Answer
 * length).
 */
const RELATIONS_SHARE = 0.5;

/**
 * The furthest a moment may be from 1970 for a date to be written of it, in milliseconds: what a
 * JavaScript date holds. Not a limit of the harness, so not a setting.
 */
const DATE_MOST = 8.64e15;

/** A text of the Cortex on one line, `max` characters at most. */
const flat = (text: string, max: number): string => clip(text.replace(/\s+/g, " ").trim(), max);

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");
const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string" && one.trim() !== "") : []);

/** The messages something was made from, the lower number first; null where the port gave none that can be read. */
function spanOf(value: unknown): [number, number] | null {
  if (!Array.isArray(value)) return null;
  const [a, b]: unknown[] = value;
  return typeof a === "number" && typeof b === "number" && Number.isSafeInteger(a) && Number.isSafeInteger(b) ? [Math.min(a, b), Math.max(a, b)] : null;
}

/** What the Cortex gave for a query, read: `most` at most, and nothing that has no text. */
function hitsOf(read: unknown, most: number): MemoryHit[] {
  return (Array.isArray(read) ? read : [])
    .flatMap((raw: unknown): MemoryHit[] => {
      if (!isRecord(raw) || typeof raw.text !== "string" || raw.text.trim() === "") return [];
      return [{ source: raw.source === "arc" ? "arc" : "chunk", text: raw.text, score: numberOf(raw.score), span: spanOf(raw.span), entities: stringsOf(raw.entities) }];
    })
    .slice(0, Math.max(1, most));
}

/** An entity as the Cortex gave it, read; null for anything that isn't one. */
function entityOf(raw: unknown): MemoryEntity | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.trim() === "") return null;
  const relations = (Array.isArray(raw.relations) ? raw.relations : []).flatMap((one: unknown): MemoryRelation[] => {
    if (!isRecord(one) || typeof one.target !== "string" || one.target.trim() === "") return [];
    return [{ target: one.target, type: textOf(one.type), label: typeof one.label === "string" && one.label.trim() !== "" ? one.label : null, strength: numberOf(one.strength), sentiment: numberOf(one.sentiment) }];
  });
  const seen = raw.lastSeenAt;
  return {
    id: textOf(raw.id),
    name: raw.name,
    type: textOf(raw.type),
    aliases: stringsOf(raw.aliases),
    description: textOf(raw.description),
    status: textOf(raw.status),
    facts: stringsOf(raw.facts),
    mentions: Math.max(0, Math.round(numberOf(raw.mentions))),
    lastSeenAt: typeof seen === "number" && Number.isFinite(seen) && Math.abs(seen) <= DATE_MOST ? seen : null,
    relations,
  };
}

/** The entities the Cortex listed, read: `most` at most. */
function briefsOf(read: unknown, most: number): MemoryEntityBrief[] {
  return (Array.isArray(read) ? read : [])
    .flatMap((raw: unknown): MemoryEntityBrief[] => (isRecord(raw) && typeof raw.name === "string" && raw.name.trim() !== "" ? [{ name: raw.name, type: textOf(raw.type), mentions: Math.max(0, Math.round(numberOf(raw.mentions))) }] : []))
    .slice(0, Math.max(1, most));
}

/** The lines from the first that fit `room` characters together, each with the line break after it. The first is clipped where it alone is longer, so the best of a list is always shown. */
function fitting(lines: readonly string[], room: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > room) {
      if (out.length === 0 && room > 2) out.push(clip(line, room - 1));
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

/** What a memory tool is built over: the Cortex, the run's chat, and how the tool pages. */
interface Reach {
  env: ToolEnv;
  port: MemoryPort;
  chatId: string;
  p: Pager;
}

/** The Cortex where a tool may rest on it; null where the host has none, the run has no chat, or the user has it off for the chat. */
function reachOf(env: ToolEnv, tool: string): Reach | null {
  const port = env.host.recall?.memory;
  if (!port || env.run.chatId === "" || recallOf(env).available?.memory === false) return null;
  return { env, port, chatId: env.run.chatId, p: pagerOf(env, tool) };
}

/**
 * What a call reads from the Cortex, or the tool's answer where it can't: that the Cortex is off
 * (asked here where the run didn't read it when it began), or that it failed, with what works from
 * the messages instead. A call the run's end overtook throws on: the loop says why it ended.
 */
async function ask<T>(reach: Reach, ctx: ToolCtx, read: () => Promise<T>): Promise<{ got: T } | ToolOutcome> {
  const { env, port, chatId, p } = reach;
  try {
    if (recallOf(env).available === null && (await port.enabled(chatId)) !== true) return { text: p.texts.render(A.memoryOff), error: true };
    return { got: await read() };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { text: saidBack(p, errorText(error), (why) => p.texts.render(A.memoryFailed, { error: why })), error: true };
  }
}

/** One memory on one line: what it is, the messages it was made from, its score, the entities it names and its text. */
function hitLine(env: ToolEnv, hit: MemoryHit): string {
  const { texts } = env;
  const { lineChars, excerptChars } = env.settings.tools;
  return texts.render(A.memoryHit, {
    source: texts.render(hit.source === "arc" ? A.memoryArcSource : A.memoryChunk),
    span: hit.span ? ` ${spanText(texts, hit.span[0], hit.span[1])}` : "",
    score: hit.score.toFixed(2),
    entities: hit.entities.length === 0 ? "" : ` · ${flat(hit.entities.join(", "), lineChars)}`,
    text: flat(hit.text, excerptChars),
  });
}

/**
 * One query's part of memory_search's answer, `share` characters at most: its heading and its
 * memories from the best while they fit, then how many didn't. `several`: the call ran other
 * queries too, so this query alone would have the whole page.
 */
function queryPart(env: ToolEnv, p: Pager, query: string, hits: readonly MemoryHit[], share: number, several: boolean): string {
  const { texts } = env;
  const within: Pager = { ...p, pageChars: share };
  if (hits.length === 0) return clip(saidBack(within, query, (said) => texts.render(A.memoryNothing, { query: said })), share);
  const head = saidBack(within, query, (said) => texts.render(A.memoryHead, { query: said, count: texts.counted(hits.length, W.memory) }));
  const more = (count: number): string => (several ? texts.render(A.queryMore, { count: String(count), tool: p.tool }) : texts.render(A.memoryMore, { count: String(count) }));
  const lines = fitting(
    hits.map((hit) => hitLine(env, hit)),
    share - head.length - more(hits.length).length - 2,
  );
  const left = hits.length - lines.length;
  return clip([head, ...lines, ...(left > 0 ? [more(left)] : [])].join("\n"), share);
}

const memorySearch: ToolDefinition = {
  name: TOOL.memorySearch,
  family: FAMILY.memory,
  tier: "read",
  build(env: ToolEnv) {
    const reach = reachOf(env, TOOL.memorySearch);
    if (!reach) return null;
    const { texts } = env;
    const { port, chatId, p } = reach;
    const { memory, chat } = env.settings.recall;
    return {
      name: TOOL.memorySearch,
      description: texts.render(TEXT.tool(TOOL.memorySearch)),
      parameters: {
        type: "object",
        properties: { queries: { type: "array", items: { type: "string" }, description: texts.render(TEXT.toolArg(TOOL.memorySearch, "queries")) }, entities: { type: "array", items: { type: "string" }, description: texts.render(TEXT.toolArg(TOOL.memorySearch, "entities")) } },
        required: ["queries"],
      },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const { named, rest } = namedArgs(args, "queries", "query", chat.queries);
        if (named.length === 0) return needs(p, "queries");
        // As many names as memory_entity lists at most: a filter of more names than the Cortex is asked to list filters nothing.
        const only = listArg(args.entities).slice(0, Math.max(1, memory.entities));
        const options = { limit: memory.hits, ...(only.length > 0 ? { entities: only } : {}) };
        const found = await ask(reach, ctx, () => Promise.all(named.map(async (query) => hitsOf(await port.search(chatId, query, options, ctx.signal), memory.hits))));
        if ("text" in found) return found;
        const note = restNote(p, Math.max(1, chat.queries), rest);
        const share = Math.max(1, Math.floor((p.pageChars - (note === "" ? 0 : note.length + 1)) / named.length) - 1);
        const parts = named.map((query, i) => queryPart(env, p, query, found.got[i] ?? [], share, named.length > 1));
        return { text: [...parts, ...(note === "" ? [] : [note])].join("\n") };
      },
    };
  },
};

/** An entity as a list names it. */
function briefText(env: ToolEnv, brief: MemoryEntityBrief): string {
  const { texts } = env;
  const { lineChars } = env.settings.tools;
  return texts.render(A.memoryEntityBrief, { name: flat(brief.name, lineChars), type: flat(brief.type, lineChars) || texts.render(TEXT.recall.none), mentions: texts.counted(brief.mentions, W.mention) });
}

/**
 * What the Cortex has recorded of one entity, within a page: what it is and how it stands, then its
 * facts and its relations, as many of each as Settings show and the page has room for, each list
 * saying how many it shows of how many there are.
 */
function entityText(env: ToolEnv, p: Pager, entity: MemoryEntity): string {
  const { texts } = env;
  const { lineChars, excerptChars } = env.settings.tools;
  const { facts: mostFacts, relations: mostRelations } = env.settings.recall.memory;
  const none = texts.render(TEXT.recall.none);
  const said = (facts: string, factLines: string, relations: string, relationLines: string): string =>
    texts.render(A.memoryEntity, {
      name: flat(entity.name, lineChars),
      type: flat(entity.type, lineChars) || none,
      status: flat(entity.status, lineChars) || none,
      aliases: entity.aliases.length === 0 ? "" : ` · ${flat(entity.aliases.join(", "), lineChars)}`,
      mentions: texts.counted(entity.mentions, W.mention),
      seen: whenText(texts, entity.lastSeenAt),
      description: flat(entity.description, excerptChars) || none,
      facts,
      factLines,
      relations,
      relationLines,
    });
  const shownOf = (shown: number, total: number): string => `${shown}/${total}`;
  const room = p.pageChars - said(shownOf(entity.facts.length, entity.facts.length), none, shownOf(entity.relations.length, entity.relations.length), none).length;
  const relationLines = fitting(
    entity.relations.slice(0, Math.max(0, mostRelations)).map((relation) =>
      clip(
        texts.render(A.memoryRelation, {
          type: flat(relation.type, lineChars) || none,
          target: flat(relation.target, lineChars),
          label: relation.label === null ? "" : `: ${flat(relation.label, lineChars)}`,
          strength: relation.strength.toFixed(2),
          sentiment: relation.sentiment.toFixed(2),
        }),
        lineChars,
      ),
    ),
    Math.floor(room * RELATIONS_SHARE),
  );
  const factLines = fitting(
    entity.facts.slice(0, Math.max(1, mostFacts)).map((fact) => `- ${flat(fact, lineChars)}`),
    room - relationLines.reduce((n, line) => n + line.length + 1, 0),
  );
  return clip(said(shownOf(factLines.length, entity.facts.length), factLines.join("\n") || none, shownOf(relationLines.length, entity.relations.length), relationLines.join("\n") || none), p.pageChars);
}

const memoryEntity: ToolDefinition = {
  name: TOOL.memoryEntity,
  family: FAMILY.memory,
  tier: "read",
  build(env: ToolEnv) {
    const reach = reachOf(env, TOOL.memoryEntity);
    if (!reach) return null;
    const { texts } = env;
    const { port, chatId, p } = reach;
    const most = Math.max(1, env.settings.recall.memory.entities);
    return {
      name: TOOL.memoryEntity,
      description: texts.render(TEXT.tool(TOOL.memoryEntity)),
      parameters: { type: "object", properties: { name: { type: "string", description: texts.render(TEXT.toolArg(TOOL.memoryEntity, "name")) } } },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const name = textArg(args.name);
        const read = await ask(reach, ctx, async () => {
          const entity = name === null ? null : entityOf(await port.entity(chatId, name));
          return entity ? { entity, known: [] } : { entity, known: briefsOf(await port.entities(chatId, most), most) };
        });
        if ("text" in read) return read;
        const { entity, known } = read.got;
        if (entity) return { text: entityText(env, p, entity) };
        const briefs = known.map((brief) => briefText(env, brief));
        if (name !== null) {
          const list = briefs.length === 0 ? texts.render(TEXT.recall.none) : briefs.join(", ");
          return { text: fitted(p, list, (entities) => saidBack(p, name, (said) => texts.render(A.memoryNoEntity, { name: said, entities }))), error: true };
        }
        if (briefs.length === 0) return { text: texts.render(A.memoryNoEntities) };
        const listed = (count: number, entities: string): string => texts.render(A.memoryEntities, { count: texts.counted(count, W.entity), entities });
        const lines = fitting(briefs, p.pageChars - listed(briefs.length, "").length);
        return { text: clip(listed(lines.length, lines.join("\n")), p.pageChars) };
      },
    };
  },
};

const memoryArcs: ToolDefinition = {
  name: TOOL.memoryArcs,
  family: FAMILY.memory,
  tier: "read",
  build(env: ToolEnv) {
    const reach = reachOf(env, TOOL.memoryArcs);
    if (!reach) return null;
    const { texts } = env;
    const { port, chatId, p } = reach;
    const { lineChars, excerptChars } = env.settings.tools;
    return {
      name: TOOL.memoryArcs,
      description: texts.render(TEXT.tool(TOOL.memoryArcs)),
      parameters: { type: "object", properties: { cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.memoryArcs, "cursor")) } } },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const recall = recallOf(env);
        // By where each starts, a chapter above the scenes it is made of; an arc whose messages aren't known comes last.
        const start = (arc: MemoryArc): number => arc.span?.[0] ?? Number.POSITIVE_INFINITY;
        const arcs = [...(await recall.arcs())].sort((a, b) => (start(a) === start(b) ? b.tier - a.tier : start(a) - start(b)));
        if (arcs.length === 0) {
          // The run's read of the arcs gives none for a Cortex that is off and for one that failed alike: asked here, each says what it is.
          const asked = await ask(reach, ctx, () => port.arcs(chatId));
          return "text" in asked ? asked : { text: texts.render(A.memoryNoArcs) };
        }
        // When a stretch was is when its messages were sent, which the chat knows; without the chat an arc is listed without it.
        const chat = await recall.chat().catch(() => null);
        const none = texts.render(TEXT.recall.none);
        return listPage(p, {
          total: arcs.length,
          noun: W.arc,
          cursor,
          item: (i) => {
            const arc = arcs[i];
            if (!arc) return "";
            return texts.render(A.memoryArc, {
              span: arc.span ? spanText(texts, arc.span[0], arc.span[1]) : none,
              when: arc.span && chat ? whenText(texts, chat.at(arc.span[0])?.at ?? null, chat.at(arc.span[1])?.at ?? null) : "",
              tier: String(arc.tier),
              title: arc.title === null ? "" : ` · ${flat(arc.title, lineChars)}`,
              summary: flat(arc.summary, excerptChars),
            });
          },
        });
      },
    };
  },
};

export const MEMORY_TOOLS: readonly ToolDefinition[] = [memorySearch, memoryEntity, memoryArcs];
