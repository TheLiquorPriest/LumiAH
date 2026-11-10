// The settings and texts the preview's Settings page shows. By default they are LumiAH's own: the
// core's section and the transport's, with their real schemas, defaults and checks, and every text
// the core sends a model, so the page is seen with exactly what the extension gives it. `sample`
// is a small made-up section that uses every keyword the page reads (fixtures.ts).

import { checkSettings, defaultSettings, SETTINGS_SCHEMA } from "../../src/core/settings";
import { checkText, TEXT_DEFS } from "../../src/core/texts";
import { checkTransport, TRANSPORT_KEY, TRANSPORT_SCHEMA, transportDefaults } from "../../src/link/settings";
import type { JsonObject, TextDef } from "../../src/shared/ui";
import { SAMPLE_SCHEMA, SAMPLE_TEXTS, sampleDefaults } from "./fixtures";
import { checkAgainst, type MockSection } from "./mock-backend";

export interface Settled {
  sections: MockSection[];
  texts: { defs: readonly TextDef[]; check(id: string, text: string): string | null };
}

/** LumiAH's own settings and texts, as the extension's backend holds them: the core's section under `core`, the transport's under its key. */
export function realSettings(): Settled {
  return {
    sections: [
      // The core's settings are a typed object; the page and the store hold them as JSON.
      { key: "core", defaults: () => JSON.parse(JSON.stringify(defaultSettings())) as JsonObject, schema: SETTINGS_SCHEMA, check: checkSettings },
      { key: TRANSPORT_KEY, defaults: transportDefaults, schema: TRANSPORT_SCHEMA, check: checkTransport },
    ],
    texts: { defs: TEXT_DEFS, check: checkText },
  };
}

/** The made-up section and texts. A text is refused when it leaves out a placeholder it needs. */
export function sampleSettings(): Settled {
  return {
    sections: [{ key: "sample", defaults: sampleDefaults, schema: SAMPLE_SCHEMA, check: (values) => checkAgainst(SAMPLE_SCHEMA, values) }],
    texts: {
      defs: SAMPLE_TEXTS,
      check: (id, text) => {
        const missing = (SAMPLE_TEXTS.find((d) => d.id === id)?.vars ?? []).filter((v) => v.required === true && !text.includes(`{{${v.name}}}`));
        return missing.length > 0 ? `The text needs ${missing.map((v) => `{{${v.name}}}`).join(", ")}.` : null;
      },
    },
  };
}
