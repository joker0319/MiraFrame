import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { CreateProjectSchema, FeedbackSchema, ResumeRequestSchema } from "@miraframe/shared";
import { ZodValidationPipe } from "../common/zod-validation.pipe";

describe("ZodValidationPipe", () => {
  it("合法 body 原样通过（含默认值转换）", () => {
    const pipe = new ZodValidationPipe(CreateProjectSchema);
    expect(pipe.transform({ title: "纸鸢引" })).toMatchObject({ title: "纸鸢引" });
  });

  it("非法 body 返回 400，并带 issues 路径", () => {
    const pipe = new ZodValidationPipe(CreateProjectSchema);
    expect(() => pipe.transform({ story: "没有标题" })).toThrow(BadRequestException);
  });

  it("空 body 按 {} 处理，适配所有字段都可选的命令接口", () => {
    const pipe = new ZodValidationPipe(ResumeRequestSchema);
    expect(() => pipe.transform(undefined)).not.toThrow();
    expect(() => pipe.transform({})).not.toThrow();
  });

  it("FeedbackSchema 拒绝空内容", () => {
    const pipe = new ZodValidationPipe(FeedbackSchema);
    expect(() => pipe.transform({ content: "" })).toThrow(BadRequestException);
  });
});
