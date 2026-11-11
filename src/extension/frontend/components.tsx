// The pages' shared atoms, moved from LumiRPEngine's set and cut to what LumiAH uses. Every control is
// a plain element with its own name (no host component), so it works the same in the drawer, in
// another extension's panel and in tests. The accessibility floor: targets of --lah-tap (36 px, 44 px
// on a coarse pointer; styles/tokens.ts), labelled icon buttons, the shared focus ring, and nothing
// shown only on hover.

import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { useApp } from "./app";
import { Icon, type IconName } from "./icons";
import { useSelect } from "./store";

/** Runs an async action with a busy flag; presses while it runs are ignored. */
export function useBusy(): [boolean, (run: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const running = useRef(false);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  return [
    busy,
    (run) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      void run()
        .catch(() => {
          // The action reports its own failure; a rejection here only must not go unhandled.
        })
        .finally(() => {
          running.current = false;
          if (live.current) setBusy(false);
        });
    },
  ];
}

/** The time, read again every `ms` while the component shows: for what counts up or down on its own. */
export function useTick(ms: number): number {
  const app = useApp();
  const [now, setNow] = useState(() => app.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(app.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

// A modifier on any of these is a class of LumiAH's own, `lah-is-…`: a bare "primary" or "warn" is
// what another extension's stylesheet, or a user's custom CSS, may well be written to catch.
export function Button(props: { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "md" | "sm"; icon?: IconName; block?: boolean; disabled?: boolean; busy?: boolean; label?: string; pressed?: boolean; expanded?: boolean; onClick?(): void; children?: ComponentChildren }) {
  const variant = props.variant ?? "secondary";
  const classes = ["lah-btn", `lah-is-${variant}`, props.size === "sm" ? "lah-is-small" : null, props.block ? "lah-is-block" : null].filter((c) => c !== null).join(" ");
  const onClick = props.onClick;
  return (
    <button type="button" class={classes} disabled={props.disabled || props.busy} aria-busy={props.busy || undefined} aria-label={props.label} aria-pressed={props.pressed} aria-expanded={props.expanded} onClick={onClick ? () => onClick() : undefined}>
      {props.icon ? <Icon name={props.icon} size={props.size === "sm" ? 14 : 18} /> : null}
      {props.children}
    </button>
  );
}

/** An icon-only button, named by `label` (also its tooltip); `pressed` makes it a toggle. */
export function IconButton(props: { icon: IconName; label: string; size?: "md" | "sm"; pressed?: boolean; expanded?: boolean; disabled?: boolean; onClick(): void }) {
  return (
    <button type="button" class={props.size === "sm" ? "lah-iconbtn lah-is-small" : "lah-iconbtn"} aria-label={props.label} title={props.label} aria-pressed={props.pressed} aria-expanded={props.expanded} disabled={props.disabled} onClick={() => props.onClick()}>
      <Icon name={props.icon} size={props.size === "sm" ? 14 : 18} />
    </button>
  );
}

export type Tone = "neutral" | "accent" | "pos" | "neg" | "warn";

export function Badge(props: { tone?: Tone; children: ComponentChildren }) {
  return <span class={`lah-badge lah-is-${props.tone ?? "neutral"}`}>{props.children}</span>;
}

/** A choice that is on or off, among others like it. */
export function Chip(props: { pressed: boolean; disabled?: boolean; onClick(): void; children: ComponentChildren }) {
  return (
    <button type="button" class="lah-chip" aria-pressed={props.pressed} disabled={props.disabled} onClick={() => props.onClick()}>
      {props.children}
    </button>
  );
}

const BANNER_ICON: Readonly<Record<"info" | "warn" | "neg" | "pos", IconName>> = { info: "info", warn: "alert", neg: "alert", pos: "check" };

/** A message across the content: an icon (so its meaning never rests on colour alone), a title, the details and actions. */
export function Banner(props: { tone: "info" | "warn" | "neg" | "pos"; title?: ComponentChildren; actions?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class={`lah-banner lah-is-${props.tone}`} role={props.tone === "warn" || props.tone === "neg" ? "alert" : "status"}>
      <div class="lah-banner-main">
        <Icon name={BANNER_ICON[props.tone]} class="lah-banner-icon" />
        <div class="lah-banner-text">
          {props.title !== undefined ? <strong>{props.title}</strong> : null}
          {props.children !== undefined ? <div>{props.children}</div> : null}
        </div>
      </div>
      {props.actions !== undefined ? <div class="lah-banner-actions">{props.actions}</div> : null}
    </div>
  );
}

/** A note where content would be: an icon, a title, a line of help and an action. */
export function Empty(props: { icon?: IconName; title?: ComponentChildren; action?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="lah-empty">
      {props.icon ? (
        <span class="lah-empty-icon">
          <Icon name={props.icon} />
        </span>
      ) : null}
      {props.title !== undefined ? <div class="lah-empty-title">{props.title}</div> : null}
      {props.children !== undefined ? <div class="lah-empty-body">{props.children}</div> : null}
      {props.action !== undefined ? <div class="lah-empty-action">{props.action}</div> : null}
    </div>
  );
}

/** A titled group: a quiet label above a card. `flush` drops the card's padding, for rows. */
export function Section(props: { title?: ComponentChildren; aside?: ComponentChildren; flush?: boolean; id?: string; children: ComponentChildren }) {
  return (
    <section class={props.flush ? "lah-section lah-is-flush" : "lah-section"} data-lah-section={props.id}>
      {props.title !== undefined || props.aside !== undefined ? (
        <div class="lah-section-head">
          {props.title !== undefined ? <h3 class="lah-section-title">{props.title}</h3> : <span />}
          {props.aside}
        </div>
      ) : null}
      <div class="lah-section-body">{props.children}</div>
    </section>
  );
}

/**
 * Details on request: a native disclosure, so keyboard and screen readers work as they expect. With
 * `open` it is controlled. Its details render only while it is open, so a closed one costs nothing
 * however much it holds.
 */
export function Disclosure(props: { summary: ComponentChildren; open?: boolean; defaultOpen?: boolean; onToggle?(open: boolean): void; class?: string; children?: ComponentChildren }) {
  const onToggle = props.onToggle;
  const [shown, setShown] = useState(props.open ?? props.defaultOpen ?? false);
  const open = props.open ?? shown;
  return (
    <details
      class={props.class ? `lah-disclosure ${props.class}` : "lah-disclosure"}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setShown(next);
        onToggle?.(next);
      }}
    >
      <summary>
        <Icon name="chevron-right" size={16} class="lah-caret" />
        <span class="lah-disclosure-label">{props.summary}</span>
      </summary>
      {open ? <div class="lah-disclosure-body">{props.children}</div> : null}
    </details>
  );
}

/** A search box: the query as typed, a clear button while it holds any, and Escape to clear it. `status` says what it finds, read out as it changes. */
export function SearchField(props: { value: string; label: string; placeholder?: string; status?: string; onInput(value: string): void; onEnter?(back: boolean): void }) {
  const onInput = props.onInput;
  return (
    <div class="lah-search" role="search">
      <Icon name="search" size={16} class="lah-search-icon" />
      <input
        class="lah-input"
        type="search"
        enterKeyHint="search"
        autocomplete="off"
        spellcheck={false}
        aria-label={props.label}
        placeholder={props.placeholder}
        value={props.value}
        onInput={(event) => onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && props.onEnter) {
            event.preventDefault();
            props.onEnter(event.shiftKey);
          }
          if (event.key !== "Escape" || props.value === "") return;
          event.preventDefault();
          event.stopPropagation();
          onInput("");
        }}
      />
      {props.value !== "" ? <IconButton icon="close" label="Clear the search" onClick={() => onInput("")} /> : null}
      {props.status !== undefined ? (
        <span class="lah-sr" role="status">
          {props.status}
        </span>
      ) : null}
    </div>
  );
}

/** A labelled control with help and an error; `for` ties the label to the control. */
export function Field(props: { label: ComponentChildren; help?: ComponentChildren; error?: string | null; for?: string; aside?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="lah-field">
      <div class="lah-field-head">
        {props.for !== undefined ? <label for={props.for}>{props.label}</label> : <span class="lah-field-label">{props.label}</span>}
        {props.aside}
      </div>
      {props.children}
      {props.help !== undefined ? <span class="lah-field-help">{props.help}</span> : null}
      {props.error ? (
        <span class="lah-field-error" role="alert">
          <Icon name="alert" size={16} />
          {props.error}
        </span>
      ) : null}
    </div>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

/** A row of choices, one pressed. */
export function Seg<T extends string>(props: { value: T | null; options: readonly SegOption<T>[]; label: string; disabled?: boolean; onChange(value: T): void }) {
  return (
    <div class="lah-seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === props.value} disabled={props.disabled} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A switch: a checkbox drawn as one, with its label and help beside it, the whole row its target. */
export function Switch(props: { checked: boolean; label: ComponentChildren; help?: ComponentChildren; disabled?: boolean; onChange(checked: boolean): void }) {
  const id = useId();
  return (
    <label class="lah-switch" for={id}>
      <span class="lah-switch-text">
        <span>{props.label}</span>
        {props.help !== undefined ? <span class="lah-field-help">{props.help}</span> : null}
      </span>
      <input id={id} type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.currentTarget.checked)} />
      <span class="lah-switch-track" aria-hidden="true" />
    </label>
  );
}

/** A tick box with its label and help beside it, the whole row its target. */
export function Check(props: { checked: boolean; label: ComponentChildren; help?: ComponentChildren; disabled?: boolean; onChange(checked: boolean): void }) {
  return (
    <label class="lah-check">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.currentTarget.checked)} />
      <span class="lah-check-text">
        <span>{props.label}</span>
        {props.help !== undefined ? <span class="lah-field-help">{props.help}</span> : null}
      </span>
    </label>
  );
}

/** A number typed or stepped with − and +, committed on blur or Enter and kept within its bounds. */
export function NumberField(props: { id?: string; value: number | null; min?: number; max?: number; step?: number; integer?: boolean; label: string; disabled?: boolean; invalid?: boolean; onChange(value: number): void }) {
  const own = useId();
  const id = props.id ?? own;
  const shown = props.value === null ? "" : String(props.value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const step = props.step ?? 1;
  const current = props.value ?? props.min ?? 0;
  const commit = (raw: number): void => {
    const rounded = props.integer ? Math.round(raw) : Number(raw.toFixed(6));
    const next = Math.min(props.max ?? Number.POSITIVE_INFINITY, Math.max(props.min ?? Number.NEGATIVE_INFINITY, rounded));
    setText(String(next));
    if (next !== props.value) props.onChange(next);
  };
  return (
    <span class="lah-stepper" role="group" aria-label={props.label}>
      <button type="button" class="lah-btn lah-is-secondary" aria-label={`Decrease ${props.label}`} disabled={props.disabled || (props.min !== undefined && current <= props.min)} onClick={() => commit(current - step)}>
        <span aria-hidden="true">−</span>
      </button>
      <input
        id={id}
        class={props.invalid ? "lah-input lah-is-invalid" : "lah-input"}
        inputMode={props.integer ? "numeric" : "decimal"}
        autocomplete="off"
        value={text}
        disabled={props.disabled}
        aria-label={props.label}
        aria-invalid={props.invalid || undefined}
        onInput={(event) => setText(event.currentTarget.value)}
        onBlur={() => {
          const parsed = Number(text);
          if (text.trim() !== "" && Number.isFinite(parsed)) commit(parsed);
          else setText(shown);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <button type="button" class="lah-btn lah-is-secondary" aria-label={`Increase ${props.label}`} disabled={props.disabled || (props.max !== undefined && current >= props.max)} onClick={() => commit(current + step)}>
        <span aria-hidden="true">+</span>
      </button>
    </span>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** A native select: its options, the value shown, a label. A value none of its options has shows as itself, so what is stored is never hidden. */
export function Select(props: { id?: string; value: string; options: readonly SelectOption[]; label?: string; disabled?: boolean; invalid?: boolean; onChange(value: string): void }) {
  const known = props.options.some((o) => o.value === props.value);
  return (
    <select id={props.id} class={props.invalid ? "lah-input lah-is-invalid" : "lah-input"} value={props.value} aria-label={props.label} aria-invalid={props.invalid || undefined} disabled={props.disabled} onChange={(event) => props.onChange(event.currentTarget.value)}>
      {known ? null : <option value={props.value}>{props.value === "" ? "Choose…" : props.value}</option>}
      {props.options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A line of text committed on blur or Enter, so a request goes once per edit rather than per key. `list` offers suggestions. */
export function TextInput(props: { id?: string; value: string; label?: string; placeholder?: string; list?: string; maxLength?: number; mono?: boolean; disabled?: boolean; invalid?: boolean; onFocus?(): void; onCommit(value: string): void }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <input
      id={props.id}
      class={`lah-input${props.invalid ? " lah-is-invalid" : ""}${props.mono ? " lah-mono" : ""}`}
      value={text}
      autocomplete="off"
      spellcheck={false}
      aria-label={props.label}
      aria-invalid={props.invalid || undefined}
      placeholder={props.placeholder}
      list={props.list}
      maxLength={props.maxLength}
      disabled={props.disabled}
      onFocus={props.onFocus}
      onInput={(event) => setText(event.currentTarget.value)}
      onBlur={() => {
        if (text !== props.value) props.onCommit(text);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

/** Text of several lines, committed on blur. */
export function TextArea(props: { id?: string; value: string; label?: string; rows?: number; maxLength?: number; placeholder?: string; disabled?: boolean; invalid?: boolean; onCommit(value: string): void }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <textarea
      id={props.id}
      class={props.invalid ? "lah-input lah-is-invalid" : "lah-input"}
      value={text}
      rows={props.rows ?? 4}
      spellcheck={false}
      aria-label={props.label}
      aria-invalid={props.invalid || undefined}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      disabled={props.disabled}
      onInput={(event) => setText(event.currentTarget.value)}
      onBlur={() => {
        if (text !== props.value) props.onCommit(text);
      }}
    />
  );
}

/** Text of several lines that says each change as it is typed (a file being edited, a message being written), where `TextArea` commits on blur. Set in the code face like every text box here; `prose` sets it in the page's own, for a message. */
export function Editor(props: { id?: string; value: string; label: string; rows?: number; placeholder?: string; prose?: boolean; disabled?: boolean; invalid?: boolean; onInput(value: string): void; onKeyDown?(event: KeyboardEvent): void }) {
  const classes = ["lah-input", props.prose ? "lah-is-prose" : null, props.invalid ? "lah-is-invalid" : null].filter((c) => c !== null).join(" ");
  return (
    <textarea
      id={props.id}
      class={classes}
      value={props.value}
      rows={props.rows ?? 4}
      spellcheck={false}
      aria-label={props.label}
      aria-invalid={props.invalid || undefined}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onInput={(event) => props.onInput(event.currentTarget.value)}
      onKeyDown={props.onKeyDown}
    />
  );
}

/** Copies `text`, saying so in a toast. */
export function CopyButton(props: { text: string | (() => string); label: string; size?: "sm" | "md"; variant?: "ghost" | "secondary"; children?: ComponentChildren }) {
  const app = useApp();
  const copy = (): void => {
    const text = typeof props.text === "function" ? props.text() : props.text;
    void app.host.copy(text).then((ok) => app.toast(ok ? "Copied" : "The clipboard refused: select the text and copy it yourself", ok ? "info" : "error"));
  };
  if (props.children === undefined) return <IconButton icon="copy" label={props.label} size={props.size ?? "sm"} onClick={copy} />;
  return (
    <Button size={props.size ?? "sm"} variant={props.variant ?? "ghost"} icon="copy" label={props.label} onClick={copy}>
      {props.children}
    </Button>
  );
}

/** A line to copy: what it is for, the line, Copy, and a word on it. */
export function CopyLine(props: { id?: string; label: string; text: string; help?: ComponentChildren }) {
  return (
    <div class="lah-copyline" data-lah-copy={props.id}>
      <span class="lah-field-label">{props.label}</span>
      <div class="lah-copyline-row">
        <code class="lah-code">{props.text}</code>
        <CopyButton text={props.text} label={`Copy: ${props.label}`} size="md" />
      </div>
      {props.help !== undefined ? <span class="lah-field-help">{props.help}</span> : null}
    </div>
  );
}

/** The toasts, newest last, each with Dismiss; errors stay until dismissed. */
export function Toasts() {
  const app = useApp();
  const list = useSelect(app.toasts, (all) => all);
  if (list.length === 0) return null;
  return (
    <div class="lah-toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={t.tone === "error" ? "lah-toast lah-is-error" : "lah-toast"} role={t.tone === "error" ? "alert" : "status"}>
          <Icon name={t.tone === "error" ? "alert" : "info"} size={16} />
          <span class="lah-toast-text">{t.text}</span>
          <IconButton icon="close" label="Dismiss" size="sm" onClick={() => app.toasts.update((all) => all.filter((x) => x.id !== t.id))} />
        </div>
      ))}
    </div>
  );
}
