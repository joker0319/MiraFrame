import type { ProjectStatus, ReviewState } from "./common";
import type { ShotConsistencyResult } from "./consistency";

// ── Provider Settings ──
export interface ProjectProviderEntry {
  selected_key: string;
  source: "project" | "default";
  resolved_key: string;
  valid: boolean;
  status: string;
  reason_code?: string;
  reason_message?: string;
  capabilities?: {
    generate?: boolean;
    stream?: boolean;
  };
}

export interface ProjectProviderSettings {
  text: ProjectProviderEntry;
  image: ProjectProviderEntry;
  video: ProjectProviderEntry;
}

export interface ProjectProviderOverridesPayload {
  text_provider_override?: string | null;
  image_provider_override?: string | null;
  video_provider_override?: string | null;
}

// ── Story Outline ──
export interface StoryOutlineAct {
  act: number;
  title: string;
  summary: string;
}

/**
 * 大綱是模型产物，字段允许缺失；渲染层对每一项都做了缺省处理。
 * 这里保持可选，避免为了“类型好看”在读取处到处补 `?? ""`。
 */
export interface StoryOutline {
  logline?: string;
  genre: string[];
  themes: string[];
  setting?: string;
  tone?: string;
  acts: StoryOutlineAct[];
  emotional_arc?: string;
}

export interface StoryOutlineUpdatePayload {
  logline?: string | null;
  genre?: string[] | null;
  themes?: string[] | null;
  setting?: string | null;
  tone?: string | null;
  acts?: StoryOutlineAct[] | null;
  emotional_arc?: string | null;
  visual_bible?: string | null;
  summary?: string | null;
  outline_approved?: boolean | null;
}

// ── Project ──
export interface Project {
  id: number;
  title: string;
  story?: string;
  style?: string;
  summary?: string;
  story_outline?: StoryOutline | null;
  visual_bible?: string | null;
  outline_approved?: boolean;
  video_url?: string | null;
  status?: ProjectStatus | string | null;
  target_shot_count?: number;
  character_hints?: string[] | null;
  creation_mode?: string | null;
  reference_images?: string[] | null;
  exports?: string[] | null;
  created_at: string;
  updated_at: string;
  provider_settings?: ProjectProviderSettings | null;
  universe_id?: number | null;
  chapter_number?: number | null;
  chapter_title?: string | null;
}

export interface CreateProjectPayload extends ProjectProviderOverridesPayload {
  title: string;
  story?: string;
  style?: string;
  target_shot_count?: number;
  character_hints?: string[];
  creation_mode?: string;
  reference_images?: string[];
  universe_id?: number;
  chapter_number?: number;
  chapter_title?: string;
}

export interface UpdateProjectPayload extends Partial<CreateProjectPayload> {
  summary?: string | null;
  status?: string | null;
  video_url?: string | null;
  outline_approved?: boolean | null;
  exports?: string[] | null;
}

export interface BlockingClip {
  shot_id: number;
  order: number;
  status: string;
  reason: string;
}

// ── Character ──
export interface Character {
  id: number;
  project_id: number;
  name: string;
  description?: string;
  image_url?: string | null;
  reference_images?: string[] | null;
  has_embedding?: boolean;
  visual_notes?: string | null;
  approval_state?: ReviewState;
  approval_version?: number;
  approved_at?: string | null;
  approved_name?: string | null;
  approved_description?: string | null;
  approved_image_url?: string | null;
}

export interface CharacterUpdatePayload {
  name?: string;
  description?: string;
  image_url?: string | null;
  visual_notes?: string | null;
  reference_images?: string[] | null;
}

export interface CharacterBible {
  id: number;
  visual_notes?: string | null;
  reference_images?: string[] | null;
  has_embedding?: boolean;
}

// ── Shot ──
export interface Shot {
  id: number;
  project_id: number;
  order: number;
  description?: string;
  prompt?: string;
  image_prompt?: string;
  image_url?: string | null;
  video_url?: string | null;
  duration?: number;
  camera?: string;
  motion_note?: string;
  scene?: string;
  action?: string;
  expression?: string;
  lighting?: string;
  dialogue?: string | null;
  sfx?: string;
  tts_url?: string | null;
  bgm_type?: string;
  /** 镜头图生成后自动跑的一致性快照；换图或换参考图时会被后端清空 */
  consistency_result?: ShotConsistencyResult | null;
  seed?: number;
  character_ids?: number[];
  approval_state?: ReviewState;
  approval_version?: number;
  approved_at?: string | null;
  approved_description?: string | null;
  approved_prompt?: string | null;
  approved_image_prompt?: string | null;
  approved_duration?: number | null;
  approved_camera?: string | null;
  approved_motion_note?: string | null;
  approved_scene?: string | null;
  approved_action?: string | null;
  approved_expression?: string | null;
  approved_lighting?: string | null;
  approved_dialogue?: string | null;
  approved_sfx?: string | null;
  approved_character_ids?: number[] | null;
}

export interface ShotUpdatePayload {
  order?: number;
  description?: string;
  prompt?: string;
  image_prompt?: string;
  duration?: number;
  camera?: string;
  motion_note?: string;
  scene?: string;
  action?: string;
  expression?: string;
  lighting?: string;
  dialogue?: string | null;
  sfx?: string;
  seed?: number;
  character_ids?: number[];
}

// ── Revision ──
export type RevisionEntityType =
  | "outline"
  | "character"
  | "characters"
  | "shots"
  | "shot"
  | "project_video";
export type RevisionFeedbackType =
  | "rewrite"
  | "regenerate"
  | "regenerate_image"
  | "regenerate_video"
  | "style"
  | "motion"
  | "dialogue"
  | "script";

export interface ProjectRevisionPayload {
  content: string;
  feedback_type?: RevisionFeedbackType;
  entity_type?: RevisionEntityType;
  entity_id?: number;
}
