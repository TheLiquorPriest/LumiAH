// Tools (DESIGN §13, §16, §17): what each tier's calls do unless a tool says otherwise, the MCP
// servers the user set up in Lumiverse and whether agents are offered their tools, and every tool
// of the registry by family, with the one open beside the list: what a model is told of it, its
// arguments made readable, whether it is on, and whether its calls wait for the user. What the
// page decides is defs-model.ts; the definitions are read once for the Library (defs.tsx).

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ApprovalChoice, DefsView, McpServerView, ToolRow, ToolTier } from "../../../shared/ui";
import { useApp } from "../app";
import { Badge, Button, Chip, CopyButton, Disclosure, Empty, IconButton, SearchField, Section, Seg, Select, Switch, useBusy } from "../components";
import { DefsStale, DefsUnread, useDefs } from "../defs";
import { approvalSettingPath, CHOICE_LABEL, familiesOf, filtersOn, holdsWords, mcpAbout, mcpCountWords, mcpWords, NO_TOOL_FILTER, paramsOf, soundFilter, TIER_COVERS, TIER_TONE, TIERS, TOOL_CHOICES, type ToolChoice, type ToolFilter, tierChoiceWords, tierReach, toolCountWords, toolFacts, toolGroups } from "../defs-model";
import { Icon } from "../icons";
import { openSetting } from "../setting-links";
import { revealInScroller } from "../scroll";
import { useSelect } from "../store";

const TIER_CHOICES: readonly { value: ApprovalChoice; label: string }[] = [
  { value: "allow", label: CHOICE_LABEL.allow },
  { value: "ask", label: CHOICE_LABEL.ask },
];

/** What each tier's calls do unless a tool has a choice of its own. */
function Tiers(props: { view: DefsView; busy: boolean; onSet(tier: ToolTier, approval: ApprovalChoice): void }) {
  const app = useApp();
  const schema = useSelect(app.client.state, (s) => s?.settings.schema ?? null);
  const kept = schema !== null ? approvalSettingPath(schema) : null;
  return (
    <Section
      title="Which tool calls wait for your word"
      id="tiers"
      aside={
        kept !== null ? (
          <Button variant="ghost" icon="sliders" label="Open the approval settings" onClick={() => openSetting(app, "approvalKinds")}>
            In Settings
          </Button>
        ) : undefined
      }
    >
      <p class="lah-lead lah-small">Every tool is one of three kinds, by what it may touch. Allow lets agents call that kind freely; Ask first holds each call until you answer it on Live. A tool can have a choice of its own: open it in the list below.</p>
      {TIERS.map((tier) => (
        <div key={tier} class="lah-tools-tier" data-lah-tier={tier}>
          <div class="lah-tools-tier-head">
            <Badge tone={TIER_TONE[tier]}>{tier}</Badge>
            <span>{`${TIER_COVERS[tier]} ${tierReach(props.view.tools, tier)}`}</span>
          </div>
          <Seg label={`What ${tier} tools' calls do`} value={props.view.tiers[tier]} options={TIER_CHOICES} disabled={props.busy} onChange={(approval) => props.onSet(tier, approval)} />
        </div>
      ))}
    </Section>
  );
}

/** The MCP servers set up in Lumiverse, each on for agents or not. */
function Servers(props: { servers: readonly McpServerView[]; external: ApprovalChoice; busy: boolean; onSwitch(server: McpServerView, off: boolean): void }) {
  return (
    <Section title="MCP servers" id="mcp" aside={props.servers.length > 0 ? <span class="lah-small lah-muted">{mcpCountWords(props.servers)}</span> : undefined}>
      <p class="lah-lead lah-small" data-lah-mcp-about>
        {mcpAbout(props.external)}
      </p>
      {props.servers.length === 0 ? (
        <Empty icon="link" title="No MCP server yet">
          Set one up in Lumiverse's own MCP settings and it shows here, off until you switch it on.
        </Empty>
      ) : (
        props.servers.map((server) => {
          const words = mcpWords(server);
          return (
            <div key={server.id} class="lah-tools-server" data-lah-mcp={server.id} data-off={server.off || undefined}>
              <Switch
                checked={!server.off}
                disabled={props.busy}
                label={
                  <span class="lah-tools-server-name">
                    <span>{server.name}</span>
                    <code class="lah-mono lah-dim">{server.id}</code>
                    <Badge tone={words.tone}>{words.status}</Badge>
                  </span>
                }
                help={<span class="lah-small lah-muted">{words.line}</span>}
                onChange={(on) => props.onSwitch(server, !on)}
              />
            </div>
          );
        })
      )}
    </Section>
  );
}

function ToolLine(props: { tool: ToolRow; open: boolean; onOpen(): void }) {
  const { tool } = props;
  return (
    <button type="button" class="lah-navrow" aria-current={props.open} data-lah-tool={tool.name} data-off={tool.off || undefined} onClick={props.onOpen}>
      <span class="lah-navrow-text">
        <span class="lah-navrow-title lah-inline">
          <span class="lah-tools-name">{tool.name}</span>
          <Badge tone={TIER_TONE[tool.tier]}>{tool.tier}</Badge>
          {tool.asks ? <Badge tone="warn">asks first</Badge> : null}
          {tool.off ? <Badge>off</Badge> : null}
        </span>
        <span class="lah-defs-opening">{tool.description}</span>
      </span>
      <Icon name="chevron-right" size={16} class="lah-chev" />
    </button>
  );
}

/** One tool: what it is, whether agents are offered it, what its calls do, and its arguments. */
function ToolDetail(props: { tool: ToolRow; view: DefsView; busy: boolean; onBack(): void; onSwitch(off: boolean): void; onApproval(choice: ToolChoice): void }) {
  const { tool } = props;
  const params = paramsOf(tool.parameters);
  const json = tool.parameters ? JSON.stringify(tool.parameters, null, 2) : null;
  return (
    <>
      <div class="lah-pane-head">
        <span class="lah-back">
          <IconButton icon="chevron-left" label="Back to the tools" onClick={props.onBack} />
        </span>
        <span class="lah-pane-title">
          <strong class="lah-h lah-mono">{tool.name}</strong>
          <span class="lah-inline">
            <Badge tone={TIER_TONE[tool.tier]}>{tool.tier}</Badge>
            {tool.asks ? <Badge tone="warn">asks first</Badge> : null}
            {tool.off ? <Badge>off</Badge> : null}
          </span>
          <span class="lah-dim lah-small">{toolFacts(tool)}</span>
        </span>
      </div>
      <Section title="What a model is told it does" id="description">
        <p class="lah-tools-param-text">{tool.description !== "" ? tool.description : "It has no description."}</p>
      </Section>
      <Section title="Offered to agents" id="switch">
        <Switch checked={!tool.off} disabled={props.busy} label={tool.off ? "Off" : "On"} help={<span class="lah-small lah-muted">While it is off no agent is offered it, whatever its definition lists.</span>} onChange={(on) => props.onSwitch(!on)} />
      </Section>
      <Section title="Approval" id="approval">
        <Seg label={`What ${tool.name}'s calls do`} value={tool.approval ?? "tier"} options={TOOL_CHOICES} disabled={props.busy} onChange={props.onApproval} />
        <p class={tool.asks ? "lah-line lah-is-warn" : "lah-line"} data-lah-holds={tool.asks ? "ask" : "allow"}>
          <Icon name={tool.asks ? "shield" : "check"} size={14} />
          <span>{tool.approval === null ? holdsWords(tool) : `${holdsWords(tool)} ${tierChoiceWords(tool.tier, props.view.tiers)}`}</span>
        </p>
      </Section>
      <Section title="Arguments" id="arguments">
        {params.length === 0 ? (
          <p class="lah-lead lah-small">A call of it takes no arguments.</p>
        ) : (
          <ul class="lah-tools-params">
            {params.map((p) => (
              <li key={p.name} class="lah-tools-param" data-lah-param={p.name}>
                <span class="lah-tools-param-head">
                  <code class="lah-tools-name">{p.name}</code>
                  <span class="lah-tools-param-type">{p.type}</span>
                  <Badge tone={p.required ? "accent" : "neutral"}>{p.required ? "required" : "optional"}</Badge>
                </span>
                <span class="lah-tools-param-text">{p.description ?? "No description."}</span>
              </li>
            ))}
          </ul>
        )}
        {json !== null ? (
          <Disclosure summary={<span class="lah-small">The schema as JSON</span>}>
            <pre class="lah-code lah-tools-json">{json}</pre>
            <div class="lah-actions">
              <CopyButton text={json} label="Copy the schema" size="md" variant="secondary">
                Copy
              </CopyButton>
            </div>
          </Disclosure>
        ) : null}
      </Section>
    </>
  );
}

export function ToolsPage() {
  const app = useApp();
  const { read, again, take } = useDefs();
  const openName = useSelect(app.nav, (n) => n.def.tools);
  const [typed, setFilter] = useState<ToolFilter>(NO_TOOL_FILTER);
  const [busy, run] = useBusy();
  const listPane = useRef<HTMLDivElement>(null);
  const detailPane = useRef<HTMLDivElement>(null);
  /** The tool that was open last, so the list comes back at its row. */
  const left = useRef<string | null>(null);
  const view = read.view;
  const tool = view !== null && openName !== null ? (view.tools.find((t) => t.name === openName) ?? null) : null;
  const shownName = tool?.name ?? null;
  const open = (name: string | null): void => app.nav.update((n) => ({ ...n, def: { ...n.def, tools: name } }));
  // A tool picked from the list starts at its head; back in the list, the row left is where the eye is.
  useLayoutEffect(() => {
    if (shownName !== null) revealInScroller(detailPane.current, "start");
    else if (left.current !== null) revealInScroller(listPane.current?.querySelector(`[data-lah-tool="${CSS.escape(left.current)}"]`) ?? null, "center");
    left.current = shownName;
  }, [shownName]);
  // The tool open is gone (its MCP server was switched off): the list shows instead.
  const gone = view !== null && !read.reading && openName !== null && tool === null;
  useEffect(() => {
    if (gone) open(null);
  }, [gone]);
  if (view === null)
    return (
      <div class="lah-stack" data-lah-view="tools">
        <DefsUnread failed={read.failed} again={again} />
      </div>
    );

  const filter = soundFilter(typed, view.tools);
  const groups = toolGroups(view.tools, filter);
  const shown = groups.reduce((sum, g) => sum + g.tools.length, 0);
  /** Sends a change; its answer is the definitions as they then stand. */
  const change = (request: () => Promise<DefsView>, done: string): void =>
    run(async () => {
      try {
        take(await request());
        app.toast(done);
      } catch (error) {
        app.fail(error);
      }
    });
  return (
    <div class="lah-tools" data-lah-view="tools" data-pane={tool !== null ? "detail" : "list"}>
      <div class="lah-tools-top">
        <Tiers view={view} busy={busy} onSet={(tier, approval) => change(() => app.client.request("lah.tier.approval", { tier, approval }), `${tier.charAt(0).toUpperCase()}${tier.slice(1)} tools: ${CHOICE_LABEL[approval].toLowerCase()}.`)} />
        <Servers servers={view.mcp} external={view.tiers.external} busy={busy} onSwitch={(server, off) => change(() => app.client.request("lah.def.switch", { kind: "mcp", id: server.id, off }), `${server.name} is ${off ? "off" : "on"} for agents.`)} />
      </div>
      <div class="lah-split" data-pane={tool !== null ? "detail" : "list"}>
        <div class="lah-split-list" ref={listPane}>
          <div class="lah-tools-filter" data-lah-tool-filter>
            <SearchField value={filter.text} label="Filter the tools" placeholder="Filter the tools" status={filtersOn(filter) ? `${shown} of ${view.tools.length} shown` : undefined} onInput={(text) => setFilter({ ...filter, text })} />
            <div class="lah-chips" role="group" aria-label="Only tools of a tier, or that ask first">
              {TIERS.map((tier) => (
                <Chip key={tier} pressed={filter.tier === tier} onClick={() => setFilter({ ...filter, tier: filter.tier === tier ? null : tier })}>
                  {tier}
                </Chip>
              ))}
              <Chip pressed={filter.asks} onClick={() => setFilter({ ...filter, asks: !filter.asks })}>
                asks first
              </Chip>
            </div>
            <Select label="Only tools of a family" value={filter.family ?? ""} options={[{ value: "", label: "Every family" }, ...familiesOf(view.tools).map((family) => ({ value: family, label: `Family: ${family}` }))]} onChange={(family) => setFilter({ ...filter, family: family === "" ? null : family })} />
          </div>
          <DefsStale read={read} again={again} />
          <div class="lah-spread">
            <span class="lah-lead lah-small" data-lah-tool-count>{`${toolCountWords(shown, view.tools.length)}, by family.`}</span>
            {filtersOn(filter) ? (
              <Button size="sm" variant="ghost" icon="close" onClick={() => setFilter(NO_TOOL_FILTER)}>
                Clear the filter
              </Button>
            ) : null}
          </div>
          {view.tools.length === 0 ? (
            <Empty icon="wrench" title="No tools">
              The registry holds no tool. The runtime gives the core's own once it is linked: see the Runtime page.
            </Empty>
          ) : shown === 0 ? (
            <Empty icon="search" title="Nothing matches">
              No tool fits the filter. It reads names, families, tiers, descriptions and arguments' names.
            </Empty>
          ) : (
            <div class="lah-navlist" data-lah-tools>
              {groups.flatMap((group) => [
                <div key={`family:${group.family}`} class="lah-navhead">{`${group.family} · ${group.tools.length}`}</div>,
                ...group.tools.map((t) => <ToolLine key={t.name} tool={t} open={t.name === openName} onOpen={() => open(t.name)} />),
              ])}
            </div>
          )}
        </div>
        <div class="lah-split-detail" ref={detailPane}>
          {tool !== null ? (
            <ToolDetail
              key={tool.name}
              tool={tool}
              view={view}
              busy={busy}
              onBack={() => open(null)}
              onSwitch={(off) => change(() => app.client.request("lah.def.switch", { kind: "tool", id: tool.name, off }), `${tool.name} is ${off ? "off" : "on"}.`)}
              onApproval={(choice) => change(() => app.client.request("lah.tool.approval", { name: tool.name, approval: choice === "tier" ? null : choice }), choice === "tier" ? `${tool.name} does as ${tool.tier} tools do.` : `${tool.name}: ${CHOICE_LABEL[choice].toLowerCase()}.`)}
            />
          ) : (
            <Empty icon="wrench" title="Pick a tool">
              A tool shows what a model is told of it, its arguments, whether agents are offered it, and whether its calls wait for your word.
            </Empty>
          )}
        </div>
      </div>
    </div>
  );
}
