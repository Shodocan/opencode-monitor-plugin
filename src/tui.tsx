/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from '@opencode-ai/plugin/tui';
import { createElement } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, Show, onCleanup } from 'solid-js';
import { readMonitorStatus, type MonitorIndicatorJob } from './status-store.js';
import { monitorDebug } from './debug-log.js';

declare global {
  namespace JSX {
    type Element = any;
    interface IntrinsicElements { [elemName: string]: any }
    interface ElementChildrenAttribute { children: {} }
  }
}

const id = 'opencode-monitor-indicator';
const kindOrder = ['bg', 'mon', 'loop', 'sched'] as const;

type Theme = TuiPluginApi['theme']['current'];
type Color = Theme['text'];

function scope(api: TuiPluginApi): string {
  return api.state.path.worktree || api.state.path.directory || process.cwd();
}

function useJobs(api: TuiPluginApi, sessionID?: string) {
  const [jobs, setJobs] = createSignal<MonitorIndicatorJob[]>([]);
  let lastLog = '';
  const refresh = () => {
    const snapshot = readMonitorStatus(scope(api));
    const sessionJobs = sessionID ? snapshot.jobs.filter((job) => job.sessionID === sessionID) : [];
    // Tool calls can originate from a plugin/server session context that does
    // not exactly match the currently focused TUI route after restart/attach.
    // Fall back to project-local active jobs so the user still sees that work
    // is running instead of getting a silent empty indicator.
    const visibleJobs = sessionJobs.length > 0 ? sessionJobs : snapshot.jobs;
    setJobs(visibleJobs);
    const nextLog = JSON.stringify({ scope: scope(api), sessionID, snapshotJobs: snapshot.jobs.length, visibleJobs: visibleJobs.length });
    if (nextLog !== lastLog) {
      lastLog = nextLog;
      monitorDebug('tui.status.refresh', JSON.parse(nextLog));
    }
  };
  refresh();
  const timer = setInterval(refresh, 1000);
  onCleanup(() => clearInterval(timer));
  return jobs;
}

function label(kind: string): string {
  if (kind === 'bg') return 'bg';
  if (kind === 'mon') return 'mon';
  if (kind === 'loop') return 'loop';
  if (kind === 'sched') return 'sched';
  return kind;
}

function title(kind: string): string {
  if (kind === 'bg') return 'background';
  if (kind === 'mon') return 'monitor';
  if (kind === 'loop') return 'loop';
  if (kind === 'sched') return 'schedule';
  return kind;
}

function statusLabel(status: string): string {
  if (status === 'active') return 'running';
  return status;
}

function kindColor(theme: Theme, kind: string): Color {
  if (kind === 'mon') return theme.warning;
  if (kind === 'loop') return theme.success;
  if (kind === 'sched') return theme.accent;
  return theme.textMuted;
}

function statusColor(theme: Theme, status: string): Color {
  if (status === 'failed') return theme.error;
  if (status === 'cancelled') return theme.textMuted;
  if (status === 'complete' || status === 'completed') return theme.success;
  return theme.warning;
}

function counts(jobs: MonitorIndicatorJob[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(label(job.kind), (counts.get(label(job.kind)) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => {
      const leftIndex = kindOrder.indexOf(left as (typeof kindOrder)[number]);
      const rightIndex = kindOrder.indexOf(right as (typeof kindOrder)[number]);
      return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
    })
    .map(([kind, count]) => ({ kind, count }));
}

function summarize(jobs: MonitorIndicatorJob[]): string {
  return counts(jobs).map(({ kind, count }) => `${kind}×${count}`).join(' · ');
}

function compactJobs(jobs: MonitorIndicatorJob[]): string {
  const visible = jobs.slice(0, 2).map((job) => `${job.jobID}:${job.kind}`);
  const extra = jobs.length > visible.length ? ` +${jobs.length - visible.length}` : '';
  return [...visible, extra].filter(Boolean).join(' ');
}

function commandHint(theme: () => Theme, command: string, description: string) {
  return (
    <box flexDirection="row" gap={1}>
      <text flexShrink={0} fg={theme().info}>›</text>
      <text fg={theme().textMuted} wrapMode="word">
        <span style={{ fg: theme().text }}>{command}</span>{' '}
        {description}
      </text>
    </box>
  );
}

function Compact(props: { api: TuiPluginApi; session_id?: string }) {
  const theme = () => props.api.theme.current;
  const jobs = useJobs(props.api, props.session_id);
  const display = createMemo(() => (jobs().length > 0 ? `jobs ${compactJobs(jobs())}` : 'jobs idle'));
  let lastDisplay = '';
  createEffect(() => {
    const next = display();
    if (next !== lastDisplay) {
      lastDisplay = next;
      monitorDebug('tui.compact.display', { scope: scope(props.api), sessionID: props.session_id, display: next });
    }
  });
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme().warning} wrapMode="none">{display()}</text>
    </box>
  );
}

function Detail(props: { api: TuiPluginApi; session_id?: string }) {
  const theme = () => props.api.theme.current;
  const jobs = useJobs(props.api, props.session_id);
  const summary = createMemo(() => summarize(jobs()));

  return (
    <box>
      <Show
        when={jobs().length > 0}
        fallback={(
          <box>
            <box flexDirection="row" gap={1}>
              <text fg={theme().success}>○</text>
              <text fg={theme().text}>
                <b>OpenCode jobs</b>{' '}
                <span style={{ fg: theme().textMuted }}>(idle)</span>
              </text>
            </box>
            <text fg={theme().textMuted} wrapMode="word">
              Run background work and deliver results when this session is idle.
            </text>
            {commandHint(theme, '/background', 'run a shell command')}
            {commandHint(theme, '/monitor', 'watch command output for a regex')}
            {commandHint(theme, '/loop', 'repeat an instruction on an interval')}
            {commandHint(theme, '/schedule', 'submit one future instruction')}
          </box>
        )}
      >
        <box>
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>●</text>
            <text fg={theme().text}>
              <b>OpenCode jobs</b>{' '}
              <span style={{ fg: theme().textMuted }}>({jobs().length} active · {summary()})</span>
            </text>
          </box>
          <For each={jobs()}>
            {(job) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={kindColor(theme(), job.kind)}>●</text>
                <text fg={theme().text} wrapMode="none">
                  <b>{job.jobID}</b>{' '}
                  <span style={{ fg: kindColor(theme(), job.kind) }}>{title(job.kind)}</span>{' '}
                  <span style={{ fg: statusColor(theme(), job.status) }}>{statusLabel(job.status)}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  );
}

export const tui: TuiPlugin = async (api) => {
  monitorDebug('tui.init', { scope: scope(api) });
  api.slots.register({
    order: 10_000,
    slots: {
      sidebar_title(_ctx, props) {
        monitorDebug('tui.slot.sidebar_title.render', { scope: scope(api), sessionID: props.session_id, title: props.title });
        return (
          <box paddingRight={1}>
            <text fg={api.theme.current.text}>
              <b>OpenCode jobs</b>
            </text>
            <text fg={api.theme.current.textMuted}>background · monitor · loop · schedule</text>
          </box>
        );
      },
      session_prompt_right(_ctx, props) {
        monitorDebug('tui.slot.session_prompt_right.render', { scope: scope(api), sessionID: props.session_id });
        return <Compact api={api} session_id={props.session_id} />;
      },
      home_prompt_right() {
        monitorDebug('tui.slot.home_prompt_right.render', { scope: scope(api) });
        return <Compact api={api} />;
      },
      home_bottom() {
        monitorDebug('tui.slot.home_bottom.render', { scope: scope(api) });
        return <Compact api={api} />;
      },
      app_bottom() {
        monitorDebug('tui.slot.app_bottom.render', { scope: scope(api) });
        return <Compact api={api} />;
      },
      sidebar_content(_ctx, props) {
        monitorDebug('tui.slot.sidebar_content.render', { scope: scope(api), sessionID: props.session_id });
        return <Detail api={api} session_id={props.session_id} />;
      },
      sidebar_footer(_ctx, props) {
        monitorDebug('tui.slot.sidebar_footer.render', { scope: scope(api), sessionID: props.session_id });
        return <Compact api={api} session_id={props.session_id} />;
      },
    },
  });
};

export default { id, tui };
