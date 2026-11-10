// The frontend as a package (`lumi-ah/extension/frontend`), for an extension that bundles LumiAH's
// pages into its own: `setup` for a drawer tab of its own name, or `createApp` and `mountPages` to
// put the pages in a root it chooses, over a channel and a host bridge it supplies; `CSS` is the one
// stylesheet they need. The transcript's pure model is here too, for a caller that reads a trace.

export { type App, type AppOptions, createApp, type HostBridge, type Nav, type PageId, type Prefs, type PrefsStorage } from "./app";
export { type Channel, UiClient, UiRequestError } from "./client";
export { createHost, type Host } from "./host";
export { TAB_ICON_SVG } from "./icons";
export { type AgentView, feedOf, type Filter, findMatches, NO_FILTER, transcriptMarkdown, turnTotals, type TurnTotals, turnView, type TurnView } from "./live-model";
export { LUMIAH_TAB, mountPages, setup, type TabOptions } from "./setup";
export { CSS } from "./styles";
