/**
 * The drift verdict, the explanation sentence, the image reference split, and the quick-fix command.
 *
 * All four are pure, which is what makes them testable at all here: `app/fleet-ui` runs vitest with
 * `environment: 'node'`, so the drawer that renders these cannot be mounted. The one that actually
 * matters is `driftVerdict` — an empty drift list means "nothing drifted" and "we could not tell"
 * on two different payloads, and only one of those may be printed as clean.
 */
import { describe, expect, it } from 'vitest';
import {
  DRIFT_EXPLANATION,
  DRIFT_HEADLINE,
  driftCopy,
  driftListState,
  driftVerdict,
  explanationOf,
  imageRef,
  NOT_COMPARABLE_HEADLINE,
  ownerResolutionReasonText,
  quickFixCommand,
  rolloutRestartCommand,
  rolloutTabLabel,
  uncomparableTotal,
  UNKNOWN_HEADLINE,
  type DriftSubject
} from './image-drift';

const subject = (over: Partial<DriftSubject> = {}): DriftSubject => ({
  name: 'keda-manager',
  namespace: 'kyma-system',
  drifted: false,
  driftDetails: [],
  ...over
});

describe('driftVerdict', () => {
  it('reads a resolved owner chain at face value', () => {
    expect(driftVerdict(subject({ ownerResolution: 'owner-chain', drifted: false }))).toBe('clean');
    expect(
      driftVerdict(
        subject({
          ownerResolution: 'owner-chain',
          drifted: true,
          driftDetails: [{ pod: 'keda-manager-abc', mismatches: [] }]
        })
      )
    ).toBe('drifted');
  });

  it('is unknown, never clean, when the owner chain was unavailable', () => {
    // The collector returns `drifted: false` with empty details in this case. Believing that pair
    // is how "no image-drifted Deployments" gets printed for a cluster nobody could evaluate.
    const unresolved = subject({ ownerResolution: 'unavailable', ownerResolutionReason: 'TRUNCATED' });
    expect(unresolved.drifted).toBe(false);
    expect(driftVerdict(unresolved)).toBe('unknown');
  });

  it('treats an older backend that sends no field as resolved', () => {
    // That release resolved pods by selector and always produced a verdict; reading the missing
    // field as unknown would blank the drift table for everyone still on the previous image.
    expect(driftVerdict(subject({ drifted: true }))).toBe('drifted');
    expect(driftVerdict(subject())).toBe('clean');
  });

  it('is not-comparable, never clean, when a container could not be compared', () => {
    // The collector's own rule: a clean verdict is `drifted: false` AND `uncomparableImages === 0`.
    // A live container reporting a bare image ID has not been cleared of drift, it was not measured.
    expect(driftVerdict(subject({ ownerResolution: 'owner-chain', uncomparableImages: 2 }))).toBe('not-comparable');
    expect(driftVerdict(subject({ ownerResolution: 'owner-chain', uncomparableImages: 0 }))).toBe('clean');
  });

  it('reports drift ahead of an uncomparable sibling container', () => {
    // A measured mismatch is actionable; the uncomparable container beside it does not soften it.
    expect(driftVerdict(subject({ drifted: true, uncomparableImages: 1 }))).toBe('drifted');
  });
});

describe('uncomparableTotal', () => {
  it('sums the containers nobody could compare, and reads an absent field as none', () => {
    expect(uncomparableTotal([subject({ uncomparableImages: 2 }), subject({ uncomparableImages: 1 })])).toBe(3);
    expect(uncomparableTotal([subject(), subject({ uncomparableImages: 0 })])).toBe(0);
    expect(uncomparableTotal([])).toBe(0);
  });
});

describe('driftListState', () => {
  it('is ok for an empty list — no rollouts is not an unread rollout', () => {
    expect(driftListState([])).toBe('ok');
  });

  it('is unknown as soon as one rollout could not be resolved', () => {
    expect(
      driftListState([subject({ ownerResolution: 'owner-chain' }), subject({ ownerResolution: 'unavailable' })])
    ).toBe('unknown');
  });

  it('is ok when every rollout resolved', () => {
    expect(driftListState([subject({ ownerResolution: 'owner-chain' }), subject({ drifted: true })])).toBe('ok');
  });
});

describe('ownerResolutionReasonText', () => {
  it('distinguishes a truncated read from a failed one', () => {
    expect(ownerResolutionReasonText('TRUNCATED')).toContain('paging ceiling');
    expect(ownerResolutionReasonText('TRUNCATED')).not.toContain('failed');
  });

  it('quotes an unfamiliar code rather than interpreting it', () => {
    expect(ownerResolutionReasonText('FORBIDDEN')).toContain('FORBIDDEN');
  });

  it('says the read did not complete when no reason came with it', () => {
    expect(ownerResolutionReasonText(null)).toContain('did not complete');
    expect(ownerResolutionReasonText(undefined)).toContain('did not complete');
  });
});

describe('explanationOf', () => {
  it('returns the backend sentence as sent', () => {
    const sentence = 'Pod is running a stale image. Template declares 1.4.0, but the live container is running 1.3.9.';
    expect(explanationOf({ container: 'manager', specImage: 'a:1.4.0', liveImage: 'a:1.3.9', explanation: sentence }))
      .toBe(sentence);
  });

  it('is null on an older backend, and never a synthesised substitute', () => {
    expect(explanationOf({ container: 'manager', specImage: 'a:1.4.0', liveImage: 'a:1.3.9' })).toBeNull();
  });

  it('treats blank and whitespace as absent', () => {
    const base = { container: 'manager', specImage: 'a:1', liveImage: 'a:2' };
    expect(explanationOf({ ...base, explanation: '' })).toBeNull();
    expect(explanationOf({ ...base, explanation: '   ' })).toBeNull();
    expect(explanationOf({ ...base, explanation: null })).toBeNull();
  });
});

describe('imageRef', () => {
  it('splits repo and tag', () => {
    expect(imageRef('europe-docker.pkg.dev/kyma/prod/keda-manager:1.4.0')).toEqual({
      repo: 'europe-docker.pkg.dev/kyma/prod/keda-manager',
      tag: '1.4.0',
      digest: null,
      version: '1.4.0'
    });
  });

  it('does not mistake a registry port for a tag', () => {
    expect(imageRef('registry:5000/app')).toEqual({
      repo: 'registry:5000/app',
      tag: null,
      digest: null,
      version: 'registry:5000/app'
    });
  });

  it('prefers the tag when a reference carries both a tag and a digest', () => {
    const ref = imageRef('app:1.2@sha256:abcdef0123456789abcdef');
    expect(ref.tag).toBe('1.2');
    expect(ref.digest).toBe('sha256:abcdef0123456789abcdef');
    expect(ref.version).toBe('1.2');
  });

  it('clips a digest when that is the only version there is', () => {
    const ref = imageRef('app@sha256:abcdef0123456789abcdef');
    expect(ref.repo).toBe('app');
    expect(ref.tag).toBeNull();
    // 19 characters: the `sha256:` prefix plus the first twelve hex digits, which is the form
    // `kubectl` and every registry UI print.
    expect(ref.version).toBe('sha256:abcdef012345');
    expect(ref.version.length).toBe(19);
  });

  it('names the whole reference when it carries no version at all', () => {
    // Better than the empty string: a comparison row has to print something the operator can read.
    expect(imageRef('nginx').version).toBe('nginx');
  });

  it('survives an absent image without throwing', () => {
    expect(imageRef(undefined)).toEqual({ repo: '', tag: null, digest: null, version: '' });
    expect(imageRef(null).version).toBe('');
  });

  it('reads the two live platformsbx cases', () => {
    // The one genuine drift: the tag is the entire difference, so the tag is what reads first.
    expect(imageRef('polls-frontend:0.3.0').version).toBe('0.3.0');
    expect(imageRef('polls-frontend:0.1.0').version).toBe('0.1.0');

    // The not-comparable pair: a long pinned reference against a bare image ID. Both sides must
    // produce something printable — the bare ID has no repository at all, and returning '' for it
    // would render an em-dash where the operator needs to see what the runtime actually reported.
    const pinned = imageRef('europe-docker.pkg.dev/gardener-project/releases/coredns:v1.14.7@sha256:086b5184d964');
    expect(pinned.tag).toBe('v1.14.7');
    expect(pinned.version).toBe('v1.14.7');
    const bare = imageRef('sha256:1a3d043f79f8');
    // Printed whole. The generic tag rule would read this as a repository called `sha256` with the
    // hex as its tag, which states a fact nobody gave us.
    expect(bare.tag).toBeNull();
    expect(bare.repo).toBe('');
    expect(bare.version).toBe('sha256:1a3d043f79f8');
    expect(bare.digest).toBe('sha256:1a3d043f79f8');
  });
});

describe('rolloutRestartCommand', () => {
  it('is the command an operator runs in their own terminal, unquoted', () => {
    expect(rolloutRestartCommand('keda-manager', 'kyma-system')).toBe(
      'kubectl rollout restart deployment keda-manager -n kyma-system'
    );
  });
});

describe('quickFixCommand', () => {
  // The whole point of the function: three of the four states must yield NO command. Telling an
  // operator to restart a Deployment whose images could not be compared, or whose pods were never
  // resolved, recommends an action that cannot affect what they are looking at.
  it('offers the restart only for a real drift', () => {
    expect(quickFixCommand(subject({ name: 'polls-frontend', namespace: 'polls', drifted: true }))).toBe(
      'kubectl rollout restart deployment polls-frontend -n polls'
    );
  });

  it('offers nothing for a clean Deployment', () => {
    expect(quickFixCommand(subject({ ownerResolution: 'owner-chain' }))).toBeNull();
  });

  it('offers nothing when the images could not be compared — a restart cannot fix that', () => {
    // The live `kube-system` case: spec `…/coredns:v1.14.7@sha256:086b…`, live `sha256:1a3d…`.
    expect(quickFixCommand(subject({ name: 'coredns', namespace: 'kube-system', uncomparableImages: 1 }))).toBeNull();
  });

  it('offers nothing when pod ownership was never resolved', () => {
    expect(quickFixCommand(subject({ ownerResolution: 'unavailable' }))).toBeNull();
  });

  it('still offers it when a Deployment is both drifted and partly uncomparable', () => {
    // Orthogonal states: the command is offered for the drift, and the uncomparable rows say for
    // themselves that it is not their fix.
    expect(quickFixCommand(subject({ drifted: true, uncomparableImages: 1 }))).not.toBeNull();
  });
});

describe('driftCopy', () => {
  it('explains a mismatch for a drifted Deployment', () => {
    expect(driftCopy(subject({ drifted: true }))).toEqual({
      headline: DRIFT_HEADLINE,
      explanation: DRIFT_EXPLANATION
    });
  });

  it('does not explain a mismatch when there is none to explain', () => {
    const notComparable = driftCopy(subject({ uncomparableImages: 3 }));
    expect(notComparable.headline).toBe(NOT_COMPARABLE_HEADLINE);
    expect(notComparable.explanation).toContain('bare image ID');
    expect(notComparable.explanation).not.toBe(DRIFT_EXPLANATION);

    const unknown = driftCopy(subject({ ownerResolution: 'unavailable' }));
    expect(unknown.headline).toBe(UNKNOWN_HEADLINE);
    expect(unknown.explanation).toContain('could not be resolved');
  });

  it('never claims a clean verdict it was not given', () => {
    // The drawer is not opened on a clean Deployment; if it ever is, "nothing was evaluated" is the
    // safer of the two things to say.
    expect(driftCopy(subject()).headline).toBe(UNKNOWN_HEADLINE);
  });
});

describe('rolloutTabLabel', () => {
  it('counts when both halves were evaluated', () => {
    expect(rolloutTabLabel('ok', 1, 2)).toEqual({ label: 'Rollouts (3)' });
    expect(rolloutTabLabel('ok', 0, 0)).toEqual({ label: 'Rollouts (0)' });
  });

  it('carries no digit at all when the drifted half was never evaluated', () => {
    // `Rollouts (0)` here is a confident zero read before anything is opened — the operator concludes
    // there is nothing to look at. And `Rollouts (2)` for the stale half alone is the same lie with a
    // different digit, so the stale count goes in the tooltip, not the label.
    const { label, why } = rolloutTabLabel('unknown', 0, 2);
    expect(label).toBe('Rollouts');
    expect(/\d/.test(label)).toBe(false);
    expect(why).toContain('was not evaluated');
    expect(why).toContain('2 StatefulSets');
  });

  it('keeps the tooltip grammatical for one stale StatefulSet', () => {
    expect(rolloutTabLabel('unknown', 0, 1).why).toContain('1 StatefulSet on a stale revision');
  });
});

describe('DRIFT_EXPLANATION', () => {
  it('keeps the specified wording', () => {
    expect(DRIFT_EXPLANATION).toBe(
      'The running pod is executing a different container image than declared in the Deployment ' +
        'template. This typically happens after an image update when a rollout is stuck or pods ' +
        'have not restarted.'
    );
  });
});
