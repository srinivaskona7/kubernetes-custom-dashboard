/**
 * The alignment rule, as a test rather than as prose.
 *
 * The console is a stack of tables, and the thing an operator notices first is whether the column of
 * values under a heading starts where the heading starts. Before this it did not: the page header sat
 * at 24px, a Section heading at 28px, a card-wrapped table's first column at 32px and a bare table's
 * at 36px, and thirty-one tables had been hand-rolled with their own cell padding, their own row
 * height and their own header type. All of that is now one token (`--page-x`) and two classes
 * (`.tbl`, `.tbl-inline`).
 *
 * A rule that lives only in a comment comes back. These checks are what stop it:
 *
 *  1. Every `<table>` in the app uses `.tbl` or `.tbl-inline`.
 *  2. Every `.tbl` sits inside a `.table-wrap`, which is what gives it internal scrolling and the
 *     container query that sheds columns — a `.tbl` outside one clips instead of shedding.
 *  3. No `<th>`/`<td>` carries its own padding utility. Cell padding is the table's, in one place,
 *     which is the only way a header and its column can be guaranteed to agree.
 *  4. No page under `pages/` writes the gutter out by hand.
 *  5. The shed tiers stay ordered — the lowest-priority column must go before the next one up.
 *
 * These read the source, so they hold for markup written after this test as well.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '.');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map(path => {
  const raw = readFileSync(path, 'utf8').split('\n');
  return { path, rel: path.slice(SRC.length + 1), lines: raw, code: blankComments(raw) };
});

/**
 * The same lines with every comment blanked out, positions preserved.
 *
 * This codebase documents its layout decisions in prose that names the elements it is about — the
 * comment inside `DataTable` explaining why there is exactly one `<table>` contains the string
 * `<table>`, and the first version of this test failed on it. Blanking comments rather than skipping
 * lines keeps the line numbers, which is the whole value of the failure message.
 *
 * A stateful pass, not a regex, because a JSX comment (`{​/* … *​/}`) spans lines and its inner lines
 * carry no marker of their own.
 */
function blankComments(lines: string[]): string[] {
  let inBlock = false;
  return lines.map(line => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) return out;
        inBlock = false;
        i = end + 2;
        continue;
      }
      const block = line.indexOf('/*', i);
      const lineComment = line.indexOf('//', i);
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        return out + line.slice(i, lineComment);
      }
      if (block === -1) return out + line.slice(i);
      out += line.slice(i, block);
      inBlock = true;
      i = block + 2;
    }
    return out;
  });
}

/** Never assert against a corpus you have not proved is populated. */
it('found the component sources to scan', () => {
  expect(FILES.length).toBeGreaterThan(30);
});

describe('every table is the shared table', () => {
  it('opens with .tbl or .tbl-inline', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      f.code.forEach((line, i) => {
        const m = /<table(\s[^>]*)?>/.exec(line);
        if (!m) return;
        const cls = /className="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '';
        // DataTable builds the class from its `shed` prop, so its own source reads as a template.
        const templated = /className=\{/.test(m[1] ?? '');
        if (templated) return;
        if (!/\btbl\b/.test(cls) && !/\btbl-inline\b/.test(cls)) {
          offenders.push(`${f.rel}:${i + 1} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('wraps every .tbl in a .table-wrap', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      f.code.forEach((line, i) => {
        // `.tbl-inline` is exempt on purpose: a handful of rows inside a drawer has nothing to shed
        // and nothing to scroll, and giving it a container would start a container query its cells
        // do not use.
        if (!/<table[^>]*className=["'`{][^"'`]*\btbl\b/.test(line) || /\btbl-inline\b/.test(line)) return;
        // Walk back over blank lines and JSX comments to the element that contains it.
        let j = i - 1;
        while (j >= 0 && f.code[j]!.trim().replace(/[{}()]/g, '') === '') j--;
        if (!(f.code[j] ?? '').includes('table-wrap')) offenders.push(`${f.rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('cell padding belongs to the table, not the cell', () => {
  /**
   * `p-`, `px-`, `py-` and the four single-side forms. A cell spanning the whole table is exempt:
   * an empty state or an unavailability notice is not a column and cannot misalign with one.
   */
  const PADDING = /\bp[xytblr]?-(?:\[[^\]]+\]|[\d.]+)\b/;

  it('no th or td declares its own padding', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      f.code.forEach((line, i) => {
        if (!/^\s*<(th|td)\b/.test(line)) return;
        if (line.includes('colSpan')) return;
        const cls = /className="([^"]*)"/.exec(line)?.[1] ?? '';
        if (PADDING.test(cls)) offenders.push(`${f.rel}:${i + 1} ${cls}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('one content gutter', () => {
  it('no page writes the gutter out by hand', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      f.code.forEach((line, i) => {
        const cls = /className="([^"]*)"/.exec(line)?.[1] ?? /className=\{`([^`]*)`\}/.exec(line)?.[1] ?? '';
        if (/\bpx-6\b/.test(cls)) offenders.push(`${f.rel}:${i + 1} ${cls}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * A panel header is a heading with a divider under it, and ten of these had been hand-rolled with
   * `px-5`, `px-4` and `px-3` — so a panel's own title sat 20, 16 or 12px in while the table under it
   * started at 0. `.panel-head` carries the inline inset; the caller keeps the block padding.
   */
  it('a divider header takes its inline inset from .panel-head', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      f.code.forEach((line, i) => {
        const cls = /className="([^"]*)"/.exec(line)?.[1] ?? '';
        if (!/border-b border-line/.test(cls)) return;
        if (!/\bpx-\d/.test(cls)) return;
        offenders.push(`${f.rel}:${i + 1} ${cls}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * `.table-wrap` is already the scroll container — the container query that sheds columns reads its
   * inline size. A second `overflow-x-auto` around it produced two nested scrollers, so the outer one
   * scrolled a table that had already decided not to.
   */
  it('nothing wraps a .table-wrap in another scroll container', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      f.code.forEach((line, i) => {
        if (!/className="table-wrap"/.test(line)) return;
        let j = i - 1;
        while (j >= 0 && f.code[j]!.trim().replace(/[{}()]/g, '') === '') j--;
        if (/overflow-x-auto|overflow-auto/.test(f.code[j] ?? '')) offenders.push(`${f.rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The gutter is applied once, by `ClusterDetail`, around every tab. A tab that adds its own doubles
   * it: Autoscaling, Storage, Traffic, Logs and Reliability each did, and their tables started 24px
   * right of the page heading above them.
   */
  it('no cluster tab adds a second gutter inside the one it is given', () => {
    const offenders = FILES.filter(
      f => f.rel.startsWith('pages/cluster-tabs/') && f.code.some(l => /\bpage-x\b/.test(l))
    ).map(f => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the gutter token and the classes that read it exist', () => {
    const css = readFileSync(join(SRC, 'theme.css'), 'utf8');
    expect(css).toMatch(/--page-x:\s*24px/);
    expect(css).toMatch(/\.page-x\s*\{\s*padding-inline:\s*var\(--page-x\)/);
    expect(css).toMatch(/\.card-body\s*\{\s*padding:\s*var\(--page-x\)/);
    expect(css).toMatch(/\.panel-head\s*\{\s*padding-inline:\s*var\(--page-x\)/);
  });

  it('a table cell at the container edge carries no outer padding', () => {
    const css = readFileSync(join(SRC, 'theme.css'), 'utf8');
    expect(css).toContain('.tbl thead th:first-child');
    expect(css).toContain('padding-inline-start: 0');
    expect(css).toContain('.tbl tbody td:last-child');
    expect(css).toContain('padding-inline-end: 0');
  });
});

describe('shed tiers stay ordered', () => {
  /**
   * Every tier hides `prio-3` at a wider container than it hides `prio-2`. Reversing them would
   * throw away the more important column first, which is a data-loss bug that looks like a layout
   * tweak in review.
   */
  it('prio-3 goes before prio-2 on every tier', () => {
    const css = readFileSync(join(SRC, 'theme.css'), 'utf8');
    const found = new Map<string, { 2?: number; 3?: number }>();
    const re = /@container \(max-width:\s*(\d+)px\)\s*\{\s*\.(tbl(?:-\w+)?)\s+\.prio-(2|3)\s*\{/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      const px = Number(m[1]);
      const tier = m[2] as string;
      const prio = Number(m[3]) as 2 | 3;
      const e = found.get(tier) ?? {};
      e[prio] = px;
      found.set(tier, e);
    }
    expect([...found.keys()].sort()).toEqual(['tbl', 'tbl-lean', 'tbl-mid', 'tbl-wide', 'tbl-xwide']);
    for (const [tier, e] of found) {
      expect(e[2], `${tier} declares a prio-2 threshold`).toBeTypeOf('number');
      expect(e[3], `${tier} declares a prio-3 threshold`).toBeTypeOf('number');
      expect(e[3]!, `${tier}: prio-3 must shed at a wider container than prio-2`).toBeGreaterThan(e[2]!);
    }
  });
});
