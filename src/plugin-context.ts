export type InvocationOrigin = 'user' | 'model' | 'synthetic' | 'system';

export interface PluginContext {
  sessionID?: string;
  agent?: string;
  invocationOrigin?: InvocationOrigin;
  registerSlashCommand(name: string, handler: (raw: string, ctx: PluginContext) => Promise<string>): void;
}

export function requireDirectUserContext(ctx: PluginContext): string {
  if (!ctx.sessionID) throw new Error('sessionID is required for opencode-monitor commands');
  if (ctx.invocationOrigin !== 'user') {
    throw new Error('opencode-monitor commands require direct user slash-command invocation');
  }
  return ctx.sessionID;
}
