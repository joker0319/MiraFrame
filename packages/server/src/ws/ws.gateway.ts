import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Inject, Optional } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { eq } from "drizzle-orm";
import { DRIZZLE, schema } from "../db";
import type { Db } from "../db";
import { parseCorsOrigins } from "../config/cors";
import { parseProjectRoomId } from "./room";

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

  // 可选注入：运行时由全局 DatabaseModule 提供；缺少 DB 的测试场景降级为只做格式校验。
  constructor(@Optional() @Inject(DRIZZLE) private readonly db?: Db) {}

  handleConnection(client: Socket) {
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

  sendToProject(projectId: number, event: string, data: unknown) {
    const room = `project:${projectId}`;
    console.log(`[WS] → emit "${event}" to room ${room}`);
    if (this.server) {
      this.server.to(room).emit(event, data);
    } else {
      console.error(`[WS] Server not initialized! Cannot emit "${event}"`);
    }
  }
}
