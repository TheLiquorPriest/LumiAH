// One stylesheet for every LumiAH surface, added with `ctx.dom.addStyle`. Each area keeps its rules
// in its own module under styles/; they join here in a fixed order: the tokens and base rules, the
// shared atoms, the shell, then the areas, so an area's rule overrides an atom's at equal specificity.

import { COMPONENTS_CSS } from "./styles/components";
import { LIVE_CSS } from "./styles/live";
import { PAGES_CSS } from "./styles/pages";
import { SHELL_CSS } from "./styles/shell";
import { TOKENS_CSS } from "./styles/tokens";

export const CSS = [TOKENS_CSS, COMPONENTS_CSS, SHELL_CSS, LIVE_CSS, PAGES_CSS].join("\n");
