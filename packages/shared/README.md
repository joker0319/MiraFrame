# @miraframe/shared

这里是**接口契约的唯一来源**。前端、服务端、Agent 都从这里取类型，不再各维护一份。

## 内容

| 路径 | 作用 |
| --- | --- |
| `types/project.ts` | Project / Character / Shot / StoryOutline / Revision / 上传等 |
| `types/agent.ts` | AgentRun / Message / 恢复摘要 |
| `types/ws-events.ts` | 30 个 WS 事件的数据形状 + 强类型 `WsEvent` 信封 |
| `types/consistency.ts` | 角色一致性校验报告（camelCase，直接对应计算层） |
| `types/config.ts` | 运行时配置项 |
| `types/api.ts` | 生成/确认/取消/修改等命令接口的回执 |
| `schemas/` | Zod 校验：实体、WS 事件、请求体、配置 |
| `constants/stages.ts` | 阶段名与顺序，Agent 状态图使用 |
| `constants/events.ts` | `WS_EVENT_TYPES`，前端监听列表与服务端事件名校验共用 |
| `utils/dialogue.ts` | 台词拆分与时长估算，TTS 与字幕共用 |

## 约定

- **ID 是整数**（数据库 `serial`），不是 UUID。
- **JSON 字段是 snake_case**；只有一致性校验内部结果保留 camelCase，因为它直接对应纯计算结构。
- **时间是 ISO 字符串**（`2026-11-28T00:00:00.000Z`），不是 `Date` 对象。
- 服务端在 `packages/server/src/contracts/dto.ts` 把数据库行转成这里的类型；REST 不再直接返回 Drizzle 行。
- 前端 `frontend/src/types/index.ts` 只做 `export type * from "@miraframe/shared"`，另加三个 UI 私有类型（`WorkflowStage`、`AgentMessage`、`AGENT_NAME_MAP`）。

## 校验策略

- **类型层**：编译期由 TypeScript 保证字段名/可空性；`WsEventDataMap` 漏事件、DTO 漏字段都会让 `tsc` 失败。
- **运行时**：`schemas/` 里同时提供 Zod schema：
  - REST 入参：`server/src/common/zod-validation.pipe.ts` 校验 CreateProject / Revision / Feedback / Generate / Resume / Character/Shot 更新 / Config；
  - REST 出站：DTO 在返回前 `safeParse`，开发/测试失败即抛，生产只记日志；
  - WS 出站：`WsGateway.sendToProject` 按 `WS_EVENT_DATA_SCHEMAS` 校验，同样开发/测试抛、生产记录。
- 模型产物（如 StoryOutline）的 schema 刻意比类型宽松，允许 fallback 的 `{raw}`，避免把不完整的模型输出误判成接口违约。
