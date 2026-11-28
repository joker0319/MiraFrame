import type { RunStatus } from "./common";
import type { ProjectProviderSettings } from "./project";

// ── Agent Run ──
export interface AgentRun {
  id: number;
  project_id: number;
  status: RunStatus | string;
  current_agent?: string;
  /** 当前卡住的人工门，刷新页面后靠它恢复确认按钮 */
  awaiting_gate?: string | null;
  progress?: number;
  error?: string | null;
  thread_id?: string;
  resource_type?: string;
  resource_id?: number;
  provider_snapshot?: ProjectProviderSettings | null;
  created_at: string;
  updated_at: string;
}

// ── Message ──
export interface Message {
  id: number;
  project_id: number;
  run_id?: number | null;
  agent: string;
  role: string;
  content: string;
  summary?: string | null;
  progress?: number | null;
  is_loading?: boolean;
  created_at: string;
}

// ── Recovery ──
export interface RecoveryStageRead {
  name: string;
  status: "completed" | "current" | "pending" | "blocked";
  artifact_count: number;
}

export interface RecoverySummaryRead {
  project_id: number;
  run_id: number;
  thread_id: string;
  current_stage: string;
  next_stage: string;
  preserved_stages: string[];
  stage_history: RecoveryStageRead[];
  resumable: boolean;
}

export interface RecoveryControlRead {
  state: "active" | "recoverable";
  detail: string;
  available_actions: string[];
  thread_id?: string;
  active_run?: AgentRun | null;
  recovery_summary?: RecoverySummaryRead | null;
}
