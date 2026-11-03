/**
 * Ingress & Traffic → Network Path.
 *
 * How a request enters and a connection leaves, hop by hop, left to right. Every hop is drawn from the
 * object that declares it (`path-view.ts` holds the rules and says which); a hop whose read failed
 * reads "Unavailable" with the reason, never a zero. Below the lanes, every destination the name index
 * knows with the object that names it, and the external upstreams the sidecar sample actually reached.
 *
 * Nothing here comes from the ingress access-log window, so this screen does not gate on
 * `ingressWasRead`: a cluster whose gateway logs were refused still has a load balancer and a NAT.
 * Client addresses never appear; the only addresses are the cluster's own and its destinations'.
 */
import type { IngressNetworkPath, PathDestination, PathObservedEgress } from '../../../api';
import { NUMERIC, DataTable, type Column } from '../../../components/DataTable';
import { CellList, Dot, Empty, type Tone } from '../../../components/ui';
import { Unavailable } from '../../../components/unavailable';
import { IngressCard, Num, ReadGap } from './parts';
import { notFromServer } from './edge-view';
import { destinationSourceGaps, egressHops, ingressHops, observedAddress, observedLabel, truncateObjects, type HopState, type PathHop } from './path-view';

const STATE_TONE: Record<Exclude<HopState, 'info'>, Tone> = { ok: 'ok', warn: 'warn', bad: 'bad', unavailable: 'unknown' };

/** What each `source` in the name index means, in the operator's words. */
const SOURCE_LABEL: Record<string, string> = {
  networkpolicy: 'NetworkPolicy annotation',
  'networkpolicy-prose': 'NetworkPolicy description',
  telemetry: 'Telemetry pipeline',
  'ingress-lb': 'Ingress load balancer DNS'
};

function HopCard({ hop, step }: { hop: PathHop; step: number }) {
  return (
    // `hop-<id>` is the anchor a Network Path Problems row scrolls to (problems.ts pathProblems), so
    // only a warn or bad hop carries it. The one id both lanes share, `pod`, is never either, so no
    // two cards end up with one id.
    <li id={hop.state === 'bad' || hop.state === 'warn' ? `hop-${hop.id}` : undefined} className="flex min-w-0 flex-col gap-2 rounded-[8px] border border-line bg-surface px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="mono text-[11px] text-muted">{String(step).padStart(2, '0')}</span>
        {/* A hop that checked nothing gets a hollow ring, never a filled dot. */}
        {hop.state === 'info' ? <span className="inline-block size-2 shrink-0 rounded-full border border-muted/60" aria-hidden /> : <Dot tone={STATE_TONE[hop.state]} />}
        <span className="min-w-0 break-words text-[13px] font-semibold text-text">{hop.title}</span>
      </div>
      {hop.state === 'unavailable' ? (
        <p className="text-[12px]">
          <Unavailable what={hop.title} why={hop.reason ?? undefined} size="sm" />
        </p>
      ) : (
        <>
          {hop.facts.length > 0 && (
            <dl className="space-y-1">
              {hop.facts.map(f => (
                <div key={f.label} className="min-w-0">
                  <dt className="text-[11px] text-muted">{f.label}</dt>
                  <dd className="mono min-w-0 break-words text-[12px] text-text">
                    {Array.isArray(f.value) ? <CellList items={f.value} empty="none" className="mono text-[12px]" /> : f.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {hop.reason && <p className={`text-[12px] ${hop.state === 'bad' ? 'text-bad' : hop.state === 'warn' ? 'text-warn' : 'text-muted'}`}>{hop.reason}</p>}
        </>
      )}
      <p className="mt-auto border-t border-line pt-2 text-[12px] text-muted">{hop.why}</p>
    </li>
  );
}

/**
 * One lane: hop cards in reading order, wrapping onto a second row at narrow widths. Ingress's ten
 * hops read as two rows of five; egress's six fit one row.
 */
const LANE_COLS = { 5: 'xl:grid-cols-5', 6: 'xl:grid-cols-6' } as const;

function Lane({ hops, cols }: { hops: PathHop[]; cols: keyof typeof LANE_COLS }) {
  return (
    <ol className={`grid grid-cols-2 gap-3 md:grid-cols-3 ${LANE_COLS[cols]}`}>
      {hops.map((h, i) => (
        <HopCard key={h.id} hop={h} step={i + 1} />
      ))}
    </ol>
  );
}

export function IngressPath({ path }: { path: IngressNetworkPath | null | undefined }): JSX.Element {
  if (!path) {
    return (
      <ReadGap
        status={
          path === null
            ? { ...notFromServer('Network path'), why: 'the network path could not be assembled on this read' }
            : notFromServer('Network path')
        }
      />
    );
  }
  const inbound = ingressHops(path);
  const outbound = egressHops(path);
  const { destinations, observed } = path.egress;
  // A source that was not read makes an empty list unknown and a non-empty one partial.
  const sourceGaps = destinationSourceGaps(path.egress.destinationSources);
  const where = [path.cluster.provider, path.cluster.region].filter(Boolean).join(' ');

  const destinationColumns: Column<PathDestination>[] = [
    {
      key: 'destination',
      header: 'Destination',
      pin: true,
      max: '360px',
      sortValue: d => d.display,
      render: d => (
        <span className="block truncate text-[13px]" title={d.display}>
          {d.display}
        </span>
      )
    },
    {
      key: 'source',
      header: 'Named from',
      max: '220px',
      sortValue: d => d.source,
      render: d => <span className="text-[12px] text-muted">{SOURCE_LABEL[d.source] ?? d.source}</span>
    },
    {
      key: 'ips',
      header: 'Addresses',
      max: '200px',
      sortValue: d => d.ips.length,
      render: d => <CellList items={d.ips} empty="none named" className="mono text-[12px]" />
    },
    {
      key: 'objects',
      header: 'Declared by',
      // First to go under 900px: the Named from column still says where each name came from.
      priority: 3,
      max: '360px',
      sortValue: d => d.objects[0] ?? null,
      render: d => {
        const { shown, more } = truncateObjects(d.objects, 2);
        return (
          <span className="block min-w-0" title={d.objects.join('\n')}>
            <CellList items={shown} empty="no object" className="mono text-[12px] text-muted" />
            {more && <span className="block text-[12px] text-muted">{more}</span>}
          </span>
        );
      }
    }
  ];

  const observedColumns: Column<PathObservedEgress>[] = [
    {
      key: 'destination',
      header: 'Destination',
      pin: true,
      max: '360px',
      sortValue: o => observedLabel(o),
      render: o => (
        <span className="block min-w-0" title={observedAddress(o)}>
          <span className="block truncate text-[13px]">{observedLabel(o)}</span>
          {o.display && <span className="mono block truncate text-[11px] text-muted">{observedAddress(o)}</span>}
        </span>
      )
    },
    {
      key: 'requests',
      header: 'Requests',
      ...NUMERIC,
      width: '104px',
      sortValue: o => o.requests,
      render: o => <Num value={o.requests} />
    },
    {
      key: 'callers',
      header: 'Callers',
      max: '420px',
      sortValue: o => o.callersTotal,
      render: o => {
        // `callers` may itself be capped server-side; `callersTotal` is the real count.
        const { shown } = truncateObjects(o.callers, 2);
        const rest = o.callersTotal - shown.length;
        const tail = rest > 0 ? `and ${rest} more` : null;
        return (
          <span className="block min-w-0" title={o.callers.join('\n')}>
            <CellList items={shown} empty="none recorded" className="mono text-[12px] text-muted" />
            {tail && <span className="block text-[12px] text-muted">{tail}</span>}
          </span>
        );
      }
    }
  ];

  return (
    <div className="space-y-5">
      <IngressCard
        title="Ingress path"
        label={where || undefined}
        hint="How a request from the Internet reaches a pod, each hop from the object that declares it."
      >
        <Lane hops={inbound} cols={5} />
      </IngressCard>

      <IngressCard title="Egress path" hint="How a connection from a pod reaches an external destination, and the addresses it leaves from.">
        <Lane hops={outbound} cols={6} />
      </IngressCard>

      <IngressCard
        title="Named destinations"
        label={String(destinations.length)}
        hint="Every external address the cluster's own objects name, and which object names it."
      >
        {sourceGaps.length > 0 && destinations.length > 0 && (
          <p className="mb-2 text-[12px] text-warn">Partial list: {sourceGaps.join('; ')}.</p>
        )}
        {sourceGaps.length > 0 && destinations.length === 0 ? (
          <ReadGap status={{ ...notFromServer('Named destinations'), why: sourceGaps.join('; ') }} />
        ) : (
          <DataTable
            columns={destinationColumns}
            rows={destinations}
            rowKey={d => `${d.source}:${d.display}`}
            empty={<Empty title="No object names an external destination" hint="No NetworkPolicy annotation or telemetry pipeline names an address." />}
          />
        )}
      </IngressCard>

      {observed && (
        <IngressCard
          title="Observed egress"
          label={String(observed.length)}
          hint="External upstreams the sidecars in this sample connected to. A sample, not an inventory."
        >
          <DataTable
            columns={observedColumns}
            rows={[...observed].sort((a, b) => b.requests - a.requests)}
            rowKey={o => observedAddress(o)}
            empty={<Empty title="No external upstream in the sample" hint="Every sampled sidecar connection went to a cluster-internal address." />}
          />
        </IngressCard>
      )}
    </div>
  );
}
