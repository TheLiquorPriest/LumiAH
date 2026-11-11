// The Guidance page (DESIGN §12): the markdown every agent is given as part of its instructions, in
// the order it is given: the user's level, the middle one (a plain chat's character's), the chat's.
// Each is edited in place and saved as a versioned write, so a save that meets someone else's
// shows theirs against the user's, as on the Workspace page. Text typed and not yet saved is a
// draft kept outside the page (workspace-drafts.ts): a level's editor is open exactly while one is.
// A level with nothing in it opens with an example of what belongs there, to start from or write
// over; and where a chat is shown, the page leads with the way to write that chat's level, since
// a reply that got something wrong is what brings most people here.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { GuidanceLevel, GuidanceView } from "../../../shared/ui";
import { errorWords, useApp } from "../app";
import { ChatBar, useShownChat } from "../chat";
import { Badge, Banner, Button, CopyButton, Disclosure, Empty, IconButton, useBusy } from "../components";
import { count } from "../format";
import { Icon } from "../icons";
import { revealInScroller } from "../scroll";
import { openSetting } from "../setting-links";
import { useSelect } from "../store";
import { draftsOf, putDraft } from "../workspace-drafts";
import { agentsEditWords, boundOf, draftsElsewhere, GUIDANCE_CHAT_LEAD, GUIDANCE_EXAMPLE, guidanceCutWords, guidanceDraftKey, isDirty, isStale, levelEmptyWords, levelFacts, levelName, levelWhose, waitingWords, wroteWords } from "../workspace-model";
import { BoundLine, ConflictBox, EditBox, isConflict, refusalOf } from "./workspace-parts";

type Read = { status: "reading" } | { status: "ready"; view: GuidanceView } | { status: "failed"; message: string };

/** One level: whose it is and who is given it, when it was last written, its text against its limit, and its editor; an example of what to write where it holds nothing. */
function Level(props: { chatId: string | null; place: number; level: GuidanceLevel; limit: number; agentsEdit: boolean; onSaved(view: GuidanceView): void; onRead(): Promise<void> }) {
  const app = useApp();
  const { chatId, level, limit } = props;
  const key = guidanceDraftKey(chatId, level.id);
  const draft = useSelect(draftsOf(app), (d) => d.get(key) ?? null);
  const [refused, setRefused] = useState<string | null>(null);
  const [saving, save] = useBusy();
  const now = app.now();
  const name = levelName(level);
  const cut = guidanceCutWords(level.text, limit);
  // A draft nothing was typed into holds no text of the user's: where the level moved on, the draft follows it, and no conflict is made of it.
  useEffect(() => {
    if (draft !== null && !isDirty(draft) && isStale(draft, level.hash)) putDraft(app, key, { base: level.hash, from: level.text, text: level.text });
  }, [draft, level.hash]);
  const drop = async (title: string, confirm: string): Promise<void> => {
    if (draft !== null && isDirty(draft) && !(await app.host.confirm({ title, message: `What you typed into ${name} is not saved, and dropping it can't be undone.`, confirm, danger: true }))) return;
    putDraft(app, key, null);
    setRefused(null);
  };
  const write = (text: string, base: string | null, said: string): void =>
    save(async () => {
      setRefused(null);
      try {
        const view = await app.client.request("lah.guidance.set", { chatId, level: level.id, text, base });
        putDraft(app, key, null);
        props.onSaved(view);
        app.toast(said);
      } catch (error) {
        setRefused(refusalOf(error));
        // Someone else wrote the level meanwhile: read it again, and the draft, which is kept, shows against theirs.
        if (isConflict(error)) await props.onRead();
      }
    });
  const facts = levelFacts(level, now);
  return (
    <li class="lah-gd-level" data-lah-level={level.id} data-lah-level-state={draft !== null ? "editing" : level.text === "" ? "empty" : "written"}>
      <div class="lah-gd-head">
        <span class="lah-gd-n" role="img" aria-label={`Given ${["first", "second", "third"][props.place - 1] ?? `as number ${props.place}`}`}>
          {props.place}
        </span>
        <span class="lah-gd-title">
          <strong class="lah-h">{level.label}</strong>
          <span class="lah-small lah-muted" data-lah-level-whose>
            {levelWhose(level)}
          </span>
        </span>
        {level.editable ? null : <Badge>read only</Badge>}
      </div>
      {facts !== null ? (
        <p class="lah-small lah-muted lah-num" data-lah-level-facts>
          {facts}
        </p>
      ) : null}
      {level.id === "chat" ? (
        <p class="lah-line" data-lah-agents-edit>
          <Icon name="agent" size={14} />
          <span>{agentsEditWords(props.agentsEdit)}</span>
          <Button size="sm" variant="ghost" icon="sliders" label="Open the setting that says whether agents may edit the chat's guidance" onClick={() => openSetting(app, "guidanceAgentsEdit")}>
            Change
          </Button>
        </p>
      ) : null}
      {!level.editable ? (
        <p class="lah-line" data-lah-locked>
          <Icon name="shield" size={14} />
          <span>{level.locked ?? "This level can't be edited on this page."}</span>
        </p>
      ) : null}
      {draft !== null ? (
        isStale(draft, level.hash) ? (
          <ConflictBox
            what={name.replace(/^./, (first) => first.toUpperCase())}
            who={level.hash === null ? "It holds nothing now." : wroteWords(level, now)}
            said={refused}
            theirs={level.hash === null ? null : level.text}
            yours={draft.text}
            busy={saving}
            onKeep={() => write(draft.text, level.hash, "Saved: your text is the newest version.")}
            onTake={() => void drop("Drop your text and take theirs?", "Drop my text")}
            onGoOn={() => {
              putDraft(app, key, { ...draft, base: level.hash, from: level.text });
              setRefused(null);
            }}
          />
        ) : (
          <EditBox
            label={`The text of ${name}`}
            value={draft.text}
            saved={level.hash === null ? null : level.text}
            bound={{ label: "Length", bound: boundOf(draft.text.length, limit, "character") }}
            problem={null}
            warning={guidanceCutWords(draft.text, limit)}
            refused={refused}
            dirty={isDirty(draft)}
            busy={saving}
            onInput={(text) => putDraft(app, key, { ...draft, text })}
            onSave={() => write(draft.text, draft.base, "Saved: agents are given it from the next reply.")}
            onCancel={() => void drop("Drop your edits?", "Drop my edits")}
          />
        )
      ) : level.text === "" ? (
        <>
          <p class="lah-lead">{levelEmptyWords(level)}</p>
          {level.editable ? (
            <>
              <div class="lah-gd-example" data-lah-example>
                <span class="lah-small lah-muted">For example, for a story in a harbour town:</span>
                <pre class="lah-text lah-ws-text">{GUIDANCE_EXAMPLE[level.id]}</pre>
              </div>
              <div class="lah-actions">
                <Button variant="primary" icon="edit" label={`Start ${name} from this example`} onClick={() => putDraft(app, key, { base: level.hash, from: level.text, text: GUIDANCE_EXAMPLE[level.id] })}>
                  Start from this example
                </Button>
                <Button icon="plus" label={`Write ${name} from nothing`} onClick={() => putDraft(app, key, { base: level.hash, from: level.text, text: level.text })}>
                  Write your own
                </Button>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          <pre class="lah-text lah-ws-text" data-lah-level-text>
            {level.text}
          </pre>
          <BoundLine label="Length" bound={boundOf(level.text.length, limit, "character")} />
          {cut !== null ? (
            <p class="lah-line lah-is-warn">
              <Icon name="alert" size={14} />
              <span>{cut}</span>
            </p>
          ) : null}
          <div class="lah-actions">
            {level.editable ? (
              <Button icon="edit" label={`Edit ${name}`} onClick={() => putDraft(app, key, { base: level.hash, from: level.text, text: level.text })}>
                Edit
              </Button>
            ) : null}
            <CopyButton text={level.text} label={`Copy the text of ${name}`} size="md" variant="secondary">
              Copy
            </CopyButton>
          </div>
        </>
      )}
    </li>
  );
}

export function GuidancePage() {
  const app = useApp();
  const chatId = useShownChat();
  const drafts = useSelect(draftsOf(app), (d) => d);
  const [state, setState] = useState<Read>({ status: "reading" });
  /** The read that counts: a slower answer to an earlier one, or to another chat's, is dropped. */
  const asked = useRef(0);
  const read = async (): Promise<void> => {
    asked.current += 1;
    const mine = asked.current;
    try {
      const view = await app.client.request("lah.guidance.get", { chatId });
      if (mine === asked.current) setState({ status: "ready", view });
    } catch (error) {
      if (mine !== asked.current) return;
      // What the page holds still shows when reading it again fails; the failure is said beside it.
      setState((held) => (held.status === "ready" ? held : { status: "failed", message: errorWords(error) }));
      app.fail(error);
    }
  };
  useEffect(() => {
    // Another chat's levels are not this one's: none of them shows while this one's are read.
    setState({ status: "reading" });
    void read();
    return app.client.onBack(() => void read());
  }, [chatId]);
  const waiting = waitingWords(draftsElsewhere(drafts, chatId));
  const levels = useRef<HTMLOListElement>(null);
  /** Counts the presses that ask for the chat's level: each brings it into view once its editor has opened. */
  const [toChat, setToChat] = useState(0);
  useLayoutEffect(() => {
    if (toChat > 0) revealInScroller(levels.current?.querySelector("[data-lah-level=chat]") ?? null, "start");
  }, [toChat]);
  const chatLevel = state.status === "ready" && chatId !== null ? (state.view.levels.find((l) => l.id === "chat" && l.editable) ?? null) : null;
  const chatKey = guidanceDraftKey(chatId, "chat");
  const writeForChat = (level: GuidanceLevel): void => {
    // What is being typed there already is gone on with; else the editor opens on what the level holds.
    if (!drafts.has(chatKey)) putDraft(app, chatKey, { base: level.hash, from: level.text, text: level.text });
    setToChat((n) => n + 1);
  };
  return (
    <>
      <ChatBar aside={<IconButton icon="refresh" label="Read the guidance again" onClick={() => void read()} />} />
      <p class="lah-lead" data-lah-view="guidance">
        Write here what every agent should always keep to. They are given all of it before every reply, yours first and this chat's last.
      </p>
      {chatLevel !== null ? (
        <div class="lah-gd-start" data-lah-guidance-start>
          <span>{GUIDANCE_CHAT_LEAD}</span>
          <Button variant="primary" icon="edit" label="Write this chat's guidance" onClick={() => writeForChat(chatLevel)}>
            {drafts.has(chatKey) ? "Go on writing for this chat" : "Write for this chat"}
          </Button>
        </div>
      ) : null}
      {chatId === null ? (
        <Banner tone="info" title="No chat is open">
          Only your own level shows: it is given in every chat. The character's level and the chat's belong to a chat: open one in Lumiverse, or pick one above.
        </Banner>
      ) : null}
      {waiting !== null ? (
        <p class="lah-line" data-lah-waiting>
          <Icon name="info" size={14} />
          <span>{waiting}</span>
        </p>
      ) : null}
      {state.status === "reading" ? (
        <Empty icon="hourglass">Reading the guidance…</Empty>
      ) : state.status === "failed" ? (
        <Empty
          icon="alert"
          title="The guidance couldn't be read"
          action={
            <Button icon="refresh" onClick={() => void read()}>
              Try again
            </Button>
          }
        >
          {state.message}
        </Empty>
      ) : (
        <>
          <ol ref={levels} class="lah-gd-levels" aria-label="The levels of guidance, in the order an agent is given them">
            {state.view.levels.map((level, i) => (
              <Level key={`${chatId ?? ""}|${level.id}`} chatId={chatId} place={i + 1} level={level} limit={state.view.limit} agentsEdit={state.view.agentsEdit} onSaved={(view) => setState({ status: "ready", view })} onRead={read} />
            ))}
          </ol>
          <Disclosure summary="How long a level may be">
            <p class="lah-line" data-lah-guidance-limit>
              <Icon name="info" size={14} />
              <span>{`Each level may hold ${count(state.view.limit)} characters. A longer one is given cut: the agent gets its start and is told the rest was left out.`}</span>
              <Button icon="sliders" label="Open the guidance's length in Settings" onClick={() => openSetting(app, "guidanceLength")}>
                Open the setting
              </Button>
            </p>
          </Disclosure>
        </>
      )}
    </>
  );
}
