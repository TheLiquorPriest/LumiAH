// The web tool (DESIGN §24.4): web_search, over the user's own web search provider as the host's
// web port gives it. Its tier is external (§17): a query leaves the user's machine, so the approval
// rules for external tools apply to every call. It needs no chat. It is not offered where the host
// has no web port or the user has set up no provider.
//
// What the provider answers is outside data: its shape is checked, every text of it is put on one
// line and clipped, and the answer stays within Answer length however long the pages are.

import type { JsonObject } from "../ports";
import { isRecord } from "../ports";
import type { WebResult } from "../recall/ports";
import { recallOf } from "../recall/recall";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, errorText, textArg } from "../util";
import { needs, pagerOf, saidBack } from "./paging";

const A = TEXT.recall.answer;

/** A text of the web on one line, `max` characters at most. */
const flat = (text: string, max: number): string => clip(text.replace(/\s+/g, " ").trim(), max);

/** What the provider gave, read: `most` at most, and nothing that has no address. */
function resultsOf(read: unknown, most: number): WebResult[] {
  return (Array.isArray(read) ? read : [])
    .flatMap((raw: unknown): WebResult[] => {
      if (!isRecord(raw) || typeof raw.url !== "string" || raw.url.trim() === "") return [];
      const content = typeof raw.content === "string" && raw.content.trim() !== "" ? raw.content : undefined;
      return [{ title: typeof raw.title === "string" ? raw.title : "", url: raw.url, snippet: typeof raw.snippet === "string" ? raw.snippet : "", ...(content === undefined ? {} : { content }) }];
    })
    .slice(0, Math.max(1, most));
}

const webSearch: ToolDefinition = {
  name: TOOL.webSearch,
  family: FAMILY.web,
  tier: "external",
  build(env: ToolEnv) {
    const port = env.host.recall?.web;
    if (!port || recallOf(env).available?.web === false) return null;
    const { texts } = env;
    const p = pagerOf(env, TOOL.webSearch);
    const { web } = env.settings.recall;
    const none = texts.render(TEXT.recall.none);
    return {
      name: TOOL.webSearch,
      description: texts.render(TEXT.tool(TOOL.webSearch)),
      parameters: { type: "object", properties: { query: { type: "string", description: texts.render(TEXT.toolArg(TOOL.webSearch, "query")) }, pages: { type: "boolean", description: texts.render(TEXT.toolArg(TOOL.webSearch, "pages")) } }, required: ["query"] },
      tier: "external",
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const query = textArg(args.query);
        if (query === null) return needs(p, "query");
        const pages = args.pages === true || (args.pages === undefined && web.pages);
        let results: WebResult[];
        try {
          // Asked at every call: against a search that leaves the machine it costs nothing, and a provider taken away since the run began is said as that, not as the provider's error.
          if ((await port.enabled()) !== true) return { text: texts.render(A.webOff), error: true };
          results = resultsOf(await port.search(query, { count: web.results, pages }, ctx.signal), web.results);
        } catch (error) {
          // A call the run's end overtook throws on: the loop says why it ended.
          if (ctx.signal.aborted) throw error;
          return { text: saidBack(p, errorText(error), (why) => texts.render(A.webFailed, { error: why })), error: true };
        }
        if (results.length === 0) return { text: saidBack(p, query, (said) => texts.render(A.webNothing, { query: said })) };
        const head = (count: number): string => saidBack(p, query, (said) => texts.render(A.webHead, { query: said, count: texts.counted(count, TEXT.recall.word.result) }));
        const shown = (result: WebResult, i: number, page: string): string =>
          texts.render(A.webResult, { n: String(i + 1), title: flat(result.title, p.lineChars) || none, url: clip(result.url.trim(), p.lineChars), snippet: flat(result.snippet, p.lineChars) || none, page });
        // Every result's title, address and snippet first, in the provider's order: a result that doesn't fit is clipped, and none follows it.
        const lines: string[] = [];
        let left = p.pageChars - head(results.length).length;
        let whole = 0;
        for (const [i, result] of results.entries()) {
          const line = shown(result, i, "");
          if (line.length + 1 > left) {
            if (left > 2) lines.push(clip(line, left - 1));
            left = 0;
            break;
          }
          lines.push(line);
          left -= line.length + 1;
          whole++;
        }
        // Then the pages' text, the best result's first, each as long as Page text shown allows and the page has room for.
        const frame = texts.render(A.webPage, { text: "" }).length;
        for (let i = 0; i < whole && left > frame; i++) {
          const result = results[i];
          if (result?.content === undefined) continue;
          const page = texts.render(A.webPage, { text: flat(result.content, Math.min(web.pageChars, left - frame)) });
          lines[i] = shown(result, i, page);
          left -= page.length;
        }
        return { text: clip([head(lines.length), ...lines].join("\n"), p.pageChars) };
      },
    };
  },
};

export const WEB_TOOLS: readonly ToolDefinition[] = [webSearch];
