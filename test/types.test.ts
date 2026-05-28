import { describe, expect, it } from 'vitest';
import { MAX_ACTIVE_JOBS } from '../src/limits.js';
import type { AutoSubmitRequest, JobKind, OutputEvent } from '../src/types.js';

describe('core types and limits', () => {
  it('exposes v1 limits', () => expect(MAX_ACTIVE_JOBS).toBe(20));
  it('uses short job kinds', () => { const k: JobKind = 'mon'; expect(k).toBe('mon'); });
  it('types delivery payloads', () => {
    const e: OutputEvent = { jobID: 'mon_1', seq: 1, stream: 'stdout', line: 'x', timestamp: 1 };
    const r: AutoSubmitRequest = { sessionID: 's', jobID: 'mon_1', kind: 'mon', text: 'x', submit: true };
    expect(e.line).toBe(r.text);
  });
});
