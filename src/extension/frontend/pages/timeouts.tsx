// Settings → Timeouts (PI-BUILD-PLAN §4.9): every wait a user can meet, grouped by what waits, each
// the very setting the rest of Settings shows (so it has the same controls: its name, what it
// guards, its default, its field, and the way back to the default). A timeout's own words name its
// setting and this page, so what timed out is found here by its name.

import type { FormNode } from "../settings-model";
import { timeoutSections, timeoutsChanged } from "../timeouts-model";
import { Button, Section } from "../components";
import { counted } from "../format";
import { Fields, type FormCtx } from "./settings-form";

export function TimeoutsPane(props: { form: FormNode; ctx: FormCtx }) {
  const sections = timeoutSections(props.form);
  const changed = timeoutsChanged(sections);
  const ctx: FormCtx = { ...props.ctx, defaults: true };
  return (
    <div data-lah-view="timeouts">
      <p class="lah-lead">Every wait in one place. A timeout says the name of the wait that ran out: find it here, give it longer, or put it back to its default.</p>
      {changed > 0 ? (
        <div class="lah-actions">
          <Button size="sm" icon="undo" disabled={ctx.busy} onClick={() => ctx.save([], sections.flatMap((s) => s.nodes.filter((n) => n.changed).map((n) => n.path)))}>
            {`Put every wait back to its default (${counted(changed, "changed", "changed")})`}
          </Button>
        </div>
      ) : null}
      {sections.map(({ group, nodes }) => (
        <Section key={group.id} title={group.label} id={`timeouts-${group.id}`}>
          <p class="lah-small lah-lead">{group.about}</p>
          <div class="lah-set-group" data-lah-timeouts={group.id}>
            <Fields nodes={nodes} ctx={ctx} />
          </div>
        </Section>
      ))}
    </div>
  );
}
