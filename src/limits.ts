// General limits
export const MAX_ACTIVE_JOBS = 20;
export const MAX_COMPLETED_RETENTION = 50;

// Process output caps
export const PROCESS_OUTPUT_CAP_LINES = 200;
export const PROCESS_OUTPUT_CAP_BYTES = 32 * 1024;

// Monitor limits
export const MONITOR_RING_BUFFER_EVENTS = 50_000;
export const MONITOR_AFTER_WAIT_MS = 5_000;
export const MONITOR_DEBOUNCE_DEFAULT_MS = 5_000;
export const MONITOR_PER_DELIVERY_CAP_BYTES = 16 * 1024;
export const MONITOR_PER_DELIVERY_CAP_EVENTS = 200;
export const MAX_MONITOR_CONTEXT_LINES = 200;
export const MAX_LINE_LENGTH = 8 * 1024;

// Regex limits
export const MAX_REGEX_PATTERN_LENGTH = 512;

// Monitor debounce range (seconds)
export const MIN_MONITOR_DEBOUNCE_S = 1;
export const MAX_MONITOR_DEBOUNCE_S = 60;

// Loop limits
export const MIN_LOOP_INTERVAL_MS = 10_000;

// Schedule limits
export const MAX_SCHEDULE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

// Delivery queue limits
export const MAX_PENDING_PER_JOB = 20;
export const MAX_PENDING_GLOBAL = 100;
export const MAX_QUEUE_BYTES_TOTAL = 1024 * 1024;

// Bridge limits
export const BRIDGE_UNAVAILABLE_EXPIRY_MS = 10 * 60 * 1000;

// ReDoS worker limits
export const REDOS_TIMEOUT_MS = 100;
export const REDOS_MAX_CONCURRENT = 4;
export const REDOS_MAX_QUEUED_PER_MONITOR = 10;

// Cancellation limits
export const CANCEL_SIGKILL_TIMEOUT_MS = 5_000;
