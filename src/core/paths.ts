// Where the core keeps its documents in the host's store (`StorePort`), in one place. These paths
// are stored formats: a document written under one is read under it by every later build, so none
// changes once shipped.
//
// One process writes them: the one that holds the harness. A page reads and writes through the
// harness's own methods, never the documents themselves, so two writers never overwrite each other.

/**
 * An id as one part of a document's path: whatever a host's ids hold (a slash, a dot, a colon), the
 * part names one document and never climbs out of its folder.
 */
export function docKey(id: string): string {
  return encodeURIComponent(id).replace(/\./g, "%2E");
}

export const DOC = {
  /** The user's own area of the workspace (`~/`): where its index stands. */
  userArea: "workspace/user.json",
  /** A chat's `learned/` area: where its index stands. */
  learned: (chatId: string): string => `chats/${docKey(chatId)}/learned.json`,
  /** The chat's own area as it stands for one turn, by the turn's generation id (`root`: before any turn), with what was written since on that path. */
  chatArea: (chatId: string, generation: string): string => `chats/${docKey(chatId)}/area/${docKey(generation)}.json`,
  /** The tools the user approved for a chat. */
  approvals: (chatId: string): string => `chats/${docKey(chatId)}/approvals.json`,
  /** What the user asked of a chat's session: when they last asked for its notes to be summarized. */
  session: (chatId: string): string => `chats/${docKey(chatId)}/session.json`,
  /** A chat's jobs, as a list shows them. */
  chatJobs: (chatId: string): string => `chats/${docKey(chatId)}/jobs.json`,
  /** One job, whole. */
  job: (id: string): string => `jobs/${docKey(id)}.json`,
  /** Every job's id and chat, in the order they were started. */
  allJobs: "jobs/all.json",
  /** The jobs running now, so a restart finds those it cut off. */
  runningJobs: "jobs/running.json",
  /** One side session, whole. */
  side: (id: string): string => `sides/${docKey(id)}.json`,
  /** Every side session, as a list shows them. */
  sides: "sides.json",
  /** One hour's model calls: `day` as `2026-05-01`, `hour` as `07`, both in UTC. */
  spend: (day: string, hour: string): string => `spend/${day}/${hour}.json`,
  /** What the last sweep found and removed. */
  upkeep: "upkeep.json",
  /** A turn handed over to the host's own generation and waiting for its reply (§25), by its generation id: what its record needs, so a restart or a late reply still gets one. */
  pending: (generationId: string): string => `pending/${docKey(generationId)}.json`,
} as const;

/** The generation a chat's area is kept under before any turn has written to it. */
export const ROOT_AREA = "root";
