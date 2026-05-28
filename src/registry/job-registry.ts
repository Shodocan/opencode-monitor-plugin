import type {
  DeliveryStatus,
  JobKind,
  JobState,
  JobStatus,
} from '../types.js';
import { MAX_ACTIVE_JOBS, MAX_COMPLETED_RETENTION } from '../limits.js';

// ----------------------------------------------------------------
// SessionRef — short hash of sessionID (internal-only)
// ----------------------------------------------------------------

function shortSessionRef(sessionID: string): string {
  let h = 0;
  for (let i = 0; i < sessionID.length; i++) {
    h = ((h << 5) - h) + sessionID.charCodeAt(i) | 0;
  }
  return `${(h >>> 0).toString(36)}`;
}

// ----------------------------------------------------------------
// Job registry
// ----------------------------------------------------------------

export interface JobRegistryEntry {
  jobID: string;
  kind: JobKind;
  status: JobState;
  sessionRef: string;
  deliveryStatus: DeliveryStatus;
  queueDroppedCount: number;
}

export class JobRegistry {
  #counter: number = 0;
  #active = new Map<string, JobRegistryEntry>();
  #completed: JobRegistryEntry[] = [];
  #sessionID: string;

  constructor(sessionID: string) {
    this.#sessionID = sessionID;
  }

  /** Return the session-scoped short reference (derived from sessionID). */
  get sessionRef(): string {
    return shortSessionRef(this.#sessionID);
  }

  /** Number of currently active jobs. */
  get activeCount(): number {
    return this.#active.size;
  }

  // -- Lifecycle -------------------------------------------------

  /**
   * Register a new job.  Returns the generated jobID.
   *
   * @throws `Error: max active jobs (20)` when limit is reached.
   */
  register(kind: JobKind): string {
    if (this.#active.size >= MAX_ACTIVE_JOBS) {
      throw new Error(`max active jobs (${MAX_ACTIVE_JOBS})`);
    }

    this.#counter += 1;
    const jobID = `${kind}_${this.#counter}`;

    const entry: JobRegistryEntry = {
      jobID,
      kind,
      status: 'active',
      sessionRef: this.sessionRef,
      deliveryStatus: 'pending',
      queueDroppedCount: 0,
    };

    this.#active.set(jobID, entry);
    return jobID;
  }

  /**
   * Get a job by ID.  Returns `undefined` when not found.
   */
  get(jobID: string): JobStatus | undefined {
    return this.#toStatus(this.#active.get(jobID) ?? this.#completed.find((e) => e.jobID === jobID));
  }

  /** List all jobs (active + recently completed). */
  list(): JobStatus[] {
    const statuses: JobStatus[] = [];
    for (const [, entry] of this.#active) {
      statuses.push(this.#toStatus(entry));
    }
    statuses.push(...this.#completed.map(this.#toStatus));
    return statuses;
  }

  /**
   * Cancel a job.  Only active jobs may be cancelled.
   *
   * @throws `Error: job {jobID} not found.`
   * @throws `Error: job {jobID} cannot be cancelled (status: {status}).`
   */
  cancel(jobID: string): void {
    const entry = this.#active.get(jobID);
    if (!entry) {
      const inCompleted = this.#completed.find((e) => e.jobID === jobID);
      if (!inCompleted) {
        throw new Error(`job ${jobID} not found.`);
      }
      throw new Error(`job ${jobID} cannot be cancelled (status: ${inCompleted.status}).`);
    }

    if (entry.status !== 'active') {
      this.#active.delete(jobID);
      this.#completed.push(entry);
      throw new Error(`job ${jobID} cannot be cancelled (status: ${entry.status}).`);
    }

    entry.status = 'cancelled';
    this.#active.delete(jobID);
    this.#completed.push(entry);
    this.#trimCompleted();
  }

  /**
   * Mark a job as completed (internal transition).
   */
  complete(jobID: string): void {
    const entry = this.#active.get(jobID);
    if (!entry) return;
    entry.status = 'completed';
    this.#active.delete(jobID);
    this.#completed.push(entry);
    this.#trimCompleted();
  }

  /**
   * Mark a job as failed (internal transition).
   */
  fail(jobID: string, deliveryStatus?: DeliveryStatus, queueDroppedCount?: number): void {
    const entry = this.#active.get(jobID);
    if (!entry) return;
    entry.status = 'failed';
    if (deliveryStatus !== undefined) entry.deliveryStatus = deliveryStatus;
    if (queueDroppedCount !== undefined) entry.queueDroppedCount = queueDroppedCount;
    this.#active.delete(jobID);
    this.#completed.push(entry);
    this.#trimCompleted();
  }

  /**
   * Update delivery status of an existing job (active or completed).
   *
   * @throws `Error: job {jobID} not found.`
   */
  updateDeliveryStatus(jobID: string, deliveryStatus: DeliveryStatus): void {
    const entry = this.#active.get(jobID) ?? this.#completed.find((e) => e.jobID === jobID);
    if (!entry) {
      throw new Error(`job ${jobID} not found.`);
    }
    entry.deliveryStatus = deliveryStatus;
  }

  /**
   * Add to the queue-dropped counter.
   *
   * @throws `Error: job {jobID} not found.`
   */
  incrementQueueDropped(jobID: string, count = 1): void {
    const entry = this.#active.get(jobID) ?? this.#completed.find((e) => e.jobID === jobID);
    if (!entry) {
      throw new Error(`job ${jobID} not found.`);
    }
    entry.queueDroppedCount += count;
  }

  // -- Internal --------------------------------------------------

  #toStatus(entry: JobRegistryEntry | undefined): JobStatus | undefined {
    if (!entry) return undefined;
    return {
      jobID: entry.jobID,
      kind: entry.kind,
      status: entry.status,
      sessionRef: entry.sessionRef,
      deliveryStatus: entry.deliveryStatus,
      queueDroppedCount: entry.queueDroppedCount,
    };
  }

  #trimCompleted(): void {
    while (this.#completed.length > MAX_COMPLETED_RETENTION) {
      this.#completed.shift();
    }
  }
}

export default JobRegistry;
