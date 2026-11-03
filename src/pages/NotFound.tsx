/**
 * The catch-all destination.
 *
 * Before this existed, `#/anything-else` matched none of the eight routes and `<Routes>`
 * rendered nothing — the rail and the header stayed, and the content region was simply blank.
 * That is the worst possible failure for a console: an empty pane is indistinguishable from a
 * cluster that returned no data, so an operator following a stale link from a ticket had no way
 * to tell "this address no longer exists" from "this cluster is empty". Honest unavailability
 * is a product invariant here, and a route that does not exist is exactly a thing to be honest
 * about.
 *
 * It names the path it was given. A 404 that will not say what it could not find forces the
 * reader to go and inspect the address bar themselves, and the whole reason they are here is
 * that a link was wrong.
 *
 * Deliberately not a redirect to `/`. Silently landing on the Overview would hide the broken
 * link — the operator would assume they had mis-clicked, paste the same bad URL into the next
 * ticket, and the dead link would outlive everyone who saw it.
 */
import { Link, useLocation } from 'react-router-dom';
import { PageHeader } from '../components/layout';

/**
 * Where an operator can actually go. These are the real routes, so a rename that breaks one
 * breaks the build rather than leaving a 404 page pointing at another 404.
 */
const DESTINATIONS: { to: string; label: string; hint: string }[] = [
  { to: '/', label: 'Fleet Overview', hint: 'Every registered cluster and its current verdict' },
  { to: '/tokens', label: 'Token Health', hint: 'Service-account token expiry across the fleet' },
  { to: '/drift', label: 'Fleet Drift & Parity', hint: 'Module, Kubernetes and workload version spread' },
  { to: '/onboard', label: 'Add a cluster', hint: 'Kubeconfig plus a service-account token' }
];

export default function NotFound() {
  const location = useLocation();
  // HashRouter: `pathname` is what follows the `#`, which is the part the operator actually
  // typed or pasted. `search` is included because a wrong `?tab=` is a common way to arrive
  // here from an edited link, and hiding it would make the message ambiguous.
  const attempted = `#${location.pathname}${location.search}`;

  return (
    <div className="min-w-0 flex-1">
      <PageHeader
        title="No such page"
        subtitle="This address does not match any route in the console."
      />

      <div className="flex flex-col items-start gap-5 page-x pb-10">
        <div className="w-full max-w-[80ch] rounded-[8px] border border-line bg-surface p-4">
          <p className="text-[13px] uppercase tracking-wide text-muted">Address requested</p>
          <p className="mono mt-1 break-all text-[14px] text-text">{attempted}</p>
          <p className="mt-3 max-w-[74ch] text-[14px] text-muted">
            Nothing was fetched and no cluster was contacted — the console never got as far as a
            request. If this link came from a saved bookmark or a ticket, the route it names has
            either been renamed or never existed.
          </p>
        </div>

        <div className="w-full max-w-[80ch]">
          <p className="pb-2 text-[13px] uppercase tracking-wide text-muted">Where to go instead</p>
          <ul className="divide-y divide-line border-y border-line">
            {DESTINATIONS.map(d => (
              <li key={d.to} className="flex items-baseline justify-between gap-4 py-2.5">
                <Link
                  to={d.to}
                  className="text-[14px] font-medium text-accent-bright underline decoration-dotted decoration-line underline-offset-[3px] transition-colors hover:decoration-accent"
                >
                  {d.label}
                </Link>
                <span className="shrink-0 text-right text-[13px] text-muted">{d.hint}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="max-w-[74ch] text-[13px] text-muted">
          A cluster's own page is <span className="mono">#/clusters/&lt;cluster-id&gt;</span>. The
          cluster list in the sidebar is the reliable way to reach one — its ids are always the
          ones currently registered.
        </p>
      </div>
    </div>
  );
}
