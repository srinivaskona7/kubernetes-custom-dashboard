/**
 * Access & Tokens, scoped to one cluster.
 *
 * The fleet-wide Token health page (`/tokens`) stays as its own global page — seeing every
 * cluster's expiry at once is exactly the cross-cluster comparison the lean sidebar keeps.
 * This tab is the single-cluster slice of the same data: the row that page would show for
 * this cluster, plus the renew action, without the cluster picker or the other N rows.
 *
 * It is also where a cluster is de-registered, for one reason: this is the page about the
 * credential, and de-registering is the act of deleting that credential and the record beside
 * it. The control itself lives in `components/RemoveCluster` — the fleet Overview's detail rail
 * renders the same one, so the typed confirmation cannot drift between the two places an
 * operator can reach it from.
 */
import { useCallback, useState } from 'react';
import { api, ApiError } from '../../api';
import { Field, Section } from '../../components/layout';
import RemoveCluster from '../../components/RemoveCluster';
import { Btn, Card, Empty, ErrorState, Pill, Skeleton } from '../../components/ui';
import { ago, duration } from '../../format';
import { seedCommand, TOKEN_LABEL, tokenTone } from '../../status';
import { useAsync } from '../../useAsync';

export default function TokensTab({ id }: { id: string }) {
  const { data, error, initial, reload } = useAsync(useCallback(() => api.tokens(), []), 30_000);  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const row = data?.clusters?.find(r => r.cluster.id === id) ?? null;

  async function renew() {
    setBusy(true);
    setNotice(null);
    try {
      const out = await api.renew(id);
      setNotice({ tone: 'ok', text: `Renewed — the new token expires ${out.expiresAt}.` });
      reload();
    } catch (err) {
      const e = err as ApiError;
      setNotice({
        tone: 'bad',
        text: e.code === 'RENEW_DISABLED' ? `Manual renewal is not enabled on this deployment. ${e.message}` : e.message
      });
    } finally {
      setBusy(false);
    }
  }

  if (initial) return <Skeleton rows={6} />;
  if (error) return <ErrorState code={error.code} message={error.message} />;
  if (!row) return <Empty title="No token record" hint="This cluster has no entry in the token health sweep yet." />;

  return (
    <div className="space-y-4">
      {notice && (
        <div className={`card px-4 py-3 text-[14px] ${notice.tone === 'ok' ? 'text-ok' : 'text-bad'}`}>{notice.text}</div>
      )}

      <Card
        title="Service account token"
        action={
          <Btn
            onClick={() => void renew()}
            disabled={busy || row.status === 'unseeded' || row.status === 'expired'}
            title={
              row.status === 'unseeded' || row.status === 'expired'
                ? 'Renewal mints the next token using the current one — there is no usable token to mint from'
                : 'Mint the next 24h token now'
            }
          >
            {busy ? 'Renewing…' : 'Renew now'}
          </Btn>
        }
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Section label="Token">
            <Field label="Status" value={<Pill tone={tokenTone(row.status)}>{TOKEN_LABEL[row.status]}</Pill>} />
            <Field label="Expires in" value={duration(row.expiresInMs)} mono />
            <Field label="Expires at" value={row.expiresAt ?? '—'} mono />
            <Field label="Last renewed" value={ago(row.renewedAt)} mono />
            <Field label="Due for renewal" value={row.dueForRenewal ? 'Yes' : 'No'} />
          </Section>
          <Section label="Identity">
            <Field label="Namespace" value={row.cluster.namespace} mono />
            <Field label="Service account" value={row.cluster.serviceAccount} mono />
            <Field label="API server" value={row.cluster.apiUrl} mono />
            {/* Both arrived here when the cluster Overview's identity card went: this tab is the
                only remaining screen that states how the cluster was onboarded, and "Cannot renew"
                belongs next to the Renew button it explains. */}
            <Field label="Onboarded via" value={row.cluster.onboardedVia} />
            <Field
              label="Credential"
              value={
                <Pill tone={row.cluster.renewable ? 'ok' : 'warn'}>
                  {row.cluster.renewable ? 'Renews itself' : 'Cannot renew'}
                </Pill>
              }
            />
          </Section>
        </div>

        {row.lastError && (
          <Section label="Last error">
            <p className="mono text-[13px] text-bad">{row.lastError}</p>
          </Section>
        )}

        {(row.status === 'unseeded' || row.status === 'expired') && (
          <Section label="Re-seed by hand">
            <p className="mb-2 text-[13px] text-muted">
              {row.status === 'unseeded'
                ? 'This cluster has never been seeded.'
                : 'The chain is broken: minting requires a valid token and this one has lapsed.'}{' '}
              Run this against the cluster, then write the result into the fleet token Secret:
            </p>
            <pre className="mono overflow-x-auto rounded-[6px] border border-line bg-bg px-3 py-2 text-[13px]">
              {seedCommand(row.cluster.namespace, row.cluster.serviceAccount)}
            </pre>
          </Section>
        )}
      </Card>

      <RemoveCluster
        id={id}
        displayName={row.cluster.displayName || id}
        canRemove={data?.canRemove ?? false}
        removable={row.removable ?? false}
      />
    </div>
  );
}
