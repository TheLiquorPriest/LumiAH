// A settings form, drawn from the nodes `settings-model.ts` reads out of the schema: each setting a
// row with its label, its help, where it sits, the control that edits it, the Changed mark and the
// way back to its default; groups of settings as boxes, tables with rows to add and remove, and a
// setting with several shapes as a choice of shape over that shape's settings. A control commits a
// whole value at once (on a press, or when a typed value is left), so every change is one request.

import { useEffect, useId, useState } from "preact/hooks";
import { addConnectionWords } from "../../../shared/connections";
import type { JsonValue, ModelChoice, SettingPath } from "../../../shared/ui";
import { Badge, Button, Check, NumberField, Seg, Select, Switch, TextArea, TextInput } from "../components";
import { goneWords, type KnownConnections, modelsConnection, noneWords, pickerLabel, unlistedWords, whoseWords } from "../connections-model";
import { Icon } from "../icons";
import { besideNumber, changedCount, type Choice, type Control, type FormNode, initialOf, isBranch, linesOf, pathKey, sameJson, shownNumber, storedNumber, valueWords, withoutRow } from "../settings-model";

/** What a form's controls need from the page that holds it. */
export interface FormCtx {
  /** Keeps changes: each `set` a whole value at a path, each `reset` a path back to its default. */
  save(set: { path: SettingPath; value: JsonValue }[], reset?: SettingPath[]): void;
  /** A request is under way: controls rest until it answers. */
  busy: boolean;
  /** What the settings refused, by the path of the setting it is about (`pathKey`). */
  problems: ReadonlyMap<string, string>;
  /** The runtime's connections, which a setting that names a connection picks from (`useRuntimeConnections`). */
  connections: KnownConnections;
  /** The setting a search led to (`pathKey`), marked so it is found on the page. */
  found: string | null;
  /** The value now at a path of the settings. */
  at(path: SettingPath): JsonValue | undefined;
  /** The models a connection of the runtime's offers (null: the default connection); rejects where they can't be listed. */
  models(connectionId: string | null): Promise<ModelChoice[]>;
  /** The tools' names, for a table with a row per tool; left out where the page doesn't know them, and a name is then typed. */
  tools?: readonly string[];
  /** Each setting's row also says the key it is kept under (`core.agents.main.connectionId`): off unless the user asked for the details. */
  details?: boolean;
  /** Each setting's row says its default even while it is the default (the Timeouts page, where the default is part of each row). */
  defaults?: boolean;
}

/** A line under a connection's control: what the page can't say yet, or whose connections these are. */
function ConnectionsNote(props: { known: KnownConnections }) {
  const words = unlistedWords(props.known) ?? whoseWords(props.known);
  return words !== null ? (
    <span class="lah-field-help" style={{ flexBasis: "100%" }} data-lah-connections-note>
      {words}
    </span>
  ) : null;
}

/** One of several choices: a row of buttons while they are few and short, else a list. */
function ChoiceControl(props: { node: FormNode; options: readonly Choice[]; ctx: FormCtx }) {
  const { node, ctx } = props;
  const options = node.nullable && !props.options.some((o) => o.value === null) ? [{ value: null, label: node.none, help: null }, ...props.options] : props.options;
  const at = options.findIndex((o) => sameJson(o.value, node.value));
  const pick = (index: string): void => {
    const chosen = options[Number(index)];
    if (chosen) ctx.save([{ path: node.path, value: chosen.value }]);
  };
  const entries = options.map((o, i) => ({ value: String(i), label: o.label }));
  // Four short choices fit a phone's row as buttons; more, or longer ones, read better as a list.
  const few = options.length <= 4 && options.every((o) => o.label.length <= 14);
  return (
    <>
      {few ? <Seg label={node.label} value={at === -1 ? null : String(at)} options={entries} disabled={ctx.busy} onChange={pick} /> : <Select label={node.label} value={at === -1 ? "" : String(at)} options={entries} disabled={ctx.busy} onChange={pick} />}
      {options[at]?.help ? <span class="lah-field-help" style={{ flexBasis: "100%" }}>{options[at]?.help}</span> : null}
    </>
  );
}

/** A model's name, typed, with the models of the connection the agent runs on offered once they are listed: the one chosen beside it where the runtime has it, else the default. */
function ModelControl(props: { node: FormNode; connection: SettingPath | null; ctx: FormCtx }) {
  const { node, ctx } = props;
  const listId = useId();
  const named = props.connection ? ctx.at(props.connection) : null;
  const connectionId = modelsConnection(typeof named === "string" && named !== "" ? named : null, ctx.connections);
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Another connection has other models.
  useEffect(() => {
    setModels(null);
    setFailed(null);
  }, [connectionId]);
  const list = (): void => {
    if (models !== null || failed !== null) return;
    ctx.models(connectionId).then(
      (found) => setModels(found),
      (error: unknown) => setFailed(error instanceof Error ? error.message : String(error)),
    );
  };
  return (
    <>
      <TextInput label={node.label} value={typeof node.value === "string" ? node.value : ""} placeholder={node.nullable ? node.none : "A model's name"} list={listId} mono disabled={ctx.busy} onFocus={list} onCommit={(text) => ctx.save([{ path: node.path, value: text.trim() === "" && node.nullable ? null : text.trim() }])} />
      <datalist id={listId}>
        {(models ?? []).map((m) => (
          <option key={m.id} value={m.id} label={m.name !== m.id ? m.name : undefined} />
        ))}
      </datalist>
      {models !== null ? <span class="lah-field-help" style={{ flexBasis: "100%" }}>{models.length === 0 ? "The connection lists no models: type the name." : `The connection offers ${models.length} model${models.length === 1 ? "" : "s"}: start typing to pick one.`}</span> : null}
      {failed !== null ? <span class="lah-field-help" style={{ flexBasis: "100%" }}>{`The connection's models couldn't be listed (${failed}): type the name.`}</span> : null}
    </>
  );
}

/** A value with no form of its own, as JSON to edit: kept once it reads as JSON, and the settings then say whether it fits. */
function JsonControl(props: { node: FormNode; ctx: FormCtx }) {
  const { node, ctx } = props;
  const [wrong, setWrong] = useState<string | null>(null);
  return (
    <>
      <TextArea
        label={`${node.label}, as JSON`}
        value={JSON.stringify(node.value, null, 2)}
        rows={6}
        disabled={ctx.busy}
        invalid={wrong !== null}
        onCommit={(text) => {
          try {
            const value = JSON.parse(text) as JsonValue;
            setWrong(null);
            ctx.save([{ path: node.path, value }]);
          } catch (error) {
            setWrong(`This isn't JSON yet, so it wasn't kept: ${error instanceof Error ? error.message : String(error)}`);
          }
        }}
      />
      {wrong !== null ? (
        <span class="lah-field-error" role="alert" style={{ flexBasis: "100%" }}>
          <Icon name="alert" size={16} />
          {wrong}
        </span>
      ) : null}
    </>
  );
}

/** A set of choices, each ticked or not. */
function SetControl(props: { node: FormNode; options: readonly Choice[]; ctx: FormCtx }) {
  const { node, ctx } = props;
  const held = Array.isArray(node.value) ? node.value : [];
  const has = (value: JsonValue): boolean => held.some((v) => sameJson(v, value));
  const keep = (wanted: (o: Choice) => boolean): void => ctx.save([{ path: node.path, value: props.options.filter(wanted).map((o) => o.value) }]);
  return (
    <div class="lah-set-checks" role="group" aria-label={node.label}>
      <div class="lah-actions">
        <span class="lah-set-unit">{`${held.length} of ${props.options.length} on`}</span>
        <Button size="sm" variant="ghost" disabled={ctx.busy || held.length === props.options.length} onClick={() => keep(() => true)}>
          All
        </Button>
        <Button size="sm" variant="ghost" disabled={ctx.busy || held.length === 0} onClick={() => keep(() => false)}>
          None
        </Button>
      </div>
      {props.options.map((o, i) => (
        // A value that is its own label is a name (a tool's), shown as one; a label in words is read as words.
        <Check key={i} checked={has(o.value)} label={o.label === String(o.value) ? <code>{o.label}</code> : o.label} help={o.help ?? undefined} disabled={ctx.busy} onChange={(on) => keep((x) => (sameJson(x.value, o.value) ? on : has(x.value)))} />
      ))}
    </div>
  );
}

/**
 * The runtime's connections, each ticked or not: a setting that holds connection ids. An id the
 * setting holds that is none of the runtime's connections (one since removed, or one of
 * Lumiverse's from before the runtime kept its own) shows too, so what is stored is never hidden and
 * can be taken out; while the runtime's list isn't known, every id held shows as it is.
 */
function ConnectionsControl(props: { node: FormNode; ctx: FormCtx }) {
  const { node, ctx } = props;
  const view = ctx.connections.view;
  const held = Array.isArray(node.value) ? node.value.filter((v): v is string => typeof v === "string") : [];
  const offered = view?.connections ?? [];
  const gone = held.filter((id) => !offered.some((x) => x.id === id));
  const set = (id: string, on: boolean): void => ctx.save([{ path: node.path, value: on ? [...held.filter((x) => x !== id), id] : held.filter((x) => x !== id) }]);
  return (
    <div class="lah-set-checks" role="group" aria-label={node.label} data-lah-connections>
      <span class="lah-set-unit">{`${held.length} of ${offered.length + gone.length} on`}</span>
      {view !== null && offered.length + gone.length === 0 ? <span class="lah-field-help">{`The runtime has no connection yet. ${addConnectionWords("the Runtime page, under Connections")}`}</span> : null}
      {offered.map((x) => (
        <Check key={x.id} checked={held.includes(x.id)} label={pickerLabel(x, view ?? { providers: [] })} disabled={ctx.busy} onChange={(on) => set(x.id, on)} />
      ))}
      {gone.map((id) => (
        <Check key={id} checked label={<code>{id}</code>} help={view !== null ? "None of the runtime's connections has this id now: untick it to take it out." : undefined} disabled={ctx.busy} onChange={(on) => set(id, on)} />
      ))}
      <ConnectionsNote known={ctx.connections} />
    </div>
  );
}

/**
 * A number: typed plain in the unit it is shown in (a time in seconds or minutes, never
 * milliseconds), with its unit beside it and, once it is long, the number grouped. A setting that
 * may be none has that as a tick; unticked where its default is none too, the field shows empty and
 * nothing is kept until a number is typed: a limit made up here would be saved at once, and a limit
 * of one token stops every call.
 */
function NumberControl(props: { node: FormNode; control: Extract<Control, { kind: "number" }>; ctx: FormCtx }) {
  const { node, control: c, ctx } = props;
  const [typing, setTyping] = useState(false);
  const kept = typeof node.value === "number" ? node.value : null;
  const fallback = typeof node.fallback === "number" ? node.fallback : null;
  const none = kept === null && !typing;
  const shown = shownNumber(c, kept, fallback);
  const beside = besideNumber(shown.value, shown.unit);
  const set = (value: JsonValue): void => ctx.save([{ path: node.path, value }]);
  const tick = (on: boolean): void => {
    setTyping(!on && fallback === null);
    if (on && kept !== null) set(null);
    if (!on && fallback !== null) set(fallback);
  };
  return (
    <>
      {node.nullable ? <Check checked={none} label={node.none} disabled={ctx.busy} onChange={tick} /> : null}
      {none ? null : <NumberField label={node.label} value={shown.value} integer={shown.integer} step={shown.step} disabled={ctx.busy} invalid={ctx.problems.has(pathKey(node.path))} onChange={(typed) => set(storedNumber(shown, typed))} {...(shown.min !== null ? { min: shown.min } : {})} {...(shown.max !== null ? { max: shown.max } : {})} />}
      {!none && beside !== null ? (
        <span class="lah-set-unit" data-lah-unit={shown.unit ?? undefined}>
          {beside}
        </span>
      ) : null}
      {kept === null && typing ? <span class="lah-field-help" style={{ flexBasis: "100%" }}>Type a number: it is kept when you leave the field.</span> : null}
    </>
  );
}

/** The control that edits a setting's value. */
function LeafControl(props: { node: FormNode; control: Exclude<Control, { kind: "group" | "table" | "variant" }>; ctx: FormCtx }) {
  const { node, control: c, ctx } = props;
  const set = (value: JsonValue): void => ctx.save([{ path: node.path, value }]);
  switch (c.kind) {
    case "boolean":
      return <Switch checked={node.value === true} label={node.value === true ? "On" : "Off"} disabled={ctx.busy} onChange={set} />;
    case "number":
      return <NumberControl node={node} control={c} ctx={ctx} />;
    case "choice":
      return <ChoiceControl node={node} options={c.options} ctx={ctx} />;
    case "connection": {
      const value = typeof node.value === "string" ? node.value : "";
      const known = ctx.connections;
      const view = known.view;
      // An id none of the runtime's connections has is offered as itself, said to be gone, so what is stored is never hidden.
      const gone = goneWords(value === "" ? null : value, known);
      const options = [...(node.nullable ? [{ value: "", label: noneWords(node.none, known) }] : []), ...(gone !== null ? [{ value, label: `${value} (no connection of the runtime's now)` }] : []), ...(view?.connections ?? []).map((x) => ({ value: x.id, label: pickerLabel(x, view ?? { providers: [] }) }))];
      return (
        <>
          <Select label={node.label} value={value} options={options} disabled={ctx.busy} invalid={ctx.problems.has(pathKey(node.path))} onChange={(id) => set(id === "" && node.nullable ? null : id)} />
          {gone !== null ? (
            <span class="lah-line lah-is-warn" style={{ flexBasis: "100%" }} data-lah-gone>
              <Icon name="alert" size={14} />
              <span>{gone}</span>
            </span>
          ) : null}
          <ConnectionsNote known={known} />
        </>
      );
    }
    case "model":
      return <ModelControl node={node} connection={c.connection} ctx={ctx} />;
    case "text": {
      const value = typeof node.value === "string" ? node.value : "";
      const commit = (text: string): void => set(text === "" && node.nullable ? null : text);
      return c.multiline ? (
        <TextArea label={node.label} value={value} placeholder={node.nullable ? node.none : undefined} disabled={ctx.busy} onCommit={commit} {...(c.maxLength !== null ? { maxLength: c.maxLength } : {})} />
      ) : (
        <TextInput label={node.label} value={value} placeholder={node.nullable ? node.none : undefined} disabled={ctx.busy} onCommit={commit} {...(c.maxLength !== null ? { maxLength: c.maxLength } : {})} />
      );
    }
    case "set":
      return <SetControl node={node} options={c.options} ctx={ctx} />;
    case "connections":
      return <ConnectionsControl node={node} ctx={ctx} />;
    case "list":
      return (
        <>
          <TextArea label={`${node.label}, one a line`} value={Array.isArray(node.value) ? node.value.map(String).join("\n") : ""} rows={4} disabled={ctx.busy} onCommit={(text) => set(linesOf(text))} />
          <span class="lah-field-help" style={{ flexBasis: "100%" }}>One a line.</span>
        </>
      );
    case "json":
      return <JsonControl node={node} ctx={ctx} />;
  }
}

/** A setting's default in a few words, for the way back to it. A long one is cut: the button names where it leads, it doesn't show the value. */
function defaultWords(node: FormNode): string {
  const words = valueWords({ ...node, value: node.fallback });
  return words.length > 32 ? `${words.slice(0, 30)}…` : words;
}

/** One setting: what it is, and its control. */
function Leaf(props: { node: FormNode; control: Exclude<Control, { kind: "group" | "table" | "variant" }>; ctx: FormCtx; bare?: boolean }) {
  const { node, ctx } = props;
  const key = pathKey(node.path);
  const problem = ctx.problems.get(key) ?? null;
  const k = props.control.kind;
  const wide = k === "set" || k === "connections" || k === "json" || k === "list" || (props.control.kind === "text" && props.control.multiline);
  return (
    <div class={wide ? "lah-set-row lah-is-wide" : "lah-set-row"} data-lah-setting={node.path.join(".")} data-changed={node.changed || undefined} data-lah-found={ctx.found === key || undefined}>
      <div class="lah-set-about">
        <div class="lah-set-row-head">
          <span class="lah-set-label">{props.bare ? "Value" : node.label}</span>
          {node.changed ? <Badge tone="accent">changed</Badge> : null}
        </div>
        {node.help ? <p class="lah-field-help">{node.help}</p> : null}
        {ctx.details ? <span class="lah-set-path">{node.path.join(".")}</span> : null}
      </div>
      <div class="lah-set-edit">
        <div class="lah-set-control">
          <LeafControl node={node} control={props.control} ctx={ctx} />
        </div>
        {problem !== null ? (
          <span class="lah-field-error" role="alert">
            <Icon name="alert" size={16} />
            {problem}
          </span>
        ) : null}
        {node.changed ? (
          <div class="lah-actions">
            <Button size="sm" variant="ghost" icon="undo" disabled={ctx.busy} label={`Put ${node.label} back to its default`} onClick={() => ctx.save([], [node.path])}>
              {`Default: ${defaultWords(node)}`}
            </Button>
          </div>
        ) : ctx.defaults ? (
          <span class="lah-field-help" data-lah-default>{`Default: ${defaultWords(node)}`}</span>
        ) : null}
      </div>
    </div>
  );
}

/** The row that adds a row to a table: its name (a connection, a model, or any name), then Add. */
function AddRow(props: { node: FormNode; control: Extract<Control, { kind: "table" }>; ctx: FormCtx }) {
  const { node, control: c, ctx } = props;
  const [name, setName] = useState("");
  const taken = new Set(c.rows.map((r) => r.key));
  const add = (): void => {
    const key = name.trim();
    if (key === "" || taken.has(key)) return;
    ctx.save([{ path: [...node.path, key], value: initialOf(c.row) }]);
    setName("");
  };
  const free = (ctx.connections.view?.connections ?? []).filter((x) => !taken.has(x.id));
  const tools = c.keys === "tool" && ctx.tools ? ctx.tools.filter((t) => !taken.has(t)) : null;
  return (
    <div class="lah-set-add" data-lah-add={node.path.join(".")}>
      {c.keys === "connection" ? (
        <Select label={`A connection to add to ${node.label}`} value={name} options={[{ value: "", label: free.length > 0 ? "Choose a connection…" : ctx.connections.view === null ? "The runtime's connections show once one is linked" : "Every connection has a row" }, ...free.map((x) => ({ value: x.id, label: pickerLabel(x, ctx.connections.view ?? { providers: [] }) }))]} disabled={ctx.busy} onChange={setName} />
      ) : tools !== null ? (
        <Select label={`A tool to add to ${node.label}`} value={name} options={[{ value: "", label: tools.length === 0 ? "Every tool has a row" : "Choose a tool…" }, ...tools.map((t) => ({ value: t, label: t }))]} disabled={ctx.busy} onChange={setName} />
      ) : (
        <input class="lah-input lah-mono" aria-label={c.keys === "model" ? `A model's name to add to ${node.label}` : c.keys === "tool" ? `A tool's name to add to ${node.label}` : `A name to add to ${node.label}`} placeholder={c.keys === "model" ? "A model's name" : c.keys === "tool" ? "A tool's name" : "A name"} value={name} autocomplete="off" spellcheck={false} disabled={ctx.busy} onInput={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === "Enter" && add()} />
      )}
      <Button icon="plus" disabled={ctx.busy || name.trim() === "" || taken.has(name.trim())} onClick={add}>
        Add
      </Button>
      {taken.has(name.trim()) && name.trim() !== "" ? <span class="lah-field-help" style={{ flexBasis: "100%" }}>It has a row already.</span> : null}
    </div>
  );
}

/** A group of settings, a table of rows, or a setting with several shapes: a box with its name, its way back to its defaults, and what it holds. */
function Branch(props: { node: FormNode; ctx: FormCtx; top?: boolean }) {
  const { node, ctx } = props;
  const c = node.control;
  const changed = changedCount(node);
  const problem = ctx.problems.get(pathKey(node.path)) ?? null;
  const rowName = (key: string): string => (c.kind === "table" && c.keys === "connection" ? (ctx.connections.view?.connections.find((x) => x.id === key)?.name ?? key) : key);
  return (
    <div class="lah-set-group" data-lah-group={node.path.join(".")}>
      {props.top ? null : (
        <div class="lah-set-group-head">
          <span class="lah-set-group-title">{node.label}</span>
          {changed > 0 ? (
            <Button size="sm" variant="ghost" icon="undo" disabled={ctx.busy} label={`Put everything in ${node.label} back to its default`} onClick={() => ctx.save([], [node.path])}>
              {`Defaults (${changed} changed)`}
            </Button>
          ) : null}
        </div>
      )}
      {!props.top && node.help ? <p class="lah-set-group-help">{node.help}</p> : null}
      {problem !== null ? (
        <span class="lah-field-error lah-set-group-help" role="alert">
          <Icon name="alert" size={16} />
          {problem}
        </span>
      ) : null}
      {c.kind === "variant" ? (
        <div class="lah-set-row lah-is-wide" data-lah-setting={[...node.path, c.property].join(".")}>
          <div class="lah-set-edit">
            <div class="lah-set-control">
              {c.variants.length <= 4 && c.variants.every((v) => v.label.length <= 14) ? (
                <Seg label={node.label} value={c.current === -1 ? null : String(c.current)} options={c.variants.map((v, i) => ({ value: String(i), label: v.label }))} disabled={ctx.busy} onChange={(i) => ctx.save([{ path: node.path, value: initialOf(c.variants[Number(i)]?.schema ?? {}) }])} />
              ) : (
                <Select label={node.label} value={c.current === -1 ? "" : String(c.current)} options={c.variants.map((v, i) => ({ value: String(i), label: v.label }))} disabled={ctx.busy} onChange={(i) => ctx.save([{ path: node.path, value: initialOf(c.variants[Number(i)]?.schema ?? {}) }])} />
              )}
            </div>
            {c.variants[c.current]?.help ? <span class="lah-field-help">{c.variants[c.current]?.help}</span> : null}
          </div>
        </div>
      ) : null}
      {c.kind === "table" ? (
        <>
          {c.rows.length === 0 ? <p class="lah-set-group-help" style={{ padding: "var(--lah-s3)" }}>No rows yet.</p> : null}
          {c.rows.map((row) => (
            <div key={row.key} class="lah-set-tablerow" data-lah-row={row.key}>
              <div class="lah-set-tablerow-head">
                <span class="lah-set-tablerow-key">{rowName(row.key)}</span>
                <Button size="sm" variant="ghost" icon="trash" disabled={ctx.busy} label={`Remove ${rowName(row.key)} from ${node.label}`} onClick={() => ctx.save([{ path: node.path, value: withoutRow(node, row.key) }])}>
                  Remove
                </Button>
              </div>
              {isBranch(row) ? <Fields nodes={row.control.kind === "group" ? row.control.fields : [row]} ctx={ctx} /> : <FieldNode node={row} ctx={ctx} bare />}
            </div>
          ))}
          <AddRow node={node} control={c} ctx={ctx} />
        </>
      ) : null}
      {c.kind === "group" || c.kind === "variant" ? <Fields nodes={c.fields} ctx={ctx} /> : null}
    </div>
  );
}

/** One node of the form: a setting's row, or a box of them. */
export function FieldNode(props: { node: FormNode; ctx: FormCtx; bare?: boolean; top?: boolean }) {
  const c = props.node.control;
  if (c.kind === "group" || c.kind === "table" || c.kind === "variant") return <Branch node={props.node} ctx={props.ctx} top={props.top} />;
  return <Leaf node={props.node} control={c} ctx={props.ctx} bare={props.bare} />;
}

/** Nodes in order. */
export function Fields(props: { nodes: readonly FormNode[]; ctx: FormCtx }) {
  return (
    <>
      {props.nodes.map((node) => (
        <FieldNode key={pathKey(node.path)} node={node} ctx={props.ctx} />
      ))}
    </>
  );
}
