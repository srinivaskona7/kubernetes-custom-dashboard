#!/usr/bin/env node
/**
 * Regenerate server/fleet/collectors/gatekeeper-library.json from a checkout of
 * github.com/open-policy-agent/gatekeeper-library.
 *
 *   npm run fleet:gk-library -- <path-to-gatekeeper-library-checkout>
 *
 * Reads every library/** /template.yaml and keeps only what the OPA screen shows or compares:
 * name, kind, title, version, bundles, one-line description, library path and a fingerprint of
 * the Rego (see regoFingerprint in collectors/gatekeeper-library.js). Nothing from a cluster.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'library'))) {
  console.error('usage: npm run fleet:gk-library -- <path-to-gatekeeper-library-checkout>');
  process.exit(2);
}

// The fingerprint function is the collector's own, so the two sides cannot normalise differently.
// The module loads the current JSON on require; seed an empty one when it does not exist yet.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, '..', 'collectors', 'gatekeeper-library.json');
if (!fs.existsSync(out)) fs.writeFileSync(out, JSON.stringify({ source: null, templates: [] }));
import gatekeeperLibraryModule from '../collectors/gatekeeper-library.js';
const { regoFingerprint } = gatekeeperLibraryModule;
import { fileURLToPath } from 'node:url';


function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name === 'template.yaml' ? [p] : [];
  });
}

const templates = walk(path.join(dir, 'library'))
  .map(file => {
    // One upstream template has a multi-line double-quoted description the strict parser
    // rejects; the fields read here sit outside it, so a document with errors is still usable.
    const parsed = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    if (parsed.errors.length) console.warn(`${path.relative(dir, file)}: ${parsed.errors[0].code}, parsed leniently`);
    const doc = parsed.toJS();
    const ann = (doc.metadata && doc.metadata.annotations) || {};
    const description = typeof ann.description === 'string'
      ? ann.description.replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0]
      : null;
    return {
      name: doc.metadata.name,
      kind: doc.spec && doc.spec.crd && doc.spec.crd.spec && doc.spec.crd.spec.names && doc.spec.crd.spec.names.kind,
      title: ann['metadata.gatekeeper.sh/title'] || null,
      version: ann['metadata.gatekeeper.sh/version'] ? String(ann['metadata.gatekeeper.sh/version']) : null,
      bundles: ann['metadata.gatekeeper.sh/bundle']
        ? String(ann['metadata.gatekeeper.sh/bundle']).split(',').map(s => s.trim()).filter(Boolean)
        : [],
      requiresSyncData: Boolean(ann['metadata.gatekeeper.sh/requires-sync-data']),
      description,
      path: path.relative(dir, path.dirname(file)),
      regoFingerprint: regoFingerprint(doc)
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

let commit = null;
let date = null;
try {
  [commit, date] = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%H %cs'], { encoding: 'utf8' }).trim().split(' ');
} catch { /* not a git checkout: source stays unstamped */ }

fs.writeFileSync(out, JSON.stringify({
  source: { repo: 'https://github.com/open-policy-agent/gatekeeper-library', commit, date },
  templates
}, null, 2) + '\n');
console.log(`wrote ${templates.length} templates to ${path.relative(process.cwd(), out)} (${commit ? commit.slice(0, 12) : 'unstamped'})`);
