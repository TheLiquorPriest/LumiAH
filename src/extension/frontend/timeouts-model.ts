// Settings → Timeouts: every wait a user can meet, in one place (`shared/timeouts.ts` lists them and
// their groups), each the very setting the rest of Settings shows, so its row has the same controls.
// Pure, so it is tested without a browser.

import { TIMEOUT_GROUPS, type TimeoutGroup } from "../../shared/timeouts";
import { changedCount, type FormNode, isBranch, nodeAt } from "./settings-model";

/** A group of the page: its heading and its settings, each a node of the settings' form. */
export interface TimeoutSection {
  group: TimeoutGroup;
  nodes: FormNode[];
}

/**
 * The page's groups, each with the settings this build's schema has of it, in the list's order:
 * one the schema doesn't have is left out, and so is a group with none. Where two rows would read
 * the same ("Time per call" of each agent), each says whose it is.
 */
export function timeoutSections(form: FormNode): TimeoutSection[] {
  const found = TIMEOUT_GROUPS.map((group) => ({ group, nodes: group.rows.flatMap((path) => nodeOf(form, path)) }));
  const seen = new Map<string, number>();
  for (const { nodes } of found) for (const node of nodes) seen.set(node.label, (seen.get(node.label) ?? 0) + 1);
  return found
    .map(({ group, nodes }) => ({ group, nodes: nodes.map((node) => ((seen.get(node.label) ?? 0) > 1 ? { ...node, label: `${node.label} (${ownerOf(form, node.path)})` } : node)) }))
    .filter((section) => section.nodes.length > 0);
}

/** The setting at `path`, where the form has one that holds a value. */
function nodeOf(form: FormNode, path: readonly string[]): FormNode[] {
  const node = nodeAt(form, path);
  return node !== null && !isBranch(node) ? [node] : [];
}

/** Whose a setting is: the nearest group it sits in (the agent, the end of the link), passing over one that only gathers ("Budget"). */
function ownerOf(form: FormNode, path: readonly string[]): string {
  for (let depth = path.length - 1; depth >= 1; depth -= 1) {
    const group = nodeAt(form, path.slice(0, depth));
    if (group !== null && group.key !== "budget") return group.label;
  }
  return path.join(".");
}

/** How many of the page's waits differ from their defaults. */
export function timeoutsChanged(sections: readonly TimeoutSection[]): number {
  return sections.reduce((n, section) => n + section.nodes.reduce((m, node) => m + changedCount(node), 0), 0);
}
