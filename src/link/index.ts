// The link between the runtime and the extension backend (DESIGN §6): its envelope, requests,
// pushes and versions, the readers each end checks what crossed with, and the bookkeeping both ends
// share (a stream's numbering, a large frame's parts).

export * from "./contract";
export * from "./frames";
export * from "./parts";
export * from "./stream";
export type { JsonObject, JsonValue } from "./json";
export { hasOwn, isRecord, toJson, toJsonObject } from "./json";
export * from "./settings";
