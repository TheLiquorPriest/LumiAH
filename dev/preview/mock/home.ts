// Home's part of the stand-in backend: the one read the first screen makes (`lah.home.get`), and
// the permissions the story's Lumiverse has not granted LumiAH in each of the preview's scenarios
// (DESIGN §25: a new user grants them, switches a chat on, and that is all of setup).

import type { PermissionNeed } from "../../../src/shared/ui";
import type { Handlers, HomeCtx } from "./ctx";

type Requests = "lah.home.get";

const TODO = "Grant it in Lumiverse: Extensions, LumiAH, Permissions.";

/** What LumiAH asks of Lumiverse, by Lumiverse's own names: what each is for, and what is lost without it. Four of them it works on no reply without; the rest switch a part of it on. */
const ASKS: readonly PermissionNeed[] = [
  { id: "interceptor", what: "see a reply's prompt before Lumiverse sends it", without: "no reply is worked on", todo: TODO, needed: true },
  { id: "chats", what: "read a chat and switch itself on for it", without: "no chat can be switched on", todo: TODO, needed: true },
  { id: "generation", what: "make its agents' model calls, and hear when a reply starts and ends", without: "its agents can't call a model", todo: TODO, needed: true },
  { id: "chat_mutation", what: "read the chat's messages and write each reply's record on it", without: "no reply is worked on", todo: TODO, needed: true },
  { id: "generation_parameters", what: "mark the replies a runtime works on", without: "no chat can run in a runtime (one that runs built in needs it for nothing)", todo: TODO, needed: false },
  { id: "world_books", what: "read your world books", without: "agents can't look up lore", todo: TODO, needed: false },
  { id: "mcp_servers", what: "use the tools of your MCP servers", without: "agents aren't offered those tools", todo: TODO, needed: false },
];

/** The permissions LumiAH lacks as a scenario opens: all of them on a fresh install, none once set up, and in `trouble` one it works on no reply without and one only a part of it rests on. */
export function missingPermissions(scenario: "ready" | "fresh" | "trouble"): PermissionNeed[] {
  if (scenario === "ready") return [];
  if (scenario === "fresh") return ASKS.map((p) => ({ ...p }));
  return ASKS.filter((p) => p.id === "generation" || p.id === "mcp_servers").map((p) => ({ ...p }));
}

export function homeMock(ctx: HomeCtx): Handlers<Requests> {
  return {
    "lah.home.get": (r) => (r.chatId === null ? { chat: null, last: null } : { chat: ctx.chat(r.chatId), last: ctx.last(r.chatId) }),
  };
}
