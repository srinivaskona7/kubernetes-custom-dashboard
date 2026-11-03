/** Path-to-line lookup for JSON value comparisons. Kept pure so navigation stays testable without a DOM. */

export type ValueDelta = { added: string[]; removed: string[]; changed: string[] };
export type DiffTone = 'added' | 'removed' | 'changed';
export type DiffMark = { path: string; line: number; tone: DiffTone };

/**
 * Maps JSON object's value paths to their key lines. `valuesText` always produces indented JSON,
 * so this deliberately follows its predictable shape instead of pretending to parse arbitrary
 * source text. Arrays are one value in the Helm diff and therefore map to their opening key line.
 */
export function jsonPathLines(text: string): Map<string, number> {
  const paths = new Map<string, number>();
  const stack: { indent: number; path: string }[] = [];

  for (const [line, source] of text.split('\n').entries()) {
    const match = /^(\s*)"([^"\\]+)":\s*(.*)$/.exec(source);
    if (!match) continue;
    const spaces = match[1] ?? '';
    const key = match[2] ?? '';
    const tail = match[3] ?? '';
    const indent = spaces.length;
    while (stack.at(-1)?.indent !== undefined && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1);
    const path = parent ? `${parent.path}.${key}` : key;
    paths.set(path, line);
    if (/^[{[]\s*,?$/.test(tail)) stack.push({ indent, path });
  }
  return paths;
}

/** The marks that belong to one side of a structured values diff. */
export function valueDiffMarks(text: string, delta: ValueDelta, side: 'left' | 'right'): DiffMark[] {
  const lines = jsonPathLines(text);
  const marks: DiffMark[] = [];
  const add = (paths: string[], tone: DiffTone) => {
    for (const path of paths) {
      const line = lines.get(path);
      if (line !== undefined) marks.push({ path, line, tone });
    }
  };
  if (side === 'right') add(delta.added, 'added');
  if (side === 'left') add(delta.removed, 'removed');
  add(delta.changed, 'changed');
  return marks;
}
