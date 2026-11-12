// A runtime's update from the extension, its memory limit and the unit that keeps it running.

export { nodeFiles } from "./files";
export { DEFAULT_MEMORY, MEMORY_FLOOR, memoryBytes, memoryRefusal } from "./memory";
export type { ProcessControl, Successor } from "./restart";
export { handOver, nodeProcess } from "./restart";
export type { ThisProcess } from "./service";
export { installedCopy, systemctlOf, unitPath, unitRunning, unitText } from "./service";
export type { OfferOutcome, SetOutcome, Update, UpdateDeps, UpdateFiles, UpdateOffer, UpdateView } from "./update";
export { createUpdate } from "./update";
