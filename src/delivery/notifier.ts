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
