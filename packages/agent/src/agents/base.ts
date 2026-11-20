import type { Phase2StateType } from "../state.js";
import type { LlmChatMessage, LlmChatResponse, ToolDefinition } from "../tools/types.js";

export interface AgentContext {
  projectId: number;
  runId: number;
  threadId: string;
  sendMessage: (content: string, opts?: { summary?: string; progress?: number; isLoading?: boolean; stage?: string }) => Promise<void>;
  sendThinking: (phase: "reasoning" | "decision" | "planning" | "reviewing", content: string, details?: string) => Promise<void>;
  callLlm: (systemPrompt: string, userPrompt: string, opts?: { maxTokens?: number; intent?: string }) => Promise<string>;
  /**
   * 带工具调用能力的模型通道。可选：没有它时 ToolLoop 会自动降级到 JSON 协议，
   * 所以老测试、fake provider 和不支持 function calling 的模型都能照常工作。
   */
  callLlmWithTools?: (
    messages: LlmChatMessage[],
    tools: ToolDefinition[],
    opts?: { maxTokens?: number; intent?: string },
  ) => Promise<LlmChatResponse>;
  /** 读取持久化的产物血缘：character:id → shot:id[]。跨 run 有效。 */
  getArtifactLineage?: () => Promise<Record<string, string[]>>;
  /** Persist the generated story outline and notify frontend via WS */
  saveOutline: (outline: Record<string, unknown>, visualBible?: string | null) => Promise<void>;
  /** Create a character record in the DB and notify frontend via WS */
  createCharacter: (character: { name: string; description: string }) => Promise<{ id: number }>;
  /** Create a shot record in the DB and notify frontend via WS */
  createShot: (shot: {
    order: number;
    description: string;
    camera?: string;
    dialogue?: string;
    action?: string;
    scene?: string;
    lighting?: string;
    prompt?: string;
    imagePrompt?: string;
    duration?: number;
    motionNote?: string;
  }) => Promise<{ id: number }>;
  /** Generate character images based on existing character descriptions */
  generateCharacterImage: () => Promise<void>;
  /** Generate per-shot frame images from storyboard prompts */
  generateShotFrames: () => Promise<void>;
  /** Generate per-shot video clips from storyboard frames */
  generateShotVideos: () => Promise<void>;
  /** Compose shot clips into the final project output */
  composeProjectVideo: () => Promise<void>;
}

export class BaseAgent {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async sendMessage(
    ctx: AgentContext,
    content: string,
    opts?: { summary?: string; progress?: number; isLoading?: boolean; stage?: string },
  ): Promise<void> {
    await ctx.sendMessage(content, opts);
  }

  async sendThinking(
    ctx: AgentContext,
    phase: "reasoning" | "decision" | "planning" | "reviewing",
    content: string,
    details?: string,
  ): Promise<void> {
    await ctx.sendThinking(phase, content, details);
  }

  async callLlm(
    ctx: AgentContext,
    systemPrompt: string,
    userPrompt: string,
    opts?: { maxTokens?: number; intent?: string },
  ): Promise<string> {
    return ctx.callLlm(systemPrompt, userPrompt, opts);
  }

  async callLlmWithTools(
    ctx: AgentContext,
    messages: LlmChatMessage[],
    tools: ToolDefinition[],
    opts?: { maxTokens?: number; intent?: string },
  ): Promise<LlmChatResponse> {
    if (!ctx.callLlmWithTools) {
      throw new Error("当前 AgentContext 未配置 callLlmWithTools，请使用 runToolLoop 的 JSON 降级模式");
    }
    return ctx.callLlmWithTools(messages, tools, opts);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_ctx: AgentContext, _state: Phase2StateType): Promise<Partial<Phase2StateType>> {
    throw new Error(`Agent ${this.name}.run() not implemented`);
  }
}
