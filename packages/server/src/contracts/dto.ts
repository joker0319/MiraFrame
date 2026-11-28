/**
 * 数据库行 → 对外 JSON（shared 契约）。
 *
 * 为什么需要这层：
 * - 数据库列是 camelCase + Date 对象，接口契约是 snake_case + ISO 字符串；
 * - 以前 REST 直接返回 Drizzle 行、WS 返回手写对象，前端只能靠 normalizer 兼容两套；
 * - 现在所有对外资源都从 DTO 出去，serializer 的返回类型就是 shared 的接口，
 *   字段改名/漏映射会直接让 tsc 失败。
 */
import type {
  AgentRun,
  Character,
  CharacterBible,
  Message,
  Project,
  Shot,
  StoryOutline,
} from "@miraframe/shared";
import {
  AgentRunSchema,
  CharacterBibleSchema,
  CharacterSchema,
  MessageSchema,
  ProjectSchema,
  ShotSchema,
} from "@miraframe/shared";
import { schema } from "../db";
import { assertContract } from "./assert";

type ProjectRow = typeof schema.projects.$inferSelect;
type CharacterRow = typeof schema.characters.$inferSelect;
type ShotRow = typeof schema.shots.$inferSelect;
type AgentRunRow = typeof schema.agentRuns.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}


export function toProjectDto(row: ProjectRow): Project {
  const dto: Project = {
    id: row.id,
    title: row.title,
    story: row.story ?? undefined,
    style: row.style,
    summary: row.summary ?? undefined,
    story_outline: (row.storyOutline as StoryOutline | null) ?? null,
    visual_bible: row.visualBible ?? null,
    outline_approved: row.outlineApproved,
    video_url: row.videoUrl ?? null,
    status: row.status,
    target_shot_count: row.targetShotCount ?? undefined,
    character_hints: row.characterHints ?? null,
    creation_mode: row.creationMode ?? null,
    reference_images: row.referenceImages ?? null,
    exports: row.exports ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    universe_id: row.universeId ?? null,
    chapter_number: row.chapterNumber ?? null,
    chapter_title: row.chapterTitle ?? null,
  };
  return assertContract(ProjectSchema, dto, "Project");
}

export function toCharacterDto(row: CharacterRow): Character {
  const dto: Character = {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    description: row.description ?? undefined,
    image_url: row.imageUrl ?? null,
    reference_images: row.referenceImages ?? null,
    has_embedding: Boolean(row.faceEmbedding),
    visual_notes: row.visualNotes ?? null,
    approval_state: row.approvedAt ? "approved" : "draft",
    approval_version: row.approvalVersion ?? 0,
    approved_at: iso(row.approvedAt),
    approved_name: row.approvedName ?? null,
    approved_description: row.approvedDescription ?? null,
    approved_image_url: row.approvedImageUrl ?? null,
  };
  return assertContract(CharacterSchema, dto, "Character");
}

export function toShotDto(row: ShotRow): Shot {
  const dto: Shot = {
    id: row.id,
    project_id: row.projectId,
    order: row.order,
    description: row.description,
    prompt: row.prompt ?? undefined,
    image_prompt: row.imagePrompt ?? undefined,
    image_url: row.imageUrl ?? null,
    video_url: row.videoUrl ?? null,
    duration: row.duration ?? undefined,
    camera: row.camera ?? undefined,
    motion_note: row.motionNote ?? undefined,
    scene: row.scene ?? undefined,
    action: row.action ?? undefined,
    expression: row.expression ?? undefined,
    lighting: row.lighting ?? undefined,
    dialogue: row.dialogue ?? null,
    sfx: row.sfx ?? undefined,
    tts_url: row.ttsUrl ?? null,
    bgm_type: row.bgmType ?? undefined,
    consistency_result: row.consistencyResult ?? null,
    seed: row.seed ?? undefined,
    character_ids: row.characterIds ?? [],
    approval_state: row.approvedAt ? "approved" : "draft",
    approval_version: row.approvalVersion ?? 0,
    approved_at: iso(row.approvedAt),
    approved_description: row.approvedDescription ?? null,
    approved_prompt: row.approvedPrompt ?? null,
    approved_image_prompt: row.approvedImagePrompt ?? null,
    approved_duration: row.approvedDuration ?? null,
    approved_camera: row.approvedCamera ?? null,
    approved_motion_note: row.approvedMotionNote ?? null,
    approved_scene: row.approvedScene ?? null,
    approved_action: row.approvedAction ?? null,
    approved_expression: row.approvedExpression ?? null,
    approved_lighting: row.approvedLighting ?? null,
    approved_dialogue: row.approvedDialogue ?? null,
    approved_sfx: row.approvedSfx ?? null,
    approved_character_ids: row.approvedCharacterIds ?? [],
  };
  return assertContract(ShotSchema, dto, "Shot");
}

export function toAgentRunDto(row: AgentRunRow): AgentRun {
  const dto: AgentRun = {
    id: row.id,
    project_id: row.projectId,
    status: row.status,
    current_agent: row.currentAgent ?? undefined,
    awaiting_gate: row.awaitingGate ?? null,
    progress: row.progress,
    error: row.error ?? null,
    thread_id: row.threadId ?? undefined,
    resource_type: row.resourceType ?? undefined,
    resource_id: row.resourceId ?? undefined,
    provider_snapshot: (row.providerSnapshot as AgentRun["provider_snapshot"]) ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
  return assertContract(AgentRunSchema, dto, "AgentRun");
}

export function toMessageDto(row: MessageRow): Message {
  const dto: Message = {
    id: row.id,
    project_id: row.projectId,
    run_id: row.runId ?? null,
    agent: row.agent,
    role: row.role,
    content: row.content,
    summary: row.summary ?? null,
    progress: row.progress ?? null,
    is_loading: row.isLoading,
    created_at: row.createdAt.toISOString(),
  };
  return assertContract(MessageSchema, dto, "Message");
}

/** 角色 bible 接口只暴露三件事，但 has_embedding 需要 faceEmbedding 是否为空。 */
export function toCharacterBibleDto(row: CharacterRow): CharacterBible {
  const dto: CharacterBible = {
    id: row.id,
    visual_notes: row.visualNotes ?? null,
    reference_images: row.referenceImages ?? null,
    has_embedding: Boolean(row.faceEmbedding),
  };
  return assertContract(CharacterBibleSchema, dto, "CharacterBible");
}
