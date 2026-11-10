// Settings → Texts: every text LumiAH sends a model, by its group, and the editor for one. A text is
// the user's own once saved, and the default again once reset. The editor names each placeholder the
// text may use (pressing one puts it in at the cursor), says which a text can't work without and
// which it uses that nothing fills, and shows the default beside the text on request. Edits not yet
// saved are held by the Settings page, so leaving the editor and coming back loses nothing.

import { useRef, useState } from "preact/hooks";
import type { TextDef } from "../../../shared/ui";
import { Badge, Button, CopyButton, Section } from "../components";
import { count, counted } from "../format";
import { Icon } from "../icons";
import { textProblems } from "../settings-model";

/** The texts of a group, each a row that opens its editor. */
export function TextList(props: { defs: readonly TextDef[]; own: Readonly<Record<string, string>>; drafts: Readonly<Record<string, string>>; current: string | null; onOpen(id: string): void }) {
  return (
    <div class="lah-navlist" data-lah-texts>
      {props.defs.map((def) => (
        <button key={def.id} type="button" class="lah-navrow" data-lah-text={def.id} aria-current={props.current === def.id} onClick={() => props.onOpen(def.id)}>
          <span class="lah-navrow-text">
            <span class="lah-navrow-title">
              {def.label} {Object.hasOwn(props.own, def.id) ? <Badge tone="accent">yours</Badge> : null} {Object.hasOwn(props.drafts, def.id) ? <Badge tone="warn">not saved</Badge> : null}
            </span>
            <span class="lah-navrow-sub">{def.note}</span>
            <span class="lah-set-path">{def.id}</span>
          </span>
          <Icon name="chevron-right" size={16} class="lah-chev" />
        </button>
      ))}
    </div>
  );
}

export interface TextEditorProps {
  def: TextDef;
  /** The user's own text; undefined while the default stands. */
  own: string | undefined;
  /** Edits not yet saved; undefined when there are none. */
  draft: string | undefined;
  busy: boolean;
  /** What the backend refused of the last save, in its words. */
  refused: string | null;
  onDraft(text: string | undefined): void;
  onSave(text: string): void;
  onReset(): void;
}

export function TextEditor(props: TextEditorProps) {
  const { def } = props;
  const area = useRef<HTMLTextAreaElement>(null);
  const [compare, setCompare] = useState(false);
  const saved = props.own ?? def.text;
  const value = props.draft ?? saved;
  const dirty = props.draft !== undefined && props.draft !== saved;
  const { missing, unknown } = textProblems(value, def.vars);
  /** Puts a placeholder in at the cursor, in place of what is selected. */
  const insert = (name: string): void => {
    const el = area.current;
    const token = `{{${name}}}`;
    const from = el?.selectionStart ?? value.length;
    const to = el?.selectionEnd ?? value.length;
    props.onDraft(`${value.slice(0, from)}${token}${value.slice(to)}`);
    // The cursor goes after what was put in, once the text holds it.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(from + token.length, from + token.length);
    });
  };
  return (
    <div class="lah-text-editor" data-lah-text-editor={def.id}>
      <p class="lah-lead">{def.note}</p>
      <span class="lah-set-path">{def.id}</span>
      {def.vars.length > 0 ? (
        <Section title="Placeholders" flush>
          <div class="lah-text-vars">
            {def.vars.map((v) => (
              <div key={v.name} class="lah-text-var">
                <Button size="sm" icon="plus" label={`Put {{${v.name}}} in at the cursor`} onClick={() => insert(v.name)}>
                  <code>{`{{${v.name}}}`}</code>
                </Button>
                <span>{v.text}</span>
                {v.required ? <Badge tone={missing.includes(v.name) ? "neg" : "neutral"}>needed</Badge> : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      <div class={compare ? "lah-text-compare" : "lah-stack"}>
        <div class="lah-field">
          <div class="lah-field-head">
            <span class="lah-field-label">{props.own !== undefined || dirty ? "Your text" : "The text (the default)"}</span>
            <span class="lah-set-unit">{`${count(value.length)} characters`}</span>
          </div>
          <textarea ref={area} class={missing.length > 0 ? "lah-input lah-is-invalid" : "lah-input"} aria-label={`${def.label}: the text`} spellcheck={false} value={value} onInput={(event) => props.onDraft(event.currentTarget.value === saved ? undefined : event.currentTarget.value)} />
        </div>
        {compare ? (
          <div class="lah-field">
            <div class="lah-field-head">
              <span class="lah-field-label">The default</span>
              <CopyButton text={def.text} label="Copy the default text" />
            </div>
            <pre class="lah-text lah-text-default">{def.text}</pre>
          </div>
        ) : null}
      </div>
      {missing.length > 0 ? (
        <span class="lah-field-error" role="alert">
          <Icon name="alert" size={16} />
          {`It can't be saved without ${missing.map((n) => `{{${n}}}`).join(", ")}: the text can't work without ${missing.length === 1 ? "it" : "them"}.`}
        </span>
      ) : null}
      {unknown.length > 0 ? <span class="lah-field-help lah-warn">{`Nothing fills ${unknown.map((n) => `{{${n}}}`).join(", ")}: ${unknown.length === 1 ? "it goes" : "they go"} to the model as written.`}</span> : null}
      {props.refused !== null ? (
        <span class="lah-field-error" role="alert">
          <Icon name="alert" size={16} />
          {props.refused}
        </span>
      ) : null}
      <div class="lah-actions">
        <Button variant="primary" icon="check" busy={props.busy} disabled={!dirty || missing.length > 0} onClick={() => props.onSave(value)}>
          Save
        </Button>
        <Button icon="close" disabled={!dirty || props.busy} onClick={() => props.onDraft(undefined)}>
          Discard edits
        </Button>
        <Button icon="undo" disabled={props.own === undefined || props.busy} onClick={props.onReset}>
          Back to the default
        </Button>
        <CopyButton text={value} label={`Copy ${def.label}`} size="md" variant="secondary">
          Copy
        </CopyButton>
        <Button pressed={compare} icon="file" onClick={() => setCompare((on) => !on)}>
          Compare with the default
        </Button>
      </div>
      <p class="lah-lead lah-small">{dirty ? "Edits not saved yet. They stay here until you save or discard them, or the page reloads." : props.own !== undefined ? `Yours since you saved it. The default is ${counted(def.text.length, "character")} long.` : "The default stands. Save an edit to make it yours."}</p>
    </div>
  );
}
