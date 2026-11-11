// One well-formed body for every request of the contract, shared by the tests that go through all
// of them (what the backend takes for a request; that the stand-in backend answers each). A request
// added to the contract must be added here to compile. The values name what the preview's made-up
// data holds, so the stand-in backend can answer them as they are; a test that needs a value only
// a live answer gives (a turn's id, a file's current version) puts its own over these.

import { baseAgents } from "../../src/core/agents";
import type { AgentDefinition, UiRequests, UiRequestType } from "../../src/shared/ui";

const HASH = "b".repeat(64);

/** A definition of the user's, made from the core's own main agent so it is whole and sound. */
export function userAgent(id: string, name: string): AgentDefinition {
  const [main] = baseAgents();
  if (!main) throw new Error("the core ships no agent definition");
  const { text: _text, ...own } = main;
  return { ...own, id, name, description: "Keeps the chat's notes.", instructions: "You keep this chat's notes.", given: "task" };
}

export const BODIES: { [K in UiRequestType]: UiRequests[K]["body"] } = {
  "lah.hello": { active: "conn-deepseek" },
  "lah.chat.get": { chatId: "chat-mara" },
  "lah.chat.set": { chatId: "chat-mara", on: true },
  "lah.chat.takeover": { chatId: "chat-joss" },
  "lah.chat.story.get": { chatId: "chat-mara" },
  "lah.chat.story.set": { chatId: "chat-mara", story: { from: "replies" } },
  "lah.live.open": { stream: "chat-mara" },
  "lah.live.events": { stream: "chat-mara", turn: "turn-1", from: 1 },
  "lah.live.close": { stream: "chat-mara" },
  "lah.turn.stop": { stream: "chat-mara", turn: "turn-1" },
  "lah.turn.say": { stream: "chat-mara", turn: "turn-1", text: "Keep it short." },
  "lah.turn.pause": { stream: "chat-mara", turn: "turn-1", on: true },
  "lah.approval.answer": { id: "held-1", answer: { decision: "refused", reason: "Not while Brann is in the room." } },
  "lah.approvals.kept": { chatId: "chat-mara" },
  "lah.approval.forget": { chatId: "chat-mara", tool: "workspace_write" },
  "lah.turns.list": { chatId: "chat-mara", cursor: null, limit: 20 },
  "lah.transcript.get": { transcript: "t".repeat(64), from: 1 },
  "lah.prompt.get": { prompt: "p".repeat(64) },
  "lah.blob.get": { hash: HASH },
  "lah.session.rollback": { chatId: "chat-mara", messageId: "msg-1", swipe: 0 },
  "lah.session.summarize": { chatId: "chat-mara" },
  "lah.settings.set": { set: [{ path: ["core", "reply", "writer"], value: null }], reset: [[]] },
  "lah.models.list": { connectionId: null },
  "lah.text.set": { id: "main.system", text: "" },
  "lah.text.reset": { id: "main.system" },
  "lah.key": { op: "mint" },
  "lah.relay": { op: "rotate", relay: "relay-1" },
  "lah.drawer.close": {},
  "lah.ws.list": { chatId: "chat-mara", area: "chat" },
  "lah.ws.read": { chatId: "chat-mara", area: "chat", path: "notes/ledger.md" },
  "lah.ws.write": { chatId: null, area: "user", path: "style/dialogue.md", text: "Short lines. No speech tags where the speaker is plain.", base: null },
  "lah.ws.move": { chatId: "chat-mara", area: "chat", from: "people/joss.md", to: "people/joss-of-the-tavern.md", base: HASH },
  "lah.ws.delete": { chatId: "chat-mara", area: "chat", path: "people/joss.md", base: HASH },
  "lah.ws.pin": { chatId: "chat-mara", area: "chat", path: "notes/ledger.md", agent: "main", on: true },
  "lah.ws.history": { chatId: "chat-mara", area: "chat", path: "notes/ledger.md" },
  "lah.ws.changes": { chatId: "chat-mara", messageId: "msg-0043", swipe: 0 },
  "lah.guidance.get": { chatId: "chat-mara" },
  "lah.guidance.set": { chatId: "chat-mara", level: "chat", text: "Joss never lies to Mara, though he leaves things out.", base: null },
  "lah.defs.get": {},
  "lah.agent.save": { agent: userAgent("harbour-clerk", "Harbour clerk") },
  "lah.skill.save": { skill: { id: "note-a-promise", name: "Note a promise", description: "How to write down something one person promised another.", body: "1. Say who promised whom.\n2. Say what, and by when.\n3. Give the reply it was said in." } },
  "lah.def.remove": { kind: "agent", id: "archivist" },
  "lah.def.switch": { kind: "tool", id: "lore_search", off: true },
  "lah.tool.approval": { name: "workspace_write", approval: "ask" },
  "lah.tier.approval": { tier: "external", approval: "ask" },
  "lah.jobs.list": { chatId: null, cursor: null, limit: 20 },
  "lah.jobs.set": { paused: true },
  "lah.job.start": { chatId: "chat-mara", agent: "archivist", task: "Bring notes/timeline.md up to date.", when: "now", allowance: { tokensIn: 200_000, wallMs: null } },
  "lah.job.cancel": { id: "job-timeline-2" },
  "lah.job.again": { id: "job-timeline-1" },
  "lah.job.grant": { id: "job-story-so-far", allowance: { tokensIn: 400_000, tokensOut: 40_000 } },
  "lah.job.resume": { id: "job-paused" },
  "lah.notice.dismiss": { id: null },
  "lah.side.list": {},
  "lah.side.start": { agent: "archivist", chatId: null },
  "lah.side.turns": { session: "side-notes", cursor: null, limit: 20 },
  "lah.side.send": { session: "side-notes", text: "What do we know of Ilse?" },
  "lah.side.remove": { session: "side-plain" },
  "lah.spend.get": { days: 30 },
  "lah.upkeep.get": {},
  "lah.upkeep.sweep": {},
  "lah.home.get": { chatId: "chat-mara" },
  "lah.lore.get": { chatId: "chat-mara" },
  "lah.lore.entry": { chatId: "chat-mara", entryId: "lore-harbour-office" },
  "lah.lore.search": { chatId: "chat-mara", queries: ["night key", "who signed the ledger"], limit: 5 },
  "lah.lore.embed": { chatId: "chat-mara", start: false },
  "lah.chronicle.get": { chatId: "chat-mara" },
  "lah.chronicle.cited": { chatId: "chat-mara", citations: ["[#38 a3f9c27e]"] },
  "lah.story.get": { chatId: "chat-mara" },
};
