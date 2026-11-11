// The strip under the page bar, on every page: what waits for the user somewhere they aren't
// looking (a tool call held for their word in another chat, a job or a side session), and what
// they haven't been told yet (a job that finished, failed, was interrupted, or needs them), each
// with the way to it. A notice stays until dismissed, here or on any other page of theirs.
//
// The strip stands over every page, so it stays small: a held call gets its line (it needs an
// answer now), and of the notices only the newest shows, cut to two lines, until the user asks for
// all of them. On a phone two notices in full took a third of the screen from the page under them.

import { useState } from "preact/hooks";
import { useApp } from "./app";
import { Button, IconButton, useBusy } from "./components";
import { ago } from "./format";
import { Icon, type IconName } from "./icons";
import { roleLabel } from "./live-model";
import { attentionOf, noticeWords, type Target } from "./nav-model";
import { useSelect } from "./store";
import type { Notice } from "../../shared/ui";

const NOTICE_ICON: Readonly<Record<Notice["kind"], IconName>> = { job_done: "check", job_failed: "alert", job_interrupted: "alert", job_needs_user: "shield" };

export function AttentionStrip() {
  const app = useApp();
  const state = useSelect(app.client.state, (s) => s);
  const nav = useSelect(app.nav, (n) => n);
  const active = useSelect(app.host.activeChat, (c) => c);
  const now = useSelect(app.client.state, () => app.now());
  const [busy, run] = useBusy();
  const [all, setAll] = useState(false);
  const [whole, setWhole] = useState<string | null>(null);
  const { held, notices } = attentionOf(state, nav, active);
  if (held.length === 0 && notices.length === 0) return null;
  const go = (target: Target): void => app.nav.update((n) => ({ ...n, ...target }));
  const dismiss = (id: string | null): void =>
    run(async () => {
      try {
        await app.client.request("lah.notice.dismiss", { id });
      } catch (error) {
        app.fail(error);
      }
    });
  // A notice is cut to a line (two with room): it stands over every page until dismissed, and a reason that runs to five lines on a phone takes the page from what the user came for. A tap on it shows it whole; several fold to the newest until asked for.
  const folded = notices.length > 1 && !all;
  return (
    <div class="lah-attention" data-lah-attention>
      {held.map(({ approval, target }) => (
        <div key={approval.id} class="lah-attention-row lah-is-warn" role="alert">
          <Icon name="shield" size={16} />
          <span class="lah-attention-text">
            <strong>{roleLabel(approval.role)}</strong> waits for your word to call <code class="lah-mono">{approval.tool}</code>
          </span>
          <Button size="sm" variant="primary" onClick={() => go(target)}>
            Answer
          </Button>
        </div>
      ))}
      {(folded ? notices.slice(0, 1) : notices).map((notice) => (
        <div key={notice.id} class={notice.kind === "job_done" ? "lah-attention-row" : "lah-attention-row lah-is-warn"} role="status" data-lah-notice={notice.id}>
          <Icon name={NOTICE_ICON[notice.kind]} size={16} />
          <button type="button" class="lah-attention-read" aria-expanded={whole === notice.id} onClick={() => setWhole(whole === notice.id ? null : notice.id)}>
            <span class={whole === notice.id ? "lah-attention-text" : "lah-attention-text lah-is-clamped"}>
              {noticeWords(notice, { chats: state?.chats ?? [] }, active)} <span class="lah-dim">{ago(now, notice.at)}</span>
            </span>
          </button>
          <Button size="sm" onClick={() => go({ page: "jobs", job: notice.jobId, chatId: notice.chatId === active ? null : notice.chatId })}>
            Open
          </Button>
          <IconButton size="sm" icon="close" label="Dismiss this notice" disabled={busy} onClick={() => dismiss(notice.id)} />
        </div>
      ))}
      {notices.length > 1 ? (
        <div class="lah-attention-row lah-is-quiet" data-lah-notices={all ? "all" : "newest"}>
          <Button size="sm" variant="ghost" icon={all ? "chevron-up" : "chevron-down"} expanded={all} onClick={() => setAll(!all)}>
            {all ? "Show the newest only" : `Show all ${notices.length} notices`}
          </Button>
          <span class="lah-attention-text" />
          <Button size="sm" variant="ghost" busy={busy} onClick={() => dismiss(null)}>
            Dismiss all
          </Button>
        </div>
      ) : null}
    </div>
  );
}
