import { DynamicStructuredTool } from "@langchain/core/tools";
import type { AgentTool, ToolDefinition, ToolInputSchema } from "./types.js";

/**
 * LangChain 工具协议桥接。
 *
 * 背景：项目原来的工具层是自研的「JSON Schema + execute」协议，虽然形态上
 * 已经和 OpenAI function calling 一致，但和 LangChain 生态不互通 —— 既不能
 * 把 LangChain 的工具拿进来，也不能把我们的工具交给 LangChain agent 用。
 *
 * 这里做双向适配，关键在于：LangChain 的 tool() / DynamicStructuredTool 接受
 * **纯 JSON Schema**（不强制 zod），所以适配层不需要引入 zod 依赖，
 * 也能在 pnpm 严格隔离的环境里正常工作。
 */

/** LangChain 工具的最小结构（duck typing，避免类型与具体版本强绑定） */
export interface LangChainToolLike {
  name?: string;
  description?: string;
  // LangChain 的 invoke 参数是具体输入类型，这里必须用 any 才能接受任意工具，
  // 用 unknown 会因参数逆变不兼容（TS 严格模式下具体类型不能赋给 unknown 参数）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (input: any, config?: any) => Promise<any>;
  schema?: unknown;
  lc_kwargs?: {
    name?: string;
    description?: string;
    schema?: unknown;
  };
}

function isJsonSchema(value: unknown): value is ToolInputSchema {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "object" && typeof record.properties === "object";
}

function isZodSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return "_def" in record || "def" in record;
}

function toTextResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * LangChain 工具 → 项目内 AgentTool。
 *
 * 只接受 JSON Schema 描述的参数：如果传入的是 zod schema，直接报错而不是
 * 静默降级 —— 静默降级会让模型收到错误的参数定义，比报错更难排查。
 */
export function fromLangChainTool(tool: LangChainToolLike): AgentTool {
  const name = tool.name ?? tool.lc_kwargs?.name;
  if (!name) throw new Error("LangChain 工具缺少 name，无法注册");

  const description = tool.description ?? tool.lc_kwargs?.description ?? "";
  const rawSchema = tool.schema ?? tool.lc_kwargs?.schema;

  let inputSchema: ToolInputSchema;
  if (rawSchema == null) {
    inputSchema = { type: "object", properties: {}, additionalProperties: true };
  } else if (isJsonSchema(rawSchema)) {
    inputSchema = rawSchema;
  } else if (isZodSchema(rawSchema)) {
    throw new Error(
      `工具 "${name}" 使用 zod schema，本项目未依赖 zod。请改用 JSON Schema 定义，或在调用方用 zodToJsonSchema 预转。`,
    );
  } else {
    throw new Error(`工具 "${name}" 的 schema 既不是 JSON Schema 也不是 zod schema`);
  }

  return {
    definition: { name, description, inputSchema },
    execute: async (args) => toTextResult(await tool.invoke(args)),
  };
}

/** 项目内 AgentTool → LangChain DynamicStructuredTool（可直接 bindTools 给模型） */
export function toLangChainTool(tool: AgentTool): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: tool.definition.name,
    description: tool.definition.description,
    schema: tool.definition.inputSchema,
    func: async (input: unknown) => tool.execute((input ?? {}) as Record<string, unknown>),
  });
}

/** 项目内 AgentTool → OpenAI function calling 的工具声明 */
export function toOpenAiToolSpec(definition: ToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    },
  };
}
