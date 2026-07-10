/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from '@opencode-ai/plugin/tui';
import { getComponentCatalogue } from '@opentui/solid';
import { registerSpinner } from 'opentui-spinner/solid';
import { createMemo, createSignal, For, Show, onCleanup } from 'solid-js';
import { readMonitorStatus, readMonitorTail, type MonitorIndicatorJob, type MonitorIndicatorSnapshot, type MonitorTailLine } from './status-store.js';
import { monitorDebug } from './debug-log.js';

if (!getComponentCatalogue().spinner) registerSpinner();

declare global {
  namespace JSX {
    type Element = any;
    interface IntrinsicElements { [elemName: string]: any }
    interface ElementChildrenAttribute { children: {} }
  }
}

const id = 'opencode-monitor-indicator';
const kindOrder = ['bg', 'mon', 'loop', 'sched'] as const;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

type Theme = TuiPluginApi['theme']['current'];
type Color = Theme['text'];

function scope(api: TuiPluginApi): string {
  return api.state.path.worktree || api.state.path.directory || process.cwd();
}

function animationsEnabled(api: TuiPluginApi): boolean {
  return api.kv.get('animations_enabled', true);
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${String(rm).padStart(2, '0')}m`;
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

function deliveryBadge(deliveryStatus: string, theme: Theme): { text: string; color: Color } {
  if (deliveryStatus === 'pending') return { text: 'pend', color: theme.accent };
  if (deliveryStatus === 'sent') return { text: 'sent', color: theme.success };
  if (deliveryStatus === 'bridge_failed') return { text: 'fail', color: theme.error };
  return { text: '?', color: theme.textMuted };
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

function maxElapsed(jobs: MonitorIndicatorJob[]): number {
  const now = Date.now();
  const active = jobs.filter((j) => j.status === 'active' && j.createdAt > 0);
  if (active.length === 0) return 0;
  const oldest = Math.min(...active.map((j) => j.createdAt));
  return now - oldest;
}

function useMonitorData(api: TuiPluginApi, sessionID?: string) {
  const [jobs, setJobs] = createSignal<MonitorIndicatorJob[]>([]);
  const [snapshot, setSnapshot] = createSignal<MonitorIndicatorSnapshot | null>(null);
  let lastLog = '';
  const refresh = () => {
    const snap = readMonitorStatus(scope(api));
    const sessionJobs = sessionID ? snap.jobs.filter((job) => job.sessionID === sessionID) : [];
    const visibleJobs = sessionJobs.length > 0 ? sessionJobs : snap.jobs;
    setJobs(visibleJobs);
    setSnapshot(snap);
    const nextLog = JSON.stringify({ scope: scope(api), sessionID, snapshotJobs: snap.jobs.length, visibleJobs: visibleJobs.length });
    if (nextLog !== lastLog) {
      lastLog = nextLog;
      monitorDebug('tui.status.refresh', JSON.parse(nextLog));
    }
  };
  refresh();
  const timer = setInterval(refresh, 1000);
  onCleanup(() => clearInterval(timer));
  return { jobs, snapshot };
}

function SpinnerOrDot(props: { api: TuiPluginApi; color: Color; children?: any }) {
  return (
    <Show
      when={animationsEnabled(props.api)}
      fallback={<text fg={props.color} flexShrink={0}>●</text>}
    >
      <spinner frames={SPINNER_FRAMES} interval={80} color={props.color} />
      <Show when={props.children}>{props.children}</Show>
    </Show>
  );
}

function Compact(props: { api: TuiPluginApi; session_id?: string }) {
  const theme = () => props.api.theme.current;
  const { jobs, snapshot } = useMonitorData(props.api, props.session_id);
  const snap = () => snapshot();
  const elapsed = createMemo(() => maxElapsed(jobs()));
  const badgeCounts = createMemo(() => counts(jobs()));
  const anyActive = createMemo(() => jobs().length > 0);

  return (
    <Show
      when={anyActive()}
      fallback={<text fg={theme().textMuted}>○ jobs idle</text>}
    >
      <box flexDirection="row" gap={1}>
        <SpinnerOrDot api={props.api} color={theme().warning} />
        <text>
          <For each={badgeCounts()}>
            {(item, i) => (
              <>
                <Show when={i() > 0}>
                  <span style={{ fg: theme().textMuted }}> · </span>
                </Show>
                <span style={{ fg: kindColor(theme(), item.kind) }}>{item.kind}×{item.count}</span>
              </>
            )}
          </For>
        </text>
        <Show when={elapsed() > 0}>
          <text fg={theme().textMuted}>⏱{formatElapsed(elapsed())}</text>
        </Show>
        <Show when={(snap()?.queueDepth ?? 0) > 0}>
          <text fg={theme().info}>⏐{snap()!.queueDepth}</text>
        </Show>
        <Show when={snap()?.bridgeUp === false}>
          <text fg={theme().error}>⚡bridge↓</text>
        </Show>
      </box>
    </Show>
  );
}

function TailPreview(props: { api: TuiPluginApi; jobID: string }) {
  const theme = () => props.api.theme.current;
  const [lines, setLines] = createSignal<MonitorTailLine[]>([]);
  const refresh = () => {
    const tail = readMonitorTail(scope(props.api), props.jobID);
    setLines(tail ? tail.lines.slice(-3) : []);
  };
  refresh();
  const timer = setInterval(refresh, 1000);
  onCleanup(() => clearInterval(timer));

  return (
    <Show when={lines().length > 0}>
      <box flexDirection="column" paddingLeft={2}>
        <For each={lines()}>
          {(line) => (
            <text wrapMode="none">
              <span style={{ fg: theme().textMuted }}>[{line.stream}] </span>
              <span style={{ fg: line.stream === 'stderr' ? theme().error : theme().text }}>{line.line}</span>
            </text>
          )}
        </For>
      </box>
    </Show>
  );
}

function Detail(props: { api: TuiPluginApi; session_id?: string }) {
  const theme = () => props.api.theme.current;
  const { jobs, snapshot } = useMonitorData(props.api, props.session_id);
  const snap = () => snapshot();
  const anyJobs = createMemo(() => jobs().length > 0);
  const elapsed = createMemo(() => maxElapsed(jobs()));
  const activeCount = createMemo(() => jobs().filter((j) => j.status === 'active').length);
  const firstActiveJob = createMemo(() => jobs().find((j) => j.status === 'active'));

  return (
    <Show
      when={anyJobs()}
      fallback={<text fg={theme().textMuted}>○ jobs idle</text>}
    >
      <box>
        <box flexDirection="row" gap={1}>
          <SpinnerOrDot api={props.api} color={theme().warning} />
          <text fg={theme().text}>
            <b>OpenCode jobs</b>{' '}
            <span style={{ fg: theme().textMuted }}>
              ({activeCount() > 0 ? <span style={{ fg: theme().warning }}>{activeCount()} active</span> : null}
              {(snap()?.queueDepth ?? 0) > 0 ? ` · ` : null}
              {(snap()?.queueDepth ?? 0) > 0 ? <span style={{ fg: theme().info }}>{snap()!.queueDepth} queued</span> : null}
              {(snap()?.completedCount ?? 0) > 0 ? ` · ` : null}
              {(snap()?.completedCount ?? 0) > 0 ? <span style={{ fg: theme().success }}>{snap()!.completedCount} done</span> : null}
              {(snap()?.failedCount ?? 0) > 0 ? ` · ` : null}
              {(snap()?.failedCount ?? 0) > 0 ? <span style={{ fg: theme().error }}>{snap()!.failedCount} failed</span> : null})
            </span>
          </text>
        </box>
        <For each={jobs()}>
          {(job, index) => {
            const badge = deliveryBadge(job.deliveryStatus, theme());
            const isExpanded = createMemo(() => firstActiveJob()?.jobID === job.jobID);
            return (
              <box>
                <box flexDirection="row" gap={1}>
                  <Show
                    when={job.status === 'active'}
                    fallback={<text fg={kindColor(theme(), job.kind)} flexShrink={0}>●</text>}
                  >
                    <SpinnerOrDot api={props.api} color={kindColor(theme(), job.kind)} />
                  </Show>
                  <text fg={theme().text} wrapMode="none">
                    <b>{job.jobID}</b>{' '}
                    <span style={{ fg: kindColor(theme(), job.kind) }}>{title(job.kind)}</span>{' '}
                    <span style={{ fg: statusColor(theme(), job.status) }}>{statusLabel(job.status)}</span>{' '}
                    <span style={{ fg: theme().textMuted }}>{formatElapsed(Date.now() - (job.createdAt || Date.now()))}</span>{' '}
                    <span style={{ fg: badge.color }}>{badge.text}</span>
                  </text>
                </box>
                <Show when={isExpanded() && job.hasTail}>
                  <TailPreview api={props.api} jobID={job.jobID} />
                </Show>
              </box>
            );
          }}
        </For>
        <text fg={theme().textMuted}>first active shows live output · /cancel to stop</text>
      </box>
    </Show>
  );
}

export const tui: TuiPlugin = async (api, _options, _meta) => {
  monitorDebug('tui.init', { scope: scope(api) });
  api.slots.register({
    order: 10_000,
    slots: {
      sidebar_title(_ctx, props) {
        return (
          <box paddingRight={1}>
            <text fg={api.theme.current.text}>
              <b>OpenCode jobs</b>
            </text>
            <text fg={api.theme.current.textMuted}>background · monitor · loop · schedule</text>
          </box>
        );
      },
      sidebar_content(_ctx, props) {
        return <Detail api={api} session_id={props.session_id} />;
      },
      sidebar_footer(_ctx, props) {
        return <Compact api={api} session_id={props.session_id} />;
      },
    },
  });
};

export default { id, tui };