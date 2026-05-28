import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeServer, type AppendNotification } from '../src/bridge/server.js';
import { appendSubmitToSession, health } from '../src/delivery/notifier.js';

const servers: BridgeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  vi.unstubAllEnvs();
});

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-monitor-notifier-'));
  return join(dir, 'bridge.json');
}

describe('appendSubmitToSession notifier', () => {
  it('reads config path from env and posts canonical append-submit payload with bearer auth', async () => {
    const configPath = await tempConfigPath();
    vi.stubEnv('OPENCODE_MONITOR_BRIDGE_CONFIG', configPath);
    const delivered: AppendNotification[] = [];
    const server = new BridgeServer({
      configPath,
      onAppend: (payload) => {
        delivered.push(payload);
        return true;
      },
    });
    servers.push(server);
    await server.start();
    server.setSessionStatus('s1', 'idle');

    await appendSubmitToSession({ sessionID: 's1', jobID: 'mon_1', kind: 'mon', text: 'go', submit: true });

    expect(delivered).toEqual([
      {
        method: 'notifications/opencode/prompt/append',
        params: { text: 'go', submit: true, sessionID: 's1' },
        jobID: 'mon_1',
        kind: 'mon',
      },
    ]);
  });

  it('can call bridge health operation from config', async () => {
    const configPath = await tempConfigPath();
    const server = new BridgeServer({ configPath });
    servers.push(server);
    await server.start();

    await expect(health(configPath)).resolves.toEqual({ ok: true });
  });
});
