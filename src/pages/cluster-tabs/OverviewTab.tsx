/**
 * The cluster Overview — what to look at on this cluster, and the way into the tab that owns it.
 *
 * ## The two verdicts, and why they are two
 *
 * Each tile carries a `state` (completeness — did every read succeed?) and a `health` (findings —
 * is what came back healthy?). The first version of this screen had only the first, and that was
 * a real defect rather than an omission: on a cluster where every read is granted and answers, a
 * pair of crashlooping containers produced seventeen `state: 'ok'` groups, so the tab rendered
 * seventeen green pills and the sentence *"Nothing to triage on this cluster"* over a cluster with
 * something plainly wrong with it. Completeness and health are different questions and this screen
 * keeps them apart all the way to the pixel.
 *
 * ## It still owns no fact
 *
 * The numbers on the tiles are **relayed, never computed here**. `srv/fleet/signals.js` reads each
 * one out of the owning collector's own payload, from the same fan-out result and the same cache
 * entry the tab behind the tile reads — so "3 crashlooping" here and the three rows on the
 * Workloads tab are the same sweep. There is still no node table, no workload list and no capacity
 * bar on this screen: the count is the headline, the tab is the detail, and having the detail twice
 * is how two screens come to disagree.
 *
 * ## Six pillars, not seventeen tiles
 *
 * This grid used to carry every summary group the server produces, plus two link-only tiles and one
 * tile for a subject no screen renders. Eighteen cells is not a triage surface — it is an index, and
 * the sidebar rail is already the index. Worse, several of the cells false-alarmed on a perfectly
 * standard cluster: `Storage & quotas` went warn because a cluster had no ResourceQuotas (which is
 * the default), `Admission & policy` warned about PDB drain blockers on single-replica system
 * workloads, and `Namespace hygiene` reported a finding per namespace for conventions this console
 * never agreed to enforce. An Overview that cries wolf three times on a healthy cluster trains the
 * operator to skip it.
 *
 * So the grid is now the six topics that are worth a glance on every cluster. Nothing was made
 * unreachable: every tab still has a permanent link in the rail, and every metric that left this
 * screen is still rendered — and still counted — by the tab that owns it. The two link-only tiles
 * went for the same reason and not because their subjects got cheaper: a tile whose whole content is
 * "no verdict, but the tab is over there" is a second copy of a rail link, wearing the costume of a
 * verdict.
 *
 * That is also why `Topic` has no nullable fields any more. `key: null` and `tab: null` existed only
 * for those three cells, and they are what forced the tile to carry apologies — "Not summarised —
 * too expensive to poll", "Collected by the server; no screen renders it yet". With the types total,
 * every tile has a verdict and a real destination by construction, and the apologies have nothing
 * left to describe.
 *
 * Everything arrives in one request, `GET /clusters/:id/summary`.
 *
 * ## No identity card here either
 *
 * This tab used to end with a "How this cluster is read" card — API server, namespace/service
 * account, onboarding route, renewability. Credentials (`?tab=tokens`) owns every one of those
 * facts and the renew action beside them, and `ClusterDetail` already banners a credential that
 * cannot renew itself above *every* tab. Stating the identity twice is the duplication the rest of
 * this docstring is about.
 */
import { useCallback, useMemo } from 'react';
import { api, type GroupSummary, type SummaryGroupKey, type TileStats } from '../../api';
import { ErrorBanner, InfoTip, Pill } from '../../components/ui';
import { Icon, type IconName } from '../../components/icons';
import { Section } from '../../components/layout';
import { RANK, TONE_OF, WORD_OF, phrase } from '../../components/health-vocabulary';
import { useAsync } from '../../useAsync';
import { NamespacesTile } from './NamespacesTile';
import { STAT_FILL, barLabel, headlinePart, legendParts } from './tile-stats';
import { TAB_LABEL, TAB_SECTIONS, sectionLabel, type Tab } from './tabs';

/**
 * A topic on the grid.
 *
 * Every field is required, and that is the point. `key` guarantees the tile has a verdict to show;
 * `tab` and `section` guarantee it has somewhere real to go.
 *
 * `section` is the difference between a link and a correct link. Without it a tile named a tab and
 * the tab chose its own default section: "Namespace hygiene", "Security" and "Admission & policy"
 * all pointed at Security & Compliance and all three arrived at `isolation`, because `useSection`
 * silently falls back whenever `?section=` is not one of the target tab's ids. Two of the three
 * therefore landed on a screen that did not contain what the tile had just counted — and looked
 * deliberate doing it. Eight of the seventeen tiles were wrong this way.
 *
 * The ids are checked against `TAB_SECTIONS` by `test/fleet/overview-tile-destinations.test.js`,
 * because a wrong id here cannot fail at runtime: it lands somewhere plausible instead.
 */
interface Topic {
  key: SummaryGroupKey;
  label: string;
  what: string;
  icon: IconName;
  tab: keyof typeof TAB_SECTIONS;
  section: string;
}

function topic<TargetTab extends keyof typeof TAB_SECTIONS>(value: Omit<Topic, 'tab' | 'section'> & {
  tab: TargetTab;
  section: (typeof TAB_SECTIONS)[TargetTab][number]['id'];
}): Topic {
  return value;
}

/**
 * The six topics worth a glance on every cluster, in reading order.
 *
 * Each label names the *subject*, not the tab — "Nodes & Capacity" rather than "Nodes & pods" —
 * because the line underneath already names the destination and an operator scanning the grid is
 * asking "what about this cluster", not "which screen is this".
 *
 * The eleven that left are not gone from the console, and the pruning was per-topic reasoning
 * rather than a quota:
 *
 *  - `capacity` and `topology` are the Nodes tab's own sub-sections; pillar 1 opens that tab, and
 *    two more tiles pointing into the same tab is an index, not a verdict.
 *  - `storage`, `compliance` and `policy` are the three that false-alarmed on a standard cluster
 *    (see the module docstring). Their metrics live on Storage & Quotas and Security & Compliance,
 *    unchanged and still counted.
 *  - `mesh`, `security`, `integrity` and `observability` are real signals and genuinely specialist:
 *    an operator who cares about sidecar coverage or APIService health goes to that tab on purpose.
 *  - `btpServices` had no screen at all, so its tile was a dead end by construction. `reliability`
 *    left for the same reason when its Namespaces & Workloads sub-tab was removed (2026-09-25).
 *
 * The order is the tab strip's order, so the Overview and the navigation describe the cluster in
 * the same sequence.
 */
const TOPICS: Topic[] = [
  topic({ key: 'health', label: 'Nodes & Capacity', what: 'nodes ready, pods running, requests vs allocatable', icon: 'nodes', tab: 'nodes', section: 'overview' }),
  topic({ key: 'workloads', label: 'Workloads & Controllers', what: 'ready vs desired across every controller', icon: 'workloads', tab: 'workloads', section: 'workloads' }),
  topic({ key: 'autoscaling', label: 'Autoscaling', what: 'HPAs at their ceiling, failed jobs', icon: 'autoscaling', tab: 'workloads', section: 'hpas' }),
  topic({ key: 'networking', label: 'Networking & Ingress', what: 'APIRules, Ingresses, Services, NetworkPolicies', icon: 'network', tab: 'networking', section: 'networking' }),
  topic({ key: 'certificates', label: 'TLS Certificates', what: 'expiry and Ingress TLS bindings', icon: 'security', tab: 'certificates', section: 'certificates' }),
  topic({ key: 'modules', label: 'Kyma Modules & Platform', what: 'installed modules, channels, states', icon: 'platform', tab: 'platform', section: 'modules' })
];

/**
 * The line under a tile's verdict: the findings if there are any, then the honesty about the read.
 *
 * Findings come first because they are what an operator acts on. `absent === true` outranks both,
 * because "this module is not installed" is a different and more useful answer than any verdict
 * about it — a cluster with no Istio is not a cluster with a broken Istio. `absent === null` is
 * *unresolved* and says nothing rather than guessing, the same contract `absentList` uses.
 */
function detailOf(s: GroupSummary): string | null {
  if (s.absent === true) return 'not installed on this cluster';
  const parts = s.signals.map(phrase);
  if (s.unavailable.length) {
    parts.push(`${s.unavailable.length} read${s.unavailable.length === 1 ? '' : 's'} refused: ${s.unavailable.join(', ')}`);
  }
  if (s.truncated.length) parts.push(`truncated: ${s.truncated.join(', ')}`);
  if (parts.length) return parts.join(' · ');
  if (s.health === 'unknown') return 'the cluster did not answer for this topic';
  return null;
}

export default function OverviewTab({
  id,
  onOpenTab
}: {
  id: string;
  onOpenTab: (tab: Tab, section?: string) => void;
}) {
  // `id` is the key, not just a dependency: without it a cluster→cluster move would leave the
  // previous cluster's verdicts on screen for a whole poll interval. See `useAsync`'s `key`.
  const { data, error, initial } = useAsync(
    useCallback(() => api.clusterSummary(id), [id]),
    30_000,
    id
  );

  /**
   * Worst first. The grid used to sit under a "Needs attention" list that did the triage, and
   * with that list gone an Attention tile could land fifteenth in a four-column grid with
   * nothing to draw the eye to it. Sorting by health rank does the same job as the list without
   * stating any finding twice — `sort` on a copy, and `RANK` is the one ordering the rail and
   * the pills already share. Ties keep the declared reading order, so a clean cluster looks
   * exactly as it did.
   */
  const ordered = useMemo(() => {
    if (!data) return TOPICS;
    const rank = (t: Topic) => {
      const s = data.groups[t.key];
      return s ? RANK[s.health] : RANK.unknown;
    };
    return [...TOPICS].sort((a, b) => rank(a) - rank(b));
  }, [data]);

  if (error && !data) return <ErrorBanner code={error.code} message={error.message} />;
  if (initial && !data) return <TileGridSkeleton />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <Section
        title="What to look at"
        hint="Worst first. Six topics, one verdict apiece, then the namespace inventory — open a tile for the rows behind its count."
      >
        {/* Separated tiles rather than the old gap-px divider grid. At eighteen cells the dense
            grid was right; at six the composition is a row of pillars, and three columns of
            genuinely separate cards is what makes each one worth reading rather than scanning past.
            Each tile therefore carries its own border — with `gap-4` there is no shared `bg-line`
            fill to draw the dividers, so without one the tiles would float unbounded. */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ordered.map(t => (
            <Tile key={t.key} topic={t} summary={data.groups[t.key]} onOpen={onOpenTab} />
          ))}
          {/* Last, not sorted in: it has no verdict to rank by. See NamespacesTile's header. */}
          <NamespacesTile id={id} onOpen={onOpenTab} />
        </div>
      </Section>
    </div>
  );
}

/**
 * One topic: its verdict, its headline count, and the way into the section that owns the rows.
 *
 * Every tile is a button now, so there is no longer a difference to explain. It used to be "a link
 * when a screen exists for it, a plain cell when one does not", which meant three of eighteen
 * identical-looking cells went nowhere and each had to apologise for itself in a line of grey text.
 * Deleting those three deleted the explanation with them.
 *
 * The destination is still named in words rather than left to a hover state: six cells that all
 * look clickable still have to say *where* they go, and `sectionLabel` returns `null` for a pair
 * that does not exist, so a wrong destination prints as the tab alone rather than as an invented
 * section name.
 */
function Tile({
  topic,
  summary,
  onOpen
}: {
  topic: Topic;
  summary: GroupSummary | undefined;
  onOpen: (tab: Tab, section?: string) => void;
}) {
  const section = sectionLabel(topic.tab, topic.section);
  const where = `${TAB_LABEL[topic.tab]}${section ? ` \u2192 ${section}` : ''}`;
  const detail = summary ? detailOf(summary) : null;

  return (
    <div className="group relative rounded-[8px] border border-line bg-base px-4 py-3.5 text-left transition-colors hover:border-line-strong hover:bg-raised">
      <button
        type="button"
        onClick={() => onOpen(topic.tab, topic.section)}
        className="absolute inset-0 rounded-[8px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        aria-label={`${topic.label} \u2014 open ${where}`}
      />
      <div className="pointer-events-none relative flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-[14px] font-medium text-text">
          <Icon name={topic.icon} size={16} className="text-muted" />
          <span>{topic.label}</span>
          <span className="pointer-events-auto relative z-10">
            <InfoTip title={topic.label} text={`Verdict driven by ${topic.what}.`} />
          </span>
        </span>
        {/* A group the server did not send is *unknown*, not clear — this can only happen when the
            browser is newer than the server, which is exactly when a fabricated green would
            mislead most. */}
        {summary ? (
          <Pill tone={TONE_OF[summary.health]}>{WORD_OF[summary.health]}</Pill>
        ) : (
          <Pill tone="unknown">Unknown</Pill>
        )}
      </div>
      {summary?.stats && <StatsBlock stats={summary.stats} />}
      {/* With stats, the counts replace the topic's description; the findings and the honesty about
          the read still print beneath them. Without (a failed read, an older server), as before. */}
      {!(summary?.stats && !detail) && (
        <p className="pointer-events-none relative mt-2 text-[13px] leading-snug text-muted">{detail ?? topic.what}</p>
      )}
      <p className="pointer-events-none relative mt-2 text-[12px] text-accent/80 group-hover:text-accent group-focus-within:text-accent">
        Opens {where}
      </p>
    </div>
  );
}

/**
 * A tile's high-level stats, laid out like the Namespaces tile: a headline of counts, one split bar,
 * a legend. Deviating counts take their tone's colour, so a deviation reads before the verdict's
 * sentence does. An unread count prints "unavailable" and an unread list draws no bar.
 */
function StatsBlock({ stats }: { stats: TileStats }) {
  const { split } = stats;
  return (
    <>
      <p className="pointer-events-none relative mt-2 text-[13px] text-text">
        {stats.headline.map((h, i) => {
          const part = headlinePart(h, stats.atLeast);
          const tone = part.tone === 'bad' ? 'text-bad' : part.tone === 'warn' ? 'text-warn' : '';
          return (
            <span key={h.label}>
              {i > 0 && <span className="text-muted"> · </span>}
              <span className="whitespace-nowrap">
              {part.count === null ? (
                <span className="text-muted">{part.text}</span>
              ) : (
                <>
                  <span className={`mono tabular-nums font-semibold ${tone}`}>{part.count}</span>{' '}
                  <span className={tone}>{part.text}</span>
                </>
              )}
              </span>
            </span>
          );
        })}
      </p>
      {split && split.total > 0 && (
        <>
          <div
            className="pointer-events-none relative mt-2 flex h-[6px] w-full overflow-hidden rounded-[2px] bg-raised"
            role="img"
            aria-label={barLabel(split)}
          >
            {split.parts.map(p =>
              p.count > 0 ? (
                <span key={p.key} className={`h-full ${STAT_FILL[p.tone]}`} style={{ width: `${(p.count / split.total) * 100}%` }} />
              ) : null
            )}
          </div>
          <p className="pointer-events-none relative mt-1.5 flex flex-wrap gap-x-3 text-[12px] text-muted">
            {legendParts(split).map(p => (
              <span key={p.key} className="inline-flex items-center gap-1">
                <span className={`inline-block h-[8px] w-[8px] rounded-full ${STAT_FILL[p.tone]}`} aria-hidden />
                <span className="mono tabular-nums text-text">{p.count}</span> {p.label}
              </span>
            ))}
          </p>
        </>
      )}
    </>
  );
}

/** Per-tile skeletons rather than one page-level spinner: the grid's shape is the information. */
function TileGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {TOPICS.map(t => (
        <div key={t.key} className="rounded-[8px] border border-line bg-base px-4 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-[14px] font-medium text-text">
              <Icon name={t.icon} size={16} className="text-muted" />
              {t.label}
            </span>
            <span className="h-[24px] w-[74px] animate-pulse rounded-[6px] bg-raised" />
          </div>
          <div className="mt-2.5 h-[13px] w-4/5 animate-pulse rounded bg-raised" />
          <div className="mt-2.5 h-[12px] w-2/5 animate-pulse rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}
