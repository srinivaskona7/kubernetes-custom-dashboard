// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The ingress screens' UI invariants, enforced as source checks rather than as prose.
 *
 * Source checks for the same reason as `helm-ui-readonly.test.ts`: `app/fleet-ui` runs vitest in Node with
 * no DOM (jsdom is blocked by npm E401 against the internal registry), so a rendering test cannot run
 * here — but the invariants that matter most about these five screens are all checkable in the source.
 *
 * Five things this folder must be true about, each of which has already been got wrong once somewhere
 * in this console:
 *
 *  1. **No control offers a mutation.** An ingress console is conventionally expected to let you
 *     restart a gateway or re-apply a Gateway CR. This one refuses, and a button labelled "Restart" is
 *     the ambiguity whether or not it is wired to anything.
 *  2. **No screen fetches.** All five take `ingress` as a prop from `TrafficTab`, which is what makes
 *     "one `clusterTrafficErrors` read per tab visit" true by construction rather than by inspection —
 *     five screens fetching the same payload would let them disagree about the same cluster.
 *  3. **A credential is named, never read.** `IngressGatewayServer.credentialName` is the name of a
 *     Secret. `server/fleet` returns Secret keys and never values, so a screen reaching for `.data[...]`
 *     would be reading something that is not on the wire — and the day it *is* on the wire, this test
 *     is what fails first.
 *  4. **`x-forwarded-for` and the user agent stay unread.** The collector deliberately never emits
 *     either; a screen that reached for them would be asserting an originator it cannot know.
 *  5. **Every `truncated` flag on the wire is rendered.** A capped list drawn as if complete is the
 *     confident-zero failure this console exists to avoid.
 */




const INGRESS_DIR = path.join(FAKE_DIR, '../../src/pages/cluster-tabs/ingress');

/** Refused Requests moved to Distributed Traces but renders the ingress refusals payload. */
const OUTSIDE_INGRESS_DIR = ['../TracesRefused.tsx'];

function ingressSources() {
  const files = fs.readdirSync(INGRESS_DIR).filter(f => /\.(ts|tsx)$/.test(f));
  assert.ok(
    files.length >= 6,
    `the ingress folder scan found only ${files.length} files — the scan is broken, not the folder`
  );
  const own = files.map(file => ({ file, src: fs.readFileSync(path.join(INGRESS_DIR, file), 'utf8') }));
  // Ingress screens that live outside this folder. The folder scan above cannot see them, so each is
  // listed here; moving one out of the folder must not drop it from every guard below.
  const shared = OUTSIDE_INGRESS_DIR.map(rel => ({ file: rel, src: fs.readFileSync(path.join(INGRESS_DIR, rel), 'utf8') }));
  return own.concat(shared);
}

/**
 * Strip comments before looking for verbs.
 *
 * Not cosmetic: these files explain at length *why* there is no restart control, and a naive grep
 * matches the explanation and fails on the code that is correct. The guard has to read what ships to
 * the browser, which is the code.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Verbs that must never label a control here.
 *
 * Each is a mutation an ingress console is conventionally expected to offer and this one refuses.
 * `Apply` and `Install ` carry a trailing/leading shape on purpose — "Apply" as a word appears in
 * prose ("the policy applies to"), so only the label form is banned.
 */
const FORBIDDEN_LABELS = [
  'Restart', 'Scale', 'Redeploy', 'Rollout', 'Drain',
  'Apply', 'Sync', 'Enable', 'Disable', 'Rotate',
  'Create Gateway', 'Edit Gateway', 'Delete Gateway',
  'Create VirtualService', 'Edit VirtualService', 'Delete VirtualService',
  'Create Ingress', 'Edit Ingress', 'Delete Ingress',
  'Create HTTPRoute', 'Edit HTTPRoute', 'Delete HTTPRoute',
  'Block', 'Ban', 'Allowlist', 'Denylist', 'Rate limit',
  'Uninstall', 'Install ', 'Modify', 'Mutate'
];

test('no ingress control is labelled with a mutation verb', () => {
  const offenders = [];
  for (const { file, src } of ingressSources()) {
    const code = stripComments(src);
    // Only string and JSX-text positions can become a label. A `<button>` whose text is a verb is the
    // defect; a variable named `applyFilter` is not, which is why this reads quoted text and JSX
    // children rather than every identifier.
    const labels = [
      ...code.matchAll(/>([^<>{}]{2,60})</g),
      ...code.matchAll(/'([^']{2,60})'/g),
      ...code.matchAll(/"([^"]{2,60})"/g)
    ].map(m => m[1]);
    for (const label of labels) {
      for (const verb of FORBIDDEN_LABELS) {
        if (label.includes(verb)) offenders.push(`${file}: "${label.trim()}" contains "${verb}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these ingress labels offer a mutation, and this console is read-only against clusters:\n  ' +
      offenders.join('\n  ')
  );
});

test('no ingress pane can accept edited text', () => {
  const offenders = [];
  for (const { file, src } of ingressSources()) {
    const code = stripComments(src);
    // The two ways a read-only pane silently becomes an editor. `<input>` is legitimate — the host and
    // peer searches use it through `SearchBox` — so it is not listed.
    if (/<textarea/i.test(code)) offenders.push(`${file}: <textarea>`);
    if (/contentEditable/.test(code)) offenders.push(`${file}: contentEditable`);
  }
  assert.deepEqual(offenders, [], 'these files can accept edited text: ' + offenders.join(', '));
});

test('no ingress screen fetches — all five take the payload as a prop', () => {
  const offenders = [];
  for (const { file, src } of ingressSources()) {
    const code = stripComments(src);
    if (/\bapi\.[a-zA-Z]+\(/.test(code)) offenders.push(`${file}: calls api.*`);
    if (/\buseAsync\(/.test(code)) offenders.push(`${file}: calls useAsync`);
    if (/\bfetch\(/.test(code)) offenders.push(`${file}: calls fetch`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these ingress screens fetch their own data instead of receiving it from TrafficTab, which lets ' +
      'five screens disagree about one cluster and costs five reads per tab visit:\n  ' +
      offenders.join('\n  ')
  );
});

test('Access control distinguishes configured policy CIDRs from observed client addresses', () => {
  const src = fs.readFileSync(path.join(INGRESS_DIR, 'IngressClients.tsx'), 'utf8');
  assert.match(src, /ipBlocks and remoteIpBlocks are configured source ranges, not observed client addresses/);
  assert.match(src, /Load balancer source ranges and upstream firewall rules are separate controls/);
  assert.match(src, /<LiveYaml clusterId=\{clusterId\} kind="AuthorizationPolicy"/);
});

test('a TLS credential is named and never read', () => {
  for (const { file, src } of ingressSources()) {
    const code = stripComments(src);
    // server/fleet returns Secret keys and never values. These are the shapes that would be reading a
    // value, and none of them can appear even though the field is not on the wire today — the day
    // somebody adds it, this is the test that fails first.
    assert.ok(!/\.stringData\b/.test(code), `${file} references stringData`);
    assert.ok(!/\.data\s*\[/.test(code), `${file} indexes a .data map, which would be a Secret value`);
    assert.ok(
      !/\bcredentialValue\b|\btlsKey\b|\bprivateKey\b/.test(code),
      `${file} names a credential value, not a credential name`
    );
  }

  // CANARY: the positive half. The Gateway server list must actually show the Secret's *name*, or the
  // three negative assertions above pass on a screen that shows nothing at all.
  const listeners = stripComments(fs.readFileSync(path.join(INGRESS_DIR, 'IngressListeners.tsx'), 'utf8'));
  assert.match(
    listeners,
    /credentialName/,
    'the TLS & Listeners screen must render the credential Secret name — that is the whole honest half of this field'
  );
});

test('no screen reaches for the two fields the collector deliberately never emits', () => {
  /*
    The ban is on **reading** the field, not on naming it.

    The first version of this test banned the words, and it failed on the sentence in
    `IngressClients.tsx` that tells the operator this console never reads `x-forwarded-for` — which is
    the single most valuable sentence on that screen. A guard that forbids documenting an invariant is
    worse than no guard, because the fix is to delete the documentation.

    So the two shapes below are the ones that would actually be a read: a property access, and a
    bracket index with the header name as a string. Both are canaried at the bottom.
  */
  const ACCESS = /\.\s*(xForwardedFor|userAgent|user_agent|x_forwarded_for)\b/;
  const INDEX = /\[\s*['"`](x-forwarded-for|user-agent|x_forwarded_for|user_agent)['"`]\s*\]/i;

  const offenders = [];
  for (const { file, src } of ingressSources()) {
    const code = stripComments(src);
    if (ACCESS.test(code)) offenders.push(`${file}: property access`);
    if (INDEX.test(code)) offenders.push(`${file}: string index`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these screens read a field the collector never emits — both identify a person and their network ' +
      'path, and both are absent from the wire on purpose. A reference is either dead code or a ' +
      'request to add them, and both need the conversation this failure starts:\n  ' + offenders.join('\n  ')
  );

  // CANARY: prove the patterns fail on a bad input before trusting them to pass on a good one.
  assert.match('const who = client.xForwardedFor;', ACCESS);
  assert.match('const ua = row.userAgent ?? null;', ACCESS);
  assert.match("const who = headers['x-forwarded-for'];", INDEX);
  // …and that the honest prose stays legal, which is the whole reason this test is shaped this way.
  const prose = 'This console never reads <span className="mono">x-forwarded-for</span> or the user agent.';
  assert.ok(!ACCESS.test(prose) && !INDEX.test(prose), 'documenting the invariant must stay legal');
});

test('every truncated flag the ingress payload carries is rendered by a screen', () => {
  const api = fs.readFileSync(
    path.join(FAKE_DIR, '../../src/api.ts'),
    'utf8'
  );

  // The three capped lists on the ingress envelope. Read out of api.ts rather than hardcoded, so a
  // fourth cap added to the wire fails here instead of shipping as a list drawn as if complete.
  const block = api.slice(api.indexOf('export interface TrafficIngress'));
  const flags = [...block.slice(0, block.indexOf('\n}')).matchAll(/^\s*(\w*[Tt]runcated)\??:\s*boolean/gm)].map(
    m => m[1]
  );
  assert.ok(
    flags.length >= 3,
    `found only ${flags.length} truncation flags on TrafficIngress — the scan is broken, not the type`
  );

  const all = ingressSources().map(s => stripComments(s.src)).join('\n');
  const unrendered = flags.filter(f => !all.includes(f));
  assert.deepEqual(
    unrendered,
    [],
    'these truncation flags are on the wire and no ingress screen reads them, so a capped list is ' +
      'drawn as if it were the whole cluster: ' + unrendered.join(', ')
  );
});

test('the gap panel is the only thing a screen renders when no ingress proxy was read', () => {
  // `ingressWasRead` is the single predicate. Every screen must consult it, or one of them draws a
  // confident 0 for a window that was never opened — the exact failure the `unavailable` vocabulary
  // exists to prevent, and the reason `TrafficTab`'s sub-tab counts use the same predicate.
  const SCREENS = [
    'IngressOverview.tsx',
    'IngressHosts.tsx',
    'IngressListeners.tsx',
    'IngressFailures.tsx',
    'IngressClients.tsx',
    'IngressGateway.tsx'
  ];
  for (const file of SCREENS) {
    const code = stripComments(fs.readFileSync(path.join(INGRESS_DIR, file), 'utf8'));
    assert.match(code, /ingressWasRead\(/, `${file} does not check whether an ingress window exists`);
  }

  // CANARY: and the predicate itself must be the three-part one, not `Boolean(ingress)`. A truthy
  // empty envelope is exactly the case that produces the confident zeros.
  const shared = fs.readFileSync(path.join(INGRESS_DIR, 'shared.ts'), 'utf8');
  assert.match(shared, /ingressProxies\s*>\s*0/, 'ingressWasRead must require that a gateway proxy was actually read');
});

/**
 * Network Path is the one ingress screen built from objects, not from the access-log window, so it is
 * deliberately not in SCREENS above: gating it on `ingressWasRead` would hide a real load balancer and
 * NAT behind a log read that failed. Its lanes come only from path-view.ts, where each hop's
 * unavailable rule is unit-tested.
 */
const PATH_GATES_ON_WINDOW = /ingressWasRead\(/;
const PATH_USES_HOPS = /ingressHops\(path\)[\s\S]*egressHops\(path\)/;

test('Network Path draws from objects, not from the access-log window', () => {
  const code = stripComments(fs.readFileSync(path.join(INGRESS_DIR, 'IngressPath.tsx'), 'utf8'));
  assert.doesNotMatch(code, PATH_GATES_ON_WINDOW, 'IngressPath must not hide object reads behind the ingress log window');
  assert.match(code, PATH_USES_HOPS, 'IngressPath must build both lanes through path-view.ts');
});

test('the Network Path patterns catch a bad screen (canary)', () => {
  assert.match('if (!ingressWasRead(ingress)) return <IngressGap />;', PATH_GATES_ON_WINDOW);
  assert.doesNotMatch('const hops = [{ id: "lb", facts: [] }];', PATH_USES_HOPS);
});

/**
 * D1: an external peer is counted, never listed by address.
 *
 * The one place allowed to read a peer's `.ip` is `peerAddress` in edge-view.ts, which returns null
 * for an external peer whatever the server sent. A screen reading `.ip` itself — or a column headed as
 * an address — is how an older srv's external addresses would reach the page.
 */
const PEER_IP_READ = /\.ip\b(?!s)/;
const ADDRESS_HEADER = /header:\s*['"`](?:Peer address|IP|IP address|Client IP|Client address|Source IP)['"`]/;

test('no ingress screen prints a peer address except through peerAddress (D1)', () => {
  const screens = ingressSources().filter(s => s.file.endsWith('.tsx'));
  assert.ok(screens.length >= 6, `the D1 scan found only ${screens.length} screens — the scan is broken`);
  const offenders = [];
  for (const { file, src } of screens) {
    const code = stripComments(src);
    if (PEER_IP_READ.test(code)) offenders.push(`${file}: reads .ip directly`);
    if (ADDRESS_HEADER.test(code)) offenders.push(`${file}: has an address column`);
  }
  // TrafficTab renders the failing requests' sources; its peer path must go through the same gate.
  const tab = stripComments(fs.readFileSync(path.join(INGRESS_DIR, '../TrafficTab.tsx'), 'utf8'));
  if (!/peer \? peerAddress\(ep\)/.test(tab)) offenders.push('TrafficTab.tsx: Endpoint no longer gates sources through peerAddress');
  assert.deepEqual(offenders, [], 'external peer addresses must never be printed (D1):\n  ' + offenders.join('\n  '));

  // The gate itself: external is null even when the server sent an address.
  const view = stripComments(fs.readFileSync(path.join(INGRESS_DIR, 'edge-view.ts'), 'utf8'));
  assert.match(view, /export function peerAddress[\s\S]{0,200}kind === 'external'[\s\S]{0,60}return null/, 'peerAddress must return null for an external peer');
});

test('the D1 patterns catch a bad screen (canary)', () => {
  assert.match('<span>{c.ip}</span>', PEER_IP_READ);
  assert.match('title={selected.ip}', PEER_IP_READ);
  assert.doesNotMatch('items={d.ips}', PEER_IP_READ);
  assert.match("header: 'Peer address',", ADDRESS_HEADER);
  assert.doesNotMatch("header: 'Peer',", ADDRESS_HEADER);
});

/**
 * Violet is the brand, never a status (CLAUDE.md, UI direction). A tone of `accent` on an ingress
 * screen is a verdict drawn in the brand colour, so the literal is banned outright; a filter chip's
 * `border-accent` class is a selection, not a tone, and does not match.
 */
const ACCENT_TONE = /['"]accent['"]/;

test('no ingress screen draws a status in violet', () => {
  const files = [...ingressSources(), { file: '../TrafficTab.tsx', src: fs.readFileSync(path.join(INGRESS_DIR, '../TrafficTab.tsx'), 'utf8') }];
  const offenders = files.filter(({ src }) => ACCENT_TONE.test(stripComments(src))).map(f => f.file);
  assert.deepEqual(offenders, [], 'these files use the accent tone as a status:\n  ' + offenders.join('\n  '));
});

test('the violet-status pattern catches a bad screen (canary)', () => {
  assert.match("app: 'accent',", ACCENT_TONE);
  assert.match('<Dot tone="accent" />', ACCENT_TONE);
  assert.doesNotMatch("active ? 'border-accent bg-accent/10 text-text' : ''", ACCENT_TONE);
});

/**
 * A card label that joins two numbers with a comma reads as one number: "1, 134 denied" was read as
 * 1,134 on Access control. Separate the tallies with a middle dot. Matches a template placeholder,
 * a comma and a space, then another placeholder, inside a `label={`...`}` expression.
 */
const COMMA_JOINED_LABEL = /label=\{[^}]*`[^`]*\}, \$\{/;

test('no card label joins two numbers with a comma', () => {
  const files = [...ingressSources(), { file: '../TrafficTab.tsx', src: fs.readFileSync(path.join(INGRESS_DIR, '../TrafficTab.tsx'), 'utf8') }];
  const offenders = files.filter(({ src }) => COMMA_JOINED_LABEL.test(stripComments(src))).map(f => f.file);
  assert.deepEqual(offenders, [], 'these labels read as one thousands-separated number:\n  ' + offenders.join('\n  '));
});

test('the comma-joined label pattern catches a bad label (canary)', () => {
  assert.match('label={ok ? `${a.length}, ${b.toLocaleString()} denied` : undefined}', COMMA_JOINED_LABEL);
  assert.doesNotMatch('label={ok ? `${a.length} · ${b.toLocaleString()} denied` : undefined}', COMMA_JOINED_LABEL);
});
