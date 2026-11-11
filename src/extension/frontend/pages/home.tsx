// Home: the first screen (DESIGN §25). Whether LumiAH is used in the open chat (its switch, with
// where it runs beside it), what needs the user (each thing with its one action), what it did for
// the last reply in a sentence (where that failed, the cause and the step that mends it), the offer
// to learn a long story nobody has learned, and the way into every other page with a line that
// says what it is for. For someone new the same screen is setup: allow LumiAH what it needs, switch
// it on, send a message. Nothing is installed and no key or connection is asked for: a runtime is
// an option, on its own page. What shows is decided in home-model.ts.

import { useContext, useEffect, useState } from "preact/hooks";
import { type HomeView, isReply, type StoryView } from "../../../shared/ui";
import { errorWords, ShownPagesContext, useApp } from "../app";
import { Banner, Button, Disclosure, IconButton, Section, useBusy, useTick } from "../components";
import { ago } from "../format";
import { homeOf, type LastLine, type Need, type Way } from "../home-model";
import { Icon } from "../icons";
import { PAGE_ICON, SKIP_ABOUT, SKIP_REPLY, type Target } from "../nav-model";
import { ChatSwitch, GrantHelp, Step, useGrant } from "../setup-parts";
import { useSelect } from "../store";
import { ReplyBrief, ReplyClock, useMendStep } from "../turn-parts";

/** A built-in turn's time before the reply, counted down a second at a time. */
function HomeClock(props: { clock: NonNullable<LastLine["clock"]> }) {
  const now = useTick(1000);
  return <ReplyClock replyBy={props.clock.replyBy} startedAt={props.clock.startedAt} now={now} />;
}

/** A way into another page: its name, a line on what it is for, and its mark. */
function WayRow(props: { way: Way; onGo(): void }) {
  const { way } = props;
  return (
    <button type="button" class="lah-navrow" data-lah-way={way.id} onClick={props.onGo}>
      <Icon name={PAGE_ICON[way.id]} size={18} />
      <span class="lah-navrow-text">
        <span class="lah-navrow-title">{way.label}</span>
        <span class="lah-navrow-sub">{way.about}</span>
      </span>
      {way.mark !== null ? <span class={way.mark === "busy" ? "lah-pulse" : "lah-dot lah-is-warn"} role="img" aria-label={way.mark === "busy" ? "something is under way" : "needs you"} /> : null}
      <Icon name="chevron-right" size={16} class="lah-chev" />
    </button>
  );
}

export function HomePage() {
  const app = useApp();
  const state = useSelect(app.client.state, (s) => s);
  const active = useSelect(app.host.activeChat, (c) => c);
  const pages = useContext(ShownPagesContext);
  // The turn of the open chat that runs now: when it starts and when it ends, what the last turn did is read again.
  const running = useSelect(app.client.state, (s) => s?.running.find((r) => isReply(r.kind) && r.chatId === active)?.turn ?? "");
  const [home, setHome] = useState<HomeView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const [busy, run] = useBusy();
  const [skipping, skip] = useBusy();
  const grant = useGrant();
  // How far the open chat's story is learned, read where LumiAH is switched on for it and again whenever a job changes: Home offers to learn a long one nobody has.
  const chatOn = useSelect(app.client.state, (s) => s?.chats.find((c) => c.chatId === active)?.on === true);
  const jobsChanged = useSelect(app.client.state, (s) => s?.jobs.changed ?? 0);
  const [story, setStory] = useState<{ chatId: string; view: StoryView } | null>(null);
  useEffect(() => {
    if (active === null || !chatOn) return setStory(null);
    let live = true;
    app.client.request("lah.story.get", { chatId: active }).then(
      (view) => live && setStory({ chatId: active, view }),
      // The offer is no need: where the story can't be read, Home simply doesn't make it.
      () => live && setStory(null),
    );
    return () => {
      live = false;
    };
  }, [active, chatOn, jobsChanged]);
  const go = (target: Target): void => app.nav.update((n) => ({ ...n, ...target }));
  const mending = useMendStep(() => go({ page: "live", chatId: null }));
  useEffect(() => {
    let live = true;
    const read = (): void => {
      app.client.request("lah.home.get", { chatId: active }).then(
        (answer) => {
          if (!live) return;
          setHome(answer);
          setFailed(null);
        },
        (error: unknown) => live && setFailed(errorWords(error)),
      );
    };
    read();
    const off = app.client.onBack(read);
    return () => {
      live = false;
      off();
    };
  }, [active, running, again]);
  if (state === null) return null;
  const now = app.now();
  const model = homeOf({ state, home, story, active, now, pages });
  const dismiss = (id: string): void =>
    run(async () => {
      try {
        await app.client.request("lah.notice.dismiss", { id });
      } catch (error) {
        app.fail(error);
      }
    });
  const act = (need: Need): void => {
    if (need.action === null) return;
    if (need.action.do === "grant") grant.ask(need.action.permissions);
    else go(need.action.target);
  };
  // The switch of the open chat: what a switch here answered stands until the state or the next read says the same.
  const chatSwitch =
    model.chat !== null ? (
      <ChatSwitch chat={model.chat.view} open fold onChanged={(chat) => setHome((held) => ({ last: held?.chat?.chatId === chat.chatId ? held.last : null, chat }))} />
    ) : (
      <p class="lah-lead" data-lah-nochat>
        {active === null ? "Open a chat in Lumiverse, and its switch shows here." : failed !== null ? "This chat couldn't be read." : "Reading this chat…"}
      </p>
    );
  const readFailed =
    failed !== null ? (
      <Banner
        tone="warn"
        title="Home couldn't read this chat"
        actions={
          <Button icon="refresh" onClick={() => setAgain(again + 1)}>
            Try again
          </Button>
        }
      >
        {failed}
      </Banner>
    ) : null;
  const first = model.setup?.find((s) => s.at !== "done")?.id ?? null;
  const last = model.last;
  const skipReply = (reply: NonNullable<LastLine["skip"]>): void =>
    skip(async () => {
      try {
        const r = await app.client.request("lah.turn.stop", { stream: reply.stream, turn: reply.turn });
        app.toast(r.stopped ? "Skipped: Lumiverse writes this reply without the agents." : "The agents had already finished.");
      } catch (error) {
        app.fail(error);
      }
    });
  return (
    <div class="lah-home" data-lah-view="home" data-lah-setup={model.setup !== null ? "todo" : "done"}>
      <div class="lah-home-col">
        {readFailed}
        {model.setup !== null ? (
          <Section title="Set up LumiAH" flush id="setup">
            <p class="lah-lead lah-home-lead">Before each reply, LumiAH's agents read your story (the chat, your lore, their own notes) and tell the model that writes your reply what it must keep true. {first === "chat" ? "Switch it on for a chat, then send a message. Nothing to install." : "One thing left: send a message."}</p>
            <ol class="lah-steps" data-lah-setup>
              {model.setup.map((step, i) => (
                <Step key={step.id} id={step.id} number={i + 1} at={step.at} title={step.title}>
                  {step.id === "chat" ? chatSwitch : null}
                  {step.id === "reply" && step.at === "now" ? (
                    <>
                      <p class="lah-lead">LumiAH works before the reply, and Live shows every step as it happens.</p>
                      <div class="lah-actions">
                        <Button icon="pulse" onClick={() => go({ page: "live", chatId: null })}>
                          Open Live
                        </Button>
                      </div>
                    </>
                  ) : null}
                </Step>
              ))}
            </ol>
          </Section>
        ) : (
          <Section title="This chat" id="chat">
            {chatSwitch}
          </Section>
        )}
        {model.needs.length > 0 ? (
          <Section title="Needs you" flush id="needs">
            {model.needs.map((need) => (
              <div key={need.key} class="lah-need" data-lah-need={need.kind} data-tone={need.tone} role="alert">
                <Icon name={need.icon} size={18} />
                <div class="lah-need-text">
                  <span>{need.text}</span>
                  {need.action === null && need.todo !== null ? <span class="lah-field-help">{need.todo}</span> : null}
                  {need.action?.do === "grant" ? <GrantHelp failed={grant.failed} todo={need.todo} /> : null}
                </div>
                <div class="lah-need-actions">
                  {need.action !== null ? (
                    <Button variant="primary" busy={need.action.do === "grant" && grant.busy} onClick={() => act(need)}>
                      {need.action.label}
                    </Button>
                  ) : null}
                  {need.notice !== null ? <IconButton icon="close" label="Dismiss this notice" disabled={busy} onClick={() => dismiss(need.notice ?? "")} /> : null}
                </div>
              </div>
            ))}
          </Section>
        ) : null}
        <Section title="Last reply" id="last">
          <div class="lah-home-last" data-lah-last={last.state} data-tone={last.tone}>
            <span class="lah-home-last-title">
              <Icon name={last.icon} size={18} />
              <span>{last.title}</span>
            </span>
            {last.clock !== null ? <HomeClock clock={last.clock} /> : null}
            <ReplyBrief brief={last.brief} lore={last.lore} />
            {last.detail !== null ? (
              <p class="lah-lead" data-lah-last-detail>
                {last.detail}
              </p>
            ) : null}
            {last.skip !== null ? (
              <p class="lah-field-help" data-lah-skip-about>
                {SKIP_ABOUT}
              </p>
            ) : null}
            {last.action !== null || last.mend?.action != null || last.skip !== null ? (
              <div class="lah-actions">
                {last.mend !== null && last.mend.action !== null ? (
                  <Button variant="primary" busy={last.mend.action.step.go === "grant" && mending.busy} onClick={() => last.mend?.action && mending.take(last.mend.action.step)}>
                    {last.mend.action.label}
                  </Button>
                ) : null}
                {last.action !== null ? (
                  <Button icon={last.state === "running" ? "pulse" : "arrow-right"} variant={last.state === "running" ? "primary" : "secondary"} onClick={() => last.action && go(last.action.target)}>
                    {last.action.label}
                  </Button>
                ) : null}
                {last.skip !== null ? (
                  <Button icon="arrow-right" busy={skipping} onClick={() => last.skip && skipReply(last.skip)}>
                    {SKIP_REPLY}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {last.counts !== null ? (
              <Disclosure summary={<span class="lah-small">Details: counts and tokens</span>}>
                <p class="lah-lead lah-small" data-lah-last-counts>
                  {last.counts}
                </p>
              </Disclosure>
            ) : null}
          </div>
        </Section>
        {model.learn !== null ? (
          <Section title="Learn this story" id="learn">
            <div class="lah-home-last" data-lah-learn>
              <span class="lah-home-last-title">
                <Icon name="scroll" size={18} />
                <span>{model.learn.title}</span>
              </span>
              <p class="lah-lead">{model.learn.text}</p>
              <div class="lah-actions">
                <Button variant="primary" icon="scroll" onClick={() => app.nav.update((n) => ({ ...n, page: "chronicle", learn: true }))}>
                  Learn this story
                </Button>
              </div>
            </div>
          </Section>
        ) : null}
        {model.news.length > 0 ? (
          <Section title="Finished" flush id="news">
            {model.news.map((notice) => (
              <div key={notice.id} class="lah-need" data-lah-news={notice.id} data-tone="pos">
                <Icon name="check" size={18} />
                <div class="lah-need-text">
                  <span>
                    {notice.text} <span class="lah-dim">{ago(now, notice.at)}</span>
                  </span>
                </div>
                <div class="lah-need-actions">
                  <Button onClick={() => go({ page: "jobs", job: notice.jobId, chatId: notice.chatId === active ? null : notice.chatId })}>Open the job</Button>
                  <IconButton icon="close" label="Dismiss this notice" disabled={busy} onClick={() => dismiss(notice.id)} />
                </div>
              </div>
            ))}
          </Section>
        ) : null}
      </div>
      <div class="lah-home-col">
        <Section title="Everything else" flush id="ways">
          <div class="lah-home-ways" data-lah-ways="main">
            {model.ways.main.map((way) => (
              <WayRow key={way.id} way={way} onGo={() => go({ page: way.id })} />
            ))}
          </div>
          {model.ways.more.length > 0 ? (
            <Disclosure class="lah-home-more" summary={`Less often needed: ${model.ways.more.map((w) => w.label.toLowerCase()).join(", ")}`} defaultOpen={model.ways.more.some((w) => w.mark === "needs")}>
              <div class="lah-home-ways" data-lah-ways="more">
                {model.ways.more.map((way) => (
                  <WayRow key={way.id} way={way} onGo={() => go({ page: way.id })} />
                ))}
              </div>
            </Disclosure>
          ) : null}
        </Section>
      </div>
    </div>
  );
}
