// The runtime's connections and sign-ins as the pages keep them (Runtime → Connections): the page
// ops `connections.*` and `signin.*`, each a thin pass to the model layer (models/). A page reaches
// them through the extension, which asks only the runtime of the page's own user (`ask` on the
// link). A key comes in with `connections.save`, on its way to the book, and nothing here gives one
// back: every answer is the connections as the pages see them (whether a key is set and its last
// four characters, never the key).
//
// What the layer refuses (a connection it can't keep as given, a sign-in that didn't finish) is
// refused as `invalid` in the layer's own words, which never hold a secret.

import type { JsonObject, JsonValue } from "../core/ports";
import { isRecord } from "../core/ports";
import { OpRefused } from "../link/work";
import type { ConnectionInput, ModelLayer, SignInProvider } from "./models";

/** The page ops answered here, by name. */
const OPS = ["connections.list", "connections.save", "connections.remove", "connections.default", "connections.test", "connections.models", "signin.start", "signin.finish", "signin.cancel", "signin.out", "signin.state"] as const;

export type BookOp = (typeof OPS)[number];

export function isBookOp(op: string): op is BookOp {
  return (OPS as readonly string[]).includes(op);
}

/** Runs what a page asked; what the layer refuses comes back refused as `invalid`, in its words. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new OpRefused("invalid", error instanceof Error ? error.message : String(error));
  }
}

function text(args: JsonObject, name: string, what: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") throw new OpRefused("bad_request", what);
  return value;
}

function provider(args: JsonObject): SignInProvider {
  const asked = args.provider;
  if (asked !== "anthropic" && asked !== "openai") throw new OpRefused("bad_request", "The runtime signs in to Anthropic and to OpenAI: say which.");
  return asked;
}

/** The connections as the pages see them, as JSON for the link. */
const json = (value: unknown): JsonValue => value as JsonValue;

/** Answers one of the ops above through the layer; `self` is this runtime (its relay and name), which every list of its connections names. */
export async function bookOp(layer: ModelLayer, op: BookOp, args: JsonObject, self: { id: string; name: string }): Promise<JsonValue> {
  const view = async (): Promise<JsonValue> => json({ ...(await layer.book.list()), relay: self });
  switch (op) {
    case "connections.list":
      return view();
    case "connections.save": {
      if (!isRecord(args.connection)) throw new OpRefused("bad_request", "Say which connection to save.");
      const key = args.key;
      if (!(key === undefined || key === null || typeof key === "string")) throw new OpRefused("bad_request", "A key is text.");
      const input = args.connection as unknown as ConnectionInput;
      const saved = await refusing(() => layer.book.save(input, key, args.create === true ? { create: true } : undefined));
      return { saved: json(saved), view: await view() };
    }
    case "connections.remove":
      await refusing(() => layer.book.remove(text(args, "id", "Say which connection to remove.")));
      return view();
    case "connections.default": {
      const id = args.id === null ? null : text(args, "id", "Say which connection is the default, or none.");
      await refusing(() => layer.book.setDefault(id));
      return view();
    }
    case "connections.test":
      return { test: json(await layer.book.test(text(args, "id", "Say which connection to test."))) };
    case "connections.models":
      if (typeof args.provider === "string") {
        const named = args.provider;
        return { models: json(await refusing(async () => layer.catalogue(named))) };
      }
      return { models: json(await refusing(() => layer.modelsOf(args.connectionId === null || args.connectionId === undefined ? null : text(args, "connectionId", "Say which connection's models to list.")))) };
    case "signin.start":
      return json(await refusing(() => layer.signIn.start(provider(args))));
    case "signin.finish": {
      const flow = text(args, "flow", "Say which sign-in to finish.");
      const code = text(args, "code", "Paste what the provider gave you after you signed in.");
      const state = await refusing(() => layer.signIn.finish(flow, code));
      return { state: json(state), view: await view() };
    }
    case "signin.cancel":
      await layer.signIn.cancel(text(args, "flow", "Say which sign-in to cancel."));
      return { cancelled: true };
    case "signin.out": {
      const which = provider(args);
      await refusing(() => layer.signIn.out(which));
      return { state: json(await layer.signIn.state(which)), view: await view() };
    }
    case "signin.state":
      return json(await layer.signIn.state(provider(args)));
  }
}
