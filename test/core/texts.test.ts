// The core's texts: every text sent to a model has an id, a default and its placeholders, and the
// user's own text stands in for it wherever it can be sent.

import { describe, expect, test } from "bun:test";
import { checkText, renderDefault, TEXT, TEXT_DEFS, Texts, textsOf, TOOL } from "../../src/core/texts";

/** Every text id the code names. */
function ids(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return value !== null && typeof value === "object" ? Object.values(value).flatMap(ids) : [];
}

describe("the registry", () => {
  test("every id the code names is a text, once", () => {
    const defined = TEXT_DEFS.map((d) => d.id);
    expect(new Set(defined).size).toBe(defined.length);
    for (const id of ids(TEXT)) expect(defined).toContain(id);
  });

  test("every shipped text can be sent as it is: it keeps what it requires and uses only its own placeholders", () => {
    for (const def of TEXT_DEFS) {
      expect({ id: def.id, problem: checkText(def.id, def.text) }).toEqual({ id: def.id, problem: null });
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.note.length).toBeGreaterThan(0);
    }
  });

  test("every base tool has a description and a text for each argument", () => {
    const defined = new Set(TEXT_DEFS.map((d) => d.id));
    for (const name of Object.values(TOOL)) expect(defined.has(TEXT.tool(name))).toBe(true);
    expect(defined.has(TEXT.toolArg(TOOL.chatRead, "from"))).toBe(true);
    expect(defined.has(TEXT.toolArg(TOOL.writeReply, "brief"))).toBe(true);
  });
});

describe("the user's own texts", () => {
  test("stand in for the shipped ones, placeholders filled the same way", () => {
    const texts = new Texts({ "writer.brief": "Notes: {{brief}}", "runtime.tool_failed": "{{name}} broke ({{error}})" });
    expect(texts.render(TEXT.writer.brief, { brief: "the lamp is lit" })).toBe("Notes: the lamp is lit");
    expect(texts.render(TEXT.runtime.toolFailed, { name: "lookup", error: "no shelf" })).toBe("lookup broke (no shelf)");
    expect(texts.replaced(TEXT.writer.brief)).toBe(true);
    expect(texts.render(TEXT.stop.busy)).toBe(renderDefault(TEXT.stop.busy));
  });

  test("one that can't be sent is refused, in words that say why, and the shipped text is sent instead", () => {
    expect(checkText("writer.brief", "A note without its brief.")).toBe("It must keep {{brief}} (the main agent's brief).");
    expect(checkText("writer.brief", "{{brief}} for {{user}}")).toBe("{{user}} isn't one of this text's placeholders ({{brief}}).");
    expect(checkText("stop.busy", "busy {{now}}")).toBe("{{now}} isn't a placeholder: this text has none.");
    expect(checkText("no.such.text", "words")).toBe('There is no text "no.such.text".');
    expect(checkText("writer.brief", "Notes: {{brief}}")).toBeNull();
    const texts = new Texts({ "writer.brief": "A note without its brief.", "no.such.text": "words" });
    expect(texts.render(TEXT.writer.brief, { brief: "x" })).toBe(renderDefault(TEXT.writer.brief, { brief: "x" }));
  });

  test("what fills a placeholder is never read for placeholders itself", () => {
    const texts = new Texts();
    expect(texts.render(TEXT.runtime.toolFailed, { name: "lore_read", error: "{{char}} met {{name}}" })).toBe("lore_read failed: {{char}} met {{name}}");
  });

  test("are read from whatever was stored: anything that isn't a text by id is left out", () => {
    expect(textsOf(null).render(TEXT.stop.busy)).toBe(renderDefault(TEXT.stop.busy));
    expect(textsOf({ "stop.busy": 7, "stop.cancelled": "stopped by hand" }).render(TEXT.stop.cancelled)).toBe("stopped by hand");
    expect(textsOf(["stop.busy"]).replaced("stop.busy")).toBe(false);
  });

  test("the words counts are written with are texts too: one for one, one for several, or one for both", () => {
    expect(new Texts().counted(1, TEXT.word.entry)).toBe("1 entry");
    expect(new Texts().counted(0, TEXT.word.entry)).toBe("0 entries");
    const own = new Texts({ "word.entry": "note|notes", "word.turn": "tour" });
    expect([own.counted(1, TEXT.word.entry), own.counted(3, TEXT.word.entry)]).toEqual(["1 note", "3 notes"]);
    expect([own.counted(1, TEXT.word.turn), own.counted(3, TEXT.word.turn)]).toEqual(["1 tour", "3 tour"]);
    expect(own.noun(2, TEXT.word.tool)).toBe("tools");
  });
});
