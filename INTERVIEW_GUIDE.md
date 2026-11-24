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

- 后端最近一次验证 **50 个测试全过**，前后端 `tsc` 0 错误，`vite build` 通过；源码中约 **149 个测试用例**分布在四个包。
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
- `:9-10` 阈值与轮次可配（`CRITIC_SCORE_THRESHOLD` 默认 7、`CRITIC_MAX_ROUNDS` 默认 2）；`:107` 通过条件是「达标 **或** 到轮次上限」，避免死循环。注意 `.env` 里配的是 `CRITIQUE_SCORE_THRESHOLD=6.0`（另一套前缀，定义在 `config/app.config.ts:139-143` 且无人消费），**实际生效的是 7**；被问「阈值怎么配」时别答错，这是待清理的双源配置，见 [ROADMAP.md](./ROADMAP.md) P0-2。
- `:124-134` 是关键：不通过时 `nextStage = plan_shots`，并把 issues/suggestions 拼成 `feedback` 回灌；`packages/agent/src/agents/plan.ts:71-81` 在下一轮生成时直接消费这个字段。
- `:93-104` 模型调用失败或 JSON 坏了，降级为人工审批，不阻断主流程。

**R** 形成了「生成 → 评估 → 带意见重写 → 再评估」的闭环，且有轮次上限和人工兜底。

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

**可能被追问**：checkpoint 存在哪？→ 诚实答：当前用 `MemorySaver`（`agent.processor.ts:51-52`），**进程内**，重启会丢执行位置；持久化的只有 run 状态、门位置和产物。见「诚实边界」。

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
| 工具调用 | `AgentContext` 暴露 `saveOutline` / `createShot` / `callLlm` 等方法 | 可以说清「工具层该长什么样」 | **当前没有 MCP**，是硬编码方法；不要说成接入了 MCP |
| 多轮记忆 | `messages` 表 + Critic 的 `feedback` 跨轮回灌（`plan.ts:71-81`） | 反馈能改变下一轮生成，不是单轮问答 | checkpoint 是 `MemorySaver`，进程内；跨重启只保留产物和 run 状态 |
| 多 Agent 路由 | Director 规划 + Review 的 `FALLBACK_ROUTE`（`review.ts:9-14,80-82`） | 模型决定路由，失败有白名单兜底 | 节点是类，不是独立进程/服务 |
| Monitor 闭环 | 29 类 WS 事件（`packages/shared/src/constants/events.ts`）+ `run_*` 事件 + 评分写 state | 进度、门、产物、告警前端实时可见 | `critique_result` 事件定义了但服务端没有 emit |
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
不是全部。产物、run 状态、门位置在 PostgreSQL；图的 checkpoint 目前是 `MemorySaver`，进程重启会丢执行位置，只能从门或阶段继续。这是我明确知道的技术债。

**Q5：外部模型限流怎么处理？**
文本 429：串行队列 + `Retry-After` + 指数退避；视频 503：可重试错误分类 + 退避封顶 120 秒；两者都有次数上限，耗尽后抛明确错误并保留已完成素材，配合 `target_stage` 续跑。

**Q6：怎么评估生成质量？**
分两层：文本层用 Critic LLM-as-Judge 打分并打回重写（有 rubric、阈值、轮次上限）；视觉层用 face-api 数值距离判角色一致性，漂移可再用参考图 i2i 修正。两层都不是「人肉看一眼」。

**Q7：一致性为什么不用纯 LLM？**
人脸距效果需要可复现的量化门限，face-api 给 128 维向量和欧氏距离，能设定 0.45/0.6 阈值并做回归；LLM 更适合审叙事和镜头语言。职责分开。

**Q8：你前端出身，在这项目里具体写了什么？**
全栈 TS：前端纸墨设计系统（语义 token + reduced-motion + 双主题）、工作台与一致性面板；后端 NestJS 服务（TTS 混流、face-api 初始化、i2i 反哺）；Agent 层的状态契约和 WS 事件类型也参与对齐。分工上重点在「把工程化保障做实」。

**Q9：和你的 EchoMind 项目是什么关系？**
EchoMind 是智能客服场景的六大考点练习，MiraFrame 是把同一套 Agent 工程能力迁移到内容生成场景：其中 LLM-as-Judge、多 Agent 路由、Monitor 闭环是共通的；MCP 和多轮记忆在 MiraFrame 里还比较弱，是明确的下一步。

**Q10：最大的技术债是什么？**
checkpoint 非持久（MemorySaver）、`critique_result` 事件空定义、DOUBAO 配置和宇宙页面残留、字幕是外挂 SRT 没烧进画面、i2i 修正目前是手动触发。这些都不影响主线演示，但面试被问到要承认。

---

## 5. 诚实边界（主动交代比被问出来强）

- **checkpoint**：`packages/agent/src/checkpointer.ts:5-14` 导出 `createCheckpointer()`，但全仓没人调用；实际用的是 processor 里 `new MemorySaver()`。进程重启丢的是「图执行到哪一步」，不是产物。
- **`critique_result` 事件**：shared 里定义、前端监听，但服务端没有 emit；Critic 的结果目前只进图状态和消息流。
- **MCP**：没有接入。Tool Registry 的接入点可以设计，但现在是硬编码 `AgentContext`。
- **`CRITIC_SYSTEM_PROMPT`**（图像四维 rubric）定义了但 CriticAgent 没调用，当前只审分镜文本。
- **残留**：`.env` 里 5 行 `DOUBAO_*` 仍在，且**并非完全无消费** —— `config/app.config.ts:101-106` 读入 6 个字段，`video.service.ts:36,40,75,85,86` 把 `doubaoApiKey`/`doubaoVideoModel` 当兜底值、`doubaoVideoDuration`/`doubaoVideoRatio` 当默认参数使用；准确说法是「作为 legacy 兜底被读取，但没有独立 doubao provider 分支」，仅 `DOUBAO_GENERATE_AUDIO` 无人消费。`UniversesPage.tsx` / `UniverseDetailPage.tsx` 保留但路由已下线。
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
