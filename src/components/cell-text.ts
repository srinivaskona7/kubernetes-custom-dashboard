/**
 * The text a table cell would read out loud.
 *
 * Its own module so it can be tested without a DOM — `app/fleet-ui` runs vitest with
 * `environment: 'node'` (jsdom is blocked by npm E401 on this workstation), and this is pure
 * tree-walking over React elements, which needs no renderer.
 *
 * Why it exists: a capped column truncates with an ellipsis, and a truncated value that cannot be
 * hovered is a value the operator cannot read at all. Twenty columns across the console declared a
 * `max` and no tooltip, so the ceiling that stopped the table overflowing also silently swallowed
 * the end of a namespace, a chart version, a webhook name. Asking every caller to remember a
 * `title` is the arrangement that produced those twenty; deriving it from what the cell already
 * renders cannot be forgotten.
 *
 * Deliberately conservative — it returns '' rather than a guess when it cannot see the text:
 *
 *  - Depth- and length-limited. A cell renders a handful of nodes; anything deeper is a component
 *    whose internals are not this function's business, and an unbounded walk over a 200-row table
 *    is a frame budget spent on tooltips.
 *  - It reads `props.children` only. It never invokes a function component: calling one outside
 *    the renderer would run hooks outside React and is a correctness bug, not an optimisation.
 *    A cell whose text lives inside a custom component gets no derived title, and the column can
 *    supply `title` explicitly.
 *  - It ignores `title` on the nodes it walks. That was the first design and it was wrong: the
 *    titles inside a cell are instructions and legends, not the cell's text — the Node column of
 *    the pod table renders `<button title="View this node in the Nodes tab">{name}</button>`, and
 *    a clipped node name got a tooltip that did not contain the name. Nothing is lost by ignoring
 *    them, because the browser shows the *innermost* title under the pointer: hovering the button
 *    still reads "View this node in the Nodes tab", and hovering the rest of the cell now reads
 *    the name that the `max` ceiling cut off, which is the only job this function has.
 *  - `false`, `null` and `undefined` contribute nothing, so `{cond && <span>…</span>}` does not
 *    produce the string "false".
 */
import { isValidElement, type ReactNode } from 'react';

const MAX_DEPTH = 6;
const MAX_LENGTH = 400;

/**
 * The public entry point. Clamps whatever the walk produced, including the trivial case: a cell
 * rendering one long string returned it untouched, so a 5 KB Helm values blob or an OPA rejection
 * message became a 5 KB tooltip. Caught by the length test, which is why it is a test and not a
 * comment.
 */
export function textOf(node: ReactNode): string {
  return clamp(walk(node, 0));
}

function walk(node: ReactNode, depth: number): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (depth >= MAX_DEPTH) return '';

  if (Array.isArray(node)) {
    return join(node.map(child => walk(child, depth + 1)));
  }
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode } | null;
    return props ? walk(props.children, depth + 1) : '';
  }
  return '';
}

/**
 * Join sibling fragments the way a reader sees them: a single space between two runs of text, and
 * no leading or trailing padding. Without it `<Dot/>{name}` yields " my-namespace", which is a
 * tooltip that does not match the cell.
 */
function join(parts: string[]): string {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function clamp(text: string): string {
  const tidy = text.replace(/\s+/g, ' ').trim();
  return tidy.length > MAX_LENGTH ? `${tidy.slice(0, MAX_LENGTH - 1)}…` : tidy;
}
