// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/**
 * Does the Scheduled pods table actually fit the container it renders in?
 *
 * `table-shed-tier.test.js` checks tiers against COLUMN COUNT, and its own header comment says why
 * that is only half the story: "column count does not predict overflow, total content width does".
 * This table is the case where the half that was checked passed and the half that was not, failed.
 * Eight columns is inside the base tier's budget, so nothing complained — and at a 1440px viewport
 * the table rendered 1137px inside a 1117px container, clipping the **Actions** column to "Log" and
 * putting a horizontal scrollbar under a table that was 20px from fitting.
 *
 * Two facts about the tier system make this table's configuration the only one that works, and both
 * are counter-intuitive enough to be worth a test rather than a comment (see theme.css for the
 * thresholds themselves):
 *
 *  1. **A tier's first number sheds priority 3, its second sheds priority 2.** `mid` is 1000/700, so
 *     on a table whose only sheddable column is priority 2, `mid` sheds nothing until the container
 *     is under 700px — which the supported window range never reaches. That is why 1280px, where
 *     the container is 957px, still rendered all eight columns and overflowed by 66px.
 *  2. **Priority 3 sheds at 1440.** The container at a 1440px viewport is 1117px, below `wide`'s
 *     1300px priority-3 threshold — so marking a column priority 3 to "help" removes it at the
 *     default width, and the design asks for every one of these columns there.
 *
 * So: `wide`, exactly one priority-2 column (Workload), and text ceilings small enough that the
 * full eight fit at 1440. Measured in Chrome against the live cluster, after the change:
 *
 *   | viewport | container | table | columns shown            |
 *   |----------|-----------|-------|--------------------------|
 *   | 1440     | 1117      | 1117  | all 8                    |
 *   | 1280     |  957      |  957  | 7 (Workload shed)        |
 *
 * Below roughly 1180px the console's dense tables scroll horizontally — six other tables do the
 * same at 1024px — and that is a documented limit of the layout, not something this table can fix
 * on its own.
 */




import { CELL_PAD_PX, CONTAINER_AT_1440_PX, tableWidth } from './helpers/column-width';

const CLUSTER_DETAIL = path.join(FAKE_DIR, '../../src/pages/ClusterDetail.tsx');

/**
 * The sum of the three text ceilings the eight-column set can afford at a 1117px container.
 *
 * Derived, not guessed: the five remaining columns (CPU, Memory, Status, Restarts, Actions) measured
 * 437px of content and the table pays roughly 200px of cell padding across eight columns, so the
 * text columns have about 480px to share. 510 is that with the slack the measurement showed at 1117.
 */
const TEXT_CEILING_BUDGET = 510;

/**
 * The `nodePodColumns` array, split into one chunk per column.
 *
 * Per column rather than one string, because these entries carry long explanatory comments and a
 * window-based regex over the whole array reads a *neighbour's* `priority` as its own — which is
 * exactly what the first draft of this guard did, reporting the Namespace column as priority 2
 * because the Pod column's comment pushed the real match out of range.
 */
function podColumns() {
  const src = fs.readFileSync(CLUSTER_DETAIL, 'utf8');
  const start = src.indexOf('const nodePodColumns');
  assert.ok(start > 0, 'nodePodColumns is gone from ClusterDetail.tsx — this guard is measuring nothing');
  const end = src.indexOf('\n  ];', start);
  assert.ok(end > start, 'could not find the end of the nodePodColumns array');
  const body = src.slice(start, end);
  const chunks = [];
  const keys = [...body.matchAll(/key:\s*'([^']+)'/g)];
  keys.forEach((m, i) => {
    const from = m.index;
    const to = i + 1 < keys.length ? keys[i + 1].index : body.length;
    chunks.push({ key: m[1], source: body.slice(from, to) });
  });
  return chunks;
}

/** The `<DataTable>` element that renders those columns — the one carrying the tier. */
function podTableElement() {
  const src = fs.readFileSync(CLUSTER_DETAIL, 'utf8');
  const at = src.indexOf('columns={nodePodColumns}');
  assert.ok(at > 0, 'nothing renders nodePodColumns any more — this guard is measuring nothing');
  const open = src.lastIndexOf('<DataTable', at);
  const close = src.indexOf('/>', at);
  return src.slice(open, close);
}

test('the Scheduled pods table sheds on a tier that can actually fire', () => {
  const element = podTableElement();
  const tier = /shed="(mid|wide|xwide|lean)"/.exec(element);
  assert.ok(tier, 'the Scheduled pods table declares no shed tier at all — eight columns will clip');
  assert.equal(
    tier[1],
    'wide',
    'only `wide` sheds a priority-2 column above a 700px container. `mid` leaves all eight columns rendered at a 1280px viewport, where they overflow by 66px; `xwide`/`lean` shed priority 3 at 1440, and nothing here is priority 3.'
  );
});

test('exactly one Scheduled pods column is allowed to shed, and it is Workload', () => {
  const sheddable = podColumns()
    .filter(c => /priority:\s*[23]/.test(c.source))
    .map(c => ({ key: c.key, priority: Number(/priority:\s*([23])/.exec(c.source)[1]) }));
  assert.deepEqual(
    sheddable,
    [{ key: 'workload', priority: 2 }],
    'Pod, Namespace, CPU, Memory, Status, Restarts and Actions are all columns the design asks for at the default width, and a priority 3 on any of them would shed it at 1440 (container 1117 < wide\'s 1300).'
  );
});

test('the Scheduled pods text columns stay inside the width their container has', () => {
  const capped = podColumns().filter(c => /max:\s*'\d+px'/.test(c.source));
  assert.deepEqual(
    capped.map(c => c.key),
    ['pod', 'ns', 'workload'],
    'the three unbounded text columns are the ones that need a ceiling'
  );
  const total = capped.reduce((sum, c) => sum + Number(/max:\s*'(\d+)px'/.exec(c.source)[1]), 0);
  assert.ok(
    total <= TEXT_CEILING_BUDGET,
    `the three text ceilings total ${total}px, over the ${TEXT_CEILING_BUDGET}px this table's five numeric columns leave at a 1117px container. Raising a ceiling here does not widen the container — it clips the Actions column, which is how this table shipped with a "Log" button.`
  );
});

/**
 * Every text column must still declare a ceiling. Without one, `table-layout: auto` grows the column
 * to its longest row and the budget above becomes a statement about nothing — a pod name is
 * unbounded, and a Deployment adds two hash suffixes to it.
 */
test('each Scheduled pods text column declares a ceiling rather than relying on its content', () => {
  const byKey = new Map(podColumns().map(c => [c.key, c.source]));
  for (const key of ['pod', 'ns', 'workload']) {
    const entry = byKey.get(key);
    assert.ok(entry, `the Scheduled pods table no longer has a '${key}' column`);
    assert.match(
      entry,
      /max:\s*'\d+px'/,
      `the '${key}' column declares no max — .tbl sets nowrap, so the column grows to its longest value and pushes Actions off the container`
    );
  }
});

/* =============================================================================================
 * The width budget, as arithmetic rather than as a column count.
 *
 * Everything above this line measures ONE table, by hand, against numbers taken in Chrome. That does
 * not generalise, and the two guards in this directory between them still could not answer the
 * question a reviewer actually has when a column is proposed: **how much room is left?**
 *
 * `helpers/column-width.js` models it. The three rules below are what the model is for:
 *
 *  1. A ratchet on each audited table's ceiling width, so a column cannot be added silently. Exact
 *     equality, deliberately — the failure message carries the new arithmetic, and recording the new
 *     number is then a conscious act by whoever widened the table.
 *  2. A table whose ceiling exceeds the container it gets at 1440 must be ABLE to shed. Not that it
 *     does — the model's total is a ceiling and errs ~5% high, so demanding a fit here would fail
 *     tables that measurably fit. Demanding the ability to shed cannot.
 *  3. A `max` below its own header's intrinsic width clips the label rather than narrowing the
 *     column. This is the one content-overflow case a sum of declared widths can never see.
 * ============================================================================================= */

/**
 * Labels for headers the source does not state as a plain string.
 *
 * A header assembled at runtime — a template string or a builder call — has no literal for the
 * model to measure. The model reports an unreadable
 * header as unresolved and the test below fails on it, so a new computed header cannot slip through
 * unmeasured; registering it here is how it gets measured.
 *
 * Each entry is the WIDER of the strings the column can render — `Memory usage`, not `CPU usage`. A
 * budget written against the narrower branch is a budget that holds only while the operator leaves the
 * Metric control alone.
 */
const COMPUTED_HEADERS = {
};

/**
 * The tables this budget covers, and the ceiling width each one currently declares.
 *
 * `full` is every column; `keptAbovePrio2` is the set that survives the tier's prio-3 threshold, which
 * is what an operator sees across the whole band from that threshold down to the prio-2 one — the band
 * a 1440px laptop sits in on every tier from `wide` up. Both are modelled ceilings, not Chrome
 * measurements: see the header note in `helpers/column-width.js` for what that distinction costs.
 *
 * Validated against the only table in this repo with a recorded post-fix Chrome measurement: the
 * Scheduled pods table models 1174px against 1117px measured, 5.1% high. Keep it in the list for that
 * reason alone — it is the model's calibration, and a change that moves it is a change that has
 * invalidated every other number here.
 */
const BUDGET = [
  {
    /*
      1216px against a 1167px container with all six columns rendered, which is why this table is on
      `shed="wide"` with a priority on two of them: at 1167 Target sheds and the rest fits at 956px.
      Two ceilings (Replicas, Metric thresholds) were widened mid-audit, which is +130px of the 1216 —
      the cost of replacing a four-number mono string with a readable cell, and not recoverable by
      narrowing it again.

      `full` is unchanged by the priorities: a `priority` decides WHEN a column renders, not how wide
      it is. `keptAbovePrio2` is the number that moved.
    */
    name: 'AutoscalingTab.hpaColumns',
    file: 'pages/cluster-tabs/AutoscalingTab.tsx',
    array: 'hpaColumns',
    columns: 6,
    full: 1216,
    keptAbovePrio2: 956
  },
  {
    /*
      1279px at `shed="wide"`, whose prio-3 threshold is a 1300px container — above the 1167px this
      table gets at 1440, so On-overlap and Age shed there and it fits at 1039px. It was `shed="mid"`,
      whose threshold is 1000px and therefore never fired at 1167: the table scrolled with all nine
      columns rendered.

      1269 -> 1279 is the Schedule column's ceiling going 160px -> 170px, and it is ARITHMETIC, not a
      new Chrome measurement: the header needs 167px once the 12px sort mark is charged, so at 160 it
      rendered `SCHEDULE (CRO…` (see `table-header-clip.test.js`). The number that decides whether
      this table still fits is `keptAbovePrio2`, and 1039px against a 1167px container has 128px of
      slack — the widening cannot have introduced a scrollbar at 1440. A re-measurement is still owed
      for the 1280px breakpoint, where the container is 957px and this table already sheds to fit.
    */
    name: 'AutoscalingTab.cronColumns',
    file: 'pages/cluster-tabs/AutoscalingTab.tsx',
    array: 'cronColumns',
    columns: 9,
    full: 1279,
    keptAbovePrio2: 1039
  },
  {
    /*
      The model's calibration, and the reason it stays in this list: 1094px modelled against 1117px
      measured in Chrome and recorded at the top of this file — 2.1% low. Every other number here is
      only as good as this one. A change that moves it has invalidated the rest.
    */
    name: 'ClusterDetail.nodePodColumns',
    file: 'pages/ClusterDetail.tsx',
    array: 'nodePodColumns',
    columns: 8,
    full: 1094,
    keptAbovePrio2: 1094
  }
];

function measured(entry) {
  return tableWidth(entry.file, entry.array, COMPUTED_HEADERS[entry.name], entry.plan);
}

test('every audited table states a header this model can measure', () => {
  const offences = [];
  for (const entry of BUDGET) {
    for (const u of measured(entry).unresolved) {
      offences.push(
        `${entry.name}: the '${u.key}' column's header is \`${u.header}\`, which is not a string literal — so its width is unknown and this table's budget is arithmetic over a hole. Register the widest string it renders in COMPUTED_HEADERS.`
      );
    }
  }
  assert.deepEqual(offences, []);
});

test('no audited table has grown wider than the budget recorded for it', () => {
  for (const entry of BUDGET) {
    const m = measured(entry);
    // `total`, not `body` — the padding-inclusive number the sums are built from. Printing the
    // content width beside a padding-inclusive total invites exactly the 32px-per-column confusion
    // that put this model 294px above `pod-columns.ts` in the first place.
    const detail = m.columns.map(c => `${c.key} p${c.priority} ${c.total}px`).join(', ');
    assert.equal(
      m.count,
      entry.columns,
      `${entry.name} now declares ${m.count} columns, not ${entry.columns}. Adding a column to a table that already overflows its container does not make the table wider — the container is fixed — it spends the slack the shed tiers were calibrated against. Re-measure in Chrome, then update BUDGET. Columns: ${detail}`
    );
    assert.equal(
      m.full,
      entry.full,
      `${entry.name}'s full set now models ${m.full}px of ceiling, not ${entry.full}px — a change of ${m.full - entry.full}px against a ${CONTAINER_AT_1440_PX}px container at 1440. Update BUDGET only with a measurement behind it. Columns: ${detail}`
    );
    assert.equal(
      m.keptAbovePrio2,
      entry.keptAbovePrio2,
      `${entry.name}'s prio-1+2 set — what an operator sees at 1440 on a shedding tier — now models ${m.keptAbovePrio2}px of ceiling, not ${entry.keptAbovePrio2}px, against a ${CONTAINER_AT_1440_PX}px container. A priority-1 column added here is width the operator pays for at every window size, because priority 1 is the set that never sheds.`
    );
  }
});

/**
 * Tables known to be unable to shed, with the arithmetic for each.
 *
 * Empty, and deliberately kept rather than deleted: both entries that were here — the Autoscaling tab's
 * HPA and CronJob tables — have been fixed, the HPA one with `shed="wide"` plus a priority on Target and
 * Metrics, the CronJob one by moving off `shed="mid"`, whose 1000px threshold never fired at the 1167px
 * container the table actually gets. An entry parked here has to carry the arithmetic that justifies it,
 * and the staleness test below means it cannot outlive its own fix.
 */
const CANNOT_SHED_DEBT = new Map([]);

test('a table wider than its container can actually shed something', () => {
  const offences = [];
  for (const entry of BUDGET) {
    const m = measured(entry);
    if (m.full <= CONTAINER_AT_1440_PX) continue;
    const sheddable = m.columns.filter(c => c.priority > 1);
    const reasons = [];
    if (m.thresholds.prio3 < CONTAINER_AT_1440_PX) {
      reasons.push(
        `its tier (${m.tier}) sheds prio-3 only below a ${m.thresholds.prio3}px container, which is under the ${CONTAINER_AT_1440_PX}px it gets at 1440 — so the threshold never fires there`
      );
    }
    if (sheddable.length === 0) reasons.push('no column declares a priority above 1, so there is nothing for a threshold to hide');
    if (reasons.length === 0) continue;
    if (CANNOT_SHED_DEBT.has(entry.name)) continue;
    offences.push(`${entry.name}: models ${m.full}px of ceiling against a ${CONTAINER_AT_1440_PX}px container, and ${reasons.join('; ')}.`);
  }
  assert.deepEqual(offences, []);
});

test('the cannot-shed debt list has no stale entries', () => {
  const stale = [];
  for (const name of CANNOT_SHED_DEBT.keys()) {
    const entry = BUDGET.find(e => e.name === name);
    if (!entry) {
      stale.push(`${name}: no longer in BUDGET`);
      continue;
    }
    const m = measured(entry);
    const fires = m.thresholds.prio3 >= CONTAINER_AT_1440_PX;
    const hasSheddable = m.columns.some(c => c.priority > 1);
    if (m.full <= CONTAINER_AT_1440_PX || (fires && hasSheddable)) stale.push(`${name}: this table can shed now`);
  }
  assert.deepEqual(stale, [], 'these tables were fixed — delete them from CANNOT_SHED_DEBT so it keeps ratcheting down');
});

/**
 * A ceiling below the header's own width does not narrow the column, it clips the label.
 *
 * `DataTable.size()` applies `max` to the `th` as well as the `td` — deliberately, so a header can
 * never render wider than the cells under it. The consequence is that `max: '90px'` on a column headed
 * `Memory usage / request` produces an ellipsised HEADER, and a column whose label is cut is a column
 * whose numbers mean nothing. On `tbl-xwide` and `tbl-lean` the header wraps at its spaces, so what
 * has to fit is the longest single word; on every other tier it is the whole string.
 *
 * Compared against the column's DECLARED ceiling, not against the width the model charges it. The
 * first version of this test compared `head` with `body`, and `body` is `max(ceiling, head)` by
 * construction — so the rule could never fire, and the canary that was supposed to break it passed.
 * A comparison whose two sides are derived from each other is a test of arithmetic, not of the source.
 */
test('no audited column declares a ceiling narrower than its own header', () => {
  const offences = [];
  for (const entry of BUDGET) {
    const m = measured(entry);
    for (const c of m.columns) {
      // `ceilingPx` is set only when the column declared a `max`. A `width` below the header does not
      // clip it — `table-layout: auto` overrides a width, so the column just costs more than it says,
      // which is the budget ratchet's business rather than this rule's.
      if (typeof c.ceilingPx !== 'number') continue;
      // `+ CELL_PAD_PX`, because the `max` is border-box: the label has to fit inside the cell's own
      // 32px of padding, not inside the declared number. Comparing the bare header width against the
      // ceiling was 32px too lenient — the same border-box slip that put this model 294px high.
      const needs = c.head + CELL_PAD_PX;
      if (c.ceilingPx >= needs) continue;
      offences.push(
        `${entry.name}:${c.key}: the column declares a ${c.ceilingPx}px \`max\` but its header needs ${needs}px with the cell's padding on the ${m.tier} tier — \`max\` lands on the \`th\` too, so the label ellipsises instead of the column narrowing.`
      );
    }
  }
  assert.deepEqual(offences, []);
});
