// One stylesheet for every LumiAH surface, added with `ctx.dom.addStyle`. Each area keeps its rules
// in its own module under styles/; they join here in a fixed order: the tokens and base rules, the
// shared atoms, the shell, then the areas, so an area's rule overrides an atom's at equal specificity.

import { CHRONICLE_CSS } from "./styles/chronicle";
import { COMPONENTS_CSS } from "./styles/components";
import { DEFS_CSS } from "./styles/defs";
import { HOME_CSS } from "./styles/home";
import { JOBS_CSS } from "./styles/jobs";
import { LIVE_CSS } from "./styles/live";
import { LORE_CSS } from "./styles/lore";
import { PAGES_CSS } from "./styles/pages";
import { SHELL_CSS } from "./styles/shell";
import { SPEND_CSS } from "./styles/spend";
import { TALK_CSS } from "./styles/talk";
import { TOKENS_CSS } from "./styles/tokens";
import { WORKSPACE_CSS } from "./styles/workspace";

export const CSS = [TOKENS_CSS, COMPONENTS_CSS, SHELL_CSS, LIVE_CSS, PAGES_CSS, HOME_CSS, WORKSPACE_CSS, DEFS_CSS, JOBS_CSS, SPEND_CSS, TALK_CSS, LORE_CSS, CHRONICLE_CSS].join("\n");
