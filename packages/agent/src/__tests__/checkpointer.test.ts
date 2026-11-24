import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemorySaver } from "@langchain/langgraph";

// vi.mock 会被提升到文件顶部，工厂里只能引用 vi.hoisted 出来的引用
const { setupMock, fromConnStringMock } = vi.hoisted(() => ({
  setupMock: vi.fn(async () => undefined),
  fromConnStringMock: vi.fn(),
}));

vi.mock("@langchain/langgraph-checkpoint-postgres", () => ({
  PostgresSaver: { fromConnString: fromConnStringMock },
}));

import { createCheckpointer, resetCheckpointer } from "../checkpointer.js";

describe("createCheckpointer", () => {
  beforeEach(() => {
    resetCheckpointer();
    fromConnStringMock.mockReset();
    fromConnStringMock.mockImplementation(() => ({ setup: setupMock }));
    setupMock.mockReset();
    setupMock.mockImplementation(async () => undefined);
  });

  it("没有连接串时退回 MemorySaver，不触碰 Postgres", async () => {
    const saver = await createCheckpointer();
    expect(saver).toBeInstanceOf(MemorySaver);
    expect(fromConnStringMock).not.toHaveBeenCalled();
  });

  it("有连接串时用 PostgresSaver 并建表", async () => {
    const conn = "postgres://u:p@localhost:5432/miraframe";
    const saver = await createCheckpointer(conn);

    expect(fromConnStringMock).toHaveBeenCalledWith(conn);
    expect(setupMock).toHaveBeenCalledTimes(1);
    expect(saver).toEqual({ setup: setupMock });
  });

  it("并发调用共用一个 saver，setup 只跑一次", async () => {
    const [a, b, c] = await Promise.all([
      createCheckpointer("postgres://x"),
      createCheckpointer("postgres://x"),
      createCheckpointer("postgres://x"),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(fromConnStringMock).toHaveBeenCalledTimes(1);
    expect(setupMock).toHaveBeenCalledTimes(1);
  });

  it("建表失败不缓存坏 Promise，下一次能重试成功", async () => {
    setupMock.mockRejectedValueOnce(new Error("boom"));

    await expect(createCheckpointer("postgres://y")).rejects.toThrow("boom");
    await expect(createCheckpointer("postgres://y")).resolves.toBeTruthy();

    expect(fromConnStringMock).toHaveBeenCalledTimes(2);
    expect(setupMock).toHaveBeenCalledTimes(2);
  });
});
