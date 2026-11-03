/**
 * Observability Tab: Telemetry pipelines, agent coverage, and distributed traces/service flows.
 * Prometheus-Operator discovery & wiring has been cleanly excluded as requested.
 */
import { lazy, Suspense } from 'react';
import { SubTabs, useUrlSection } from '../../components/SubTabs';
import { Skeleton } from '../../components/ui';
import { TAB_SECTIONS } from './tabs';
import { ObservabilitySection } from './ModulesIntegrityTab';

const TracesTab = lazy(() => import('./TracesTab'));

const SECTIONS = TAB_SECTIONS.observability;
type SectionId = (typeof SECTIONS)[number]['id'];

export default function ObservabilityTab({ id }: { id: string }): JSX.Element {
  const [section, setSection] = useUrlSection<SectionId>('section', SECTIONS, SECTIONS[0].id);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pt-4">
        <SubTabs sections={SECTIONS} active={section} onSelect={setSection} />
      </div>
      <div className="flex-1 min-h-0 px-5 py-4">
        <Suspense fallback={<Skeleton rows={6} />}>
          {section === 'telemetry' && <ObservabilitySection id={id} hidePrometheusOperator />}
          {section === 'traces' && <TracesTab id={id} />}
        </Suspense>
      </div>
    </div>
  );
}
