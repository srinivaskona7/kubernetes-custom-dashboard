/**
 * Loading placeholders that keep the page's structure on screen.
 *
 * The request is explicit about this (§20): skeletons for the metric cards, the breakdown and the
 * table rows, and **do not freeze the entire page**. That rules out the console's existing
 * `Skeleton rows={n}` for this page — it replaces the whole tab body with grey bars, so the header,
 * the filter bar and the sub-tabs vanish for the four-to-seven seconds a ten-proxy log read takes, and
 * the operator cannot even change the filter that is loading. Here the shell always renders, and only
 * the blocks that are waiting for data are grey.
 *
 * Every shape below is sized to the real thing it stands in for. A skeleton that is a different height
 * than its content makes the page jump when the read lands, which reads as a rendering fault rather
 * than as an arrival — and on a page whose whole subject is "how much of this is real", a layout that
 * visibly rearranges itself is the wrong first impression.
 *
 * `.skeleton` (theme.css) supplies the surface and the pulse, and honours
 * `prefers-reduced-motion: reduce`. Nothing here animates on its own.
 *
 * `aria-hidden` on the bars with one `aria-busy` region around them: eight pulsing divs each
 * announcing themselves is worse than silence, and `aria-busy` on the container is the thing a screen
 * reader actually uses to say "this part is still loading".
 */

/** One grey line. `w` and `h` are Tailwind arbitrary values so a caller can match its own type scale. */
export function SkeletonLine({ w = 'w-full', h = 'h-3' }: { w?: string; h?: string }): JSX.Element {
  return <div aria-hidden="true" className={`skeleton ${w} ${h}`} />;
}

/**
 * One metric tile's worth: a label line, then the big number, then the caption.
 *
 * Three lines rather than one block, because a single 88px rectangle does not read as a card that is
 * about to contain a number — it reads as an image that failed to load.
 */
export function SkeletonTile(): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-[8px] border border-line bg-raised px-3.5 py-3">
      <SkeletonLine w="w-24" h="h-2.5" />
      <SkeletonLine w="w-16" h="h-6" />
      <SkeletonLine w="w-28" h="h-2.5" />
    </div>
  );
}

/** The metric strip. `count` matches the number of tiles the real strip renders, so nothing shifts. */
export function SkeletonTiles({ count = 5 }: { count?: number }): JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading traffic counts" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonTile key={i} />
      ))}
    </div>
  );
}

/**
 * The error-breakdown rows: a code pill, a count, and a bar.
 *
 * The bar widths descend rather than being uniform. A column of identical bars looks like a chart
 * with no data in it; a descending set looks like a distribution that has not arrived, which is what
 * it is.
 */
export function SkeletonBars({ rows = 5 }: { rows?: number }): JSX.Element {
  const widths = ['w-[88%]', 'w-[62%]', 'w-[41%]', 'w-[24%]', 'w-[12%]', 'w-[8%]'];
  return (
    <div aria-busy="true" aria-label="Loading the response-code breakdown" className="divide-y divide-line">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 py-2">
          <SkeletonLine w="w-[56px]" h="h-4" />
          <SkeletonLine w="w-[52px]" h="h-3" />
          <span className="flex-1">
            <SkeletonLine w={widths[i % widths.length] ?? 'w-1/2'} h="h-2" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Table rows, at the row height `.tbl` actually uses (44px), inside a header rule so the block reads
 * as a table rather than as a list.
 *
 * Deliberately not a `<table>`: `layout-alignment.test.ts` requires every `<table>` in the app to be
 * the shared `DataTable`, and a skeleton has no columns to align. This is the one place a grid of grey
 * bars is honest about being scaffolding.
 */
export function SkeletonRows({ rows = 8 }: { rows?: number }): JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading failures">
      <div className="flex h-9 items-center gap-6 border-b border-line">
        <SkeletonLine w="w-[60px]" h="h-2.5" />
        <SkeletonLine w="w-[48px]" h="h-2.5" />
        <SkeletonLine w="w-[160px]" h="h-2.5" />
        <SkeletonLine w="w-[100px]" h="h-2.5" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-6 border-b border-line/60">
          <SkeletonLine w="w-[52px]" h="h-4" />
          <SkeletonLine w="w-[34px]" h="h-3" />
          <SkeletonLine w="w-[210px]" h="h-3" />
          <SkeletonLine w="w-[120px]" h="h-3" />
        </div>
      ))}
    </div>
  );
}
