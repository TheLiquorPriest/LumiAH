// Lore (DESIGN §24.1 to §24.5): the world books of a chat. What is there in a line; a search box that
// runs the agents' own search, so the user sees what an agent would find and why; every entry by
// book with its state for the last reply (in the prompt, added by the agent, left out of the prompt,
// not in the prompt, switched off) and how it came to be in the prompt; an entry whole, in the
// list's place on a phone and beside it where there is room; and how search by meaning stands, with
// what it has cost. The entry open is kept in `nav` (`Nav.lore`), so another page can lead to one
// and it is still open when the user comes back. What shows is decided in lore-model.ts.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type EmbeddingStatus, isReply, type LoreHit, type LoreRow, type LoreSearch, type LoreState, type LoreView } from "../../../shared/ui";
import { type App, errorWords, useApp } from "../app";
import { ChatBar, useChatView, useShownChat } from "../chat";
import { UiRequestError } from "../client";
import { Banner, Button, Chip, Empty, IconButton, SearchField, Section, Select, Switch, useBusy } from "../components";
import { Icon } from "../icons";
import { openSetting, SETTING_LINKS, type SettingLink } from "../setting-links";
import { settingPlace } from "../settings-model";
import {
  bookChoices,
  countsLine,
  entryFacts,
  entryTitle,
  filterFor,
  foundWords,
  groupsOf,
  isFiltered,
  limitForAll,
  LORE_STATE_ICON,
  LORE_STATE_TONE,
  LORE_STATE_WORDS,
  type LoreFilter,
  type LoreKept,
  markWords,
  matchWords,
  MEANING_SETTINGS,
  meaningOf,
  NO_LORE_FILTER,
  noHitsWords,
  nothingWords,
  queriesOf,
  ranWords,
  rowSub,
  rowWhy,
  START_LORE_KEPT,
  stateAbout,
  stateChips,
} from "../lore-model";
import { revealInScroller, scrollParent } from "../scroll";
import { createStore, type Store, useSelect } from "../store";

/**
 * How often the page looks again while texts are being embedded, in milliseconds. Nothing is pushed
 * as they are, so the page asks until they are done. It is the page's own pace and bounds nothing,
 * so it is no setting.
 */
const LOOK_AGAIN_MS = 2000;

const KEPT = new WeakMap<App, Store<LoreKept>>();

/** What an app's Lore page keeps while another page shows: the words in the search box and the filters. A page's own state goes when the page bar shows another page. */
function keptOf(app: App): Store<LoreKept> {
  let store = KEPT.get(app);
  if (!store) {
    store = createStore<LoreKept>(START_LORE_KEPT);
    KEPT.set(app, store);
  }
  return store;
}

interface Read {
  status: "loading" | "ready" | "failed";
  view: LoreView | null;
  message: string;
}

const LOADING: Read = { status: "loading", view: null, message: "" };

/** A search: the queries asked, and what they found (kept while they are asked again). */
interface Search {
  status: "idle" | "searching" | "ready" | "failed";
  asked: string[];
  found: LoreSearch | null;
  message: string;
}

const NO_SEARCH: Search = { status: "idle", asked: [], found: null, message: "" };

/** The entry open, as its read stands: `gone` where the chat's books have no such entry. */
interface Opened {
  status: "loading" | "ready" | "failed" | "gone";
  id: string;
  entry: LoreRow | null;
  text: string;
  message: string;
}

/** A state as its sign and its words. */
function StateMark(props: { state: LoreState }) {
  return (
    <span class="lah-lore-state" data-state={props.state} data-tone={LORE_STATE_TONE[props.state]}>
      <Icon name={LORE_STATE_ICON[props.state]} size={14} />
      {LORE_STATE_WORDS[props.state]}
    </span>
  );
}

/** A text with the words a search matched marked. */
function Marked(props: { text: string; words: readonly string[] }) {
  return <>{markWords(props.text, props.words).map((piece, i) => (piece.hit ? <mark key={i}>{piece.text}</mark> : piece.text))}</>;
}

/** What a search found: how it ran, then each query with its hits, best first. A hit's title is its press, which reaches over the whole card. */
function Found(props: { search: Search; shown: string | null; onOpen(hit: LoreHit): void; onAll(limit: number): void; onAgain(): void; onSetting(link: SettingLink): void }) {
  const { search } = props;
  if (search.status === "failed")
    return (
      <Banner
        tone="neg"
        title="The search failed"
        actions={
          <Button size="sm" icon="refresh" onClick={props.onAgain}>
            Try again
          </Button>
        }
      >
        {search.message}
      </Banner>
    );
  const found = search.found;
  if (found === null)
    return search.status === "searching" ? (
      <p class="lah-line" role="status">
        <span class="lah-pulse" aria-hidden="true" />
        <span>Searching…</span>
      </p>
    ) : null;
  const ran = ranWords(found.meaning);
  const setting = ran.setting;
  const all = limitForAll(found);
  return (
    <div class="lah-lore-found" data-lah-lore-found data-busy={search.status === "searching" || undefined}>
      <p class="lah-lore-ran" data-lah-lore-ran={found.meaning}>
        <Icon name={found.meaning === "on" ? "sparkle" : "info"} size={16} />
        <span>{`This is what an agent finds with the same words. ${ran.words}`}</span>
        {setting !== null ? (
          <Button size="sm" icon="sliders" label="Open the setting that switches search by meaning on" onClick={() => props.onSetting(setting)}>
            Open the setting
          </Button>
        ) : null}
      </p>
      {found.queries.map((answer) => {
        const words = foundWords(answer);
        return (
          <section key={answer.query} class="lah-lore-query" data-lah-lore-query={answer.query} data-hits={answer.hits.length}>
            <h4 class="lah-lore-query-head">
              <strong>{`“${answer.query}”`}</strong>
              {words !== null ? <span class="lah-small lah-muted lah-num">{words}</span> : null}
            </h4>
            {words === null ? (
              <p class="lah-lead" data-lah-lore-nohits>
                {noHitsWords(answer.query)}
              </p>
            ) : (
              <ol class="lah-lore-hits" aria-label={`Entries found for ${answer.query}`}>
                {answer.hits.map((hit) => (
                  <li key={hit.entryId} class="lah-lore-hit" data-lah-hit={hit.entryId} data-by={hit.by.join(" ")} data-current={props.shown === hit.entryId || undefined}>
                    <button type="button" class="lah-lore-hit-open" aria-current={props.shown === hit.entryId ? "true" : undefined} onClick={() => props.onOpen(hit)}>
                      <span>{entryTitle({ title: hit.title, keys: [] })}</span>
                      <Icon name="chevron-right" size={16} class="lah-chev" />
                    </button>
                    <StateMark state={hit.state} />
                    <span class="lah-lore-match">{`${hit.book} · ${matchWords(hit, answer.query)}`}</span>
                    {hit.lines.length > 0 ? (
                      <ul class="lah-lore-lines">
                        {hit.lines.map((line) => (
                          <li key={line.line} class="lah-lore-line">
                            <Marked text={line.text} words={hit.words} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}
      {all !== null ? (
        <div class="lah-actions">
          <Button size="sm" icon="chevron-down" disabled={search.status === "searching"} onClick={() => props.onAll(all)}>
            Show every entry found
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The entries by book, under the filters: each row a press that opens its entry. */
function Entries(props: { view: LoreView; filter: LoreFilter; shown: string | null; chatOff: boolean; onFilter(next: LoreFilter): void; onOpen(id: string): void; onHome(): void }) {
  const { view } = props;
  const filter = filterFor(view, props.filter);
  const groups = groupsOf(view, filter);
  const books = bookChoices(view, filter);
  return (
    <div class="lah-lore-entries" data-lah-lore-entries data-lah-lore-turn={view.last === null ? "none" : "last"}>
      {view.last === null ? (
        <Banner
          tone="info"
          title="LumiAH hasn't answered in this chat yet"
          actions={
            props.chatOff ? (
              <Button icon="home" onClick={props.onHome}>
                Open Home
              </Button>
            ) : undefined
          }
        >
          {props.chatOff
            ? "It is switched off for this chat: its switch is on Home. After its first reply here, each entry says whether it was in the prompt, added, or left out."
            : "After its first reply here, each entry says whether it was in the prompt, added, or left out. Until then an entry is only switched off or not."}
        </Banner>
      ) : (
        <p class="lah-lead lah-small">How each entry stood for the last reply. Lumiverse puts entries in the prompt by their keys; LumiAH's main agent can add one, or leave one out, before the reply is written.</p>
      )}
      <div class="lah-lore-filters">
        <div class="lah-chips" role="group" aria-label="Show the entries in one state" data-lah-lore-filter={filter.state ?? "all"}>
          {stateChips(view, filter).map((chip) => (
            <Chip key={chip.state ?? "all"} pressed={chip.pressed} onClick={() => props.onFilter({ ...filter, state: chip.pressed ? null : chip.state })}>
              {chip.icon !== null ? <Icon name={chip.icon} size={14} /> : null}
              <span data-lah-lore-chip={chip.state ?? "all"}>{chip.label}</span>
              <span class="lah-lore-chip-count">{chip.count}</span>
            </Chip>
          ))}
        </div>
        {/* One book needs no choice among books. */}
        {books.length > 2 ? <Select label="Show the entries of one book" value={filter.book ?? ""} options={books} onChange={(id) => props.onFilter({ ...filter, book: id === "" ? null : id })} /> : null}
      </div>
      {groups.length === 0 ? (
        <Empty
          icon="filter"
          action={
            <Button icon="close" onClick={() => props.onFilter(NO_LORE_FILTER)}>
              Clear the filters
            </Button>
          }
        >
          <span data-lah-lore-nothing>{nothingWords(view, filter)}</span>
        </Empty>
      ) : (
        groups.map((group) => (
          <Section key={group.book.id} title={group.book.name} aside={<span class="lah-small lah-muted lah-num">{isFiltered(filter) ? `${group.rows.length} of ${group.book.entries}` : `${group.book.entries} ${group.book.entries === 1 ? "entry" : "entries"}`}</span>} flush id={`book:${group.book.id}`}>
            {group.book.description !== "" ? <p class="lah-lore-about">{group.book.description}</p> : null}
            {group.rows.length === 0 ? <p class="lah-lore-about">This book has no entries.</p> : null}
            {group.rows.map((row) => {
              const why = rowWhy(row);
              return (
                <button key={row.entryId} type="button" class="lah-navrow lah-lore-row" data-lah-lore-row={row.entryId} data-state={row.state} aria-current={props.shown === row.entryId ? "true" : undefined} onClick={() => props.onOpen(row.entryId)}>
                  <span class="lah-navrow-text">
                    <span class="lah-navrow-title">{entryTitle(row)}</span>
                    <span class="lah-lore-standing">
                      <StateMark state={row.state} />
                      {why !== null ? <span class="lah-lore-why">{why}</span> : null}
                    </span>
                    <span class="lah-navrow-sub">{rowSub(row)}</span>
                  </span>
                  <Icon name="chevron-right" size={16} class="lah-chev" />
                </button>
              );
            })}
          </Section>
        ))
      )}
    </div>
  );
}

/** An entry whole: how it stood for the last reply, its facts, and its text, with the words of the search that led here marked. */
function EntryPane(props: { opened: Opened; row: LoreRow | null; book: string | null; answered: boolean; marks: readonly string[]; onClose(): void; onAgain(): void }) {
  const { opened, row } = props;
  const back = (
    <span class="lah-back">
      <IconButton icon="chevron-left" label="Back to the lore" onClick={props.onClose} />
    </span>
  );
  const again = (
    <Button icon="refresh" onClick={props.onAgain}>
      Try again
    </Button>
  );
  if (row === null)
    return (
      <div class="lah-lore-entry" data-lah-lore-open={opened.id} data-status={opened.status}>
        <div class="lah-pane-head">{back}</div>
        {opened.status === "loading" ? (
          <Empty icon="hourglass">Reading the entry…</Empty>
        ) : (
          <Empty
            icon="alert"
            title={opened.status === "gone" ? "That entry isn't in this chat's books" : "The entry couldn't be read"}
            action={
              <>
                {opened.status === "gone" ? null : again}
                <Button icon="list" onClick={props.onClose}>
                  Back to the lore
                </Button>
              </>
            }
          >
            {opened.message}
          </Empty>
        )}
      </div>
    );
  const why = rowWhy(row);
  return (
    <div class="lah-lore-entry" data-lah-lore-open={row.entryId} data-status={opened.status} data-state={row.state}>
      <div class="lah-pane-head">
        {back}
        <span class="lah-pane-title">
          <strong class="lah-h">{entryTitle(row)}</strong>
          <span class="lah-lore-standing">
            <StateMark state={row.state} />
            {why !== null ? <span class="lah-lore-why">{why}</span> : null}
          </span>
        </span>
      </div>
      <p class="lah-lead">{stateAbout(row.state, props.answered)}</p>
      <dl class="lah-lore-facts">
        {entryFacts(row, props.book).map((fact) => (
          <div key={fact.label} class="lah-lore-fact">
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {opened.status === "ready" ? (
        <Section title="Its text" id="entry-text">
          {opened.text.trim() === "" ? (
            <p class="lah-lead">This entry has no text.</p>
          ) : (
            <p class="lah-lore-text" data-lah-lore-text>
              <Marked text={opened.text} words={props.marks} />
            </p>
          )}
        </Section>
      ) : opened.status === "loading" ? (
        <Empty icon="hourglass">Reading its text…</Empty>
      ) : (
        <Banner tone="neg" title={opened.status === "gone" ? "Its text is gone: the chat's books no longer have this entry" : "Its text couldn't be read"} actions={opened.status === "gone" ? undefined : again}>
          {opened.message}
        </Banner>
      )}
      <p class="lah-small lah-dim">{`The agents' tools name this entry ${row.short}.`}</p>
    </div>
  );
}

/** Search by meaning as it stands for the chat: what it is, its one switch with what that sends and to whom, how much is embedded, what it has cost, and the one thing to do about it where there is one. */
function Meaning(props: { status: EmbeddingStatus; busy: boolean; switching: boolean; onEmbed(): void; onSwitch(on: boolean): void; onSetting(link: SettingLink): void }) {
  const meaning = meaningOf(props.status);
  const spent = meaning.spent;
  return (
    <Section title="Search by meaning" id="meaning">
      <p class="lah-lead">Finds entries and messages that say the same in other words. For that each text is embedded: a model you set up in Lumiverse turns it into numbers that can be compared, which costs what its provider charges.</p>
      {meaning.toggle !== null ? (
        <div data-lah-lore-switch={meaning.toggle.on ? "on" : "off"}>
          <Switch checked={meaning.toggle.on} label="Search by meaning" help={meaning.toggle.sends} disabled={props.switching} onChange={props.onSwitch} />
        </div>
      ) : null}
      <p class="lah-lore-meaning" data-lah-lore-meaning={meaning.standing} data-tone={meaning.tone} role="status">
        {meaning.standing === "working" ? <span class="lah-pulse" aria-hidden="true" /> : <Icon name={meaning.icon} size={18} />}
        <span>{meaning.words}</span>
      </p>
      {meaning.embedded !== null ? <p class="lah-num">{meaning.embedded}</p> : null}
      {spent !== null ? (
        <div class="lah-lore-spent">
          {spent.fraction !== null ? (
            <div class="lah-meter" role="meter" aria-label="Embedded in the last 24 hours, of the daily limit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(spent.fraction * 100)} aria-valuetext={spent.today} data-reached={spent.reached || undefined}>
              <span style={{ "--lah-fill": String(spent.fraction) }} />
            </div>
          ) : null}
          <p class="lah-small lah-num">{spent.today}</p>
          <p class="lah-small lah-num">{spent.all}</p>
          {meaning.model !== null ? <p class="lah-small lah-muted">{`Embedded with ${meaning.model}.`}</p> : null}
          {meaning.priced ? null : (
            <p class="lah-small lah-muted" data-lah-lore-noprice>
              No price is set for that model, so no cost is shown.
            </p>
          )}
        </div>
      ) : null}
      <div class="lah-actions">
        {meaning.canEmbed ? (
          <Button icon="bolt" busy={props.busy} onClick={props.onEmbed}>
            Embed what waits now
          </Button>
        ) : null}
        {spent !== null && !meaning.priced ? (
          <Button icon="coins" label="Set the price of the embedding model in Settings" onClick={() => props.onSetting(MEANING_SETTINGS.price)}>
            Set a price
          </Button>
        ) : null}
        {meaning.standing === "capped" ? (
          <Button icon="sliders" label="Open the daily limit on embedding in Settings" onClick={() => props.onSetting(MEANING_SETTINGS.cap)}>
            The daily limit
          </Button>
        ) : null}
        <Button icon="sliders" label="Open the settings of search by meaning" onClick={() => props.onSetting(MEANING_SETTINGS.enabled)}>
          Its settings
        </Button>
      </div>
    </Section>
  );
}

export function LorePage() {
  const app = useApp();
  const chatId = useShownChat();
  const open = useSelect(app.nav, (n) => n.lore);
  const kept = useSelect(keptOf(app), (k) => k);
  const chat = useChatView(chatId);
  const replying = useSelect(app.client.state, (s) => chatId !== null && (s?.running.some((r) => isReply(r.kind) && r.chatId === chatId) ?? false));
  const [read, setRead] = useState<Read>(LOADING);
  const [search, setSearch] = useState<Search>(NO_SEARCH);
  /** Search was pressed over an empty box. */
  const [empty, setEmpty] = useState(false);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [again, setAgain] = useState(0);
  /** The words the search that led to the entry open matched, marked in its text. */
  const [marks, setMarks] = useState<{ id: string; words: readonly string[] } | null>(null);
  const [embedding, embed] = useBusy();
  const [switching, flip] = useBusy();
  const list = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  /** The chat whose lore shows: an answer for another is dropped. */
  const shownChat = useRef(chatId);
  /** The read and the search that count: a slower answer to an earlier one is dropped. */
  const asked = useRef(0);
  const searched = useRef(0);

  const readLore = (chat: string): void => {
    const mine = (asked.current += 1);
    app.client.request("lah.lore.get", { chatId: chat }).then(
      (view) => mine === asked.current && setRead({ status: "ready", view, message: "" }),
      (error: unknown) => mine === asked.current && setRead((held) => ({ ...held, status: "failed", message: errorWords(error) })),
    );
  };
  // Another chat has other books: what was read and found is the last chat's, and so is the entry open (unless the page has only just shown, led here to one).
  useEffect(() => {
    if (shownChat.current !== chatId && app.nav.get().lore !== null) app.nav.update((n) => ({ ...n, lore: null }));
    shownChat.current = chatId;
    asked.current += 1;
    searched.current += 1;
    setRead(LOADING);
    setSearch(NO_SEARCH);
    if (chatId === null) return;
    readLore(chatId);
    return app.client.onBack(() => readLore(chatId));
  }, [chatId]);
  // A reply of this chat that just ended has changed which entries were in the prompt.
  const wasReplying = useRef(replying);
  useEffect(() => {
    if (wasReplying.current && !replying && chatId !== null) readLore(chatId);
    wasReplying.current = replying;
  }, [replying]);
  // While texts are embedded the page asks how far that is, since nothing is pushed.
  const working = read.view?.embedding.working ?? false;
  useEffect(() => {
    if (!working || chatId === null) return;
    const timer = setInterval(() => {
      app.client.request("lah.lore.embed", { chatId, start: false }).then(
        (r) => shownChat.current === chatId && setRead((held) => (held.view !== null ? { ...held, view: { ...held.view, embedding: r.embedding } } : held)),
        () => {
          // The next look asks again; what was last read stands meanwhile.
        },
      );
    }, LOOK_AGAIN_MS);
    return () => clearInterval(timer);
  }, [working, chatId]);
  // The entry open is read whole: its row is in the list already, its text is not.
  useEffect(() => {
    if (chatId === null || open === null) {
      setOpened(null);
      return;
    }
    let live = true;
    setOpened({ status: "loading", id: open, entry: null, text: "", message: "" });
    app.client.request("lah.lore.entry", { chatId, entryId: open }).then(
      (r) => live && setOpened({ status: "ready", id: open, entry: r.entry, text: r.text, message: "" }),
      (error: unknown) => live && setOpened({ status: error instanceof UiRequestError && error.code === "not_found" ? "gone" : "failed", id: open, entry: null, text: "", message: errorWords(error) }),
    );
    return () => {
      live = false;
    };
  }, [chatId, open, again]);

  const view = read.view;
  const listed = view !== null && view.books.length > 0;
  /** The entry's row in the list, where the list shows it. */
  const rowOf = (id: string): Element | null => list.current?.querySelector(`[data-lah-lore-row="${CSS.escape(id)}"]`) ?? null;
  /** Where the page stood when an entry was opened from it: Back returns there. */
  const leftAt = useRef<number | null>(null);
  const wasOpen = useRef<string | null>(null);
  // An entry opens at its head: on a phone it takes the list's place, and the panel may be scrolled far down the list. Back returns to where the list was left; an entry another page led to has no such place, so its row is brought into view.
  useLayoutEffect(() => {
    const scroller = list.current ? scrollParent(list.current) : null;
    if (open !== null) revealInScroller(detail.current, "start");
    else if (wasOpen.current !== null) {
      if (scroller && leftAt.current !== null) scroller.scrollTop = leftAt.current;
      else revealInScroller(rowOf(wasOpen.current), "center");
      leftAt.current = null;
    }
    wasOpen.current = open;
  }, [open]);
  // Beside the list, the row of the entry open is brought into view: a search result or another page may have led to one far down it. On a phone the list is put away while an entry is open, and a row that isn't drawn has no place to scroll to.
  useLayoutEffect(() => {
    const row = open !== null && listed ? rowOf(open) : null;
    if (row && row.getClientRects().length > 0) revealInScroller(row, "nearest");
  }, [open, listed]);

  const keep = (next: Partial<LoreKept>): void => keptOf(app).update((k) => ({ ...k, ...next }));
  const openEntry = (id: string, words: readonly string[] | null): void => {
    const scroller = list.current ? scrollParent(list.current) : null;
    leftAt.current = scroller ? scroller.scrollTop : null;
    setMarks(words !== null ? { id, words } : null);
    app.nav.update((n) => ({ ...n, lore: id }));
  };
  const close = (): void => app.nav.update((n) => ({ ...n, lore: null }));
  const toSetting = (link: SettingLink): void => openSetting(app, link);
  const runSearch = (queries: string[], limit: number | null): void => {
    if (chatId === null) return;
    const mine = (searched.current += 1);
    setSearch((held) => ({ ...held, status: "searching", asked: queries, message: "" }));
    app.client.request("lah.lore.search", { chatId, queries, ...(limit !== null ? { limit } : {}) }).then(
      (found) => mine === searched.current && setSearch({ status: "ready", asked: queries, found, message: "" }),
      (error: unknown) => mine === searched.current && setSearch({ status: "failed", asked: queries, found: null, message: errorWords(error) }),
    );
  };
  const searchBox = (): void => {
    const queries = queriesOf(kept.box);
    setEmpty(queries.length === 0);
    if (queries.length > 0) runSearch(queries, null);
    else box.current?.querySelector("input")?.focus();
  };
  const typed = (value: string): void => {
    keep({ box: value });
    setEmpty(false);
    // An emptied box asks for nothing: what the last search found goes with it.
    if (value !== "") return;
    searched.current += 1;
    setSearch(NO_SEARCH);
  };
  const startEmbedding = (): void =>
    embed(async () => {
      if (chatId === null) return;
      try {
        const r = await app.client.request("lah.lore.embed", { chatId, start: true });
        if (shownChat.current === chatId) setRead((held) => (held.view !== null ? { ...held, view: { ...held.view, embedding: r.embedding } } : held));
      } catch (error) {
        app.fail(error);
      }
    });
  // The one switch: it sets the setting where the settings shown keep it, then reads how search by meaning stands now. Where they don't hold it, its place in Settings opens instead.
  const switchMeaning = (on: boolean): void =>
    flip(async () => {
      if (chatId === null) return;
      const settings = app.client.state.get()?.settings;
      const place = settings ? settingPlace(settings.schema, SETTING_LINKS[MEANING_SETTINGS.enabled]) : null;
      if (place === null) return toSetting(MEANING_SETTINGS.enabled);
      try {
        const result = await app.client.request("lah.settings.set", { set: [{ path: place, value: on }], reset: [] });
        app.client.patch({ settings: result.settings });
        const r = await app.client.request("lah.lore.embed", { chatId, start: false });
        if (shownChat.current === chatId) setRead((held) => (held.view !== null ? { ...held, view: { ...held.view, embedding: r.embedding } } : held));
        app.toast(on ? "Search by meaning is on." : "Search by meaning is off: nothing more is sent.");
      } catch (error) {
        app.fail(error);
      }
    });
  const readAgain = (): void => {
    if (chatId === null) return;
    if (view === null) setRead(LOADING);
    readLore(chatId);
  };

  if (chatId === null)
    return (
      <div class="lah-lore-one" data-lah-view="lore" data-lah-lore="nochat">
        <ChatBar />
        <Empty icon="book" title="No chat is open">
          Lore shows a chat's world books: which entries reached its last reply and why, and a search that finds what an agent would find. Open a chat in Lumiverse, or pick one above.
        </Empty>
      </div>
    );
  if (view === null)
    return (
      <div class="lah-lore-one" data-lah-view="lore" data-lah-lore={read.status === "failed" ? "failed" : "loading"}>
        <ChatBar />
        {read.status === "failed" ? (
          <Empty
            icon="alert"
            title="The lore couldn't be read"
            action={
              <Button icon="refresh" onClick={readAgain}>
                Try again
              </Button>
            }
          >
            {read.message}
          </Empty>
        ) : (
          <Empty icon="hourglass">Reading this chat's lore…</Empty>
        )}
      </div>
    );
  const stale =
    read.status === "failed" ? (
      <Banner
        tone="warn"
        title="The lore couldn't be read again"
        actions={
          <Button size="sm" icon="refresh" onClick={readAgain}>
            Try again
          </Button>
        }
      >
        {`${read.message} What shows is as it was last read.`}
      </Banner>
    ) : null;
  const meaning = <Meaning status={view.embedding} busy={embedding} switching={switching} onEmbed={startEmbedding} onSwitch={switchMeaning} onSetting={toSetting} />;
  if (!listed)
    return (
      <div class="lah-lore-one" data-lah-view="lore" data-lah-lore="nobooks">
        <ChatBar />
        {stale}
        <Empty
          icon="book"
          title="This chat has no world books"
          action={
            <Button icon="refresh" onClick={readAgain}>
              Read again
            </Button>
          }
        >
          Lore is what a reply must stay true to: the places, the people and the rules of your world. Books are attached in Lumiverse, to a chat, its character or your persona. Attach one, and its entries show here with which of them reached the last reply.
        </Empty>
        {meaning}
      </div>
    );
  const row = open !== null ? (view.entries.find((e) => e.entryId === open || e.short === open) ?? opened?.entry ?? null) : null;
  const shown = row?.entryId ?? open;
  return (
    <div class="lah-split lah-lore" data-pane={open !== null ? "detail" : "list"} data-lah-view="lore" data-lah-lore="ready" data-lah-entry={shown ?? undefined}>
      <div class="lah-split-list" ref={list}>
        <ChatBar aside={<IconButton icon="refresh" label="Read the lore again" onClick={readAgain} />} />
        {stale}
        <p class="lah-lore-count" data-lah-lore-count>
          {countsLine(view, app.now())}
        </p>
        <div class="lah-lore-search" data-lah-lore-search={search.status}>
          <div class="lah-lore-box" ref={box}>
            <SearchField value={kept.box} label="Search this chat's lore as an agent does" placeholder="Search the lore: night key" onInput={typed} onEnter={searchBox} />
            <Button variant="primary" icon="search" busy={search.status === "searching"} onClick={searchBox}>
              Search
            </Button>
          </div>
          {empty ? (
            <span class="lah-field-error" role="alert">
              <Icon name="alert" size={16} />
              Type a word or two to look for, then press Search.
            </span>
          ) : (
            <span class="lah-field-help">Runs the agents' own search over these books. Several searches at once: separate them with ;</span>
          )}
        </div>
        <Found
          search={search}
          shown={shown}
          onOpen={(hit) => openEntry(hit.entryId, hit.words)}
          onAll={(limit) => runSearch(search.asked, limit)}
          onAgain={() => runSearch(search.asked, null)}
          onSetting={toSetting}
        />
        <Entries view={view} filter={kept.filter} shown={shown} chatOff={chat !== null && !chat.on} onFilter={(filter) => keep({ filter })} onOpen={(id) => openEntry(id, null)} onHome={() => app.nav.update((n) => ({ ...n, page: "home" }))} />
        {meaning}
      </div>
      <div class="lah-split-detail" ref={detail}>
        {open !== null && opened !== null ? (
          <EntryPane
            opened={opened}
            row={row}
            book={row !== null ? (view.books.find((b) => b.id === row.bookId)?.name ?? null) : null}
            answered={view.last !== null}
            marks={marks !== null && marks.id === shown ? marks.words : []}
            onClose={close}
            onAgain={() => setAgain(again + 1)}
          />
        ) : open !== null ? (
          <Empty icon="hourglass">Reading the entry…</Empty>
        ) : (
          <Empty icon="book" title="Pick an entry to read it whole">
            Press an entry in the list, or one a search found: its text, its keys and how it stood for the last reply show here.
          </Empty>
        )}
      </div>
    </div>
  );
}
