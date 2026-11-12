// Lore and history as the pages read them (DESIGN §24.1 to §24.7, §22): `harness.recall`. Each
// method takes one plain object and resolves plain JSON (`shapes.ts`), so each can be a request over
// the link; a refusal rejects with a `HarnessRefusal`, whose message the user reads.
//
// The pages read what the agents read: the Lore page's search is the agents' own `lore_search`, the
// Chronicle page's check is `chronicle_check`, and both go through the chat's kept indexes, so
// opening a page builds nothing an agent's next turn doesn't use.

import { baseAgents, resolveAgent } from "../agents";
import type { Definitions } from "../definitions";
import type { HarnessHost } from "../ports";
import { HarnessRefusal } from "../refusal";
import { AGENT, type Settings } from "../settings";
import type { StorySource } from "../story";
import { TEXT, type Texts } from "../texts";
import { countedIn, priced } from "../usage";
import { tokensOf } from "../util";
import { type AreaAccess, fileAt, showPath } from "../workspace";
import { whoOf } from "./chat";
import { checkChronicle, chronicleReach, readChronicle, storyHashes, uncoveredMessages, uncoveredRuns } from "./chronicle";
import { checkCitation, namedMessage, placesOf } from "./cite";
import { CHRONICLER, RECALL_SKILL, recallAgents } from "./definitions";
import type { LoreDoc } from "./lore";
import { hitDetail, searchLore } from "./lore-search";
import { stretchesOf } from "./outline";
import { type LastTurn, Recall, type RecallRun, recallOf } from "./recall";
import type { ChronicleCheck, CitedMessage, EmbedStatus, LoreHitView, LoreListing, LoreRow, LoreSearchView, LoreState, StoryEstimate, StoryStatus } from "./shapes";

export interface RecallPage {
  /** A chat's books and entries, each entry as it stood at the chat's last turn, and search by meaning as it stands. */
  lore(input: { chatId: string }): Promise<LoreListing & { embedding: EmbedStatus }>;
  /** One entry whole: its row and its text. */
  entry(input: { chatId: string; entryId: string }): Promise<{ entry: LoreRow; text: string }>;
  /** The agents' own `lore_search` over the chat's books: several queries, each with its hits (`limit` a query; left out: Settings' hits per page). */
  search(input: { chatId: string; queries: string[]; limit?: number }): Promise<LoreSearchView>;
  /** Search by meaning as it stands for a chat; `start` has what waits for a vector embedded now, in the background, under the daily cap. */
  embed(input: { chatId: string; start: boolean }): Promise<{ embedding: EmbedStatus }>;
  /** A chat's chronicle with the check run over it. */
  chronicle(input: { chatId: string }): Promise<ChronicleCheck>;
  /** The messages citations name, each as it stands now, in the order asked. */
  cited(input: { chatId: string; citations: string[] }): Promise<{ cited: CitedMessage[] }>;
  /** How far the learning of a chat's story has come, and what to start one with. */
  story(input: { chatId: string }): Promise<StoryStatus>;
}

export interface RecallPageDeps {
  host: HarnessHost;
  /**
   * The user's settings and texts as they stand, as a run about the chat would read them, the
   * definitions where the caller has them (the model the chronicler runs on is read from them), what
   * counts as the chat's story, and why LumiAH's own agents don't keep its chronicle (null: they do).
   */
  setup(chatId: string): Promise<{ settings: Settings; texts: Texts; definitions?: Pick<Definitions, "resolve">; story: StorySource; chronicle: string | null }>;
  /** The chat's `learned/` area. */
  learned(chatId: string): Promise<AreaAccess | null>;
}

/** The plan of a story's learning, within the `learned` area. A path the skill names, so fixed. */
const PLAN = "chronicle/plan.md";

/**
 * What learning the rest of a story is expected to take (`StoryEstimate`): a plain reckoning from
 * the messages no outline line covers (`rest`, oldest first, each with its length; `starts`: the
 * number each run of them begins with, so no stretch is counted across a covered message) and
 * Settings' three figures. Nothing is taken to be read from a provider's cache, so the prompt
 * tokens count in full with the limits and the reckoning errs high. `model`: what the chronicler
 * runs on, for the cost at the user's price; null where that isn't known.
 */
export function storyEstimate(rest: readonly { index: number; chars: number }[], starts: readonly number[], settings: Readonly<Settings>, model: string | null): StoryEstimate {
  const { stretchMessages, stretchChars, estimateSent, estimateWritten, estimateRounds } = settings.recall.chronicle;
  const chars = rest.reduce((n, message) => n + message.chars, 0);
  const stretches = stretchesOf(rest, { messages: Math.max(1, stretchMessages), chars: Math.max(1, stretchChars) }, { top: starts }).length;
  const tokens = chars / settings.loop.charsPerToken;
  const promptTokens = Math.ceil(tokens * Math.max(0, estimateSent));
  const writtenTokens = Math.ceil(tokens * Math.max(0, estimateWritten));
  const cachedTokens = 0;
  const cost = model === null || rest.length === 0 ? undefined : priced({ in: promptTokens, cachedIn: cachedTokens, out: writtenTokens, reasoningOut: 0, estimated: [] }, [model], settings.prices).cost;
  return {
    messages: rest.length,
    chars,
    stretches,
    promptTokens,
    cachedTokens,
    writtenTokens,
    weighedTokens: countedIn({ in: promptTokens, cachedIn: cachedTokens }, settings.spend.cachedWeight),
    toolTurns: Math.ceil(stretches * Math.max(0, estimateRounds)),
    usd: rest.length === 0 ? 0 : (cost ?? null),
  };
}

function stateOf(doc: LoreDoc, last: LastTurn | null): LoreState {
  if (!doc.entry.enabled) return "off";
  if (last?.added.includes(doc.entry.id)) return "added";
  if (last?.dropped.includes(doc.entry.id)) return "dropped";
  return last && Object.hasOwn(last.held, doc.entry.id) ? "in_prompt" : "not_in_prompt";
}

function rowOf(doc: LoreDoc, last: LastTurn | null, charsPerToken: number): LoreRow {
  const why = last && Object.hasOwn(last.held, doc.entry.id) ? last.held[doc.entry.id] : undefined;
  return {
    entryId: doc.entry.id,
    short: doc.short,
    bookId: doc.book.id,
    title: doc.entry.title,
    keys: [...doc.entry.keys],
    secondaryKeys: [...doc.entry.secondaryKeys],
    chars: doc.entry.content.length,
    tokens: tokensOf(doc.entry.content, charsPerToken),
    enabled: doc.entry.enabled,
    constant: doc.entry.constant,
    vectorized: doc.entry.vectorized,
    state: stateOf(doc, last),
    ...(why ? { why } : {}),
  };
}

export function recallPage(deps: RecallPageDeps): RecallPage {
  const { host } = deps;
  const recall = Recall.of(host);
  /** Each request reads the chat and its lore as they stand now: a run of its own, by a number no run bears. */
  let asked = 0;

  /** The chat a request names; refused where it names none. */
  const chatOf = (input: { chatId?: unknown }): string => {
    if (typeof input.chatId !== "string" || input.chatId === "") throw new HarnessRefusal("bad_request", "Say which chat.");
    return input.chatId;
  };

  /** A view of the chat for one request, with the user's settings and texts as they stand. */
  const view = async (chatId: string): Promise<{ run: RecallRun; settings: Settings; texts: Texts }> => {
    const { settings, texts, story } = await deps.setup(chatId);
    return { run: recallOf({ host, run: { id: `page-${++asked}`, kind: "side", chatId }, settings, texts, story }), settings, texts };
  };

  const status = async (run: RecallRun, settings: Settings, start: boolean): Promise<EmbedStatus> => recall.meaning.status({ lore: await run.loreGroups(), chat: await run.chatGroup(), settings, start });

  return {
    async lore(input) {
      const chatId = chatOf(input);
      const { run, settings } = await view(chatId);
      const corpus = await run.lore();
      const last = await recall.last(chatId);
      return {
        books: corpus.books.map((book) => ({ id: book.id, name: book.name, description: book.description, entries: corpus.docs.filter((doc) => doc.book.id === book.id).length })),
        entries: corpus.docs.map((doc) => rowOf(doc, last, settings.loop.charsPerToken)),
        last: last ? { generationId: last.generationId, at: last.at } : null,
        embedding: await status(run, settings, false),
      };
    },

    async entry(input) {
      const chatId = chatOf(input);
      const { run, settings } = await view(chatId);
      const corpus = await run.lore();
      const [doc, ...others] = typeof input.entryId === "string" ? corpus.named(input.entryId) : [];
      if (!doc || others.length > 0) throw new HarnessRefusal("not_found", "There is no such entry in the books that apply to this chat: it may have been removed, or its book no longer applies.");
      return { entry: rowOf(doc, await recall.last(chatId), settings.loop.charsPerToken), text: doc.entry.content };
    },

    async search(input) {
      const chatId = chatOf(input);
      const queries = (Array.isArray(input.queries) ? input.queries : []).filter((q): q is string => typeof q === "string" && q.trim() !== "").map((q) => q.trim());
      if (queries.length === 0) throw new HarnessRefusal("bad_request", "Say what to search for.");
      const { run, settings } = await view(chatId);
      // As many queries as one lore_search call carries: the page runs the agents' own search, within the agents' own limits.
      const taken = queries.slice(0, Math.max(1, settings.recall.lore.queries));
      const limit = typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit > 0 ? input.limit : settings.tools.pageItems;
      const last = await recall.last(chatId);
      const { meaning, found } = await searchLore(run, taken);
      return {
        meaning,
        queries: found.map(({ query, hits }) => ({
          query,
          total: hits.length,
          hits: hits.slice(0, limit).map((hit): LoreHitView => {
            const { fields, words, lines } = hitDetail(hit.doc, query, settings);
            return {
              entryId: hit.doc.entry.id,
              short: hit.doc.short,
              bookId: hit.doc.book.id,
              book: hit.doc.book.name,
              title: hit.doc.entry.title,
              chars: hit.doc.entry.content.length,
              state: stateOf(hit.doc, last),
              constant: hit.doc.entry.constant,
              score: hit.score,
              by: [...hit.by],
              fields,
              words,
              ...(hit.similarity !== undefined ? { similarity: hit.similarity } : {}),
              lines: lines.map((line) => ({ line: line.line, text: line.text })),
            };
          }),
        })),
      };
    },

    async embed(input) {
      const chatId = chatOf(input);
      const { run, settings } = await view(chatId);
      return { embedding: await status(run, settings, input.start === true) };
    },

    async chronicle(input) {
      const chatId = chatOf(input);
      const { story } = await deps.setup(chatId);
      return checkChronicle(await readChronicle(await deps.learned(chatId)), storyHashes(await host.chat.path(chatId), story));
    },

    async cited(input) {
      const chatId = chatOf(input);
      const citations = (Array.isArray(input.citations) ? input.citations : []).filter((c): c is string => typeof c === "string");
      if (citations.length === 0) throw new HarnessRefusal("bad_request", "Say which citations to read.");
      const { run } = await view(chatId);
      const chat = await run.chat();
      const hashes = chat.hashes();
      const places = placesOf(hashes);
      return {
        cited: citations.map((citation): CitedMessage => {
          const named = namedMessage(citation);
          if (!named) return { index: -1, ok: false, why: "gone", message: null };
          const state = named.hash === null ? ({ state: hashes.has(named.index) ? "ok" : "gone" } as const) : checkCitation({ index: named.index, hash: named.hash }, hashes, places);
          const at = state.state === "moved" ? state.now : named.index;
          const doc = state.state === "gone" ? undefined : chat.at(at);
          return {
            index: named.index,
            ok: state.state === "ok",
            ...(state.state !== "ok" ? { why: state.state } : {}),
            ...(state.state === "moved" ? { now: state.now } : {}),
            message: doc ? { index: doc.index, role: doc.role, name: whoOf(doc), at: doc.at, text: doc.text } : null,
          };
        }),
      };
    },

    async story(input) {
      const chatId = chatOf(input);
      const { settings, texts, definitions, story, chronicle } = await deps.setup(chatId);
      const learned = await deps.learned(chatId);
      const path = await host.chat.path(chatId);
      const plan = learned && fileAt(await learned.index(), PLAN) ? showPath("learned", PLAN) : null;
      const files = await readChronicle(learned);
      // What the story leaves out is nothing to learn: it counts in no figure here.
      const chat = storyHashes(path, story);
      const { covered } = chronicleReach(files, chat);
      const left = new Set(uncoveredMessages(files, chat));
      // The model the chronicler runs on: its own, else the one it follows, else its connection's. Where none of them can be read the estimate has no cost.
      const [builtIn] = recallAgents();
      const resolved = definitions?.resolve(CHRONICLER, settings) ?? (builtIn ? resolveAgent(builtIn, settings, baseAgents().find((agent) => agent.id === AGENT.main)) : undefined);
      const model = resolved?.model ?? (await host.connections.get(resolved?.connectionId ?? null).catch(() => null))?.model ?? null;
      const estimate = storyEstimate(path.filter((m) => left.has(m.index)), uncoveredRuns(files, chat).map(([from]) => from), settings, model === "" ? null : model);
      return { plan, messages: chat.story().length, covered, estimate, suggested: { task: texts.render(TEXT.recall.story.objective, { skill: RECALL_SKILL.learn }), agent: CHRONICLER }, refused: chronicle };
    },
  };
}
