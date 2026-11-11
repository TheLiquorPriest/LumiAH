// What Home and the Runtime page share of setup and of where a chat runs (DESIGN §25): a chat's
// switch with its place beside it and how it stands under it, the asking for permissions, and a
// numbered step. The decisions are setup-model.ts's; these send the requests and say what came of
// them.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ChatStoryView, ChatView, PermissionNeed, RunPlace, StorySetting } from "../../shared/ui";
import { useApp } from "./app";
import { chatLabel } from "./chat";
import { Banner, Button, Disclosure, Seg, type SegOption, Switch, useBusy } from "./components";
import { counted } from "./format";
import { Icon, type IconName } from "./icons";
import { asksWords, chatStanding, grantReason, neededPermissions, PLACE_ABOUT, PLACE_LABEL, type StepAt } from "./setup-model";
import { useSelect } from "./store";
import { storyChosen, storyRows, storySummary, storyWhy } from "./story-model";

const PLACES: readonly SegOption<RunPlace>[] = [
  { value: "builtin", label: PLACE_LABEL.builtin },
  { value: "runtime", label: PLACE_LABEL.runtime },
];

const STANDING_ICON: Readonly<Record<"pos" | "neutral" | "warn", IconName>> = { pos: "check", neutral: "info", warn: "alert" };

/**
 * A chat's switch: whether LumiAH is used in it, how that stands in a line (with the one press that
 * mends it where something is wrong), and, once it is on, where its replies are prepared. Switching
 * it on while Lumiverse hasn't yet allowed LumiAH what it needs asks for that first, so a newcomer
 * has one thing to press. A chat another extension holds has no switch here: it says whose it is,
 * and offers to take it over. `fold` keeps the choice of place under a line that says where it runs
 * (Home does: few change it); a list of chats shows the choice itself, and says what each place is
 * once above them. A chat its extension plays only in a runtime has no choice of place: it says so.
 */
export function ChatSwitch(props: { chat: ChatView; open: boolean; title?: string; fold?: boolean; onChanged?(chat: ChatView): void; children?: ComponentChildren }) {
  const app = useApp();
  const state = useSelect(app.client.state, (s) => s);
  const [busy, run] = useBusy();
  // The runtime was chosen while none is there to choose: the page says what one is and where to set it up, rather than refusing.
  const [asked, setAsked] = useState(false);
  // The switch was turned on while a permission LumiAH needs was missing: Lumiverse is asked, and the chat is switched on once it has allowed them.
  const [wanted, setWanted] = useState(false);
  const grant = useGrant();
  const { chat } = props;
  const name = chatLabel(chat);
  const needed = state === null ? 0 : neededPermissions(state).length;
  const set = (on: boolean, place: RunPlace | undefined, said: string): void =>
    run(async () => {
      try {
        const result = await app.client.request("lah.chat.set", { chatId: chat.chatId, on, ...(place !== undefined ? { place } : {}) });
        props.onChanged?.(result.chat);
        setAsked(false);
        app.toast(said);
      } catch (error) {
        app.fail(error);
      }
    });
  const switchOn = (): void => set(true, undefined, `LumiAH is on for ${name}: it prepares the next reply.`);
  const takeOver = (other: string): void =>
    run(async () => {
      // Two can't both prepare a reply: taking a chat from an extension that is still installed leaves that one's pages saying what is no longer so, which is why it is asked first.
      const agreed = await app.host.confirm({ title: "Take this chat over?", message: `${other} stops preparing ${name}'s replies, and this page holds its switch from now on. Do it only if ${other} is no longer installed.`, confirm: "Take it over" });
      if (!agreed) return;
      try {
        const result = await app.client.request("lah.chat.takeover", { chatId: chat.chatId });
        props.onChanged?.(result.chat);
        app.toast(result.chat.on ? `${name} is taken over: LumiAH prepares its next reply.` : `${name} is taken over. Switch LumiAH on for it here.`);
      } catch (error) {
        app.fail(error);
      }
    });
  useEffect(() => {
    if (!wanted || grant.busy) return;
    // Lumiverse didn't allow them: the switch stays off, and what to do is said under it.
    if (grant.failed !== null) return setWanted(false);
    if (needed > 0) return;
    setWanted(false);
    switchOn();
  }, [wanted, grant.busy, grant.failed, needed]);
  if (state === null) return null;
  const standing = chatStanding(chat, state);
  const missing = state.permissions;
  const turn = (on: boolean): void => {
    if (!on) return set(false, undefined, `LumiAH is off for ${name}.`);
    if (needed === 0) return switchOn();
    setWanted(true);
    // What follows says it (the chat is switched on), so the grant itself needn't.
    grant.ask(
      missing.map((p) => p.id),
      false,
    );
  };
  const choose = (place: RunPlace): void => {
    if (place === chat.place) return;
    if (place === "runtime" && !state.runtime.ready) return setAsked(true);
    set(true, place, place === "builtin" ? `${name} runs built in from its next reply.` : `${name} runs in your runtime from its next reply.`);
  };
  const only = chat.needsRuntime;
  const places =
    only !== undefined ? (
      <p class="lah-field-help" data-lah-runtime-only>
        {`${only.by} plays this chat only in your runtime: there is no built-in way for it. ${PLACE_ABOUT.runtime}`}
      </p>
    ) : (
      <>
        <Seg value={chat.place} options={PLACES} label={`Where ${name} runs`} disabled={busy} onChange={choose} />
        {props.fold === true ? (
          <ul class="lah-facts" data-lah-places>
            <li>
              <span>
                <strong>{PLACE_LABEL.builtin}.</strong> {PLACE_ABOUT.builtin}
              </span>
            </li>
            <li>
              <span>
                <strong>{PLACE_LABEL.runtime}.</strong> {PLACE_ABOUT.runtime}
              </span>
            </li>
          </ul>
        ) : null}
        {asked ? (
          <Banner
            tone="info"
            title="No runtime is set up yet"
            actions={
              <>
                <Button variant="primary" icon="link" onClick={() => app.nav.update((n) => ({ ...n, page: "runtime" }))}>
                  Set up a runtime
                </Button>
                <Button variant="ghost" onClick={() => setAsked(false)}>
                  Stay built in
                </Button>
              </>
            }
          >
            {`${PLACE_ABOUT.runtime} This chat keeps running built in until one is linked.`}
          </Banner>
        ) : null}
      </>
    );
  return (
    <div class="lah-chatswitch" data-lah-chat={chat.chatId} data-answered={standing.answered} data-place={chat.place} data-on={chat.on} data-lah-other={chat.other?.identifier}>
      {/* Where the extension plays its chats only in a runtime, its own pages switch a chat on: LumiAH's switch isn't offered. */}
      {state.runtime.only === undefined ? <Switch checked={chat.on || wanted} disabled={busy || wanted || chat.other !== undefined} label={<strong>{props.title ?? (props.open ? "Use LumiAH in this chat" : name)}</strong>} help={props.title === undefined && props.open ? name : undefined} onChange={turn} /> : <strong>{props.title ?? name}</strong>}
      {wanted ? (
        <span class="lah-chatswitch-line" data-tone="neutral" role="status">
          <Icon name="hourglass" size={16} />
          <span>Lumiverse is asking you to allow LumiAH what it needs. Agree there, and this chat is switched on.</span>
        </span>
      ) : (
        <span class="lah-chatswitch-line" data-tone={standing.tone} role={standing.tone === "warn" ? "alert" : undefined}>
          <Icon name={STANDING_ICON[standing.tone]} size={16} />
          <span>{!chat.on && !standing.answered && chat.other === undefined && state.runtime.only === undefined ? `${standing.line} Switched on, its agents read up before each reply and brief the model that writes it${chat.place === "builtin" ? ". Nothing to install." : ", in your runtime."}` : standing.line}</span>
        </span>
      )}
      {standing.takeover !== null ? (
        <div class="lah-actions">
          <Button disabled={busy} onClick={() => standing.takeover !== null && takeOver(standing.takeover)}>
            Take this chat over
          </Button>
        </div>
      ) : null}
      {needed > 0 && !wanted && chat.other === undefined ? (
        <>
          {chat.on ? (
            <div class="lah-actions">
              <Button variant="primary" icon="shield" busy={grant.busy} onClick={() => grant.ask(missing.map((p) => p.id))}>
                Allow LumiAH
              </Button>
            </div>
          ) : (
            <p class="lah-field-help" data-lah-asks>
              {asksWords(missing)}
            </p>
          )}
          <Disclosure summary={`What it asks for (${counted(missing.length, "permission")})`}>
            <PermissionList permissions={missing} />
          </Disclosure>
          <GrantHelp failed={grant.failed} todo={missing[0]?.todo ?? null} />
        </>
      ) : null}
      {standing.fix !== null ? (
        <div class="lah-actions">
          <Button variant="primary" disabled={busy} onClick={() => set(true, standing.fix?.place, standing.fix?.place === "builtin" ? `${name} runs built in from its next reply.` : `${name} is pinned to the runtime's connection again.`)}>
            {standing.fix.label}
          </Button>
        </div>
      ) : null}
      {chat.on && props.fold === true ? (
        <>
          <Disclosure class="lah-chatswitch-place" summary={`Where it runs: ${PLACE_LABEL[chat.place].toLowerCase()}`} defaultOpen={asked}>
            {places}
          </Disclosure>
          <ChatStory chatId={chat.chatId} />
        </>
      ) : chat.on ? (
        <div class="lah-chatswitch-place">
          <span class="lah-field-label">Where it runs</span>
          {places}
        </div>
      ) : null}
      {props.children}
    </div>
  );
}

/**
 * What counts as a chat's story (DESIGN §24.4), folded under a line that says whose messages it is:
 * what holds and why, then the chat's own choice of each member over Settings'. A member the
 * extension that answers the chat sets is shown as its, with no choice.
 */
function ChatStory(props: { chatId: string }) {
  const app = useApp();
  const [busy, run] = useBusy();
  const [view, setView] = useState<ChatStoryView | null>(null);
  useEffect(() => {
    let current = true;
    app.client.request("lah.chat.story.get", { chatId: props.chatId }).then(
      (result) => current && setView(result.story),
      (error: unknown) => current && app.fail(error),
    );
    return () => {
      current = false;
    };
  }, [props.chatId]);
  if (view === null || view.chatId !== props.chatId) return null;
  const choose = (member: keyof StorySetting, value: string): void =>
    run(async () => {
      try {
        setView((await app.client.request("lah.chat.story.set", { chatId: view.chatId, story: storyChosen(view, member, value) })).story);
        app.toast("Saved for this chat. It holds from its next reply.");
      } catch (error) {
        app.fail(error);
      }
    });
  return (
    <Disclosure class="lah-chatswitch-story" summary={storySummary(view)}>
      <p class="lah-field-help" data-lah-story-why>
        {storyWhy(view)}
      </p>
      {storyRows(view).map((row) => (
        <div key={row.member} class="lah-chatswitch-story-row" data-lah-story-member={row.member}>
          <span class="lah-field-label">{row.label}</span>
          {row.claimed !== null ? (
            <p class="lah-field-help" data-lah-story-claimed>
              {row.claimed}
            </p>
          ) : (
            <Seg value={row.value} options={row.options} label={row.label} disabled={busy} onChange={(value) => choose(row.member, value)} />
          )}
          {row.help !== "" ? <p class="lah-field-help">{row.help}</p> : null}
        </div>
      ))}
    </Disclosure>
  );
}

/** What asking Lumiverse for permissions came to, where it didn't grant them: the page then says what to do by hand. */
export type GrantFailure = "denied" | "unavailable" | null;

/** Asks Lumiverse to grant permissions: `ask` shows its confirmation (and says so once granted, unless `said` is false: what follows the grant says it then), and `failed` says how that ended where they weren't granted. Granted, the state is read again, so they are off the list of what LumiAH lacks whether or not the backend's push has come yet. */
export function useGrant(): { busy: boolean; failed: GrantFailure; ask(permissions: readonly string[], said?: boolean): void } {
  const app = useApp();
  const [busy, run] = useBusy();
  const [failed, setFailed] = useState<GrantFailure>(null);
  return {
    busy,
    failed,
    ask: (permissions, said = true) =>
      run(async () => {
        // The reason names what is lost without them, so it is worked out from the ones asked for: some are needed, some only add a part.
        const asked = (app.client.state.get()?.permissions ?? []).filter((p) => permissions.includes(p.id));
        const result = await app.host.grant(permissions, grantReason(asked));
        setFailed(result === "granted" ? null : result);
        if (result !== "granted") return;
        if (said) app.toast("Allowed. LumiAH has what it asked for.");
        await app.client.sync().catch(() => {
          // The backend's own push says the same a moment later; a read that failed here is no news to the user.
        });
      }),
  };
}

/** What to do once asking for permissions didn't grant them: said under the button that asked. The page can't tell a user who pressed Cancel from a Lumiverse that refused, so the words fit both. */
export function GrantHelp(props: { failed: GrantFailure; todo: string | null }) {
  if (props.failed === null) return null;
  return (
    <Banner tone="warn" title={props.failed === "denied" ? "Not allowed yet" : "This Lumiverse can't be asked from here"}>
      {props.failed === "denied" ? "Nothing was changed. Ask again when you are ready, or grant them by hand. " : "Grant them by hand. "}
      {props.todo ?? "Open LumiAH under Extensions in Lumiverse and grant its permissions."}
    </Banner>
  );
}

/** What LumiAH asks for, one line each: what the permission is for, and what is lost without it. One that only a part of LumiAH rests on says so first. */
export function PermissionList(props: { permissions: readonly PermissionNeed[] }) {
  return (
    <ul class="lah-facts" data-lah-permissions>
      {props.permissions.map((p) => (
        <li key={p.id} data-needed={p.needed}>
          <span>{`${p.needed ? "To" : "Optional: to"} ${p.what}.${p.without ? ` Without it, ${p.without}.` : ""}`}</span>
        </li>
      ))}
    </ul>
  );
}

/** One numbered step of a setup: its number (a tick once done), its title, and its body. */
export function Step(props: { id: string; number: number; at: StepAt; title: string; children?: ComponentChildren }) {
  return (
    <li class="lah-step" data-lah-step={props.id} data-state={props.at}>
      <span class="lah-step-mark" aria-hidden="true">
        {props.at === "done" ? <Icon name="check" size={16} /> : props.number}
      </span>
      <div class="lah-step-body">
        <span class="lah-step-title">
          {props.title} <span class="lah-sr">{props.at === "done" ? "(done)" : props.at === "now" ? "(next)" : "(to do)"}</span>
        </span>
        {props.children}
      </div>
    </li>
  );
}
