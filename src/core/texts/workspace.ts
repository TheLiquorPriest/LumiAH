// The workspace's texts (DESIGN §11): its tools' descriptions and everything they answer.
//
// A path's own marks (`/`, `learned/`, `~/`, `..`) and the word `new` for a file that isn't there yet
// are what the tools read, so a text that names them names them as the tools take them.

import { CURSOR_ARG, GROUP, SETTING_VAR, type TextDef, TOOL, toolTexts, v, word } from "../text-def";

export const WORKSPACE_TEXT = {
  areaChat: "workspace.area.chat",
  areaLearned: "workspace.area.learned",
  areaUser: "workspace.area.user",
  noArea: "workspace.no_area",
  pathBad: "workspace.path.bad",
  pathOutside: "workspace.path.outside",
  pathLong: "workspace.path.long",
  listLead: "workspace.list.lead",
  listFolder: "workspace.list.folder",
  listFile: "workspace.list.file",
  listPinned: "workspace.list.pinned",
  listEmpty: "workspace.list.empty",
  listIsFile: "workspace.list.is_file",
  listNothing: "workspace.list.nothing",
  readPage: "workspace.read.page",
  readGone: "workspace.read.gone",
  grepLine: "workspace.grep.line",
  grepNothing: "workspace.grep.nothing",
  wrote: "workspace.wrote",
  unchanged: "workspace.unchanged",
  edited: "workspace.edited",
  moved: "workspace.moved",
  deleted: "workspace.deleted",
  pinned: "workspace.pinned",
  unpinned: "workspace.unpinned",
  pinUser: "workspace.pin.user",
  noFile: "workspace.no_file",
  noFileToWrite: "workspace.write.no_file",
  isFolder: "workspace.is_folder",
  exists: "workspace.exists",
  stale: "workspace.stale",
  fileChars: "workspace.limit.file_chars",
  files: "workspace.limit.files",
  areaChars: "workspace.limit.area_chars",
  editNotFound: "workspace.edit.not_found",
  editSeveral: "workspace.edit.several",
  moveAcross: "workspace.move.across",
  wordFile: "word.file",
  wordListed: "word.folder_or_file",
  wordMatch: "word.match",
} as const;

const ANSWERS = GROUP.answers;

/** What the tools that take one file say of its path. */
const FILE_ARG = "The file's path, as workspace_list writes it: /notes/plan.md in this chat's own area, learned/… kept with the chat, ~/… the user's own.";

/** What the tools that change a file there is say of the version they take. */
const BASE_ARG = "The file's version as you last read it, from workspace_read or workspace_list.";

const area = (id: string, label: string, text: string): TextDef => ({ id, group: ANSWERS, label: `An area: ${label}`, note: "Names an area where an answer says which areas a run's workspace has.", text, vars: [v("root", "how the area's paths start", true)] });

export const WORKSPACE_TEXTS: TextDef[] = [
  ...toolTexts(
    TOOL.workspaceList,
    "List the workspace: the text files you and the other agents keep, for yourselves and for each other. It has three areas, told apart by how a path starts. / is this chat's own, and follows the story: when the user swipes, regenerates or edits the chat, its files go back to how they stood at that point. learned/ is kept with the chat whatever path the story takes. ~/ is the user's own, shared by all their chats. This lists what is directly in a folder: its folders, each with how many files it holds, and its files, each with its length, its version and whether it is pinned for you. Without a path it lists /.",
    { path: "The folder to list: /, learned/, ~/, or a folder under one of them, such as /notes/. Leave it out to list /.", cursor: CURSOR_ARG },
  ),
  ...toolTexts(TOOL.workspaceRead, "Read a workspace file, a page at a time. The answer gives the file's version: every change to a file names the version it was based on, so keep it for the change you make next.", { path: FILE_ARG, cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.workspaceGrep, "Find every line of the workspace's files that holds some exact text, in any letter case, each with its file and line number. Without a path it searches / and learned/; give ~/ to search the user's own files, or a folder or one file to search that alone.", {
    text: "The text to find, as written; letter case doesn't matter.",
    path: "Where to search: a folder (/notes/, learned/, ~/) or one file. Leave it out to search / and learned/.",
    cursor: CURSOR_ARG,
  }),
  ...toolTexts(
    TOOL.workspaceWrite,
    "Write a workspace file whole: a new file, or the next version of one there is. Every change names the version it was based on: base is new for a file that isn't there yet, else the version workspace_read or workspace_list gave you. If the file has changed since, nothing is written and you are told its version now: read it again and make your change on that. The area decides how the file lives: / follows the story as swipes and edits do, learned/ stays with the chat whatever path the story takes, ~/ is the user's own, shared by all their chats. For a small change to a long file, workspace_edit is cheaper.",
    {
      path: "The file's path: /notes/plan.md in this chat's own area, learned/… to keep it with the chat, ~/… for the user's own. Its folders need no making.",
      content: "The file's whole text, as it is to stand.",
      base: "new for a file that isn't there yet; else the version this text is based on, as workspace_read and workspace_list give it.",
    },
  ),
  ...toolTexts(TOOL.workspaceEdit, "Change part of a workspace file: one exact match of find is replaced by replace. find must be in the file once: give more of the text around it until it is, or pass all to replace every match. Like every change it names the version it was based on, as workspace_read gave it.", {
    path: FILE_ARG,
    find: "The text to replace, exactly as the file holds it: every space and line break counts.",
    replace: "What takes its place. Empty takes the text out.",
    base: BASE_ARG,
    all: "true to replace every match of find. Left out, find must match once.",
  }),
  ...toolTexts(TOOL.workspaceMove, "Move or rename a workspace file within its area; its history and its pins go with it. Like every change it names the version it was based on. To take a file to another area, write it there and delete it here.", {
    from: "The file's path now.",
    to: "Its new path, in the same area. No file may be there yet.",
    base: BASE_ARG,
  }),
  ...toolTexts(TOOL.workspaceDelete, "Delete a workspace file. Like every change it names the version it was based on, so a file someone changed since you read it isn't deleted unseen.", { path: FILE_ARG, base: BASE_ARG }),
  ...toolTexts(
    TOOL.workspacePin,
    "Pin a workspace file, or lift its pin. A pinned file leads what you are sent each turn, as it stands then: pin what you need every time, such as a running summary or the facts to keep straight, and keep it short. Pinned files share a size limit, and one past it is only named. You pin in / and learned/; a pin in ~/ reaches every chat of the user's, so it is theirs to set unless their settings let you.",
    { path: FILE_ARG, pinned: "true to pin the file, false to lift its pin." },
  ),
  area(WORKSPACE_TEXT.areaChat, "the chat's own", "{{root}} (this chat's own files)"),
  area(WORKSPACE_TEXT.areaLearned, "kept with the chat", "{{root}} (kept with the chat)"),
  area(WORKSPACE_TEXT.areaUser, "the user's own", "{{root}} (the user's own files)"),
  { id: WORKSPACE_TEXT.noArea, group: ANSWERS, label: "An area this run doesn't have", note: "A workspace tool's answer to a path in an area the run has none of: a side session about no chat has the user's files alone.", text: "Your workspace has no {{area}} here. It has: {{areas}}. Give a path in one of those.", vars: [v("area", "the area asked for, by how its paths start"), v("areas", "the areas there are, each as the three texts above name it", true)] },
  { id: WORKSPACE_TEXT.pathBad, group: ANSWERS, label: "A path that can't be one", note: "A workspace tool's answer to a path that holds a backslash or a control character.", text: "That path can't be used: a path holds no backslash and no control character. Put / between its folders, as in /notes/plan.md.", vars: [] },
  { id: WORKSPACE_TEXT.pathOutside, group: ANSWERS, label: "A path that leaves its area", note: "A workspace tool's answer to a path that climbs out of its area.", text: "That path climbs out of its area: .. may go up inside an area, never above it. Say which area by how the path starts: / for this chat's own, learned/, or ~/ for the user's.", vars: [] },
  { id: WORKSPACE_TEXT.pathLong, group: ANSWERS, label: "A path too long", note: "A workspace tool's answer to a path past Path length.", text: "That path is too long: within its area {{setting}} lets a path hold {{limit}} characters at most. Use shorter names or fewer folders.", vars: [v("limit", "Path length", true), SETTING_VAR], setting: ["workspace", "pathChars"] },
  { id: WORKSPACE_TEXT.listLead, group: ANSWERS, label: "workspace_list: the chat's area", note: "Leads workspace_list's answer when it lists the chat's own area from the top.", text: "This is /, the chat's own area. ~/ is the user's own area, shared by all their chats: list it with path ~/.", vars: [] },
  { id: WORKSPACE_TEXT.listFolder, group: ANSWERS, label: "workspace_list: a folder", note: "One folder in workspace_list's answer.", text: "- {{path}} (folder, {{files}})", vars: [v("path", "the folder's path, closed with a slash", true), v("files", 'how many files it holds, at any depth, with the word: "3 files"')] },
  { id: WORKSPACE_TEXT.listFile, group: ANSWERS, label: "workspace_list: a file", note: "One file in workspace_list's answer.", text: "- {{path}} ({{chars}} characters, version {{version}}{{pinned}})", vars: [v("path", "the file's path", true), v("chars", "its length"), v("version", "its version, which a change to it names as base"), v("pinned", "that it is pinned for the agent that asks, in the words below; nothing when it isn't")] },
  { id: WORKSPACE_TEXT.listPinned, group: ANSWERS, label: "workspace_list: a pinned file", note: "Marks a file that is pinned for the agent that asks, in workspace_list's answers.", text: ", pinned for you", vars: [] },
  { id: WORKSPACE_TEXT.listEmpty, group: ANSWERS, label: "workspace_list: an empty area", note: "workspace_list's answer for an area that holds no file.", text: "{{path}} holds no files yet.", vars: [v("path", "how the area's paths start", true)] },
  { id: WORKSPACE_TEXT.listIsFile, group: ANSWERS, label: "workspace_list: a file, not a folder", note: "workspace_list's answer to a path that names a file.", text: "{{path}} is a file, not a folder: {{chars}} characters, version {{version}}{{pinned}}. workspace_read reads it.", vars: [v("path", "the file's path", true), v("chars", "its length"), v("version", "its version"), v("pinned", "that it is pinned for the agent that asks; nothing when it isn't")] },
  { id: WORKSPACE_TEXT.listNothing, group: ANSWERS, label: "workspace_list: nothing there", note: "workspace_list's answer to a path that names no file and no folder that holds one.", text: "There is nothing at {{path}}: no file, and no folder that holds one. workspace_list without a path lists the workspace from the top.", vars: [v("path", "the path asked for", true)] },
  {
    id: WORKSPACE_TEXT.readPage,
    group: ANSWERS,
    label: "workspace_read: its answer",
    note: "workspace_read's answer: a file, or the part of it a page holds, under its path, its length and its version.",
    text: "[{{path}}: characters {{from}} to {{to}} of {{total}}, version {{version}}. A write, an edit, a move or a delete of this file takes that version as base.]\n{{text}}",
    vars: [v("path", "the file's path"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("total", "the file's length"), v("version", "its version, which a change to it names as base", true), v("text", "the text", true)],
  },
  { id: WORKSPACE_TEXT.readGone, group: ANSWERS, label: "workspace_read: a text that is gone", note: "A workspace tool's answer when the store no longer has a file's text.", text: "The text of {{path}} (version {{version}}) is no longer in the store, so it can't be read. If you know what it held, write it again with workspace_write and base {{version}}; else say in your answer that it is lost.", vars: [v("path", "the file's path", true), v("version", "its version")] },
  { id: WORKSPACE_TEXT.grepLine, group: ANSWERS, label: "workspace_grep: a line", note: "One line workspace_grep found.", text: "- {{path}}, line {{line}}: {{text}}", vars: [v("path", "the file's path", true), v("line", "the line's number in the file"), v("text", "the line, around what was found", true)] },
  { id: WORKSPACE_TEXT.grepNothing, group: ANSWERS, label: "workspace_grep: nothing found", note: "workspace_grep's answer when no line holds the text: where it looked, and what to try next.", text: "No line holds “{{query}}” in {{where}} ({{files}} searched). Try a shorter piece of it, or look elsewhere: without a path the search covers / and learned/, and path ~/ searches the user's own files.", vars: [v("query", "what was looked for", true), v("where", "where it looked"), v("files", 'how many files it read, with the word: "12 files"')] },
  { id: WORKSPACE_TEXT.wrote, group: ANSWERS, label: "workspace_write: written", note: "workspace_write's answer once the file is written.", text: "Wrote {{path}}: {{chars}} characters, now at version {{version}}. Your next change to it takes that version as base.", vars: [v("path", "the file's path", true), v("chars", "its length"), v("version", "its new version", true)] },
  { id: WORKSPACE_TEXT.unchanged, group: ANSWERS, label: "A write that changes nothing", note: "The answer of workspace_write and workspace_edit when the file already holds the text they would give it: no version is made.", text: "{{path}} already holds exactly this text, so nothing changed. It is at version {{version}}.", vars: [v("path", "the file's path", true), v("version", "its version", true)] },
  { id: WORKSPACE_TEXT.edited, group: ANSWERS, label: "workspace_edit: edited", note: "workspace_edit's answer once the file is changed.", text: "Edited {{path}}: {{count}} replaced. It holds {{chars}} characters now, at version {{version}}. Your next change to it takes that version as base.", vars: [v("path", "the file's path", true), v("count", 'how many matches were replaced, with the word: "1 match"'), v("chars", "its length now"), v("version", "its new version", true)] },
  { id: WORKSPACE_TEXT.moved, group: ANSWERS, label: "workspace_move: moved", note: "workspace_move's answer once the file is moved.", text: "Moved {{from}} to {{to}}. Its text is the same, so its version is still {{version}}.", vars: [v("from", "the path it had"), v("to", "its path now", true), v("version", "its version")] },
  { id: WORKSPACE_TEXT.deleted, group: ANSWERS, label: "workspace_delete: deleted", note: "workspace_delete's answer once the file is gone.", text: "Deleted {{path}}. It was at version {{version}}.", vars: [v("path", "the path it had", true), v("version", "the version that went")] },
  { id: WORKSPACE_TEXT.pinned, group: ANSWERS, label: "workspace_pin: pinned", note: "workspace_pin's answer once the file is pinned: how much the agent's pinned files hold now, against Pinned files in context.", text: "Pinned {{path}}: it leads what you are sent each turn, as it stands then. Your pinned files hold {{chars}} characters together now; up to {{limit}} are given in full (Pinned files in context), and a file past that is only named.", vars: [v("path", "the file's path", true), v("chars", "the length of the agent's pinned files together"), v("limit", "Pinned files in context")] },
  { id: WORKSPACE_TEXT.unpinned, group: ANSWERS, label: "workspace_pin: pin lifted", note: "workspace_pin's answer once the file's pin is lifted.", text: "Lifted the pin on {{path}}: it no longer leads what you are sent. workspace_read still reads it.", vars: [v("path", "the file's path", true)] },
  {
    id: WORKSPACE_TEXT.pinUser,
    group: ANSWERS,
    label: "workspace_pin: a pin in the user's area",
    note: "workspace_pin's answer to a file in ~/ while Agents may pin your own files is off: a pin there reaches every chat, so it is the user's to set and to lift.",
    text: "Nothing was changed: {{path}} is in ~/, the user's own area, and a pin there leads what you are sent in every chat of theirs, so pins there are the user's to set and to lift, on the Workspace page (Agents may pin your own files). To have this text each turn in this chat, keep it in a file in / or learned/ and pin that.",
    vars: [v("path", "the file's path", true)],
  },
  { id: WORKSPACE_TEXT.noFile, group: ANSWERS, label: "No such file", note: "A workspace tool's answer to a path that names no file.", text: "There's no file {{path}}. workspace_list shows the files there are.", vars: [v("path", "the path asked for", true)] },
  { id: WORKSPACE_TEXT.noFileToWrite, group: ANSWERS, label: "workspace_write: no file to base it on", note: "workspace_write's answer to a base given for a file that isn't there.", text: "Nothing was written: there's no file {{path}}, so there is no version to base it on. To make the file, call workspace_write again with base new. workspace_list shows the files there are.", vars: [v("path", "the path asked for", true)] },
  { id: WORKSPACE_TEXT.isFolder, group: ANSWERS, label: "A folder where a file is needed", note: "A workspace tool's answer to a path that names a folder where it takes one file.", text: "{{path}} is a folder, and this takes one file. workspace_list with that path lists the files in it.", vars: [v("path", "the folder's path", true)] },
  { id: WORKSPACE_TEXT.exists, group: ANSWERS, label: "A file already there", note: "The answer to a write that said the file was new, or a move to a path, where there is a file already.", text: "Nothing was changed: there is already a file {{path}}, at version {{version}}. To replace its text, read it with workspace_read and write with that version as base; else choose another path.", vars: [v("path", "the file's path", true), v("version", "the version it has", true)] },
  { id: WORKSPACE_TEXT.stale, group: ANSWERS, label: "A change based on another version", note: "The answer to a write, an edit, a move or a delete whose base isn't the version the file has now.", text: "Nothing was changed: {{path}} is at version {{version}} now, and that isn't the version you gave as base: it was changed since you read it, or the base was miscopied. Read it again with workspace_read and make your change on what it holds now.", vars: [v("path", "the file's path", true), v("version", "the version it has now", true)] },
  { id: WORKSPACE_TEXT.fileChars, group: ANSWERS, label: "A file too long", note: "The answer to a write or an edit that would take a file past File length.", text: "Nothing was changed: the file would hold {{chars}} characters, and {{setting}} lets a file hold {{limit}} at most. Split it over several files.", vars: [v("chars", "the length it would have"), v("limit", "File length", true), SETTING_VAR], setting: ["workspace", "fileChars"] },
  { id: WORKSPACE_TEXT.files, group: ANSWERS, label: "Too many files", note: "The answer to a write of a new file into an area that holds as many as Files per area allows.", text: "Nothing was changed: this area already holds the {{limit}} {{setting}} allows. Delete files nobody needs any more, or add to one there is.", vars: [v("limit", 'Files per area, with the word: "400 files"', true), SETTING_VAR], setting: ["workspace", "files"] },
  { id: WORKSPACE_TEXT.areaChars, group: ANSWERS, label: "An area too big", note: "The answer to a write or an edit that would take an area's files past Area size.", text: "Nothing was changed: with it this area's files would hold {{chars}} characters together, and {{setting}} lets an area hold {{limit}} at most. Delete or shorten files nobody needs any more first.", vars: [v("chars", "the length the area's files would have together"), v("limit", "Area size", true), SETTING_VAR], setting: ["workspace", "areaChars"] },
  { id: WORKSPACE_TEXT.editNotFound, group: ANSWERS, label: "workspace_edit: nothing to replace", note: "workspace_edit's answer when the file doesn't hold the text to replace.", text: "Nothing was changed: {{path}} (version {{version}}) doesn't hold that text, character for character. Read the file again with workspace_read and copy the text to replace from what it gives.", vars: [v("path", "the file's path", true), v("version", "its version")] },
  { id: WORKSPACE_TEXT.editSeveral, group: ANSWERS, label: "workspace_edit: several matches", note: "workspace_edit's answer when the text to replace is in the file more than once and all wasn't asked for.", text: "Nothing was changed: that text is in {{path}} {{count}}. Give more of the text around the one you mean, until find matches once, or pass all: true to replace every one.", vars: [v("path", "the file's path", true), v("count", 'how many times, with the word: "3 times"', true)] },
  { id: WORKSPACE_TEXT.moveAcross, group: ANSWERS, label: "workspace_move: across areas", note: "workspace_move's answer to a move from one area to another.", text: "Nothing was moved: a move stays inside one area, and {{from}} and {{to}} are in two. To take the file across, read it, write it there with workspace_write and base new, then delete it here with workspace_delete.", vars: [v("from", "the path it has"), v("to", "the path asked for")] },
  word(WORKSPACE_TEXT.wordFile, "file", "files"),
  word(WORKSPACE_TEXT.wordListed, "folder or file", "folders and files"),
  word(WORKSPACE_TEXT.wordMatch, "match", "matches"),
];
