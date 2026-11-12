// The rig's compare mode for a whole run: `bun test --preload ./test/support/compare.ts`. Every runtime
// a rig starts asks each read of chats and world books of both roads, its own copy and the link
// (roads.ts), and a test in which the two answered differently fails, saying where.

import { afterEach } from "bun:test";
import { roads } from "./roads";

roads.road = "both";

afterEach(() => {
  const found = roads.differences.splice(0);
  if (found.length > 0) throw new Error(`The runtime's copy and the link answered differently:\n${found.join("\n")}`);
});
