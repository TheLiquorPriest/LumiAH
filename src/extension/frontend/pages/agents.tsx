// Agents (DESIGN §13, §14): the agent definitions as a list, and the one open beside it. A
// definition says what an agent is (its name, and the description a delegating agent reads when it
// chooses whom to start), what it is told (its instructions), what it is given when another agent
// starts it, and what it runs with. The frame, and everything an agent shares with a skill, is
// defs.tsx; what the page decides is defs-model.ts.

import { useId, useMemo, useRef } from "preact/hooks";
import type { AgentView, ConnectionView, TextsView } from "../../../shared/ui";
import { useApp } from "../app";
import { Editor, Field, Section } from "../components";
import { type DefKind, DefsFrame, type KindFieldsProps, libraryOf } from "../defs";
import { AGENT_WORDS, type AgentDraft, agentDraft, agentForm, agentToSave, applyAgentForm, copyAgent, followsWords, grantSettingWords, instructionsNote, instructionsShown, newAgent, ownProblems, sameAgent, typedInstructions } from "../defs-model";
import { Icon } from "../icons";
import { formOf, problemsByPath, valueAt } from "../settings-model";
import { useSelect } from "../store";
import { FieldNode, type FormCtx } from "./settings-form";

const NO_TEXTS: TextsView = { defs: [], own: {} };
const NO_CONNECTIONS: readonly ConnectionView[] = [];

/** An agent's own fields: its instructions, then what it is given and runs with, as the form the backend's schema describes. */
function AgentFields(props: KindFieldsProps<AgentView, AgentDraft>) {
  const app = useApp();
  const { draft, saved, view } = props;
  const texts = useSelect(app.client.state, (s) => s?.texts ?? NO_TEXTS);
  const connections = useSelect(app.client.state, (s) => s?.connections ?? NO_CONNECTIONS);
  const settings = useSelect(app.client.state, (s) => s?.settings ?? null);
  const box = useId();
  /** The models each connection offers, asked for once while this agent shows. */
  const modelLists = useRef(new Map<string, Promise<string[]>>());
  const kept = saved !== null ? agentDraft(saved).instructions : null;
  const note = instructionsNote(draft.instructions, kept, texts.defs);
  const { own, rest } = ownProblems(props.problems, ["instructions", "text"]);
  const wrong = [own.get("instructions"), own.get("text")].filter((p) => p !== undefined).join(" ");
  // What Settings say a sub-agent may be given, for the choice that leaves it to them.
  const settingsSay = useMemo(() => (settings !== null ? grantSettingWords(settings) : null), [settings]);
  const form = useMemo(() => formOf(agentForm(view, draft.rest, settingsSay)), [view.agentSchema, view.agentDefaults, draft.rest, settingsSay]);
  const follows = followsWords(draft.rest, view.agents);
  const ctx: FormCtx = {
    // The form keeps a change by handing it here: it goes into the edits, and Save sends the whole definition.
    save: (set, reset) => props.onChange({ ...draft, rest: applyAgentForm(draft.rest, view.agentDefaults, set, reset) }),
    busy: props.busy,
    problems: problemsByPath(form, rest),
    connections,
    found: null,
    at: (path) => valueAt(draft.rest, path),
    models: (connectionId) => {
      const key = connectionId ?? "";
      let list = modelLists.current.get(key);
      if (!list) {
        list = app.client.request("lah.models.list", { connectionId }).then((r) => r.models);
        modelLists.current.set(key, list);
        // A list that couldn't be read is asked for again next time.
        list.catch(() => modelLists.current.delete(key));
      }
      return list;
    },
  };
  return (
    <>
      <Section title="What it is told" id="instructions">
        {note !== null ? (
          <p class={note.tone === "warn" ? "lah-line lah-is-warn" : "lah-line"} data-lah-instructions-note={note.tone} role={note.tone === "warn" ? "alert" : undefined}>
            <Icon name={note.tone === "warn" ? "alert" : "info"} size={14} />
            <span>{note.words}</span>
          </p>
        ) : null}
        <Field label="Instructions" for={box} help="Its system prompt: sent at the head of every call it makes." error={wrong !== "" ? wrong : null}>
          <Editor id={box} label="Instructions" rows={12} value={instructionsShown(draft.instructions, texts.own)} invalid={wrong !== ""} disabled={props.busy} onInput={(typed) => props.onChange({ ...draft, instructions: typedInstructions(typed, kept, texts.own) })} />
        </Field>
      </Section>
      <section class="lah-section lah-defs-form" data-lah-section="runs">
        <div class="lah-section-head">
          <span class="lah-section-title">What it is given, and what it runs with</span>
        </div>
        <p class="lah-lead lah-small">These are the definition's own. What Settings → Agents says for this agent stands over them. Here a value's default is what a new agent starts with.</p>
        {follows !== null ? (
          <p class="lah-line">
            <Icon name="info" size={14} />
            <span>{follows}</span>
          </p>
        ) : null}
        <FieldNode node={form} ctx={ctx} top />
      </section>
    </>
  );
}

const AGENTS: DefKind<AgentView, AgentDraft> = {
  kind: "agent",
  nav: "agents",
  words: AGENT_WORDS,
  icon: "user",
  drafts: (app) => libraryOf(app).agents,
  list: (view) => view.agents,
  draftOf: agentDraft,
  fresh: (view) => newAgent(view.agentDefaults),
  copy: copyAgent,
  same: sameAgent,
  save: (app, draft) => app.client.request("lah.agent.save", { agent: agentToSave(draft) }),
  about: "The main agent works on every reply and hands work to the others; a job or a conversation starts with one. Open one to see what it is told, the tools it is given and the model it runs with.",
  help: {
    newId: 'What delegate, a job and a conversation name it by: lower-case letters, digits, "-" and "_". It is fixed once the agent is made.',
    madeId: "What delegate, a job and a conversation name it by. It is fixed: copy the agent to have it under another id.",
    name: "How the pages call it.",
    description: "What a delegating agent reads when it chooses whom to start: say what this agent is good for, and what to hand it.",
  },
  Fields: AgentFields,
};

export function AgentsPage() {
  return <DefsFrame kind={AGENTS} />;
}
