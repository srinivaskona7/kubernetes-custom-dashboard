/**
 * The alignment classifier, and the console-wide audit that keeps every column honest about it.
 *
 * Two halves, and the second is the one that earns its keep: a unit test proves `CPU` is right and
 * `Namespace` is left, and then the scan reads every `Column<T>[]` in the source and fails on any
 * column whose *declared* alignment contradicts what the classifier would have given it. A
 * contradiction is always one of two real bugs — either the column is aligned wrongly, or its header
 * names something other than what the cell renders (a `Nodes` column holding node names rather than a
 * node count), and both want fixing rather than living behind an `align` override.
 *
 * Runs under vitest with no DOM: the classifier is a pure function and the scan is `fs`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { alignFor } from './align';

describe('alignFor', () => {
  test('a quantity reads right', () => {
    for (const header of [
      'CPU',
      'Memory',
      'Memory used',
      'CPU requested',
      'Restarts',
      'Pods',
      'Usage / limit',
      'Latency p95',
      'Errors',
      'Connections',
      'Capacity',
      'Request headroom',
      'Age',
      '%'
    ]) {
      expect(alignFor(header), header).toBe('right');
    }
  });

  test('an identity reads left', () => {
    for (const header of [
      'Pod',
      'Node',
      'Namespace',
      'Workload',
      'Service',
      'Route',
      'Endpoint',
      'Container',
      'Zone',
      'Description',
      'Path',
      'URL',
      'Status',
      'Cluster',
      'Release'
    ]) {
      expect(alignFor(header), header).toBe('left');
    }
  });

  test('a header naming both a subject and a quantity reads as the quantity', () => {
    // The cell renders the number; the subject is there to say which number it is.
    expect(alignFor('Pod restarts')).toBe('right');
    expect(alignFor('Node CPU')).toBe('right');
    expect(alignFor('Namespace count')).toBe('right');
  });

  test('a header the classifier has no rule for gets no opinion, rather than a guess', () => {
    for (const header of ['Enforcement', 'Drift', 'Scope', 'Mode']) {
      expect(alignFor(header), header).toBeNull();
    }
    // `Chart version` is not in that set: `chart` is an identity word, and a chart version is an
    // identifier — `1.24.3-rc2` is read left to right, not compared as a magnitude.
    expect(alignFor('Chart version')).toBe('left');
  });

  test('an empty header has no opinion', () => {
    expect(alignFor('')).toBeNull();
    expect(alignFor('   ')).toBeNull();
  });
});

/* ------------------------------------------------------------------ the console-wide audit */

const UI_SRC = new URL('../../', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.tsx$/.test(e.name) ? [full] : [];
  });
}

/** Strip comments: the doc comments in these files discuss alignment at length. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface Declared {
  where: string;
  header: string;
  align: 'left' | 'right' | 'center' | null;
}

/** Every column entry that declares a string header, with whatever alignment it states. */
function declaredColumns(): Declared[] {
  const files = walk(UI_SRC);
  expect(files.length, 'the fleet-ui scan found no .tsx files — the scan is broken, not the UI').toBeGreaterThan(30);
  const out: Declared[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const where = relative(UI_SRC, file);
    // One entry per `{ key: '…' … }` object inside a Column array. Splitting on `key:` is enough
    // because every column in this codebase declares one and declares it first.
    const parts = src.split(/(?=\bkey:\s*')/).slice(1);
    for (const part of parts) {
      const key = /^key:\s*'([^']+)'/.exec(part)?.[1];
      if (!key) continue;
      const entry = part.slice(0, part.indexOf('render:') >= 0 ? part.indexOf('render:') : 400);
      const header = /header:\s*'([^']*)'/.exec(entry)?.[1];
      const actions = /\.\.\.ACTIONS\b/.test(entry);
      if (!header && !actions) continue;
      const align = actions
        ? 'right'
        : /align:\s*'right'/.test(entry) || /\.\.\.NUMERIC\b/.test(entry)
          ? 'right'
          : /align:\s*'center'/.test(entry) || /\.\.\.CENTER\b/.test(entry)
            ? 'center'
            : /align:\s*'left'/.test(entry)
              ? 'left'
              : null;
      out.push({ where: `${where}:${key}`, header: actions ? 'Actions' : header!, align });
    }
  }
  return out;
}

describe('the console agrees with its own alignment rule', () => {
  test('no column declares an alignment the classifier contradicts', () => {
    const columns = declaredColumns();
    expect(columns.length, 'no columns parsed — the scan is broken').toBeGreaterThan(80);
    const offences = columns
      .filter(c => {
        const verdict = alignFor(c.header);
        if (verdict === null || c.align === null) return false;
        // `center` is always an explicit opt-in the classifier never returns, and a pinned identity
        // column stating `left` against a numeric-looking header is the documented override.
        if (c.align === 'center') return false;
        return verdict !== c.align;
      })
      .map(
        c =>
          `${c.where} is headed "${c.header}" and declares align: '${c.align}', but the classifier reads that header as '${alignFor(
            c.header
          )}'. Either the alignment is wrong, or the header names something other than what the cell renders — a "Nodes" column holding node names wants a header that says so.`
      );
    expect(offences).toEqual([]);
  });

  test('a column with no declared alignment gets one from its header', () => {
    // Not an assertion about correctness — an assertion that the classifier is actually load-bearing.
    // If it had an opinion about nothing, every test above would still pass and no table would change.
    const columns = declaredColumns();
    const derived = columns.filter(c => c.align === null && alignFor(c.header) !== null);
    expect(derived.length, 'the classifier decides nothing for any real column').toBeGreaterThan(20);
  });

  /**
   * The classifier was introduced over a console whose alignment had already been reviewed by hand, so
   * it must not *change* any existing column — it must agree with the review and then keep future
   * columns in line.
   *
   * Two columns failed this when it was first written, and both were the classifier's fault rather
   * than the table's: Traffic's `Request` (a method and a path) and Tokens' `Last error` (a message)
   * were read as quantities because `request` and `error` were in the numeric word list. Removing
   * those two singular words is why the list looks asymmetric.
   */
  test('the classifier silently right-aligns nothing that renders left today', () => {
    const surprises = declaredColumns()
      .filter(c => c.align === null && alignFor(c.header) === 'right')
      .map(c => `${c.where} headed "${c.header}" renders left today and the classifier would move it right`);
    expect(surprises).toEqual([]);
  });
});
