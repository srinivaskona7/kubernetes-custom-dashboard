import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the SQLite deploy-safety invariants: the data PVC is ReadWriteOnce, so
// the Deployment MUST use Recreate. Under RollingUpdate the surge pod can land
// on another node and hang forever with "Multi-Attach error for volume".

const __dirname = dirname(fileURLToPath(import.meta.url));
const chartDir = resolve(__dirname, '..', '..', 'chart');
const read = (p) => readFileSync(resolve(chartDir, p), 'utf8');

function helmAvailable() {
  try {
    execFileSync('helm', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function helmTemplate(setArgs = []) {
  const args = ['template', 'test', chartDir];
  for (const s of setArgs) args.push('--set', s);
  try {
    return { out: execFileSync('helm', args, { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { err: `${err.stderr ?? ''}${err.stdout ?? ''}` };
  }
}

describe('chart values: deploy safety', () => {
  it('defaults strategy.type to Recreate', () => {
    expect(read('values.yaml')).toMatch(/^strategy:\s*\n\s+type:\s*Recreate\s*$/m);
  });

  it('keeps replicaCount at 1 (SQLite is single-writer)', () => {
    expect(read('values.yaml')).toMatch(/^replicaCount:\s*1\s*$/m);
  });

  it('declares the data PVC as ReadWriteOnce', () => {
    expect(read('templates/pvc.yaml')).toMatch(/ReadWriteOnce/);
  });
});

describe.skipIf(!helmAvailable())('chart renders (helm template)', () => {
  it('renders the PVC, mount, DB_PATH and Recreate by default', () => {
    const { out } = helmTemplate();
    expect(out).toMatch(/kind: PersistentVolumeClaim/);
    expect(out).toMatch(/claimName: test-.*-data/);
    expect(out).toMatch(/mountPath: \/app\/data/);
    expect(out).toMatch(/name: DB_PATH\s*\n\s+value: "\/app\/data\/app\.db"/);
    expect(out).toMatch(/strategy:\s*\n\s+type:\s*Recreate/);
    expect(out).toMatch(/rollingUpdate:\s*null/);
  });

  it('fails to render RollingUpdate while persistence is enabled', () => {
    expect(helmTemplate(['strategy.type=RollingUpdate']).err).toMatch(/Multi-Attach/);
  });

  it('fails to render persistence=false without allowEphemeral', () => {
    expect(helmTemplate(['persistence.enabled=false']).err).toMatch(/ephemeral container storage/);
  });

  it('allows RollingUpdate without a PVC when data loss is accepted', () => {
    const { out } = helmTemplate(['persistence.enabled=false', 'persistence.allowEphemeral=true', 'strategy.type=RollingUpdate']);
    expect(out).toMatch(/type:\s*RollingUpdate/);
    expect(out).not.toMatch(/rollingUpdate:/);
    expect(out).not.toMatch(/PersistentVolumeClaim/);
  });
});

// Kubernetes server-defaults spec.strategy.rollingUpdate onto a Deployment
// created under RollingUpdate; that field is Forbidden under Recreate and Helm
// cannot delete it (its patch strips the chart's null). scripts/helm-deploy.sh
// removes it with a kubectl merge patch before helm upgrade.
describe('helm-deploy.sh strategy preflight', () => {
  const deployScript = readFileSync(resolve(__dirname, '..', '..', 'scripts', 'helm-deploy.sh'), 'utf8');

  it('strips the live rollingUpdate with a merge patch', () => {
    expect(deployScript).toMatch(/kubectl patch "deployment\/\$\{RELEASE\}"/);
    expect(deployScript).toMatch(/--type=merge/);
    expect(deployScript).toMatch(/"rollingUpdate":null/);
  });

  it('runs the patch BEFORE helm upgrade', () => {
    expect(deployScript.indexOf('kubectl patch "deployment/${RELEASE}"'))
      .toBeLessThan(deployScript.indexOf('helm upgrade --install'));
  });

  it('only patches an existing Deployment that wants Recreate and still has the field', () => {
    expect(deployScript).toMatch(/kubectl get deployment "\$RELEASE"[^\n]*>\/dev\/null 2>&1/);
    expect(deployScript).toMatch(/DESIRED_STRATEGY.*==.*"Recreate"/);
    expect(deployScript).toMatch(/-n "\$LIVE_ROLLING_UPDATE"/);
  });
});

// The preflight keys off an awk extraction of the rendered strategy; if template
// indentation shifts it returns empty and the preflight silently stops running.
describe.skipIf(!helmAvailable())('helm-deploy.sh reads the strategy correctly', () => {
  const awk = "/^kind: Deployment$/{d=1} d && /^  strategy:/{s=1; next} s && /^    type:/{print $2; exit}";
  const extract = (setArgs) => execFileSync('awk', [awk], { input: helmTemplate(setArgs).out, encoding: 'utf8' }).trim();

  it('extracts Recreate from the default render', () => {
    expect(extract([])).toBe('Recreate');
  });

  it('extracts RollingUpdate from the ephemeral render', () => {
    expect(extract(['persistence.enabled=false', 'persistence.allowEphemeral=true', 'strategy.type=RollingUpdate'])).toBe('RollingUpdate');
  });
});

// The /tls cert is the service-account pod identity, not a person identity
// attested by the pod — no DSID belongs in the chart.
describe.skipIf(!helmAvailable())('narrative pod identity', () => {
  it('renders an aws actor pod identity without person attributes', () => {
    const { out } = helmTemplate();
    expect(out).toMatch(/narrative\.apple\.com\/type: "actor"/);
    expect(out).toMatch(/narrative\.apple\.com\/domain: "aws"/);
    expect(out).toMatch(/narrative\.apple\.com\/pod-identity: "true"/);
    expect(out).not.toMatch(/person_id|name-json-type|identity-attestor/);
  });
});
