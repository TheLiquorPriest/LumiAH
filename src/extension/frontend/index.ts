// The frontend as a package (`lumi-ah/extension/frontend`), for an extension that builds LumiAH
// into itself (DESIGN §21): `setup` for a drawer tab of its own name; or `createApp` and
// `mountPages` to put the pages (all, or those it names) in a root it chooses, over a channel and a
// host bridge it supplies; or a single page as a component (`PAGE_VIEW`, rendered inside
// `AppContext.Provider`) wherever in its own drawer it likes. `CSS` is the one stylesheet they
// need. The transcript's pure model is here too, for a caller that reads a trace; and the
// runtime's connections as a page app knows them, with the words a picker of them says, for an
// extension's own page that picks an agent's connection.

export { type App, AppContext, type AppOptions, createApp, type GroupId, GROUPS, type HostBridge, type Nav, type PageEntry, type PageId, PAGES, type Prefs, type PrefsStorage, ShownPagesContext } from "./app";
export { type Channel, UiClient, UiRequestError } from "./client";
export { ConnectionsSection, ConnectionsWanted, leadToConnections, useRuntimeConnections } from "./connections";
export { goneWords, type KnownConnections, modelsConnection, noneWords, pickerLabel, unlistedWords, whoseWords } from "./connections-model";
export { createHost, type Host } from "./host";
export { TAB_ICON_SVG } from "./icons";
export { type AgentView, feedOf, type Filter, findMatches, NO_FILTER, transcriptMarkdown, turnTotals, type TurnTotals, turnView, type TurnView } from "./live-model";
export { LUMIAH_TAB, mountPages, setup, type TabOptions } from "./setup";
export { PAGE_VIEW, Shell } from "./shell";
export { CSS } from "./styles";
