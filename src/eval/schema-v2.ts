export interface TrajectoryV2 {
  schema_version: 2;
  task_id: number;
  title: string;
  trigger_msg_id: number | null;
  source_msg_id: number | null;
  result_msg_id: number | null;
  commit_sha: string | null;
  started_at: number;            // epoch ms
  finished_at: number | null;
  total_duration_ms: number | null;
  agents: Record<string, AgentTrajectory>;   // key: "<role>:<slot>"
  blocked_events: BlockedEvent[];            // task-level (any agent)
  label: 'good' | 'bad';
  raw: {                                     // v1 backwards-compat for critic/gate
    messages: Record<string, unknown>[];
    tool_metrics: Record<string, unknown>[];
  };
}

export interface AgentTrajectory {
  agent_id: string;          // e.g. "cec50b17:37"
  role: string;              // 'developer' | 'code-reviewer' | 'doc-writer' | 'test-runner' | 'orchestrator'
  tools: Record<string, ToolStats>;
  blocked_events: BlockedEvent[];
  messages_in: number;
  messages_out: number;
  active_duration_ms: number;  // sum of tool durations attributable to this agent
}

export interface ToolStats {
  calls: number;
  avg_ms: number;
  p90_ms: number;
  errors: number;
  error_rate: number;        // errors / calls
}

export interface BlockedEvent {
  agent_id: string;
  text: string;              // first 200 chars
  at: number;                // epoch ms
  category: 'CONFUSED' | 'WAITING' | 'ERROR' | 'OTHER';
}

export interface ThresholdsFile {
  calibrated_at: string;
  sample_size: Record<string, number>;
  by_role: Record<string, RoleThresholds>;
  task_level: { traceability_score_max: number };
}

export interface RoleThresholds {
  tool_calls_p90: number;
  duration_ms_p90: number;
  error_rate_max: number;
  has_commit?: boolean;
}
