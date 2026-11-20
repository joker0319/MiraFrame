# MiraFrame 全链路解读（前端 / 服务端 / Agent / shared）

> 目的：把「一次生成从点击到出片」的每个环节、每个文件、每个字段讲清楚。
> 所有结论都是读代码 + 实际运行验证过的，不是按目录猜的。
> 规模参考：shared 1426 行 / agent 1188 行 / server 3781 行 / frontend 7889 行。

---

## 0. 一句话总览

**前端点按钮 → REST 建 run → BullMQ 排队 → Processor 造 AgentContext → 跑 LangGraph 状态图 → 每个节点调 LLM/出图/出视频 → 撞到门就停、存 `awaiting_gate`、走 Redis 等人点确认 → 完成后 ffmpeg 合成。**

三层之间只有两个契约：

| 契约 | 位置 | 说明 |
| --- | --- | --- |
| `AgentContext` | `agent/src/agents/base.ts:3` | Agent 层唯一的对外出口。Agent 不认识 DB/HTTP/WS，只调这 10 个方法 |
| WS 事件 + REST 响应 | 前端 `useWebSocket.ts` / `projectsApi.ts` | 前端只认事件名和 JSON 字段，不认后端内部结构 |

---

## 1. 四层依赖方向

```
frontend  ──HTTP/WS──▶  server  ──import──▶  agent
    │                      │                   │
    └──────────┬───────────┴───────────────────┘
               ▼
            shared（类型 / 阶段名 / WS 事件 / Zod schema）
```

- `shared` 被三层共用，但**只放类型和常量，没有运行逻辑**。
- `agent` 是纯逻辑包：没有任何 NestJS、没有任何 DB 客户端、不 `fetch`。它的包依赖只有 `@langchain/langgraph` + `zod`。
- `server` 是唯一知道「数据库怎么连、模型怎么调、消息怎么推」的地方。
- `frontend` 只通过 `services/*.ts`（REST）和 `hooks/useWebSocket.ts`（Socket.IO）与后端打交道。

---

## 2. 一次生成的生命周期（逐步对照代码）

### 步骤 0：建项目

`POST /api/v1/projects` → `projects.controller.ts:46`
写 `project` 表：`title / story / style / target_shot_count`，状态 `draft`。

### 步骤 1：点「开始生成」

前端 `ProjectPage.tsx:153 handleGenerate()` → `projectsApi.generate(projectId)`
→ `POST /api/v1/projects/:id/generate` → `generation.controller.ts:18`

### 步骤 2：建 run + 入队

`AgentService.startGeneration()`（`agent.service.ts:88`）做四件事：

1. **先取消该项目所有 queued/running 的 run**（`:89` → `cancelActiveRunsForProject`）
   → 这就是「同项目同时只能跑一个」的实现方式，不是锁。
2. `INSERT agentrun`：`status=queued, progress=0`，并把 `patch_plan` 存成 feedback、`route_decision` 存成 feedbackType。
3. 生成 `threadId = thread-{projectId}-{runId}`（`:109`），回写进 run 行。
4. `generationQueue.add("execute-graph", input, {jobId})`，成功后把状态改成 `running`。
   **注意**：`jobId = generation:{projectId}:{runId}`，BullMQ 靠它去重。

同时推 WS `run_started`。

> REST 立刻返回 `202 {run_id, status:"queued"}`，前端只是把 `isGenerating` 置 true，真正的活全在 worker 里。

### 步骤 3：Processor 领取任务

`AgentProcessor.process()`（`agent.processor.ts:31`，`@Processor("generation", {concurrency: 8})`）

1. 查 run 状态，不是 running/queued 就直接 return（`:36-43`）——**取消后残留的 job 靠这里兜住**。
2. `buildPhase2Graph()` + `new MemorySaver()` + `compile()`（`:47-49`）
   ⚠️ checkpointer 是**每个 job 新建的内存实例**，进程一退出就没了。
3. 读 project 一行（title/story/style/targetShotCount/outline/visualBible）。
4. `buildProjectContext()`（`agent-run-state.ts:13`）拼出一段**文本**：
   项目标题、画风、目标镜头数、visual bible、**已审批的大纲 JSON**、本次反馈（含 entity/feedbackType/revisionMode）、story brief。
   这段文本后面会被拼到**每一次** LLM 调用的 user prompt 前面——**这就是这个项目的「记忆」**。
5. 构造 10 个方法的 `ctx` 对象（`:70-487`）。
6. `setNodeContext(ctx)` + `runWithNodeContext(ctx, ...)`（`:490-495`）双保险注入。
7. `buildInitialState(job.data)`（`agent-run-state.ts:40`）造初始 state。
8. 进入 `while (!isComplete && stepCount < 50)` 主循环（`:502`）。

### 步骤 4：图开始跑

`compiled.invoke(initialState, {configurable:{thread_id}})`。

图的入口是**条件边** `START → routeFromStart`（`graph.ts:24`），它直接返回 `state.currentStage`。
初始 `currentStage = targetStage || "plan_outline"`，所以：

- 首次生成 → 从 `plan_outline` 开始
- 审批大纲后 → 从 `plan_characters` 开始
- 改某个镜头 → 从 `render_shot_images` 开始

这就是「不用重跑全流程」的机制：**换入口，不换图**。

### 步骤 5：节点执行

以大纲节点为例（`nodes/index.ts:61` → `OutlineAgent.run`）：

1. `ctx.sendMessage("开始生成故事大纲...", {progress:0.05, isLoading:true, stage:"plan_outline"})`
   → processor 写 `message` 表 + 推 `run_message` + 推 `run_progress` + 更新 run.progress
2. `ctx.sendThinking(...)` → 推 `agent_thinking`（前端聊天气泡里的「思考中」）
3. `ctx.callLlm(system, user, {maxTokens, intent})`
   → processor 把 `projectContext + "\n\nTask:\n" + user` 拼起来，交给 `TextService.generate()`
   → `TextService` 按 `TEXT_PROVIDER` 决定走真实 HTTP 还是 `generateFakeResponse(intent)`
4. 解析 JSON（`extractJson` 先去 ```json 围栏，再正则抓第一个 `{...}`），失败就 `{raw: text}` 兜底
5. `ctx.saveOutline()` → 写 `project.story_outline / visual_bible` + 推 `outline_updated`
6. 返回 `{currentStage:"plan_outline", nextStage:"outline_approval", stageHistory:["plan_outline"], reviewRequested:false}`

**节点的返回值就是 state 的补丁**（LangGraph 的 reducer 语义：默认覆盖，`stageHistory` 是 concat）。

### 步骤 6：撞门

`plan_outline → outline_approval`（线性边，`graph.ts:34`）。
门节点（`nodes/index.ts:122`）只有一句 `interrupt({question, gate})`。

`interrupt()` 抛特殊异常 → 图挂起 → `invoke` 返回带 `INTERRUPT` 的结果。

Processor 拿到后（`:511-542`）：

1. **把 gate 写进 `agentrun.awaiting_gate`** ← 刷新页面能恢复按钮，靠的就是这一列
2. 推 WS `run_awaiting_confirm`：`{run_id, agent, gate, current_stage, question, auto_mode, story_outline?}`
3. `autoMode` 为真 → sleep 1s 自动 confirm；否则 `waitForConfirm()`（`:639`）

`waitForConfirm` 的机制：**订阅 Redis 频道 `generation:{projectId}:{runId}`**，最长等 30 分钟。
收到 `{action:"confirm"}` → resolve(true)；`{action:"cancel"}` → resolve(false)；超时 → resolve(false)。

### 步骤 7：用户点确认

确认有**两条完全不同的路径**，这是最容易看混的地方：

**A. 大纲门（特殊对待）**
`POST /projects/:id/approve-outline`（`generation.controller.ts:86`）
→ 把 `project.outline_approved = true`
→ **再调 `startGeneration({targetStage:"plan_characters"})` 起一个新 run**
→ 旧 run 被 `cancelActiveRunsForProject` 取消掉

也就是说：**大纲门不是「恢复」，而是「弃掉旧 run、从下一阶段开新 run」**。
（带 feedback 时则 `targetStage:"plan_outline"`，等于重生成大纲。）

**B. 其余三个门**
`POST /projects/:id/generate/:runId/resume`（`:64`）
→ `redis.publish(channel, {action: "confirm"})`
→ 卡在 `waitForConfirm` 的 processor 收到 → `graphInput = new Command({resume: true})` → 继续 while 循环 → `invoke` 从同一 thread 续跑。

续跑时 LangGraph 会**从头重跑门节点**，`interrupt()` 这次返回 `true` 而不是抛异常，于是 `isApprovedResume` 判定通过，写 `approvalHistory.outline = "approved"`，条件边走向下一阶段。

> ⚠️ 前端 `useWebSocket.ts:299` 的 yolo 模式会 `socket.emit("confirm", ...)`，但 **`WsGateway` 里只有 `@SubscribeMessage("join")`，没有 `confirm` 处理器**——这条 WS 通道是死代码，真正生效的是上面的 REST。

### 步骤 8：走到出片

`plan_shots → shots_approval → render_shot_images → shot_images_approval → compose_videos → END`

- `render_shot_images`（`nodes/index.ts:91`）：`generateShotFrames()` 逐镜出图 → `generateShotVideos()` 逐镜出视频（图生视频，传 `imageUrl` 当首帧）
- `compose_videos`（`agent/src/agents/compose.ts:9`）：`composeProjectVideo()` → `VideoService.composeVideo()` → 下载所有片段 → 写 `concat.txt` → `ffmpeg -f concat` → `static/exports/project-N/final.mp4` → 写回 `project.video_url`，`status=completed`

### 步骤 9：收尾

`invoke` 不再有中断 → `run.status = succeeded, progress = 1`，推 `run_completed`。
`finally` 里 `clearNodeContext()`。

---

## 3. Agent 层详解（1188 行，真正的改造区）

### 3.1 `state.ts` — 18 个字段

| 组 | 字段 | 谁写 | 谁读 |
| --- | --- | --- | --- |
| 身份 | `projectId / runId / threadId` | processor 初始化 | 无（调试用） |
| 位置 | `currentStage` | 各 Agent | `routeFromStart` |
| | `nextStage` | 各 Agent | **无人读**（只给前端展示） |
| | `stageHistory` | 各 Agent（`concat`） | 无人读 |
| | `routeStage / routeMode` | `review.ts` | `routeAfterReview` / 无人读 |
| 审批 | `approvalHistory` | 4 个门节点 | 4 个 `routeAfterX` |
| | `reviewRequested` | 各 Agent 恒 `false` | 4 个 `routeAfterX`（**永远为假**） |
| 质量 | `critiqueScores / critiqueRound` | 只有 `critic.ts` | 无人 |
| | `artifactLineage` | **无人写** | 无人读 |
| 反馈 | `feedback / feedbackType / entityType / entityId / revisionMode` | processor 初始化 | `outline.ts` / `plan.ts` |

**只有 `stageHistory` 有 reducer**（`:10-13`），其余 17 个都是「覆盖」语义。
`approvalHistory` 虽然是累积型，但没写 reducer，靠每个节点手写 `{...state.approvalHistory, x: "approved"}` 展开——漏一处就会清空别的门的结论。

### 3.2 `graph.ts` — 10 节点 + 3 类边

| 类型 | 内容 |
| --- | --- |
| 节点 | `plan_outline` `plan_characters` `plan_shots` `render_shot_images` `compose_videos` + 4 个 `*_approval` + `review` |
| 入口条件边 | `START → currentStage`（6 个可选目的地） |
| 线性边 | 5 条：生产节点 → 自己的门；`compose_videos → END` |
| 门条件边 | 4 条，每条登记「允许的去处」，返回值不在表里就会运行时抛错 |

**门的目的地登记表**（`graph.ts:45-62`）：

| 门 | 通过 | 拒绝 | 登记了拒绝目的地吗 |
| --- | --- | --- | --- |
| `outline_approval` | plan_characters | plan_outline | ✅ |
| `characters_approval` | plan_shots | plan_characters | ❌ **缺** |
| `shots_approval` | render_shot_images | plan_shots | ❌ **缺** |
| `shot_images_approval` | compose_videos | render_shot_images | ✅ |

### 3.3 `nodes/index.ts` — 三件事

1. **上下文注入**（`:16-58`）：`AsyncLocalStorage` 正常路径 → 全局 `_nodeCtx` 兜底 → mock 对象兜底（`callLlm` 返回 `"{}"`）。
   第三层让**失败静默化**：图照跑、WS 照推、产物全空，只有一行 WARNING。
2. **5 个节点函数**（`:61-112`）：都是 `agent.run(getNodeCtx(), state)` 的薄包装。
   例外是 `planCharactersNode`（`:66`）——它一个节点干两件事：生成角色描述 + 出角色图，节点粒度不纯。
3. **4 个门 + 6 个路由**（`:115-209`）：四个门除了 key 不同完全一致（应抽成工厂）；门节点**不写 `currentStage`**。

### 3.4 五个 Agent

| 文件 | 干什么 | 输出 |
| --- | --- | --- |
| `outline.ts` | 生成大纲 + visual bible | `project.story_outline`，返回 `nextStage=outline_approval` |
| `plan.ts::runCharacters` | 2-4 个角色（名 + 描述），逐个落库、同名则更新 | `character` 表；解析失败退化成「主角/配角」 |
| `plan.ts::runShots` | 4-8 个镜头（描述/运镜/场景/动作/对白/提示词/时长） | `shot` 表；按 `order` upsert |
| `compose.ts` | 调 ffmpeg 合成 | `project.video_url` |
| `render.ts` | **占位类，没接进图**，只发消息不发图 | — |
| `critic.ts` | **占位类，没接进图**，分数写死 8.5 / 8.0 | — |
| `review.ts` | 反馈路由引擎，按 `currentStage` 查表决定回哪 | `routeStage` |

### 3.5 `base.ts::AgentContext` — 10 个方法

| 方法 | 真实副作用（processor 里的实现） |
| --- | --- |
| `sendMessage` | 写 `message` 表 + 推 `run_message` + 推 `run_progress` + 更新 `run.progress/current_agent` |
| `sendThinking` | 只推 WS `agent_thinking`，**不落库** |
| `callLlm` | 拼 projectContext → `TextService.generate()` |
| `saveOutline` | 更新 `project.story_outline/visual_bible` + 推 `outline_updated` |
| `createCharacter` | 按 `(projectId, name)` 查重 → insert/update → 推 `character_created/updated` |
| `createShot` | 按 `(projectId, order)` 查重 → insert/update；**顺手生成 imagePrompt/videoPrompt**（缺省时用 `buildShotImagePrompt`） |
| `generateCharacterImage` | 逐角色出图（已有 imageUrl 跳过），写 `image_url/reference_images`；**任一失败就抛错** |
| `generateShotFrames` | 逐镜出图（已有跳过），写 `shot.image_url`；有失败就抛 |
| `generateShotVideos` | 逐镜出视频（已有可播放跳过），写 `shot.video_url`；失败把 `video_url` 置 null 并抛 |
| `composeProjectVideo` | 校验所有镜头都有视频 → ffmpeg 合成 → 写 `project.video_url/status` |

**关键性质：所有方法都是「读 DB → 调外部 → 写 DB → 推 WS」**。Agent 层看不到这些，只看到方法名。

---

## 4. 服务端详解（3781 行）

### 4.1 模块结构

```
AppModule
├── CoreModule        全局配置（app.config.ts: 环境变量 → app.* 命名空间）
├── DatabaseModule    Drizzle + Postgres（DRIZZLE 注入 token）
├── RedisModule       两个连接：REDIS_CLIENT（发布/普通命令）+ REDIS_SUBSCRIBER（订阅专用）
├── ServicesModule    Text / Image / Video / TTS / Face / Sidecar
├── WsModule          Socket.IO 网关，namespace = "ws/projects"，房间 = project:{id}
├── AgentModule       AgentService + AgentProcessor + RevisionService
├── GenerationModule  /generate /resume /approve-outline /feedback
├── ProjectsModule    projects / characters / shots 三组控制器
└── RuntimeConfigModule  /config 的读写与连通性测试（写回 .env）
```

### 4.2 三个 Service 的分工

| 类 | 职责 | 注意点 |
| --- | --- | --- |
| `AgentService` | 建 run、入队、取消、提交修改、启动时清理僵尸 run | 无锁，靠「先取消同项目活动 run」保证串行 |
| `AgentProcessor` | 795 行，唯一的「执行场地」：造 ctx、跑图、等门、落库、推 WS | concurrency=8，但同项目已被上游串行化 |
| `RevisionService` | 把「用户改哪里」翻译成 `targetStage`，并预清理（置空图片/视频） | 纯规则，无 LLM |

`RevisionService.targetStageFor()` 的映射（`revision.service.ts:18`）：

| entityType | feedbackType | targetStage |
| --- | --- | --- |
| outline | — | plan_outline |
| character/characters | — | plan_characters |
| shots | — | plan_shots |
| shot | script/dialogue | plan_shots |
| shot | 其他 | render_shot_images |
| project_video | — | compose_videos |
| 其他 | — | **review**（实际会落到 plan_outline，见 5.3） |

`prepareAssets()` 只做「让旧产物失效」：改角色图 → 清 `image_url`；改镜头视频 → 清 `video_url`；改画面 → 清图和视频。

### 4.3 七张表

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `project` | 项目主表，也是「事实上的记忆」 | `story_outline` `visual_bible` `outline_approved` `video_url` `status` |
| `character` | 角色 | `image_url` `reference_images` + 一整套 `approved_*` 快照字段 |
| `shot` | 镜头 | `image_prompt` `prompt` `image_url` `video_url` `duration` + `approved_*` 快照 |
| `shot_character_binding` | 镜头↔角色 多对多 | 目前**没被任何代码写入** |
| `agentrun` | 一次执行 | `status` `awaiting_gate` `progress` `thread_id` `patch_plan` |
| `message` | 聊天记录（含进度消息） | `agent` `role` `summary` `progress` `is_loading` |
| `agentmessage` | **未被使用的表** | 只有 schema 和 relations，没有任何读写 |

`awaiting_gate` 是整个 HITL 里最关键的一列：**它是唯一能跨进程存活的「我卡在哪个门」记录**。

### 4.4 WS 事件：发了 18 个，前端听了 25 个

实际发送：`run_started` `run_progress` `run_message` `agent_thinking` `run_awaiting_confirm` `run_confirmed` `run_cancelled` `run_completed` `run_failed` `character_created` `character_updated` `character_deleted` `shot_created` `shot_updated` `shot_deleted` `outline_updated` `project_updated` `bible_updated`

**前端监听但后端从不发**（预留）：`critique_result` `data_cleared` `version_created` `version_rollback` `audio_generated` `export_completed` `consistency_eval_completed` `error` `connected`（后者由网关在 join 时 emit）

---

## 5. 前端详解（7889 行）

### 5.1 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | `HomePage` | 首页/工作台 |
| `/projects` | `ProjectsPage` | 项目列表 |
| `/project/new` | `NewProjectPage` | 建项目，提交后跳 `?autoStart=true` |
| `/project/:id` | `ProjectPage` | 主工作台（核心） |
| `/universes` `/universes/:id` | 宇宙页 | **后端无对应接口** |

### 5.2 六个 store（Zustand）

| store | 装什么 | 谁更新 |
| --- | --- | --- |
| `projectStore` | project 全字段 + 一组扁平字段 | React Query 首次加载 + WS `project_updated/outline_updated` |
| `characterStore` | 角色列表 | Query + WS `character_*` |
| `shotStore` | 镜头列表 | Query + WS `shot_*` |
| `runStore` | isGenerating / currentStage / progress / awaitingConfirm / awaitingAgent / currentRunId | WS `run_*` |
| `messageStore` | 聊天消息流 | WS `run_message` / `agent_thinking` + Query 历史 |
| `chatPanelStore` `settingsStore` `themeStore` | UI 状态 | 本地 |

`projectStore` 里同时存在 `project` 对象和 `projectTitle` 这类扁平字段——因为 **Zustand selector 返回新对象会导致无限重渲染**（`ProjectPage.tsx:55` 的注释），所以只能拆成单值订阅。

### 5.3 刷新后「确认按钮还在」的完整链路

1. 页面挂载 → `useProjectWorkspaceData` 发 5 个 Query：project / characters / shots / messages / **latest-run**
2. `latest-run` 返回 `agentrun` 整行，含 `status` 和 `awaiting_gate`
3. `useProjectWorkspaceData.ts:81-99`：
   - `status` 不是 running/queued → `setGenerating(false)` + `setAwaitingConfirm(false)`
   - 是 running 且有 `awaiting_gate` → `setAwaitingConfirm(true, agentForGate(gate), run.id)`
4. `agentForGate()` 把 gate 翻成前端 agent 名（outline/characters/shots/frames）
5. `ProjectPage` 根据 `awaitingConfirm` 渲染「确认进入下一步」按钮（`:403`）
6. 生成中时 `latest-run` 每 5s 轮询一次（`:49`），兜住 WS 断线的场景

**注意**：这里恢复的只是「按钮显示」，不是图的执行状态——图还在原进程里挂着等 Redis 消息。**服务端重启后，卡在门上的 run 会被 `cancelStaleRuns` 判死**（`agent.service.ts:41`，启动时把 30 分钟前的 queued/running 全部 cancel）。

### 5.4 阶段映射（后端 → 前端）

`utils/workflowStage.ts:8`：

```
plan_outline→outline        outline_approval→outline_approval
plan_characters→characters  characters_approval→characters_approval
plan_shots→shots            shots_approval→shots_approval
render_shot_images→shot_images  shot_images_approval→shot_images
compose_videos→output       review→review
```

`resolveEventStage()` 优先读 `stage`，其次 `current_stage`；映射不到就返回 null（不改动 UI）。

### 5.5 确认按钮最终打哪个接口

`ProjectPage.tsx:167 handleConfirm()`：

```
if (awaitingAgent === "outline" 或 (有大纲但 outline_approved=false))
    → POST /approve-outline        （起新 run）
else
    → POST /generate/:runId/resume （Redis 放行当前 run）
```

这就是为什么「大纲确认」和「其余确认」在后端是两套完全不同的实现。

---

## 6. 已核实的断点与陷阱清单

按「会不会真的炸」排序。

| # | 位置 | 现象 | 影响 |
| --- | --- | --- | --- |
| 1 | `nodes/index.ts:35` | 没上下文时返回 mock（`callLlm` 返回 `"{}"`） | 失败静默：图跑完、消息正常、产物为空；现有 `graph.test.ts` 就靠它活着 |
| 2 | `graph.ts:50-57` | `characters_approval` / `shots_approval` 的拒绝目的地没登记 | **在角色门或分镜门点「拒绝」→ 抛 `Branch condition returned unknown destination`**，流程崩（已用探针实测） |
| 3 | `nodes/index.ts:122-172` | 四个门都不写 `currentStage` | `review.ts` 的 routeMap 以门名为 key，永远匹配不上，永远落到 `plan_outline` |
| 4 | 全仓库 | 没有任何地方把 `reviewRequested` 置 true | `review` 节点实际不可达；四个 `routeAfterX` 的第一行判断是死逻辑 |
| 5 | `graph.ts:65-69` | review 的目的地表只有 3 个，`review.ts` 会产出 5 种 | 即使接通也会抛错 |
| 6 | `agents/index.ts` | `CriticAgent` / `RenderAgent` 只被导出，没有进图 | 「质量评审」「角色图渲染」两个阶段是空壳；`critiqueScores` 运行时永远 `{}` |
| 7 | `ws.gateway.ts` | 只有 `join` 处理器 | 前端 yolo 模式的 `socket.emit("confirm")` 是死代码 |
| 8 | `agent.processor.ts:48` | checkpointer 在 `process()` 内新建 `MemorySaver` | 进程重启 = checkpoint 全丢；恢复只能靠 `awaiting_gate` 那一列，且 run 会被判死 |
| 9 | `agent.processor.ts:132` + `text.service.ts:42` | `callLlm(system, user)` 单轮 + 只拼 `[system,user]` | **没有多轮记忆**：`message` 表只用于展示，从不回灌进 prompt |
| 10 | `frontend/services` | `versionsApi / consistencyApi / exportApi / styleTemplatesApi / universesApi` 调用的接口后端不存在 | 这些功能是前端壳子，点了会 404 |
| 11 | `hooks/useWebSocket.ts:24` | WS 地址硬编码 `http://host:3000` | 非 3000 端口/HTTPS 部署会连不上 |
| 12 | `agent.service.ts:109` | `threadId` 每次新 run 都不同 | 跨 run 无法续跑同一个 thread；「继续上次」只能靠重跑阶段 |
| 13 | `db/schema.ts` | `agentmessage` 表、`shot_character_binding` 表无读写 | 预留结构，别当成已有能力 |
| 14 | `state.ts` | `artifactLineage` 从没被写过 | 增量重生成没有数据基础（P3 要补的第一块） |

---

## 7. 调试入口速查

| 想验证什么 | 看哪里 |
| --- | --- |
| 请求有没有进来 | `[processor] === Starting generation job ===`，打印 projectId/runId/threadId |
| LLM 实际收到什么 | `[processor:llm] userPrompt (first 120 chars)`；完整 prompt 在 `projectContext + Task` |
| 卡在哪个门 | `[processor] ⏸ Interrupted at gate="..."`，以及 `agentrun.awaiting_gate` |
| 确认有没有到 | `[processor:confirm] Received message on "generation:x:y"` |
| 前端收了什么 | 浏览器 console `[WS:recv] ← "event_name"` |
| 节点顺序 | `state.stageHistory`（唯一 concat 的字段） |

**本地跑一遍的推荐方式**：`.env` 里 `TEXT_PROVIDER=fake / IMAGE_PROVIDER=fake / VIDEO_PROVIDER=fake`，点生成 → 4 道门全手动确认 → 看 ffmpeg 是否合成。fake 模式下 `TextService.generateFakeResponse(intent)` 会按 `intent`（outline/characters/shots）返回固定 fixture，所以能完整走完流程而不用花钱。

---

## 8. 一页速查：文件 → 一句话

```
agent/src
  state.ts        18 字段的状态契约，只有 stageHistory 有 reducer
  graph.ts        10 节点 + 入口条件边 + 4 门条件边（目的地表在这里）
  nodes/index.ts  上下文注入 + 5 节点包装 + 4 门 + 6 路由（断链都在这）
  agents/base.ts  AgentContext 10 方法（三层之间唯一的缝）
  agents/outline.ts   prompt → JSON → saveOutline
  agents/plan.ts      角色描述 + 分镜脚本，按 name/order upsert
  agents/compose.ts   调 ffmpeg 合成
  agents/render.ts    占位，未接入
  agents/critic.ts    占位，分数写死
  agents/review.ts    按 currentStage 查表决定回哪（key 对不上）
  checkpointer.ts     MemorySaver（注释里写了生产该换 Postgres）

server/src
  agent/agent.service.ts    建 run / 入队 / 取消 / 提交修改 / 启动清理
  agent/agent.processor.ts  795 行核心：造 ctx、跑图、等门、落库、推 WS
  agent/agent-run-state.ts  projectContext 拼装 + 初始 state + 预设审批历史
  agent/revision.service.ts 反馈 → targetStage + 预清理旧产物
  ws/ws.gateway.ts          Socket.IO，房间 project:{id}，只有 join
  db/schema.ts              7 张表
  services/text.service.ts  OpenAI/Anthropic 兼容 + fake fixture
  services/image.service.ts DashScope 任务轮询 / OpenAI images
  services/video.service.ts 图生视频 + ffmpeg concat
  modules/generation/*      generate / resume / approve-outline / feedback
  modules/projects/*        projects / characters / shots CRUD

frontend/src
  pages/ProjectPage.tsx          工作台：5 个节点卡片 + 确认按钮 + 修订入口
  hooks/useWebSocket.ts          25 个事件 → 6 个 store 的映射表
  hooks/useProjectWorkspaceData.ts 5 个 Query + 刷新后恢复门状态
  stores/runStore.ts             isGenerating / awaitingConfirm / currentStage
  utils/workflowStage.ts         后端 stage → 前端 WorkflowStage
  services/client.ts             fetchApi 封装 + 静态资源 URL 处理
```

---

## 9. 读完之后应该能回答的 8 个问题

1. 点「生成」之后，第一个写库的动作是什么？（`INSERT agentrun`）
2. 图是怎么知道从哪个节点开始的？（`START` 条件边读 `currentStage`，初始值来自 `targetStage`）
3. 门停住时，状态存在哪里？（Postgres 的 `agentrun.awaiting_gate`；图的 checkpoint 只在内存）
4. 刷新页面后按钮为什么还在？（`latest-run` Query 读 `awaiting_gate` → `setAwaitingConfirm`）
5. 用户点确认，消息怎么送到 worker？（REST → `redis.publish` → `waitForConfirm` resolve）
6. 大纲确认为什么和别的门不一样？（它不 resume，而是起新 run 从 `plan_characters` 开始）
7. LLM 到底看到了多少历史？（只有 `projectContext` 那段文本 + 本次 feedback，没有多轮消息）
8. `AgentContext` 为什么是改造的入口？（加工具、加记忆、加真实评分，都得从这里长出来）
