// The pages' icons: line drawings on a 24-unit grid, stroked in currentColor so each takes its
// colour from the text around it. Each is a few shape specs rather than markup, so nothing parses
// strings into DOM. Moved from LumiRPEngine's set, the shapes LumiAH uses, with `stop` added.

export type IconName =
  | "pulse"
  | "layers"
  | "sliders"
  | "link"
  | "search"
  | "filter"
  | "copy"
  | "download"
  | "close"
  | "check"
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
  | "chevron-down"
  | "refresh"
  | "alert"
  | "info"
  | "key"
  | "trash"
  | "undo"
  | "stop"
  | "code"
  | "message"
  | "clock"
  | "sparkle"
  | "wrench"
  | "branch"
  | "expand"
  | "shrink"
  | "edit"
  | "external"
  | "file"
  | "hourglass"
  | "user"
  | "bolt"
  | "list"
  | "plus"
  | "upload"
  | "table";

/** A path's `d`; a stroked circle; a filled dot (the only fill the set allows); a rounded rect. */
type IconShape = string | readonly ["c", number, number, number] | readonly ["dot", number, number, number] | readonly ["r", number, number, number, number, number];

const ICONS: Readonly<Record<IconName, readonly IconShape[]>> = {
  pulse: ["M3 12h4l2.5-6 5 12 2.5-6h4"],
  layers: ["M12 4l8.5 4.5L12 13 3.5 8.5Z", "M3.5 12.5L12 17l8.5-4.5", "M3.5 16.5L12 21l8.5-4.5"],
  sliders: ["M4 6h9M17 6h3", ["c", 15, 6, 2], "M4 12h3M11 12h9", ["c", 9, 12, 2], "M4 18h7M15 18h5", ["c", 13, 18, 2]],
  link: ["M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1", "M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"],
  search: [["c", 10.5, 10.5, 6.5], "M15.25 15.25L20 20"],
  filter: ["M4 5h16l-6 7.5V19l-4-2v-4.5Z"],
  copy: [["r", 8.5, 8.5, 11.5, 11.5, 2], "M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"],
  download: ["M12 4v11", "M7.5 10.5L12 15l4.5-4.5", "M4.5 19.5h15"],
  close: ["M6 6l12 12M18 6L6 18"],
  check: ["M4.5 12.5l4.75 4.75L19.5 7"],
  "chevron-left": ["M14.5 5.5L8 12l6.5 6.5"],
  "chevron-right": ["M9.5 5.5L16 12l-6.5 6.5"],
  "chevron-up": ["M5.5 14.5L12 8l6.5 6.5"],
  "chevron-down": ["M5.5 9.5L12 16l6.5-6.5"],
  refresh: ["M20 12a8 8 0 1 1-2.34-5.66", "M18.5 3v4h-4"],
  alert: ["M12 3.5L21 19.5H3Z", "M12 9.5v4.5", ["dot", 12, 16.75, 1.1]],
  info: [["c", 12, 12, 9], "M12 11v5.5", ["dot", 12, 7.75, 1.15]],
  key: [["c", 7.75, 16.25, 4.25], "M10.75 13.25L20 4", "M16.75 7.25l2.75 2.75", "M14.25 9.75l2 2"],
  trash: ["M4 6.5h16", "M9.5 6.5v-2h5v2", "M6 6.5l1 13h10l1-13", "M10 10.5v5.5M14 10.5v5.5"],
  undo: ["M8.5 14L4 9.5 8.5 5", "M4 9.5h10a5.25 5.25 0 0 1 0 10.5h-3"],
  stop: [["r", 6, 6, 12, 12, 2]],
  code: ["M8.5 7L3.5 12l5 5", "M15.5 7l5 5-5 5", "M13.5 4.5l-3 15"],
  message: ["M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4.5 3.5V17H6a2 2 0 0 1-2-2Z"],
  clock: [["c", 12, 12, 9], "M12 7.5V12l3 2"],
  sparkle: ["M11 5c.7 4.8 2.7 6.8 7.5 7.5-4.8.7-6.8 2.7-7.5 7.5-.7-4.8-2.7-6.8-7.5-7.5C8.3 11.8 10.3 9.8 11 5Z", "M18.5 2.5v4M16.5 4.5h4"],
  wrench: ["M13.22 13.04L7.54 18.72A1.6 1.6 0 0 1 5.28 16.46L10.96 10.78A4.75 4.75 0 0 1 17.38 4.5L14.72 7.16A1.5 1.5 0 0 0 16.84 9.28L19.5 6.62A4.75 4.75 0 0 1 13.22 13.04Z"],
  branch: [["c", 6.5, 5.5, 2], ["c", 6.5, 18.5, 2], ["c", 17.5, 8.5, 2], "M6.5 7.5v9", "M17.5 10.5a4.5 4.5 0 0 1-4.5 4.5H6.5"],
  expand: ["M14 4h6v6M10 20H4v-6", "M20 4l-6.5 6.5M4 20l6.5-6.5"],
  shrink: ["M14 4v6h6M10 20v-6H4", "M14 10l6-6M10 14l-6 6"],
  edit: ["M15 4.5l4.5 4.5L9 19.5H4.5V15Z", "M12.5 7l4.5 4.5"],
  external: ["M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5", "M14 4h6v6", "M20 4l-9 9"],
  file: ["M7 3.5h6.5l4.5 4.5v10.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z", "M13.5 3.5V8H18"],
  hourglass: ["M6.5 3.5h11M6.5 20.5h11", "M7.5 3.5c0 4 4.5 5.5 4.5 8.5s-4.5 4.5-4.5 8.5", "M16.5 3.5c0 4-4.5 5.5-4.5 8.5s4.5 4.5 4.5 8.5"],
  user: [["c", 12, 8, 3.75], "M4.5 20c0-4 3.4-6.75 7.5-6.75s7.5 2.75 7.5 6.75"],
  bolt: ["M13.5 3L5 13.5h6.5L10.5 21 19 10.5h-6.5Z"],
  list: ["M9 6.5h11M9 12h11M9 17.5h11", ["dot", 4.75, 6.5, 1.15], ["dot", 4.75, 12, 1.15], ["dot", 4.75, 17.5, 1.15]],
  plus: ["M12 5v14M5 12h14"],
  upload: ["M12 15V4", "M7.5 8.5L12 4l4.5 4.5", "M4.5 19.5h15"],
  table: [["r", 3.5, 4.5, 17, 15, 2], "M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"],
};

function shape(spec: IconShape, key: number) {
  if (typeof spec === "string") return <path key={key} d={spec} />;
  switch (spec[0]) {
    case "c":
      return <circle key={key} cx={spec[1]} cy={spec[2]} r={spec[3]} />;
    case "dot":
      return <circle key={key} cx={spec[1]} cy={spec[2]} r={spec[3]} fill="currentColor" stroke="none" />;
    case "r":
      return <rect key={key} x={spec[1]} y={spec[2]} width={spec[3]} height={spec[4]} rx={spec[5]} />;
  }
}

export function Icon(props: { name: IconName; size?: number; label?: string; class?: string }) {
  const size = props.size ?? 20;
  return (
    <svg
      class={props.class ? `lah-icon ${props.class}` : "lah-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      focusable="false"
      aria-hidden={props.label ? undefined : "true"}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
    >
      {ICONS[props.name].map(shape)}
    </svg>
  );
}

/** The drawer tab's icon, as markup for `registerDrawerTab`: the pulse of an agent at work in a ring. */
export const TAB_ICON_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.5 12h2.8l1.9-4.2 3.6 8.4 1.9-4.2h2.8"/></svg>`;
