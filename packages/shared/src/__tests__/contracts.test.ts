import { describe, expect, it } from "vitest";
import {
  WS_EVENT_TYPES,
  type AgentRun,
  type Character,
  type Message,
  type MissingWsEventData,
  type Project,
  type Shot,
  type WsEvent,
} from "../index";

/**
 * 契约测试不跑运行时 schema，而是用 `satisfies`/类型断言把
 * 「字段名、ID 类型、时间格式」固定在编译期：
 * - 有人把 integer id 改成 string、把 snake_case 改回 camelCase，tsc 会先炸；
 * - 新增 WS 事件但忘记补 WsEventDataMap，MissingWsEventData 就不再是 never。
 */

const project = {
  id: 1,
  title: "纸鸢引",
  story: "古代临安城，一位少女继承了祖上的纸鸢铺。",
  style: "guofeng-manga",
  story_outline: {
    logline: "一只纸鸢牵出亡者未说出口的话。",
    genre: ["奇幻"],
    themes: ["记忆"],
    acts: [{ act: 1, title: "纸鸢引魂", summary: "少女点亮引魂符。" }],
  },
  visual_bible: "冷蓝雨夜过渡到晨曦金",
  outline_approved: true,
  video_url: "/static/exports/project-1/final.mp4",
  status: "completed",
  target_shot_count: 6,
  character_hints: ["沈鸢", "阿砚"],
  reference_images: [],
  exports: [],
  created_at: "2026-11-28T00:00:00.000Z",
  updated_at: "2026-11-28T00:00:00.000Z",
} satisfies Project;

const character = {
  id: 2,
  project_id: 1,
  name: "沈鸢",
  description: "继承纸鸢铺的少女。",
  image_url: "/static/characters/2.png",
  reference_images: ["/static/characters/2.png"],
  has_embedding: true,
  approval_state: "approved",
  approval_version: 1,
} satisfies Character;

const shot = {
  id: 3,
  project_id: 1,
  order: 1,
  description: "雨夜街角，少女撑伞。",
  prompt: "gentle camera push in",
  image_url: "/static/shots/3.png",
  video_url: "/static/shots/3.mp4",
  dialogue: "这里以前，好像很亮。",
  character_ids: [2],
  consistency_result: {
    shotId: 3,
    order: 1,
    expected: [{ characterId: 2, name: "沈鸢", status: "consistent", distance: 0.22 }],
    extraFaces: [],
    verdict: "ok",
    message: "与参考形象一致",
    checkedAt: "2026-11-28T00:00:00.000Z",
  },
} satisfies Shot;

const run = {
  id: 9,
  project_id: 1,
  status: "running",
  awaiting_gate: "outline_approval",
  progress: 0.2,
  thread_id: "thread-1-9",
  created_at: "2026-11-28T00:00:00.000Z",
  updated_at: "2026-11-28T00:00:00.000Z",
} satisfies AgentRun;

const message = {
  id: 10,
  project_id: 1,
  run_id: 9,
  agent: "system",
  role: "assistant",
  content: "开始生成故事大纲...",
  is_loading: true,
  created_at: "2026-11-28T00:00:00.000Z",
} satisfies Message;

type AssertNever<T extends never> = T;
export type _AllWsEventsMapped = AssertNever<MissingWsEventData>;

describe("shared contracts", () => {
  it("Project/Character/Shot/Run/Message 使用整数 id、snake_case 与 ISO 时间", () => {
    expect(project.id).toBe(1);
    expect(project.story_outline?.acts[0].title).toBe("纸鸢引魂");
    expect(character.project_id).toBe(1);
    expect(shot.consistency_result?.verdict).toBe("ok");
    expect(run.awaiting_gate).toBe("outline_approval");
    expect(message.is_loading).toBe(true);
    expect(new Date(project.created_at).toISOString()).toBe(project.created_at);
  });

  it("WS 事件名唯一，且 WsEvent 能按事件名收窄 data", () => {
    expect(new Set(WS_EVENT_TYPES).size).toBe(WS_EVENT_TYPES.length);

    const event: WsEvent = {
      type: "run_progress",
      data: { run_id: 9, progress: 0.5 },
    };
    expect(event.type).toBe("run_progress");
    if (event.type === "run_progress") {
      expect(event.data.progress).toBe(0.5);
    }
  });
});
