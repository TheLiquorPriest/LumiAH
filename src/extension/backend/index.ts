// The extension backend's pieces, for an extension that builds its own backend from them (DESIGN §1):
// the backend over a host, the host's interface and its Spindle implementation, and the settings'
// sections. `main.ts` is LumiAH's own entry and isn't part of this.

export { type Backend, type BackendEnv, type BackendOptions, CORE_KEY, createBackend, settingsSections } from "./backend";
export { type BackendIdentity, identityOf, LUMIAH } from "./identity";
export type { AnchorCodec } from "./chat";
export type { BackendExtension, BackendTools } from "./extension";
export { LinkRefused, UiRefused } from "./errors";
export { type SettingsSection, SettingsRefused, SettingsStore, type TextsDef } from "./settings";
export type { ActivatedInfo, BackendHost, GenerationEnded, GenerationStarted, GenerationStopped, HostBook, HostBookEntry, HostBookRecord, HostChat, HostConnection, HostDatabank, HostEntryRecord, HostGenerationType, HostLogLevel, HostMessage, HostPresetBlock, InterceptorInput, InterceptorVerdict, PassRequest, PromptMessage, PromptSlot, SwipeChanged } from "./spindle";
export { createSpindleHost } from "./spindle";
export { INTERCEPTOR_PRIORITY, TAGGED_TYPES, cutoff } from "./turns";
