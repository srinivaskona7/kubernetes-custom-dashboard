/**
 * The Logs tab's address, as a pure function over search params.
 *
 * Extracted from `ClusterDetail`'s `viewLogs` callback so the rule can be tested without a
 * router, a DOM or a rendered page — the thing that goes wrong with a link like this is never
 * the click handler, it is which parameters survive the jump and which are left behind to
 * describe a pod that is no longer selected.
 *
 * `LogsTab` reads `?ns=` `?pod=` `?container=` `?previous=` `?tail=` `?filterNs=` `?sort=` `?dir=`
 * (see its own header), so those eight names are the contract between this file and that one.
 *
 * Two of them are easy to get wrong together. `ns` names the *selected* pod's namespace; `filterNs`
 * narrows the *list*. They are separate because a deep link naming one pod must not collapse the
 * list to one namespace — but a link that sets `ns` and leaves a stale `filterNs` behind is worse
 * than either: the named pod is filtered out of the list it was supposed to be selected in, and
 * `LogsTab`'s auto-select effect then quietly opens somebody else's log. See {@link logParams}.
 */

/** How a caller asks for a pod's log. */
export interface LogTarget {
  namespace: string;
  pod: string;
  /** `null`/omitted lets `LogsTab` pick — it defaults to the pod's first container. */
  container?: string | null;
  /**
   * Open the log of the container instance that ran *before* the last restart.
   *
   * This is the whole point of the option. A crashlooping pod's current container was started
   * seconds ago and its log is empty or holds only a startup banner — the evidence for *why* it
   * died is in the previous instance. An operator following a "Logs" link from a crashloop row
   * would otherwise land on a blank pane and have to find and tick "Previous instance" by hand,
   * every single time, which is exactly the manual step this link exists to remove.
   */
  previous?: boolean;
}

/**
 * Rewrite `params` to address one pod's log.
 *
 * Returns a new `URLSearchParams`; never mutates the input, because the caller is holding React
 * Router's current value and mutating it in place is a state update React cannot see.
 *
 * Parameters are **deleted rather than blanked** when they do not apply. `?container=` with an
 * empty value is not the same as no `?container=` — the first says "this pod's container is
 * called nothing", which `LogsTab` would take as a selection and then fail to match.
 *
 * `filterNs` is *re-pointed* at the target's namespace rather than deleted. Deleting it would also
 * work — the list would show every namespace and the pod would be in it — but an operator arriving
 * from a failing upstream wants that pod's neighbours, not 121 pods cluster-wide, and the namespace
 * select is right there to widen again. What it must never do is stay pointing somewhere else; that
 * filters the target out of its own list. The list filter always contains the selection.
 */
export function logParams(params: URLSearchParams, target: LogTarget): URLSearchParams {
  const p = new URLSearchParams(params);
  p.set('tab', 'logs');
  p.set('ns', target.namespace);
  p.set('pod', target.pod);
  p.set('filterNs', target.namespace);

  if (target.container) p.set('container', target.container);
  else p.delete('container');

  // Only ever written as the literal '1' that `LogsTab` tests for, and removed rather than set
  // to '0' — an absent parameter is what "current instance" means everywhere else in the URL.
  if (target.previous) p.set('previous', '1');
  else p.delete('previous');

  return p;
}

/**
 * Strip every Logs-tab parameter. Used when leaving the tab.
 *
 * A stale `?pod=` outliving the tab that reads it is how a later link back to Logs lands on
 * whichever pod was open twenty minutes ago instead of the one just clicked.
 *
 * `filterNs` and `sort` go with it for the same reason and one more: they are list state, so a
 * `filterNs` left in the URL follows the operator into Storage and Security, where nothing reads it
 * and it reads as a filter that is silently doing nothing. `tail` and `dir` are deliberately *kept*
 * — they are how this reader likes to read a log, not which log they were reading, and re-picking
 * "2000 lines, newest first" on every arrival is the annoyance that made them settings in the first
 * place.
 */
export function clearLogParams(params: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(params);
  for (const k of ['ns', 'pod', 'container', 'previous', 'filterNs', 'sort']) p.delete(k);
  return p;
}
