// What the page bar and the strip under it say: which pages carry a mark, and where each thing
// that waits for the user is shown.

import { describe, expect, test } from "bun:test";
import { MockBackend } from "../../dev/preview/mock-backend";
import { sampleSettings } from "../../dev/preview/sections";
import { groupOf, GROUPS, type Nav, PAGES, START_NAV } from "../../src/extension/frontend/app";
import { approvalTarget, attentionOf, badgeOf, groupMark, noticeWords, PAGE_ICON, pageMarks, shownGroups, shownPage, shows, stripOver } from "../../src/extension/frontend/nav-model";
import type { ApprovalView, ChatView, JobView, Notice, PermissionNeed, RelayView, RunningTurn, UiState } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const settled = sampleSettings();
const started: UiState = new MockBackend(() => {}, { scenario: "ready", turn: "none", sections: settled.sections, texts: settled.texts, delay: 0, page: 50, fail: new Set(), now: () => T0, later: () => () => {} }).state;
// A quiet state: the preview's story starts with jobs and notices of its own, which these tests add one at a time.
const base: UiState = { ...started, running: [], approvals: [], jobs: { active: [], off: false, paused: false, changed: 0 }, notices: [] };

const run = (over: Partial<RunningTurn>): RunningTurn => ({ stream: "chat-mara", chatId: "chat-mara", turn: "t1", kind: "new", startedAt: T0, paused: false, ...over });
const held = (over: Partial<ApprovalView>): ApprovalView => ({ id: "held-1", stream: "chat-mara", turn: "t1", chatId: "chat-mara", agentId: "archivist-1", role: "archivist", callId: "c1", tool: "workspace_write", tier: "write", args: {}, at: T0, until: T0 + 60_000, ...over });
const job = (over: Partial<JobView>): JobView => ({ id: "job-1", chatId: "chat-mara", agent: "archivist", task: "Tidy the notes.", when: "now", state: "running", by: { who: "user" }, basis: null, createdAt: T0, usage: { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 }, ...over });
const notice = (over: Partial<Notice>): Notice => ({ id: "n1", at: T0, kind: "job_done", chatId: "chat-mara", jobId: "job-1", text: "The archivist's job finished.", ...over });
const at = (over: Partial<Nav>): Nav => ({ ...START_NAV, ...over });

describe("the pages and their groups", () => {
  test("every page is in one group, and a group has few enough pages to fit a phone's row", () => {
    const ids = GROUPS.flatMap((g) => g.pages.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(PAGES.map((p) => p.id));
    for (const g of GROUPS) expect(g.pages.length).toBeLessThanOrEqual(4);
    // Few enough groups, too, that their row holds on a phone.
    expect(GROUPS.length).toBeLessThanOrEqual(5);
    expect(groupOf("workspace")).toBe("story");
    expect(groupOf("upkeep")).toBe("system");
  });

  test("a newcomer lands on Home, which stands alone and first; the pages few people need come after the ones most do", () => {
    expect(START_NAV.page).toBe("home");
    expect(GROUPS[0]).toMatchObject({ id: "home", pages: [{ id: "home" }] });
    const far = PAGES.filter((p) => p.far === true).map((p) => p.id);
    // The Runtime page is none of those: no chat is answered without a runtime.
    expect(far.sort()).toEqual(["agents", "skills", "spend", "tools", "upkeep"]);
    // Within the groups a newcomer opens first, nothing is one of those.
    for (const g of GROUPS.slice(0, 3)) expect(g.pages.some((p) => p.far === true)).toBe(false);
    expect(groupOf("lore")).toBe("story");
    expect(groupOf("chronicle")).toBe("story");
  });

  test("every page says what it is for in a line, and has an icon", () => {
    for (const p of PAGES) {
      expect(p.about.length).toBeGreaterThan(20);
      expect(p.about.endsWith(".")).toBe(true);
      expect(typeof PAGE_ICON[p.id]).toBe("string");
    }
  });
});

describe("marks on the page bar", () => {
  test("nothing under way, nothing marked", () => {
    expect(pageMarks(base)).toEqual({});
    expect(pageMarks(null)).toEqual({});
  });

  test("a run under way marks the page that shows it: a reply Live, a job Jobs, a side session's turn Talk", () => {
    const marks = pageMarks({ ...base, running: [run({}), run({ stream: "job-1", kind: "job", turn: "job-1" }), run({ stream: "side-1", kind: "side", chatId: null, turn: "s1" })] });
    expect(marks).toEqual({ live: "busy", jobs: "busy", talk: "busy" });
  });

  test("a held call says its page needs the user, over what is merely under way", () => {
    const state: UiState = { ...base, running: [run({}), run({ stream: "job-1", kind: "job", turn: "job-1" })], approvals: [held({ stream: "job-1", turn: "job-1" })] };
    expect(pageMarks(state)).toEqual({ live: "busy", jobs: "needs" });
    expect(groupMark("now", pageMarks(state))).toBe("needs");
    expect(groupMark("story", pageMarks(state))).toBeNull();
  });

  test("a job that waits to run marks its page, and so does a job that failed or needs the user; one that only finished doesn't", () => {
    expect(pageMarks({ ...base, jobs: { ...base.jobs, active: [job({ state: "queued" })] } }).jobs).toBe("busy");
    expect(pageMarks({ ...base, notices: [notice({ kind: "job_failed" })] }).jobs).toBe("needs");
    expect(pageMarks({ ...base, notices: [notice({ kind: "job_needs_user" })] }).jobs).toBe("needs");
    expect(pageMarks({ ...base, notices: [notice({ kind: "job_done" })] }).jobs).toBeUndefined();
  });

  test("a permission LumiAH can't answer without marks Home, where it is granted; one only a part of it rests on marks nothing", () => {
    const need = (over: Partial<PermissionNeed>): PermissionNeed => ({ id: "generation", what: "make its agents' model calls", without: "no agent can think", todo: "Grant it in Lumiverse.", needed: true, ...over });
    expect(pageMarks({ ...base, permissions: [need({})] })).toEqual({ home: "needs" });
    expect(groupMark("home", pageMarks({ ...base, permissions: [need({})] }))).toBe("needs");
    expect(pageMarks({ ...base, permissions: [need({ id: "mcp_servers", needed: false })] })).toEqual({});
    expect(pageMarks({ ...base, runtime: { ...base.runtime, issues: ["This Lumiverse is too old to keep a turn's record. Update Lumiverse."] } }).home).toBe("needs");
  });

  test("no chat is answered without the runtime: its page is marked while none is ready, set up or not, and not once one is", () => {
    const none: UiState = { ...base, runtime: { ...base.runtime, relays: [], ready: false }, key: { set: false, print: null, at: null }, connections: base.connections.filter((c) => !c.loopback), chats: [] };
    const fresh = pageMarks(none);
    expect(fresh).toEqual({ runtime: "needs" });
    expect(groupMark("system", fresh)).toBe("needs");
    // A chat switched on while none is ready: its replies fail until one is.
    const waiting: ChatView = { chatId: "chat-brann", name: "Brann's long watch", on: true, since: T0, connection: { id: "conn-loopback", name: "LumiAH loopback", loopback: true } };
    expect(pageMarks({ ...none, chats: [waiting] }).runtime).toBe("needs");
    // A runtime registered that has gone quiet.
    const quiet: RelayView[] = base.runtime.relays.map((r) => ({ ...r, link: "quiet" }));
    expect(pageMarks({ ...none, runtime: { ...none.runtime, relays: quiet } }).runtime).toBe("needs");
    // The preview's set-up story has one linked and ready.
    expect(base.runtime.ready).toBe(true);
    expect(pageMarks(base).runtime).toBeUndefined();
  });
});

describe("what waits for the user, and where", () => {
  const state: UiState = { ...base, running: [run({}), run({ stream: "job-1", kind: "job", turn: "job-1" }), run({ stream: "side-1", kind: "side", chatId: null, turn: "s1" })] };

  test("a held call is answered in the live view of the run that holds it", () => {
    expect(approvalTarget(held({}), state)).toEqual({ page: "live", chatId: "chat-mara" });
    expect(approvalTarget(held({ stream: "job-1" }), state)).toEqual({ page: "jobs", job: "job-1" });
    expect(approvalTarget(held({ stream: "side-1", chatId: "" }), state)).toEqual({ page: "talk", side: "side-1" });
  });

  test("the strip points only at what the user isn't looking at", () => {
    const waiting: UiState = { ...state, approvals: [held({}), held({ id: "held-2", stream: "job-1" })] };
    // On Live with the chat open in Lumiverse: its own held call shows in the view itself.
    expect(attentionOf(waiting, at({ page: "live" }), "chat-mara").held.map((h) => h.approval.id)).toEqual(["held-2"]);
    // Another chat picked, or another page: both are pointed at.
    expect(attentionOf(waiting, at({ page: "live", chatId: "chat-brann" }), "chat-mara").held).toHaveLength(2);
    expect(attentionOf(waiting, at({ page: "settings" }), "chat-mara").held).toHaveLength(2);
    expect(attentionOf(waiting, at({ page: "jobs", job: "job-1" }), null).held.map((h) => h.approval.id)).toEqual(["held-1"]);
    expect(shows(at({ page: "talk", side: "side-1" }), null, { page: "talk", side: "side-1" })).toBe(true);
  });

  test("the notices that need the user show on every page, the newest first, until dismissed; a job that only finished doesn't, nor does a job's own notice on the page that shows that job", () => {
    const notices = [notice({ id: "old", at: T0, kind: "job_failed" }), notice({ id: "done", at: T0 + 2000, kind: "job_done" }), notice({ id: "new", at: T0 + 5000, kind: "job_interrupted", jobId: "job-2" })];
    expect(attentionOf({ ...base, notices }, at({ page: "settings" }), null).notices.map((n) => n.id)).toEqual(["new", "old"]);
    // The Jobs page with job-1 open says why it failed itself: the strip would only say it again, and its "Open" would lead to where the user is.
    expect(attentionOf({ ...base, notices }, at({ page: "jobs", job: "job-1" }), null).notices.map((n) => n.id)).toEqual(["new"]);
    expect(attentionOf({ ...base, notices }, at({ page: "jobs" }), null).notices.map((n) => n.id)).toEqual(["new", "old"]);
    expect(attentionOf(null, START_NAV, null)).toEqual({ held: [], notices: [] });
  });

  test("a notice is said in plain words, and names its chat when that isn't the one open", () => {
    const failed = notice({ kind: "job_failed", chatId: "chat-brann", text: "The archivist's job **failed**: the connection refused it." });
    // The open chat's own job needs no name; another chat's does, since "the archivist's job" could be either's.
    expect(noticeWords(failed, base, "chat-brann")).toBe("The archivist's job failed: the connection refused it.");
    expect(noticeWords(failed, base, "chat-mara")).toBe("The archivist's job failed: the connection refused it. (Brann's long watch)");
    expect(noticeWords({ ...failed, chatId: "chat-gone" }, base, "chat-mara")).toBe("The archivist's job failed: the connection refused it. (another chat)");
  });
});

describe("the signs outside the drawer", () => {
  const replying: UiState = { ...base, running: [run({})] };

  test("the tab's badge counts what waits for the user first, shows a working mark while a reply is prepared for the open chat, and counts other runs otherwise", () => {
    expect(badgeOf(null, "chat-mara")).toBeNull();
    expect(badgeOf(base, "chat-mara")).toBeNull();
    expect(badgeOf(replying, "chat-mara")).toBe("…");
    // Another chat is open: the reply under way isn't the one the user waits for.
    expect(badgeOf(replying, "chat-brann")).toBe("1");
    expect(badgeOf({ ...base, running: [run({ stream: "job-1", kind: "job", turn: "job-1" })] }, "chat-mara")).toBe("1");
    // What needs the user outranks both; a job that only finished is news, not a mark.
    expect(badgeOf({ ...replying, approvals: [held({})], notices: [notice({ kind: "job_failed" })] }, "chat-mara")).toBe("2!");
    expect(badgeOf({ ...replying, notices: [notice({ kind: "job_done" })] }, "chat-mara")).toBe("…");
  });

  test("the strip stands over every page but Home, which says what waits for the user itself", () => {
    expect(stripOver("home")).toBe(false);
    for (const p of PAGES.filter((x) => x.id !== "home")) expect(stripOver(p.id)).toBe(true);
  });
});

describe("a shell that shows only some pages", () => {
  test("keeps the groups that hold one of them, each with only those, in the usual order", () => {
    const groups = shownGroups(["settings", "live", "workspace"]);
    expect(groups.map((g) => [g.id, g.pages.map((p) => p.id)])).toEqual([
      ["now", ["live"]],
      ["story", ["workspace"]],
      ["system", ["settings"]],
    ]);
    expect(shownGroups()).toBe(GROUPS);
  });

  test("shows its first page where something leads to one it was not given (Home among them), and marks a group by the pages it shows", () => {
    const groups = shownGroups(["workspace", "guidance"]);
    expect(shownPage(groups, "guidance")).toBe("guidance");
    expect(shownPage(groups, "live")).toBe("workspace");
    expect(shownPage(groups, START_NAV.page)).toBe("workspace");
    expect(groupMark("story", { workspace: "busy", lore: "needs" }, groups)).toBe("busy");
  });
});
