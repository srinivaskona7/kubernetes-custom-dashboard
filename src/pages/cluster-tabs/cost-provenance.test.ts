/**
 * The Cost tab's qualifier and provenance rules.
 *
 * These are the rules that stop a modelled dollar figure reading like an invoice figure, so each
 * one is pinned by the exact string an operator sees rather than by a boolean.
 */
import { describe, expect, it } from 'vitest';
import {
  qualifiedHourlyUsd,
  qualifiedUsd,
  qualifierCaption,
  qualifierPillLabel,
  qualifierPrefix,
  rateCardProvenance,
  unattributedNote,
  usd
} from './cost-provenance';

describe('qualifierPrefix', () => {
  it('claims a lower bound only when every priced node had a stated rate', () => {
    expect(qualifierPrefix('exact')).toBe('');
    expect(qualifierPrefix('floor')).toBe('≥');
  });

  it('will not claim a bound once a rate was derived from a shape, in either direction', () => {
    // The derived per-unit rate runs above r5 and below c5, so no bound holds.
    expect(qualifierPrefix('approximate')).toBe('≈');
    expect(qualifierPrefix('approximate-floor')).toBe('≈');
  });

  it('treats an absent qualifier as no claim rather than as exact-looking money', () => {
    expect(qualifierPrefix(null)).toBe('');
    expect(qualifierPrefix(undefined)).toBe('');
  });
});

describe('qualifiedUsd', () => {
  it('applies one qualifier to every figure, so a tile and a row cannot disagree', () => {
    expect(qualifiedUsd(4102, 'floor')).toBe('≥$4,102');
    expect(qualifiedUsd(4102, 'approximate')).toBe('≈$4,102');
    expect(qualifiedUsd(4102, 'exact')).toBe('$4,102');
  });

  it('renders null as an em-dash, never as $0', () => {
    expect(qualifiedUsd(null, 'floor')).toBe('—');
    expect(qualifiedUsd(undefined, 'exact')).toBe('—');
    expect(usd(null)).toBe('—');
  });

  it('keeps the same discipline on the hourly figure', () => {
    expect(qualifiedHourlyUsd(5.617, 'floor')).toBe('≥$5.62');
    expect(qualifiedHourlyUsd(5.617, 'approximate-floor')).toBe('≈$5.62');
    expect(qualifiedHourlyUsd(null, 'floor')).toBe('—');
  });
});

describe('qualifierCaption', () => {
  it('names the two kinds of doubt separately', () => {
    expect(qualifierCaption('floor', 2, 0)).toBe('a floor — 2 nodes could not be priced at all');
    expect(qualifierCaption('approximate', 0, 1)).toBe(
      'an approximation — 1 node priced from its shape, not from a stated rate'
    );
    expect(qualifierCaption('approximate-floor', 1, 3)).toBe(
      '1 node could not be priced at all, and 3 nodes priced from their shape, not from a stated rate — so this is neither exact nor a bound'
    );
  });

  it('never prints a count it does not have as 0', () => {
    // A qualifier with an absent count used to read "a floor — 0 nodes could not be priced at
    // all", which contradicts the qualifier it is explaining.
    expect(qualifierCaption('floor', null, 0)).toBe(
      'a floor — the number of nodes that could not be priced is not reported'
    );
    expect(qualifierCaption('approximate', 0, undefined)).toBe(
      'an approximation — an unreported number of nodes were priced from their shape, not from a stated rate'
    );
  });

  it('says what the figure is when nothing is in doubt', () => {
    expect(qualifierCaption('exact', 0, 0)).toBe('per month, at list rate plus the Kyma management fee');
  });
});

describe('qualifierPillLabel', () => {
  it('tells the simulator what its delta is measured against', () => {
    expect(qualifierPillLabel('floor')).toBe('vs a floor');
    expect(qualifierPillLabel('approximate')).toBe('vs an approximation');
    expect(qualifierPillLabel('approximate-floor')).toBe('vs an unbounded approximation');
    expect(qualifierPillLabel('exact')).toBeNull();
  });
});

describe('rateCardProvenance', () => {
  it('prints the built-in list as having no region dimension, rather than falling silent', () => {
    expect(
      rateCardProvenance({
        rateCard: 'built-in',
        rateCardRegion: null,
        rateCardRegionNote: 'no region dimension — rates are a single built-in list',
        rateCardAsOf: '2026-09-21',
        rateCardAsOfBasis: 'the date these rates were last edited in this repository, not a market quote'
      })
    ).toBe(
      'built-in; no region dimension — rates are a single built-in list; rates as of 2026-09-21 (the date these rates were last edited in this repository, not a market quote)'
    );
  });

  it('prints an override file’s own region and date', () => {
    expect(
      rateCardProvenance({
        rateCard: 'file:/etc/rates.json',
        rateCardRegion: 'eu-central-1',
        rateCardAsOf: '2026-08-01',
        rateCardAsOfBasis: 'as stated by the override file'
      })
    ).toBe('file:/etc/rates.json; region eu-central-1; rates as of 2026-08-01 (as stated by the override file)');
  });

  it('reports a missing date as unknown age, never as today', () => {
    const text = rateCardProvenance({ rateCard: 'file:/etc/rates.json' });
    expect(text).toContain('no price date recorded, so their age is unknown');
    expect(text).toContain('no region recorded');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('does not invent a source when the payload is absent', () => {
    expect(rateCardProvenance(undefined)).toContain('unknown source');
  });
});

describe('unattributedNote', () => {
  it('says the remainder is unknown, and that the unweighed spend is not idle', () => {
    expect(unattributedNote(1)).toBe(
      '1 namespace could not be weighed against cluster allocatable, so the unrequested remainder is not known — it is not 0, and their spend is not idle'
    );
    expect(unattributedNote(2)).toContain('2 namespaces could not be weighed');
  });

  it('distinguishes "attribution never ran" from "every namespace was weighed"', () => {
    expect(unattributedNote(null)).toBe(
      'attribution was not computed for this cluster, so how many namespaces could not be weighed is not reported — the unrequested remainder is not 0'
    );
  });

  it('stays silent when every namespace was weighed', () => {
    expect(unattributedNote(0)).toBeNull();
    expect(unattributedNote(undefined)).toBeNull();
  });
});
