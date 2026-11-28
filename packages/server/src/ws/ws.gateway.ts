import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Inject, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Server, Socket } from "socket.io";
import Redis from "ioredis";
import { and, eq } from "drizzle-orm";
import { DRIZZLE, schema } from "../db";
import type { Db } from "../db";
import { REDIS_CLIENT } from "../redis";
import { parseCorsOrigins } from "../config/cors";
import { parseConfirmRunId, parseProjectRoomId, projectIdFromRooms } from "./room";
import { constantTimeEquals } from "../modules/config/admin.guard";
import { validateWsEventData, type WsEventDataMap, type WsEventType } from "@miraframe/shared";

// 与 REST 共用同一套来源白名单；模块加载时 ConfigModule 通常已就绪，
// 未就绪时 parseCorsOrigins 也会返回本地开发默认值，不会放开到任意来源。
const CORS_ORIGINS = parseCorsOrigins(process.env.CORS_ORIGINS);

@WebSocketGateway({
  namespace: "ws/projects",
  cors: { origin: CORS_ORIGINS },
})
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  // 可选注入：运行时由全局 DatabaseModule / RedisModule 提供；
  // 缺少依赖的测试场景降级为只做格式校验或直接忽略。
  constructor(
    @Optional() @Inject(DRIZZLE) private readonly db?: Db,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService,
  ) {}

  handleConnection(client: Socket) {
    const expected = this.config?.get<string>("app.apiToken");
    if (!expected) {
      console.log(`[WS] Client connected: ${client.id}`);
      return;
    }

    const auth = client.handshake.auth as { token?: unknown } | undefined;
    const token =
      typeof auth?.token === "string"
        ? auth.token
        : typeof client.handshake.headers["x-api-token"] === "string"
          ? client.handshake.headers["x-api-token"]
          : null;

    if (!token || !constantTimeEquals(token, expected)) {
      console.warn(`[WS] Rejected unauthenticated client ${client.id}`);
      client.disconnect(true);
      return;
    }
    console.log(`[WS] Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`[WS] Client disconnected: ${client.id}`);
  }

  @SubscribeMessage("join")
  async handleJoinRoom(client: Socket, rawProjectId: unknown) {
    const projectId = parseProjectRoomId(rawProjectId);
    if (projectId === null) {
      console.warn(`[WS] Rejected join with invalid project id from ${client.id}`);
      return;
    }
    // 项目不存在时静默拒绝，不向调用方透露存在性信息。
    if (!(await this.projectExists(projectId))) {
      console.warn(`[WS] Rejected join for unknown project ${projectId} from ${client.id}`);
      return;
    }

    const room = `project:${projectId}`;
    client.join(room);
    console.log(`[WS] Client ${client.id} joined room ${room}`);
    client.emit("connected", {
      type: "connected",
      data: { project_id: projectId },
    });
  }

  /**
   * 实时确认通道（前端 yolo / 不刷新页面的场景）。
   *
   * 以前前端 `socket.emit("confirm")` 是死代码：网关只处理 join。
   * 这里补上后，确认仍走和 REST 完全相同的 Redis 频道，不引入第二条状态机。
   * 校验三件事：room 已 join、run 属于该 room、run 仍 active。
   */
  @SubscribeMessage("confirm")
  async handleConfirm(client: Socket, payload: unknown) {
    if (!this.redis) {
      console.warn("[WS] confirm 被忽略：Redis 未就绪");
      return;
    }
    const runId = parseConfirmRunId(payload);
    const projectId = projectIdFromRooms(client.rooms);
    if (runId === null || projectId === null) {
      console.warn(`[WS] Rejected confirm with invalid payload from ${client.id}`);
      return;
    }

    if (this.db) {
      const [run] = await this.db
        .select({ status: schema.agentRuns.status })
        .from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.projectId, projectId)))
        .limit(1);
      if (!run || (run.status !== "running" && run.status !== "queued")) {
        console.warn(
          `[WS] Rejected confirm for inactive/foreign run=${runId} project=${projectId}`,
        );
        return;
      }
    }

    await this.redis.publish(
      `generation:${projectId}:${runId}`,
      JSON.stringify({ action: "confirm" }),
    );
    console.log(`[WS] → confirm published project=${projectId} run=${runId}`);
  }

  private async projectExists(id: number): Promise<boolean> {
    if (!this.db) return true;
    try {
      const rows = await this.db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, id))
        .limit(1);
      return rows.length > 0;
    } catch (err) {
      // WS 是只读订阅；DB 抖动时宁可放行并记录，也不要拖垮前端连接。
      console.warn(`[WS] Project existence check failed for ${id}:`, err);
      return true;
    }
  }

  sendToProject<K extends WsEventType>(projectId: number, event: K, data: WsEventDataMap[K]) {
    const room = `project:${projectId}`;
    const validation = validateWsEventData(event, data);
    if (!validation.ok) {
      const details = validation.issues
        .map((issue) => `${issue.path || "(root)"}: ${issue.message}`)
        .join("; ");
      console.error(`[WS] 出站事件 "${event}" 不符合 shared 契约: ${details}`);
      // 开发/测试直接失败，生产只记录：一个字段不该让整条生成任务挂掉。
      if (process.env.NODE_ENV !== "production") {
        throw new Error(`WS 出站事件 "${event}" 不符合 shared 契约: ${details}`);
      }
    }
    console.log(`[WS] → emit "${event}" to room ${room}`);
    if (this.server) {
      this.server.to(room).emit(event, data);
    } else {
      console.error(`[WS] Server not initialized! Cannot emit "${event}"`);
    }
  }
}
