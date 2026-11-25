# 面试脱稿速记卡

完整答案见 [`CAREER_HANDBOOK.md`](../CAREER_HANDBOOK.md) §3–§4。这里只留**讲出来的锚点**：每题一句话 + 三个关键词。先看左列题目自己复述，卡住了再看右列。

## Q1–Q13 速记

| 题                     | 一句话锚点                                                                                            | 关键词                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Q1 LangGraph vs 状态机 | 节点/条件边/中断点显式化，恢复靠 thread_id + checkpoint，14 节点有结构测试。                          | 显式状态图 · interrupt · thread_id     |
| Q2 让模型跳过阶段      | 只给「裁剪可选阶段」的裁量权：白名单 + 四个必需阶段 + 默认顺序重排 + 坏格式回退。                     | LLM 决策 · 确定性约束 · 回退           |
| Q3 HITL 落地           | 四个 interrupt 门，门名落库，前端靠 WS 恢复按钮，确认后经 Redis 恢复图。                              | interrupt · awaitingGate · resume      |
| Q4 断点恢复            | 产物/run/门/checkpoint 都在 PG；重启后 BullMQ 拾起，同 thread_id 从最后节点续。                       | PostgresSaver · job 重拾 · 30min 清理  |
| Q5 限流                | 两层：单 provider 退避重试扛抖动，跨 provider 候选链 + 熔断扛故障，保留素材可续跑。                   | 重试≠选路 · Retry-After · target_stage |
| Q6 质量评估            | 三层，可靠性倒序：face-api 数值门最硬 → 文本 Critic → 视觉模型最主观。                                | Critic · 128 维距离 · 视觉逐帧         |
| Q7 一致性不用纯 LLM    | 需要可复现门限做回归，向量距离能定 0.45/0.6；LLM 留给叙事和镜头语言。                                 | 可复现 · 欧氏距离 · 职责分开           |
| Q8 前端出身写了什么    | 全栈 TS：纸墨设计系统 + 工作台/一致性面板，后端 TTS/face-api/i2i，契约与事件对齐。                    | 语义 token · 工程化保障 · 全栈 TS      |
| Q9 和 EchoMind 关系    | 六大考点迁移到内容生成场景：Judge/路由/Monitor 共通，MCP 落地，记忆做滚动摘要。                       | 能力迁移 · MCP 真实 server · 滚动摘要  |
| Q10 最大技术债         | 四个已补：critique 事件、ALS 上下文、provider 选路、i2i 闭环；剩 SRT 外挂、单段记忆、进程内 WS/熔断。 | 已补四项 · 诚实边界 · 不影响主线       |
| Q11 并发不串号         | 只走 AsyncLocalStorage，取不到显式报错而非 mock；模块级只共享无状态 Agent 与 pg 连接池。              | ALS · 删全局兜底 · 8 并发测试          |
| Q12 MCP 接入           | 先自实现 200 行 stdio 搞懂协议，再换官方 adapters；连接层与转换层分开，节点零改动。                   | JSON-RPC · 分层 · isError 语义坑       |
| Q13 长会话记忆         | 增量滚动摘要：按用户发言分组，最近 5 轮原文 + 旧摘要合并，coveredThroughId 只前进。                   | 不是截断 · 合并摘要 · 失败不覆盖       |

## Q14–Q17 重点四题展开

### Q14 provider 降级与熔断

讲法分四步，别一上来讲实现：

1. **旧痛点**：只对同一 URL 重试。密钥失效/欠费/区域故障时，重试只是一路撞超时——用户等到「生成失败」而不是「换一家继续」。
2. **两层分工**：**重试负责抖动，选路负责故障**。候选链 `TEXT_PROVIDERS=a,b`，scoped 覆盖通用配置；不配就是单元素链，默认行为不变。
3. **熔断**：连续失败 3 次进冷却，指数翻倍封顶 5 分钟；到期放一个 half-open 探测。失败分类里 401/403 可切（主 key 坏了备 key 往往好），400/422 不切也不计入，否则坏 prompt 打穿整链健康度。
4. **两个被测试逼出来的设计**（这是加分点）：半开候选必须排最前，否则备一直健康、主冷却到期永远轮不到探测；全链冷却时 best-effort 试最早恢复的一家，不第一次就认输。

收尾边界：静态优先级 + 熔断，不是成本/延迟动态加权；状态在进程内，多实例要 Redis。

### Q15 漂移自动修复

核心一句：**缺口在编排，不在能力**——`ShotRepairService` 早就写好，只差调用方。

三道闸按成本从低到高：开关与预算（默认 2 镜）→ 图像链里至少一家非 fake 且有 key（`generateImage` 无 key 会静默返回占位图，不拦就会把真图换成灰底）→ 只修 `drift`，灰区 `review` 和 `unverifiable` 都不动。

预算按最严重角色距离降序取前 N，每镜只修一次。复检只认 `ok`/`review` 为修好，**`unverifiable` 不算**——没检出脸等于没证据。图先生成成功再写库并清 `videoUrl`，`data:` 占位图在写库前拦截。

为什么挂在生视频之前：新图直接进 `generateShotVideos`，不需要额外重合成，清 `videoUrl` 是正确性而非代价。

### Q16 视觉 Critic

先讲必要性：文本 Critic 不知道图长什么样，face-api 看不出六根手指、画风跑偏、构图切头；`CRITIC_SYSTEM_PROMPT` 的四维 rubric 早就写好，只是没人调——**不是新功能，是把已有设计接上**。

四个实现取舍：

- **批量**：一次带 4 张，提示词写死「图 N = 镜头 #order」对照表，不让模型自己数。
- **内联**：供应商访问不到我们的 `/static/`，压到长边 768 / JPEG 0.8 转 base64；透明 PNG 先铺白底。
- **解析**：总分取镜头均值不用模型自报（实测自报 9.9 但分项全 5）；漏评记 `missingOrders` 不补满分；`needs_regenerate` 只认布尔 true；重画要「标记 + 低于阈值」双条件。
- **重画路径**：复用 i2i 带参考图，拼 suggestions 而不是 issues（issues 说哪错，suggestions 才说怎么改），否则脸又漂了。

被追问「为什么不复审重画后的图」：审-改-审会在主观判定上无限花钱；改后仍过一遍可量化的人脸一致性检查。

### Q17 DOM 字幕

一句开场：**数据本来就是现成的**，`dialogue` 已拆给 TTS，字幕只是同一份数据的第二个出口，之前只接了「听得见」。

不做烧录有两个理由，**第二个更重要**：环境上本机 ffmpeg 无 libass；性质上烧录不可逆、改一句台词要重编码整条片子，和「可反馈、可增量重生成」这条主线冲突。DOM 层随时开关、导出 mp4 保持干净画面。

难点在**时间轴不在样式**：解析规则下沉 shared 共用一份 `parseDialogue`；按标点切 ≤18 字条、段内按字数分配时长；成片按 `shots[].duration` 比例缩放到真实总时长（冻结末帧会让硬累加越漂越远）；只监听 `timeupdate`，cue 真换了才 setState。

边界明说：导出 mp4 不带字幕，后端另有 `final.srt` 但没下载入口。

## 主动交代的边界（别等被问出来）

- 视觉 Critic 不审视频（要抽帧）、重画后不复审、复用文本链只换 `VISION_MODEL`。
- i2i 只修 `drift` 不修灰区；预算是「每次跑」不是全项目总量。
- 长期记忆是单段摘要，无向量检索、不跨项目复用。
- 熔断与 WS 广播都是进程内，多实例各算各的。
- `final.mp4` 不带 DOM 字幕；成片时间轴是比例估算，可能偏几百毫秒。
- 项目定位是学习/演示原型，不建议不改造直接上生产（ffmpeg/TTS/迁移/env/卷都没收口）。

## 代码定位（按题目跳）

| 讲什么               | 去哪找                                                               |
| -------------------- | -------------------------------------------------------------------- |
| 图结构 / 中断点      | `packages/agent/src/graph.ts`、`nodes/index.ts`                      |
| 并发隔离 / 恢复      | `agent.processor.ts`、`agent/src/nodes/index.ts`                     |
| provider 选路 / 熔断 | `server/src/services/provider-routing.ts`、`GET /api/v1/providers`   |
| i2i / 视觉 Critic    | `auto-repair.ts`、`keyframe-critic.ts`、`keyframe-critic.service.ts` |
| 字幕                 | `shared/src/utils/dialogue.ts`、`frontend/.../SubtitleOverlay.tsx`   |
| 前后端契约           | `packages/shared/src/types/*`、`constants/{events,stages}.ts`        |
