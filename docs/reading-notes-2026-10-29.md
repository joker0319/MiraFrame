# MiraFrame 源码阅读笔记 · 10/29

今天只解决了三个疑问，但把「门」这条线彻底走通了。

---

## 一、两道门，两条通道（今天最重要的结论）

| 门 | 点确认走哪个接口 | 实际发生什么 | 节点日志次数 |
|---|---|---|---|
| `outline_approval` | `POST /approve-outline` | 改 `project.outline_approved=true` → `startGeneration({targetStage:"plan_characters"})` → 先 cancel 旧 run → **新建 run（新 threadId）** → 图从 START 路由到 `plan_characters`，**永远不再经过大纲门** | 1 次 |
| `characters_approval` | `POST /generate/:runId/resume` | Redis publish `generation:{projectId}:{runId}` → `waitForConfirm` 醒来 → `Command({resume:true})` → **同一个 thread 内重放该节点** | 2 次 |
| `shots_approval` | 同上 | 同上 | 2 次 |
| `shot_images_approval` | 同上 | 同上 | 2 次 |

代码落点：

- 分叉在前端：`ProjectPage.tsx:167-174`，大纲门走 `approveOutlineMutation`，其余走 `resumeMutation`
- 大纲门：`generation.controller.ts:86-170`，`agent.service.ts:89` 第一步就是 `cancelActiveRunsForProject`
- 其余门：`generation.controller.ts:64-84` 只发 Redis，不碰图
- 唤醒：`agent.processor.ts:639-685`（`waitForConfirm`，30 分钟超时）→ `:579` 换成 `new Command({resume:true})`

**为什么必须两条通道**：`resume` 只能唤醒「当前挂起的节点」，改变不了「下一步走哪条边」——`routeFromStart` 只在 run 启动时执行一次。想跳过重新生成大纲直接进角色阶段，只能给新 run 塞一个 `currentStage=plan_characters`。

### 实测证据（project 15）

```
 id |  status   |  thread_id   |    awaiting_gate     | progress
 35 | running   | thread-15-35 | shot_images_approval |    0.8
 34 | cancelled | thread-15-34 |        (空)          |    0.2
```

日志里 `>>> [门]` 只有：`outline_approval 进入` ×1、`characters_approval 进入` ×2。确认分镜门之后再没出现 `characters_approval` → **不累积**。

---

## 二、门被进入 2 次的规律

- 次数 = **1 次首次进入 + N 次 resume**
- 不叠加：resume 只重放「当前挂着的那个节点」，前面已执行的节点在 checkpoint 里是 done，不会回退
- 会涨的两种例外：同一道门反复确认/拒绝；重新起 run 后从零计数
- **铁律**：门节点里 `interrupt()` 之前的代码必须无副作用（会因为 resume 重跑一遍）

---

## 三、checkpoint / checkpointer / MemorySaver

| 名词 | 是什么 |
|---|---|
| checkpoint | 一条记录：`channel_values`（state 快照）+ `next`（下一步该跑谁）+ `checkpoint_id` + pending 信息 |
| checkpointer | 存取这些记录的接口契约（`put` / `getTuple`） |
| MemorySaver | 最简陋的实现，一个进程内的 Map，key 是 `(thread_id, checkpoint_id)` |

**state 和 checkpoint 不是一回事**：state 只是数据；checkpoint = 数据 + 执行到哪了 + 元数据（含哪个节点挂在哪个 interrupt 上）。

代码落点（`agent.processor.ts`）：

```ts
const graph = buildPhase2Graph();
const checkpointer = new MemorySaver();          // :48  每个 job 新建一个
const compiled = graph.compile({ checkpointer });
const config = { configurable: { thread_id: threadId } };  // :52  thread-15-35
// :502-508  一个 while 循环反复 invoke，最多 50 步
graphInput = new Command({ resume: true });      // :579
```

**为什么 resume 要把节点整个重跑一遍**：JS 没法让函数暂停在中间再接着跑。恢复时只能从函数第一行重来，靠 `interrupt()` 第二次调用返回 `true` 而不是抛信号来「跳过阻塞点」。

**MemorySaver 的真实代价**：

| 场景 | 结果 |
|---|---|
| 同一 run 内确认门 | 正常，`while` 还在等，存档还在 |
| 进程重启 / `tsx watch` 热重载 | 图对象和存档一起没，run 再也 resume 不了 |
| 部署两个实例 | run 落到别的 pod 取不到存档 |
| 刷新浏览器 | 能恢复确认按钮，靠 `agentrun.awaiting_gate` 列（`:520-523`），**不是 checkpointer** |
| 30 分钟不点 | `waitForConfirm` 超时（`:554`），run 标记 `cancelled` |

**升级路径**：换 `@langchain/langgraph-checkpoint-postgres` 的 `PostgresSaver`，`compile({checkpointer})` 结构不变，`agentrun.thread_id` 列（`schema.ts:158`）已经是现成的槽位号 → 真断点续跑、跨进程恢复。这是改造计划里能写、面试能讲的一个点。

---

## 四、`nodes/index.ts` 的 5 块结构（216 行，真正的代码约 80 行）

| 行号 | 内容 | 要点 |
|---|---|---|
| 11-14 | `new` 4 个 agent | 模块加载时建一次，agent 本身无状态 |
| 17-58 | ctx 注入 | `_nodeCtx` 全局变量 + `AsyncLocalStorage`，都没有就返回 mock（**静默失败**，`callLlm` 返回 `"{}"`） |
| 61-112 | 5 个生产节点 | 多数是薄壳 `return xxxAgent.run(ctx, state)`；`planCharactersNode` 顺手生成角色图（职责不干净）；`renderShotImagesNode` 没有 agent，自己调三个 ctx 方法（业务逻辑漏到了节点层） |
| 115-178 | 4 道门 | 只做三件事：`interrupt()` → 拿 `resumeValue` → 写 `approvalHistory`。**门不决定去哪** |
| 185-216 | 5 个路由函数 | 读 state 写的事实，返回节点名。`routeFromStart` 读 `currentStage`，其余读 `approvalHistory.xxx` |

**为什么不能直接给节点传 ctx**：调用方是 LangGraph（`fn(state)`），而且函数在模块加载时就定义好了，那时候还没有 `projectId/runId`。正规做法是把 ctx 放进 `config.configurable` 用第二个参数取，这个项目没这么做。

**为什么门不直接返回下一个节点名**：技术上节点只能返回「state 的一部分」，返回字符串会当 state 更新；设计上是「节点写事实，路由做决策」的分工，路由函数是纯函数可以单测。

**节点 ≠ agent**：节点是图里的执行单元，agent 是业务逻辑。`renderShotImagesNode` 是节点，但把活自己干了。

---

## 五、代码地图

- **已读**：`state.ts` → `graph.ts` → `agents/base.ts` → `agents/outline.ts` → `agents/plan.ts` → `nodes/index.ts` + 两道门机制 + checkpoint/resume
- **在读**：`agent.processor.ts`（HITL 闭环）
- **待读**：
  1. `agent.processor.ts:557-600`（确认分支 / 取消 / 正常完成）
  2. `agent.processor.ts:639-685`（`waitForConfirm`）
  3. 4 个短 agent：`compose.ts`(14) / `render.ts`(36) / `review.ts`(29) / `critic.ts`(54)
  4. `processor` 里 `AgentContext` 的实现体（挑 `createShot` 一个方法）
  5. server 剩余：`agent.service.ts`、WS 网关
  6. 前端

---

## 六、待办 / 遗留

1. `nodes/index.ts:124` 和 `:140` 两处 `>>> [门]` 临时探针待还原
2. `packages/agent/tsconfig.json` 缺 `"types": ["node"]`（`tsconfig.base.json` 里 `lib:["ES2022"]` 的问题，不影响运行，tsx 不做类型检查）
3. 两个已验证的 bug：
   - 角色门/分镜门拒绝时报 `Branch condition returned unknown destination`（`graph.ts` 目的地图缺「回上一阶段」）
   - `review` 节点不可达：`reviewRequested` 从未置 true；`review.ts` routeMap 用门名作 key，而门节点从不写 `currentStage`
4. 未接入图：`CriticAgent`、`RenderAgent`；`shot_character_binding` 表零引用零数据
5. 本地环境：后端 `:3000`（日志 `/tmp/mira-server.log`）、前端 `:5173`（`/tmp/mira-web.log`）、全 fake provider 不需要真 key

---

## 七、下次从哪继续

先看 `agent.processor.ts:557-600`，盯着三个问题：

1. `557-570` 那个 `if (gate === "outline_approval")` 是干什么的？大纲门走新 run，这段还执行得到吗？
2. 为什么 `awaitingGate` 要写数据库，而 checkpoint 不写？
3. 图「正常跑完」和「被取消」，对 `agentrun.status` 分别改了什么？
