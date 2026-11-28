import { WS_EVENT_TYPES } from "../constants/events";
import type { AgentThinkingPhase, VersionEntityType } from "./common";
import type {
  BlockingClip,
  Character,
  ProjectProviderSettings,
  Shot,
  StoryOutline,
} from "./project";
import type { RecoverySummaryRead } from "./agent";
import type { ShotConsistencyResult } from "./consistency";

/**
 * 事件名以 `WS_EVENT_TYPES` 常量为唯一来源；这里只做类型推导。
 * 新增事件时先加常量，再补 `WsEventDataMap`——两处不一致会被测试卡住。
 */
export type WsEventType = (typeof WS_EVENT_TYPES)[number];

export interface ConnectedEventData {
  project_id: number;
}

export interface ErrorEventData {
  message?: string;
  error?: string;
}

export interface RunStartedEventData {
  run_id: number;
  project_id?: number;
  provider_snapshot?: ProjectProviderSettings;
  current_stage?: string;
  stage?: string;
  next_stage?: string;
  progress?: number;
  current_agent?: string;
  recovery_summary?: RecoverySummaryRead;
  preserved_stages?: string[];
}

export interface RunProgressEventData {
  run_id: number;
  project_id?: number;
  current_agent?: string;
  current_stage?: string;
  stage?: string;
  next_stage?: string;
  progress?: number;
  recovery_summary?: RecoverySummaryRead;
}

export interface RunMessageEventData {
  agent?: string | null;
  role?: string | null;
  content: string;
  summary?: string | null;
  progress?: number | null;
  is_loading?: boolean | null;
}

export interface AgentThinkingEventData {
  agent: string;
  phase: AgentThinkingPhase;
  content: string;
  details?: string;
}

export interface RunCompletedEventData {
  run_id?: number;
  project_id?: number;
  current_stage?: string;
  current_agent?: string;
  message?: string;
  video_generation_pending?: boolean;
}

export interface RunFailedEventData {
  run_id?: number;
  project_id?: number;
  error?: string;
  agent?: string;
  current_stage?: string;
}

export interface RunAwaitingConfirmEventData {
  run_id: number;
  project_id?: number;
  agent: string;
  gate?: string;
  current_stage?: string;
  stage?: string;
  next_stage?: string;
  recovery_summary?: RecoverySummaryRead;
  preserved_stages?: string[];
  message?: string;
  completed?: boolean;
  next_step?: string;
  question?: string;
  auto_mode?: boolean;
  story_outline?: StoryOutline;
  visual_bible?: string | null;
}

export interface RunConfirmedEventData {
  run_id: number;
  project_id?: number;
  agent?: string;
  gate?: string;
  current_stage?: string;
  stage?: string;
  next_stage?: string;
  recovery_summary?: RecoverySummaryRead;
  auto_mode?: boolean;
}

export interface RunCancelledEventData {
  run_id?: number;
  project_id?: number;
  run_ids?: number[];
  cancelled_count?: number;
}

export interface CharacterCreatedEventData {
  character: Character;
}

export interface CharacterUpdatedEventData {
  character: Character;
}

export interface CharacterDeletedEventData {
  character_id: number;
}

export interface ShotCreatedEventData {
  shot: Shot;
}

export interface ShotUpdatedEventData {
  shot: Shot;
}

export interface ShotDeletedEventData {
  shot_id: number;
}

export interface OutlineUpdatedEventData {
  project_id: number;
  story_outline?: StoryOutline | null;
  visual_bible?: string | null;
  outline_approved?: boolean;
}

export interface ProjectUpdatedEventData {
  title?: string;
  story?: string;
  style?: string;
  summary?: string;
  story_outline?: StoryOutline | null;
  visual_bible?: string | null;
  outline_approved?: boolean;
  video_url?: string | null;
  status?: string | null;
  target_shot_count?: number;
  character_hints?: string[] | null;
  creation_mode?: string | null;
  reference_images?: string[] | null;
  exports?: string[] | null;
  provider_settings?: ProjectProviderSettings | null;
  universe_id?: number | null;
  chapter_number?: number | null;
  chapter_title?: string | null;
  blocking_clips?: BlockingClip[] | null;
}

export interface DataClearedEventData {
  cleared_types?: string[];
}

export interface CritiqueResultEventData {
  stage: string;
  entity_type: string;
  entity_id?: number | null;
  score: number;
  threshold: number;
  passed: boolean;
  round: number;
  max_rounds: number;
  dimensions: Record<string, number>;
  issues: string[];
  suggestions: string[];
  will_regenerate: boolean;
}

export interface BibleUpdatedEventData {
  character_id: number;
  visual_notes?: string;
  reference_images_count?: number;
  has_embedding?: boolean;
}

export interface VersionCreatedEventData {
  entity_type: VersionEntityType;
  entity_id: number;
  version: number;
  trigger: string;
}

export interface VersionRollbackEventData {
  entity_type: VersionEntityType;
  entity_id: number;
  from_version: number;
  to_version: number;
}

export interface AudioGeneratedEventData {
  shot_id: number;
  tts_url?: string;
  bgm_type?: string;
  duration?: number;
}

export interface ExportCompletedEventData {
  export_id: string;
  format: string;
  download_url?: string;
  status: string;
  error?: string;
}

export interface ConsistencyEvalCompletedEventData {
  project_id: number;
  source?: "auto" | "manual";
  checked_at?: string;
  summary?: { ok: number; review: number; drift: number; unverifiable: number };
  shots?: Array<{ shot_id: number; consistency_result: ShotConsistencyResult }>;
}

export interface ConsistencyRepairCompletedEventData {
  project_id: number;
  source?: "auto" | "manual";
  repaired: Array<{
    shot_id: number;
    order: number | null;
    references: number;
    verdict?: string | null;
    resolved: boolean;
  }>;
  skipped: Array<{ shot_id: number; reason: string }>;
  failed: Array<{ shot_id: number; error: string }>;
}

/**
 * 每个事件的数据形状。用 `Record<WsEventType, ...>` 的形式约束，
 * 漏一个事件会在测试里的类型断言处直接报错。
 */
export interface WsEventDataMap {
  connected: ConnectedEventData;
  pong: Record<string, unknown>;
  echo: Record<string, unknown>;
  error: ErrorEventData;
  run_started: RunStartedEventData;
  run_progress: RunProgressEventData;
  run_message: RunMessageEventData;
  agent_thinking: AgentThinkingEventData;
  run_completed: RunCompletedEventData;
  run_failed: RunFailedEventData;
  run_awaiting_confirm: RunAwaitingConfirmEventData;
  run_confirmed: RunConfirmedEventData;
  run_cancelled: RunCancelledEventData;
  character_created: CharacterCreatedEventData;
  character_updated: CharacterUpdatedEventData;
  character_deleted: CharacterDeletedEventData;
  shot_created: ShotCreatedEventData;
  shot_updated: ShotUpdatedEventData;
  shot_deleted: ShotDeletedEventData;
  outline_updated: OutlineUpdatedEventData;
  project_updated: ProjectUpdatedEventData;
  data_cleared: DataClearedEventData;
  critique_result: CritiqueResultEventData;
  bible_updated: BibleUpdatedEventData;
  version_created: VersionCreatedEventData;
  version_rollback: VersionRollbackEventData;
  audio_generated: AudioGeneratedEventData;
  export_completed: ExportCompletedEventData;
  consistency_eval_completed: ConsistencyEvalCompletedEventData;
  consistency_repair_completed: ConsistencyRepairCompletedEventData;
}

/** 强类型的 WS 信封，前端/服务端都可以用它构造事件。 */
export type WsEvent = {
  [K in WsEventType]: { type: K; data: WsEventDataMap[K] };
}[WsEventType];

/** 编译期检查：`WS_EVENT_TYPES` 里的每个事件都必须在 map 里有形状。 */
export type MissingWsEventData = Exclude<WsEventType, keyof WsEventDataMap>;
