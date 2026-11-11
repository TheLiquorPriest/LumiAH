// Every "Open the setting" of the pages lands on a setting Settings really has (a link that named
// none used to open Settings on its first section, with no word), and no page leads to a setting
// by a path of its own writing: through the links' one list, or with a path the backend gave it.

import { describe, expect, test } from "bun:test";
import { MockBackend } from "../../dev/preview/mock-backend";
import { realSettings } from "../../dev/preview/sections";
import { SETTING_LINKS, type SettingLink } from "../../src/extension/frontend/setting-links";
import { formOf, leavesOf, navOf, sectionAt, sectionFor, settingPlace } from "../../src/extension/frontend/settings-model";

const settled = realSettings();
const settings = new MockBackend(() => {}, { scenario: "ready", turn: "none", sections: settled.sections, texts: settled.texts, delay: 0, page: 50, fail: new Set(), now: () => 0, later: () => () => {} }).state.settings;
const form = formOf(settings);
const nav = navOf(form);
const links = Object.keys(SETTING_LINKS) as SettingLink[];

describe("the settings the pages lead to", () => {
  test("each is a setting of LumiAH's own settings, found where they keep it", () => {
    for (const link of links) {
      const place = settingPlace(settings.schema, SETTING_LINKS[link]);
      expect({ link, place: place?.join(".") ?? null }).not.toEqual({ link, place: null });
      // It is one setting, with a control of its own, so Settings can mark it.
      expect({ link, leaf: leavesOf(form).some((leaf) => leaf.path.join(".") === place?.join(".")) }).toEqual({ link, leaf: true });
    }
  });

  test("each opens a section Settings lists", () => {
    for (const link of links) {
      const place = settingPlace(settings.schema, SETTING_LINKS[link]) ?? [];
      const section = sectionFor(nav, place) ?? sectionAt(nav, place);
      expect({ link, section: section?.node.label ?? null }).not.toEqual({ link, section: null });
    }
    // Where each lands, said once so a change of a section's name shows here.
    expect(sectionFor(nav, settingPlace(settings.schema, SETTING_LINKS.guidanceLength) ?? [])?.node.label).toBe("Guidance");
    expect(sectionFor(nav, settingPlace(settings.schema, SETTING_LINKS.workspaceLimits) ?? [])?.node.label).toBe("The workspace");
    expect(sectionFor(nav, settingPlace(settings.schema, SETTING_LINKS.agentsModel) ?? [])?.node.label).toBe("Main agent");
  });

  test("a place the settings shown don't hold is none, at their root or in a section", () => {
    expect(settingPlace(settings.schema, ["guidance", "nothing"])).toBeNull();
    expect(settingPlace(settings.schema, ["core", "guidance", "chars"])).toEqual(["core", "guidance", "chars"]);
    expect(settingPlace({ type: "object", properties: { guidance: { type: "object", properties: { chars: { type: "integer" } } } } }, ["guidance", "chars"])).toEqual(["guidance", "chars"]);
  });

  test("no page writes a setting's path itself", async () => {
    const written: string[] = [];
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: `${import.meta.dir}/../../src/extension/frontend` })) {
      if (file === "setting-links.ts") continue;
      const source = await Bun.file(`${import.meta.dir}/../../src/extension/frontend/${file}`).text();
      // A path written where a page leads to Settings: `setting: [` with a name in it, as against one handed on (`setting: cap.path`).
      if (/\bsetting:\s*\[\s*["'`.]/.test(source)) written.push(file);
    }
    expect(written).toEqual([]);
  });
});
