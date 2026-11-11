// Every setting a page leads to ("Open the setting", "Set a limit"), in one place, so a test can
// hold each to a section Settings really has: a link that named none used to open Settings on its
// first section, with no word. Each is named by its place among the core's own settings, or the
// transport's own; where the settings shown keep those inside a section (`core` and `transport` in
// LumiAH's own), the Settings page finds it there (`settingPlace`). A page leads to a setting only
// through `openSetting`, or with a whole path the backend gave it (a cap's, a kept kind's).

import type { App } from "./app";

export const SETTING_LINKS = {
  /** The most characters a level of guidance may hold. */
  guidanceLength: ["guidance", "chars"],
  /** Whether agents may edit the chat's guidance. */
  guidanceAgentsEdit: ["guidance", "agentsEdit"],
  /** How big a file, and an area, of the workspace may be. */
  workspaceLimits: ["workspace", "fileChars"],
  /** Search by meaning: its switch, its day's limit, and the price of the model it uses. */
  meaningSwitch: ["recall", "meaning", "enabled"],
  meaningCap: ["recall", "meaning", "tokensPerDay"],
  meaningPrice: ["recall", "meaning", "usdPerMillion"],
  /** Which kinds of tool call ask permission first. */
  approvalKinds: ["approval", "tiers", "read"],
  /** What jobs may spend in a day, and each job by itself. */
  jobsLimits: ["jobs", "tokensPerDay"],
  /** What every agent may spend in a day, in tokens and in money. */
  dayTokens: ["spend", "tokensPerDay"],
  dayCost: ["spend", "costPerDay"],
  /** The connection and model the main agent thinks with: where a model that can't call tools is changed. */
  agentsModel: ["agents", "main", "connectionId"],
  /** What the main agent may spend on one reply, and what every agent of a turn may spend together: where a limit a reply stopped at is raised. */
  agentLimits: ["agents", "main", "budget", "toolTurns"],
  turnLimits: ["turn", "tokensIn"],
  /** How far the chat may be past its chronicle before that counts as behind: Home offers Learn this story past it. */
  chronicleTail: ["recall", "chronicle", "tail"],
  /** How much of the chat stays in the prompt word for word. */
  historyKept: ["history", "keep"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type SettingLink = keyof typeof SETTING_LINKS;

/** Opens Settings on a setting, marked. */
export function openSetting(app: Pick<App, "nav">, link: SettingLink): void {
  app.nav.update((n) => ({ ...n, page: "settings", setting: [...SETTING_LINKS[link]] }));
}
