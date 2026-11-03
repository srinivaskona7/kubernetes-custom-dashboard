/** Customer-facing network workspace: edge traffic, service flows, and connectivity configuration. */
import { lazy, Suspense } from 'react';
import { SubTabs, useUrlSection } from '../../components/SubTabs';
import { Skeleton } from '../../components/ui';
import { TAB_SECTIONS } from './tabs';

const NetworkOverview = lazy(() => import('./NetworkOverview'));
const TrafficTab = lazy(() => import('./TrafficTab'));
const TracesTab = lazy(() => import('./TracesTab'));

const VIEWS = TAB_SECTIONS.network;

type View = (typeof VIEWS)[number]['id'];

export default function NetworkOperationsTab({ id, onViewLogs }: {
  id: string;
  onViewLogs: (namespace: string, pod: string, container?: string | null, opts?: { previous?: boolean }) => void;
}): JSX.Element {
  const [view, setView] = useUrlSection<View>('networkView', VIEWS, VIEWS[0].id);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pt-4"><SubTabs sections={VIEWS} active={view} onSelect={setView} /></div>
      <Suspense fallback={<div className="px-5 pt-4"><Skeleton rows={4} /></div>}>
        {view === 'overview' && <NetworkOverview id={id} />}
        {view === 'edge' && <TrafficTab id={id} onViewLogs={onViewLogs} />}
        {view === 'flows' && <TracesTab id={id} />}
      </Suspense>
    </div>
  );
}
