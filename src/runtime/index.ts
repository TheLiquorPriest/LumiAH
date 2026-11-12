// The runtime as a package (DESIGN §1: "another extension uses LumiAH as a package"): an extension
// that loads its own definitions into the runtime builds its own entry around these, the way
// main.ts does around the core's harness.

export type { RuntimeConfig } from "./config";
export { configDir, configOf, configPathOf, configText } from "./config";
export type { OwnedEntry, RuntimeFiles, RuntimeIO, ServeOptions, Served } from "./cli";
export { USAGE, lumiah, serve } from "./cli";
export type { OpenSocket, Socket, SocketEvents } from "./connection";
export { HostConnection, LinkError } from "./connection";
export { ModelCallError, linkHost } from "./host";
export type { LinkHandlers, OutOfReach, RuntimeLink } from "./link";
export { LinkClient } from "./link";
export type { Http, HttpReply, HttpRequest, StoredLogin } from "./lumiverse";
export { LiveError } from "./lumiverse";
export type { Runtime, RuntimeDeps } from "./runtime";
export { createRuntime } from "./runtime";
export type { Harness } from "./turn";
export type { OfferOutcome, ProcessControl, SetOutcome, Successor, ThisProcess, Update, UpdateDeps, UpdateFiles, UpdateOffer, UpdateView } from "./update";
export { DEFAULT_MEMORY, MEMORY_FLOOR, createUpdate, handOver, installedCopy, memoryBytes, memoryRefusal, nodeFiles, nodeProcess, systemctlOf, unitPath, unitRunning, unitText } from "./update";
