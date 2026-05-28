import { mkdtemp, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach, vi } from 'vitest';
import type { AutoSubmitRequest } from '../src/types.js';
import {
  BridgeServer,
  readBridgeConfig,
  validateBearerToken,
  writeBridgeConfig,
  type AppendNotification,
} from '../src/bridge/server.js';

const servers: BridgeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  vi.unstubAllEnvs();
});

function req(sessionID = 's1', jobID = 'bg_1'): AutoSubmitRequest {
  return { sessionID, jobID, kind: 'bg', text: 'submit me', submit: true };
}

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-monitor-bridge-'));
  return join(dir, 'nested', 'bridge.json');
}

describe('bridge config and bearer token handling', () => {
  it('uses OPENCODE_MONITOR_BRIDGE_CONFIG by default and writes private modes', async () => {
    const configPath = await tempConfigPath();
    vi.stubEnv('OPENCODE_MONITOR_BRIDGE_CONFIG', configPath);

    const config = { url: 'http://127.0.0.1:12345', token: 'a'.repeat(43) };
    await writeBridgeConfig(configPath, config);

    expect(await readBridgeConfig()).toEqual(config);
    expect((await stat(join(configPath, '..'))).mode & 0o777).toBe(0o700);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects group/world-accessible config files before returning secrets', async () => {
    const configPath = await tempConfigPath();
    await writeBridgeConfig(configPath, { url: 'http://127.0.0.1:1', token: 'b'.repeat(43) });
    await chmod(configPath, 0o644);

    await expect(readBridgeConfig(configPath)).rejects.toThrow(/permissions/i);
  });

  it('rejects non-exact config file and parent directory modes', async () => {
    const configPath = await tempConfigPath();
    await writeBridgeConfig(configPath, { url: 'http://127.0.0.1:1', token: 'c'.repeat(43) });

    await chmod(configPath, 0o400);
    await expect(readBridgeConfig(configPath)).rejects.toThrow(/permissions/i);

    await chmod(configPath, 0o600);
    await chmod(join(configPath, '..'), 0o755);
    await expect(readBridgeConfig(configPath)).rejects.toThrow(/parent/i);
  });

  it('generates long base64url tokens and rejects unsafe token values', async () => {
    const configPath = await tempConfigPath();
    const server = new BridgeServer({ configPath });
    servers.push(server);

    const config = await server.start();

    expect(config.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(config.token.length).toBeGreaterThanOrEqual(43);
    expect(() => validateBearerToken('')).toThrow(/token/i);
    expect(() => validateBearerToken('example-token')).toThrow(/token/i);
    expect(() => validateBearerToken('changeme')).toThrow(/token/i);
    expect(() => validateBearerToken('x'.repeat(42))).toThrow(/token/i);
  });
});

describe('BridgeServer HTTP API', () => {
  it('listens on loopback only and exposes unauthenticated health without secrets', async () => {
    const server = new BridgeServer({ configPath: await tempConfigPath() });
    servers.push(server);
    const config = await server.start();

    expect(new URL(config.url).hostname).toMatch(/^(127\.0\.0\.1|\[::1\])$/);

    const response = await fetch(`${config.url}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain(config.token);
  });

  it('requires bearer auth and never includes token text in auth errors', async () => {
    const server = new BridgeServer({ configPath: await tempConfigPath() });
    servers.push(server);
    const config = await server.start();

    const missing = await fetch(`${config.url}/notify/append-submit`, { method: 'POST' });
    const wrong = await fetch(`${config.url}/notify/append-submit`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(missing.status).toBe(401);
    expect(await missing.text()).not.toContain(config.token);
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(config.token);
  });

  it('rejects notify requests for unregistered sessions', async () => {
    const server = new BridgeServer({ configPath: await tempConfigPath() });
    servers.push(server);
    const config = await server.start();

    const response = await fetch(`${config.url}/notify/append-submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(req('unseen-session')),
    });

    expect(response.status).toBe(409);
  });

  it('queues busy/retry/unknown sessions and delivers append notification only after idle', async () => {
    const delivered: AppendNotification[] = [];
    const server = new BridgeServer({
      configPath: await tempConfigPath(),
      onAppend: (payload) => {
        delivered.push(payload);
        return true;
      },
    });
    servers.push(server);
    const config = await server.start();
    server.setSessionStatus('s1', 'busy');
    server.setSessionStatus('s2', 'retry');
    server.setSessionStatus('s3', undefined);

    const response = await fetch(`${config.url}/notify/append-submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(req('s1', 'bg_9')),
    });

    expect(response.status).toBe(202);
    expect(delivered).toEqual([]);

    for (const sessionID of ['s2', 's3']) {
      const queued = await fetch(`${config.url}/notify/append-submit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(req(sessionID, `bg_${sessionID}`)),
      });
      expect(queued.status).toBe(202);
    }
    expect(delivered).toEqual([]);

    server.setSessionStatus('s1', 'idle');
    expect(delivered).toEqual([
      {
        method: 'notifications/opencode/prompt/append',
        params: { text: 'submit me', submit: true, sessionID: 's1' },
        jobID: 'bg_9',
        kind: 'bg',
      },
    ]);

    server.setSessionStatus('s2', 'idle');
    server.setSessionStatus('s3', 'idle');
    expect(delivered.map((payload) => payload.params.sessionID)).toEqual(['s1', 's2', 's3']);
  });

  it('does not flush a busy session when another session is idle', async () => {
    const delivered: AppendNotification[] = [];
    const server = new BridgeServer({
      configPath: await tempConfigPath(),
      onAppend: (payload) => {
        delivered.push(payload);
        return true;
      },
    });
    servers.push(server);
    const config = await server.start();
    server.setSessionStatus('s1', 'idle');
    server.setSessionStatus('s2', 'busy');

    const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
    await fetch(`${config.url}/notify/append-submit`, {
      method: 'POST', headers, body: JSON.stringify(req('s2', 'bg_busy')),
    });
    await fetch(`${config.url}/notify/append-submit`, {
      method: 'POST', headers, body: JSON.stringify(req('s1', 'bg_idle')),
    });

    expect(delivered.map((payload) => payload.params.sessionID)).toEqual(['s1']);
    server.setSessionStatus('s2', 'idle');
    expect(delivered.map((payload) => payload.params.sessionID)).toEqual(['s1', 's2']);
  });
});
