// The request (DESIGN §3.1, §3.2): the messages Lumiverse assembled for a reply, read two ways.
//
// The main agent reads them as a document: each message numbered, with whose it is and where it came
// from, the preset's instruction blocks marked as the instructions the reply must achieve.
//
// The writer is sent them as they came, with the main agent's brief put in as one message more.

import type { ModelMessage, PathMessage, PresetBlock, RequestMessage } from "./ports";
import type { Settings } from "./settings";
import { TEXT, type Texts } from "./texts";

/** The request as the main agent reads it. */
export interface RequestDocument {
  text: string;
  /** How many messages it has. */
  messages: number;
  /** The last chat message it holds, by its place in the chat; null when none of it could be traced to the chat. */
  last: number | null;
}

/** A message's text as the document shows it: its text, each part's text in order, and a word for each image, audio or video it carries (the main agent is sent text only). */
function shown(m: RequestMessage, texts: Texts): string {
  if (!m.parts) return m.content;
  return m.parts
    .map((p) => (p.type === "text" ? p.text : p.type === "media" ? texts.render(TEXT.request.media, { media: p.media }) : p.type === "tool_use" ? `${p.name} ${JSON.stringify(p.input)}` : p.content))
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * The request as a document. `blocks` are the active preset's (none when it couldn't be read: no
 * message is then marked as an instruction, and each says only what Lumiverse's tag says of it);
 * `path` names who wrote each chat message.
 */
export function requestDocument(messages: readonly RequestMessage[], blocks: readonly PresetBlock[], path: readonly PathMessage[], texts: Texts): RequestDocument {
  const blockOf = new Map(blocks.map((b) => [b.id, b]));
  const nameOf = new Map(path.map((m) => [m.id, m.name]));
  let last: number | null = null;
  const parts = messages.map((m, i): string => {
    const base = { n: String(i + 1), role: m.role, text: shown(m, texts) };
    const source = m.source;
    if (source?.kind === "history") {
      last = last === null ? source.index : Math.max(last, source.index);
      const name = nameOf.get(source.messageId) ?? "";
      return texts.render(TEXT.request.message, { ...base, from: texts.render(TEXT.request.fromHistory, { index: String(source.index), name: name === "" ? "" : `, ${name}` }) });
    }
    if (source?.kind === "block") {
      const block = blockOf.get(source.blockId);
      if (block?.kind === "instruction") return texts.render(TEXT.request.instruction, { ...base, name: block.name });
      const from = block ? texts.render(TEXT.request.fromMarker, { marker: block.marker ?? block.name, name: block.name }) : texts.render(TEXT.request.fromBlock, { name: source.blockId });
      return texts.render(TEXT.request.message, { ...base, from });
    }
    return texts.render(TEXT.request.message, { ...base, from: "" });
  });
  return { text: parts.length > 0 ? parts.join("\n\n") : texts.render(TEXT.request.empty), messages: messages.length, last };
}

/** A message of the request as a model call takes it: without where it came from. */
function plain(m: RequestMessage): ModelMessage {
  const { source: _source, ...message } = m;
  return message;
}

/**
 * The writer's conversation: Lumiverse's assembled messages as they came, with the brief put in as
 * one message, framed by the writer's own text, where Settings say and as whose. Without a brief
 * (null), the messages alone.
 *
 * "Before your last message" is before the last message of the user's that came from the chat; where
 * no message is traced to the chat, before the last user message; where there is none, at the end.
 */
export function writerMessages(messages: readonly RequestMessage[], brief: string | null, reply: Readonly<Pick<Settings["reply"], "briefAt" | "briefRole">>, texts: Texts): ModelMessage[] {
  const out = messages.map(plain);
  if (brief === null) return out;
  const message: ModelMessage = { role: reply.briefRole, content: texts.render(TEXT.writer.brief, { brief }) };
  let at = reply.briefAt === "start" ? 0 : out.length;
  if (reply.briefAt === "before_last_user") {
    const traced = messages.findLastIndex((m) => m.role === "user" && m.source?.kind === "history");
    const found = traced >= 0 ? traced : messages.findLastIndex((m) => m.role === "user");
    if (found >= 0) at = found;
  }
  out.splice(at, 0, message);
  return out;
}
