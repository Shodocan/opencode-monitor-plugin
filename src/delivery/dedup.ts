import crypto from 'node:crypto';
import type { AutoSubmitRequest, JobKind } from '../types.js';

/**
 * SHA-1 hash of `text`. Non-security use — collisions are irrelevant at
 * payload scale (≤16 KB monitor / ≤32 KB bg output). Used only as a
 * dedup identity component.
 */
export function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * Identity key for content dedup. Includes `kind` so a `mon` entry can
 * never collide with a `loop` entry for the same job. `agent` is
 * intentionally excluded (same job → same session).
 */
export function dedupKey(req: AutoSubmitRequest): string {
  return `${req.sessionID}::${req.jobID}::${req.kind}::${hashText(req.text)}`;
}

/**
 * Eligibility policy shared by both queues. `/loop` has its own existing
 * coalesce path and is excluded; all other kinds are dedup-eligible.
 */
export function isDedupEligible(kind: JobKind): boolean {
  return kind !== 'loop';
}