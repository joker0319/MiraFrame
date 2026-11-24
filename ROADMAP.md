# MiraFrame 后续优化路线图

> 数据截至 2026-11-24，代码基线 `82ae3d4`（42 个提交）。
> 配套：[RESUME.md](./RESUME.md)（简历写法）、[INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md)（面试口述）、[MODIFICATIONS.md](./MODIFICATIONS.md)（改动流水账）。
> 工期单位沿用 `multi-agent-upgrade-plan.md` 的「晚」（每天 2–3 小时）。
> **更新 2026-11-24：P0 已全部实施完毕**（安全收口、配置治理、工程卫生、最小 CI），**P1-1 checkpoint 持久化、P1-2 critique 可视化、P1-4 并发上下文治理、P1-3 工具层/MCP 也已完成**，下方各节保留为实施记录与验收依据。当前待办：P1-5（前端测试扩充）。P1-5 已部分完成——前端用例从 4 个增加到 10 个。

---

## 0. 先说判断

**现在最缺的不是新功能，是「可信度」和「一致性」。**

功能层面已经闭环：Director 决策、Critic 评估、人工门、失败恢复、一致性检测与反哺都真实跑通了，再加一个模块的边际收益很低。但有三类问题会在面试或背调时被放大：

1. **文档与代码不一致**：`multi-agent-upgrade-plan.md` 是 2026-10-28 的裁定稿，其 §1.2 九条差距里大部分已经实现或半实现，照着它讲会讲错。
2. **配置与安全裸奔**：运行时配置接口无鉴权、可明文取密钥、CORS 全开；`.env` 有死配置和重复项；Critic 阈值存在两套前缀且配的那个不生效。
3. **技术债正好压在考点上**：checkpoint 非持久、`critique_result` 定义了不 emit、MCP 没接、图像 rubric 定义了不调用 —— 这几个恰好是「多轮记忆 / Monitor 闭环 / 工具调用 / LLM-as-Judge」四个考点的最短板。

所以优先级是：**P0 先把口径和安全收干净 → P1 挑两三条把技术债直接转成简历亮点 → P2 才谈技术深度。**

### 优先级总览

| 级别 | 主题 | 工期 | 面试价值 | 建议 |
| --- | --- | --- | --- | --- |
| **P0** | 工程卫生 + 安全 + 配置治理 | 1–2 晚 | 中（防扣分） | **投递前必做** |
| **P1** | checkpoint 持久化、Monitor 闭环、工具层/MCP、测试与 CI | 3–6 晚 | **高（直接升级简历）** | 挑 2–3 项做 |
| **P2** | 多模态 Critic、provider 选路、多轮记忆、字幕烧录 | 每晚 1–2 项 | 中高（讲深度） | 有余力再说 |
| **不做** | 分布式锁、多租户、K8s、重写 Python | — | 负（分散叙事） | 明确拒绝 |

---

## 1. 现状盘点：旧计划的九条差距，现在还剩几条

`multi-agent-upgrade-plan.md` §1.2 的差距清单是改造**之前**写的。逐条核实后：

| # | 原差距 | 当前状态 | 证据 |
| --- | --- | --- | --- |
| 1 | Critic 是桩（硬编码 8.5） | **已实现** | `agents/critic.ts:87-91` 真调 LLM、`:107` 用模型分判定、`:127-134` 打回并回灌；`8.5` 仅存于测试 fixture |
| 2 | 无工具层（硬编码方法） | **部分** | 已有 `tools/registry.ts`、`tools/loop.ts`、`tools/outline-tools.ts`，但仅 `agents/outline.ts:22-38` 使用；协议是自研 JSON Schema，非 LangChain `tool()` |
| 3 | 无调度者（顺序写死） | **部分** | Director 已接入 `graph.ts:8,28-37`、`nodes/index.ts:245-252`；但生产节点之间仍是固定 `addEdge`（`graph.ts:40-55`），模型只能裁剪可选阶段 |
| 4 | Agent 间无通信 | **部分** | 打回语义已有（`critic.ts:127-134` + `plan.ts:71-81`），但仍是纯 state 共享，`state.ts` 无 `messages` 字段、全仓无 `handoff` |
| 5 | `artifactLineage` 空转 | **部分** | 字段已写入（`state.ts:22`、`lineage.ts:61-71`），但影响面分析实际走持久化的 `shots.characterIds`（`revision.service.ts:40-41,75-83`）；无 artifacts 表 |
| 6 | 无 provider 路由策略 | **未实现** | `text.service.ts:226-259` / `video.service.ts:420-444` 只是对同一 URL 重试；无切换、降级、成功率/成本指标 |
| 7 | 上下文失忆 | **部分** | `messages` 表已被消费（`agent.processor.ts:73-91`、`agent-run-state.ts:41-74` 注入 contextBlock），但 `callLlm` 仍只拼 `[system, user]` 单轮；无滚动摘要与 token 预算 |
| 8 | 无 MCP | **未实现** | 仅 `tools/registry.ts:9-10` 注释提及；无 mcp 目录、无 `@langchain/mcp-adapters` 依赖 |
| 9 | `_nodeCtx` 全局单例 | **部分** | AsyncLocalStorage 已用于主路径（`nodes/index.ts:50-54`、`agent.processor.ts:600,605,744`），但 `:49,57-60` 全局兜底、`:67-89` mock 静默降级仍在 |

> 结论：九条里 **1 条已实现、6 条部分实现、2 条未实现**。旧计划里「P0/P1/P2 主干」的说法已经过期，别再拿它当待办清单。

### 面试指南「诚实边界」复核

`INTERVIEW_GUIDE.md` §5 的八条里，**七条仍成立**（checkpoint 用 `MemorySaver`、`critique_result` 未 emit、MCP 未接、图像 rubric 未调用、宇宙文件残留、字幕外挂、i2i 手动）。

**一条需要修正**：原文写「`.env` 里 5 行 `DOUBAO_*` 配置已无代码消费」不准确 —— `config/app.config.ts:101-106` 读入 6 个字段，`video.service.ts:36,40,75,85,86` 把 `doubaoApiKey`/`doubaoVideoModel` 当作兜底值、`doubaoVideoDuration`/`doubaoVideoRatio` 当作默认参数消费；准确说法是「作为 legacy 兜底被读取，但没有独立 doubao provider 分支」。`DOUBAO_GENERATE_AUDIO` 确实无人消费。本轮已同步修正该文档。

---

## 2. P0 · 投递前必做（约 1–2 晚，防扣分）

这一档不产生新亮点，但能让「背调 / 现场打开代码」时不翻车。

### P0-1 运行时配置接口收口（安全，最高优先）

- **现状**：`modules/config/config.controller.ts:4-35` 无 `@UseGuards`；`POST reveal`（`:31-35`）返回明文密钥；`PUT` 可任意写 `.env`（`config.service.ts:184-203`）。`main.ts:13` `enableCors()` 全开，`ws.gateway.ts:10-13` `origin: "*"`、`join` 房间无校验。`ADMIN_TOKEN` 在 `app.config.ts:17` 定义、`.env:25` 为空、全仓无消费。
- **动作**：给 config 模块加 `ADMIN_TOKEN` 守卫；`reveal` 改为只返回掩码或干脆移除；CORS 收成白名单；WS `join` 校验 project 归属。`ADMIN_TOKEN` 为空时启动期告警。
- **验收**：未带 token 调 `PUT /config` 与 `/config/reveal` 返回 401/403；`.env` 不再被匿名请求改写。
- **落地点**：`modules/config/*`、`main.ts`、`ws/ws.gateway.ts`、`config/app.config.ts`。
- **备注**：原型项目不必做完整 RBAC，但「无鉴权可明文取密钥」被看到会直接扣分。

### P0-2 配置治理（消除双源与死配置）

- **现状**：`agents/critic.ts:9-10` 读 `CRITIC_SCORE_THRESHOLD`（默认 7）；`config/app.config.ts:139-143` 另定义 `CRITIQUE_ENABLED` / `CRITIQUE_SCORE_THRESHOLD`（默认 6.0）/ `CRITIQUE_MAX_ROUNDS`，三者全仓无消费者。`.env:111-113` 配的是 `CRITIQUE_` 前缀，**实际不生效**；`.env:95` 与 `:127` 两次 `TTS_ENABLED=true`；`app.config.ts` 全为 `process.env.X || default` 直读，无启动期校验（`main.ts` 也无全局 `ValidationPipe`）。
- **动作**：统一成一套前缀（建议保留 `CRITIC_`，删除 `app.config.ts` 里的死字段）；删 `.env` 重复项；把 provider 配置抽成 Zod schema 在启动期校验，缺关键项直接 fail-fast 而不是生成到一半报 401。
- **验收**：改 `.env` 阈值能真实改变 Critic 行为；缺 `TEXT_API_KEY` 时启动即报明确错误。
- **落地点**：`agents/critic.ts`、`config/app.config.ts`、`main.ts`、`.env` / `.env.example`。

### P0-3 工程卫生清理

- 删调试探针日志：`nodes/index.ts:171-177,187-193`（`>>> [门]`、`🔬 临时探针`）、`agents/outline.ts:12`（打印整份 state）。
- 删 `packages/server/package.json:15` 的 `db:push`（可绕过迁移直接推 schema），统一走 `db:generate` + `db:migrate`。
- 删已下线的宇宙残留：`pages/UniversesPage.tsx`、`pages/UniverseDetailPage.tsx`、`services/universesApi.ts`、`services/index.ts:14,178` 的导出。
- 挂载已定义但从未使用的 `components/ui/error-boundary.tsx:17-66`（目前 `App.tsx:37-49` 只有 `Suspense`）。
- **验收**：`grep` 不到探针日志；`pnpm typecheck` / `pnpm build` 仍通过；前端异常不再白屏。
- **落地点**：上述文件。

### P0-4 补最小 CI

- **现状**：`package.json:6-13` 有 `test` / `test:e2e`（`playwright test`）/ `lint` / `typecheck`，但 `:15-21` 没装 `@playwright/test`，全仓无 `.github/`、无 playwright 配置、无 `*.e2e.*`。`MODIFICATIONS.md:73` 只记了「移除失效 CI」，没补回来。
- **动作**：加一条 GitHub Actions，`push` / `PR` 跑 `pnpm typecheck && pnpm test && pnpm build`；要么补 `@playwright/test` + 一个冒烟用例，要么删掉空转的 `test:e2e` 脚本。
- **验收**：CI 徽章变绿；简历可写「CI 保障 149 个测试」。
- **落地点**：`.github/workflows/ci.yml`、根 `package.json`。

---

## 3. P1 · 面试加分最大（约 3–6 晚，挑 2–3 项）

这一档直接把「诚实边界」里的技术债转成简历 bullet，**性价比最高**。

### P1-1 checkpoint 持久化（首推）

> **状态：已完成（2026-11-24）**。`createCheckpointer(connectionString)` 按 `DATABASE_URL` 返回 `PostgresSaver` 并幂等建表，processor 不再 `new MemorySaver()`；重启续跑靠 BullMQ 重拾 job + 同 `thread_id` 的 checkpoint，无需额外恢复扫描。下方保留原始方案与验收标准。

- **动机**：`checkpointer.ts:5-7` 导出了 `createCheckpointer()` 但全仓无人调用；`agent.processor.ts:51-52` 仍 `new MemorySaver()`，进程重启丢图执行位置。这是六大考点里「多轮记忆」最实的短板，也是 Q4 必被追问的点。
- **动作**：实现 PostgresSaver，用 `thread_id = projectId:runId` 存 checkpoint；图 `compile({ checkpointer })` 换成它；确认 `interrupt` 恢复走同一 thread。
- **验收**：生成到一半重启后端，能从 DB 恢复到原节点继续执行；`awaitingGate` 与新 checkpoint 不冲突。
- **落地点**：`agent/src/checkpointer.ts`、`server/src/agent/agent.processor.ts`、新增 drizzle migration。
- **简历升级**：`RESUME.md` 版本 B 第 2 条可加「checkpoint 落 PostgreSQL，支持进程重启后从原节点恢复」。

### P1-2 emit `critique_result` + 前端评分可视化

> **状态：已完成（2026-11-24）**。Critic 每轮评审后经 `AgentContext.reportCritique` 上报，`agent.processor.ts` 转 snake_case 载荷广播；前端 `critiqueStore` 收下后由 `CritiquePanel` 渲染总分/阈值/轮次/四维得分/问题/建议，消息流同时留一条文本。补 13 个用例（agent 3 + server 契约 4 + 前端 6）。下方保留原始方案与验收标准。

- **动机**：事件在 `shared/src/constants/events.ts:8`、`types/ws-events.ts:29`、`frontend/src/types/index.ts:56` 三处定义，前端 `useWebSocket.ts:250-260,380` 也监听了，**服务端从来没 emit**。等于「Monitor 闭环」缺了最直观的一环。
- **动作**：Critic 打分后在 processor 里 emit 事件（带 `overall_score` / `dimensions` / `round` / `passed`）；前端在节点详情展示评分与打回原因。
- **验收**：分镜被 Critic 打回时，页面实时出现分数和意见，且能在消息流里回溯。
- **落地点**：`ws/ws.gateway.ts`、`agent.processor.ts`、`agents/critic.ts`、前端 `ConsistencyPanel` 同级新增评分组件。
- **简历升级**：LLM-as-Judge 从「代码里有」变成「演示看得见」，面试时能直接指屏幕讲。

### P1-3 工具层统一 + 接 MCP

> **状态：已完成（2026-11-24，2026-11-25 升级连接层）**。工具协议与 LangChain `tool()` 双向互通（`tools/langchain-bridge.ts`）；MCP 先按规范自实现 stdio 客户端（`tools/mcp/client.ts`，零依赖），随后接入官方 `@langchain/mcp-adapters@1.0.1` 的 `MultiServerMCPClient`（`tools/mcp/sdk-toolkit.ts`）作为默认连接层，自实现保留为 `transport: builtin` 兜底、`auto` 自动回落。配套真实素材库 server（`tools/mcp/servers/assets-server.mjs`，暴露项目内真实文件、带路径穿越与敏感文件拦截）。大纲节点把 MCP 工具注册进同一个 ToolRegistry，模型可自主调用；`ToolLoop × MCP` 集成测试用预设 tool_calls 验证了「模型决策 → 远端工具执行 → 结果回填 → 继续生成」的完整链路（含对真实目录内容的断言）。换层时发现官方 SDK 会把工具级 `isError` 包成异常、破坏「错误回填给模型」的契约，适配层已还原。见 §MODIFICATIONS P1-3 一节。

- **动机**：工具层已有但只覆盖大纲节点（`tools/registry.ts`、`loop.ts`、`outline-tools.ts`），且是自研 JSON Schema 协议；`base.ts:22-47` 的硬编码 `AgentContext` 仍在。MCP 是热词，也是六大考点里最明确的一条短板。
- **动作**：把 `ToolRegistry` 对齐 LangChain `tool()` 协议，把 `saveOutline` 等硬编码方法迁成注册工具；接 `@langchain/mcp-adapters` 挂一个真实外部 server（如文件系统或素材库），`registry.ts:9-10` 的注释就能兑现。**注**：`2.x` 要求 core ^1.2.6 / langgraph ^1.4.18，与本项目 1.1.48 / 1.3.2 冲突，故钉死 `1.0.1`（peer `^1.0.0`）。
- **验收**：至少一个 Agent 通过 MCP 工具完成一次真实调用；工具清单可枚举。
- **落地点**：`agent/src/tools/*`、`agents/base.ts`、`package.json`。
- **提醒**：别为凑热词挂一堆没用的 server，一个真实调用胜过五个空壳。

### P1-4 收尾并发上下文治理

> **状态：已完成（2026-11-24）**。删除 `_nodeCtx` 全局兜底与 `setNodeContext` / `clearNodeContext`，`getNodeCtx()` 只从 ALS 取、取不到直接抛 `[agent:ctx] 图节点拿不到 AgentContext`；mock context 只留在测试文件里。新增 4 个用例：缺失上下文显式报错 ×2、8 个 job 并发不串号、单 job 缺上下文不影响其它 job。同时确认 `graph.test.ts` 里 ALS 能穿透 LangGraph 内部异步边界（原来靠 `try/catch` 吞异常，实际从未验证过）。

- **动机**：`agent.processor.ts:18` BullMQ `concurrency: 8`，但 `:51` 每个 job 新建进程内 `MemorySaver`，`nodes/index.ts:49,67-89` 还留着全局 `_nodeCtx` 兜底 + 取不到上下文就返回 `"{}"` 的 mock 静默降级 —— 并发下理论上会串号或静默产出空结果。已有幂等控制（`agent.service.ts:128-130` jobId、`:212-226` 同项目取消旧 run），别重复造。
- **动作**：删 `_nodeCtx` 兜底，ALS 取不到直接抛错；mock context 只保留在测试里；配合 P1-1 的持久化 checkpointer 说明并发模型。
- **验收**：两个项目并发生成互不干扰；缺失上下文时明确报错而非静默 `"{}"`。
- **落地点**：`agent/src/nodes/index.ts`、`agent.processor.ts`。

### P1-5 补前端组件测试

- **现状**：全仓 149 个用例里 **frontend 只有 1 个文件 / 4 个用例**（`frontend/src/__tests__/stores.test.tsx`），无组件、无页面测试；而前端恰好是你出身方向，被问「测试怎么做」时答不上来会可惜。
- **动作**：给 `ConsistencyPanel`、`NodeDetail`、`useWebSocket` 的关键分支补 6–10 个 Testing Library 用例（drift 红点、按钮触发修正、WS 事件更新 store）。
- **验收**：`pnpm test` 前端用例数从 4 升到 10+。
- **落地点**：`frontend/src/__tests__/`。

---

## 4. P2 · 技术深度（有余力再说，每项 1–2 晚）

| 项 | 动机 | 落地点 | 验收 |
| --- | --- | --- | --- |
| **多模态 Critic** | `prompts/critic.ts:1-15` 的 `CRITIC_SYSTEM_PROMPT`（图像四维 rubric）定义了却从未调用；让模型直接看镜头图打分，并与 face-api 数值结果合并成一条质量结论 | `agents/critic.ts`、`server/src/services/image.service.ts` | 分镜图能产出评分，与一致性结果汇入同一报告 |
| **provider 选路 / 降级** | 目前只有「同一 URL 重试」，无成功率/延迟/成本驱动的切换（旧计划第 6 条未实现） | `config/app.config.ts`、`services/{text,video}.service.ts` | 主 provider 连续失败时自动切备用并记日志 |
| **多轮记忆** | `messages` 只被拼成 contextBlock，仍是单轮 `[system,user]`；补滚动摘要 + token 预算装配 + 反馈意图分类 | `agent-run-state.ts`、`services/text.service.ts` | 长会话下反馈能跨 5 轮保持连贯，且 prompt 不超预算 |
| **字幕烧录** | 成片字幕仍是外挂 `final.srt`（`video.service.ts:195-196`），无 `subtitles`/`libass` 滤镜 | `services/video.service.ts` | 输出内嵌中文字幕的 mp4（需处理容器字体） |
| **i2i 自动修正 + 视频联动** | 目前手动触发（`projects.controller.ts:193-200`），且重画会清空 `videoUrl`（`shot-repair.service.ts:78`）需手动重合成 | `agent.processor.ts` 自动校验后、`shot-repair.service.ts` | drift 经确认后自动重画并重合成该镜视频 |
| **WS 事件版本与去重** | `ws.gateway.ts:37-45` 直接 `emit`，29 类事件无版本/事件 ID/去重，前端靠 `socket.off` 防重复注册 | `ws.gateway.ts`、`shared/src/constants/events.ts` | 重连后不重复应用同一事件 |
| **face-api 注释与实现对齐** | `face.service.ts:11-16` 注释仍写「显式切到 cpu 最稳」，实现已是优先 wasm、失败回退 cpu | `face.service.ts` | 注释与实现一致 |

---

## 5. 明确不建议做（避免过度工程）

- **分布式锁 / 多租户 / K8s / 服务拆分**：原型定位，会稀释「全栈 TS + Agent 工程化」这条主线，且没人会问。
- **重写成 Python**：会毁掉「前端转 Agent、全栈 TypeScript」的叙事一致性，也是你相对其他候选人的差异化。
- **把 i2i 改成全自动**：一致性判定有波动，自动重画会静默消耗生成额度；保留人工确认反而是可讲的产品判断。
- **继续加新页面 / 新模块**：功能边际收益已经很低，时间投到 P1 的「把已有能力坐实」上回报更高。
- **为凑简历补一堆空壳 MCP server / 新 Agent 类**：面试一追问就露馅，不如一个真实调用。

---

## 6. 与简历的联动

| 做完哪项 | `RESUME.md` 里可以升级什么 |
| --- | --- |
| P0-4 CI | 版本 C 第 6 条加「CI 保障 149 个测试」，从「本地跑过」升级为「持续保障」 |
| P1-1 checkpoint | 版本 B 第 2 条加「checkpoint 落 PostgreSQL，进程重启后从原节点恢复」；§7 删掉「checkpoint 非持久」这条红线 |
| P1-2 critique_result | 版本 B 第 1 条、版本 E 第 2 条可写「评审结果经 WS 实时可视化」，LLM-as-Judge 可现场演示 |
| P1-3 MCP | 版本 E 新增一条「接入 MCP 工具协议」；`INTERVIEW_GUIDE.md` 六大考点表里「工具调用」从「弱」升为「扎实」 |
| P1-5 前端测试 | 版本 D 可加「前端关键交互 10+ 组件测试」 |
| P2 多模态 Critic | 版本 E 第 2 条升级为「文本 + 图像双通道评估」 |

> P1-1 与 P1-2 都已完成，`INTERVIEW_GUIDE.md` §3 的建议可以从「挑三项讲扎实」改成「挑四项讲扎实」——Monitor 闭环那条短板（`critique_result` 只定义不 emit）已经补掉了。

---

## 7. 落地顺序（一句话）

**先花 1–2 晚一次性清完 P0（安全、配置、卫生、CI）→ 再做 P1-1 checkpoint 与 P1-2 critique_result（这两项直接把最大技术债变成简历亮点）→ 按面试反馈决定要不要补 MCP / 多模态 Critic。**

不要按 `multi-agent-upgrade-plan.md` 的旧顺序从头做：那份计划的九条差距现在只剩两条完全未实现，照着走会重复劳动。
