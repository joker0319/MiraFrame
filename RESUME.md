# MiraFrame 简历项目经历

> 数据截至 2026-11-24，代码基线 `82ae3d4`（42 个提交）。
> 配套：[INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md)（面试口述展开）、[ROADMAP.md](./ROADMAP.md)（后续优化）、[MODIFICATIONS.md](./MODIFICATIONS.md)（改动流水账）。
> 用法：§1 抄项目名片 → §2 按投递岗位挑一版正文 → §3 挑 3–4 个能讲清口径的数字 → §6 确认每条 bullet 都有对应口述案例。

---

## 0. 动笔前先定三件事

| 问题 | 结论 | 简历上怎么写 |
| --- | --- | --- |
| 项目性质 | 基于 GitHub 开源项目做二次开发与能力增强 | **必须写「基于开源项目二次改造 / 主导改造」**，不要写「独立从零设计开发」。这是最容易被背调查出来的一句话 |
| 你的角色 | 前端转 AI Agent，重心在 Agent 工程化与全栈落地 | 不要写成纯前端（浪费 Agent 含量），也不要写成算法/模型训练（没有做过） |
| 项目定位 | 学习、演示与产品原型（README 已明示） | 不要写「上线」「生产环境」「日活」「QPS」。数据一律标注「本地演示环境」口径 |

> 一句话原则：**简历只写「做了什么 + 用什么手段 + 得到什么可验证结果」，故事和踩坑留给面试。**

---

## 1. 项目名片（可直接复制）

```text
MiraFrame 弥镜 | AI 漫剧生成 Agent 工作台 | 2026.09 – 2026.11
角色：核心开发（基于开源项目二次改造）
技术栈：TypeScript 5 / LangGraph.js / NestJS 11 / React 18 / PostgreSQL 16
       / Redis + BullMQ / Drizzle ORM / Socket.IO / Vitest / pnpm monorepo
项目简介：把「故事想法 → 大纲 → 角色设定 → 分镜 → 镜头图/视频 → 成片」
         拆成可解释、可中断恢复、可人工反馈、失败可自愈的多 Agent 流水线。
```

补充字段（有空间再加）：

- **工程规模**：pnpm monorepo 四包（frontend / server / agent / shared），163 个 TS/TSX 文件，前后端共享 Zod Schema 与 WebSocket 事件类型。
- **相关链接**：仓库地址、演示录屏、[INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md)。

---

## 2. 正文五版（按岗位挑一版，不要全贴）

### 版本 A · 一行版（简历空间紧张，或作为「其他项目」）

> **MiraFrame｜AI 漫剧生成 Agent 工作台**：基于 LangGraph.js 将固定流水线改造为「Director 规划 + Critic 评估打回 + 4 个人工确认门」的可恢复多 Agent 系统，实现 429/503 分类重试、阶段级续跑与角色一致性自动校验闭环。

---

### 版本 B · 标准版 4 条（推荐｜AI 应用 / 全栈 / 后端岗）

> 适合大多数情况。4 条分别对应「决策 → 执行 → 保障 → 质量」，正好是一条完整故事线。前 4 条必选，第 5 条按岗位选加。

1. **重构生成架构**：基于 LangGraph.js 将固定阶段流水线改造为「workflow 骨架 + 模型决策节点」混合架构；Director Agent 依据题材生成阶段计划，通过阶段白名单、必需阶段补齐与顺序重排约束模型裁量权，非法输出自动回退全链路；Critic Agent 以四维 rubric 实现 LLM-as-Judge，未达标带意见打回重写，并设轮次上限与人工审批兜底；评审结论（总分/阈值/轮次/四维得分/问题建议）经 WS 实时下发，前端渲染评分卡片，Judge 过程可见可回溯。
2. **实现可恢复的 Human-in-the-Loop**：落地 4 个 `interrupt` 人工确认门，门位置持久化至 PostgreSQL、经 Redis 消息恢复；设计 `target_stage` 阶段续跑，配合 `shots.characterIds` 血缘影响面分析只标脏受影响镜头，复用已生成素材，避免整条链路重跑。
3. **收敛多供应商失败恢复**：文本侧 429 采用进程级串行队列 + `Retry-After` 优先 / 指数退避兜底，视频侧将 503、`queue_full`、429 等归为可重试错误并封顶 120s 退避、限 8 次；provider 全量配置化，切换仅需改环境变量；6 镜头项目中失败镜头经续跑补齐，无需从头生成。
4. **搭建角色一致性质量闭环**：以 face-api wasm 后端 + 贪心指派（阈值 0.45 / 0.6）在镜头图生成后自动校验，结果落库并在工作台告警；漂移镜头可用角色参考图走图生图反哺重画并自动复检。9 张图检测耗时由 41s 降至 1.8s（约 23×），i2i 对照使人脸距离由约 0.4 降至 0.22。
5. *（前端/全栈岗加）* **全栈落地与实时同步**：前端实现纸墨设计系统、双主题与工作台；29 类 WebSocket 事件驱动进度、审批门、产物与告警的实时展示；前后端共享 Zod Schema 与事件类型，以单一数据源避免契约漂移。

---

### 版本 C · 完整版 6 条（项目作为主项目、有一整块版面）

在版本 B 基础上把「保障」和「质量」拆开，并补上成片链路与工程规模：

1. 基于 LangGraph.js 重构 6 阶段生成流水线为「workflow 骨架 + 模型决策节点」架构，Director 受白名单与必需阶段约束地产出 `executionPlan` 与可回溯的 `planRationale`。
2. 实现 Critic LLM-as-Judge 闭环：四维 rubric 评分、未达标将 issues/suggestions 回灌下一轮生成、轮次上限防死循环、模型异常降级人工审批；评分与打回原因经 WS 实时下发到前端评分卡片。
3. 落地 4 个 `interrupt` 人工门 + DB 持久化等待位置 + Redis 恢复；`target_stage` 阶段续跑配合血缘分析实现增量重生成。
4. 治理外部依赖：文本 429 串行队列 + `Retry-After`/指数退避，视频 503/队列满分类重试（8 次、封顶 120s），供应商差异全部收敛到配置层；曾以最小只读探测定位成本问题并改用免费模型。
5. 构建一致性闭环：face-api wasm 提速约 23×（41s → 1.8s）→ 镜头图生成后自动校验并落库告警 → 参考图 i2i 反哺修正；6 镜头 / 3 角色项目端到端 1.85s。
6. 完成成片链路与工程化：逐镜头 macOS TTS 对白配音、原声底噪处理与 `final.srt` 字幕，输出约 34s 成片；pnpm monorepo 四包共享 Zod 契约，264 个测试用例、CI 保障 `build` / `typecheck` / 全量测试通过；BullMQ 并发 8 下用 AsyncLocalStorage 隔离每个 job 的 AgentContext，移除全局兜底，缺上下文显式报错而非静默产出空结果。

---

### 版本 D · 前端岗侧重（把前端放前两条）

> 投前端 / 前端偏全栈时用。Agent 部分保留但压缩，避免面试官只问页面。

1. **主导前端工程与视觉体系**：React 18 + Vite + Zustand + TanStack Query 实现项目列表、工作台、节点详情与设置面板；重构纸墨设计系统（语义 token、双主题、reduced-motion 降级），替换模板化视觉。
2. **实时状态同步**：设计 29 类 WebSocket 事件的消费层，统一处理生成进度、审批门恢复、产物更新与一致性告警；与后端共享 Zod Schema 和事件类型，消除接口契约漂移。
3. **把 AI 生成的不确定态做成产品交互**：错误态、重试入口、人工反馈入口、漂移红点与「按参考图修正」按钮，让后台 worker 的长任务在前端可观察、可干预。
4. **参与 Agent 工程化链路**：LangGraph 阶段续跑、4 个人工门状态持久化、429/503 失败恢复与角色一致性自动校验（详见 [INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md)）。

---

### 版本 E · AI Agent / LLM 应用岗侧重（决策与评估放前三）

1. **多 Agent 决策与路由**：Director 依据题材与用户反馈规划阶段（白名单 + 必需阶段约束 + 顺序重排 + 格式异常回退），Review 决定反馈回流到哪个阶段；解决「固定流水线对所有题材一视同仁」问题。
2. **LLM-as-Judge 质量闭环**：四维 rubric 真打分、不通过带意见打回 `plan_shots` 重写、轮次上限与人工兜底；替代原先硬编码永远通过的桩实现。
3. **Human-in-the-Loop 与断点续跑**：4 个 `interrupt` 门 + DB 记录 `awaitingGate` + Redis 恢复 + `target_stage` 从指定阶段切入，已完成素材不重生成。
4. **面向真实供应商的可靠性治理**：429 串行队列与 `Retry-After`/指数退避、503/队列满分类重试、血缘分析增量标脏、provider 配置化降级。
5. **可量化的视觉评估闭环**：face-api 128 维 descriptor + 欧氏距离阈值 + 贪心指派处理多角色同框，自动校验后以参考图 i2i 反哺；文本用 LLM 评审、几何特征用专用模型，职责分离。
6. **可插拔工具层 + MCP**：`ToolRegistry` + `ToolLoop` 让模型自主选工具（原生 function calling，不支持时降级 JSON 协议）；工具定义与 LangChain `tool()` 双向互通；连接层主用官方 `@langchain/mcp-adapters`，并保留按 MCP 规范（JSON-RPC over stdio）自实现的客户端作兜底，两者契约一致可切换；吸收 SDK 把工具级 `isError` 包成异常的行为、还原为回填给模型的错误文本，保住 Agent 自我修正能力。
7. **多轮记忆的增量滚动摘要**：滑出保留窗口的旧轮次与旧摘要合并压缩后落库，`coveredThroughId` 游标保证每轮只折叠一次、job 重放不重复；摘要与最近几轮原文分块注入并声明「冲突以原文为准」；三条失败兜底（表缺失静默降级、模型失败沿用旧摘要、空输出不覆盖），避免摘要器故障清空记忆或阻断生成。

---

## 3. 量化数据速查（挑 3–4 个，必须能讲清口径）

| 数据 | 口径 / 出处 |
| --- | --- |
| 50+ 个提交、4 个包、176 个 TS/TSX 文件 | `git rev-list --count HEAD`；含 25 个测试文件，非测试 151 个 |
| 264 个测试用例 / 27 个测试文件；后端 102 全过；`pnpm build` / `pnpm typecheck` 通过 | 各包 `__tests__/`，含 P0 加固 18 个、并发隔离 4 个、工具层与 MCP 44 个、滚动摘要 30 个；`INTERVIEW_GUIDE.md` §0 |
| 6 个生产阶段、4 个人工门、29 类 WS 事件、16 个 stage 定义 | `shared/src/constants/{events,stages}.ts`、`agent/src/nodes/index.ts` |
| face-api 9 张图 41s → 1.8s（约 23×） | wasm 后端 + 模型单例缓存，`face.service.ts` |
| 一致性端到端 1.85s（6 镜头 / 3 角色） | project-23，`GET /consistency?refresh=1` |
| 人脸距离约 0.4 → 0.22；临时项目实测 0.2562 / `ok` | i2i 反哺对照，`shot-repair.service.ts` |
| 阈值 0.45 / 0.6；重试 8 次、退避封顶 120s | `consistency.ts`、`.env` `VIDEO_MAX_RETRIES` |
| 6 镜头成片约 34s、4/6 镜头含对白配音，输出 `final.srt` | 配音后成片；mean −24.9dB / peak −8.1dB |

> 提醒：
> - 简历里**最多放 3–4 个数字**，堆数字反而像编的。
> - 所有数字都是**本地演示环境**口径，被问到要主动说明，不要说成线上指标。
> - 「41s → 1.8s」「0.4 → 0.22」这类对比最有力，优先选。
> - 成片体积有 4.4MB（无配音）与 5.17MB（配音后）两个历史口径，简历里**只写时长与镜头数**，避免自相矛盾。

---

## 4. 措辞原则

**推荐动词**（按强度）：主导改造 / 重构 / 设计并实现 / 落地 / 收敛 / 治理 / 补齐 / 补齐闭环 / 消除。

**必须避免**：

| 不要写 | 原因 | 改成 |
| --- | --- | --- |
| 独立从零设计并开发 | 与开源二次开发的事实不符，背调必翻车 | 基于开源项目二次改造，主导 Agent 链路重构 |
| 参与 / 负责 / 协助了后端开发 | 弱动词，看不出你做了什么 | 写明具体动作与结果 |
| 实现了 AI 漫剧生成系统 | 没有信息量 | 写清「把固定流水线改造成可解释、可恢复的多 Agent 系统」 |
| 自研多 Agent 框架 / 分布式高可用 | 没做过（MCP 已接入，可以写，但要写清「官方 SDK + 自实现兜底」） | 删掉；见 §7 诚实红线 |
| 大幅提升性能、显著优化体验 | 无数字 | 41s → 1.8s、距离 0.4 → 0.22 |
| LangGraph / NestJS / PostgreSQL / Redis / Zod / WebSocket…（纯罗列） | 技术栈栏已经写过了 | 每条 bullet 只保留「解决问题所需」的技术词 |
| 上线后稳定运行 / 服务 N 万用户 | 原型项目，无生产流量 | 本地演示环境端到端跑通 |

**口语 → 简历语言对照**：

| 口述 | 简历 |
| --- | --- |
| 「模型老是被限流，我加了个队列」 | 针对 LLM 429 设计进程级串行队列，优先解析 `Retry-After`，否则指数退避 + 抖动，耗尽后抛明确错误并保留已完成素材 |
| 「让 AI 自己决定要不要跑某一步」 | Director 依据题材生成受白名单与必需阶段约束的执行计划，非法输出回退全链路，决策依据可回溯 |
| 「分镜不好就让 AI 重写」 | Critic 以四维 rubric 评分，未达标将 issues/suggestions 回灌下一轮生成，设轮次上限与人工兜底 |
| 「同一个角色每张图长得不一样」 | 以 128 维人脸 descriptor + 欧氏距离阈值自动检测角色漂移，并用参考图图生图反哺修正 |
| 「刷新页面还能接着确认」 | 人工门等待位置持久化至 DB，前端经 WS 恢复状态，确认后通过 Redis 消息恢复图执行 |

---

## 5. 关键词（过简历筛选 / ATS）

**中文**：多 Agent 编排、LangGraph、状态图、Human-in-the-Loop、LLM-as-Judge、意图规划、断点续跑、增量重生成、失败恢复、限流退避、WebSocket 实时同步、全栈 TypeScript、Zod 契约、人脸一致性、图生图。

**English**：multi-agent orchestration, LangGraph.js, state graph, human-in-the-loop, LLM-as-a-Judge, planner-executor, checkpoint & resume, incremental regeneration, retry with exponential backoff, provider abstraction, WebSocket, full-stack TypeScript, shared schema, face embedding, image-to-image.

> 关键词要**出现在 bullet 里**，不要单独堆一行「技能关键词」——筛简历的人看的是上下文。

---

## 6. 简历 → 面试联动（每条 bullet 都要能被追问）

| 简历 bullet | 口述展开 | 代码落点 |
| --- | --- | --- |
| Director 规划阶段 | INTERVIEW_GUIDE §2 案例 1 | `agent/src/agents/director.ts` |
| Critic 打回重写 | §2 案例 2 | `agent/src/agents/critic.ts`、`prompts/critic.ts` |
| 4 个人工门 + 续跑 | §2 案例 3 | `agent/src/nodes/index.ts`、`server/src/agent/agent.processor.ts` |
| 429 / 503 / 增量 | §2 案例 4 | `server/src/services/{text,video}.service.ts`、`agent/revision.service.ts` |
| 一致性闭环 | §2 案例 5 | `server/src/services/{face,consistency,consistency.service,shot-repair}.service.ts` |

**自检**：随便指一条 bullet，能否在 90 秒内讲清「当时什么问题 → 我为什么这么选 → 结果怎么验证 → 局限在哪」？讲不清就删掉或降格，别留着当雷。

---

## 7. 诚实红线（写了就是给自己挖坑）

- **没做的**：独立意图分类器、图像/视频多模态 Critic、provider 智能选路、字幕烧录。（checkpoint 持久化已在 P1-1 补齐，MCP 已在 P1-3 接入，CI 已在 P0 补齐。）
- **半成品**：工具层目前只有大纲节点接入（MCP 工具也挂在那里），其余阶段仍是硬编码 `AgentContext` 方法；MCP 只挂了素材库一个 server；长期记忆是单段滚动摘要，没有向量检索、不跨项目复用。
- **配置口径**：Critic 阈值统一为 `CRITIC_SCORE_THRESHOLD=6.0`（由 `agents/critic.ts` 读取），不再有 `CRITIQUE_*` 双前缀；启动期会校验数值合法性并告警。
- **原型局限**：免费模型 + 本地 PostgreSQL/Redis；face-api 对半透明、背影、非人形参考图检不出脸；i2i 修正手动触发且会清空该镜视频。
- **成本教训**：早期一次探测误用付费模型产生约 ¥17–27 费用，之后把 provider 全量配置化并定下「探测只读、最小单任务」规则 —— 这段适合口述，不适合写进简历。

> 主动交代边界比被问出来强。简历负责「让人想问」，[INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md) 负责「问了答得上」。
