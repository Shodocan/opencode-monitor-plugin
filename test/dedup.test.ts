import { describe, expect, it } from 'vitest';
import type { AutoSubmitRequest } from '../src/types.js';
import { dedupKey, hashText, isDedupEligible } from '../src/delivery/dedup.js';

function req(
  sessionID = 's1',
  jobID = 'bg_1',
  kind: AutoSubmitRequest['kind'] = 'bg',
  text = 'hello',
): AutoSubmitRequest {
  return { sessionID, jobID, kind, text, submit: true };
}

describe('hashText', () => {
  it('is deterministic for the same input', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
  });
  it('differs for different input', () => {
    expect(hashText('hello')).not.toBe(hashText('world'));
  });
  it('is stable for empty string', () => {
    expect(hashText('')).toBe(hashText(''));
  });
});

describe('dedupKey', () => {
  it('is equal for identical requests', () => {
    expect(dedupKey(req())).toBe(dedupKey(req()));
  });
  it('differs when sessionID changes', () => {
    expect(dedupKey(req('s1'))).not.toBe(dedupKey(req('s2')));
  });
  it('differs when jobID changes', () => {
    expect(dedupKey(req('s1', 'bg_1'))).not.toBe(dedupKey(req('s1', 'bg_2')));
  });
  it('differs when kind changes', () => {
    expect(dedupKey(req('s1', 'bg_1', 'mon'))).not.toBe(dedupKey(req('s1', 'bg_1', 'bg')));
  });
  it('differs when text changes', () => {
    expect(dedupKey(req('s1', 'bg_1', 'bg', 'a'))).not.toBe(dedupKey(req('s1', 'bg_1', 'bg', 'b')));
  });
});

describe('isDedupEligible', () => {
  it('returns false for loop', () => {
    expect(isDedupEligible('loop')).toBe(false);
  });
  it('returns true for bg', () => {
    expect(isDedupEligible('bg')).toBe(true);
  });
  it('returns true for mon', () => {
    expect(isDedupEligible('mon')).toBe(true);
  });
  it('returns true for sched', () => {
    expect(isDedupEligible('sched')).toBe(true);
  });
});