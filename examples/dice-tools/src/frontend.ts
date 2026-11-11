// The frontend's entry (`dist/frontend.js`): Lumiverse calls `setup` with the page's context.
// LumiAH's pages go in one drawer tab under this extension's name.

import { setup as lumiah } from "lumi-ah/extension/frontend";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";

export function setup(ctx: SpindleFrontendContext): () => void {
  return lumiah(ctx, { id: "dice-tools", title: "Dice Tools", shortName: "Dice", description: "LumiAH's agents with real dice: switch them on for a chat, watch them work, and set them up" });
}
