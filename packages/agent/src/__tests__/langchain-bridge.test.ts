import { describe, expect, it } from "vitest";
import { tool } from "@langchain/core/tools";
import {
  fromLangChainTool,
  toLangChainTool,
  toOpenAiToolSpec,
} from "../tools/langchain-bridge.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AgentTool } from "../tools/types.js";

const WEATHER_SCHEMA = {
  type: "object",
  properties: { city: { type: "string", description: "城市名" } },
  required: ["city"],
} as const;

function createEchoTool(): AgentTool {
  return {
    definition: {
      name: "echo_city",
      description: "回显城市名",
      inputSchema: WEATHER_SCHEMA as unknown as AgentTool["definition"]["inputSchema"],
    },
    execute: async (args) => `city=${String(args.city ?? "")}`,
  };
}

describe("langchain-bridge", () => {
  it("LangChain tool() 产出的工具可以直接转成 AgentTool 并执行", async () => {
    const lcTool = tool(async (input: { q: string }) => `answer:${input.q}`, {
      name: "search_docs",
      description: "搜索文档",
      schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    });

    const agentTool = fromLangChainTool(lcTool);
    expect(agentTool.definition.name).toBe("search_docs");
    expect(agentTool.definition.inputSchema).toMatchObject({ type: "object" });
    expect(agentTool.definition.inputSchema.properties).toHaveProperty("q");
    await expect(agentTool.execute({ q: "大纲" })).resolves.toBe("answer:大纲");
  });

  it("AgentTool 转成 LangChain 工具后仍保留参数 schema 与执行语义", async () => {
    const lcTool = toLangChainTool(createEchoTool());
    expect(lcTool.name).toBe("echo_city");
    expect(lcTool.description).toContain("回显");
    await expect(lcTool.invoke({ city: "深圳" })).resolves.toBe("city=深圳");
  });

  it("往返转换后注册进 ToolRegistry 依然可执行（协议互通的关键闭环）", async () => {
    const roundTripped = fromLangChainTool(toLangChainTool(createEchoTool()));
    const registry = new ToolRegistry().register(roundTripped);
    const result = await registry.execute({ id: "1", name: "echo_city", arguments: { city: "东京" } });
    expect(result.toolCallId).toBe("1");
    expect(result.content).toBe("city=东京");
  });

  it("拒绝 zod schema 并给出可操作的错误，而不是静默降级", () => {
    const zodLike = { _def: { typeName: "ZodObject" }, parse: () => ({}) };
    expect(() =>
      fromLangChainTool({ name: "zod_tool", description: "d", schema: zodLike, invoke: async () => "x" }),
    ).toThrow(/zod/);
  });

  it("缺少 name 的工具直接报错", () => {
    expect(() => fromLangChainTool({ invoke: async () => "x" })).toThrow(/name/);
  });

  it("没有 schema 的工具补成空 object schema", () => {
    const agentTool = fromLangChainTool({ name: "no_args", invoke: async () => "ok" });
    expect(agentTool.definition.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  });

  it("toOpenAiToolSpec 产出标准 function calling 声明", () => {
    const spec = toOpenAiToolSpec(createEchoTool().definition);
    expect(spec.type).toBe("function");
    expect(spec.function.name).toBe("echo_city");
    expect(spec.function.parameters).toMatchObject({ type: "object" });
    expect(spec.function.parameters.properties).toHaveProperty("city");
  });
});
