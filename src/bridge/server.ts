import crypto from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, open, readFile, stat, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { IdleQueue, type SessionStatus } from './idle-queue.js';
import type { AutoSubmitRequest, JobKind } from '../types.js';

export interface BridgeConfig {
  url: string;
  token: string;
}

export interface AppendNotification {
  method: 'notifications/opencode/prompt/append';
  params: { text: string; submit: true; sessionID: string };
  jobID: string;
  kind: JobKind;
}

export interface BridgeServerOptions {
  configPath?: string;
  host?: '127.0.0.1' | '::1';
  port?: number;
  onAppend?: (payload: AppendNotification) => boolean;
}

const CONFIG_ENV = 'OPENCODE_MONITOR_BRIDGE_CONFIG';
const TOKEN_BYTES = 32;
const MIN_BASE64URL_TOKEN_LENGTH = 43;
const UNSAFE_TOKENS = new Set(['default', 'example', 'example-token', 'changeme', 'change-me', 'token']);

function resolveConfigPath(path?: string): string {
  const resolved = path ?? process.env[CONFIG_ENV];
  if (!resolved) throw new Error(`${CONFIG_ENV} is required`);
  return resolved;
}

function generateBearerToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

export function validateBearerToken(token: string): void {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('bridge bearer token is invalid');
  }
  if (token.length < MIN_BASE64URL_TOKEN_LENGTH) {
    throw new Error('bridge bearer token is invalid');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('bridge bearer token is invalid');
  }
  if (UNSAFE_TOKENS.has(token.toLowerCase())) {
    throw new Error('bridge bearer token is invalid');
  }
}

function assertLoopbackUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:') throw new Error('bridge URL must use http');
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]' && parsed.hostname !== '::1') {
    throw new Error('bridge URL must be loopback');
  }
}

export async function writeBridgeConfig(path: string, config: BridgeConfig): Promise<void> {
  validateBearerToken(config.token);
  assertLoopbackUrl(config.url);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);

  const handle = await open(path, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

export async function readBridgeConfig(path?: string): Promise<BridgeConfig> {
  const configPath = resolveConfigPath(path);
  const parentInfo = await stat(dirname(configPath));
  const parentMode = parentInfo.mode & 0o777;
  if (parentMode !== 0o700) {
    throw new Error('bridge config parent permissions are invalid');
  }
  if (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid()) {
    throw new Error('bridge config parent owner is invalid');
  }

  const info = await stat(configPath);
  const mode = info.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error('bridge config permissions are invalid');
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('bridge config owner is invalid');
  }

  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Partial<BridgeConfig>;
  if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string') {
    throw new Error('bridge config is invalid');
  }
  validateBearerToken(parsed.token);
  assertLoopbackUrl(parsed.url);
  return { url: parsed.url, token: parsed.token };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function isJobKind(value: unknown): value is JobKind {
  return value === 'bg' || value === 'mon' || value === 'loop' || value === 'sched';
}

function parseAutoSubmitRequest(value: unknown): AutoSubmitRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionID !== 'string' ||
    typeof record.jobID !== 'string' ||
    typeof record.text !== 'string' ||
    record.submit !== true ||
    !isJobKind(record.kind)
  ) {
    return undefined;
  }
  return {
    sessionID: record.sessionID,
    jobID: record.jobID,
    kind: record.kind,
    text: record.text,
    submit: true,
  };
}

function toAppendNotification(req: AutoSubmitRequest): AppendNotification {
  return {
    method: 'notifications/opencode/prompt/append',
    params: { text: req.text, submit: true, sessionID: req.sessionID },
    jobID: req.jobID,
    kind: req.kind,
  };
}

export class BridgeServer {
  #options: BridgeServerOptions;
  #server?: Server;
  #config?: BridgeConfig;
  #registeredSessions = new Set<string>();
  #idleQueue: IdleQueue;

  constructor(options: BridgeServerOptions = {}) {
    this.#options = options;
    const onAppend = options.onAppend ?? (() => true);
    this.#idleQueue = new IdleQueue(undefined, (req) => onAppend(toAppendNotification(req)));
  }

  async start(): Promise<BridgeConfig> {
    if (this.#server) return this.#config!;
    const host = this.#options.host ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== '::1') {
      throw new Error('bridge host must be loopback');
    }

    const token = generateBearerToken();
    validateBearerToken(token);
    const server = createServer((req, res) => {
      void this.#handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#options.port ?? 0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('bridge listen failed');
    const hostname = host === '::1' ? '[::1]' : host;
    this.#server = server;
    this.#config = { url: `http://${hostname}:${address.port}`, token };
    await writeBridgeConfig(resolveConfigPath(this.#options.configPath), this.#config);
    return this.#config;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    this.#config = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  setSessionStatus(sessionID: string, status: SessionStatus | undefined): void {
    this.#registeredSessions.add(sessionID);
    this.#idleQueue.setSessionStatus(status, sessionID);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/notify/append-submit') {
        await this.#handleAppendSubmit(req, res);
        return;
      }
      writeJson(res, 404, { error: 'not found' });
    } catch {
      writeJson(res, 500, { error: 'bridge request failed' });
    }
  }

  async #handleAppendSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#isAuthorized(req.headers.authorization)) {
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      writeJson(res, 400, { error: 'invalid json' });
      return;
    }
    const request = parseAutoSubmitRequest(body);
    if (!request) {
      writeJson(res, 400, { error: 'invalid append request' });
      return;
    }
    if (!this.#registeredSessions.has(request.sessionID)) {
      writeJson(res, 409, { error: 'session is not registered' });
      return;
    }

    this.#idleQueue.deliver(request);
    if (this.#idleQueue.getSessionStatus(request.sessionID) === 'idle') {
      this.#idleQueue.flush(request.sessionID);
    }
    writeJson(res, 202, { ok: true });
  }

  #isAuthorized(header: string | undefined): boolean {
    if (!this.#config || typeof header !== 'string') return false;
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) return false;
    const candidate = header.slice(prefix.length);
    if (candidate.length !== this.#config.token.length) return false;
    const expected = Buffer.from(this.#config.token);
    const actual = Buffer.from(candidate);
    return crypto.timingSafeEqual(expected, actual);
  }
}
