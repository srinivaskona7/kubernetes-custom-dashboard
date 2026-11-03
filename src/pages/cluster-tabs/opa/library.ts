/**
 * Words for a template's relation to the upstream Gatekeeper library, kept out of the components
 * so Policies, Overview and the drawer say the same thing and the wording is testable without a DOM.
 *
 * The server does the matching (srv/fleet/collectors/gatekeeper-library.js); this file only names
 * its answer. Two rules it keeps: a template whose Rego could not be compared is never called
 * "library" without saying so, and a version comparison that could not be made is never "current".
 */
import type { OpaBundleCoverage, OpaLibraryMatch } from '../../../api';
import type { Tone } from '../../../components/ui';

export interface SourceLabel {
  text: string;
  tone: Tone;
  title: string;
}

export function sourceLabel(m: OpaLibraryMatch): SourceLabel {
  if (m.state === 'custom') {
    return { text: 'custom', tone: 'unknown', title: 'Not a gatekeeper-library template name — written for this cluster' };
  }
  const upstream = m.title ? `"${m.title}"` : 'a library template';
  if (m.state === 'modified') {
    return {
      text: 'modified',
      tone: 'warn',
      title: `Carries the name of ${upstream} (${m.path ?? 'library'}) but its Rego differs — the upstream description does not necessarily apply`
    };
  }
  const version = m.clusterVersion ?? m.libraryVersion;
  const base = version ? `library v${version}` : 'library';
  if (m.behind === true) {
    return {
      text: `${base} · v${m.libraryVersion} out`,
      tone: 'warn',
      title: `${upstream}: the cluster runs v${m.clusterVersion}; the library has v${m.libraryVersion}`
    };
  }
  if (m.rego === null) {
    return {
      text: base,
      tone: 'unknown',
      title: `Named like ${upstream}; its Rego could not be compared (no Rego on one side), so "unchanged" is not claimed`
    };
  }
  return {
    text: base,
    tone: 'ok',
    title: m.behind === false
      ? `${upstream}, Rego identical to the library, version current`
      : `${upstream}, Rego identical to the library; version not annotated, so currency is unknown`
  };
}

/** `pod-security-baseline` → `Pod Security baseline`. Unknown bundle names pass through. */
export function bundleName(bundle: string): string {
  const m = /^pod-security-(.+)$/.exec(bundle);
  return m ? `Pod Security ${m[1]}` : bundle;
}

/** The templates of a bundle the cluster does not have, by library title. */
export function missingTemplates(b: OpaBundleCoverage): string[] {
  return b.templates.filter(t => !t.installed).map(t => t.title || t.name);
}

/** "a, b, c, d +2 more": the first `n` names whole, then the count of the rest. */
export function listHead(names: string[], n: number): string {
  return names.length <= n ? names.join(', ') : `${names.slice(0, n).join(', ')} +${names.length - n} more`;
}
