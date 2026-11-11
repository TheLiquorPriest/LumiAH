// An untagged request's body as it is passed on (DESIGN §2; docs/RUNTIME.md, "A request with no
// tag"): everything Lumiverse's generation call has a place for reaches it as it came, and what it
// has no place for refuses the request by name. Nothing is left out on the way.

import { describe, expect, test } from "bun:test";
import { passedMessageDTO, passedToolDTO } from "../../src/extension/backend/spindle";
import type { JsonObject, JsonValue } from "../../src/link/json";
import { passedRequest } from "../../src/runtime/openai";

/** A few bytes of made-up media, base64. */
const IMAGE = "iVBORw0KGgo=";
const AUDIO = "UklGRiQAAAA=";
const VIDEO = "AAAAIGZ0eXA=";

/** What Lumiverse's generation call is handed for a request's body: its messages, its tools and its parameters; or why the request was refused. */
function handed(body: JsonObject): { messages: unknown[]; tools: unknown[]; parameters: JsonObject } | string {
  const passed = passedRequest(body);
  return "refused" in passed ? passed.refused : { messages: passed.messages.map(passedMessageDTO), tools: passed.tools.map(passedToolDTO), parameters: passed.parameters };
}

/** Why a request with these messages is refused; fails when it isn't. */
function refusal(messages: JsonValue[], more: JsonObject = {}): string {
  const out = handed({ model: "lumiah", messages, ...more });
  if (typeof out !== "string") throw new Error("the request was passed on");
  return out;
}

describe("a request passed through", () => {
  test("carries each kind of message and part to Lumiverse's generation call as it came", () => {
    const out = handed({
      model: "lumiah",
      stream: true,
      temperature: 0.4,
      seed: 7,
      tool_choice: "auto",
      messages: [
        { role: "developer", content: "Answer as Joss, keeper of the harbour light." },
        { role: "system", content: [{ type: "text", text: "The quay is closed after dark.", cache_control: { type: "ephemeral", ttl: "1h" } }] },
        {
          role: "user",
          name: "Mara",
          content: [
            { type: "text", text: "What do you see and hear in these?" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE}`, detail: "auto" } },
            { type: "input_audio", input_audio: { data: AUDIO, format: "wav" } },
            { type: "video_url", video_url: { url: `data:video/mp4;base64,${VIDEO}` } },
          ],
        },
        {
          role: "assistant",
          content: null,
          reasoning_content: "The tide table and the light's log will say.",
          reasoning_details: [{ type: "reasoning.text", text: "Look both up." }],
          tool_calls: [
            { id: "call_tide", type: "function", function: { name: "tide_table", arguments: '{"day":"today"}' } },
            { id: "call_log", type: "function", function: { name: "light_log", arguments: "" } },
          ],
        },
        { role: "tool", tool_call_id: "call_tide", name: "tide_table", content: "High water at 18:40." },
        { role: "tool", tool_call_id: "call_log", content: [{ type: "text", text: "Lit at dusk by Okoro." }], cache_control: { type: "ephemeral" } },
        { role: "user", content: "So who keeps the light?" },
        { role: "assistant", name: "Joss", content: "Okoro keeps", prefix: true },
      ],
      tools: [
        { type: "function", function: { name: "tide_table", description: "The day's tides.", parameters: { type: "object", properties: { day: { type: "string" } } }, strict: true } },
        { type: "function", function: { name: "light_log" } },
      ],
    });

    expect(out).toEqual({
      messages: [
        // A developer message is a system message to Lumiverse.
        { role: "system", content: "Answer as Joss, keeper of the harbour light." },
        // A list of parts stays a list, each part with its cache breakpoint as given.
        { role: "system", content: [{ type: "text", text: "The quay is closed after dark.", cache_control: { type: "ephemeral", ttl: "1h" } }] },
        {
          role: "user",
          content: [
            { type: "text", text: "What do you see and hear in these?" },
            { type: "image", data: IMAGE, mime_type: "image/png" },
            { type: "audio", data: AUDIO, mime_type: "audio/wav" },
            { type: "video", data: VIDEO, mime_type: "video/mp4" },
          ],
          name: "Mara",
        },
        // An assistant's tool calls follow its content, with the reasoning the model gave before them.
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_tide", name: "tide_table", input: { day: "today" } },
            { type: "tool_use", id: "call_log", name: "light_log", input: {} },
          ],
          reasoning_content: "The tide table and the light's log will say.",
          reasoning_details: [{ type: "reasoning.text", text: "Look both up." }],
        },
        // A run of tool results is one user message of results, each tied to its call.
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_tide", content: "High water at 18:40." },
            { type: "tool_result", tool_use_id: "call_log", content: "Lit at dusk by Okoro.", cache_control: { type: "ephemeral" } },
          ],
        },
        { role: "user", content: "So who keeps the light?" },
        // `prefix: true` is Lumiverse's `partial`: the model continues the message.
        { role: "assistant", content: "Okoro keeps", name: "Joss", partial: true },
      ],
      tools: [
        { name: "tide_table", description: "The day's tides.", parameters: { type: "object", properties: { day: { type: "string" } } }, strict: true },
        { name: "light_log", description: "", parameters: { type: "object", properties: {} } },
      ],
      // Every other field of the body, but the model and the stream flag, which are the runtime's own.
      parameters: { temperature: 0.4, seed: 7, tool_choice: "auto" },
    });
  });

  test("takes `partial: true` for the prefix mark too, and an assistant's `reasoning` for its reasoning", () => {
    const out = handed({ messages: [{ role: "assistant", content: "Okoro", partial: true, reasoning: "Ilse handed him the keys." }] });
    expect(out).toMatchObject({ messages: [{ role: "assistant", content: "Okoro", partial: true, reasoning_content: "Ilse handed him the keys." }] });
  });

  test("passes over a field that holds nothing", () => {
    const out = handed({ messages: [{ role: "assistant", content: "Okoro keeps it now.", name: "", refusal: null, audio: null, function_call: null, tool_calls: [], annotations: [], prefix: false }], tools: [] });
    expect(out).toEqual({ messages: [{ role: "assistant", content: "Okoro keeps it now." }], tools: [], parameters: {} });
  });

  test("refuses a request that holds media it can't hand on, and says which", () => {
    expect(refusal([{ role: "user", content: [{ type: "text", text: "Whose boat?" }, { type: "image_url", image_url: { url: "https://harbour.example/boats/brann.png" } }] }])).toBe(
      "LumiAH didn't pass this request on: message 1's part 2 is given by its address (https://harbour.example/boats/brann.png), and Lumiverse's generation call takes media only as its data: send it as a base64 `data:` URL (the runtime downloads nothing). A request that is no reply of a chat's goes to the writer's connection whole or not at all, so that nothing of a prompt is dropped on the way.",
    );
    expect(refusal([{ role: "user", content: [{ type: "video_url", video_url: { url: "https://harbour.example/tide.mp4" } }] }])).toContain("message 1's part 1 is given by its address");
    expect(refusal([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/svg+xml,%3Csvg%2F%3E" } }] }])).toContain("is a `data:` URL of another form than `data:<type>;base64,<data>`");
    expect(refusal([{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE}`, detail: "high" } }] }])).toContain("asks for its image at `detail: high`");
    expect(refusal([{ role: "user", content: [{ type: "input_audio", input_audio: { data: AUDIO } }] }])).toContain("is audio without its data or its format");
    // A file has no place in Lumiverse's generation call, whether it comes as its data or as a provider's id for it.
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
