// The Workspace page (DESIGN §11): the agents' files, which the user reads and edits like any of
// them. The three areas are a choice at the top, each with how full it is; the area chosen lists
// its files as a tree by folder; beside the list (in its place on a phone, with Back) is what is
// open: a file, a reply's change set, what is pinned, or the form that makes a file. Which file and
// which change set are open is in nav, so Live and Sessions lead here; where the page itself is
// (the area, the filter, the folders folded) is kept while another page shows (workspace-drafts.ts).

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { WorkspaceArea, WorkspaceView } from "../../../shared/ui";
import { errorWords, type FileTarget, useApp } from "../app";
import { ChatBar, useShownChat } from "../chat";
import { Badge, Banner, Button, Empty, IconButton, SearchField } from "../components";
import { count, counted } from "../format";
import { Icon } from "../icons";
import { revealInScroller } from "../scroll";
import { openSetting } from "../setting-links";
import { useSelect } from "../store";
import { draftsOf, keptOf } from "../workspace-drafts";
import { AREA_WORDS, AREAS, type AreaRead, areaBounds, areaRowWords, areaSummary, basisWords, draftKey, draftsElsewhere, fileFacts, filterTerms, followNav, isDirty, newDraftKey, pinMark, pinnedCount, treeOf, treeRows, waitingWords, type WorkspaceKept, type WorkspacePane } from "../workspace-model";
import { FilePane } from "./workspace-file";
import { ChangesPane, NewFilePane, PinsPane } from "./workspace-panes";
import { BoundLine } from "./workspace-parts";

type Reads = Readonly<Record<WorkspaceArea, AreaRead>>;

const READING: AreaRead = { status: "reading" };
const NO_CHAT: AreaRead = { status: "no-chat" };

/** What an empty area says would be there, and how it comes to be. */
const EMPTY_WORDS: Readonly<Record<WorkspaceArea, string>> = {
  chat: "Agents keep their notes on this chat's story here as they work. Press New file to make one yourself.",
  learned: "What an agent learns about this chat for good is kept here, and so is the chat's guidance. Press New file to make one yourself.",
  user: "Files here are shared by all your chats: your guidance, and whatever you want every agent to find. Press New file to make one.",
};

export function WorkspacePage() {
  const app = useApp();
  const chatId = useShownChat();
  const navFile = useSelect(app.nav, (n) => n.file);
  const navChanges = useSelect(app.nav, (n) => n.changes);
  const held = useSelect(keptOf(app), (k) => k);
  const drafts = useSelect(draftsOf(app), (d) => d);
  const [reads, setReads] = useState<Reads>({ chat: READING, learned: READING, user: READING });
  /** The read of each area that counts: a slower answer to an earlier one, or to another chat's, is dropped. */
  const asked = useRef<Record<WorkspaceArea, number>>({ chat: 0, learned: 0, user: 0 });
  const detailEl = useRef<HTMLDivElement>(null);
  const now = app.now();

  // Nav says which file and which change set are open; the page follows it, and puts back what no longer belongs to the chat shown.
  const followed = followNav(held, { file: navFile, changes: navChanges }, chatId);
  const { kept, file, changes } = followed;
  useLayoutEffect(() => {
    if (kept !== held) keptOf(app).set(kept);
    if (file !== navFile || changes !== navChanges) app.nav.update((n) => ({ ...n, file, changes }));
  });

  const readArea = (area: WorkspaceArea): void => {
    asked.current[area] += 1;
    const mine = asked.current[area];
    if (area !== "user" && chatId === null) return;
    app.client.request("lah.ws.list", { chatId, area }).then(
      (view) => mine === asked.current[area] && setReads((r) => ({ ...r, [area]: { status: "ready", view } })),
      (error: unknown) => {
        if (mine !== asked.current[area]) return;
        // What the page holds of the area still shows when reading it again fails; the failure is said beside it.
        setReads((r) => {
          if (r[area].status === "ready") return r;
          return { ...r, [area]: { status: "failed", message: errorWords(error) } };
        });
        app.fail(error);
      },
    );
  };
  const readAll = (): void => AREAS.forEach(readArea);
  useEffect(() => {
    // Another chat's files are not this one's: none of them shows while this one's are read. The user's own are the same in every chat.
    setReads((r) => ({ chat: chatId === null ? NO_CHAT : READING, learned: chatId === null ? NO_CHAT : READING, user: r.user.status === "ready" ? r.user : READING }));
    readAll();
    return app.client.onBack(readAll);
  }, [chatId]);

  const { area } = kept;
  const read = reads[area];
  const view = read.status === "ready" ? read.view : null;
  const views = AREAS.flatMap((a): WorkspaceView[] => {
    const r = reads[a];
    return r.status === "ready" ? [r.view] : [];
  });
  const chatView = reads.chat.status === "ready" ? reads.chat.view : null;
  /** The pane as it can show: a file or a change set only while nav names one. */
  const pane: WorkspacePane = (kept.pane === "file" && file === null) || (kept.pane === "changes" && changes === null) ? "none" : kept.pane;
  const shownKey = pane === "file" && file !== null ? `file:${file.area}:${file.path}` : pane;
  // What opens starts at its head: the panel may be scrolled far down the list.
  useLayoutEffect(() => {
    if (pane !== "none") revealInScroller(detailEl.current, "start");
  }, [shownKey]);

  const change = (next: Partial<Pick<WorkspaceKept, "area" | "pane" | "filter" | "folded">>): void => keptOf(app).update((k) => ({ ...k, ...next }));
  const openFile = (target: FileTarget): void => app.nav.update((n) => ({ ...n, file: target }));
  /** Pins and the new file's form close onto what was open under them. */
  const closePane = (): void => change({ pane: file !== null ? "file" : changes !== null ? "changes" : "none" });
  const toggleFolder = (path: string): void => {
    const key = `${area}:${path}`;
    change({ folded: new Set(kept.folded.has(key) ? [...kept.folded].filter((k) => k !== key) : [...kept.folded, key]) });
  };

  const filtering = filterTerms(kept.filter).length > 0;
  const tree = view ? treeOf(view.files, kept.filter) : [];
  const found = tree.reduce((n, node) => n + (node.kind === "folder" ? node.files : 1), 0);
  const folded = new Set([...kept.folded].flatMap((k) => (k.startsWith(`${area}:`) ? [k.slice(area.length + 1)] : [])));
  const rows = treeRows(tree, folded, filtering);
  const bounds = view ? areaBounds(view) : null;
  const newDraft = drafts.get(newDraftKey(chatId, area));
  const waiting = waitingWords(draftsElsewhere(drafts, chatId));

  return (
    <div class="lah-split" data-lah-view="workspace" data-pane={pane === "none" ? "list" : "detail"}>
      <div class="lah-split-list">
        <ChatBar aside={<IconButton icon="refresh" label="Read the files again" onClick={readAll} />} />
        {chatId === null ? (
          <Banner tone="info" title="No chat is open">
            Only your own area shows: it is the same in every chat. The other two belong to a chat: open one in Lumiverse, or pick one above.
          </Banner>
        ) : null}
        {waiting !== null ? (
          <p class="lah-line" data-lah-waiting>
            <Icon name="info" size={14} />
            <span>{waiting}</span>
          </p>
        ) : null}
        <div class="lah-navlist lah-ws-areas" role="group" aria-label="The workspace's areas">
          {AREAS.map((a) => (
            <button key={a} type="button" class="lah-navrow" data-lah-area={a} aria-pressed={a === area} disabled={reads[a].status === "no-chat"} onClick={() => change({ area: a })}>
              <span class="lah-ws-sign">{AREA_WORDS[a].sign}</span>
              <span class="lah-navrow-text">
                <span class="lah-navrow-title">{AREA_WORDS[a].name}</span>
                <span class="lah-navrow-sub">{areaRowWords(a, reads[a])}</span>
              </span>
            </button>
          ))}
        </div>
        <section class="lah-ws-about" data-lah-area-about={area}>
          <p class="lah-lead lah-small">{`${AREA_WORDS[area].about}${area === "chat" && view ? ` ${basisWords(view.basis)}` : ""}`}</p>
          {/* How full the area is, in words; a limit that is passed is said again under it, where its bar shows by how much. */}
          {view ? (
            <p class="lah-small lah-muted lah-num" data-lah-area-room>
              {areaSummary(view)}
            </p>
          ) : null}
          {bounds && bounds.files.over > 0 ? <BoundLine label="Files" bound={bounds.files} /> : null}
          {bounds && bounds.chars.over > 0 ? <BoundLine label="Characters" bound={bounds.chars} /> : null}
          <div class="lah-actions">
            <Button icon="plus" pressed={pane === "new"} onClick={() => change({ pane: "new" })}>
              {newDraft && isDirty(newDraft) ? "Go on with the new file" : "New file"}
            </Button>
            <Button icon="pin" pressed={pane === "pins"} label="Show the files each agent is always given" onClick={() => change({ pane: "pins" })}>
              {`Always given (${count(pinnedCount(views))})`}
            </Button>
            {changes !== null && pane !== "changes" ? (
              <Button icon="compare" onClick={() => change({ pane: "changes" })}>
                The reply's changes
              </Button>
            ) : null}
            <Button icon="sliders" label="Open the workspace's limits in Settings" onClick={() => openSetting(app, "workspaceLimits")}>
              Limits
            </Button>
          </div>
        </section>
        {read.status === "failed" ? (
          <Empty
            icon="alert"
            title="This area couldn't be read"
            action={
              <Button icon="refresh" onClick={() => readArea(area)}>
                Try again
              </Button>
            }
          >
            {read.message}
          </Empty>
        ) : view === null ? (
          <Empty icon="hourglass">Reading the files…</Empty>
        ) : view.files.length === 0 ? (
          <Empty icon="folder" title="No file here yet">
            {EMPTY_WORDS[area]}
          </Empty>
        ) : (
          <>
            <SearchField label="Narrow the files by path" placeholder="Narrow by path" value={kept.filter} status={filtering ? `${count(found)} of ${counted(view.files.length, "file")}` : undefined} onInput={(filter) => change({ filter })} />
            {filtering ? <p class="lah-small lah-muted" data-lah-found>{`${count(found)} of ${counted(view.files.length, "file")} have every word of that in their path.`}</p> : null}
            {rows.length === 0 ? (
              <Empty
                icon="search"
                title="No file's path holds that"
                action={
                  <Button icon="close" onClick={() => change({ filter: "" })}>
                    Show every file
                  </Button>
                }
              >
                The words are looked for in each file's path, not in its text.
              </Empty>
            ) : (
              <nav class="lah-navlist lah-ws-tree" aria-label={`The files of the area ${AREA_WORDS[area].sign}`}>
                {rows.map((row) => {
                  const depth = `--lah-ws-depth:${row.node.depth}`;
                  if (row.kind === "folder") {
                    const facts = `${counted(row.node.files, "file")} · ${counted(row.node.chars, "character")}`;
                    // While a filter narrows the tree every folder shows open, so there is nothing for a press to do.
                    return filtering ? (
                      <div key={`d:${row.node.path}`} class="lah-navrow" data-kind="folder" style={depth}>
                        <Icon name="folder" size={16} />
                        <span class="lah-navrow-text">
                          <span class="lah-navrow-title lah-ws-path">{`${row.node.name}/`}</span>
                          <span class="lah-navrow-sub lah-num">{facts}</span>
                        </span>
                      </div>
                    ) : (
                      <button key={`d:${row.node.path}`} type="button" class="lah-navrow" data-kind="folder" data-lah-folder={row.node.path} style={depth} aria-expanded={row.open} onClick={() => toggleFolder(row.node.path)}>
                        <Icon name={row.open ? "chevron-down" : "chevron-right"} size={16} />
                        <span class="lah-navrow-text">
                          <span class="lah-navrow-title lah-ws-path">{`${row.node.name}/`}</span>
                          <span class="lah-navrow-sub lah-num">{facts}</span>
                        </span>
                      </button>
                    );
                  }
                  const { path } = row.node;
                  const mark = pinMark(row.node.file);
                  const draft = drafts.get(draftKey(chatId, area, path));
                  const unsaved = draft !== undefined && isDirty(draft);
                  return (
                    <button key={`f:${path}`} type="button" class="lah-navrow" data-kind="file" data-lah-file-row={path} style={depth} aria-current={pane === "file" && file !== null && file.area === area && file.path === path ? "true" : undefined} onClick={() => openFile({ area, path, hash: null })}>
                      <Icon name="file" size={16} />
                      <span class="lah-navrow-text">
                        <span class="lah-navrow-title lah-ws-path">{row.node.name}</span>
                        <span class="lah-navrow-sub lah-num">{fileFacts(row.node.file, now)}</span>
                      </span>
                      {mark !== null || unsaved ? (
                        <span class="lah-ws-marks">
                          {mark !== null ? <Badge tone="accent">{mark}</Badge> : null}
                          {unsaved ? <Badge tone="warn">not saved</Badge> : null}
                        </span>
                      ) : null}
                      <Icon name="chevron-right" size={16} class="lah-chev" />
                    </button>
                  );
                })}
              </nav>
            )}
          </>
        )}
      </div>
      <div class="lah-split-detail" ref={detailEl}>
        {pane === "file" && file !== null ? (
          <FilePane key={`${chatId ?? ""}|${file.area}|${file.path}`} chatId={chatId} target={file} view={views.find((v) => v.area === file.area) ?? null} fromChanges={changes !== null} onClose={() => app.nav.update((n) => ({ ...n, file: null }))} onChanged={() => readArea(file.area)} />
        ) : pane === "changes" && changes !== null ? (
          <ChangesPane key={`${chatId ?? ""}|${changes.messageId}|${changes.swipe}`} chatId={chatId} target={changes} basis={chatView?.basis ?? null} onClose={() => app.nav.update((n) => ({ ...n, changes: null }))} onOpen={openFile} />
        ) : pane === "pins" ? (
          <PinsPane chatId={chatId} views={views} onClose={closePane} onOpen={openFile} onChanged={readArea} />
        ) : pane === "new" ? (
          <NewFilePane
            key={`${chatId ?? ""}|${area}`}
            chatId={chatId}
            area={area}
            view={view}
            onClose={closePane}
            onMade={(path) => {
              readArea(area);
              openFile({ area, path, hash: null });
            }}
          />
        ) : (
          <Empty icon="file" title="Pick a file">
            Its text shows here, with its history, which agents are always given it, and the ways to edit, move and delete it. These are the files agents keep for themselves and for each other; what you write here is a version like any of theirs.
          </Empty>
        )}
      </div>
    </div>
  );
}
