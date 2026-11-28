import { describe, expect, it } from "vitest";
import {
  CancelRunResponseSchema,
  CreateProjectSchema,
  GenerateRunResponseSchema,
  ProjectSchema,
  ShotSchema,
  StoryOutlineSchema,
  UploadReferenceResponseSchema,
  WS_EVENT_DATA_SCHEMAS,
  WS_EVENT_SCHEMA_COVERAGE,
  validateWsEventData,
} from "../index";

describe("shared runtime validation", () => {
  it("CreateProjectSchema 接受合法输入并拒绝缺 title", () => {
    expect(CreateProjectSchema.safeParse({ title: "纸鸢引", story: "..." }).success).toBe(true);
    expect(CreateProjectSchema.safeParse({ story: "..." }).success).toBe(false);
  });

  it("ProjectSchema 要求整数 id 与 ISO 时间", () => {
    const valid = {
      id: 1,
      title: "纸鸢引",
      created_at: "2026-11-28T00:00:00.000Z",
      updated_at: "2026-11-28T00:00:00.000Z",
    };
    expect(ProjectSchema.safeParse(valid).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...valid, id: "1" }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...valid, created_at: "" }).success).toBe(false);
  });

  it("ShotSchema 允许缺失的可选字段，但 id/order 必须存在", () => {
    expect(ShotSchema.safeParse({ id: 3, project_id: 1, order: 1 }).success).toBe(true);
    expect(ShotSchema.safeParse({ id: 3, project_id: 1 }).success).toBe(false);
  });

  it("StoryOutlineSchema 对模型产物保持宽松（允许 {raw}）", () => {
    expect(StoryOutlineSchema.safeParse({ raw: "模型没有返回 JSON" }).success).toBe(true);
  });

  it("命令类响应回执也走同一套 schema", () => {
    expect(GenerateRunResponseSchema.safeParse({ run_id: 9, status: "queued" }).success).toBe(true);
    expect(GenerateRunResponseSchema.safeParse({ run_id: "9", status: "queued" }).success).toBe(false);
    expect(CancelRunResponseSchema.safeParse({ status: "cancelled", cancelled: 1 }).success).toBe(true);
    expect(
      UploadReferenceResponseSchema.safeParse({ url: "/static/x.png", reference_images: [] }).success,
    ).toBe(true);
  });

  it("WS 事件 map 覆盖全部事件，并能拒绝越界进度", () => {
    expect(WS_EVENT_SCHEMA_COVERAGE).toBe(true);
    expect(Object.keys(WS_EVENT_DATA_SCHEMAS)).toHaveLength(30);
    expect(validateWsEventData("run_progress", { run_id: 1, progress: 0.5 }).ok).toBe(true);
    expect(validateWsEventData("run_progress", { run_id: 1, progress: 2 }).ok).toBe(false);
    expect(
      validateWsEventData("agent_thinking", { agent: "x", phase: "thinking", content: "y" }).ok,
    ).toBe(false);
  });
});
