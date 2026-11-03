/**
 * The clickable-resource layer: a link, the URL state it drives, and the drawer it opens.
 *
 * ## The one idea
 *
 * A resource on screen — a table row, a card, a finding, a related-resource entry — is a
 * `<ResourceLink>`. Clicking one sets `?res=Kind/namespace/name` and nothing else. The drawer
 * reads that parameter, looks the row up in data the page already holds, and renders it through
 * the single registry entry for that Kind. One renderer per Kind, reached from everywhere.
 *
 * Driving it through the URL rather than component state is what makes a drawer shareable: an
 * operator investigating an incident can paste the address bar into a ticket and the next person
 * lands on the same object. It also means Back closes the drawer, which is what Back should do.
 *
 * ## Read-only
 *
 * Every affordance here navigates or copies. There is no action menu, no overflow menu, and no
 * write of any kind — Kyma Fleet must never change cluster state, and the drawer is the surface
 * where a "convenient" Delete would most plausibly have been added.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Dot, Pill, type Tone } from './ui';
import { DetailPanel, Field, Section } from './layout';
import { isKind, RESOURCE_REGISTRY } from '../resources/registry';
import type { Resolver } from '../resources/resolve';
import { refFromParam, refToParam, type ResourceRef, type ResourceView } from '../resources/types';

// ------------------------------------------------------ resolver registration

/**
 * How a tab lends its data to the drawer.
 *
 * The drawer is mounted once, on the cluster page, so that a link works the same from every tab
 * and `?res=` survives a tab switch. But the data lives in the tabs — Services are in the
 * Networking tab's payload, PVCs in Storage's. Rather than hoist every tab's fetch up to the
 * page (which would make the page fetch nine endpoints on mount to serve a drawer that may never
 * open), each tab registers a resolver for as long as it is mounted and withdraws it on unmount.
 *
 * Registration is a ref, not state: a resolver arriving must not re-render the whole page, and
 * the drawer only ever reads it during its own render.
 */
type ResolverBag = {
  register: (key: string, resolver: Resolver) => () => void;
  resolve: Resolver;
};

const ResolverContext = createContext<ResolverBag | null>(null);

/**
 * The registration counter, deliberately in a **second** context.
 *
 * It used to ride on the same value as `register`/`resolve`, and that was an infinite render
 * loop: bumping the counter produced a new context value, `useRegisterResolver`'s effect listed
 * that value as a dependency, so it unregistered and re-registered, which bumped the counter
 * again. React caught it as "Maximum update depth exceeded" on whichever tab happened to be
 * mounted. Splitting the contexts fixes it at the root — the bag a tab registers into is now
 * referentially stable for the life of the page, so the effect runs exactly twice per tab
 * (mount and unmount), while the drawer still re-renders on every change because it is the only
 * thing reading the counter.
 */
const ResolverVersionContext = createContext(0);

export function ResourceDataProvider({ children }: { children: ReactNode }) {
  const bag = useRef(new Map<string, Resolver>());
  // Bumped on every register/unregister so an open drawer re-renders once the tab that owns its
  // Kind has mounted. Without this, deep-linking straight to `?res=Service/...` would show
  // "not in view" permanently, because the drawer rendered before the tab registered.
  const [version, setVersion] = useState(0);

  const register = useCallback((key: string, resolver: Resolver) => {
    bag.current.set(key, resolver);
    setVersion(v => v + 1);
    return () => {
      bag.current.delete(key);
      setVersion(v => v + 1);
    };
  }, []);

  // Stable for the life of the provider — see `ResolverVersionContext` above for why that is
  // load-bearing rather than a micro-optimisation.
  const value = useMemo<ResolverBag>(
    () => ({
      register,
      resolve: ref => {
        for (const r of bag.current.values()) {
          const hit = r(ref);
          if (hit !== undefined) return hit;
        }
        return undefined;
      }
    }),
    [register]
  );

  return (
    <ResolverContext.Provider value={value}>
      <ResolverVersionContext.Provider value={version}>{children}</ResolverVersionContext.Provider>
    </ResolverContext.Provider>
  );
}

/**
 * Lend this tab's payload to the drawer for as long as the tab is mounted.
 *
 * `key` must be stable per tab — it is what lets a re-render replace the previous resolver
 * rather than accumulate copies of it.
 */
export function useRegisterResolver(key: string, resolver: Resolver) {
  const ctx = useContext(ResolverContext);
  useEffect(() => {
    if (!ctx) return;
    return ctx.register(key, resolver);
  }, [ctx, key, resolver]);
}

// ------------------------------------------------------------------ URL state

/**
 * The selected resource, read from and written to `?res=`.
 *
 * `select(null)` removes the parameter rather than blanking it, so a closed drawer leaves no
 * trace in the URL and Back does not step through a series of empty states.
 */
export function useResourceSelection() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('res');

  const ref = useMemo(() => refFromParam(raw, isKind), [raw]);

  const select = useCallback(
    (next: ResourceRef | null) => {
      setParams(
        prev => {
          const p = new URLSearchParams(prev);
          if (next) p.set('res', refToParam(next));
          else p.delete('res');
          return p;
        },
        // Replace, not push. A drawer is a look, not a destination: pushing every peek would
        // make Back walk the operator through twenty resources instead of leaving the page.
        { replace: true }
      );
    },
    [setParams]
  );

  return { ref, select };
}

// ------------------------------------------------------------------ the link

/**
 * A clickable resource.
 *
 * A real `<button>`, not a styled `<div>`: it must be reachable by Tab and activate on Enter and
 * Space, and every one of these is inside a table an operator may be driving from the keyboard
 * at 3am. The dotted underline is the shared visual language for "this goes somewhere" — colour
 * alone would not survive a monochrome display or a red-green operator.
 */
export function ResourceLink({
  refTo,
  children,
  tone,
  className = ''
}: {
  refTo: ResourceRef;
  children?: ReactNode;
  /** Renders a status dot before the label — for rows whose health is the point. */
  tone?: Tone;
  className?: string;
}) {
  const { select } = useResourceSelection();
  const label = children ?? refTo.container ?? refTo.name;

  return (
    <button
      type="button"
      onClick={() => select(refTo)}
      title={`${refTo.kind} ${refTo.namespace ? `${refTo.namespace}/` : ''}${refTo.name}${
        refTo.container ? ` · ${refTo.container}` : ''
      } — open details`}
      className={`inline-flex max-w-full items-center gap-1.5 text-left underline decoration-dotted decoration-line underline-offset-[3px] transition-colors hover:text-accent hover:decoration-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${className}`}
    >
      {tone && <Dot tone={tone} />}
      <span className="truncate">{label}</span>
    </button>
  );
}

// ------------------------------------------------------------------ the drawer

/**
 * Resolve a ref to its row. Supplied by the page, because the page is the thing holding data.
 *
 * Returning `undefined` means "not in what I have" — a genuine and common answer, since a ref
 * can outlive a rename or point at a namespace the current filter excludes. The drawer says so
 * rather than rendering an empty shell that reads as "this resource has no fields".
 */
export type ResourceResolver = (ref: ResourceRef) => unknown | undefined;

export function ResourceDetailDrawer({
  resolve,
  extraFor
}: {
  /** The page's own resolver. Tab-registered resolvers are consulted after it. */
  resolve: ResourceResolver;
  /**
   * Optional per-ref extras the page can supply — an events list, a log shortcut.
   *
   * Receives the resolved `row` as well as the rendered view, because the useful next step
   * usually depends on a field the renderer deliberately turned into prose: "open the log of the
   * instance before the last restart" is only worth offering when `restarts > 0`, and by the time
   * the view exists that number is a formatted string inside `fields`. Re-parsing it back out
   * would be a second, worse source of truth.
   */
  extraFor?: (ref: ResourceRef, view: ResourceView, row: unknown) => ReactNode;
}) {
  const { ref, select } = useResourceSelection();
  const ctx = useContext(ResolverContext);
  // Subscribing to the counter is what re-renders the drawer when a tab mounts and registers the
  // resolver that owns `ref.kind`. Read before the early return, because a conditional hook is
  // a different bug in the same place.
  useContext(ResolverVersionContext);
  if (!ref) return null;

  const def = RESOURCE_REGISTRY[ref.kind];
  const row = resolve(ref) ?? ctx?.resolve(ref);

  const body = row === undefined ? null : def.render(row, ref);

  return (
    <DetailPanel
      title={<span className="mono">{ref.container ?? ref.name}</span>}
      subtitle={`${ref.namespace ? `${ref.namespace} · ` : ''}${ref.kind}`}
      onClose={() => select(null)}
      inlineClassName="sticky top-[84px] max-h-[calc(100vh-100px)] rounded-[8px] border border-line"
    >
      {body === null ? (
        <Section label="Not in view">
          <p className="text-[13px] text-muted">
            This page does not currently hold <span className="mono">{ref.kind}</span>{' '}
            <span className="mono">
              {ref.namespace ? `${ref.namespace}/` : ''}
              {ref.name}
            </span>
            . It may have been renamed or removed, or a namespace filter may be excluding it — the
            link was followed correctly, the object is not in the data this page fetched.
          </p>
        </Section>
      ) : (
        <>
          {body.status && (
            <Section label="Status">
              <div className="pb-1">
                <Pill tone={body.tone}>{body.status}</Pill>
              </div>
            </Section>
          )}

          <Section label="Identity">
            {body.identity.map(fld => (
              <Field key={fld.label} label={fld.label} value={fld.value} mono={fld.mono} />
            ))}
            <CopyRow ref_={ref} />
          </Section>

          <Section label="Details">
            {body.fields.map(fld => (
              <Field key={fld.label} label={fld.label} value={fld.value} mono={fld.mono} />
            ))}
          </Section>

          {body.extra && <Section label="More">{body.extra}</Section>}

          <RelatedResources related={body.related} />

          {extraFor?.(ref, body, row)}
        </>
      )}
    </DetailPanel>
  );
}

/**
 * Copy the resource's coordinates.
 *
 * The one non-navigation affordance in the drawer, and it writes to the clipboard, never to the
 * cluster. It exists because the actual next step after investigating here is almost always a
 * `kubectl` command elsewhere, and retyping a 40-character generated name is where transcription
 * errors come from.
 */
function CopyRow({ ref_ }: { ref_: ResourceRef }) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (what: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied(null), 1500);
      },
      // A clipboard write can be refused (no permission, insecure context). Say nothing
      // rather than claiming a copy that did not happen.
      () => setCopied(null)
    );
  };

  const kubectl = `kubectl get ${ref_.kind.toLowerCase()} ${ref_.name}${
    ref_.namespace ? ` -n ${ref_.namespace}` : ''
  } -o yaml`;

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-2">
      <CopyBtn label="Copy name" active={copied === 'name'} onClick={() => copy('name', ref_.name)} />
      {ref_.namespace && (
        <CopyBtn
          label="Copy namespace"
          active={copied === 'ns'}
          onClick={() => copy('ns', ref_.namespace as string)}
        />
      )}
      <CopyBtn label="Copy kubectl get" active={copied === 'kubectl'} onClick={() => copy('kubectl', kubectl)} />
    </div>
  );
}

function CopyBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[4px] border border-line px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
    >
      {active ? 'Copied' : label}
    </button>
  );
}

/**
 * "Where else to look" — the next *investigation*, as distinct from the next *object*.
 *
 * `RelatedResources` above answers "what is this connected to" and every entry there is another
 * resource. This answers a different question: "I have seen what this thing is, now where is the
 * evidence" — its entries are screens, not objects. A pod's log, a workload's events, the
 * decisions that produced a violation. Keeping them in a separate section is the point; folding
 * a log link into a list of Kinds would make it read as one more resource to inspect rather than
 * as the thing to do next.
 *
 * Rendered as one row per step with the reason on the right, because an operator at 3am picking
 * between three onward links needs to know why each one is offered, and a bare list of verbs
 * ("Logs", "Events", "Decisions") does not say which answers the question they actually have.
 *
 * Every entry is a navigation. There is no action here and there must never be one — this is the
 * most plausible place in the product for a well-meaning "Restart pod" to be added, sitting as it
 * does right beside the evidence that a pod is unhealthy, and the read-only guarantee is what
 * makes this console safe to hand to someone at 3am.
 */
export interface InvestigationStep {
  /** The affordance's label. A verb phrase — this is a thing to do, not a thing to read. */
  label: string;
  /** Why it is offered. Rendered muted, to the right. */
  why: string;
  onClick: () => void;
}

export function RelatedInvestigationLinks({ steps }: { steps: InvestigationStep[] }) {
  if (!steps.length) return null;
  return (
    <Section label="Where else to look">
      <ul className="divide-y divide-line">
        {steps.map(s => (
          <li key={s.label} className="flex items-baseline justify-between gap-3 py-1.5">
            <button
              type="button"
              onClick={s.onClick}
              title={s.why}
              className="shrink-0 text-left text-[13px] font-medium underline decoration-dotted decoration-line underline-offset-[3px] transition-colors hover:text-accent hover:decoration-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              {s.label}
            </button>
            <span className="text-right text-[12px] text-muted">{s.why}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * The Related panel — how an investigation moves. A Deployment leads to its Pods, a Pod to its
 * Node and its containers, an APIRule to its backing Service.
 *
 * Grouped by relation so that a workload with forty pods reads as one "Pod" heading rather than
 * forty repetitions of the word, and each group is capped: past a couple of dozen entries the
 * panel stops being navigation and becomes a second table. The count in the heading is always
 * the true total, so a capped list never understates what is there.
 */
const MAX_PER_RELATION = 24;

export function RelatedResources({ related }: { related: ResourceView['related'] }) {
  const groups = useMemo(() => {
    const m = new Map<string, ResourceView['related']>();
    for (const r of related) {
      const list = m.get(r.relation);
      if (list) list.push(r);
      else m.set(r.relation, [r]);
    }
    return [...m.entries()];
  }, [related]);

  if (!groups.length) return null;

  return (
    <>
      {groups.map(([relation, items]) => (
        <Section key={relation} label={`${relation} (${items.length})`}>
          <ul className="divide-y divide-line">
            {items.slice(0, MAX_PER_RELATION).map(r => (
              <li
                key={`${r.ref.kind}/${r.ref.namespace}/${r.ref.name}/${r.ref.container ?? ''}`}
                className="flex items-baseline justify-between gap-3 py-1"
              >
                <ResourceLink refTo={r.ref} className="mono text-[13px]" />
                {r.note && <span className="shrink-0 text-[12px] text-muted">{r.note}</span>}
              </li>
            ))}
          </ul>
          {items.length > MAX_PER_RELATION && (
            <p className="pt-1 text-[12px] text-muted">
              Showing {MAX_PER_RELATION} of {items.length}. The full list is in the tab this resource
              belongs to.
            </p>
          )}
        </Section>
      ))}
    </>
  );
}
