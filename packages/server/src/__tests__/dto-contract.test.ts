import { describe, expect, it } from "vitest";
import type { AgentRun, Character, Message, Project, Shot } from "@miraframe/shared";
import { schema } from "../db";
import {
  toAgentRunDto,
  toCharacterDto,
  toMessageDto,
  toProjectDto,
  toShotDto,
} from "../contracts/dto";

const now = new Date("2026-11-28T00:00:00.000Z");

const projectRow = {
  id: 1,
  title: "纸鸢引",
  story: "古代临安城，一位少女继承了祖上的纸鸢铺。",
  style: "guofeng-manga",
  summary: null,
  storyOutline: { logline: "纸鸢引魂", genre: [], themes: [], acts: [] },
  visualBible: "冷蓝到晨曦金",
  outlineApproved: true,
  videoUrl: "/static/exports/project-1/final.mp4",
  status: "completed",
  textProviderOverride: null,
  imageProviderOverride: null,
  videoProviderOverride: null,
  targetShotCount: 6,
  characterHints: ["沈鸢"],
  creationMode: "story",
  referenceImages: [],
  exports: [],
  universeId: null,
  chapterNumber: null,
  chapterTitle: null,
  createdAt: now,
  updatedAt: now,
} satisfies typeof schema.projects.$inferSelect;

const characterRow = {
  id: 2,
  projectId: 1,
  name: "沈鸢",
  description: "继承纸鸢铺的少女。",
  imageUrl: "/static/characters/2.png",
  referenceImages: ["/static/characters/2.png"],
  faceEmbedding: "[0.1,0.2]",
  visualNotes: "青绿色外袍",
  approvedName: "沈鸢",
  approvedDescription: "继承纸鸢铺的少女。",
  approvedImageUrl: "/static/characters/2.png",
  approvedAt: now,
  approvalVersion: 1,
  createdAt: now,
  updatedAt: now,
} satisfies typeof schema.characters.$inferSelect;

const shotRow = {
  id: 3,
  projectId: 1,
  order: 1,
  description: "雨夜街角，少女撑伞。",
  prompt: "gentle camera push in",
  imagePrompt: "rainy street, girl with umbrella",
  imageUrl: "/static/shots/3.png",
  videoUrl: "/static/shots/3.mp4",
  duration: 5,
  camera: "Wide shot",
  motionNote: "slow push in",
  scene: "雨夜街道",
  action: "少女抬头",
  expression: "惊讶",
  lighting: "冷蓝",
  dialogue: "这里以前，好像很亮。",
  sfx: "rain",
  ttsUrl: "/static/tts/3.mp3",
  bgmType: "ambient",
  consistencyResult: null,
  seed: 42,
  characterIds: [2],
  approvedDescription: null,
  approvedPrompt: null,
  approvedImagePrompt: null,
  approvedDuration: null,
  approvedCamera: null,
  approvedMotionNote: null,
  approvedScene: null,
  approvedAction: null,
  approvedExpression: null,
  approvedLighting: null,
  approvedDialogue: null,
  approvedSfx: null,
  approvedCharacterIds: [],
  approvedAt: null,
  approvalVersion: 0,
  createdAt: now,
  updatedAt: now,
} satisfies typeof schema.shots.$inferSelect;

const runRow = {
  id: 9,
  projectId: 1,
  status: "running",
  currentAgent: "plan_outline",
  awaitingGate: "outline_approval",
  progress: 0.2,
  routeDecision: null,
  patchPlan: null,
  error: null,
  resourceType: null,
  resourceId: null,
  threadId: "thread-1-9",
  providerSnapshot: null,
  createdAt: now,
  updatedAt: now,
} satisfies typeof schema.agentRuns.$inferSelect;

const messageRow = {
  id: 10,
  projectId: 1,
  runId: 9,
  agent: "system",
  role: "assistant",
  content: "开始生成故事大纲...",
  summary: "大纲生成完成",
  progress: 0.2,
  isLoading: true,
  createdAt: now,
} satisfies typeof schema.messages.$inferSelect;

describe("REST DTO 与 shared 契约", () => {
  it("Project 行序列化成 snake_case + ISO 时间", () => {
    const dto: Project = toProjectDto(projectRow);
    expect(dto).toMatchObject({
      id: 1,
      story_outline: { logline: "纸鸢引魂" },
      visual_bible: "冷蓝到晨曦金",
      outline_approved: true,
      created_at: now.toISOString(),
    });
    expect(dto).not.toHaveProperty("storyOutline");
    expect(dto).not.toHaveProperty("createdAt");
  });

  it("Character 行序列化成 shared Character", () => {
    const dto: Character = toCharacterDto(characterRow);
    expect(dto).toMatchObject({
      project_id: 1,
      image_url: "/static/characters/2.png",
      has_embedding: true,
      approval_state: "approved",
      approved_at: now.toISOString(),
    });
    expect(dto).not.toHaveProperty("projectId");
  });

  it("Shot 行序列化成 shared Shot，一致性快照原样保留", () => {
    const dto: Shot = toShotDto(shotRow);
    expect(dto).toMatchObject({
      project_id: 1,
      image_url: "/static/shots/3.png",
      image_prompt: "rainy street, girl with umbrella",
      character_ids: [2],
      consistency_result: null,
    });
    expect(dto).not.toHaveProperty("imageUrl");
  });

  it("AgentRun / Message 序列化成 shared 契约", () => {
    const run: AgentRun = toAgentRunDto(runRow);
    const message: Message = toMessageDto(messageRow);
    expect(run.awaiting_gate).toBe("outline_approval");
    expect(run.created_at).toBe(now.toISOString());
    expect(message.is_loading).toBe(true);
    expect(message.project_id).toBe(1);
  });
});
