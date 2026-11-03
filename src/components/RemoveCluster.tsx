/**
 * De-register a cluster from the dashboard. One implementation, two places that render it.
 *
 * ## What it does, and the line it does not cross
 *
 * It deletes two local records: the cluster's registration and the token this dashboard holds
 * for it. **Nothing on the target cluster changes.** The `fleet-dashboard` namespace, the
 * `fleet-reader` ServiceAccount and its ClusterRole all stay exactly where they are, and the
 * server's response names the `kubectl` commands that would remove them — printed here, because
 * a console that quietly leaves objects behind on someone's cluster has told them nothing.
 * Forgetting a credential is not a Kubernetes mutation, which is why this control can exist on a
 * read-only console at all.
 *
 * ## Why it is typed
 *
 * The same action once sat as a plain button on the fleet table and in the detail header, and was
 * removed because a mis-click there blinds the fleet. What brings it back is a shape a mis-click
 * cannot reach: a two-step reveal, and then the cluster's own id typed out by hand. An "Are you
 * sure?" dialog is dismissed by reflex; a name typed character by character is the only
 * confirmation that requires having read which cluster it names.
 *
 * Re-onboarding is the undo, and the panel says so — the cost of being wrong here is a kubeconfig
 * and a token away from being repaired, and saying that is more useful than a warning implying it
 * is not.
 *
 * ## Why it is shared
 *
 * It renders in two places that reach the same decision from different directions: the cluster's
 * own Credentials tab (where the operator is already looking at the credential being deleted) and
 * the fleet Overview's detail panel (where they are looking at the fleet and have decided one
 * member does not belong). Both need the identical guard, and two copies of a guard is one copy
 * that eventually loses a step.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { rosterChanged } from '../roster-signal';
import { Section } from './layout';
import { Btn, Card } from './ui';

export default function RemoveCluster({
  id,
  displayName,
  canRemove,
  removable,
  /**
   * Called after a successful removal, with the server's list of what is still running on the
   * cluster.
   *
   * A caller that unmounts this component in response — the Overview does, because the row it was
   * rendered beside no longer exists — **takes over showing that list**. It names objects still
   * occupying someone else's cluster, and dropping it on the floor is how a console leaves litter
   * behind silently. A caller that stays mounted can ignore the argument; the panel below says it.
   */
  onRemoved,
  /**
   * `card` is the standalone panel the Credentials tab renders. `inline` drops the Card chrome for
   * the Overview detail rail, which is already a panel and would otherwise nest a box in a box.
   */
  variant = 'card'
}: {
  id: string;
  displayName: string;
  /** This deployment can write cluster records, and this account carries the admin scope. */
  canRemove: boolean;
  /** This particular record is deletable — a cluster baked into the image is not. */
  removable: boolean;
  onRemoved?: (leftBehind: string) => void;
  variant?: 'card' | 'inline';
}) {
  const navigate = useNavigate();
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setFailed(null);
    try {
      const out = await api.offboard(id);
      // Held on screen rather than navigating straight away: `leftBehind` names objects still
      // running on someone's cluster, and bouncing to the fleet would take it with it.
      setDone(out.leftBehind);
      // The sidebar rail lists the fleet on its own 30-second poll. Without this it keeps showing
      // a cluster the server has already forgotten until the next tick lands.
      rosterChanged();
      onRemoved?.(out.leftBehind);
    } catch (err) {
      const e = err as ApiError;
      setFailed(e.message || 'The removal was refused.');
    } finally {
      setBusy(false);
    }
  }

  const Shell = ({ title, children }: { title: string; children: React.ReactNode }) =>
    variant === 'card' ? (
      <Card title={title}>{children}</Card>
    ) : (
      <div className="mt-4 rounded-[7px] border border-line bg-raised/40 p-3">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">{title}</div>
        {children}
      </div>
    );

  if (done) {
    return (
      <Shell title="Removed from the fleet">
        <p className="text-[14px] text-text">
          <span className="mono">{displayName}</span> is no longer registered. Its token record is deleted.
        </p>
        <Section label="Still running on the cluster">
          <p className="mb-2 text-[13px] text-muted">{done}</p>
        </Section>
        <Btn variant="primary" onClick={() => navigate('/')}>
          Back to the fleet
        </Btn>
      </Shell>
    );
  }

  return (
    <Shell title="Remove from the fleet">
      <p className="text-[14px] text-muted">
        Deletes this dashboard&rsquo;s record of <span className="mono text-text">{displayName}</span> and the token it
        holds for it. Nothing on the cluster itself is changed — the fleet namespace, the reader account and its
        ClusterRole stay, and the commands to remove them are shown once this finishes. Adding the cluster again
        restores everything here.
      </p>

      {!canRemove ? (
        <p className="mt-3 text-[13px] text-warn">
          This account cannot de-register clusters. That needs the fleet admin role collection, on a deployment that
          can write the cluster Secret.
        </p>
      ) : !removable ? (
        <p className="mt-3 text-[13px] text-warn">
          <span className="mono">{id}</span> is defined in the image rather than onboarded here. Deleting the record
          would work until the next pod restart put it straight back — remove it from{' '}
          <span className="mono">srv/fleet/clusters.json</span> and rebuild instead.
        </p>
      ) : !armed ? (
        <div className="mt-3">
          <Btn variant="danger" onClick={() => setArmed(true)}>
            Remove this cluster…
          </Btn>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {/* The id is part of the field id, so two of these on one page — the Overview rail beside
              a tab, say — cannot end up sharing one label/control association. */}
          <label htmlFor={`offboard-confirm-${id}`} className="block text-[13px] text-text">
            Type <span className="mono text-bad">{id}</span> to confirm.
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={`offboard-confirm-${id}`}
              value={typed}
              onChange={e => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={id}
              className="mono h-8 w-full min-w-0 max-w-[260px] rounded-[6px] border border-line bg-raised px-2 text-[13px] text-text placeholder:text-muted focus:border-bad focus:outline-none"
            />
            <Btn
              variant="danger"
              disabled={busy || typed !== id}
              title={typed !== id ? 'The cluster id must match exactly' : `De-register ${id}`}
              onClick={() => void remove()}
            >
              {busy ? 'Removing…' : 'Remove'}
            </Btn>
            <Btn onClick={() => { setArmed(false); setTyped(''); setFailed(null); }} disabled={busy}>
              Cancel
            </Btn>
          </div>
          {failed && <p className="text-[13px] text-bad">{failed}</p>}
        </div>
      )}
    </Shell>
  );
}
