# MiraFrame 面试叙事指南

> 数据截至 2026-11-25，代码基线 commit `104e93e`（共 68 个提交）。
> 用法：先看「30 秒版本」建立总纲，再挑 2–3 个 STAR 案例深讲，最后用「诚实边界」主动交代局限。
> 配套：[README.md](./README.md)（项目是什么）、[RESUME.md](./RESUME.md)（简历怎么写）、[ROADMAP.md](./ROADMAP.md)（后续优化）、[MODIFICATIONS.md](./MODIFICATIONS.md)（改动流水账）。
> 脱稿速记：[docs/INTERVIEW_CHEATSHEET.md](./docs/INTERVIEW_CHEATSHEET.md)（每题一句话锚点 + 关键词，重点四题附展开层次）。

---

## 0. 三档讲法

### 30 秒版本

> MiraFrame 是一个全 TypeScript 的 AI 漫剧生成工作台。我接手时它是一个固定阶段的生成流水线，改造后变成「workflow 骨架 + 模型决策节点」的混合架构：Director Agent 决定这轮走哪些阶段，Critic Agent 用 LLM-as-Judge 给分镜打分、不合格就带意见打回重写，四个关键节点用 `interrupt` 做人工确认。外部模型限流、掉线、返回坏 JSON 都有降级路径，不会让整条流水线崩掉。最后我加了人脸一致性闭环：自动校验、漂移告警、再用参考图走图生图反哺修正。全项目 pnpm monorepo，前后端共享 Zod Schema 和 WS 事件类型。

### 3 分钟版本

按「决策 → 执行 → 保障」三层讲：

1. **决策层**：Director 用 LLM 产出 `executionPlan`，但阶段走白名单 + 必需阶段约束，模型只能在一定范围内裁量；Critic 按四维 rubric 给分，不通过就把 issues/suggestions 写回 `feedback`，PlanAgent 下一轮直接消费；ReviewAgent 在用户反馈后决定回流到哪个阶段。
2. **执行层**：LangGraph 状态图串起 6 个生产节点和 4 个人工门；门的等待位置落到 DB 的 `awaitingGate`，靠 Redis 的 confirm 消息恢复；续跑用 `target_stage` 从指定阶段切入，已完成素材不重生成。
3. **保障层**：文本 429 用进程级串行队列 + `Retry-After` + 指数退避；视频 503/`queue_full` 分类重试、封顶 120 秒；这些是「同一家内的重试」，再往上一层是候选链 + 熔断（连续失败切备用、指数冷却、half-open 探活），应对密钥失效/账号欠费这类重试救不回来的故障；一致性用 face-api wasm（9 张图 1.8 秒，比 cpu 快约 23 倍）+ 贪心指派避免多角色抢脸；漂移镜头自动按角色参考图走 i2i 重画并复检（有开关、有单轮预算、图像服务不可用时自动跳过）。前端通过 29 类 WS 事件实时看到进度、门、产物和告警。

### 结果数据（可引用）

- 后端最近一次验证 **221 个测试全过**，全仓 `pnpm build` / `pnpm typecheck` 通过；源码中 **443 个测试用例**分布在四个包（含 P0 加固 18 个、并发上下文隔离 4 个、工具层与 MCP 44 个、滚动摘要 30 个、provider 选路 34 个、i2i 自动修复 32 个、多模态 Critic 53 个、字幕叠加 25 个、WS 地址解析 4 个、前端组件与事件矩阵 24 个）。
- 项目共 **58 个提交**（含文档提交）；一致性相关三次提交 `dfbfcb0 → c5fc8f7 → 7037473` 对应「检测 → 自动接入流水线 → 反哺修正」三步演进。
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

### 案例 4：真实供应商的失败恢复（429 / 503 / 熔断降级 / 增量）

**S** 换过 Kimi、百炼、Agnes 三家供应商，各自有坑：Kimi 429 且账号并发只有 1、RPM 3；Agnes 免费视频队列满会返回 503 `video_queue_full`；早期一次探测误用了付费模型，烧了约 ¥17–27。更要命的是密钥过期/欠费这类故障，重试再多次也救不回来。

**T** 不靠「手动重试」，把供应商差异收敛到配置层和服务层，并区分「抖动」与「故障」。

**A**
- 文本重试：`text.service.ts` 的静态 `requestQueue` 串行化 + `fetchWithRetry`；`resolveRetryDelay` 优先读 `Retry-After`、其次读错误文本里的秒数、最后指数退避 `base × 2^attempt` + 抖动。429 耗尽抛明确错误，不误判为「模型不支持 tools」。
- 视频重试：`video.service.ts` 的 `generateAgnesVideo` 把 503/429/502/504 和 `queue_full|队列已满|rate limit|busy` 归为可重试，退避 `min(base × 2^n, 120s)`；当前 `.env` 是 `VIDEO_MAX_RETRIES=8`、`VIDEO_RETRY_BASE_MS=8000`。
- 跨 provider 降级：`services/provider-routing.ts` 解析 `TEXT_PROVIDERS=agnes,kimi` 候选链，连续失败 3 次熔断（指数冷却、half-open 探测），只对 401/403/429/5xx/网络错误切换、400 不切也不计熔断；text / image / video 三个服务都接入，`GET /api/v1/providers` 暴露各家的成功率、平均延迟与冷却状态。
- 增量：`packages/server/src/agent/revision.service.ts:43-107` 用持久化的 `shots.characterIds` 做血缘分析，只把受影响镜头的 `imageUrl/videoUrl/consistencyResult` 置空，其余复用。
- 成本教训沉淀为规则：探测只读、最小单任务、模型全部配置化（`packages/server/src/config/app.config.ts`）。

**R** 6 镜头项目原本只有 4 个出视频，日志出现 `HTTP 503，9s 后重试 (1/8)`，续跑后补齐，成片 4.4MB；文本侧把 reasoning token 从约 2500 压到约 27。降级链路用本地两个真实 HTTP server 验证：主返回 401、备返回 200，第 1–2 次调用切换成功，第 3 次触发熔断，第 4 次只打备用（`primary → backup → primary → backup → primary → backup → backup`）。

**可能被追问**：为什么不直接换付费模型？→ 免费额度够用，且成本不确定是原型阶段最大的风险；把 provider 做成配置后，切换只需改环境变量。那熔断会不会误伤？→ 400 类请求错误明确不切换也不计失败，且半开探测成功即恢复，冷却时长有上限。

---

### 案例 5：一致性闭环——检测到反哺（face-api + i2i）

**S** 同一个角色在不同镜头里长相漂移，但分镜提示词写满「鹅蛋脸、低髻、木簪」也没用，模型不会稳定遵循。

**T** 先能自动发现漂移，再能自动修正。

**A** 三步走，对应三次提交：
1. **检测**（`dfbfcb0`）：`packages/server/src/services/face.service.ts:52-69` 正确初始化 wasm（`setWasmPaths → setBackend("wasm") → ready()`，失败回退 cpu）+ `:32-37` monkeyPatch 补 Node 缺失的 DOM 类；`:88-126` 输出 128 维 descriptor。性能：9 张图从 **41 秒降到 1.8 秒，约 23 倍**。
2. **判定 + 自动接入**（`c5fc8f7`）：`consistency.ts:126-161` 用「全局最近优先的贪心指派」处理多角色同框，一张脸只归一个角色；阈值 0.45 / 0.6（`:38-42`）；参考图检不出脸标 `no_reference`，不算失败。`agent.processor.ts:502-504` 把校验挂在 `generateShotFrames()` 末尾，模型或下载失败只 warn、不阻断流水线；结果写回 `shot.consistency_result`，节点卡对 `drift` 亮红点。
3. **反哺**（`7037473`）：`packages/server/src/services/shot-repair.service.ts:29-98` 取绑定角色的参考图（每角色 3 张、全镜 4 张），拼「第 N 张是某某、保留原分镜、不要加角色」的提示词（`buildRepairPrompt()` `:105-115`），走 Agnes i2i 重画；`packages/server/src/services/image.service.ts` 的 `buildAgnesImageBody()` 把参考图放进 `extra_body.image`（`response_format` 也必须在 `extra_body`，放顶层会报错），只重检这一张。

**R** project-23 端到端 1.85 秒；沈鸢在 4 个镜头 0.36–0.41、2 个镜头 0.46，i2i 对照后降到 0.22；临时项目端到端跑通 0.2562 / `ok`，并广播 `shot_updated`。第三步原先是人点按钮，现在由 `autoRepairDriftedShots` 自动串联（见 Q15）。

**可能被追问**：为什么不用多模态 LLM 直接判一致性？→ face-api 给的是可复现的数值距离和阈值，适合做门限和回归；LLM 判断难量化。Agent 的评估角色交给 Critic 审文本，人脸这种几何特征交给专用模型，各自做擅长的事。

---

## 3. 对齐「Agent 六大考点」

| 考点 | MiraFrame 里对应什么 | 能讲到什么深度 | 要主动说的边界 |
| --- | --- | --- | --- |
| 意图识别 | Director 把题材 + 用户反馈转成 `executionPlan`（`director.ts:99-137`） | 任务意图 → 受约束的执行计划，带 `planRationale` 可解释 | 没有独立的「用户意图分类器」，是规划而非分类 |
| 工具调用 | `ToolRegistry` + `ToolLoop` 模型自主选工具；`tools/langchain-bridge.ts` 与 LangChain `tool()` 双向互通；`tools/mcp/` 主用官方 `@langchain/mcp-adapters`（1.0.1），并保留按 MCP 规范自实现的 stdio 客户端作兜底，两条连接层契约一致、可切换 | 能讲清「工具描述 → 模型决策 → 执行 → 结果回填」闭环，以及本地工具、远端 MCP 工具、官方 SDK 与自实现如何统一 | 目前只有大纲节点挂了远端工具；MCP 是可选增强 |
| 多轮记忆 | `messages` 表按轮分组注入 + **滚动摘要**（`conversation-memory.ts`：滑出窗口的旧轮次增量折叠成摘要，`coveredThroughId` 保证每轮只折一次）+ 图 checkpoint 落 PostgreSQL | 长会话不会因为截断丢掉早期偏好；摘要失败也不阻断生成 | 摘要仍是单次 LLM 压缩，没有做向量检索式长期记忆 |
| 多 Agent 路由 | Director 规划 + Review 的 `FALLBACK_ROUTE`（`review.ts:9-14,80-82`） | 模型决定路由，失败有白名单兜底 | 节点是类，不是独立进程/服务 |
| Monitor 闭环 | 29 类 WS 事件（`packages/shared/src/constants/events.ts`）+ `run_*` 事件 + `critique_result` 评分实时下发 + 评分写 state | 进度、门、产物、告警、评分前端实时可见 | 事件是进程内广播，没有做多实例的 Redis adapter |
| LLM-as-Judge | 两路 Critic：文本路审分镜（四维 rubric + 阈值 + 轮次上限 + 回灌重写）；视觉路审关键帧（多图批量、逐镜打分、结构性问题自动重画）。都有阈值、预算与人工兜底 | 真打分、真打回、真回灌；视觉路能看出画风跑偏、手指畸形、构图切头 | 视频还没审；视觉判定比数值阈值主观 |

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
两层。单 provider 内：文本 429 走串行队列 + `Retry-After` + 指数退避，视频 503 走可重试错误分类 + 退避封顶 120 秒，都有次数上限，耗尽后抛明确错误并保留已完成素材，配合 `target_stage` 续跑。跨 provider：重试耗尽后按候选链切下一家，并把连续失败的那家熔断一段时间，见 Q14。

**Q6：怎么评估生成质量？**
分三层，各管一件确定性不同的事：文本层用 Critic LLM-as-Judge 打分并打回重写（rubric、阈值、轮次上限）；几何层用 face-api 128 维向量距离判角色一致性（可复现的数值门限），漂移再按参考图 i2i 修正；画面层用视觉模型逐张看关键帧，管人脸比对看不见的问题——手指数量、肢体结构、画风跑偏、构图切头、乱码文字。三层都不是「人肉看一眼」，但可靠性反过来排：数值最硬，视觉模型最主观。

**Q7：一致性为什么不用纯 LLM？**
人脸距效果需要可复现的量化门限，face-api 给 128 维向量和欧氏距离，能设定 0.45/0.6 阈值并做回归；LLM 更适合审叙事和镜头语言。职责分开。

**Q8：你前端出身，在这项目里具体写了什么？**
全栈 TS：前端纸墨设计系统（语义 token + reduced-motion + 双主题）、工作台与一致性面板；后端 NestJS 服务（TTS 混流、face-api 初始化、i2i 反哺）；Agent 层的状态契约和 WS 事件类型也参与对齐。分工上重点在「把工程化保障做实」。

**Q9：和你的 EchoMind 项目是什么关系？**
EchoMind 是智能客服场景的六大考点练习，MiraFrame 是把同一套 Agent 工程能力迁移到内容生成场景：LLM-as-Judge、多 Agent 路由、Monitor 闭环是共通的；MCP 在 MiraFrame 里用真实素材库 server 落了地（连接层主用官方 `@langchain/mcp-adapters`），多轮记忆做了增量滚动摘要，六大考点都有对应实现。

**Q10：最大的技术债是什么？**
`critique_result` 事件**已补齐**（P1-2：Critic 每轮评审后经 WS 下发评分、阈值、轮次与打回原因，前端节点详情渲染评分卡片）；`_nodeCtx` 全局兜底**已删除**（P1-4：节点上下文只走 ALS，取不到直接报错）；provider 选路/降级**已补齐**（P2：候选链 + 熔断 + 只读健康端点，见 Q14）。i2i 自动联动**已补齐**（P2：漂移自动重画 + 复检 + 回执，见 Q15）。剩余技术债是字幕外挂 SRT 没烧进画面、长期记忆只是单段摘要（没有向量检索、跨项目不复用）、WS 是进程内广播没接 Redis adapter。DOUBAO 配置、宇宙页面残留、无鉴权配置接口、进程内 checkpointer 等已在 P0/P1-1 中清理完毕。这些都不影响主线演示，但面试被问到要承认。

**Q11：BullMQ 并发 8，怎么保证项目之间不串号？**
上下文不走模块级全局变量，只走 `AsyncLocalStorage`：processor 用 `runWithNodeContext(ctx, () => compiled.invoke(...))` 把每个 job 的 ctx 绑定在自己的异步链上，节点里 `getNodeCtx()` 只从 ALS 取。早先这里有个 `_nodeCtx` 全局兜底 + 取不到就返回 mock（`callLlm` 吐 `"{}"`），并发下会串号、且静默产出空结果还显示成功——现在取不到直接抛 `[agent:ctx] 图节点拿不到 AgentContext`。模块级共享的只有两类东西：Agent 实例（只持有 `readonly name`，无状态）和 checkpointer 单例（内部是 pg 连接池，本来就该复用，不持有项目上下文）。测试用 8 个不同 `projectId` 并发跑 Critic 节点、故意错开 LLM 延迟，断言每份回报的 issues/suggestions 都来自它自己的 job。

**Q12：MCP 你是怎么接的？自实现和官方 SDK 怎么选？**

先自实现、后换官方 SDK，两步都留下了。顺序很重要，因为它逼我先把协议搞明白：

第一步按规范写了 200 行 stdio 客户端（`tools/mcp/client.ts`）：stdin/stdout 每行一个 JSON-RPC 2.0 消息，握手 `initialize` → 收 result → 发 `notifications/initialized`，然后 `tools/list` / `tools/call`，结果在 `result.content[]`。细节上做了请求 id 递增配对、超时、子进程退出时把所有 pending 拒绝掉、stdout 混入非协议内容时记进诊断而不是崩。

第二步换成官方 `@langchain/mcp-adapters` 的 `MultiServerMCPClient`：连上 → `getTools()` → 转换 → 关掉。换完之后 **节点代码和 ToolLoop 一行没改**，因为当初就把「连接层」和「转换层」拆开了：`sdk-toolkit.ts` 和自实现都只产出 `AgentTool[]`，差异被 `adapter.ts` 吃掉。这是分层带来的直接收益。

自实现的客户端没有删，保留为 `transport: "builtin"`，默认 `auto`（先 SDK，失败回落），可用 `MIRAFRAME_MCP_TRANSPORT` 切换。理由是两条路契约一致、都有测试，SDK 出问题时不至于整个功能不可用。

**换 SDK 时踩到一个真实的语义坑**，这个值得讲：MCP 规范里 `isError: true` 是**工具级错误**（参数不对、路径越界），模型看到它才能自我修正；但官方 SDK 会把它包成抛出的异常（`MCP tool 'x' on server 'y' returned an error: ...`）。如果任由异常冒泡，ToolLoop 会中断而不是回填给模型——工具错误就变成了传输错误，Agent 的自我修正能力随之消失。所以 `adapter.ts` 里专门有 `toMcpErrorText()`：剥掉 SDK 的包装前缀、还原成单层 `ERROR:` 文本，并在测试里断言「不含 `returned an error`」。这类「库的默认行为违反你的契约」的问题，只有集成测试能抓住。

**版本也是坑**：`@langchain/mcp-adapters@2.x` 要求 `@langchain/core ^1.2.6` + `langgraph ^1.4.18`，而项目锁在 core 1.1.48 / langgraph 1.3.2，`StateGraph`、`interrupt`、`PostgresSaver` 全建在这两层上。所以钉死 `1.0.1`——它的 peer 是 `^1.0.0`，零升级。为一个增强能力去动 Agent 骨架不值。

配套的 server 是真实可跑的（`servers/assets-server.mjs`，零依赖），暴露项目内文件系统，做了路径穿越校验和 `.env`/密钥类文件拦截。验收方式是集成测试真的 spawn 子进程走完整往返。

最强的一条证据是 `mcp-tool-loop.test.ts`：模型（预设 tool_calls）先调 `list_project_assets` 查 docs 目录，结果回填进下一轮上下文，再调本地工具写草稿、落库。断言里直接检查了「模型第二轮的上下文里出现了 `architecture-walkthrough.md`」——证明工具结果真的回到了模型，而不是调完就丢。

工程细节上还有两点：一是 MCP 是**可选增强**，`createAssetsToolKit()` 拉不起进程就返回 null，节点照常跑；二是构建坑——tsup 是 bundle 模式，`.mjs` 子进程脚本不会进 dist，而生产镜像「只拷 dist」，所以加了 `scripts/copy-mcp-servers.mjs`，否则 `node dist` 形态下 MCP 永远降级。

**Q13：长会话的记忆怎么管？为什么不是简单截断？**

因为截断会把「最早的偏好」整段丢掉，而用户的反馈恰恰是指代性的：「改回第一版」——第一版是什么，只有历史里有。所以做的是**增量滚动摘要**：

- 消息按「用户发言 = 一轮的开始」分组（`conversation-memory.ts` 的 `groupConversationTurns`）；
- 最近 `keepTurns`（默认 5）轮保留原文，更早的轮次被折叠进一段摘要；
- 折叠用 `coveredThroughId` 记录「摘要覆盖到哪条消息」，每轮只折叠一次，不会重复烧钱；
- 新内容是**与旧摘要合并**后输出完整摘要，不是简单追加（否则摘要会越堆越乱）；
- 内容太少（默认 < 600 字）就先攒着，不值得为两句话调一次模型。

prompt 里是两个 block：`## 长期记忆（滚动摘要）` 在前、最近几轮原文在后，并明确「两者冲突时以原文为准」——摘要可能失真，原文不会。

工程上最值得说的是**失败语义**，一共三条：记忆表还没建（迁移没跑）→ 当空记忆静默降级；模型调用失败 → 沿用旧摘要、不阻断生成；模型返回空 → 不覆盖旧摘要，宁可保留旧的也不要一次坏调用清空长期记忆。长期记忆系统最容易出的事故就是「摘要器挂了，把记忆写成空」，这里用 `applyMemoryPlan` 返回 null 挡住了。

还有两个细节：`coveredThroughId` 用 `Math.max(旧值, 新值)` 保证只前进不后退（job 重放时不会重复折叠）；`keepTurns` 与 `minChars` 都走环境变量（`MIRAFRAME_MEMORY_KEEP_TURNS` / `MIRAFRAME_MEMORY_MIN_CHARS`），测试里可以精确控制。验收是真实 Postgres 跑一次：6 轮对话 → 折叠第 1-3 轮、`covered_through_id` 落库、prompt 里只剩 4-6 轮原文 + 摘要，删项目级联清掉记忆行。

**Q14：provider 挂了怎么降级？熔断会不会误伤？**

原来的实现只有一层：对同一个 URL 重试。429 退避、503 退避都对，但如果主 provider 是密钥失效、账号欠费、区域故障，重试只会一路撞到超时——用户等到的是「生成失败」，而不是「换一家继续」。

现在是两层，**重试负责抖动，选路负责故障**：

- **候选链**：`TEXT_PROVIDERS=agnes,kimi` 按顺序尝试，每个候选的 `TEXT_<NAME>_BASE_URL / _API_KEY / _MODEL` 覆盖通用 `TEXT_*`。不配就是单元素链，行为与改造前完全一致——这点很重要，降级能力不能以破坏默认路径为代价。
- **熔断**：同一家连续失败 N 次（默认 3）进入冷却，冷却时长指数翻倍、封顶 5 分钟；冷却期内直接跳过，到期后放一个**试探**请求（half-open），成功即恢复、失败则冷却翻倍。
- **分类**：只有「换一家可能有用」的失败才切换——网络、超时、429、5xx、401/403。401/403 也算可切换，因为主 key 失效时备用 key 往往就是好的，这正是降级最该救的场景。反过来 400/422 是请求本身有问题，换谁都一样，**不切换、也不记入熔断**，否则一个坏 prompt 能把整条链的健康度打穿。
- **观测**：`GET /api/v1/providers` 返回每家的状态、成功率、平均延迟、连续失败数、剩余冷却时间、上次错误（只读脱敏，不含 baseUrl 和密钥）。演示时可以直接 curl，看主 provider 连续 401 之后 `closed → open → half_open` 的过程。

有两个设计点是被测试逼出来的，讲出来比只讲结论有说服力：

1. **半开的候选必须排在最前面**。最初的实现是「健康 → 半开 → 冷却」，结果备用一直健康、每次都先成功，主 provider 冷却到期后永远轮不到试探，等于被永久摘除。改成 probe 优先，代价是一次探测请求，换来的是主能真正恢复。
2. **备用也会熔断**。测试里主备同时 5xx 时，两家都会进冷却，这时请求会走「全链冷却」分支：不在第一次就认输，而是 best-effort 尝试最早恢复的那一家。硬失败对调用方没有价值，而抖动常常已经恢复了。

工具通道还有个专属处理：`function calling` 返回 400 在普通调用里是「参数错、不该切换」，但在工具通道里通常意味着「这家不支持 tools」，换一家就有意义。所以 `ProviderHttpError` 支持 `switchableOverride` 覆盖默认分类；整条链都不支持时才回 `TOOLS_UNSUPPORTED`，让 ToolLoop 按原设计降级到 JSON 协议——**降级路径没变，只是多了一次换家的机会**。

边界也要说清楚：这是**静态优先级 + 熔断**，不是按成本/延迟动态加权的负载均衡，也没有跨进程共享熔断状态（多实例各算各的，要做得上 Redis）。真要做「成本驱动」，得先有按 token 计费的账本，那是另一个工程量级。

**Q15：漂移自动修，怎么保证不烧钱、不来回震荡？**

原来的第三步是「人点按钮」：检测自动、修复手动。缺口不在能力，而在编排——`ShotRepairService` 早就写好了，只差一个调用方。

现在的链路是 `generateShotFrames` → `autoCheckConsistency` → `autoRepairDriftedShots`，三道闸按成本从低到高排：

- **开关**：`MIRAFRAME_AUTO_REPAIR`，默认开；预算 `MIRAFRAME_AUTO_REPAIR_MAX_SHOTS` 默认 2，压到 0 就退回「只告警、手动修」。
- **图像服务是否真能出图**：这一道最容易被忽略。`generateImage` 在 **fake provider 或没配 key** 时会**静默返回占位图**，不拦住就会把一张真图换成灰底占位图、还顺手清掉视频。所以先用 `isImageRepairAvailable()` 解析候选链，要求至少一家「非 fake 且带 key」。
- **这一轮有没有漂移**：只修 `verdict=drift`。灰区 `review` 不修——判定本身不确定，重画大概率是白花钱；`ok` 和 `unverifiable` 也不动。

预算怎么花：按「漂得最厉害」排序，也就是取该镜头里 `distance` 最大的那个角色，从重到轻取前 N 个。每镜头只出现一次，所以不存在同一张图反复重画。

复检语义是特意设计的：重画后立刻只重检这一张，`ok` / `review` 算「不再漂移」，`unverifiable` **不算修好**——没检出脸等于没有证据，这时候宣称修好只会掩盖问题。修不好的镜头保持原样，前端面板仍可手动重试。

还有两个实现细节值得说：

1. **先出图成功、再写库**。`repairWithReferences` 里图生图返回后才更新 `imageUrl`、清空 `videoUrl`；返回 `data:` 开头（占位图）时在写库前就抛错，原图不受影响。失败的镜头会进回执的 `failed`，不会让整轮中断。
2. **挂在生视频之前**。校验和修复都在 `generateShotFrames` 末尾，`generateShotVideos` 拿到的就是新图，所以**不需要额外重合成**——这也是为什么「清空 `videoUrl`」在这里不是代价，而是正确性保证。

观测上新增 `consistency_repair_completed` 事件，载荷带 `repaired`（含复检判定与 `resolved`）、`skipped`（`not_drift` / `no_references` / `over_budget`）、`failed`，前端消息流会显示「重画 2 个、1 个已恢复」。

**可能被追问：为什么不干脆全自动、不设上限？** → 一致性判定本身有波动，重画又是按张计费；无上限的自动修复会在一个本来就判不准的指标上反复花钱。预算 + 复检 + 保留手动兜底，是「自动化」和「可预测成本」之间的折中。

**Q16：视觉 Critic 怎么做的？为什么不是一张图调一次？**

先说我为什么认为它必要：原来的质量检查有两个洞。文本 Critic 读的是分镜脚本，它不知道图出来是什么样；face-api 只认人脸向量，画风从国漫变成 3D 渲染、手画成六根指头、构图把主角半个头切出画——这些它一句话都说不出。`CRITIC_SYSTEM_PROMPT` 其实早就写好了图像四维 rubric（一致性、画面质量、画风、构图），只是一直没人调。所以这不是新功能，是把已有设计接上。

**一张图一次调用是错的**。6 镜项目就是 6 次请求，而每次都要重复发同样的项目风格、角色设定、评分规则；请求数乘以「固定开销」比图本身还贵。现在的做法是一次带 4 张（可配），6 镜走 2 次调用。

批量带来一个新风险：模型会数错图。所以提示词里把对应关系写死成「图 1 = 镜头 #1；出场角色：沈鸢；画面要求：……」——不让它自己数，而是给它一张对照表。

图片必须压缩后内联成 base64。原因不是省流量，是**供应商访问不到我们的图**：镜头图由图像供应商生成，返回的是它们域名的 URL；本机 `/static/` 更不可能被外部访问。压到长边 768 / JPEG 0.8 后单张约 100KB（原图 1024 PNG 常有 1–2MB，6 张就是 10MB 请求体）。透明 PNG 要先铺白底，否则 JPEG 不支持 alpha，出来一片黑。

解析层有四个刻意的取舍，都是为了「别让一个不可靠的判定变成不可靠的动作」：

1. **总分用镜头均值，不用模型自报的 `overall_score`**。实测里它经常给 9.9 总分、分项却全是 5 分，两者矛盾时按分项算更接近真实。
2. **漏评的镜头记进 `missingOrders`，不补满分也不当成通过**，前端会显示「镜头 #3 未返回评分」。
3. **`needs_regenerate` 只认 `true`**，字符串 `"true"`、数字 `1`、缺字段一律算 false——重画是花钱的动作，没有明确指令就不该发生。
4. **重画要两个条件同时满足**：模型说要重画，**并且**分数低于阈值。只看标记会把 8 分的图重画掉，只看分数会在模型认为「小修可用」时白花一次生成。

重画没有走「纯文生图重来一张」，而是复用 i2i 那条保脸路径：带角色参考图、把 Critic 的 suggestions 拼进提示词（拼接的是 suggestions 不是 issues——issues 说哪里错，suggestions 才是怎么改）。否则重画一次，脸又漂了，等于用视觉问题换了一个几何问题。

**可能被追问：为什么不重审重画后的图？** → 那会变成「审-改-审」的循环，而视觉判定本身是主观的，很可能每轮都有新意见。修改后的图仍然过一遍人脸一致性检查（可量化），视觉上只跑一轮，剩下的交给人。

**可能被追问：视觉模型和文本模型是两个供应商怎么办？** → 现在复用同一条文本 provider 链，只允许用 `VISION_MODEL` 覆盖模型名（同 key 同 baseUrl、只换模型是常态，`qwen-plus` → `qwen-vl-max`）。链路本身已经过熔断保护，视觉调用失败会自动切下一家，整条链都挂也只是这一轮没有结论，不阻断生成。

**Q17：字幕为什么用 DOM 叠加，不做 ffmpeg 烧录？**

先看数据是不是现成的：`shots.dialogue` 是剧本格式，服务端 `planDialogue` 早就把它拆成「说话人 / 语气 / 纯台词」送 TTS 了，合成时还顺手写了个外挂 `final.srt`。所以字幕不需要新的 AI 能力，只是同一份数据的第二个出口——之前只接了「听得见」，没接「看得见」。

**不做烧录有两个理由，第二个更重要。**

第一个是环境：本机 Homebrew ffmpeg 9.0.2 没编 libass，`-filters` 里查不到 `subtitles`/`ass`/`drawtext`，系统字体目录也没有 PingFang。要跑通得换 ffmpeg 静态构建、把字体挂进容器。

第二个是性质：烧录是把字逐帧画进像素，成片**不可逆**。改一句台词就要重新编码整条片子；而 MiraFrame 的卖点恰恰是「可反馈、可增量重生成」。用 DOM 层盖在 `<video>` 上，字幕随时开关、改文案零成本、导出 mp4 也不会被字幕污染。这跟前面「把结果正确性和渲染好看拆开」是同一个判断：渲染层缺依赖，不该挡住生成链路的正确性验证。

**实现上真正要设计的是时间轴，不是样式。** 我把台词解析从 server 抽到 shared，前后端共用一份 `parseDialogue`——否则 TTS 念的字和屏幕显示的字会慢慢对不上。然后 `planSubtitleCues` 做三件事：按标点把长句切成不超过 18 字的字幕条（中文没空格，一屏三段话读不完）、段内按字数比例分配时长并给短句兜底、多段按镜头累加。单镜头的时长直接取 `onLoadedMetadata`，精确；成片不能直接用 `shots[].duration` 累加，因为台词过长时服务端会冻结末帧延长画面，得按比例缩放到视频真实总时长，否则越往后字幕越漂。

组件层只监听 `timeupdate`，不启 rAF：250ms 一次对字幕够准，而且只在「当前 cue 真换了」时才 `setState`，绝大多数事件都是空转。

**可能被追问：那下载出去的 mp4 没有字幕怎么办？** → 这是明说过的边界。字幕只在本站播放器可见；要带出去有三条路：配带 libass 的 ffmpeg 做真烧录、下载时附 `final.srt`（外挂，B 站/剪映都认）、或者用 `<track>` 让浏览器原生渲染 srt。我选的是先把「看得见」做出来，不为一个渲染依赖卡住主链路。

---



## 5. 诚实边界（主动交代比被问出来强）

- **checkpoint（P1-1 已修）**：`packages/agent/src/checkpointer.ts` 的 `createCheckpointer(connectionString)` 返回 `PostgresSaver` 并幂等建表，`agent.processor.ts` 用 `app.databaseUrl` 构造；无连接串时才退回 `MemorySaver`（单测路径）。
- **`critique_result` 事件（P1-2 已修）**：`AgentContext.reportCritique` 由 `CriticAgent` 每轮评审后调用，`agent.processor.ts` 转成 snake_case 载荷经 WS 下发；前端 `critiqueStore` 收下后渲染评分卡片（总分/阈值/轮次/维度/问题/建议），消息流也留一条文本便于回溯。
- **MCP（P1-3 已接，连接层已换官方 SDK）**：默认走 `@langchain/mcp-adapters@1.0.1` 的 `MultiServerMCPClient`，`tools/mcp/client.ts`（自实现 JSON-RPC over stdio）保留为 `transport: builtin` 兜底，`MIRAFRAME_MCP_TRANSPORT` 可切。`servers/assets-server.mjs` 是配套的真实素材库 server，拦截路径穿越与 `.env`/密钥类文件。钉 1.0.1 是因为 2.x 要求把 core 升到 ^1.2.6、langgraph 升到 ^1.4.18，为增强能力动 Agent 骨架不划算。仍只有大纲节点挂了远端工具，且 MCP 是可选增强——拉起失败自动降级，主流程不受影响。
- **视觉 Critic 的边界**：只审关键帧、不审视频（视频要抽帧，成本和时延另算）；重画后不复审——避免「审-改-审」在主观判定上无限花钱，改完的图仍会过一遍人脸一致性检查；复用文本 provider 链只换 `VISION_MODEL`，所以「文本模型配了纯文本模型」的环境要显式加一个多模态模型名，否则视觉调用会 400；单轮只审前 8 个镜头、单次最多 4 张图，是额度保护不是能力上限。
- **残留（P0 已清理）**：`DOUBAO_*` 配置与 `app.config.ts` 里的兜底字段、`UniversesPage.tsx` / `UniverseDetailPage.tsx` / `universesApi.ts` 均已删除；宇宙路由保留重定向以免旧链接 404。`config/` 接口已加 `ADMIN_TOKEN` 守卫，CORS 收紧为白名单，明文 `reveal` 接口移除。
- **长期记忆的边界**：`conversation_memory` 每个项目一行，存的是单段摘要，没有向量检索、不能跨项目复用；摘要质量依赖模型，`keepTurns=5` 之外的细节只剩压缩后的一句。真要做得更细，应该按「角色设定 / 分镜决定 / 风格偏好」分槽存储，而不是一段散文。
- **provider 选路的边界**：静态优先级 + 熔断，不是按成本/延迟动态加权的负载均衡；熔断状态在进程内，多实例部署时各算各的（应改 Redis 共享）；候选链目前靠 `BASE_URL` 嗅探协议（dashscope / agnes / 通用 OpenAI），新增一家特殊协议仍要改代码。
- **face-api 局限**：半透明、背影、非人形参考图检不出脸，标 `no_reference`，不误判但也无法校验。
- **i2i 自动修复的边界**：只修 `drift` 不修灰区 `review`；单轮预算默认 2 个镜头（`MIRAFRAME_AUTO_REPAIR_MAX_SHOTS`），是「每次跑」而不是「全项目总量」；每个镜头只修一次，避免修脸把构图修坏后再来回震荡；预算和判定都在进程内，多实例部署时各算各的。
- **字幕的边界**：走 DOM 叠加，不烧录。导出的 `final.mp4` 不带字幕（后端另写有外挂 `final.srt`，但没有下载入口）；成片时间轴按 `shots[].duration` 比例估算，个别镜头被延长较多时会偏几百毫秒；没有字号/位置自定义，也没有双语或逐字高亮。本机 ffmpeg 无 libass 只是不做烧录的环境原因，真正的原因是烧录不可逆、和「可反馈可增量重生成」这条主线冲突。

---

## 6. 代码地图（按讲题定位）

| 主题 | 文件 |
| --- | --- |
| 状态图与节点 | `packages/agent/src/graph.ts`、`nodes/index.ts`、`state.ts` |
| Director / Critic / Review | `packages/agent/src/agents/{director,critic,review}.ts`、`prompts/{director,critic}.ts` |
| 执行器与门持久化 | `packages/server/src/agent/agent.processor.ts`、`agent-run-state.ts` |
| 增量与续跑 | `packages/server/src/agent/revision.service.ts`、`services/lineage.ts` |
| Provider 选路与熔断 | `packages/server/src/services/provider-routing.ts`、`modules/config/providers.controller.ts` |
| Provider 与失败恢复 | `packages/server/src/services/{text,video,image,tts}.service.ts`、`config/app.config.ts` |
| 一致性闭环 | `packages/server/src/services/{face,consistency,consistency.service,shot-repair,auto-repair}.service.ts`、`agent/agent.processor.ts` 的 `autoCheckConsistency` / `autoRepairDriftedShots` |
| 前后端契约 | `packages/shared/src/types/*`、`constants/{events,stages,approval}.ts` |
| 台词解析与字幕时间轴 | `packages/shared/src/utils/dialogue.ts`、`packages/frontend/src/components/project/SubtitleOverlay.tsx` |
| 前端工作台 | `packages/frontend/src/pages/ProjectPage.tsx`、`components/project/*`、`hooks/useWebSocket.ts` |
| 改动时间线 | `MODIFICATIONS.md` |
