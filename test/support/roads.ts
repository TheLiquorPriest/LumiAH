// Which road the rig's runtimes read chats and world books by (src/runtime/reads.ts): their own copy, as
// every runtime does (the default); the link alone; or both, every read asked of both roads and the
// answers compared, each difference kept here so the test it happened in fails (compare.ts:
// `bun test --preload ./test/support/compare.ts`). `LUMIAH_READS` sets it for a whole run.

export type Road = "copy" | "link" | "both";

const asked = process.env.LUMIAH_READS;

export const roads: { road: Road; differences: string[] } = {
  road: asked === "link" || asked === "both" ? asked : "copy",
  differences: [],
};
