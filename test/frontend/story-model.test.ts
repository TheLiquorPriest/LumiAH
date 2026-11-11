// What Home's chat fold shows of what counts as the story (DESIGN §24.4): each member follows
// Settings until the chat chooses; the newest message is a choice only where only the replies are
// the story; a member the extension that answers the chat sets is its, with no choice; and where
// Lumiverse doesn't say whether Sovereign Hand is on, the choice of whose messages says so.

import { describe, expect, test } from "bun:test";
import { storyChosen, storyRows } from "../../src/extension/frontend/story-model";
import type { ChatStoryView } from "../../src/shared/ui";

/** A chat with no choice of its own, Settings as shipped, and a Lumiverse that doesn't say. */
const VIEW: ChatStoryView = {
  chatId: "chat-mara",
  chosen: {},
  setting: { hidden: "leave_out", from: "lumiverse", newest: "directive" },
  claimed: null,
  sovereignHand: null,
  holds: { source: { hidden: "leave_out", from: "everyone", newest: "directive" }, by: { hidden: "user", from: "user", newest: "user" }, sovereignHand: null },
};

/** The same chat once only the replies are its story, by `by`'s word. */
const replies = (view: ChatStoryView, by: "chat" | "claim"): ChatStoryView => ({ ...view, holds: { source: { ...view.holds.source, from: "replies" }, by: { ...view.holds.by, from: by } } });

describe("a chat's own choice of what counts as its story", () => {
  test("each member follows Settings until the chat chooses; the newest message is a choice only where only the replies are the story", () => {
    expect(storyRows(VIEW).map((row) => [row.member, row.value, row.claimed])).toEqual([
      ["hidden", "settings", null],
      ["from", "settings", null],
    ]);
    const chosen = replies({ ...VIEW, chosen: { from: "replies" } }, "chat");
    expect(storyRows(chosen).map((row) => [row.member, row.value])).toEqual([
      ["hidden", "settings"],
      ["from", "replies"],
      ["newest", "settings"],
    ]);
    // A press sets that member alone; As Settings takes it back.
    expect(storyChosen(chosen, "hidden", "include")).toEqual({ from: "replies", hidden: "include" });
    expect(storyChosen(chosen, "from", "settings")).toEqual({});
  });

  test("a member the extension that answers the chat sets is its, with no choice, and names it", () => {
    const rows = storyRows(replies({ ...VIEW, claimed: { by: "Tide keeper", story: { from: "replies" } } }, "claim"));
    expect(rows.find((row) => row.member === "from")?.claimed).toContain("Tide keeper");
    expect(rows.find((row) => row.member === "hidden")?.claimed).toBeNull();
    // Its word needs no line on Sovereign Hand: it isn't the user's choice to make here.
    expect(rows.find((row) => row.member === "from")?.help).toBe("");
  });

  test("where Lumiverse doesn't say whether Sovereign Hand is on, the choice of whose messages says so; where it says, nothing is added", () => {
    expect(storyRows(VIEW).find((row) => row.member === "from")?.help).not.toBe("");
    expect(storyRows({ ...VIEW, sovereignHand: true }).find((row) => row.member === "from")?.help).toBe("");
  });
});
