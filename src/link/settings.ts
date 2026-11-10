// The transport's settings: every limit and timing of the link, the runtime and the extension
// backend, each with its default. They are one section (`transport`) of the user's settings, which
// the extension keeps in user storage beside the core's own section and the Settings page shows from
// the schema below; the runtime reads them over the link (`settings.get`) and keeps the ones it last
// read in its config, to start with before it has linked. Both ends import this file, so they agree
// on every name and default.
//
// The schema is JSON Schema written by hand, in the dialect the Settings page renders (the comment
// above `SettingsView` in src/shared/ui.ts): `title`, `description`, `type`, `properties`, `oneOf`
// of `const`, `minimum`, `maximum`, `x-unit`.

import type { JsonObject, JsonValue } from "./json";
import { hasOwn, isRecord } from "./json";

/** The key of this section in the user's settings. */
export const TRANSPORT_KEY = "transport";

/** The runtime's limits and timings, in milliseconds unless named. */
export interface RuntimeTuning {
  /** A keep-alive comment after this much silence on a reply's stream to Lumiverse. */
  commentMs: number;
  /** A progress line restated into the thinking block after this long without a token. */
  progressMs: number;
  /** A stream from the extension with nothing in it this long is given up. */
  stallMs: number;
  /** How long the extension may stay out of reach under a stream or a turn before it ends. */
  lostMs: number;
  /** How often the runtime pings while it reads streams or answers turns, naming them. */
  probeMs: number;
  /** How often it pings while it does neither. */
  heartbeatMs: number;
  /** How long a request may go unanswered, with nothing heard meanwhile, before the extension counts as silent. */
  silentMs: number;
  /** After Lumiverse reports an error in the extension, how long silence makes it a crash. */
  crashMs: number;
  /** How long a gap in a stream waits before its chunks are asked for again. */
  resendMs: number;
  /** How many times a gap is asked about before its stream is given up. */
  resendTries: number;
  /** Chunks between acknowledgements while a stream runs (its terminal chunk is always acknowledged). */
  ackEvery: number;
  /** Each link request's wait for its answer. */
  requestMs: number;
  /** How often the event socket is pinged while open: Lumiverse closes one idle for two minutes. */
  socketPingMs: number;
  /** How long `GET /v1/models` waits for the link to come up. */
  modelsWaitMs: number;
  /** The largest request body the runtime reads from Lumiverse. */
  maxBodyBytes: number;
  /** How long `up` waits for the turns under way to finish before it restarts a running runtime. */
  drainMs: number;
  /** How often it asks meanwhile. */
  drainPollMs: number;
  /** How many of the user's connections the runtime reads when it looks for the loopback's. */
  connectionsRead: number;
  /** The first wait before reconnecting to Lumiverse; each failure doubles it, up to `reconnectMaxMs`. */
  reconnectMs: number;
  reconnectMaxMs: number;
  /** How often the runtime asks Lumiverse about its session, which renews it. */
  sessionCheckMs: number;
  /** How long a stopping runtime waits for its last error chunks and cancels to go out. */
  stopGraceMs: number;
  /** How long trace events wait to be sent with the ones that follow them. */
  traceMs: number;
  /** The most trace events one request carries to the live view. */
  traceBatch: number;
  /** The most trace events held while they can't be sent; past it a turn's later events stay out of the live view. */
  traceHeld: number;
  /** How long a new turn waits for the chat's earlier one to stop before it is refused. */
  turnWaitMs: number;
  /** The largest frame, in characters, the runtime puts together from parts. */
  joinMaxUnits: number;
  /** How long a frame's first parts wait for the rest. */
  partStaleMs: number;
}

/** What the transport does, as the user set it. */
export interface TransportSettings {
  /** The history cutoff (DESIGN §2): which of the chat's messages a tagged prompt keeps. */
  history: { keep: "all" | "last"; count: number };
  tags: {
    /** How long a turn's tag admits its request: past it its generation is surely over. */
    lifeMs: number;
    /** The most tags remembered at once, the oldest let go first. */
    held: number;
  };
  streams: {
    /** How long a stream's text waits to be sent with what follows it. */
    coalesceMs: number;
    /** How long a finished stream's chunks are kept for an acknowledgement that never came. */
    keepMs: number;
  };
  connections: {
    /** The connections, by id, that take one tool call per answer: a call on one asks its provider for no parallel tool calls. */
    oneToolAtATime: string[];
  };
  link: {
    /** How long without a hello or a ping before a runtime shows as quiet. */
    quietMs: number;
    /** The runtimes one account may have registered at once. */
    relays: number;
    /** How long minting a key waits for the linked runtime to make the loopback connection. */
    connectionMs: number;
    /** The largest frame, in characters, the extension puts together from parts. */
    joinMaxUnits: number;
    /** How long a frame's first parts wait for the rest. */
    partStaleMs: number;
  };
  live: {
    /** The most events kept of a chat's live turn; past it the turn's later events stay out of the live view. */
    events: number;
    /** The most events one read of a live view or a stored transcript answers. */
    page: number;
    /** The most chats whose latest turn is kept for the live view. */
    chats: number;
    /** How long after its generation ended a turn that never said it ended counts as lost. */
    lostMs: number;
  };
  anchors: {
    /** How long a turn's record waits for Lumiverse to save the reply before it is let go. */
    waitMs: number;
    /** The most records waiting at once. */
    held: number;
  };
  sessions: {
    /** How much of a reply's opening the Sessions page shows to find it by. */
    previewChars: number;
    /** The most turns one page of the Sessions list holds. */
    page: number;
    /** The most chats whose message list is kept in memory between reads; 0 keeps none. */
    pathsKept: number;
  };
  runtime: RuntimeTuning;
}

export const RUNTIME_DEFAULTS: Readonly<RuntimeTuning> = Object.freeze({
  commentMs: 5_000,
  progressMs: 60_000,
  stallMs: 30 * 60_000,
  lostMs: 120_000,
  probeMs: 15_000,
  heartbeatMs: 60_000,
  silentMs: 45_000,
  crashMs: 10_000,
  resendMs: 3_000,
  resendTries: 5,
  ackEvery: 64,
  requestMs: 60_000,
  socketPingMs: 45_000,
  modelsWaitMs: 10_000,
  // Lumiverse's socket frame limit is 4 MiB; a body under it leaves room for its envelope.
  maxBodyBytes: 4 * 1024 * 1024 - 64 * 1024,
  drainMs: 5 * 60_000,
  drainPollMs: 2_000,
  connectionsRead: 200,
  reconnectMs: 1_000,
  reconnectMaxMs: 30_000,
  sessionCheckMs: 24 * 60 * 60_000,
  stopGraceMs: 500,
  traceMs: 100,
  traceBatch: 64,
  traceHeld: 20_000,
  turnWaitMs: 30_000,
  joinMaxUnits: 32 * 1024 * 1024,
  partStaleMs: 60_000,
});

export const TRANSPORT_DEFAULTS: Readonly<TransportSettings> = Object.freeze({
  history: Object.freeze({ keep: "last" as const, count: 40 }),
  tags: Object.freeze({ lifeMs: 2 * 60 * 60_000, held: 256 }),
  streams: Object.freeze({ coalesceMs: 40, keepMs: 10 * 60_000 }),
  connections: Object.freeze({ oneToolAtATime: Object.freeze([]) as unknown as string[] }),
  link: Object.freeze({ quietMs: 120_000, relays: 8, connectionMs: 15_000, joinMaxUnits: 32 * 1024 * 1024, partStaleMs: 60_000 }),
  live: Object.freeze({ events: 20_000, page: 500, chats: 32, lostMs: 30_000 }),
  anchors: Object.freeze({ waitMs: 10 * 60_000, held: 64 }),
  sessions: Object.freeze({ previewChars: 120, page: 50, pathsKept: 16 }),
  runtime: RUNTIME_DEFAULTS,
});

const ms = (title: string, description: string, minimum: number, maximum: number): JsonObject => ({ type: "integer", title, description, minimum, maximum, "x-unit": "ms" });
const whole = (title: string, description: string, minimum: number, maximum: number, unit?: string): JsonObject => ({ type: "integer", title, description, minimum, maximum, ...(unit !== undefined ? { "x-unit": unit } : {}) });

const DAY_MS = 24 * 60 * 60_000;

/** The section's schema, each setting in the order the Settings page shows it. */
export const TRANSPORT_SCHEMA: JsonObject = {
  type: "object",
  title: "Transport",
  description: "How LumiAH's runtime, its link to this extension and the extension itself carry a reply. The defaults suit a runtime on the same machine as Lumiverse.",
  additionalProperties: false,
  properties: {
    history: {
      type: "object",
      title: "History cutoff",
      description: "Which of the chat's messages stay in the prompt Lumiverse sends for a reply LumiAH answers. The main agent reads the rest of the chat with its tools when a reply needs it.",
      additionalProperties: false,
      properties: {
        keep: {
          title: "Keep",
          oneOf: [
            { const: "last", title: "The latest messages", description: "Only the latest messages stay; how many is set below." },
            { const: "all", title: "Every message", description: "Nothing is left out: the prompt is as large as Lumiverse makes it." },
          ],
        },
        count: whole("Latest messages kept", "How many of the chat's latest messages stay in the prompt when only the latest are kept.", 1, 10_000, "messages"),
      },
    },
    tags: {
      type: "object",
      title: "Turn tags",
      description: "The single-use tag the prompt interceptor puts on each generation LumiAH answers.",
      additionalProperties: false,
      properties: {
        lifeMs: ms("A tag's life", "How long after a generation starts its tag still admits its request.", 60_000, DAY_MS),
        held: whole("Tags remembered", "The most tags remembered at once; the oldest is let go first.", 8, 4096),
      },
    },
    streams: {
      type: "object",
      title: "Streams",
      description: "How a model call's answer travels from this extension to the runtime.",
      additionalProperties: false,
      properties: {
        coalesceMs: ms("Text held back", "How long a stream's text waits to be sent with what follows it. Lower shows text sooner in more, smaller pieces.", 0, 2_000),
        keepMs: ms("Unacknowledged chunks kept", "How long a finished stream's chunks are kept for an acknowledgement that never came.", 10_000, DAY_MS),
      },
    },
    connections: {
      type: "object",
      title: "Connections",
      description: "What LumiAH must know of a connection that Lumiverse doesn't say.",
      additionalProperties: false,
      properties: {
        oneToolAtATime: {
          type: "array",
          title: "One tool call per answer",
          description: "Connections whose model must call one tool at a time: a call on one asks its provider for no parallel tool calls. Add a connection here when its model's answers with several tool calls at once come back broken.",
          uniqueItems: true,
          items: { type: "string", format: "connection", maxLength: 256 },
        },
      },
    },
    link: {
      type: "object",
      title: "Link",
      description: "The extension's end of the link to your runtimes.",
      additionalProperties: false,
      properties: {
        quietMs: ms("Quiet after", "How long without a word from a runtime before the Runtime page shows it as quiet.", 10_000, DAY_MS),
        relays: whole("Runtimes per account", "The runtimes one account may have registered at once.", 1, 64, "runtimes"),
        connectionMs: ms("Wait for the connection", "How long minting a key waits for your linked runtime to make the loopback connection.", 1_000, 5 * 60_000),
        joinMaxUnits: whole("Largest frame joined", "The largest frame the extension puts together from parts: a stored transcript or a model call's prompt may be this long.", 1024 * 1024, 256 * 1024 * 1024, "characters"),
        partStaleMs: ms("Parts kept", "How long the first parts of a frame wait for the rest.", 1_000, 60 * 60_000),
      },
    },
    live: {
      type: "object",
      title: "Live view",
      description: "What the extension keeps of each chat's current turn for the Live page.",
      additionalProperties: false,
      properties: {
        events: whole("Events kept per turn", "The most events kept of a chat's live turn; past it the reply's later events stay out of the Live page (its stored transcript is whole all the same).", 100, 1_000_000, "events"),
        page: whole("Events per read", "The most events one read of a live view or a stored transcript answers.", 10, 10_000, "events"),
        chats: whole("Chats kept", "The most chats whose latest turn is kept for the Live page.", 1, 1024, "chats"),
        lostMs: ms("Lost after", "How long after its generation ended a turn that never said it ended counts as lost.", 1_000, 60 * 60_000),
      },
    },
    anchors: {
      type: "object",
      title: "Anchors",
      description: "The record each turn leaves on its reply's message.",
      additionalProperties: false,
      properties: {
        waitMs: ms("Wait for the reply", "How long a turn's record waits for Lumiverse to save the reply before it is let go.", 10_000, DAY_MS),
        held: whole("Records waiting", "The most records waiting for their replies at once.", 1, 4096, "records"),
      },
    },
    sessions: {
      type: "object",
      title: "Sessions page",
      additionalProperties: false,
      properties: {
        previewChars: whole("Reply preview", "How much of a reply's opening the Sessions page shows to find it by.", 0, 2_000, "characters"),
        page: whole("Turns per page", "The most turns one page of the Sessions list holds.", 1, 500, "turns"),
        pathsKept: whole("Chats kept in memory", "The most chats whose list of messages (without their text) is kept in memory until the chat changes, so a reply reads its chat once. 0 keeps none: every read asks Lumiverse again.", 0, 1024, "chats"),
      },
    },
    runtime: {
      type: "object",
      title: "Runtime",
      description: "The runtime's own limits and timings. It reads them when it links and whenever you change them; until it has linked it uses the ones it last read.",
      additionalProperties: false,
      properties: {
        commentMs: ms("Keep-alive comment", "A comment goes out on a reply's stream after this much silence, so nothing between the runtime and Lumiverse closes it.", 1_000, 60_000),
        progressMs: ms("Progress line", "A progress line is restated in the thinking block after this long without a token, so Lumiverse sees the reply alive.", 5_000, 10 * 60_000),
        stallMs: ms("Stream stalled after", "A model call with nothing from this extension for this long is given up.", 10_000, DAY_MS),
        lostMs: ms("Extension lost after", "How long this extension may stay out of the runtime's reach during a reply before the reply ends.", 5_000, 60 * 60_000),
        probeMs: ms("Ping while working", "How often the runtime pings while it answers a reply.", 1_000, 5 * 60_000),
        heartbeatMs: ms("Ping while idle", "How often the runtime pings while it answers none.", 5_000, 60 * 60_000),
        silentMs: ms("Silent after", "How long a request may go unanswered, with nothing heard meanwhile, before this extension counts as silent.", 5_000, 60 * 60_000),
        crashMs: ms("Crashed after", "After Lumiverse reports an error in this extension, how long silence makes it a crash.", 1_000, 5 * 60_000),
        resendMs: ms("Ask again after", "How long a gap in a stream waits before the missing chunk is asked for again.", 500, 60_000),
        resendTries: whole("Times to ask again", "How many times a gap is asked about before its stream is given up.", 1, 50, "times"),
        ackEvery: whole("Chunks per acknowledgement", "How many chunks of a stream go by between acknowledgements.", 1, 4096, "chunks"),
        requestMs: ms("Request wait", "How long each request to this extension waits for its answer.", 5_000, 60 * 60_000),
        socketPingMs: ms("Socket ping", "How often the runtime pings Lumiverse's event socket. Lumiverse closes one idle for two minutes.", 5_000, 110_000),
        modelsWaitMs: ms("Model list wait", "How long the connection's model list waits for the link to come up.", 1_000, 5 * 60_000),
        maxBodyBytes: whole("Largest request", "The largest request the runtime reads from Lumiverse. A larger one is refused: lower the connection's context size, or the history cutoff.", 64 * 1024, 64 * 1024 * 1024, "bytes"),
        drainMs: ms("Wait before restart", "How long setting the runtime up again waits for replies under way before it restarts it.", 0, 60 * 60_000),
        drainPollMs: ms("Restart poll", "How often it asks meanwhile.", 500, 60_000),
        connectionsRead: whole("Connections read", "How many of your connections the runtime reads when it looks for the loopback's.", 10, 200, "connections"),
        reconnectMs: ms("First reconnect wait", "The first wait before the runtime reconnects to Lumiverse; each failure doubles it.", 100, 60_000),
        reconnectMaxMs: ms("Longest reconnect wait", "The longest wait between two tries to reconnect.", 1_000, 60 * 60_000),
        sessionCheckMs: ms("Session check", "How often the runtime asks Lumiverse about its session, which renews it.", 60_000, 7 * DAY_MS),
        stopGraceMs: ms("Stop grace", "How long a stopping runtime waits for its last words to go out.", 0, 30_000),
        traceMs: ms("Trace held back", "How long the runtime holds trace events to send them together.", 0, 5_000),
        traceBatch: whole("Trace events per request", "The most trace events one request carries to the Live page.", 1, 4096, "events"),
        traceHeld: whole("Trace events held", "The most trace events held while they can't be sent; past it a reply's later events stay out of the Live page (its stored transcript is whole all the same).", 100, 1_000_000, "events"),
        turnWaitMs: ms("Wait for the earlier reply", "How long a new reply waits for the chat's earlier one to stop before it is refused.", 1_000, 10 * 60_000),
        joinMaxUnits: whole("Largest frame joined", "The largest frame the runtime puts together from parts.", 1024 * 1024, 256 * 1024 * 1024, "characters"),
        partStaleMs: ms("Parts kept", "How long the first parts of a frame wait for the rest.", 1_000, 60 * 60_000),
      },
    },
  },
};

/** A value the section refuses: where it is, from the section's root, and why. */
export interface SettingProblem {
  path: (string | number)[];
  message: string;
}

/** Checks a value against a node of the schema above: the keywords this section uses, no more. */
function check(schema: JsonObject, value: unknown, path: (string | number)[], problems: SettingProblem[]): void {
  const title = typeof schema.title === "string" ? schema.title : String(path.at(-1) ?? "This setting");
  if (Array.isArray(schema.oneOf)) {
    const choices = schema.oneOf.flatMap((c) => (isRecord(c) && c.const !== undefined ? [c.const] : []));
    if (!choices.some((c) => c === value)) problems.push({ path, message: `${title} must be one of: ${choices.map(String).join(", ")}.` });
    return;
  }
  if (schema.type === "object") {
    if (!isRecord(value)) {
      problems.push({ path, message: `${title} must be a group of settings.` });
      return;
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(value)) if (!hasOwn(properties, key)) problems.push({ path: [...path, key], message: `There is no setting ${[...path, key].join(".")}.` });
    for (const [key, child] of Object.entries(properties)) if (hasOwn(value, key) && isRecord(child)) check(child as JsonObject, value[key], [...path, key], problems);
    return;
  }
  if (schema.type === "array") {
    // The one kind of list this section has: text items, each once.
    const max = isRecord(schema.items) && typeof schema.items.maxLength === "number" ? schema.items.maxLength : Number.MAX_SAFE_INTEGER;
    if (!Array.isArray(value)) problems.push({ path, message: `${title} must be a list.` });
    else
      value.forEach((item: unknown, i) => {
        if (typeof item !== "string" || item === "" || item.length > max) problems.push({ path: [...path, i], message: `${title} lists text, each at most ${max} characters.` });
        else if (value.indexOf(item) !== i) problems.push({ path: [...path, i], message: `${title} lists "${item}" twice.` });
      });
    return;
  }
  if (schema.type === "integer") {
    const unit = typeof schema["x-unit"] === "string" ? ` ${schema["x-unit"]}` : "";
    const min = typeof schema.minimum === "number" ? schema.minimum : Number.MIN_SAFE_INTEGER;
    const max = typeof schema.maximum === "number" ? schema.maximum : Number.MAX_SAFE_INTEGER;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) problems.push({ path, message: `${title} must be a whole number.` });
    else if (value < min || value > max) problems.push({ path, message: `${title} must be from ${min} to ${max}${unit}.` });
  }
}

/** What the section refuses of `values` (the section as stored: any part may be absent, and its default then stands); none when it takes them all. */
export function checkTransport(values: unknown): SettingProblem[] {
  const problems: SettingProblem[] = [];
  if (values !== undefined) check(TRANSPORT_SCHEMA, values, [], problems);
  return problems;
}

function merged(defaults: JsonValue, own: unknown): JsonValue {
  if (!isRecord(defaults)) return own === undefined ? defaults : (own as JsonValue);
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(defaults)) out[key] = merged(value, isRecord(own) && hasOwn(own, key) ? own[key] : undefined);
  return out;
}

/** The section's defaults as plain JSON. */
export function transportDefaults(): JsonObject {
  return JSON.parse(JSON.stringify(TRANSPORT_DEFAULTS)) as JsonObject;
}

/**
 * The section whole: the user's own values over the defaults. A value the schema refuses (a stored
 * one from another build, a hand-edited config) is left out, so its default stands; a list with an
 * item refused is left out whole.
 */
export function transportOf(values: unknown): TransportSettings {
  const SEP = "\u0000";
  const refused = checkTransport(values).map((p) => p.path.join(SEP));
  const strip = (value: unknown, path: string[]): unknown => {
    const at = path.join(SEP);
    if (refused.includes(at)) return undefined;
    if (Array.isArray(value)) return refused.some((r) => r.startsWith(`${at}${SEP}`)) ? undefined : value;
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const kept = strip(child, [...path, key]);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  };
  return merged(transportDefaults(), strip(values, [])) as unknown as TransportSettings;
}

/** The runtime's part of the section, from the settings' values whole (`{ core, transport }`). */
export function runtimeTuningOf(values: unknown): RuntimeTuning {
  return transportOf(isRecord(values) ? values[TRANSPORT_KEY] : undefined).runtime;
}
