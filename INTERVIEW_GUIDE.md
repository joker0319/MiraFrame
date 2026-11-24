# MiraFrame 面试叙事指南

> 数据截至 2026-11-24，代码基线 commit `82ae3d4`（共 42 个提交）。
> 用法：先看「30 秒版本」建立总纲，再挑 2–3 个 STAR 案例深讲，最后用「诚实边界」主动交代局限。
> 配套：[README.md](./README.md)（项目是什么）、[RESUME.md](./RESUME.md)（简历怎么写）、[ROADMAP.md](./ROADMAP.md)（后续优化）、[MODIFICATIONS.md](./MODIFICATIONS.md)（改动流水账）。

---

## 0. 三档讲法

### 30 秒版本

> MiraFrame 是一个全 TypeScript 的 AI 漫剧生成工作台。我接手时它是一个固定阶段的生成流水线，改造后变成「workflow 骨架 + 模型决策节点」的混合架构：Director Agent 决定这轮走哪些阶段，Critic Agent 用 LLM-as-Judge 给分镜打分、不合格就带意见打回重写，四个关键节点用 `interrupt` 做人工确认。外部模型限流、掉线、返回坏 JSON 都有降级路径，不会让整条流水线崩掉。最后我加了人脸一致性闭环：自动校验、漂移告警、再用参考图走图生图反哺修正。全项目 pnpm monorepo，前后端共享 Zod Schema 和 WS 事件类型。

### 3 分钟版本

按「决策 → 执行 → 保障」三层讲：

1. **决策层**：Director 用 LLM 产出 `executionPlan`，但阶段走白名单 + 必需阶段约束，模型只能在一定范围内裁量；Critic 按四维 rubric 给分，不通过就把 issues/suggestions 写回 `feedback`，PlanAgent 下一轮直接消费；ReviewAgent 在用户反馈后决定回流到哪个阶段。
2. **执行层**：LangGraph 状态图串起 6 个生产节点和 4 个人工门；门的等待位置落到 DB 的 `awaitingGate`，靠 Redis 的 confirm 消息恢复；续跑用 `target_stage` 从指定阶段切入，已完成素材不重生成。
3. **保障层**：文本 429 用进程级串行队列 + `Retry-After` + 指数退避；视频 503/`queue_full` 分类重试、封顶 120 秒；一致性用 face-api wasm（9 张图 1.8 秒，比 cpu 快约 23 倍）+ 贪心指派避免多角色抢脸；漂移镜头可用角色参考图走 i2i 反哺。前端通过 29 类 WS 事件实时看到进度、门、产物和告警。

### 结果数据（可引用）

- 后端最近一次验证 **72 个测试全过**，全仓 `pnpm build` / `pnpm typecheck` 通过；源码中 **220 个测试用例**分布在四个包（含 P0 加固 18 个、并发上下文隔离 4 个、工具层与 MCP 30 个）。
- 项目共 **42 个提交**（含文档提交）；一致性相关三次提交 `dfbfcb0 → c5fc8f7 → 7037473` 对应「检测 → 自动接入流水线 → 反哺修正」三步演进。
- 真实运行：project-23 **6 镜头 / 3 角色**，一致性端到端 **1.85 秒**；续跑 run 51 结果 `ok=2 review=4 drift=0`。
- i2i 反哺对照：沈鸢人脸距离从灰区约 **0.4 → 0.22**；临时项目端到端实测 **0.2562，判定 ok**。
- 视频 503 场景：6 镜头项目原本只有 4 个出片，按 `target_stage=render_shot_images` 续跑后补齐，成片 **4.4MB**。

---

## 1. 主线故事：我改造的不是功能，是「可控性」

**情境**：项目原本能把小说想法变成漫剧，但它是固定流水线——短片也得走满所有阶段，分镜质量没人负责，Kimi 一限流就整批失败，第 5、6 镜头视频失败就得从头重跑。

**我做的判断**：问题不在「少一个功能」，而在三个缺失——**决策不可解释**、**产物无评估**、**失败无恢复**。所以改造分三层：

| 层 | 缺什么 | 加了什么 | 代码落点 |
| --- | --- | --- | --- |
| 决策 | 流程写死 | Director 规划阶段 + Critic 打分打回 + Review 决定回流 | `packages/agent/src/agents/{director,critic,review}.ts` |
| 执行 | 人工门只存在于前端 | 4 个 `interrupt` 门 + DB 记住等待位置 + `target_stage` 续跑 | `packages/agent/src/nodes/index.ts:173,189,203,216` |
| 保障 | 供应商一抽风就全崩 | 429/503 分类重试 + 增量标脏 + 一致性闭环 | `packages/server/src/services/{text,video,consistency,shot-repair}.service.ts` |

**一句话总结**：把「跑完就结束的脚本」改造成「能解释自己为什么这么走、走错了能退回来、外部依赖挂了能自己扛住」的 Agent 系统。

---

## 2. 五个 STAR 案例

### 案例 1：让模型决定流程，但不让模型乱来（Director）

**S** 固定流水线对所有题材一视同仁：4 镜头的短片也要走满 6 个阶段，既慢又没法解释「为什么这步要跑」。

**T** 让模型根据题材和反馈决定阶段，同时保证关键阶段不被跳过。

**A**
- `packages/agent/src/agents/director.ts:9-20` 定义 `ALLOWED_STAGES` 白名单；`:23-30` 定义全链路兜底。
- `:38-48` 从模型回复里抠 JSON，兼容 ```json 围栏和前后废话；`:58-82` 做规范化：白名单过滤、去重、必需的 `plan_outline / critique_shots / render_shot_images / compose_videos` 保底、再按默认顺序重排。
- `:99-137` 调用 LLM（intent `director-plan`，maxTokens 1024），产出 `executionPlan` 和 `planRationale`；模型失败或格式坏就 `defaultPlan()`（`:118-121`）。
- 反馈场景下重新规划用另一套 prompt（`packages/agent/src/prompts/director.ts:28-40`）。

**R** 模型有裁量权（比如短篇可跳过角色阶段），但产出一定落在白名单和必需阶段约束内；`planRationale` 让「为什么跳过」可回溯。

**可能被追问**：模型给了非法阶段怎么办？→ 白名单过滤 + 必需阶段补齐 + 顺序重排，模型只决定「裁剪哪些可选阶段」。

---

### 案例 2：LLM-as-Judge 不是打完分就结束（Critic）

**S** 早期的 Critic 是桩，分数硬编码，永远通过——质量闭环等于不存在。

**T** 做一个真能打回重写的评审，同时不能因为模型抽风卡死流程。

**A**
- `packages/agent/src/prompts/critic.ts:21-40`：四维 rubric（叙事、连贯性、镜头语言、可生成性），1–10 分，要求只返回 JSON，并给出「8+ 可发布 / 6–7 小修 / ≤5 重写」的评分指引。
- `packages/agent/src/agents/critic.ts:21-35`：解析 JSON，兼容围栏、截取首尾 `{}`、字段缺失兜底；`:87-91` 调模型。
- `:9-10` 阈值与轮次可配（`CRITIC_SCORE_THRESHOLD`、`CRITIC_MAX_ROUNDS`）；`:107` 通过条件是「达标 **或** 到轮次上限」，避免死循环。原先 `.env` 里的 `CRITIQUE_*` 是另一套无人消费的前缀，P0 已统一为 `CRITIC_*`（当前 `6.0` / `2`），并由 `config/startup-check.ts` 在启动期校验取值是否合法。
- `:124-134` 是关键：不通过时 `nextStage = plan_shots`，并把 issues/suggestions 拼成 `feedback` 回灌；`packages/agent/src/agents/plan.ts:71-81` 在下一轮生成时直接消费这个字段。
- `:93-104` 模型调用失败或 JSON 坏了，降级为人工审批，不阻断主流程。
- `:124-152`（P1-2）：评审结论不只写进 state，还经 `AgentContext.reportCritique` 上报，转成 WS `critique_result` 推给前端——分数、阈值、第几轮、四维得分、问题与建议都会实时出现在分镜节点的评分卡片上。「打分」这件事从后台字段变成了屏幕上看得见的东西。

**R** 形成了「生成 → 评估 → 带意见重写 → 再评估」的闭环，且有轮次上限和人工兜底；评审过程对用户可见、可回溯（消息流留文本，卡片留结构）。

**可能被追问**：Evaluator 自己判错了怎么办？→ 两道保险：轮次上限防止来回拉扯，人工审批门作为最终兜底。

---

### 案例 3：人工确认不是前端弹窗，是可恢复的状态机（HITL）

**S** 大纲、角色、分镜、镜头图四个节点需要人拍板，但生成任务跑在后台 worker 里，页面刷新或进程重启后不知道「该等谁确认」。

**T** 让门的位置和执行状态可持久化、可恢复。

**A**
- `packages/agent/src/nodes/index.ts:173,189,203,216` 四个 `interrupt()` 门；`START → director → 生产节点 → 审批 → review` 的条件边在 `packages/agent/src/graph.ts:28-84`。
- 执行器捕获 interrupt 后把门名写进 `agentRuns.awaitingGate`（`packages/server/src/agent/agent.processor.ts:621-633`，字段定义 `packages/server/src/db/schema.ts:154`）；确认后清 gate（`:685-688`）；30 分钟超时自动取消（`:663-664`）。
- 前端通过 WS 的 `run_awaiting_confirm` 恢复按钮状态，确认走 Redis 消息（`packages/server/src/modules/generation/generation.controller.ts:64-84`）。
- 续跑入口：`revision.service.ts:25-35` 把反馈类型映射成 `target_stage`，`agent-run-state.ts:108-115` 把它注入初始 state，`nodes/index.ts:96-99` 让指定阶段不再重新规划；历史门自动置 approved（`agent-run-state.ts:138-155`）。

**R** 刷新页面能从 DB 恢复等待状态；补第 5、6 镜头时只重跑渲染阶段，不用重跑文本和图片。

**可能被追问**：checkpoint 存在哪？→ PostgreSQL。`agent/src/checkpointer.ts` 用 `PostgresSaver.fromConnString()` + `setup()` 幂等建表，`thread_id = thread-{projectId}-{runId}`；进程重启后未完成的 BullMQ job 被重新拾起，图从最后完成的节点继续。只有单测或无数据库场景才退回 `MemorySaver`。

---

### 案例 4：真实供应商的失败恢复（429 / 503 / 增量）

**S** 换过 Kimi、百炼、Agnes 三家供应商，各自有坑：Kimi 429 且账号并发只有 1、RPM 3；Agnes 免费视频队列满会返回 503 `video_queue_full`；早期一次探测误用了付费模型，烧了约 ¥17–27。

**T** 不靠「手动重试」，把供应商差异收敛到配置层和服务层。

**A**
- 文本：`packages/server/src/services/text.service.ts:9` 进程级静态串行队列，`:211-224` 排队；`:226-259` 重试；`:262-284` 优先读 `Retry-After`，其次读错误文本里的秒数，最后指数退避 `base × 2^attempt` + 抖动。429 耗尽抛明确错误（`:186-188`），不再误判为「模型不支持 tools」。
- 视频：`packages/server/src/services/video.service.ts:420-444` 把 503/429/502/504 和 `queue_full|队列已满|rate limit|busy` 归为可重试，退避 `min(base × 2^n, 120s)`；当前 `.env` 是 `VIDEO_MAX_RETRIES=8`、`VIDEO_RETRY_BASE_MS=8000`。
- 增量：`packages/server/src/agent/revision.service.ts:43-107` 用持久化的 `shots.characterIds` 做血缘分析，只把受影响镜头的 `imageUrl/videoUrl/consistencyResult` 置空，其余复用。
- 成本教训沉淀为规则：探测只读、最小单任务、模型全部配置化（`packages/server/src/config/app.config.ts:56-99`）。

**R** 6 镜头项目原本只有 4 个出视频，日志出现 `HTTP 503，9s 后重试 (1/8)`，续跑后补齐，成片 4.4MB；文本侧把 reasoning token 从约 2500 压到约 27。

**可能被追问**：为什么不直接换付费模型？→ 免费额度够用，且成本不确定是原型阶段最大的风险；把 provider 做成配置后，切换只需改环境变量。

---

### 案例 5：一致性闭环——检测到反哺（face-api + i2i）

**S** 同一个角色在不同镜头里长相漂移，但分镜提示词写满「鹅蛋脸、低髻、木簪」也没用，模型不会稳定遵循。

**T** 先能自动发现漂移，再能自动修正。

**A** 三步走，对应三次提交：
1. **检测**（`dfbfcb0`）：`packages/server/src/services/face.service.ts:52-69` 正确初始化 wasm（`setWasmPaths → setBackend("wasm") → ready()`，失败回退 cpu）+ `:32-37` monkeyPatch 补 Node 缺失的 DOM 类；`:88-126` 输出 128 维 descriptor。性能：9 张图从 **41 秒降到 1.8 秒，约 23 倍**。
2. **判定 + 自动接入**（`c5fc8f7`）：`consistency.ts:126-161` 用「全局最近优先的贪心指派」处理多角色同框，一张脸只归一个角色；阈值 0.45 / 0.6（`:38-42`）；参考图检不出脸标 `no_reference`，不算失败。`agent.processor.ts:502-504` 把校验挂在 `generateShotFrames()` 末尾，模型或下载失败只 warn、不阻断流水线；结果写回 `shot.consistency_result`，节点卡对 `drift` 亮红点。
3. **反哺**（`7037473`）：`packages/server/src/services/shot-repair.service.ts:29-98` 取绑定角色的参考图（每角色 3 张、全镜 4 张），拼「第 N 张是某某、保留原分镜、不要加角色」的提示词（`buildRepairPrompt()` `:105-115`），走 Agnes i2i 重画；`packages/server/src/services/image.service.ts` 的 `buildAgnesImageBody()` 把参考图放进 `extra_body.image`（`response_format` 也必须在 `extra_body`，放顶层会报错），只重检这一张。

**R** project-23 端到端 1.85 秒；沈鸢在 4 个镜头 0.36–0.41、2 个镜头 0.46，i2i 对照后降到 0.22；临时项目端到端跑通 0.2562 / `ok`，并广播 `shot_updated`。

**可能被追问**：为什么不用多模态 LLM 直接判一致性？→ face-api 给的是可复现的数值距离和阈值，适合做门限和回归；LLM 判断难量化。Agent 的评估角色交给 Critic 审文本，人脸这种几何特征交给专用模型，各自做擅长的事。

---

## 3. 对齐「Agent 六大考点」

| 考点 | MiraFrame 里对应什么 | 能讲到什么深度 | 要主动说的边界 |
| --- | --- | --- | --- |
| 意图识别 | Director 把题材 + 用户反馈转成 `executionPlan`（`director.ts:99-137`） | 任务意图 → 受约束的执行计划，带 `planRationale` 可解释 | 没有独立的「用户意图分类器」，是规划而非分类 |
| 工具调用 | `ToolRegistry` + `ToolLoop` 模型自主选工具；`tools/langchain-bridge.ts` 与 LangChain `tool()` 双向互通；`tools/mcp/` 按 MCP 规范自实现 stdio 客户端，挂真实素材库 server | 能讲清「工具描述 → 模型决策 → 执行 → 结果回填」闭环，以及本地工具与远端 MCP 工具如何统一 | MCP 客户端是自实现而非官方 SDK；目前只有大纲节点挂了远端工具 |
| 多轮记忆 | `messages` 表 + Critic 的 `feedback` 跨轮回灌（`plan.ts:71-81`） | 反馈能改变下一轮生成，不是单轮问答 | 图 checkpoint 已落 PostgreSQL；`messages` 仍是拼接式上下文，不做滚动摘要 |
| 多 Agent 路由 | Director 规划 + Review 的 `FALLBACK_ROUTE`（`review.ts:9-14,80-82`） | 模型决定路由，失败有白名单兜底 | 节点是类，不是独立进程/服务 |
| Monitor 闭环 | 29 类 WS 事件（`packages/shared/src/constants/events.ts`）+ `run_*` 事件 + `critique_result` 评分实时下发 + 评分写 state | 进度、门、产物、告警、评分前端实时可见 | 事件是进程内广播，没有做多实例的 Redis adapter |
| LLM-as-Judge | Critic 四维 rubric + 阈值 + 轮次上限 + 人工兜底 | 真打分、真打回、真回灌 | 只审分镜文本，没审图片/视频 |

> 讲法建议：这六项不要都说成「已完整实现」。挑 **多 Agent 路由 + LLM-as-Judge + Monitor 闭环** 三项讲扎实，其余两项坦诚说「这是下一步要补的」，反而更可信。

---

## 4. 高频问答

**Q1：为什么用 LangGraph 而不是自己写状态机？**
状态图把节点、条件边、中断点显式化，审批门用 `interrupt` 表达，恢复靠 `thread_id` + resume 值，比手写 if/else 的状态机容易验证；测试里对 14 个节点（含 start/end）做了结构断言（`graph.test.ts:56-86`）。

**Q2：让模型决定跳过阶段，不怕不稳定吗？**
怕，所以模型只有「裁剪可选阶段」的裁量权：`ALLOWED_STAGES` 白名单、四个必需阶段不可跳过、输出按默认顺序重排、格式坏就回退全链路。这是典型的「LLM 决策 + 确定性约束」。

**Q3：Human-in-the-Loop 具体怎么落地？**
四个 `interrupt` 门；执行器把门名落到 `agentRuns.awaitingGate`，前端靠 WS 恢复确认按钮，用户确认后通过 Redis 消息恢复图；历史门在续跑时自动置 approved。

**Q4：断点恢复是真的持久化吗？**
产物、run 状态、门位置、图的 checkpoint 都在 PostgreSQL。进程重启后 BullMQ 重新拾起未完成的 job，同 `thread_id` 的 checkpoint 已存在，图从最后完成的节点继续；只有超过 30 分钟的残留 run 会被启动清理标记为 cancelled。

**Q5：外部模型限流怎么处理？**
文本 429：串行队列 + `Retry-After` + 指数退避；视频 503：可重试错误分类 + 退避封顶 120 秒；两者都有次数上限，耗尽后抛明确错误并保留已完成素材，配合 `target_stage` 续跑。

**Q6：怎么评估生成质量？**
分两层：文本层用 Critic LLM-as-Judge 打分并打回重写（有 rubric、阈值、轮次上限）；视觉层用 face-api 数值距离判角色一致性，漂移可再用参考图 i2i 修正。两层都不是「人肉看一眼」。

**Q7：一致性为什么不用纯 LLM？**
人脸距效果需要可复现的量化门限，face-api 给 128 维向量和欧氏距离，能设定 0.45/0.6 阈值并做回归；LLM 更适合审叙事和镜头语言。职责分开。

**Q8：你前端出身，在这项目里具体写了什么？**
全栈 TS：前端纸墨设计系统（语义 token + reduced-motion + 双主题）、工作台与一致性面板；后端 NestJS 服务（TTS 混流、face-api 初始化、i2i 反哺）；Agent 层的状态契约和 WS 事件类型也参与对齐。分工上重点在「把工程化保障做实」。

**Q9：和你的 EchoMind 项目是什么关系？**
EchoMind 是智能客服场景的六大考点练习，MiraFrame 是把同一套 Agent 工程能力迁移到内容生成场景：LLM-as-Judge、多 Agent 路由、Monitor 闭环是共通的；MCP 在 MiraFrame 里用真实素材库 server 落了地（自实现 stdio 客户端，零新增依赖），多轮记忆仍是拼接式上下文，是明确的下一步。

**Q10：最大的技术债是什么？**
`critique_result` 事件**已补齐**（P1-2：Critic 每轮评审后经 WS 下发评分、阈值、轮次与打回原因，前端节点详情渲染评分卡片）；`_nodeCtx` 全局兜底**已删除**（P1-4：节点上下文只走 ALS，取不到直接报错）。剩余技术债是字幕外挂 SRT 没烧进画面、i2i 修正目前是手动触发、`messages` 仍是拼接式上下文没有滚动摘要、WS 是进程内广播没接 Redis adapter。DOUBAO 配置、宇宙页面残留、无鉴权配置接口、进程内 checkpointer 等已在 P0/P1-1 中清理完毕。这些都不影响主线演示，但面试被问到要承认。

**Q11：BullMQ 并发 8，怎么保证项目之间不串号？**
上下文不走模块级全局变量，只走 `AsyncLocalStorage`：processor 用 `runWithNodeContext(ctx, () => compiled.invoke(...))` 把每个 job 的 ctx 绑定在自己的异步链上，节点里 `getNodeCtx()` 只从 ALS 取。早先这里有个 `_nodeCtx` 全局兜底 + 取不到就返回 mock（`callLlm` 吐 `"{}"`），并发下会串号、且静默产出空结果还显示成功——现在取不到直接抛 `[agent:ctx] 图节点拿不到 AgentContext`。模块级共享的只有两类东西：Agent 实例（只持有 `readonly name`，无状态）和 checkpointer 单例（内部是 pg 连接池，本来就该复用，不持有项目上下文）。测试用 8 个不同 `projectId` 并发跑 Critic 节点、故意错开 LLM 延迟，断言每份回报的 issues/suggestions 都来自它自己的 job。

**Q12：MCP 你是怎么接的？为什么不用官方 SDK？**

MCP 的 stdio 传输本身很小：stdin/stdout 每行一个 JSON-RPC 2.0 消息，握手是 `initialize` → 收 result → 发 `notifications/initialized`，然后 `tools/list` 拿清单、`tools/call` 执行，结果在 `result.content[]` 里。我把它实现成一个 200 行的客户端（`tools/mcp/client.ts`）：请求 id 递增配对、超时、子进程退出时把所有 pending 拒绝掉、stdout 混入非协议内容时记进诊断而不是崩掉。

不引官方 SDK 的理由有三条：项目已有 `ToolRegistry`，只差「远端描述符 → `AgentTool`」这一层薄适配；协议面小，自己实现能把超时/降级语义控制成我要的样子；少一个重依赖，冷启动和排查都更简单。

配套的 server 是真实可跑的（`servers/assets-server.mjs`，零依赖），暴露项目内的文件系统，做了路径穿越校验和敏感文件拦截。验收方式是集成测试真的 spawn 子进程走完整往返：`initialize` → `tools/list` → `tools/call` 读到真实目录内容 → 越界路径被拒。

最强的一条证据是 `mcp-tool-loop.test.ts`：模型（预设 tool_calls）先调 `list_project_assets` 查 docs 目录，结果回填进下一轮上下文，再调本地工具写草稿、落库。断言里直接检查了「模型第二轮的上下文里出现了 `architecture-walkthrough.md`」——证明工具结果真的回到了模型，而不是调完就丢。

工程细节上还有两点值得说：一是 MCP 是**可选增强**，`createAssetsToolKit()` 拉不起进程就返回 null，节点照常跑；二是构建时有个坑——tsup 是 bundle 模式，`.mjs` 子进程脚本不会进 dist，而生产镜像是「只拷 dist」的，所以加了一个 `scripts/copy-mcp-servers.mjs` 把它复制进去，否则 `node dist` 形态下 MCP 永远降级。

---

## 5. 诚实边界（主动交代比被问出来强）

- **checkpoint（P1-1 已修）**：`packages/agent/src/checkpointer.ts` 的 `createCheckpointer(connectionString)` 返回 `PostgresSaver` 并幂等建表，`agent.processor.ts` 用 `app.databaseUrl` 构造；无连接串时才退回 `MemorySaver`（单测路径）。
- **`critique_result` 事件（P1-2 已修）**：`AgentContext.reportCritique` 由 `CriticAgent` 每轮评审后调用，`agent.processor.ts` 转成 snake_case 载荷经 WS 下发；前端 `critiqueStore` 收下后渲染评分卡片（总分/阈值/轮次/维度/问题/建议），消息流也留一条文本便于回溯。
- **MCP（P1-3 已接）**：`tools/mcp/client.ts` 按 MCP 规范（JSON-RPC 2.0 over stdio）自实现客户端，`servers/assets-server.mjs` 是配套的真实素材库 server，暴露项目内真实文件并拦截路径穿越与 `.env`/密钥类文件。**不用官方 `@langchain/mcp-adapters`** 是刻意取舍：只需要「远端工具 → AgentTool」这层薄适配，协议面本身很小，少一个重依赖。目前只有大纲节点挂了远端工具，且 MCP 是可选增强——拉起失败自动降级，主流程不受影响。
- **`CRITIC_SYSTEM_PROMPT`**（图像四维 rubric）定义了但 CriticAgent 没调用，当前只审分镜文本。
- **残留（P0 已清理）**：`DOUBAO_*` 配置与 `app.config.ts` 里的兜底字段、`UniversesPage.tsx` / `UniverseDetailPage.tsx` / `universesApi.ts` 均已删除；宇宙路由保留重定向以免旧链接 404。`config/` 接口已加 `ADMIN_TOKEN` 守卫，CORS 收紧为白名单，明文 `reveal` 接口移除。
- **face-api 局限**：半透明、背影、非人形参考图检不出脸，标 `no_reference`，不误判但也无法校验。
- **i2i 修正**：手动触发，且会清空该镜视频，需要重新合成才会更新成片。
- **成片字幕**：外挂 `final.srt`，没有烧录进画面。

---

## 6. 代码地图（按讲题定位）

| 主题 | 文件 |
| --- | --- |
| 状态图与节点 | `packages/agent/src/graph.ts`、`nodes/index.ts`、`state.ts` |
| Director / Critic / Review | `packages/agent/src/agents/{director,critic,review}.ts`、`prompts/{director,critic}.ts` |
| 执行器与门持久化 | `packages/server/src/agent/agent.processor.ts`、`agent-run-state.ts` |
| 增量与续跑 | `packages/server/src/agent/revision.service.ts`、`services/lineage.ts` |
| Provider 与失败恢复 | `packages/server/src/services/{text,video,image,tts}.service.ts`、`config/app.config.ts` |
| 一致性闭环 | `packages/server/src/services/{face,consistency,consistency.service,shot-repair}.service.ts`、`agent/agent.processor.ts:753-802` |
| 前后端契约 | `packages/shared/src/types/*`、`constants/{events,stages,approval}.ts` |
| 前端工作台 | `packages/frontend/src/pages/ProjectPage.tsx`、`components/project/*`、`hooks/useWebSocket.ts` |
| 改动时间线 | `MODIFICATIONS.md` |
