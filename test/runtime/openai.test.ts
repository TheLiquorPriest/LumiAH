// An untagged request's body as it is read to be passed on (DESIGN §2; docs/RUNTIME.md, "A request
// with no tag"): what the runtime's model calls have no place for refuses the request by name, so
// nothing is left out on the way. How what is read reaches a provider is the model layer's (its
// own tests, test/runtime/models/pass.test.ts).

import { describe, expect, test } from "bun:test";
import type { JsonObject, JsonValue } from "../../src/link/json";
import { type PassedRequest, passedRequest } from "../../src/runtime/openai";

/** A few bytes of made-up media, base64. */
const IMAGE = "iVBORw0KGgo=";
const AUDIO = "UklGRiQAAAA=";

/** What a request's body is read as: its messages, its tools and its parameters; or why the request was refused. */
function handed(body: JsonObject): PassedRequest | string {
  const passed = passedRequest(body);
  return "refused" in passed ? passed.refused : passed;
}

/** Why a request with these messages is refused; fails when it isn't. */
function refusal(messages: JsonValue[], more: JsonObject = {}): string {
  const out = handed({ model: "lumiah", messages, ...more });
  if (typeof out !== "string") throw new Error("the request was passed on");
  return out;
}

describe("a request passed through", () => {
  test("is read with every field of its body beside its messages and tools, but the model and the stream flag", () => {
    const out = handed({ model: "lumiah", stream: true, messages: [{ role: "user", content: "Where is Ilse?" }], temperature: 0.4, seed: 7 });
    expect(out).toEqual({ messages: [{ role: "user", content: "Where is Ilse?" }], tools: [], parameters: { temperature: 0.4, seed: 7 } });
  });

  test("refuses a request that holds media it can't hand on, and says which", () => {
    expect(refusal([{ role: "user", content: [{ type: "text", text: "Whose boat?" }, { type: "image_url", image_url: { url: "https://harbour.example/boats/brann.png" } }] }])).toBe(
      "LumiAH didn't pass this request on: message 1's part 2 is given by its address (https://harbour.example/boats/brann.png), and the runtime's model calls take media only as its data: send it as a base64 `data:` URL (the runtime downloads nothing). A request that is no reply of a chat's goes to the writer's connection whole or not at all, so that nothing of a prompt is dropped on the way.",
    );
    expect(refusal([{ role: "user", content: [{ type: "video_url", video_url: { url: "https://harbour.example/tide.mp4" } }] }])).toContain("message 1's part 1 is given by its address");
    expect(refusal([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/svg+xml,%3Csvg%2F%3E" } }] }])).toContain("is a `data:` URL of another form than `data:<type>;base64,<data>`");
    expect(refusal([{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE}`, detail: "high" } }] }])).toContain("asks for its image at `detail: high`");
    expect(refusal([{ role: "user", content: [{ type: "input_audio", input_audio: { data: AUDIO } }] }])).toContain("is audio without its data or its format");
    // A file has no place in the runtime's model calls, whether it comes as its data or as a provider's id for it.
    expect(refusal([{ role: "user", content: [{ type: "file", file: { filename: "tide-tables.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } }] }])).toContain("is a part of the kind `file`");
    expect(refusal([{ role: "user", content: [{ type: "file", file: { file_id: "file-tide-tables" } }] }])).toContain("is a part of the kind `file`");
  });

  test("refuses a request that holds a message, a part, a field or a tool it has no way to pass on, and says which", () => {
    const asked = { role: "user", content: "Who keeps the light?" };
    expect(refusal([asked, { role: "function", name: "tide_table", content: "High water at 18:40." }])).toContain("message 2 has the role `function`");
    expect(refusal([asked, { role: "assistant", content: [{ type: "refusal", refusal: "I can't say." }] }])).toContain("message 2's part 1 is a part of the kind `refusal`");
    expect(refusal([asked, { role: "assistant", content: null, function_call: { name: "tide_table", arguments: "{}" } }])).toContain("message 2 has the field `function_call`");
    expect(refusal([asked, { role: "assistant", content: null, audio: { id: "audio_ilse" } }])).toContain("message 2 has the field `audio`");
    expect(refusal([asked, { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "custom", custom: { name: "note", input: "Low tide." } }] }])).toContain("message 2's tool call 1 has the field `custom`");
    expect(refusal([asked, { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "tide_table", arguments: "{day:" } }] }])).toContain("message 2's tool call 1's arguments aren't a JSON object");
    expect(refusal([asked, { role: "tool", content: "High water at 18:40." }])).toContain("message 2, a tool's result, names no tool call");
    expect(refusal([asked, { role: "tool", tool_call_id: "call_1", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE}` } }] }])).toContain("message 2, a tool's result, holds more than text");
    // A prefix is an assistant message's to carry, and a name is text.
    expect(refusal([{ ...asked, prefix: true }])).toContain("message 1 has the field `prefix`");
    expect(refusal([{ ...asked, name: 7 }])).toContain("message 1 has a name that isn't text");
    expect(refusal([asked], { tools: [{ type: "web_search" }] })).toContain("tool 1 isn't a function");
    expect(refusal([asked], { tools: [{ type: "function", function: { name: "tide_table", cache_control: { type: "ephemeral" } } }] })).toContain("tool 1 has the field `cache_control`");
  });
});
