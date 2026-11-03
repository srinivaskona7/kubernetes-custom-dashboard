/**
 * Events — the namespace's event stream, narrowed to objects this release actually owns or reaches.
 *
 * ## How the narrowing is done, and why it matters
 *
 * The server joins on `involvedObject` — the Kind, namespace and name Kubernetes itself recorded on
 * the Event. It never matches on a name prefix, which is the tempting shortcut and the wrong one:
 * a release called `api` would collect every event from `api-gateway`, `api-tests` and
 * `apiserver-proxy`, and an operator debugging a failed rollout would be reading another
 * component's failures. So an event appears here only when its `involvedObject` resolves to a row
 * on the Resources tab.
 *
 * ## What the coverage line is for
 *
 * Kubernetes expires Events after roughly an hour, and this read is capped and namespace-scoped.
 * An empty list therefore means "nothing in the last hour, in this namespace, within the cap" — not
 * "nothing ever happened". The coverage line says that on screen, because a quiet event list is the
 * easiest place in this console to read a limit as an all-clear.
 */
import { useMemo } from 'react';
import { COLUMN_INFO } from '../../components/table/column-info';
import type { HelmRelatedData, HelmRelatedEvent } from '../../api';
import { Column, DataTable } from '../../components/DataTable';
import { Section } from '../../components/layout';
import { Empty, Pill, type Tone } from '../../components/ui';
import { ago } from '../../format';

function typeTone(type: string): Tone {
  if (type === 'Warning') return 'warn';
  if (type === 'Normal') return 'ok';
  return 'unknown';
}

export function HelmEvents({
  data,
  onSelectResource
}: {
  data: HelmRelatedData;
  onSelectResource: (id: string | null) => void;
}): JSX.Element {
  const byId = useMemo(() => new Set(data.resources.map(r => r.id)), [data.resources]);
  const idOf = (e: HelmRelatedEvent) => `${e.resource.kind}/${e.resource.namespace ?? '-'}/${e.resource.name}`;

  const warnings = data.events.filter(e => e.type === 'Warning').length;

  const columns: Column<HelmRelatedEvent>[] = [
    {
      key: 'at',
      header: 'Timestamp',
      pin: true,
      priority: 1,
      width: '120px',
      render: e => (
        <span className="mono" title={e.at ?? undefined}>
          {e.at ? ago(e.at) : 'not recorded'}
        </span>
      )
    },
    {
      key: 'type',
      header: 'Type',
      priority: 1,
      width: '100px',
      render: e => <Pill tone={typeTone(e.type)}>{e.type}</Pill>
    },
    {
      key: 'reason',
      header: 'Reason',
      priority: 1,
      width: '170px',
      render: e => <span className="mono">{e.reason ?? 'not recorded'}</span>
    },
    {
      key: 'message',
      header: 'Message',
      priority: 1,
      /**
       * `max-w-[70ch]` capped the span, not the column, so the column was free to grow to ~70
       * characters of mono text — several hundred pixels on top of the eight sibling columns, whose
       * declared widths already sum to 1070px. An event message is the longest string on this page.
       *
       * Not measured live: this release had no events inside the API server's retention window, so
       * unlike the other tables on this page the number here is derived from the sibling budget
       * (1070px of declared widths, 370px of it priority 3 and shed under `wide`) rather than from a
       * rendered row. The guard test enforces that the ceiling exists; the exact value wants a
       * re-measure on a release that is actively churning.
       */
      max: '320px',
      render: e => (
        <span className="block truncate" title={e.message}>
          {e.message}
        </span>
      )
    },
    {
      key: 'source',
      header: 'Source',
      priority: 3,
      width: '150px',
      render: e => (
        <span className="mono text-muted" title="The controller that reported this event">
          {e.source ?? 'not recorded'}
        </span>
      )
    },
    {
      key: 'resource',
      header: 'Affected resource',
      priority: 1,
      max: '230px',
      render: e => {
        const id = idOf(e);
        const label = `${e.resource.kind}/${e.resource.name}`;
        if (!byId.has(id)) {
          return (
            <span
              className="mono text-muted"
              title="This object was in the release's live set when the event was recorded, but is not in it now."
            >
              {label}
            </span>
          );
        }
        return (
          <button
            type="button"
            onClick={() => onSelectResource(id)}
            className="mono max-w-full truncate text-left underline decoration-dotted decoration-line underline-offset-[3px] transition-colors hover:text-accent hover:decoration-accent"
            title={`Open ${label}`}
          >
            {label}
          </button>
        );
      }
    },
    {
      key: 'count',
      header: 'Count',
      priority: 2,
      align: 'right',
      width: '80px',
      render: e => <span className="mono">{e.count}</span>
    },
    {
      key: 'firstSeen',
      header: 'First seen',
      priority: 3,
      align: 'right',
      width: '110px',
      render: e => <span className="mono text-muted">{e.firstSeen ? ago(e.firstSeen) : '—'}</span>
    },
    {
      key: 'lastSeen',
      header: 'Last seen',
      info: COLUMN_INFO.lastSeen,
      priority: 3,
      align: 'right',
      width: '110px',
      render: e => <span className="mono text-muted">{e.lastSeen ? ago(e.lastSeen) : '—'}</span>
    }
  ];

  const coverage = [
    data.eventCoverage.namespaceOnly
      ? `Read from namespace ${data.release.namespace} only`
      : 'Read cluster-wide',
    `capped at ${data.eventCoverage.limit} events`,
    data.eventCoverage.truncated ? 'the cap was reached, so this list is a floor' : 'the cap was not reached',
    'Kubernetes expires Events after about an hour'
  ].join(' · ');

  return (
    <Section
      title="Events"
      label={String(data.events.length)}
      hint={`Joined to this release on each Event’s involvedObject — never on a name prefix.${warnings > 0 ? ` ${warnings} warning${warnings === 1 ? '' : 's'}.` : ''}`}
    >
      {!data.eventCoverage.readable && (
        <div className="mb-3 rounded-[8px] border border-warn/40 bg-warn/10 px-4 py-2.5 text-[13px] text-warn">
          <strong className="font-semibold">Events could not be read.</strong> This is not an empty event list — the
          read did not happen, so nothing here can be trusted as quiet.
        </div>
      )}
      <DataTable
        columns={columns}
        rows={data.events}
        rowKey={e => `${e.at ?? 'na'}|${idOf(e)}|${e.reason ?? ''}|${e.count}`}
        // `wide`, not `mid`: nine columns whose declared widths already total 1070px before Message,
        // in a container measured at 1132px — mid's 1000px trigger never fires there. Under `wide`
        // the priority-3 trio (Source, First seen, Last seen — 370px) sheds and the row fits.
        shed="wide"
        empty={
          <Empty
            title="No events for this release’s resources"
            hint={`Nothing in the window read. ${coverage}. A quiet list here is not proof that a rollout went well — check the Insights tab for live state.`}
          />
        }
      />
      {/* The empty state already carries `coverage` inside its hint, because an empty list is
          exactly where the caveat matters most and a reader must not have to look elsewhere for
          it. Repeating it underneath printed the same sentence twice on the same screen, which
          reads as two different facts. With rows present the footer is the only place it
          appears, so it stays. */}
      {data.events.length > 0 && <p className="mt-2 text-[12px] text-muted">{coverage}.</p>}
    </Section>
  );
}
