import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebSocket } from "../hooks/useWebSocket";
import { getApiBase } from "../services/client";
import { useRunStore } from "../stores/runStore";
import { useMessageStore } from "../stores/messageStore";
import { useShotStore } from "../stores/shotStore";
import { useCharacterStore } from "../stores/characterStore";
import { useProjectStore } from "../stores/projectStore";
import { useCritiqueStore } from "../stores/critiqueStore";
import type { Character, Shot } from "@/types";

const { handlers, fakeSocket, ioMock } = vi.hoisted(() => {
  const handlers = new Map<string, (data: Record<string, unknown>) => void>();
  const fakeSocket = {
    connected: true,
    on: vi.fn((event: string, cb: (data: Record<string, unknown>) => void) => {
      handlers.set(event, cb);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
    emit: vi.fn(),
  };
  return { handlers, fakeSocket, ioMock: vi.fn(() => fakeSocket) };
});

vi.mock("socket.io-client", () => ({ io: ioMock }));

function HookHarness({ projectId }: { projectId: number }) {
  const { send } = useWebSocket(projectId);
  return (
    <button type="button" onClick={() => send({ type: "confirm", data: { run_id: 99 } })}>
      send
    </button>
  );
}

let nextProjectId = 1000;
function mount() {
  const projectId = nextProjectId++;
  render(<HookHarness projectId={projectId} />);
  return projectId;
}

function emit(event: string, data: Record<string, unknown>) {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`事件 ${event} 没有注册 handler`);
  act(() => handler(data));
}

function lastMessage() {
  return useMessageStore.getState().messages.at(-1);
}

const makeCharacter = (overrides: Partial<Character> = {}): Character => ({
  id: 1,
  project_id: 1,
  name: "沈鸢",
  image_url: "/static/c1.png",
  ...overrides,
});

const makeShot = (overrides: Partial<Shot> = {}): Shot => ({
  id: 1,
  project_id: 1,
  order: 1,
  image_url: "/static/s1.png",
  video_url: null,
  ...overrides,
});

beforeEach(() => {
  handlers.clear();
  fakeSocket.emit.mockClear();
  ioMock.mockClear();
  useRunStore.getState().resetRunState();
  useRunStore.getState().setRunMode("manual");
  useMessageStore.getState().clearMessages();
  useShotStore.getState().clearShots();
  useCharacterStore.getState().clearCharacters();
  useProjectStore.getState().clearProject();
  useCritiqueStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useWebSocket 事件落点", () => {
  it("用与 API 同源的地址建连，连接后加入项目房间", () => {
    const projectId = mount();

    expect(ioMock).toHaveBeenCalledWith(
      `${getApiBase()}/ws/projects`,
      expect.objectContaining({ transports: ["websocket", "polling"] }),
    );
    emit("connect", {});
    expect(fakeSocket.emit).toHaveBeenCalledWith("join", String(projectId));
  });

  it("error 事件把服务端错误写进消息流", () => {
    mount();
    emit("error", { message: "provider down" });
    expect(lastMessage()).toMatchObject({ role: "error", content: "provider down" });
  });

  it("run_started 启动运行状态并写入开始分隔消息", () => {
    mount();
    emit("run_started", { run_id: 42, recovery_summary: { rounds: 1 } });

    expect(useRunStore.getState()).toMatchObject({
      isGenerating: true,
      currentRunId: 42,
      progress: 0,
    });
    expect(lastMessage()?.content).toBe("开始生成");
  });

  it("run_progress 同步进度、agent 与阶段", () => {
    mount();
    emit("run_progress", {
      run_id: 42,
      progress: 0.6,
      current_agent: "critic",
      stage: "render_shot_images",
    });

    expect(useRunStore.getState()).toMatchObject({
      isGenerating: true,
      progress: 0.6,
      currentAgent: "critic",
      currentStage: "shot_images",
    });
  });

  it("run_message 落消息并从 stage 字段推导阶段", () => {
    mount();
    emit("run_message", {
      agent: "outline",
      content: "大纲已生成",
      stage: "plan_outline",
    });

    expect(lastMessage()).toMatchObject({ agent: "outline", content: "大纲已生成" });
    expect(useRunStore.getState().currentStage).toBe("outline");
  });

  it("run_awaiting_confirm 打开审批门并产出等待消息", () => {
    mount();
    emit("run_awaiting_confirm", {
      run_id: 42,
      agent: "characters",
      gate: "characters_approval",
      question: "是否继续？",
    });

    expect(useRunStore.getState()).toMatchObject({
      awaitingConfirm: true,
      awaitingAgent: "characters",
      currentStage: "characters_approval",
    });
    expect(lastMessage()?.content).toContain("等待确认：是否继续？");
  });

  it("run_confirmed / run_completed / run_failed / run_cancelled 收敛运行状态", () => {
    mount();

    emit("run_confirmed", {});
    expect(useRunStore.getState().awaitingConfirm).toBe(false);

    emit("run_completed", { message: "全部完成" });
    expect(useRunStore.getState()).toMatchObject({
      isGenerating: false,
      currentStage: "review",
      progress: 1,
    });
    expect(lastMessage()?.content).toBe("全部完成");

    emit("run_started", { run_id: 1 });
    emit("run_failed", { error: "额度不足" });
    expect(useRunStore.getState()).toMatchObject({ isGenerating: false, error: "额度不足" });

    emit("run_cancelled", {});
    expect(useRunStore.getState()).toMatchObject({ isGenerating: false, progress: 0 });
  });

  it("角色与镜头实体事件更新对应 store，删除事件移除记录", () => {
    mount();
    useCharacterStore.getState().setCharacters([makeCharacter()]);
    useShotStore.getState().setShots([makeShot()]);

    emit("character_updated", { character: makeCharacter({ name: "沈鸢（改）" }) });
    expect(useCharacterStore.getState().characters[0].name).toBe("沈鸢（改）");

    emit("shot_updated", { shot: makeShot({ video_url: "/static/a.mp4" }) });
    expect(useShotStore.getState().shots[0].video_url).toBe("/static/a.mp4");

    emit("character_deleted", { character_id: 1 });
    emit("shot_deleted", { shot_id: 1 });
    expect(useCharacterStore.getState().characters).toHaveLength(0);
    expect(useShotStore.getState().shots).toHaveLength(0);
  });

  it("project_updated 只覆盖随事件传来的字段，data_cleared 按类型清空", () => {
    mount();
    emit("project_updated", { title: "雾中字条", target_shot_count: 6 });
    expect(useProjectStore.getState().projectTitle).toBe("雾中字条");
    expect(useProjectStore.getState().projectTargetShotCount).toBe(6);

    useCharacterStore.getState().setCharacters([makeCharacter()]);
    useShotStore.getState().setShots([makeShot()]);
    emit("data_cleared", { clearedTypes: ["characters", "shots"] });
    expect(useCharacterStore.getState().characters).toHaveLength(0);
    expect(useShotStore.getState().shots).toHaveLength(0);
  });

  it("critique_result 按 stage 分别落库，并写一条可回溯消息", () => {
    mount();
    emit("critique_result", {
      stage: "keyframe",
      entity_type: "shots",
      score: 6.2,
      threshold: 6.5,
      passed: false,
      dimensions: { quality: 6 },
      issues: ["镜头 #2 手指畸形"],
      will_regenerate: true,
    });

    expect(useCritiqueStore.getState().byStage.keyframe?.score).toBe(6.2);
    expect(useCritiqueStore.getState().byStage.critique_shots).toBeUndefined();
    expect(lastMessage()?.content).toContain("评分: 6.2/10");
    expect(lastMessage()?.content).toContain("将重新生成");
  });

  it("version / audio / consistency 事件各自落到消息或镜头快照", () => {
    mount();
    useShotStore.getState().setShots([makeShot()]);

    emit("version_created", { version: 3 });
    expect(lastMessage()?.content).toContain("版本已保存 (v3)");

    emit("version_rollback", { from_version: 3, to_version: 2 });
    expect(lastMessage()?.content).toContain("已回滚从 v3 到 v2");

    emit("audio_generated", { shot_id: 1, tts_url: "/static/tts/1.mp3" });
    expect(useShotStore.getState().shots[0].tts_url).toBe("/static/tts/1.mp3");

    emit("consistency_eval_completed", {
      shots: [{ shot_id: 1, consistency_result: { verdict: "drift" } }],
      summary: { drift: 1, review: 0 },
    });
    expect(useShotStore.getState().shots[0].consistency_result).toMatchObject({
      verdict: "drift",
    });
    expect(lastMessage()?.content).toContain("1 个镜头疑似漂移");
  });

  it("consistency_repair_completed 汇总修复数、失败数与未恢复数", () => {
    mount();
    emit("consistency_repair_completed", {
      repaired: [
        { order: 1, references: 3, resolved: true },
        { order: 2, references: 2, resolved: false },
      ],
      failed: [{ shot_id: 3, error: "生成失败" }],
    });

    const content = lastMessage()?.content ?? "";
    expect(content).toContain("重画 2 个镜头，1 个已恢复");
    expect(content).toContain("1 个仍疑似漂移");
    expect(content).toContain("1 个修复失败");
  });

  it("send 只在 socket 已连接时发出 confirm", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(fakeSocket.emit).toHaveBeenCalledWith("confirm", {
      type: "confirm",
      data: { run_id: 99 },
    });

    fakeSocket.emit.mockClear();
    fakeSocket.connected = false;
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(fakeSocket.emit).not.toHaveBeenCalled();
    fakeSocket.connected = true;
  });

  it("yolo 模式在审批门后自动确认", () => {
    vi.useFakeTimers();
    useRunStore.getState().setRunMode("yolo");
    mount();

    emit("run_awaiting_confirm", { run_id: 7, auto_mode: false });
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(fakeSocket.emit).toHaveBeenCalledWith("confirm", {
      type: "confirm",
      data: { run_id: 7 },
    });
  });
});
