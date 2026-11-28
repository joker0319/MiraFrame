// ============================================================
// 前端类型入口
//
// 接口/领域类型全部来自 @miraframe/shared（单一来源）。
// 这个文件只保留“渲染层私有”的类型：路由阶段、带图标的聊天消息、中文标签映射。
// ============================================================

import type React from "react";
import type { AgentThinkingPhase } from "@miraframe/shared";

export type * from "@miraframe/shared";

/** 前端工作台自己的阶段名（后端 stage → 这个枚举的映射在 utils/workflowStage）。 */
export type WorkflowStage =
  | "outline"
  | "outline_approval"
  | "characters"
  | "characters_approval"
  | "shots"
  | "shots_approval"
  | "shot_images"
  | "output"
  | "review";

/** 服务端 agent 名 → 界面展示名。纯 UI 文案，不属于接口契约。 */
export const AGENT_NAME_MAP: Record<string, string> = {
  outline: "大纲",
  plan: "规划",
  character: "角色",
  shot: "分镜",
  compose: "合成",
  review: "审查",
  critic: "质量审查",
};

/**
 * 聊天流里的消息。比 `Message` 多了图标、时间和思考阶段，
 * 因为它混合了“DB 历史消息”和“WS 实时事件”，不是单纯的服务端行。
 */
export interface AgentMessage {
  id?: string;
  agent: string;
  role: string;
  content: string;
  summary?: string;
  icon?: React.ComponentType<{ className?: string }>;
  timestamp?: string;
  progress?: number;
  isLoading?: boolean;
  phase?: AgentThinkingPhase;
  details?: string;
}
