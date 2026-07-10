export type JobKind = 'bg' | 'mon' | 'loop' | 'sched';
export type JobState = 'active' | 'completed' | 'failed' | 'cancelled';
export type DeliveryStatus = 'pending' | 'sent' | 'bridge_failed' | 'unknown';
export type OutputStream = 'stdout' | 'stderr';

export interface OutputEvent {
  jobID: string;
  seq: number;
  stream: OutputStream;
  line: string;
  timestamp: number;
}

export interface AutoSubmitRequest {
  sessionID: string;
  agent?: string;
  jobID: string;
  kind: JobKind;
  text: string;
  submit: true;
}

export interface JobStatus {
  jobID: string;
  kind: JobKind;
  status: JobState;
  sessionRef?: string;
  deliveryStatus?: DeliveryStatus;
  queueDroppedCount?: number;
  createdAt: number;
}

export interface FormatterOptions {
  nonce?: string;
  maxPreviewLen?: number;
}

export interface FormattedDelivery {
  text: string;
  commandPreview?: string;
  promptPreview?: string;
}
