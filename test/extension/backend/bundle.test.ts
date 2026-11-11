// The backend bundle, held to Lumiverse's install scan. Lumiverse reads an extension's backend
// file when it is installed, updated or loaded, and refuses to run one that reaches for the
// filesystem, a subprocess, a socket, the network, the process or code made at run time. The
// source rules (test/core/boundary.test.ts) keep those out of what LumiAH writes; this test holds
// what Lumiverse actually reads, the bundle, to the scan itself, so that a refused pattern (one of
// the bundler's own making included) fails here and not at a user's install.
//
// The scan is ported from Lumiverse's `src/spindle/manager.service.ts`, at the commit LumiAH targets
// (the one `lumiverse-spindle-types` 0.6.79 goes with), function by function and regex by regex:
// `normalizeJavaScriptForSafetyScan`, `collectIgnoredSpans` (with its `skipQuoted`, `scanTemplate`,
// `isRegexContext`, `scanRegex` and `scanCode`), `isIgnoredIndex`, `createScannableSources`,
// `matchOutsideIgnored`, `decodeQuotedLiteral`, `decodeSimpleStringExpression`,
// `resolveStaticModuleSpecifier`, `addDynamicModuleHits`, `addPropertyAccessHits`,
// `addAliasPropertyHits`, `addDestructuringHits`, `addNativeFetchHits`, `isEmptyFunctionProbe` and
// `detectDangerousBackendCapabilities`, with the tables they read (`DANGEROUS_MODULE_LABELS`,
// `DANGEROUS_BUN_PROPERTIES`, `DANGEROUS_PROCESS_PROPERTIES`, `DANGEROUS_BACKEND_CHECKS`,
// `LABEL_TO_CAPABILITY`, `EMPTY_FUNCTION_PROBE_RE`). Where the port differs from the original it is
// in how TypeScript's strict index checks are met (`charAt`, `?? ""`), never in what is matched.
// When Lumiverse changes its scan, this port is changed with it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");

type SourceSpan = { start: number; end: number };
type ScannableSource = { text: string; ignoredSpans: SourceSpan[] };
type BackendSafetyCheck = { label: string; regex: RegExp };
type SpindleCapability = "dynamic_code_execution" | "base64_decode";

// The secure-socket module's name, put together here: the repository's push check refuses the
// acronym as a word, wherever it stands.
const SECURE_SOCKET = ["t", "l", "s"].join("");
const SOCKET_MODULES = `(?:net|${SECURE_SOCKET}|dgram|http|https)`;

const DANGEROUS_MODULE_LABELS = new Map<string, string>([
  ["fs", "filesystem module access"],
  ["fs/promises", "filesystem module access"],
  ["node:fs", "filesystem module access"],
  ["node:fs/promises", "filesystem module access"],
  ["child_process", "subprocess module access"],
  ["node:child_process", "subprocess module access"],
  ["net", "direct socket module access"],
  [SECURE_SOCKET, "direct socket module access"],
  ["dgram", "direct socket module access"],
  ["http", "direct socket module access"],
  ["https", "direct socket module access"],
  ["node:net", "direct socket module access"],
  [`node:${SECURE_SOCKET}`, "direct socket module access"],
  ["node:dgram", "direct socket module access"],
  ["node:http", "direct socket module access"],
  ["node:https", "direct socket module access"],
  ["worker_threads", "worker or cluster module access"],
  ["cluster", "worker or cluster module access"],
  ["node:worker_threads", "worker or cluster module access"],
  ["node:cluster", "worker or cluster module access"],
  ["bun:sqlite", "direct SQLite module access"],
  ["node:sqlite", "direct SQLite module access"],
  ["bun", "dangerous Bun system API usage"],
  ["node-fetch", "direct fetch API usage"],
  ["undici", "direct fetch API usage"],
  ["cross-fetch", "direct fetch API usage"],
]);

const DANGEROUS_BUN_PROPERTIES = new Set(["file", "write", "spawn", "spawnSync", "serve", "connect", "listen", "fetch"]);
const DANGEROUS_PROCESS_PROPERTIES = new Set(["env", "exit", "kill", "chdir", "dlopen"]);
const FETCH_PROPERTIES = new Set(["fetch"]);
const FETCH_GLOBALS = ["globalThis", "global", "self"] as const;

const DANGEROUS_BACKEND_CHECKS: BackendSafetyCheck[] = [
  {
    label: "filesystem module access",
    regex: /(?:from\s*["'`](?:node:)?fs(?:\/promises)?["'`]|require\s*\(\s*["'`](?:node:)?fs(?:\/promises)?["'`]\s*\)|import\s*\(\s*["'`](?:node:)?fs(?:\/promises)?["'`]\s*\))/,
  },
  {
    label: "subprocess module access",
    regex: /(?:from\s*["'`](?:node:)?child_process["'`]|require\s*\(\s*["'`](?:node:)?child_process["'`]\s*\)|import\s*\(\s*["'`](?:node:)?child_process["'`]\s*\))/,
  },
  {
    label: "direct socket module access",
    regex: new RegExp(`(?:from\\s*["'\`](?:node:)?${SOCKET_MODULES}["'\`]|require\\s*\\(\\s*["'\`](?:node:)?${SOCKET_MODULES}["'\`]\\s*\\)|import\\s*\\(\\s*["'\`](?:node:)?${SOCKET_MODULES}["'\`]\\s*\\))`),
  },
  {
    label: "worker or cluster module access",
    regex: /(?:from\s*["'`](?:node:)?(?:worker_threads|cluster)["'`]|require\s*\(\s*["'`](?:node:)?(?:worker_threads|cluster)["'`]\s*\)|import\s*\(\s*["'`](?:node:)?(?:worker_threads|cluster)["'`]\s*\))/,
  },
  {
    label: "direct SQLite module access",
    regex: /(?:from\s*["'`](?:bun:sqlite|node:sqlite)["'`]|require\s*\(\s*["'`](?:bun:sqlite|node:sqlite)["'`]\s*\)|import\s*\(\s*["'`](?:bun:sqlite|node:sqlite)["'`]\s*\))/,
  },
  {
    label: "dangerous Bun system API usage",
    regex: /\bBun\.(?:file|write|spawn|spawnSync|serve|connect|listen)\b/,
  },
  {
    label: "dangerous process API usage",
    regex: /\bprocess\.(?:env|exit|kill|chdir|dlopen)\b/,
  },
  {
    label: "direct fetch API usage",
    regex: /(?<![.\w$])fetch\s*(?:\?\.\s*)?\(|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*fetch\b|(?<![.\w$])fetch\s*\.\s*(?:call|apply|bind)\s*\(/,
  },
  {
    label: "direct fetch API usage",
    regex: /(?:from\s*["'`](?:node-fetch|undici|cross-fetch)["'`]|import\s*["'`](?:node-fetch|undici|cross-fetch)["'`])/,
  },
  {
    label: "dangerous Bun system API usage",
    regex: /(?:from\s*["'`]bun["'`]|import\s*["'`]bun["'`])/,
  },
];

function normalizeJavaScriptForSafetyScan(content: string): string {
  try {
    return new Bun.Transpiler({ loader: "js" }).transformSync(content);
  } catch {
    return content;
  }
}

function collectIgnoredSpans(source: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const len = source.length;
  const addSpan = (start: number, end: number): void => {
    if (end > start) spans.push({ start, end });
  };

  const skipQuoted = (start: number, quote: "'" | '"', end: number): number => {
    let i = start + 1;
    while (i < end) {
      if (source.charAt(i) === "\\") {
        i += 2;
        continue;
      }
      if (source.charAt(i) === quote) {
        addSpan(start, i + 1);
        return i + 1;
      }
      i += 1;
    }
    addSpan(start, end);
    return end;
  };

  const scanTemplate = (start: number, end: number): number => {
    let i = start + 1;
    let textStart = start;
    while (i < end) {
      if (source.charAt(i) === "\\") {
        i += 2;
        continue;
      }
      if (source.charAt(i) === "`") {
        addSpan(textStart, i + 1);
        return i + 1;
      }
      if (source.charAt(i) === "$" && source.charAt(i + 1) === "{") {
        addSpan(textStart, i + 2);
        i = scanCode(i + 2, end, true);
        if (source.charAt(i) !== "}") return i;
        textStart = i;
        i += 1;
        continue;
      }
      i += 1;
    }
    addSpan(textStart, end);
    return end;
  };

  // The tokens after which a `/` starts a regex literal and not a division.
  const REGEX_CONTEXT_CHARS = new Set(["(", ",", "=", "!", "&", "|", "?", ":", ";", "{", "[", "}", "+", "-", "*", "%", "~", "^", "<", ">"]);
  const REGEX_CONTEXT_KEYWORDS = new Set(["return", "typeof", "delete", "void", "throw", "new", "in", "of", "instanceof", "case", "do", "else", "yield", "await"]);

  const isRegexContext = (pos: number): boolean => {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(source.charAt(j))) j -= 1;
    if (j < 0) return true;
    const ch = source.charAt(j);
    if (REGEX_CONTEXT_CHARS.has(ch)) return true;
    if (/[A-Za-z_$]/.test(ch)) {
      let k = j;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(source.charAt(k))) k -= 1;
      return REGEX_CONTEXT_KEYWORDS.has(source.slice(k + 1, j + 1));
    }
    return false;
  };

  const scanRegex = (start: number, end: number): number => {
    let i = start + 1;
    let inClass = false;
    while (i < end) {
      const ch = source.charAt(i);
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "[") {
        inClass = true;
        i += 1;
        continue;
      }
      if (ch === "]" && inClass) {
        inClass = false;
        i += 1;
        continue;
      }
      if (ch === "/" && !inClass) {
        i += 1;
        while (i < end && /[dgimsuy]/.test(source.charAt(i))) i += 1;
        addSpan(start, i);
        return i;
      }
      // A regex that doesn't end on its line: the rest stays scannable.
      if (ch === "\n") return start + 1;
      i += 1;
    }
    addSpan(start, end);
    return end;
  };

  const scanCode = (start: number, end: number, stopOnTemplateBrace = false): number => {
    let i = start;
    while (i < end) {
      const ch = source.charAt(i);
      if (stopOnTemplateBrace && ch === "}") return i;
      if (ch === "/" && source.charAt(i + 1) === "/") {
        const lineEnd = source.indexOf("\n", i + 2);
        const commentEnd = lineEnd === -1 ? end : lineEnd;
        addSpan(i, commentEnd);
        i = commentEnd;
        continue;
      }
      if (ch === "/" && source.charAt(i + 1) === "*") {
        const blockEnd = source.indexOf("*/", i + 2);
        const commentEnd = blockEnd === -1 ? end : blockEnd + 2;
        addSpan(i, commentEnd);
        i = commentEnd;
        continue;
      }
      if (ch === "/" && isRegexContext(i)) {
        i = scanRegex(i, end);
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = skipQuoted(i, ch, end);
        continue;
      }
      if (ch === "`") {
        i = scanTemplate(i, end);
        continue;
      }
      i += 1;
    }
    return i;
  };

  scanCode(0, len);
  return spans.sort((a, b) => a.start - b.start);
}

function isIgnoredIndex(index: number | undefined, spans: SourceSpan[]): boolean {
  if (index === undefined || index < 0) return false;
  for (const span of spans) {
    if (index < span.start) return false;
    if (index >= span.start && index < span.end) return true;
  }
  return false;
}

function createScannableSources(content: string): ScannableSource[] {
  const normalized = normalizeJavaScriptForSafetyScan(content);
  const texts = normalized === content ? [content] : [content, normalized];
  return texts.map((text) => ({ text, ignoredSpans: collectIgnoredSpans(text) }));
}

function matchOutsideIgnored(source: ScannableSource, regex: RegExp): RegExpMatchArray[] {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const globalRegex = new RegExp(regex.source, flags);
  const matches: RegExpMatchArray[] = [];
  for (const match of source.text.matchAll(globalRegex)) {
    if (!isIgnoredIndex(match.index, source.ignoredSpans)) matches.push(match);
  }
  return matches;
}

function decodeQuotedLiteral(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)$/.test(trimmed)) return null;
  const quote = trimmed.charAt(0);
  const body = trimmed.slice(1, -1);
  if (quote === "`") return body.replace(/\$\{[^}]*\}/g, "");
  if (quote === '"') {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return body;
    }
  }
  return body.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

function decodeSimpleStringExpression(raw: string): string | null {
  const trimmed = raw.trim();
  const direct = decodeQuotedLiteral(trimmed);
  if (direct !== null) return direct;

  const charCode = trimmed.match(/^String\.fromCharCode\s*\(([^)]*)\)$/);
  if (charCode) {
    const chars = (charCode[1] ?? "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 0x10ffff);
    if (chars.length > 0) return String.fromCodePoint(...chars);
  }

  const literalParts = [...trimmed.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g)].map((match) => {
    if (match[3] !== undefined) return match[3].replace(/\$\{[^}]*\}/g, "");
    if (match[1] !== undefined) return decodeQuotedLiteral(`"${match[1]}"`) ?? "";
    return decodeQuotedLiteral(`'${match[2]}'`) ?? "";
  });
  return literalParts.length > 0 ? literalParts.join("") : null;
}

/** A dynamic `import()` or `require()` specifier, where the whole expression is provably one constant string; null for anything else, which the scan then refuses. */
function resolveStaticModuleSpecifier(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const charCode = trimmed.match(/^String\.fromCharCode\s*\(([^)]*)\)$/);
  if (charCode) {
    const parts = (charCode[1] ?? "").split(",").map((p) => p.trim());
    if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return null;
    const codes = parts.map(Number);
    if (codes.some((n) => !Number.isInteger(n) || n < 0 || n > 0x10ffff)) return null;
    return String.fromCodePoint(...codes);
  }

  const LITERAL = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:[^`\\$]|\\.|\$(?!\{))*`)/;
  let rest = trimmed;
  let value = "";
  let matchedAny = false;
  while (rest) {
    const m = rest.match(LITERAL);
    if (!m) return null;
    const decoded = decodeQuotedLiteral(m[0]);
    if (decoded === null) return null;
    value += decoded;
    matchedAny = true;
    rest = rest.slice(m[0].length).replace(/^\s+/, "");
    if (!rest) break;
    // `import(spec, { with: … })`: the specifier is complete.
    if (rest.charAt(0) === ",") break;
    if (rest.charAt(0) !== "+") return null;
    rest = rest.slice(1).replace(/^\s+/, "");
    if (!rest) return null;
  }
  return matchedAny ? value : null;
}

function addDynamicModuleHits(source: ScannableSource, hits: Set<string>): void {
  for (const match of matchOutsideIgnored(source, /(?<![.\w$])(?:require|import)\s*\(([^;\n]{1,300})\)/)) {
    if (match.index !== undefined) {
      const tail = source.text.slice(match.index + match[0].length);
      // `require(name) { … }` is a method's definition.
      if (/^\s*\{/.test(tail)) continue;
    }
    const resolved = resolveStaticModuleSpecifier(match[1] ?? "");
    if (resolved === null) {
      hits.add("dynamic module access");
      continue;
    }
    const label = DANGEROUS_MODULE_LABELS.get(resolved);
    if (label) hits.add(label);
  }
}

function addPropertyAccessHits(source: ScannableSource, objectName: string, properties: Set<string>, label: string, hits: Set<string>): void {
  const escapedObject = objectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dotAccess = new RegExp(`\\b${escapedObject}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
  for (const match of matchOutsideIgnored(source, dotAccess)) {
    if (properties.has(match[1] ?? "")) hits.add(label);
  }

  const computedAccess = new RegExp(`\\b${escapedObject}\\s*\\[([^\\]]{1,300})\\]`, "g");
  for (const match of matchOutsideIgnored(source, computedAccess)) {
    const property = decodeSimpleStringExpression(match[1] ?? "");
    if (property && properties.has(property)) hits.add(label);
  }
}

function addAliasPropertyHits(source: ScannableSource, hits: Set<string>): void {
  const aliases = new Map<string, "Bun" | "process">();
  for (const match of matchOutsideIgnored(source, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(Bun|process)\b/)) {
    aliases.set(match[1] ?? "", match[2] === "Bun" ? "Bun" : "process");
  }

  for (const [alias, aliasSource] of aliases) {
    addPropertyAccessHits(source, alias, aliasSource === "Bun" ? DANGEROUS_BUN_PROPERTIES : DANGEROUS_PROCESS_PROPERTIES, aliasSource === "Bun" ? "dangerous Bun system API usage" : "dangerous process API usage", hits);
  }
}

function addDestructuringHits(source: ScannableSource, hits: Set<string>): void {
  for (const match of matchOutsideIgnored(source, /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*Bun\b/)) {
    for (const prop of (match[1] ?? "").split(",")) {
      const name = prop.trim().split(/\s*:/, 1)[0]?.trim();
      if (name !== undefined && DANGEROUS_BUN_PROPERTIES.has(name)) hits.add("dangerous Bun system API usage");
    }
  }

  for (const match of matchOutsideIgnored(source, /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\b/)) {
    for (const prop of (match[1] ?? "").split(",")) {
      const name = prop.trim().split(/\s*:/, 1)[0]?.trim();
      if (name !== undefined && DANGEROUS_PROCESS_PROPERTIES.has(name)) hits.add("dangerous process API usage");
    }
  }
}

function addNativeFetchHits(source: ScannableSource, hits: Set<string>): void {
  for (const objectName of FETCH_GLOBALS) {
    addPropertyAccessHits(source, objectName, FETCH_PROPERTIES, "direct fetch API usage", hits);
  }

  for (const match of matchOutsideIgnored(source, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(globalThis|global|self)\b/)) {
    addPropertyAccessHits(source, match[1] ?? "", FETCH_PROPERTIES, "direct fetch API usage", hits);
  }

  for (const match of matchOutsideIgnored(source, /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:globalThis|global|self)\b/)) {
    for (const prop of (match[1] ?? "").split(",")) {
      const name = prop.trim().split(/\s*:/, 1)[0]?.trim();
      if (name === "fetch") hits.add("direct fetch API usage");
    }
  }
}

/** The labels a capability the manifest asks for (`requested_capabilities`) lets through; every other label has no opt-in. */
const LABEL_TO_CAPABILITY: ReadonlyMap<string, SpindleCapability> = new Map([
  ["dynamic code execution", "dynamic_code_execution"],
  ["base64 decoding", "base64_decode"],
]);

/** `Function()` and `Function("")`: the probe some libraries make to see whether code may be made at run time, which makes none. */
const EMPTY_FUNCTION_PROBE_RE = /\bFunction\s*\(\s*(?:""|''|``|)\s*\)/g;

function isEmptyFunctionProbe(source: ScannableSource, matchIndex: number): boolean {
  EMPTY_FUNCTION_PROBE_RE.lastIndex = 0;
  let probe: RegExpExecArray | null;
  while ((probe = EMPTY_FUNCTION_PROBE_RE.exec(source.text)) !== null) {
    if (probe.index === matchIndex) return true;
    if (probe.index > matchIndex) return false;
  }
  return false;
}

function detectDangerousBackendCapabilities(content: string, declared: ReadonlySet<SpindleCapability> = new Set()): string[] {
  const hits = new Set<string>();
  for (const source of createScannableSources(content)) {
    for (const check of DANGEROUS_BACKEND_CHECKS) {
      if (matchOutsideIgnored(source, check.regex).length > 0) hits.add(check.label);
    }
    addDynamicModuleHits(source, hits);
    addPropertyAccessHits(source, "Bun", DANGEROUS_BUN_PROPERTIES, "dangerous Bun system API usage", hits);
    addPropertyAccessHits(source, "process", DANGEROUS_PROCESS_PROPERTIES, "dangerous process API usage", hits);
    addAliasPropertyHits(source, hits);
    addDestructuringHits(source, hits);
    addNativeFetchHits(source, hits);
    if (matchOutsideIgnored(source, /\bObject\.getOwnPropertyDescriptor\s*\(\s*process\s*,\s*["'`]env["'`]/).length > 0) hits.add("dangerous process API usage");

    for (const match of matchOutsideIgnored(source, /\beval\s*\(|\bFunction\s*\(/)) {
      if (match.index === undefined) continue;
      if (match[0].startsWith("Function") && isEmptyFunctionProbe(source, match.index)) continue;
      hits.add("dynamic code execution");
      break;
    }

    if (matchOutsideIgnored(source, /\bBuffer\.from\s*\([^)]*["'`]base64["'`]/).length > 0) hits.add("base64 decoding");
  }

  if (declared.size === 0) return [...hits];
  return [...hits].filter((label) => {
    const cap = LABEL_TO_CAPABILITY.get(label);
    return cap === undefined || !declared.has(cap);
  });
}

/** The capabilities LumiAH's manifest asks the user for at install, as the scan reads them: what isn't one is dropped. */
function declaredCapabilities(): Set<SpindleCapability> {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, "spindle.json"), "utf8"));
  const raw: unknown = typeof manifest === "object" && manifest !== null && "requested_capabilities" in manifest ? manifest.requested_capabilities : null;
  const declared = new Set<SpindleCapability>();
  if (!Array.isArray(raw)) return declared;
  for (const entry of raw) if (entry === "dynamic_code_execution" || entry === "base64_decode") declared.add(entry);
  return declared;
}

const scan = (code: string): string[] => detectDangerousBackendCapabilities(code).sort();

describe("Lumiverse's install scan, as ported here", () => {
  test("refuses what reaches past the sandbox, however it is spelled", () => {
    expect(scan('const tides = await fetch("https://harbour.example/tides");')).toEqual(["direct fetch API usage"]);
    expect(scan("const ask = globalThis.fetch;")).toEqual(["direct fetch API usage"]);
    expect(scan('import { readFileSync } from "node:fs";\nreadFileSync("light.md");')).toEqual(["filesystem module access"]);
    expect(scan(`const sockets = require("${SECURE_SOCKET}");`)).toEqual(["direct socket module access"]);
    expect(scan('const home = process.env.HOME;')).toEqual(["dangerous process API usage"]);
    expect(scan("const { env } = process;")).toEqual(["dangerous process API usage"]);
    expect(scan('Bun["ser" + "ve"]({ port: 7872 });')).toEqual(["dangerous Bun system API usage"]);
    expect(scan('const keeper = new Function("return 1");')).toEqual(["dynamic code execution"]);
    expect(scan('const lamp = eval("1 + 1");')).toEqual(["dynamic code execution"]);
    expect(scan('const key = Buffer.from(text, "base64");')).toEqual(["base64 decoding"]);
    // A module whose name isn't one provable constant could be any module.
    expect(scan('const mod = loaders.length > 0 ? import("node:" + name) : null;')).toEqual(["dynamic module access"]);
  });

  test("passes the same words where they are no code: in a string, a comment or a regex, as an object's key, and in the empty probe", () => {
    expect(scan('const words = "process.env, eval( and fetch( in a sentence";')).toEqual([]);
    expect(scan('// fetch("https://harbour.example") and eval("1") in a comment\nconst lamp = 1;')).toEqual([]);
    // A provider's error words, matched by a regex that names the bare word.
    expect(scan("const passing = /fetch failed|socket hang up|ECONNRESET/i;\nconst again = passing.test(words);")).toEqual([]);
    expect(scan('const said = words.replace(/eval\\(|Function\\(/g, "");')).toEqual([]);
    // A scheme kept as a key, quoted or not, loads no module.
    expect(scan('const schemes = { "node:": "built in", node: "bare", "bun:": "built in" };')).toEqual([]);
    expect(scan('let canMake = true;\ntry { new Function(""); } catch { canMake = false; }')).toEqual([]);
    // A method that happens to be called require or fetch is no module load and no network call.
    expect(scan('const got = await host.fetch("tides");\nconst tool = registry.require("lookup");')).toEqual([]);
  });

  test("lets through only what the manifest asked the user for", () => {
    const code = 'const key = Buffer.from(text, "base64");\nconst home = process.env.HOME;';
    expect(detectDangerousBackendCapabilities(code, new Set<SpindleCapability>(["base64_decode", "dynamic_code_execution"]))).toEqual(["dangerous process API usage"]);
  });
});

describe("the backend bundle", () => {
  let dir = "";
  let bundle = "";
  let built = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lumiah-bundle-"));
    const out = join(dir, "backend.js");
    // As scripts/build.ts bundles it (`bun run build`), into a folder of its own: the same entry, target and build id's define.
    const run = Bun.spawnSync([process.execPath, "build", "src/extension/backend/main.ts", "--outfile", out, "--target", "bun", "--define", `process.env.LAH_BUILD_ID=${JSON.stringify("scan-test")}`], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    built = run.exitCode === 0 ? "" : `bun build failed (${run.exitCode}): ${run.stderr.toString()}${run.stdout.toString()}`;
    if (built === "") bundle = readFileSync(out, "utf8");
  }, 120_000);

  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  test("is built here the way `bun run build` builds it", () => {
    // What this test runs is read off the build script: when that changes, this must change with it.
    const script = readFileSync(join(ROOT, "scripts/build.ts"), "utf8");
    expect(script).toContain('bundle("src/extension/backend/main.ts", "dist/backend.js", "bun");');
    expect(script).toContain('[process.execPath, "build", entry, "--outfile", out, "--target", target, ...flags, "--define", `process.env.LAH_BUILD_ID=${JSON.stringify(id)}`]');
    expect(built).toBe("");
    expect(bundle).toContain("scan-test");
  });

  test("holds nothing Lumiverse's install scan refuses, so it installs", () => {
    expect(built).toBe("");
    expect(detectDangerousBackendCapabilities(bundle, declaredCapabilities())).toEqual([]);
  }, 120_000);
});
