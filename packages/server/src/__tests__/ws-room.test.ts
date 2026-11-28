import { describe, expect, it, vi } from "vitest";
import { WsGateway } from "../ws/ws.gateway";
import { parseConfirmRunId, parseProjectRoomId, projectIdFromRooms } from "../ws/room";

describe("WS room 与 confirm 载荷解析", () => {
  it("只接受正整数项目 id", () => {
    expect(parseProjectRoomId("12")).toBe(12);
    expect(parseProjectRoomId(12)).toBe(12);
    expect(parseProjectRoomId(" 12 ")).toBe(12);
    expect(parseProjectRoomId("project:12")).toBeNull();
    expect(parseProjectRoomId("-1")).toBeNull();
    expect(parseProjectRoomId("1.5")).toBeNull();
    expect(parseProjectRoomId(null)).toBeNull();
  });

  it("兼容前端 {type, data:{run_id}} 与直接 {run_id} 两种载荷", () => {
    expect(parseConfirmRunId({ type: "confirm", data: { run_id: 7 } })).toBe(7);
    expect(parseConfirmRunId({ run_id: "7" })).toBe(7);
    expect(parseConfirmRunId({ data: { run_id: 0 } })).toBeNull();
    expect(parseConfirmRunId({ data: { run_id: "abc" } })).toBeNull();
    expect(parseConfirmRunId("7")).toBeNull();
  });

  it("从房间集合反查项目 id，忽略其他房间", () => {
    expect(projectIdFromRooms(new Set(["project:3", "project:4"]))).toBe(3);
    expect(projectIdFromRooms(new Set(["project:abc"]))).toBeNull();
    expect(projectIdFromRooms([])).toBeNull();
  });
});

describe("WS 出站契约校验", () => {
  it("合法事件放行，非法事件在测试环境直接抛错", () => {
    const gateway = new WsGateway();
    const emit = vi.fn();
    gateway.server = { to: () => ({ emit }) } as never;

    expect(() =>
      gateway.sendToProject(1, "run_progress", { run_id: 9, progress: 0.5 }),
    ).not.toThrow();
    expect(emit).toHaveBeenCalledWith("run_progress", { run_id: 9, progress: 0.5 });

    expect(() =>
      gateway.sendToProject(1, "run_progress", { run_id: 9, progress: 2 } as never),
    ).toThrow(/不符合 shared 契约/);
  });
});

describe("WS 共享口令握手", () => {
  function makeClient(token?: string) {
    return {
      id: "socket-1",
      handshake: { auth: token ? { token } : {}, headers: {} },
      disconnect: vi.fn(),
    } as never;
  }

  it("配置 API_TOKEN 后，无 token 直接断开，正确 token 放行", () => {
    const gateway = new WsGateway(undefined, undefined, { get: () => "secret" } as never);
    const bad = makeClient();
    gateway.handleConnection(bad);
    expect((bad as { disconnect: ReturnType<typeof vi.fn> }).disconnect).toHaveBeenCalledWith(true);

    const good = makeClient("secret");
    gateway.handleConnection(good);
    expect((good as { disconnect: ReturnType<typeof vi.fn> }).disconnect).not.toHaveBeenCalled();
  });
});
