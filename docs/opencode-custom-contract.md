# opencode Custom MCP TUI Notification Contract

This document describes the custom MCP notification contract supported by the custom `och` opencode build.

## Install/runtime assumptions

- Custom binary command: `och`
- Installed binary path on WSL: `~/.opencode-custom-hindsight/bin/och`
- Public installer URL: `https://s3.casonatto.dev/shared/opencode-custom-hindsight/install.sh`
- Auto-update should be disabled for now:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false
}
```

Restart `och` after changing opencode config or MCP server config.

## MCP server setup

Example `opencode.json` entry for a local MCP server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "mcp": {
    "tui-control": {
      "type": "local",
      "command": ["bun", "/absolute/path/to/server.ts"],
      "enabled": true
    }
  }
}
```

For Node.js, use:

```json
"command": ["node", "/absolute/path/to/server.js"]
```

## Notification methods

All notifications are one-way MCP JSON-RPC notifications sent by the MCP server to opencode.

With `@modelcontextprotocol/sdk`, use the underlying server object:

```ts
await server.server.notification({
  method: "notifications/opencode/toast/show",
  params: { message: "hello", variant: "info" },
})
```

## Status notification from opencode to MCP servers

opencode also sends session status notifications back to connected MCP servers.

This is how an MCP server can tell whether a session is currently idle or busy. It is event-driven: register a notification handler, keep the latest status per `sessionID` in your MCP server, and consult that cache before sending prompts or commands.

Method:

```text
notifications/opencode/session/status
```

Params:

```ts
{
  sessionID: string
  status:
    | { type: "idle" }
    | { type: "busy" }
    | {
        type: "retry"
        attempt: number
        message: string
        next: number
        action?: {
          reason: string
          provider: string
          title: string
          message: string
          label: string
          link?: string
        }
      }
}
```

Example MCP handler:

```ts
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

const sessionStatus = new Map<string, "idle" | "busy" | "retry">()

const SessionStatusNotification = NotificationSchema.extend({
  method: z.literal("notifications/opencode/session/status"),
  params: z.object({
    sessionID: z.string(),
    status: z.discriminatedUnion("type", [
      z.object({ type: z.literal("idle") }),
      z.object({ type: z.literal("busy") }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number().int().nonnegative(),
        message: z.string(),
        next: z.number().int().nonnegative(),
        action: z
          .object({
            reason: z.string(),
            provider: z.string(),
            title: z.string(),
            message: z.string(),
            label: z.string(),
            link: z.string().optional(),
          })
          .optional(),
      }),
    ]),
  }),
})

server.server.setNotificationHandler(SessionStatusNotification, (notification) => {
  sessionStatus.set(notification.params.sessionID, notification.params.status.type)
})

function isSessionIdle(sessionID: string) {
  return sessionStatus.get(sessionID) === "idle"
}

function isSessionBusy(sessionID: string) {
  return sessionStatus.get(sessionID) === "busy" || sessionStatus.get(sessionID) === "retry"
}
```

Notes:

- `busy` means the session is actively running work.
- `idle` means the session is ready for a new prompt.
- `retry` is not idle; treat it as busy/blocking until the session returns to `idle` or the retry is handled.
- opencode only pushes changes; it does not currently provide an MCP request for an initial status snapshot.
- If your MCP server connects after a session is already busy, the cache is unknown until the next status change. Treat unknown as conservative/not-ready unless your tool has another source of truth.

### Append visible prompt text

Method:

```text
notifications/opencode/prompt/append
```

Params:

```ts
{
  text: string
  submit?: boolean
  sessionID?: string
}
```

Example:

```ts
await server.server.notification({
  method: "notifications/opencode/prompt/append",
  params: {
    text: "hello from MCP",
    submit: false,
  },
})
```

Behavior:

- Inserts `text` into the visible TUI prompt.
- If `submit: true`, opencode submits after inserting the text.
- If `sessionID` is provided, opencode only applies the append when the visible prompt belongs to that session.

### Send hidden synthetic prompt

Method:

```text
notifications/opencode/prompt/synthetic
```

Params:

```ts
{
  text: string
  sessionID: string
}
```

Example:

```ts
await server.server.notification({
  method: "notifications/opencode/prompt/synthetic",
  params: {
    text: "Run this hidden instruction",
    sessionID: "ses_...",
  },
})
```

Behavior:

- Queues a hidden synthetic user prompt for `sessionID`.
- Does not type into the visible prompt input.
- Requires a valid opencode session ID.

### Execute TUI command

Method:

```text
notifications/opencode/command/execute
```

Params:

```ts
{
  command: string
}
```

Example:

```ts
await server.server.notification({
  method: "notifications/opencode/command/execute",
  params: {
    command: "prompt.submit",
  },
})
```

Known useful commands:

- `prompt.submit`
- `prompt.clear`
- `session.new`
- `session.list`
- `session.interrupt`
- `session.compact`
- `agent.cycle`

### Show toast

Method:

```text
notifications/opencode/toast/show
```

Params:

```ts
{
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration?: number
}
```

Example:

```ts
await server.server.notification({
  method: "notifications/opencode/toast/show",
  params: {
    title: "MCP",
    message: "Task completed",
    variant: "success",
    duration: 5000,
  },
})
```

Behavior:

- Shows a TUI toast.
- `duration` is in milliseconds.
- If `duration` is omitted, opencode applies its default duration.

### Select session

Method:

```text
notifications/opencode/session/select
```

Params:

```ts
{
  sessionID: string
}
```

Example:

```ts
await server.server.notification({
  method: "notifications/opencode/session/select",
  params: {
    sessionID: "ses_...",
  },
})
```

Behavior:

- Navigates the TUI to the requested session.

## Minimal MCP server example

```ts
#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({
  name: "opencode-tui-control",
  version: "1.0.0",
})

server.registerTool(
  "append_prompt",
  {
    description: "Append text to the opencode TUI prompt",
    inputSchema: {
      text: z.string(),
      submit: z.boolean().optional(),
      sessionID: z.string().optional(),
    },
  },
  async ({ text, submit, sessionID }) => {
    await server.server.notification({
      method: "notifications/opencode/prompt/append",
      params: { text, submit, sessionID },
    })

    return {
      content: [{ type: "text", text: "Prompt appended" }],
    }
  },
)

server.registerTool(
  "synthetic_prompt",
  {
    description: "Send a hidden synthetic prompt to an opencode session",
    inputSchema: {
      text: z.string(),
      sessionID: z.string(),
    },
  },
  async ({ text, sessionID }) => {
    await server.server.notification({
      method: "notifications/opencode/prompt/synthetic",
      params: { text, sessionID },
    })

    return {
      content: [{ type: "text", text: "Synthetic prompt sent" }],
    }
  },
)

server.registerTool(
  "execute_command",
  {
    description: "Execute an opencode TUI command",
    inputSchema: {
      command: z.string(),
    },
  },
  async ({ command }) => {
    await server.server.notification({
      method: "notifications/opencode/command/execute",
      params: { command },
    })

    return {
      content: [{ type: "text", text: `Command sent: ${command}` }],
    }
  },
)

server.registerTool(
  "show_toast",
  {
    description: "Show a toast in opencode",
    inputSchema: {
      message: z.string(),
      title: z.string().optional(),
      variant: z.enum(["info", "success", "warning", "error"]).default("info"),
      duration: z.number().int().positive().optional(),
    },
  },
  async ({ message, title, variant, duration }) => {
    await server.server.notification({
      method: "notifications/opencode/toast/show",
      params: { message, title, variant, duration },
    })

    return {
      content: [{ type: "text", text: "Toast shown" }],
    }
  },
)

server.registerTool(
  "select_session",
  {
    description: "Select an opencode session in the TUI",
    inputSchema: {
      sessionID: z.string(),
    },
  },
  async ({ sessionID }) => {
    await server.server.notification({
      method: "notifications/opencode/session/select",
      params: { sessionID },
    })

    return {
      content: [{ type: "text", text: `Selected session: ${sessionID}` }],
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
```

## Testing checklist

1. Start `och` with the MCP server configured.
2. Confirm the MCP server appears in opencode MCP status.
3. Call `show_toast`; expect a visible TUI toast.
4. Call `append_prompt` with `submit: false`; expect text inserted in the visible prompt.
5. Call `append_prompt` with `submit: true`; expect text inserted and submitted.
6. Call `synthetic_prompt` with a valid `sessionID`; expect a hidden synthetic prompt to be queued for that session.
7. Call `execute_command` with `prompt.clear`; expect the prompt to clear.
8. Call `select_session` with a valid `sessionID`; expect the TUI to navigate to that session.

## Notes

- Notifications are validated by opencode before being published to the TUI bus.
- Invalid notification params are ignored by the current implementation path.
- The custom contract is not part of upstream opencode and requires the custom `och` build.
