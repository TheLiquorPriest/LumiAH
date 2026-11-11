// An agent's words drawn as prose (prose-model.ts reads them): a report, an answer, a brief. One
// component for every page, so a heading or a list an agent wrote looks the same wherever it shows.

import { type Block, type Inline, proseOf } from "./prose-model";

function Words(props: { inline: readonly Inline[] }) {
  return (
    <>
      {props.inline.map((piece, i) =>
        "text" in piece ? <span key={i}>{piece.text}</span> : "strong" in piece ? <strong key={i}>{piece.strong}</strong> : "em" in piece ? <em key={i}>{piece.em}</em> : <code key={i} class="lah-mono">{piece.code}</code>,
      )}
    </>
  );
}

function BlockOf(props: { block: Block }) {
  const { block } = props;
  switch (block.kind) {
    case "heading":
      // A heading in an agent's text is a heading within the card it shows in, never one of the page's own.
      return (
        <p class="lah-prose-h" role="heading" aria-level={Math.min(6, block.level + 3)}>
          <Words inline={block.inline} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <Words inline={item} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "code":
      return <pre class="lah-prose-code lah-mono">{block.text}</pre>;
    case "para":
      return (
        <p>
          {block.lines.map((line, i) => (
            <span key={i}>
              {i > 0 ? <br /> : null}
              <Words inline={line} />
            </span>
          ))}
        </p>
      );
  }
}

/** A text an agent wrote, as prose. `clamp`: at most that many blocks, for an opening (the rest is the caller's to offer). */
export function Prose(props: { text: string; clamp?: number }) {
  const blocks = proseOf(props.text);
  const shown = props.clamp !== undefined ? blocks.slice(0, props.clamp) : blocks;
  return (
    <div class="lah-prose" data-lah-prose>
      {shown.map((block, i) => (
        <BlockOf key={i} block={block} />
      ))}
    </div>
  );
}
