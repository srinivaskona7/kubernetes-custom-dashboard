/**
 * The words the log footer owes an operator when the read stopped short of the raw log — two
 * facts srv/fleet/collectors/logs.js already computes (`bytesTruncated`, `partialLinesDropped`)
 * and the footer used to drop on the floor. A `null`/absent value renders nothing, never a 0:
 * `partialLinesDropped` is legitimately 0 on almost every successful read, and that must not
 * print as a sentence about a cut that did not happen.
 */
import { describe, expect, it } from 'vitest';
import { logCutSentences } from './log-cut';

describe('logCutSentences', () => {
  it('says nothing when neither limit was hit', () => {
    expect(logCutSentences(false, 0)).toEqual([]);
    expect(logCutSentences(null, null)).toEqual([]);
    expect(logCutSentences(undefined, undefined)).toEqual([]);
  });

  it('names the byte cut, in the direction kubelet actually cuts', () => {
    expect(logCutSentences(true, 0)).toEqual(['output cut at the byte limit: oldest lines kept']);
  });

  it('names a dropped partial line, singular and plural', () => {
    expect(logCutSentences(false, 1)).toEqual(['1 partial line dropped']);
    expect(logCutSentences(false, 2)).toEqual(['2 partial lines dropped']);
  });

  it('carries both at once, and neither implies the other', () => {
    expect(logCutSentences(true, 2)).toEqual([
      'output cut at the byte limit: oldest lines kept',
      '2 partial lines dropped'
    ]);
  });
});
