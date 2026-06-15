import { execFileSync } from 'child_process';
import { getIdleAgentsWithUnreadSignature, getTmuxPane } from './db.js';

interface NudgerDeps {
  getIdleAgentsWithUnreadSignature: typeof getIdleAgentsWithUnreadSignature;
  getTmuxPane: typeof getTmuxPane;
  execFileSync: typeof execFileSync;
}

export class Nudger {
  private nudgedMsgId = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private deps: NudgerDeps;

  constructor(deps?: Partial<NudgerDeps>) {
    this.deps = {
      getIdleAgentsWithUnreadSignature,
      getTmuxPane,
      execFileSync,
      ...deps,
    };
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => this._poll(), intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Nudge a specific agent immediately (e.g. on P0 message send). Returns true on success. */
  pingAgent(agentId: string): boolean {
    const pane = this.deps.getTmuxPane(agentId);
    if (!pane) return false;
    try {
      this.deps.execFileSync('tmux', ['send-keys', '-t', pane,
        '[synapse] you have unread messages, call read_messages', 'Enter']);
      return true;
    } catch { return false; }
  }

  private _poll(): void {
    const rows = this.deps.getIdleAgentsWithUnreadSignature();
    for (const row of rows) {
      const lastNudged = this.nudgedMsgId.get(row.agent_id) ?? 0;
      if (row.max_msg_id > lastNudged) {
        if (this.pingAgent(row.agent_id)) {
          this.nudgedMsgId.set(row.agent_id, row.max_msg_id);
        }
      }
    }
    const stillUnread = new Set(rows.map((r) => r.agent_id));
    for (const id of this.nudgedMsgId.keys()) {
      if (!stillUnread.has(id)) this.nudgedMsgId.delete(id);
    }
  }
}
