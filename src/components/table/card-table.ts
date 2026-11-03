/**
 * The card surface the Namespaces and Pods tables sit on, as one class list so the two cannot drift.
 *
 * Arbitrary variants, scoped to the wrapper: they override `.tbl`'s flush outer edge and
 * `.table-wrap`'s 8px gutter for these tables only (utilities beat `@layer components`, so `.tbl`
 * defaults elsewhere are untouched). The wrapper breaks `.filter-bar + .table-block`, so the
 * toolbar-row collapse that rule gives is restated here. Every header is centred over its column
 * whatever its cells do: the `th` centres its inline label, and the sort button drops
 * `.num`/`.ctr`'s full width so the label, sort mark and InfoTip centre as one run, in the text
 * columns' label-then-mark order (`.num`'s row-reverse is for a right edge these headers do not
 * have). The wrap carries the card's border here, so theme.css's scroll fade is off: masking the wrap
 * would fade the border and surface with it.
 */
export const CARD_TABLE_CLASS = [
  'relative',
  '[&_.table-tools]:-mt-2.5 [&_.table-tools]:mb-0 [&_.table-tools]:min-h-[18px] [&_.table-tool]:py-0 [&_.table-tool]:leading-4',
  '[&_.table-wrap]:m-0 [&_.table-wrap]:rounded-[6px] [&_.table-wrap]:border [&_.table-wrap]:border-line [&_.table-wrap]:bg-surface [&_.table-wrap]:p-0',
  '[&_th:first-child]:ps-3 [&_td:first-child]:ps-3 [&_th:last-child]:px-2.5 [&_td:last-child]:px-2.5',
  '[&_thead_th]:text-center [&_thead_.th-sort]:w-auto [&_thead_.th-sort]:justify-center [&_thead_.th-sort]:flex-row',
  '[&_.table-wrap]:[mask-image:none]',
  '[&_.pin]:shadow-none [&_tbody_tr:last-child_td]:border-b-0'
].join(' ');
