// The chat tools (DESIGN §4.3): search, grep and read over the chat's own messages, every one of the
// active path before the reply, those the request doesn't hold among them. A message is named by its
// number in the chat (`index_in_chat`), as the request names it.

import { excerptOf } from "../lexical";
import type { ChatMessage, JsonObject } from "../ports";
import { TEXT, TOOL } from "../texts";
import type { ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { textArg, wholeArg } from "../util";
import { around, badCursor, grepLines, listPage, needs, pageEnd, pagerOf, readCursor } from "./paging";

/** Who wrote a message, as the answers say it: its name, else whose it is. */
function who(m: ChatMessage): string {
  return m.name.trim() !== "" ? m.name : m.role;
}

const chatSearch: ToolDefinition = {
  name: TOOL.chatSearch,
  build(env: ToolEnv) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatSearch);
    return {
      name: TOOL.chatSearch,
      description: texts.render(TEXT.tool(TOOL.chatSearch)),
      parameters: { type: "object", properties: { query: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chatSearch, "query")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chatSearch, "cursor")) } }, required: ["query"] },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const query = textArg(args.query);
        if (query === null) return needs(p, "query");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const messages = await env.chat.messages();
        if (messages.length === 0) return { text: texts.render(TEXT.answer.chatEmpty) };
        const hits = (await env.chat.index()).search(query);
        if (hits.length === 0) return { text: texts.render(TEXT.answer.chatSearchNothing, { query }) };
        return listPage(p, {
          total: hits.length,
          noun: TEXT.word.message,
          cursor,
          item: (i) => {
            const hit = hits[i];
            const m = hit ? messages[hit.key] : undefined;
            return hit && m ? texts.render(TEXT.answer.chatHit, { index: String(m.index), who: who(m), chars: String(m.content.length), excerpt: excerptOf(m.content, hit.piece, env.settings.tools.excerptChars) }) : "";
          },
        });
      },
    };
  },
};

const chatGrep: ToolDefinition = {
  name: TOOL.chatGrep,
  build(env: ToolEnv) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatGrep);
    return {
      name: TOOL.chatGrep,
      description: texts.render(TEXT.tool(TOOL.chatGrep)),
      parameters: { type: "object", properties: { text: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chatGrep, "text")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chatGrep, "cursor")) } }, required: ["text"] },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const needle = textArg(args.text);
        if (needle === null) return needs(p, "text");
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const messages = await env.chat.messages();
        if (messages.length === 0) return { text: texts.render(TEXT.answer.chatEmpty) };
        const found = grepLines(messages.map((m) => m.content), needle);
        if (found.length === 0) return { text: texts.render(TEXT.answer.chatGrepNothing, { query: needle }) };
        return listPage(p, {
          total: found.length,
          noun: TEXT.word.line,
          cursor,
          item: (i) => {
            const line = found[i];
            const m = line ? messages[line.key] : undefined;
            return line && m ? texts.render(TEXT.answer.chatLine, { index: String(m.index), who: who(m), line: String(line.line), text: around(line.text, line.at, needle.length, env.settings.tools.lineChars) }) : "";
          },
        });
      },
    };
  },
};

const chatRead: ToolDefinition = {
  name: TOOL.chatRead,
  build(env: ToolEnv) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatRead);
    return {
      name: TOOL.chatRead,
      description: texts.render(TEXT.tool(TOOL.chatRead)),
      parameters: {
        type: "object",
        properties: { from: { type: "integer", description: texts.render(TEXT.toolArg(TOOL.chatRead, "from")) }, to: { type: "integer", description: texts.render(TEXT.toolArg(TOOL.chatRead, "to")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chatRead, "cursor")) } },
        required: ["from"],
      },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const from = wholeArg(args.from);
        if (from === null) return needs(p, "from");
        const to = wholeArg(args.to) ?? from;
        const given = readCursor(p, args);
        if ("text" in given) return given;
        const messages = await env.chat.messages();
        const first = messages[0];
        const last = messages.at(-1);
        if (!first || !last) return { text: texts.render(TEXT.answer.chatEmpty) };
        const missing = [from, to].find((index) => !messages.some((m) => m.index === index));
        if (missing !== undefined) return { text: texts.render(TEXT.answer.chatNoMessage, { index: String(missing), first: String(first.index), last: String(last.index) }), error: true };
        const range = messages.filter((m) => m.index >= Math.min(from, to) && m.index <= Math.max(from, to));
        // A cursor names the message a page starts in and where in it: "12:3000".
        const start = given.given ? range.findIndex((m) => m.index === given.at) : 0;
        if (start < 0 || given.within > (range[start]?.content.length ?? 0)) return badCursor(p, args.cursor);
        const head = texts.render(TEXT.answer.chatRead, { from: String(range[0]?.index ?? from), to: String(range.at(-1)?.index ?? to), count: String(range.length) });
        const frame = (m: ChatMessage, part: { from: number; to: number; text: string }): string => texts.render(TEXT.answer.chatMessage, { index: String(m.index), who: who(m), from: String(part.from), to: String(part.to), chars: String(m.content.length), text: part.text });
        const more = (cursor: string): string => texts.render(TEXT.answer.more, { tool: p.tool, cursor });
        // The longest cursor a page could end with, so the page leaves room for it.
        const room = Math.max(1, p.pageChars - head.length - more(`${last.index}:${Math.max(...range.map((m) => m.content.length))}`).length - 2);
        const parts: string[] = [];
        let used = 0;
        let next: string | null = null;
        let offset = given.within;
        for (let i = start; i < range.length; i++) {
          const m = range[i] as ChatMessage;
          const left = room - used - frame(m, { from: m.content.length, to: m.content.length, text: "" }).length - 2;
          // A message that doesn't fit after the ones before it starts the next page.
          if (left < 1 && parts.length > 0) {
            next = `${m.index}:${offset}`;
            break;
          }
          const end = pageEnd(m.content, offset, Math.max(1, left));
          const part = frame(m, { from: offset, to: end, text: m.content.slice(offset, end) });
          parts.push(part);
          used += part.length + 2;
          if (end < m.content.length) {
            next = `${m.index}:${end}`;
            break;
          }
          offset = 0;
        }
        const footer = next !== null ? more(next) : given.given ? texts.render(TEXT.answer.end) : "";
        return { text: [head, parts.join("\n\n"), footer].filter((part) => part !== "").join("\n") };
      },
    };
  },
};

export const CHAT_TOOLS: readonly ToolDefinition[] = [chatSearch, chatGrep, chatRead];
