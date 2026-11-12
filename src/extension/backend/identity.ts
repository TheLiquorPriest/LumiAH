// Who a backend is in Lumiverse (DESIGN §21). LumiAH's own backend is LumiAH; an extension that
// builds LumiAH into its backend names itself here, so that a user can have both installed, each
// with its own runtime, connection and records, without either answering the other's chats.
//
// What keeps the two apart follows from the identifier alone: the runtime links to the extension of
// that identifier, the loopback connection names a model derived from it (`loopbackModel`), and
// Lumiverse gives each extension its own storage and its own entry on a message. The rest is what
// the user reads.

import { EXTENSION_IDENTIFIER, type LinkedBackend, OWN_BACKEND } from "../../link/contract";

export interface BackendIdentity {
  /** The extension's identifier in Lumiverse (its `spindle.json`): what its runtime links to (`lumiah up --extension <identifier>`), and what its start and update lines name. */
  identifier: string;
  /** The name its pages, its messages and its runtime's words show. */
  name: string;
  /** The name its runtime gives the loopback connection it makes. */
  connectionName: string;
  /**
   * Where LumiAH's records sit in the extension's own entry of a message's metadata, where the
   * extension keeps no record of its own to fold them into (`BackendOptions.anchor`). Lumiverse
   * keys that entry by the extension's identifier and lets no other extension write it, so the
   * identifier (the default) means the entry itself: it is nothing but the records, as LumiAH's
   * own is. Any other key: the records sit under that key in the entry, and the rest of the entry
   * stays the extension's own.
   */
  anchorKey: string;
  /**
   * Where its Settings, which hold LumiAH's settings and the Timeouts page, are shown, said in place
   * of "<name>'s Settings" (a timeout's words: "Runtime wait (<settingsAt> → Timeouts → Waiting for
   * the runtime)"), for an extension that shows LumiAH's pages somewhere in its own and not as its
   * own Settings (LumiRPEngine: "LumiRPEngine's Harness tab → System → Settings"). Absent: "<name>'s
   * Settings".
   */
  settingsAt?: string;
}

/** LumiAH itself. */
export const LUMIAH: BackendIdentity = { identifier: EXTENSION_IDENTIFIER, name: OWN_BACKEND.name, connectionName: OWN_BACKEND.connection, anchorKey: EXTENSION_IDENTIFIER };

/** A backend's identity: what it names of itself over LumiAH's own. An extension that names only its identifier is shown, and names its connection, by that identifier. */
export function identityOf(given: Partial<BackendIdentity> = {}): BackendIdentity {
  const identifier = given.identifier ?? LUMIAH.identifier;
  const own = identifier === LUMIAH.identifier;
  const name = given.name ?? (own ? LUMIAH.name : identifier);
  return { identifier, name, connectionName: given.connectionName ?? name, anchorKey: given.anchorKey ?? (own ? LUMIAH.anchorKey : identifier), ...(given.settingsAt !== undefined ? { settingsAt: given.settingsAt } : {}) };
}

/** Who a runtime is told it is linked to, on `register` and on every `hello`: the identity as the runtime's words use it. */
export function linkedBackend(identity: BackendIdentity): LinkedBackend {
  return { name: identity.name, connection: identity.connectionName, ...(identity.settingsAt !== undefined ? { settingsAt: identity.settingsAt } : {}) };
}
