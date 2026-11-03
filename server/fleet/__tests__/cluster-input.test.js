/**
 * The cluster-input generator.
 *
 * The property under test is that the file it writes is the request body — nothing more,
 * nothing renamed. If this drifts from what POST /api/fleet/clusters accepts, an operator
 * generates a file the dialog then rejects, and the failure lands on whoever is holding
 * the clipboard rather than here.
 */
import { test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

import _cluster_input from '../tools/cluster-input.js';
const { buildInput, readCluster, DEFAULT_DURATION } = _cluster_input;

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig';

/** Stands in for kubectl, answering by jsonpath rather than by argument position. */
function fakeKubectl({ server = 'https://api.example.invalid', inlineCa = PEM, caFile = '' } = {}) {
  const calls = [];
  return {
    calls,
    run(args) {
      calls.push(args);
      const jp = args.find(a => a.startsWith('jsonpath=')) || '';
      if (jp.endsWith('server}')) return server;
      if (jp.endsWith('certificate-authority-data}')) return inlineCa ? Buffer.from(inlineCa).toString('base64') : '';
      if (jp.endsWith('certificate-authority}')) return caFile;
      if (args[0] === 'create' && args[1] === 'token') return TOKEN;
      return '';
    }
  };
}

test('the generated file is exactly the onboarding request body', () => {
  const k = fakeKubectl();
  const input = buildInput({ name: '  Platform Dev  ', env: 'dev', runFn: k.run });

  assert.deepEqual(Object.keys(input).sort(), ['apiUrl', 'caData', 'env', 'name', 'token']);
  assert.strictEqual(input.name, 'Platform Dev', 'the display name is trimmed, as the server would');
  assert.strictEqual(input.env, 'dev');
  assert.strictEqual(input.apiUrl, 'https://api.example.invalid');
  assert.strictEqual(input.caData, PEM);
  assert.strictEqual(input.token, TOKEN);
});

test('a trailing slash on the API URL is removed, matching the server', () => {
  const k = fakeKubectl({ server: 'https://api.example.invalid/' });
  assert.strictEqual(buildInput({ name: 'x', runFn: k.run }).apiUrl, 'https://api.example.invalid');
});

test('the onboarding input carries no permission request of any kind', () => {
  const k = fakeKubectl();
  // `rollout: true` used to add `allowRollout` here, which the server forwarded into a grant of
  // `patch` on every workload. Both ends are removed; this asserts the input side stays inert
  // even when a caller passes the old flag.
  const out = buildInput({ name: 'x', rollout: true, runFn: k.run });
  assert.deepEqual(Object.keys(out).sort(), ['apiUrl', 'caData', 'env', 'name', 'token']);
});

test('env defaults to unknown rather than guessing', () => {
  const k = fakeKubectl();
  assert.strictEqual(buildInput({ name: 'x', runFn: k.run }).env, 'unknown');
});

test('a CA held in a file is resolved to PEM, not passed through as a path', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ca-')), 'ca.crt');
  fs.writeFileSync(file, PEM);

  const k = fakeKubectl({ inlineCa: '', caFile: file });
  assert.strictEqual(buildInput({ name: 'x', runFn: k.run }).caData, PEM);
});

test('a context is threaded into every kubectl call, including the mint', () => {
  const k = fakeKubectl();
  buildInput({ name: 'x', context: 'platformdev', runFn: k.run });
  // Reading the wrong context is silent and produces a file that points at the wrong
  // cluster — so every call must carry it, not just the first.
  for (const args of k.calls) {
    assert.ok(args.includes('platformdev'), `missing --context: ${args.join(' ')}`);
  }
});

test('the default token lifetime is the 24h the renewal chain assumes', () => {
  assert.strictEqual(DEFAULT_DURATION, '24h');
  const k = fakeKubectl();
  buildInput({ name: 'x', runFn: k.run });
  const mint = k.calls.find(a => a[0] === 'create');
  assert.ok(mint.includes('--duration=24h'));
});

test('an explicit duration is passed through', () => {
  const k = fakeKubectl();
  buildInput({ name: 'x', duration: '8h', runFn: k.run });
  assert.ok(k.calls.find(a => a[0] === 'create').includes('--duration=8h'));
});

test('a missing name is refused before anything is minted', () => {
  const k = fakeKubectl();
  assert.throws(() => buildInput({ name: '   ', runFn: k.run }), /--name is required/);
  assert.strictEqual(k.calls.length, 0, 'nothing was read and nothing was minted');
});

test('a non-https server address is refused', () => {
  const k = fakeKubectl({ server: 'http://api.example.invalid' });
  assert.throws(() => buildInput({ name: 'x', runFn: k.run }), /no https server address/);
});

test('a CA that is not a certificate is refused rather than written', () => {
  const k = fakeKubectl({ inlineCa: 'not a certificate' });
  assert.throws(() => buildInput({ name: 'x', runFn: k.run }), /not a PEM certificate/);
});

test('kubectl printing an error instead of a token names the likely cause', () => {
  // The real failure: the RBAC bundle was never applied, so `create token` fails and its
  // stderr — or an empty string — would otherwise be written into the file as the token.
  const k = fakeKubectl();
  assert.throws(
    () => buildInput({ name: 'x', runFn: k.run, mintFn: () => 'Error from server (NotFound)' }),
    /has fleet-dashboard-rbac\.yaml been applied/
  );
});

test('readCluster minifies, so one context out of many is unambiguous', () => {
  const k = fakeKubectl();
  readCluster({ runFn: k.run });
  for (const args of k.calls) assert.ok(args.includes('--minify'), args.join(' '));
});
