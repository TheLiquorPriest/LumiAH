// LumiAH keeps a chat's chronicle and learns its story only with its own agents (DESIGN §24.4).
// Where the extension that answers a chat puts an agent of its own under the chronicler's or the
// story reader's name, a job started for them would start that agent: upkeep isn't offered to the
// main agent and learning the story is refused, with why. The same answer decides both.

import { describe, expect, test } from "bun:test";
import type { Definitions } from "../../src/core/definitions";
import type { DefinitionSource } from "../../src/core/ports";
import { chronicleRefusal } from "../../src/core/recall/definitions";

/** Where one definition comes from and what it stands over; undefined for one switched off. */
type Sourced = { source: DefinitionSource; over?: "builtin" | "extension" } | undefined;

const BUILTIN: Sourced = { source: "builtin" };

/** A chat's definitions as far as the guard reads them: where the chronicler and the story reader come from. */
const rows = (chronicler: Sourced, reader: Sourced): Pick<Definitions, "sourced"> => ({
  sourced: (id) => (id === "chronicler" ? chronicler : id === "story-reader" ? reader : undefined),
});

describe("whose agents keep the chronicle", () => {
  test("LumiAH's own, or the user's own over them: upkeep and learning are offered", () => {
    expect(chronicleRefusal(rows(BUILTIN, BUILTIN), "RP Engine")).toBeNull();
    expect(chronicleRefusal(rows({ source: "user", over: "builtin" }, { source: "user", over: "builtin" }), "RP Engine")).toBeNull();
  });

  test("an extension's agent under either name, the user's over one, or one switched off: refused, naming the extension where there is one", () => {
    expect(chronicleRefusal(rows({ source: "extension" }, BUILTIN), "RP Engine")).toContain("RP Engine");
    expect(chronicleRefusal(rows(BUILTIN, { source: "extension" }), "RP Engine")).toContain("RP Engine");
    expect(chronicleRefusal(rows({ source: "extension" }, BUILTIN), null)).not.toBeNull();
    expect(chronicleRefusal(rows({ source: "user", over: "extension" }, BUILTIN), "RP Engine")).toContain("RP Engine");
    expect(chronicleRefusal(rows(undefined, BUILTIN), "RP Engine")).not.toBeNull();
    expect(chronicleRefusal(rows(BUILTIN, undefined), "RP Engine")).not.toBeNull();
  });
});
