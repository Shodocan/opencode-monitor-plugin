import crypto from 'node:crypto';
import type { AutoSubmitRequest, FormattedDelivery, FormatterOptions, JobKind, JobStatus } from '../types.js';

const DEFAULT_MAX_PREVIEW = 200;

// High-entropy nonce generator.
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------
const DIRECTIVE = 'monitor triggered.';

// ----------------------------------------------------------------
// ANSI / control-char sanitizer
// ----------------------------------------------------------------
const ANSI_ESC_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const ANSI_OSC_RE = /\x1b\][^\x07]*\x07/g;

/**
 * Remove ANSI escape sequences, carriage returns, and control characters
 * while preserving newlines and tabs.
 */
export function sanitize(text: string): string {
  return (
    text
      // Strip OSC sequences first
      .replace(ANSI_OSC_RE, '')
      // Strip CSI / other escape sequences
      .replace(ANSI_ESC_RE, '')
      // Strip carriage returns
      .replace(/\r/g, '')
      // Strip any remaining single control chars (except \n \t)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
  );
}

// ----------------------------------------------------------------
// Secret redaction
// ----------------------------------------------------------------

const AUTH_BEARER_RE = /Authorization\s+Bearer\s+[\w-]+/gi;
const URL_USERINFO_RE = /([\w.-]+:\/\/)([^\s@/]+)@/g;

// Groups: $1=boundary $2=key-quote $3=key-name $4=pre-separator whitespace
// $5=separator (: or =) $6=post-separator whitespace $7=value-quote $8=value.
// Backrefs: \2 (key-quote close), \7 (value-quote close).
const NONCE_RE = /^[0-9a-f]{32}$/;
const SECRET_PATTERN_RE =
  /([\s,;:{\[({=]|^)(["']?)((?:TOKEN|ACCESS_TOKEN|BEARER_TOKEN|PRIVATE_KEY|API_KEY|SECRET|PASSWORD))\2(\s*)([=:])(\s*)(["']?)([\w\-/.+%=@!$^*]+)\7/gi;

/**
 * Best-effort redaction of secrets in a string.
 * Replaces values after the known key names and in common URL / header patterns.
 */
export function redactSecrets(text: string): string {
  // Key SEP value / "value" patterns — preserve boundary, key, separator, whitespace, and quotes.
  text = text.replace(SECRET_PATTERN_RE, (_m, b, q1, key, ws1, sep, ws2, q2, _value) =>
    `${b}${q1}${key}${q1}${ws1}${sep}${ws2}${q2}****${q2}`,
  );

  // Authorization Bearer headers
  text = text.replace(AUTH_BEARER_RE, 'Authorization Bearer ****');

  // url://user:pass@host → url://****@host
  text = text.replace(URL_USERINFO_RE, '$1****@');

  return text;
}

// ----------------------------------------------------------------
// Preview truncator
// ----------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

/**
 * Detect whether `text` is already a nonce-fenced block.
 * Returns the unwrapped inner content if fenced, otherwise `undefined`.
 */
function unwrapNonceFence(text: string): string | undefined {
  const lines = text.split('\n');
  if (lines.length < 2) return undefined;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!NONCE_RE.test(first) || !NONCE_RE.test(last) || first !== last) return undefined;
  return lines.slice(1, -1).join('\n');
}

// ----------------------------------------------------------------
// Kind label helpers
// ----------------------------------------------------------------

function kindLabel(kind: JobKind | string): string {
  const labels: Record<JobKind, string> = {
    bg: 'background',
    mon: 'monitor',
    loop: 'loop',
    sched: 'schedule',
  };
  return labels[kind as JobKind] ?? kind;
}

function statusLabel(status: string): string {
  return status === 'cancelled' ? 'cancelled' : status;
}

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

const DEFAULT_OPTIONS: FormatterOptions = {
  maxPreviewLen: DEFAULT_MAX_PREVIEW,
};

/**
 * Format a delivery payload into structured text for AutoSubmitRequest.
 *
 * Produces:
 *  - `text`: the main block (background / monitor / loop / schedule / jobs / cancel description)
 *  - `commandPreview` / `promptPreview`: truncated previews (≤200 chars)
 *  - Untrusted output is always wrapped in a nonce-delimited block with a status label.
 */
export function formatDelivery(raw: string, opts?: FormatterOptions): FormattedDelivery {
  const { nonce = generateNonce(), maxPreviewLen = DEFAULT_MAX_PREVIEW } = { ...DEFAULT_OPTIONS, ...opts };

  const sanitized = sanitize(raw);
  const redacted = redactSecrets(sanitized);

  // Build the delivery text: nonce fence → directive → content → nonce fence
  const text = [
    nonce,
    DIRECTIVE,
    redacted,
    nonce,
  ].join('\n');

  return {
    text,
    commandPreview: redacted ? truncate(redacted, maxPreviewLen) : undefined,
    promptPreview: redacted ? truncate(redacted, maxPreviewLen) : undefined,
  };
}

/**
 * Format a full auto-submit request into its final text payload.
 *
 * Wraps the delivery text with job metadata. If `request.text` is already
 * a nonce-fenced block (e.g. from `formatDelivery`), the fences are merged
 * rather than producing nested nonce blocks.
 */
export function formatAutoSubmit(request: AutoSubmitRequest, opts?: FormatterOptions): string {
  const { nonce = generateNonce() } = { ...DEFAULT_OPTIONS, ...opts };
  const kind = kindLabel(request.kind);

  // If input text is already nonce-fenced, unwrap to avoid nested fences.
  const inner = unwrapNonceFence(request.text);

  const lines = inner !== undefined
    // Already-fenced input: merge into single fence with metadata and directive.
    ? [nonce, `[${kind}] job=${request.jobID}`, DIRECTIVE, inner, nonce]
    // Raw input: wrap with directive.
    : [nonce, DIRECTIVE, `[${kind}] job=${request.jobID}`, request.text, nonce];

  return lines.join('\n');
}

/**
 * Format a collection of job statuses for delivery.
 */
export function formatJobs(jobs: JobStatus[], opts?: FormatterOptions): FormattedDelivery {
  const { nonce = generateNonce(), maxPreviewLen = DEFAULT_MAX_PREVIEW } = { ...DEFAULT_OPTIONS, ...opts };

  const parts: string[] = [];
  for (const job of jobs) {
    const label = kindLabel(job.kind);
    parts.push(`${job.jobID} (${label}) → ${statusLabel(job.status)}`);
  }
  const body = parts.join('\n');
  const text = [
    nonce,
    DIRECTIVE,
    body,
    nonce,
  ].join('\n');

  return {
    text,
    commandPreview: truncate(body, maxPreviewLen),
    promptPreview: truncate(body, maxPreviewLen),
  };
}

/**
 * Format a cancel notification for delivery.
 */
export function formatCancel(jobID: string, kind: string, opts?: FormatterOptions): FormattedDelivery {
  const { nonce = generateNonce() } = { ...DEFAULT_OPTIONS, ...opts };
  const body = `${jobID} (${kindLabel(kind)}) → cancelled`;
  const text = [nonce, DIRECTIVE, body, nonce].join('\n');

  return {
    text,
    commandPreview: body,
    promptPreview: body,
  };
}
