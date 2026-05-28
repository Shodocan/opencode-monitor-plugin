import type { AutoSubmitRequest } from '../types.js';
import { readBridgeConfig } from '../bridge/server.js';

export async function appendSubmitToSession(req: AutoSubmitRequest, configPath?: string): Promise<void> {
  const config = await readBridgeConfig(configPath);
  const response = await fetch(`${config.url}/notify/append-submit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    throw new Error(`bridge notify failed with status ${response.status}`);
  }
}

export async function health(configPath?: string): Promise<{ ok: true }> {
  const config = await readBridgeConfig(configPath);
  const response = await fetch(`${config.url}/health`);
  if (!response.ok) {
    throw new Error(`bridge health failed with status ${response.status}`);
  }
  const body = await response.json() as { ok?: unknown };
  if (body.ok !== true) throw new Error('bridge health response is invalid');
  return { ok: true };
}
