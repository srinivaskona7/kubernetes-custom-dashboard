/**
 * The paging control: a range line and a row of page buttons.
 *
 * Dumb by design. Every rule it obeys is a function in `pagination.ts`, tested there, because this
 * console's vitest runs in node and a component cannot be rendered in a test on this workstation.
 * What is left here is markup and the accessible names, and two of those are load-bearing:
 *
 *   - **It renders nothing for a single page.** A table with 12 of 12 rows on screen gets no "Page 1
 *     of 1" beside it; that is chrome describing the absence of a decision. The count line lives on
 *     the table's own heading, so a one-page result still says how many of how many it is showing.
 *   - **Every button names its target page.** "Next" and a row of bare digits give a screen-reader
 *     user a set of identical controls; `Go to page 3 of 18` is the whole affordance in the label.
 *
 * Semantic `<button>` throughout (§26) inside a `<nav>`, which is what gives the whole group one
 * announced name instead of eighteen unrelated buttons.
 *
 * No new CSS: `.filter-tool` is the console's existing always-visible bordered control — the table
 * toolbar's `.table-tool` is invisible until the table is hovered, which is right for a Columns menu
 * and wrong for the control an operator is reaching for — and `.filter-tool-on` is the accent pair
 * already proved to pass AA on `--color-raised`.
 *
 * `PageControl`, not `Pagination`, and the file name is the reason: macOS is case-insensitive, so a
 * `Pagination.tsx` beside `pagination.ts` is one path. TypeScript resolves `./Pagination` by trying
 * `.ts` before `.tsx` and lands on the logic module, so the import silently returns the wrong file —
 * locally. On a case-sensitive CI box it resolves correctly, which is the worse half: the two
 * environments disagree about what the module is.
 */
import { pageWindow, rangeLabel } from './pagination';

export function PageControl({
  page,
  pageCount,
  from,
  to,
  total,
  noun,
  onPage
}: {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  /** What a row is, for the range line and the group's accessible name. Plural. */
  noun: string;
  onPage: (page: number) => void;
}): JSX.Element | null {
  // One page is not a navigation decision. See the note above.
  if (pageCount <= 1) return null;

  const pages = pageWindow(page, pageCount);

  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 pt-3" aria-label={`${noun} pages`}>
      <p className="text-[12px] text-muted">
        {/*
          The range, never a bare page number. "Page 9 of 18" tells an operator nothing about how much
          they are looking at; `201–225 of 430` is the same fact with its denominator attached, which
          is the form the rest of this console uses for every count read out of a log window.
        */}
        <span className="mono">{rangeLabel({ from, to, total })}</span> {noun}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="filter-tool"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label={page <= 1 ? 'Previous page — already on the first page' : `Go to the previous page, page ${page - 1} of ${pageCount}`}
        >
          Previous
        </button>
        {pages.map((p, i) =>
          p === 'gap' ? (
            // Index keys: the only thing distinguishing two gaps is their position, and a gap is not
            // interactive, so it has nothing to keep across a re-render.
            <span key={`gap-${i}`} className="px-1 text-[12px] text-muted/70" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className={p === page ? 'filter-tool filter-tool-on' : 'filter-tool'}
              // `aria-current` rather than `aria-pressed`: this is the page being shown, not a toggle
              // that has been switched on, and a screen reader announces the two differently.
              aria-current={p === page ? 'page' : undefined}
              aria-label={`Go to page ${p} of ${pageCount}`}
              onClick={() => onPage(p)}
            >
              <span className="mono filter-tool-value">{p}</span>
            </button>
          )
        )}
        <button
          type="button"
          className="filter-tool"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
          aria-label={page >= pageCount ? 'Next page — already on the last page' : `Go to the next page, page ${page + 1} of ${pageCount}`}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
