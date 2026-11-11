// Skills (DESIGN §13): the skills as a list, and the one open beside it. A skill is a procedure in
// markdown that an agent may follow: its prompt lists the skills it may load, each by its name and
// description, and `skill_load` returns the body of the one it picks. Nothing in the code decides
// when a skill applies, and the page says so. The frame is defs.tsx.

import { useId, useState } from "preact/hooks";
import type { Skill, SkillView } from "../../../shared/ui";
import { Editor, Field, Section, Seg, type SegOption } from "../components";
import { type DefKind, DefsFrame, type KindFieldsProps, libraryOf } from "../defs";
import { copySkill, newSkill, ownProblems, SKILL_WORDS, sameSkill, skillDraft, skillToSave } from "../defs-model";
import { Icon } from "../icons";

type BodyView = "write" | "read";

const BODY_VIEWS: readonly SegOption<BodyView>[] = [
  { value: "write", label: "Write" },
  { value: "read", label: "Read" },
];

/** A skill's own field: its body, to write or to read as an agent is given it. */
function SkillFields(props: KindFieldsProps<SkillView, Skill>) {
  const { draft } = props;
  const box = useId();
  const [mode, setMode] = useState<BodyView>("write");
  const { own, rest } = ownProblems(props.problems, ["body"]);
  return (
    <Section title="What it says" id="body" aside={<Seg<BodyView> label="The body: write it, or read it" value={mode} options={BODY_VIEWS} onChange={setMode} />}>
      <p class="lah-line">
        <Icon name="info" size={14} />
        <span>An agent that holds skill_load is told this skill's name and description. When it loads the skill, this body is what comes back, as written. Nothing in the code decides when a skill applies: the agent does.</span>
      </p>
      {mode === "write" ? (
        <Field label="Body" for={box} help="Markdown: the steps to follow, in the order to follow them." error={own.get("body")}>
          <Editor id={box} label="Body" rows={16} value={draft.body} invalid={own.has("body")} disabled={props.busy} onInput={(body) => props.onChange({ ...draft, body })} />
        </Field>
      ) : draft.body.trim() === "" ? (
        <p class="lah-lead lah-small" data-lah-skill-reading>
          The body is empty. Write the steps under Write.
        </p>
      ) : (
        <div class="lah-text lah-defs-reading" data-lah-skill-reading>
          {draft.body}
        </div>
      )}
      {rest.map((p) => (
        <span key={p.path.join(".")} class="lah-field-error" role="alert">
          <Icon name="alert" size={16} />
          {p.message}
        </span>
      ))}
    </Section>
  );
}

const SKILLS: DefKind<SkillView, Skill> = {
  kind: "skill",
  nav: "skills",
  words: SKILL_WORDS,
  icon: "book",
  drafts: (app) => libraryOf(app).skills,
  list: (view) => view.skills,
  draftOf: skillDraft,
  fresh: newSkill,
  copy: copySkill,
  same: sameSkill,
  save: (app, draft) => app.client.request("lah.skill.save", { skill: skillToSave(draft) }),
  about: "An agent is shown each skill's name and description, and loads the whole of one when it decides it applies: nothing else decides when.",
  help: {
    newId: 'What skill_load takes: lower-case letters, digits, "-" and "_". It is fixed once the skill is made.',
    madeId: "What skill_load takes. It is fixed: copy the skill to have it under another id.",
    name: "How an agent's prompt, and the pages, call it.",
    description: "All an agent reads when it chooses a skill: say when to use it.",
  },
  Fields: SkillFields,
};

export function SkillsPage() {
  return <DefsFrame kind={SKILLS} />;
}
