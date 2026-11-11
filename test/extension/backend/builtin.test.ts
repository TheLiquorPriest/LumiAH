// A chat that runs built in (DESIGN §25), end to end over a fake Lumiverse, with the core's own
// harness and no runtime: Lumiverse's prompt comes to the interceptor, the main agent works there
// and briefs, the prompt goes back with the brief put in, Lumiverse's own generation writes the
// reply on the chat's own connection, and the turn's record is written on the reply once Lumiverse
// says the generation ended. Whatever goes wrong on LumiAH's side, the user still gets a reply:
// the prompt goes on as it came, and the live view says why LumiAH had no part in it.

import { afterEach, describe, expect, test } from "bun:test";
import type { JsonObject, PreparedTurn, TurnRecord, TurnRequest, TurnResult } from "../../../src/core/ports";
import { recordOf } from "../../../src/core/sessions";
import { isRecord } from "../../../src/link/json";
import { bare, cast, gate, offers, told } from "../../support/cast";
import { toolCall } from "../../support/fake-host";
import { UiFailure } from "../../support/fake-lumiverse";
import { callsOf, live, startedAs, stepsOf } from "../../support/live";
import { type Rig, type RigOptions, rig, until, USER } from "../../support/rig";

let r: Rig | null = null;
afterEach(() => {
  r?.close();
  r = null;
});

const ASKED = "Who keeps the harbour light now?";
const BRIEF = "Okoro keeps the light; Ilse handed it over last spring.";
const REPLY = "Okoro keeps it now. Ilse handed him the keys last spring.";

/** What Lumiverse sent its own model: each message's text, in order. */
const sentOf = (body: JsonObject): string[] => (Array.isArray(body.messages) ? body.messages.map((m) => (isRecord(m) && typeof m.content === "string" ? m.content : "")) : []);

/** What LumiAH keeps on a message for a swipe: the core's record, and what the backend says beside it of where the turn ran. */
function kept(own: unknown, swipe: number) {
  const entry = isRecord(own) && isRecord(own.swipes) ? own.swipes[String(swipe)] : undefined;
  return { record: recordOf(entry), ran: isRecord(entry) ? entry.ran : undefined };
}

/** A main agent that briefs at once. */
const briefing = (brief: string, id = "reply_1") => ({ toolCalls: [toolCall("write_reply", { brief }, id)] });

describe("a chat that runs built in", () => {
  test("is worked on before the reply and written by Lumiverse itself: the main agent's tools, its brief in the prompt, and the record on the reply", async () => {
    const it = (r = await rig());
    const chatId = await it.setUpBuiltin();
    const play = cast({ name: "main", is: offers("write_reply"), lines: [{ toolCalls: [toolCall("preset_instructions", {}, "look_1")] }, briefing(BRIEF)] });
    it.host.script = play.script;
    it.lumiverse.writes = () => REPLY;

    const out = await it.generate(chatId);

    // The reply is Lumiverse's own generation, on the chat's own connection: no runtime was asked, and the request carries no tag.
    expect(out).toMatchObject({ status: 200, error: null, content: REPLY });
    expect(it.lumiverse.provided.map((p) => p.connectionId)).toEqual(["conn-main"]);
    expect(out.body.lumiah_turn).toBeUndefined();
    // Its prompt is Lumiverse's own, in order, with the brief put in and named for the Prompt Breakdown.
    const sent = sentOf(out.body);
    expect(sent[0]).toBe("You are Joss, keeper of the harbour light.");
    expect(sent).toContain(ASKED);
    expect(sent.filter((text) => text.includes(BRIEF))).toHaveLength(1);
    expect(out.breakdown).toHaveLength(1);
    expect(out.breakdown[0]?.name).toBe("LumiAH: the main agent's brief");
    expect(sent[out.breakdown[0]?.index ?? -1]).toContain(BRIEF);
    // The main agent made two calls (its tool, then the brief); nobody made a writer's call.
    expect(play.calls("main")).toHaveLength(2);
    expect(it.host.calls).toHaveLength(2);

    // The record is on the reply's message once Lumiverse said the generation ended, with where the turn ran beside it.
    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => reply.own !== null, "the reply's record");
    const { record, ran } = kept(reply.own, 0);
    expect(record).toMatchObject({ generationId: out.generationId, kind: "new" });
    expect(ran).toEqual({ place: "builtin" });

    // The live view shows the turn where it ran, with the tools the main agent called, ended as done.
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const { view, events } = await live(it, chatId);
    expect(view).toMatchObject({ turn: out.generationId, place: "builtin", ended: { state: "done" } });
    expect(view.ended?.noPart).toBeUndefined();
    expect(typeof view.replyBy).toBe("number");
    const [main] = startedAs(events, "main");
    expect(callsOf(stepsOf(events, main?.id)).map((c) => [c.name, c.error])).toEqual([
      ["preset_instructions", false],
      ["write_reply", false],
    ]);

    // The Sessions page lists it, with its place.
    const turns = await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 10 });
    expect(turns.turns).toMatchObject([{ turn: out.generationId, place: "builtin", preview: REPLY }]);
    expect(turns.turns[0]?.noPart).toBeUndefined();
  });

  test("carries its session to the next reply, and a swipe of a reply gets a record of its own", async () => {
    const it = (r = await rig());
    const chatId = await it.setUpBuiltin();
    const play = cast({ name: "main", is: offers("write_reply"), lines: [briefing("Okoro keeps the light.", "c1"), briefing("Brann sells him the oil.", "c2"), briefing("Brann sells him the oil, and has since the storm.", "c3")] });
    it.host.script = play.script;
    it.lumiverse.writes = () => "Okoro keeps it now.";
    const first = await it.generate(chatId);
    await until(() => it.host.message(chatId, first.messageId ?? "").own !== null, "the first reply's record");

    it.host.say(chatId, "user", "And who sells him the lamp oil?");
    it.lumiverse.writes = () => "Brann does, every market day.";
    const second = await it.generate(chatId);
    const reply = it.host.message(chatId, second.messageId ?? "");
    await until(() => reply.own !== null, "the second reply's record");
    // The main agent's second turn takes up what its first one did.
    expect(play.calls("main")[1]?.messages.map((m) => m.content).join("\n")).toContain("Okoro keeps the light.");

    it.lumiverse.writes = () => "Brann, ever since the storm.";
    const swiped = await it.generate(chatId, { type: "swipe" });
    expect(swiped.content).toBe("Brann, ever since the storm.");
    await until(() => kept(reply.own, 1).record !== null, "the swipe's record");
    expect(kept(reply.own, 0).record?.generationId).toBe(second.generationId);
    expect(kept(reply.own, 1)).toMatchObject({ record: { generationId: swiped.generationId }, ran: { place: "builtin" } });
    // The reply's first swipe keeps its own record beside it.
    expect(Object.keys(isRecord(reply.own) && isRecord(reply.own.swipes) ? reply.own.swipes : {})).toEqual(["0", "1"]);
  });

  test("still gets its reply when LumiAH's turn fails: the prompt goes on as it came, and the live view says why", async () => {
    const it = (r = await rig());
    const chatId = await it.setUpBuiltin();
    it.host.script = () => ({ error: "The provider answered 503." });
    it.lumiverse.writes = () => "Okoro, I think.";

    const out = await it.generate(chatId);

    expect(out).toMatchObject({ status: 200, error: null, content: "Okoro, I think." });
    expect(sentOf(out.body)).toEqual(["You are Joss, keeper of the harbour light.", ASKED]);
    expect(out.breakdown).toEqual([]);
    expect(it.lumiverse.interceptorErrors).toEqual([]);
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const { view } = await live(it, chatId);
    expect(view).toMatchObject({ turn: out.generationId, place: "builtin" });
    const noPart = view.ended?.noPart;
    expect(noPart?.why).toBe("failed");
    // The page prints its heading once: the words begin with the reason, not with the heading again.
    expect(noPart?.text.startsWith("The provider answered 503.")).toBe(true);
    expect(noPart?.text).toContain("503");
    expect(noPart?.text).toContain("Lumiverse sent the prompt as it was");
    // The reply LumiAH had no part in is still a turn of the chat's: the Sessions page lists it, and says whose reply it is.
    await until(() => it.host.message(chatId, out.messageId ?? "").own !== null, "the failed turn's record");
    const listed = await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 10 });
    expect(listed.turns.map((t) => [t.turn, t.place, t.noPart?.why])).toEqual([[out.generationId, "builtin", "failed"]]);
    // The chat goes on: the next reply is worked on again.
    it.host.say(chatId, "user", "You think?");
    it.host.script = () => briefing(BRIEF);
    it.lumiverse.writes = () => REPLY;
    const next = await it.generate(chatId);
    expect(sentOf(next.body).some((text) => text.includes(BRIEF))).toBe(true);
  });

  test("hands the prompt back as it came when the time Lumiverse gives is nearly gone, and says it ran out of time", async () => {
    const it = (r = await rig());
    const chatId = await it.setUpBuiltin();
    // Lumiverse waits two and a half seconds for the interceptor here, and LumiAH keeps two of them back: the main agent has half a second.
    it.host.interceptorMs = 2_500;
    await it.backend.settings.change(USER, [{ path: ["transport", "builtin", "marginMs"], value: 2_000 }], []);
    it.host.script = () => ({ hang: true });
    it.lumiverse.writes = () => "Okoro, I think.";

    const began = Date.now();
    const out = await it.generate(chatId);

    // Inside Lumiverse's wait, with time to spare: Lumiverse never passed the interceptor over.
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(out).toMatchObject({ status: 200, error: null, content: "Okoro, I think." });
    expect(sentOf(out.body)).toEqual(["You are Joss, keeper of the harbour light.", ASKED]);
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const { view } = await live(it, chatId);
    const noPart = view.ended?.noPart;
    expect(noPart?.why).toBe("time");
    // Beside the sentence, a code a page can act on.
    expect(view.ended?.cause).toBe("time");
    expect(noPart?.text).not.toContain("had no part in this reply");
    expect(noPart?.text).toContain("a job");
    // The view says when its time ended: half a second after it began.
    expect((view.replyBy ?? 0) - began).toBeLessThan(1_000);
  });

  test("leaves nothing behind when Lumiverse's Stop ends the generation, while the main agent works or while Lumiverse writes", async () => {
    const it = (r = await rig());
    const chatId = await it.setUpBuiltin();
    // Stopped while the main agent works: no prompt is sent, no reply is saved.
    const held = gate();
    it.host.script = cast({ name: "main", is: offers("write_reply"), lines: [held.held(briefing(BRIEF))] }).script;
    const first = new AbortController();
    const working = it.generate(chatId, { signal: first.signal });
    await until(() => held.waiting === 1, "the main agent's call");
    first.abort();
    const stopped = await working;
    held.open();
    expect(stopped).toMatchObject({ messageId: null, content: "" });
    expect(it.lumiverse.provided).toEqual([]);
    await until(() => it.backend.live.runningOf(USER).length === 0, "the stopped turn's end in the live view");
    const one = await live(it, chatId);
    expect(one.view.ended).toMatchObject({ state: "stopped" });
    // There was no reply, so nothing is said of who wrote one.
    expect(one.view.ended?.noPart).toBeUndefined();

    // Stopped while Lumiverse writes, after the brief went in: the turn is given up, with no record anywhere.
    it.host.script = () => briefing(BRIEF, "reply_2");
    it.lumiverse.writes = () => new Promise<string>(() => undefined);
    const second = new AbortController();
    const writing = it.generate(chatId, { signal: second.signal });
    await until(() => it.lumiverse.provided.length === 1, "Lumiverse's own generation");
    expect(sentOf(it.lumiverse.provided[0]?.body ?? {}).some((text) => text.includes(BRIEF))).toBe(true);
    second.abort();
    const cut = await writing;
    expect(cut.messageId).toBeNull();
    await until(() => it.backend.live.runningOf(USER).length === 0, "the given-up turn's end in the live view");
    expect(it.host.chatList.get(chatId)?.messages.map((m) => m.role)).toEqual(["user"]);
    expect((await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 10 })).total).toBe(0);

    // And the chat's next reply is worked on as any other.
    it.host.script = () => briefing(BRIEF, "reply_3");
    it.lumiverse.writes = () => REPLY;
    const next = await it.generate(chatId);
    expect(next.content).toBe(REPLY);
    expect(sentOf(next.body).some((text) => text.includes(BRIEF))).toBe(true);
    await until(() => it.host.message(chatId, next.messageId ?? "").own !== null, "the next reply's record");
  });

  test("skipped from its live view ends LumiAH's work and no more: Lumiverse writes the reply on its own, and the view says where to stop the reply itself", async () => {
    const it = (r = await rig());
    const chatId = await it.setUpBuiltin();
    // A model call that takes as long as it takes, as a real one does: it ends when its signal does.
    it.host.script = () => ({ hang: true });
    it.lumiverse.writes = () => "Okoro, I think.";
    const generating = it.generate(chatId);
    await until(() => it.host.calls.length === 1, "the main agent's call");
    const turn = it.backend.live.runningOf(USER)[0]?.turn ?? "";

    expect(await it.page.request("lah.turn.stop", { stream: chatId, turn })).toEqual({ stopped: true });
    const out = await generating;

    expect(out).toMatchObject({ status: 200, content: "Okoro, I think." });
    expect(sentOf(out.body)).toEqual(["You are Joss, keeper of the harbour light.", ASKED]);
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const { view } = await live(it, chatId);
    const noPart = view.ended?.noPart;
    expect(noPart?.why).toBe("stopped");
    expect(view.ended?.cause).toBe("skipped");
    expect(noPart?.text).toBe("You skipped LumiAH for this reply. Lumiverse wrote the reply from the prompt as it was. To stop a reply itself, use Lumiverse's own Stop.");
    // Over: there is nothing left to stop.
    expect(await it.page.request("lah.turn.stop", { stream: chatId, turn })).toEqual({ stopped: false });
  });

  test("runs a job the main agent started once the reply is over, in the extension, and the pages follow it", async () => {
    const it = (r = await rig());
    const chatId = await it.setUpBuiltin();
    const TASK = "Note who kept the light before Okoro.";
    const play = cast(
      { name: "main", is: offers("write_reply"), lines: [{ toolCalls: [toolCall("job_start", { agent: "summarizer", task: TASK }, "start_1")] }, briefing(BRIEF)] },
      { name: "job", is: told(TASK), lines: ["Ilse kept the light before Okoro."] },
    );
    it.host.script = play.script;
    let before = -1;
    it.lumiverse.writes = () => {
      before = play.calls("job").length;
      return REPLY;
    };

    const out = await it.generate(chatId);

    expect(out.content).toBe(REPLY);
    // It waited for the reply: nothing of it had run while Lumiverse wrote.
    expect(before).toBe(0);
    await until(() => play.calls("job").length === 1, "the job's run");
    const listed = async () => (await it.page.request("lah.jobs.list", { chatId, cursor: null, limit: 10 })).jobs;
    const [running] = await listed();
    await until(() => it.backend.jobs.active(USER, running?.id ?? "") === null && it.backend.live.runningOf(USER).length === 0, "the job's end");
    const [job] = await listed();
    expect(job).toMatchObject({ chatId, state: "done", task: TASK });
    const ran = await live(it, job?.id ?? "");
    expect(ran.view).toMatchObject({ kind: "job", place: "builtin", ended: { state: "done" } });
    // A job the user starts by hand for the chat runs here too.
    it.host.script = () => "Brann sells the oil.";
    const started = await it.page.request("lah.job.start", { chatId, agent: "summarizer", task: "Note who sells the lamp oil.", when: "now" });
    await until(() => it.backend.jobs.active(USER, started.job.id) === null && it.backend.live.runningOf(USER).length === 0, "the user's job to finish");
    expect((await listed()).find((j) => j.id === started.job.id)).toMatchObject({ state: "done" });
    expect((await live(it, started.job.id)).view).toMatchObject({ kind: "job", place: "builtin", ended: { state: "done" } });
  });

  test("beside a chat that runs in a runtime: each reply is made in its own place, at the same time", async () => {
    const it = (r = await rig());
    const away = await it.setUp();
    const here = await it.setUpBuiltin("The fish market");
    it.host.say(here, "user", "What does Brann sell on market day?");
    const play = cast(
      { name: "main-here", is: (request) => offers("write_reply")(request) && told("What does Brann sell on market day?")(request), lines: [briefing("Brann sells lamp oil and salt fish.", "here_1")] },
      { name: "main-away", is: offers("write_reply"), lines: [briefing(BRIEF, "away_1")] },
      { name: "writer", is: bare, lines: [REPLY] },
    );
    it.host.script = play.script;
    it.lumiverse.writes = () => "Lamp oil, mostly.";

    const [there, local] = await Promise.all([it.generate(away), it.generate(here)]);

    // The runtime's chat: tagged, answered by the writer through the runtime.
    expect(there).toMatchObject({ status: 200, content: REPLY });
    expect(typeof there.body.lumiah_turn).toBe("string");
    expect(play.calls("writer")).toHaveLength(1);
    // The built-in chat: untagged, written by Lumiverse with the brief in its prompt; the runtime never saw it.
    expect(local).toMatchObject({ status: 200, content: "Lamp oil, mostly." });
    expect(local.body.lumiah_turn).toBeUndefined();
    expect(sentOf(local.body).some((text) => text.includes("Brann sells lamp oil and salt fish."))).toBe(true);
    expect(it.lumiverse.provided.map((p) => p.connectionId)).toEqual(["conn-main"]);

    await until(() => it.host.message(away, there.messageId ?? "").own !== null && it.host.message(here, local.messageId ?? "").own !== null, "both replies' records");
    await until(() => it.backend.live.runningOf(USER).length === 0, "both turns' ends in the live view");
    expect((await live(it, away)).view).toMatchObject({ turn: there.generationId, place: "runtime", ended: { state: "done" } });
    expect((await live(it, here)).view).toMatchObject({ turn: local.generationId, place: "builtin", ended: { state: "done" } });
    // Each chat says where it runs, and the built-in one moves to the runtime and back by the same switch.
    expect((await it.page.request("lah.chat.get", { chatId: away })).chat).toMatchObject({ on: true, place: "runtime", connection: { loopback: true } });
    expect((await it.page.request("lah.chat.get", { chatId: here })).chat).toMatchObject({ on: true, place: "builtin", connection: { id: "conn-main", loopback: false } });
    expect((await it.page.request("lah.chat.set", { chatId: here, on: true, place: "runtime" })).chat).toMatchObject({ on: true, place: "runtime", connection: { loopback: true } });
    expect((await it.page.request("lah.chat.set", { chatId: here, on: true, place: "builtin" })).chat).toMatchObject({ on: true, place: "builtin", connection: { id: "conn-main", loopback: false } });
  });
});

describe("a chat that isn't switched on, or runs in a runtime that isn't there", () => {
  test("is left to Lumiverse untouched, and a chat can't be set to run in a runtime while none is linked", async () => {
    const it = (r = await rig());
    const chat = it.host.addChat(USER, "Brann's ledger");
    it.host.say(chat.id, "user", "How much oil is left?");
    it.lumiverse.writes = () => "Two casks.";
    const out = await it.generate(chat.id);
    expect(out.content).toBe("Two casks.");
    expect(it.host.calls).toEqual([]);
    expect(it.backend.live.runningOf(USER)).toEqual([]);

    const refused = await it.page.request("lah.chat.set", { chatId: chat.id, on: true, place: "runtime" }).catch((error: unknown) => error);
    expect(refused instanceof UiFailure ? refused.error : null).toMatchObject({ code: "unavailable", message: expect.stringContaining("let the chat run built in") });
  });
});

describe("an extension that builds LumiAH in and asks for fewer permissions", () => {
  test("plays a built-in turn without the permissions to read characters and personas, and its pages don't ask for what it chose not to", async () => {
    const it = (r = await rig({ backend: { identity: { identifier: "lantern_ext", name: "Lantern", connectionName: "Lantern loopback" }, declined: ["characters", "personas"] } }));
    it.host.permissions.delete("characters");
    it.host.permissions.delete("personas");
    it.host.permissions.delete("presets");
    const chatId = await it.setUpBuiltin();
    it.host.script = [briefing(BRIEF)];
    it.lumiverse.writes = () => REPLY;

    const out = await it.generate(chatId);

    expect(out).toMatchObject({ status: 200, error: null, content: REPLY });
    expect(sentOf(out.body).some((text) => text.includes(BRIEF))).toBe(true);
    expect(out.breakdown[0]?.name).toBe("Lantern: the main agent's brief");
    await until(() => isRecord(it.host.message(chatId, out.messageId ?? "").metadata.lantern_ext), "the record under the extension's own key");
    expect(it.host.logs.filter((l) => l.level === "error")).toEqual([]);

    // What it chose not to ask for is never brought up; a permission it does ask for and lacks is said as information, not as something in the way.
    const state = await it.page.request("lah.hello", {});
    const asked = state.permissions.map((p) => p.id);
    expect(asked).toContain("presets");
    expect(asked).not.toContain("characters");
    expect(asked).not.toContain("personas");
    const presets = state.permissions.find((p) => p.id === "presets");
    expect(presets).toMatchObject({ needed: false, what: "read the preset's instructions", without: "the agents know the preset only by the prompt it made" });
    expect(presets?.todo).toBe("Grant it in Lumiverse (Extensions → Lantern → Permissions).");
    expect(state.permissions.every((p) => !p.needed)).toBe(true);
    expect(state.setup.steps.find((step) => step.id === "permissions")).toEqual({ id: "permissions", done: true });
  });

  test("can't be switched on without any one of the four permissions no reply can be worked on without, and the pages say what each is for; with the four it works, every other permission being optional", async () => {
    const it = (r = await rig());
    const chatId = await it.setUpBuiltin();
    await it.page.request("lah.chat.set", { chatId, on: false });
    const NEEDED = ["interceptor", "chats", "generation", "chat_mutation"];
    // Each of the four, missing alone, keeps a chat from being switched on, and is told to the pages as one LumiAH can't do without.
    for (const id of NEEDED) {
      it.host.permissions.delete(id);
      const refused = await it.page.request("lah.chat.set", { chatId, on: true }).catch((error: unknown) => error);
      expect(refused instanceof UiFailure ? refused.error : null).toMatchObject({ code: "unavailable", message: expect.stringContaining(`"${id}"`) });
      const { permissions, setup } = await it.page.request("lah.hello", {});
      expect(permissions.filter((p) => p.needed).map((p) => p.id)).toEqual([id]);
      expect(setup.steps.find((step) => step.id === "permissions")).toEqual({ id: "permissions", done: false });
      it.host.permissions.add(id);
    }
    // Lumiverse puts reading a chat's messages under the permission to change them, which is why that one is among the four.
    it.host.permissions.delete("chat_mutation");
    expect((await it.page.request("lah.hello", {})).permissions.find((p) => p.id === "chat_mutation")).toEqual({ id: "chat_mutation", needed: true, what: "read the chat's messages and write each reply's record on it", without: "no reply is worked on", todo: "Grant it in Lumiverse (Extensions → LumiAH → Permissions)." });
    it.host.permissions.add("chat_mutation");

    // With the four and nothing else, the chat is switched on and its reply is worked on: what each other permission opens is quietly absent, and the pages say so as information.
    for (const id of [...it.host.permissions]) if (!NEEDED.includes(id)) it.host.permissions.delete(id);
    expect((await it.page.request("lah.chat.set", { chatId, on: true })).chat).toMatchObject({ on: true, place: "builtin" });
    const state = await it.page.request("lah.hello", {});
    expect(state.permissions.map((p) => [p.id, p.needed])).toEqual([
      ["generation_parameters", false],
      ["world_books", false],
      ["presets", false],
      ["characters", false],
      ["personas", false],
      ["mcp_servers", false],
      ["embeddings", false],
      ["memories", false],
      ["databanks", false],
      ["web_search", false],
    ]);
    expect(state.setup.steps.find((step) => step.id === "permissions")).toEqual({ id: "permissions", done: true });
    it.host.script = [briefing(BRIEF)];
    it.lumiverse.writes = () => REPLY;
    const out = await it.generate(chatId);
    expect(out).toMatchObject({ status: 200, error: null, content: REPLY });
    expect(sentOf(out.body).some((text) => text.includes(BRIEF))).toBe(true);
    await until(() => it.host.message(chatId, out.messageId ?? "").own !== null, "the reply's record");
    expect(it.host.logs.filter((l) => l.level === "error")).toEqual([]);
  });
});

const USAGE = { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 };

/** What a test scripts of the core where it runs built in: the two halves of a turn. The runtime's side answers no turn in these tests. */
type Halves = { prepare(turn: TurnRequest, options: { replyBy: number | null }, signal: AbortSignal): Promise<PreparedTurn>; complete(input: { generationId: string; reply: string }): Promise<TurnResult> };

const scripted = (halves: (instance: number) => Halves): NonNullable<RigOptions["harness"]> => {
  let instances = 0;
  return (_host, _settings, _extension, place) => ({
    answer: async () => ({ status: "failed", reason: "no turn is answered in this test", record: null, reply: "", usage: USAGE }),
    ...(place === "builtin" ? halves(++instances) : {}),
  });
};

/** A first half that hands the prompt back as it came, with the turn waiting for its reply. */
const briefed = async (turn: TurnRequest): Promise<PreparedTurn> => ({ messages: turn.messages, part: "brief", pending: true, usage: USAGE });

/** A record as the core's second half leaves one; one it had to finish from storage says so (`recovered`). */
const recordOfTurn = (generationId: string, recovered: boolean): TurnRecord => ({ v: 1, generationId, kind: "new", at: 2_000, path: "", segment: "a".repeat(64), usage: { ...USAGE, calls: 1 }, ...(recovered ? { recovered: "restart" as const } : {}) });

describe("a built-in turn whose first half never returns", () => {
  test(
    "costs neither its own reply nor the chat's next one: it is let go when its prompt goes back, and the next reply is worked on at once",
    async () => {
      let prepares = 0;
      const it = (r = await rig({
        harness: scripted(() => ({
          // The first is stuck on something that never answers and can't be told to stop (a read Lumiverse never answers, a tool that ignores its signal); the next works.
          prepare: (turn) => (++prepares === 1 ? Promise.withResolvers<never>().promise : briefed(turn)),
          complete: async (input) => ({ status: "done", record: null, reply: input.reply, usage: USAGE }),
        })),
      }));
      const chatId = await it.setUpBuiltin();
      // Lumiverse waits 2.5 s here and LumiAH keeps 2 s back; a later reply would wait a second for the chat's earlier one, were that one still held against it.
      it.host.interceptorMs = 2_500;
      await it.backend.settings.change(
        USER,
        [
          { path: ["transport", "builtin", "marginMs"], value: 2_000 },
          { path: ["transport", "runtime", "turnWaitMs"], value: 1_000 },
        ],
        [],
      );
      it.lumiverse.writes = () => "Okoro, I think.";

      // The stuck turn costs no reply: the prompt goes back as it came, in time.
      const first = await it.generate(chatId);
      expect(first).toMatchObject({ status: 200, content: "Okoro, I think." });
      expect(it.lumiverse.interceptorErrors).toEqual([]);
      expect(it.backend.live.whole(USER, chatId)?.ended?.noPart?.why).toBe("time");

      it.host.say(chatId, "user", "You think?");
      const began = Date.now();
      const second = await it.generate(chatId);
      expect(second).toMatchObject({ status: 200, content: "Okoro, I think." });
      // Worked on (a second first half ran), held up by nothing, and with no word of an earlier reply.
      expect({ prepares, heldUp: Date.now() - began >= 1_000, said: it.backend.live.whole(USER, chatId)?.ended?.noPart ?? null }).toEqual({ prepares: 2, heldUp: false, said: null });
    },
    20_000,
  );
});

describe("the text a built-in turn is completed with", () => {
  test("is the text its own generation wrote on the swipe it wrote, not the swipe the message shows", async () => {
    const completed: string[] = [];
    const it = (r = await rig({
      harness: scripted(() => ({
        prepare: briefed,
        complete: async (input) => {
          completed.push(input.reply);
          return { status: "done", record: null, reply: input.reply, usage: USAGE };
        },
      })),
    }));
    const chatId = await it.setUpBuiltin();
    const reply = it.host.say(chatId, "assistant", "Okoro keeps it.");
    const handler = it.host.interceptor?.handler;
    if (handler === undefined) throw new Error("no interceptor");
    const prompt = [{ role: "user" as const, text: ASKED, history: true }];

    // A second swipe is written in the background: the first stays the one shown. Lumiverse (an older one) says nothing of what the generation wrote.
    reply.swipes.push("");
    it.host.emit.started({ generationId: "gen-background", chatId, userId: USER, type: "swipe", targetMessageId: reply.id, targetSwipeId: 1 });
    await handler({ chatId, userId: USER, generationId: "gen-background", type: "swipe", dryRun: false, connectionId: "conn-main", presetId: null, personaId: null, activated: [], messages: prompt });
    reply.swipes[1] = "Brann does, since the storm.";
    it.host.emit.touched(chatId);
    it.host.emit.ended({ generationId: "gen-background", chatId, userId: USER, messageId: reply.id, error: null });
    await until(() => completed.length === 1, "the turn's second half");
    expect(reply.swipeId).toBe(0);
    expect(completed).toEqual(["Brann does, since the storm."]);

    // Where Lumiverse says what the generation wrote, that is the reply, whatever the chat shows by then.
    reply.swipes.push("");
    it.host.emit.started({ generationId: "gen-third", chatId, userId: USER, type: "swipe", targetMessageId: reply.id, targetSwipeId: 2 });
    await handler({ chatId, userId: USER, generationId: "gen-third", type: "swipe", dryRun: false, connectionId: "conn-main", presetId: null, personaId: null, activated: [], messages: prompt });
    reply.swipes[2] = "Ilse, some say.";
    it.host.emit.ended({ generationId: "gen-third", chatId, userId: USER, messageId: reply.id, content: "Ilse, some say.", error: null });
    await until(() => completed.length === 2, "the second turn's second half");
    expect(completed[1]).toBe("Ilse, some say.");
  });
});

describe("a built-in turn that waits for its reply when the extension is restarted", () => {
  /** A rig whose scripted core says, of a turn it is asked to complete, whether it had to be found again after a restart: the second core made is the one a restarted backend makes. */
  const restartable = (completed: { instance: number; reply: string }[]) =>
    rig({
      harness: scripted((instance) => ({
        prepare: briefed,
        complete: async (input) => {
          completed.push({ instance, reply: input.reply });
          return { status: "done", record: recordOfTurn(input.generationId, instance > 1), reply: input.reply, usage: USAGE, ...(instance > 1 ? { recovered: "restart" as const } : {}) };
        },
      })),
    });

  test("still gets its record when Lumiverse saves the reply after the restart, and the Sessions page says it was written after the fact", async () => {
    const completed: { instance: number; reply: string }[] = [];
    const it = (r = await restartable(completed));
    const chatId = await it.setUpBuiltin();
    const writing = Promise.withResolvers<string>();
    it.lumiverse.writes = () => writing.promise;
    const generating = it.generate(chatId);
    await until(() => it.lumiverse.provided.length === 1, "Lumiverse's own generation");

    // The worker is restarted while Lumiverse writes: nothing it held in memory is left.
    await it.restart();
    writing.resolve(REPLY);
    const out = await generating;

    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => reply.own !== null, "the reply's record");
    expect(completed).toEqual([{ instance: 2, reply: REPLY }]);
    expect(kept(reply.own, 0)).toMatchObject({ record: { generationId: out.generationId, recovered: "restart" }, ran: { place: "builtin" } });
    const turns = await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 10 });
    expect(turns.turns).toMatchObject([{ turn: out.generationId, place: "builtin", recovered: "restart" }]);
    // Nothing is owed to the turn any more: a second restart finds nothing to settle.
    await it.restart();
    await it.page.request("lah.hello", {});
    await it.backend.settle();
    expect(completed).toHaveLength(1);
  });

  test("gets its record when the user comes back after a restart that outlasted the reply", async () => {
    const completed: { instance: number; reply: string }[] = [];
    const it = (r = await restartable(completed));
    const chatId = await it.setUpBuiltin();
    const writing = Promise.withResolvers<string>();
    it.lumiverse.writes = () => writing.promise;
    const generating = it.generate(chatId);
    await until(() => it.lumiverse.provided.length === 1, "Lumiverse's own generation");

    // The worker stops, and Lumiverse saves the reply while there is none to hear of it.
    await it.backend.settle();
    it.host.reload();
    writing.resolve(REPLY);
    const out = await generating;
    const reply = it.host.message(chatId, out.messageId ?? "");
    expect(reply.own).toBeNull();

    // A new worker starts, and the user opens a page.
    await it.restart();
    await it.page.request("lah.hello", {});
    await until(() => reply.own !== null, "the reply's record");
    expect(kept(reply.own, 0)).toMatchObject({ record: { generationId: out.generationId, recovered: "restart" }, ran: { place: "builtin" } });
  });

  test("is let go, in words the live view shows, when no reply was saved for it", async () => {
    const completed: { instance: number; reply: string }[] = [];
    const it = (r = await restartable(completed));
    const chatId = await it.setUpBuiltin();
    const writing = Promise.withResolvers<string>();
    it.lumiverse.writes = () => writing.promise;
    const generating = it.generate(chatId);
    await until(() => it.lumiverse.provided.length === 1, "Lumiverse's own generation");

    await it.restart();
    writing.reject(new Error("The provider answered 503."));
    const out = await generating;
    expect(out.messageId).toBeNull();

    await until(() => it.backend.live.whole(USER, chatId) !== null, "the word of what became of the turn");
    expect(it.backend.live.whole(USER, chatId)).toMatchObject({ turn: out.generationId, ended: { state: "lost", reason: expect.stringContaining("no reply was saved for it") } });
    expect(completed).toEqual([]);
    expect((await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 10 })).total).toBe(0);
  });
});

describe("a second reply asked for in a chat while the first one's agents still work", () => {
  test("lets the first turn go and says why in the chat's live view; Lumiverse writes that reply alone, and the second is worked on", async () => {
    const it = (r = await rig());
    const chatId = await it.setUpBuiltin();
    // The first turn's main agent is still at its call when the second reply is asked for; the second's briefs at once.
    const play = cast({ name: "main", is: offers("write_reply"), lines: [{ hang: true }, briefing(BRIEF, "second_1")] });
    it.host.script = play.script;
    it.lumiverse.writes = (body) => (sentOf(body).some((text) => text.includes(BRIEF)) ? REPLY : "Okoro, I think.");
    // A page follows the chat's live view.
    await it.page.request("lah.live.open", { stream: chatId });

    const first = it.generate(chatId);
    await until(() => play.calls("main").length === 1, "the first turn's call");
    const second = it.generate(chatId);
    const [one, two] = await Promise.all([first, second]);

    // Both replies are written: the first from the prompt as it came, the second with its brief.
    expect(one).toMatchObject({ status: 200, content: "Okoro, I think." });
    expect(two).toMatchObject({ status: 200, content: REPLY });
    // The page heard the first turn end, and why, before the second took its place in the chat's live view.
    const heard = it.page.pushes.flatMap((push) => (push.type === "lah.live" && "turn" in push.change && push.change.turn === one.generationId && push.change.ended !== null ? [push.change.ended] : []));
    expect(heard.at(-1)).toMatchObject({ state: "stopped", noPart: { why: "stopped", text: expect.stringContaining("Another reply was asked for in this chat") } });
    // The second leaves its record; a turn that was let go leaves none, as one the user skipped.
    await until(() => it.host.message(chatId, two.messageId ?? "").own !== null, "the second reply's record");
    const rows = (await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 10 })).turns;
    expect(rows.map((row) => [row.turn, row.noPart])).toEqual([[two.generationId, undefined]]);
    expect(it.host.message(chatId, one.messageId ?? "").own).toBeNull();
  });
});

describe("Lumiverse's signal for a built-in turn", () => {
  test("is a Stop when it ends before the deadline Lumiverse gave, whatever its reason says: nothing is said of a reply that never comes", async () => {
    const it = (r = await rig());
    const chatId = await it.setUpBuiltin();
    it.host.script = () => ({ hang: true });
    const handler = it.host.interceptor?.handler;
    if (handler === undefined) throw new Error("no interceptor");
    it.host.emit.started({ generationId: "gen-stopped", chatId, userId: USER, type: "normal", targetMessageId: null, targetSwipeId: null });
    const stop = new AbortController();
    const working = handler({ chatId, userId: USER, generationId: "gen-stopped", type: "normal", dryRun: false, connectionId: "conn-main", presetId: null, personaId: null, activated: [], messages: [{ role: "user", text: ASKED, history: true }], signal: stop.signal, deadlineAt: Date.now() + 300_000 });
    await until(() => it.host.calls.length === 1, "the main agent's call");
    // Minutes before the deadline, with words another build of Lumiverse might use for anything.
    stop.abort(new Error("The interceptor timed out or was cancelled."));
    expect(await working).toEqual({});
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const ended = it.backend.live.whole(USER, chatId)?.ended;
    expect(ended?.state).toBe("stopped");
    expect(ended?.noPart).toBeUndefined();
  });
});
