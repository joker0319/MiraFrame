# MiraFrame 修改说明

> 本项目基于 GitHub 上的一个开源项目进行二次修改与能力增强。以下记录本次修改的完整内容。

## 项目定位

MiraFrame 是一个全 TypeScript 的 AI 漫剧生成项目：从故事想法出发，用 LangGraph.js 编排多 Agent，生成故事大纲、角色设定、分镜脚本、角色图与镜头素材。

本次修改的目标，是把项目从**「工作流编排」**（节点与顺序写死在代码里、模型只负责生成文本）升级为**「具备 Agent 特征的系统」**（模型能自主决策、能理解多轮反馈、能增量复用产物）。

---

## 修改一：工具调用层 —— 让模型从「说」到「做」

**修改前**：`plan_outline` 节点里硬编码了「生成大纲 → 解析 JSON → 存库」三步，模型只是一个文本生成器，没有决策权。

**修改后**：

- 新增 `packages/agent/src/tools/` 工具层，包含纯 JSON Schema 协议、`ToolRegistry` 注册表、三个大纲工具（`write_outline_draft` / `save_outline` / `report_progress`）和多轮循环 `runToolLoop`。
- 模型根据上下文**自主决定调用哪个工具、以什么顺序调用**，流程不再写死。
- 工具执行失败时不抛异常中断，而是把 `ERROR: ...` 回填给模型，让它**自我修正重试**（测试验证了「首次传非法 JSON → 收到错误 → 二次改对」的路径）。
- 双通道设计：真实模型走原生 function calling；不支持时自动降级为 JSON 协议，同一套工具、同一个循环，只是传输格式不同。
- 相同工具连续调用 3 次强制收尾，**防止死循环烧 token**。

**意义**：这是 workflow 与 Agent 的分界线——下一步走哪条路，从代码决定变成模型决定。

---

## 修改二：多轮上下文 —— 让模型从「失忆」到「记得」

**修改前**：用户的每轮反馈虽然以 `role=user` 写入了 `message` 表，但处理器只写不读；模型只看到当前这一句话和项目快照，看不懂「把主角改回第一版，但保留结尾」这类指代。

**修改后**：

- 新增 `buildConversationHistory` 纯函数，把消息流配对成「用户反馈 → 系统回应摘要」的轮次链。
- 系统消息**只取 summary 摘要、不取正文**，避免把整份大纲和分镜塞进 prompt 导致 token 爆炸。
- 排除当前轮反馈，避免与项目上下文重复注入；只剩一轮时则保留，防止模型完全失去上下文。
- **保留原始轮次编号**，让模型理解「第一版 / 第三稿」指的是哪一轮。
- 末尾加显式提示，帮助模型理解否定式表达（「改回」「保留」「不要那个角色」）。
- 双层截断（最多 5 轮 / 2400 字符），历史再长也不会挤掉任务本身。
- 在处理器层统一注入文本通道与工具通道，**所有节点**（大纲、角色、分镜、质检）自动受益。

**说明**：这是会话上下文注入（context engineering），不是长期记忆系统——没有向量检索、没有记忆压缩。

---

## 修改三：增量重生成 —— 让改一处不再全量重跑

**修改前**：修改一个角色设定，所有分镜全部重新生成，耗时耗 token，且可能把已满意的镜头改坏。

**修改后**：

- 关键发现：state 里的 `artifactLineage` 字段全项目零引用；真正可用的持久化血缘是数据库里早已存在却从未写入的 `shots.characterIds`。由于 LangGraph state 按 run 隔离、checkpointer 在进程内，跨 run 血缘必须落数据库，因此基于 `characterIds` 建立血缘。
- 新增 `packages/server/src/agent/lineage.ts`：角色名匹配（全名 + 三字名取后两字简称）、影响面分析（`affected` / `reused` 分组）、血缘映射。
- `createShot` 自动把匹配到的角色 id 写入 `shots.characterIds`；采用**惰性加载**解决时序问题（角色在后续节点才创建，run 开头查询为空）。
- 修改角色时只把引用该角色的镜头 `imageUrl/videoUrl` 清空**标脏**，其余镜头产物直接复用——渲染节点原有的 `if (imageUrl) continue` 逻辑自动跳过，未改渲染层一行代码。
- 界面播报「N 个镜头重渲染 / M 个复用」。

**已知局限**：血缘靠分镜文本是否包含角色名做启发式匹配；若模型完全不提角色名则血缘缺失。更严谨的做法是让模型生成分镜时直接输出 `characterIds`。

---

## 验证

- 两包 `tsc --noEmit` 类型检查通过。
- 全量测试 **155 个通过**（修改前 140 个），新增工具循环集成测试、历史对话单元测试、血缘单元测试。
- 端到端集成测试实际跑通工具循环：`write_outline_draft → save_outline → 收尾`，大纲正确落库。

## 改动统计

- 本次提交 51 个文件，+5559 / -588 行。
- `.gitignore` 新增排除运行时导出的图片/视频产物（`packages/server/static/exports/`、`videos/`）。
- 移除了历史中一个早期遗留、指向旧项目数据库的失效 CI 配置。

---

## 补充：接入真实推理模型（Kimi k3）的兼容性修复

**背景**：默认 `.env` 用 `TEXT_PROVIDER=fake`，`generateFakeResponse()` 返回写死的「雨夜星灯」样本，**完全忽略用户输入**——因此输入任何提示词产物都一样。要真正让提示词生效必须接真实模型。

**接入 Kimi（Moonshot AI，OpenAI 兼容接口）的配置**：

```
TEXT_PROVIDER=openai
TEXT_BASE_URL=https://api.moonshot.cn/v1
TEXT_API_KEY=<你的真实 key>
TEXT_MODEL=kimi-k3
TEXT_ENDPOINT=/chat/completions
```

**踩过的三个坑与修复**（都已做成可配置项，对其他模型无副作用）：

1. **temperature 必须为 1**：kimi-k3 是推理模型，代码默认传 `0.7` 会报 400 `only 1 is allowed`。
   → 新增 `TEXT_FORCE_TEMPERATURE=1`，`generate()` 与 `generateWithTools()` 都用它覆盖 options。

2. **思考吃光 token 导致工具调用拿不到**：纯推理模式下 2500 tokens 全被 `reasoning_content` 消耗，`finish_reason=length`， tool_calls 为空，大纲阶段反复重试。
   → 新增 `TEXT_REASONING_EFFORT=low`（可选，不设置则不传该字段）。开启后 reasoning tokens 从 ~2500 降到 ~27，Function Calling 正常返回合法 JSON 参数。

3. **120s 超时不够**：推理模型生成角色 JSON 超过 120 秒触发 `AbortSignal.timeout`。
   → 新增 `TEXT_TIMEOUT_MS=300000`，替换两处硬编码的 120_000。

4. **429 限流**：该 Kimi 账号并发上限 1、RPM 上限 3，流水线/脚本连续请求会返回 429 `rate_limit_reached_error`，原先直接抛错中断生成。
   → `TextService` 新增带指数退避的 429 自动重试（优先读 `Retry-After` 头或错误信息里的建议秒数，加随机抖动），配置项 `TEXT_MAX_RETRIES=6`、`TEXT_RETRY_BASE_MS=1000`。
   → 新增进程级请求串行队列 `requestQueue`：所有 LLM 请求任一时刻只发一个，从源头消除"并发超限"型 429，重试只处理偶发 RPM 频率限制。网络层错误也一并重试。
   → `generateWithTools()` 里 429 重试耗尽后抛明确错误，不再误判为 `TOOLS_UNSUPPORTED` 去降级 JSON（降级只会再撞一次限流）。

**验证**：用「纸鸢引」提示词端到端跑通全部 6 阶段，状态 `succeeded`，产出角色「阿鸢 / 阿满 / 鸢婆婆 / 陈阿婆」、6 个分镜、成片 mp4——产物全部来自输入，不再是 fake 样本。另做了并发压测：同时发起 5 个请求，串行队列 + 自动重试后 5 个全部成功。两包 typecheck 通过。

## 补充：接入真实图像 / 视频生成（阿里云百炼 DashScope）

**背景**：接上 Kimi 后文本真实生成了，但 `IMAGE_PROVIDER=fake` / `VIDEO_PROVIDER=fake` 导致镜头图片返回固定 URL、镜头视频全部返回同一个 `dev_clip.mp4`，成片只是把这段固定素材拼接——用户看到"镜头都一样、成片是旧的"。

**探测结论**（_key 为百炼 `sk-ws-` 格式，与 Kimi `sk-ms-` 不同，是两家服务_）：
- 图像 `qwen-image-3.0`：可用，DashScope 原生 `multimodal-generation/generation` 接口返回真实图片 URL（项目 `image.service.ts` 用的正是此格式）。
- 视频：`wan2.7-t2v` 未开通（`AccessDenied.Unpurchased`）；`wan2.6-t2v` / `wan2.6-i2v` / `wan2.5-t2v-preview` / `wanx2.1-t2v-turbo` 已开通。项目流水线是"先出首帧图再图生视频"，故选 `wan2.6-i2v`。
- `wan2.6-t2v` 异步任务实测约 60 秒 `SUCCEEDED` 并返回真实视频 URL，接口格式与 `video.service.ts` 一致（`X-DashScope-Async: enable` + `output.video_url`）。

**配置改动**（仅 `.env`，代码无需改）：
```
IMAGE_PROVIDER=openai
IMAGE_MODEL=qwen-image-3.0
IMAGE_API_KEY=<百炼 key>
VIDEO_PROVIDER=openai
VIDEO_MODEL=wan2.6-i2v
VIDEO_API_KEY=<百炼 key>
VIDEO_MODE=image
```

**遗留（账户问题，非代码问题）**：端到端验证时图像阶段返回 `Arrearage: Access denied, please make sure your account is in good standing`——该百炼账户在验证过程中额度耗尽 / 欠费，生成类接口被拒（模型列表等非计费接口仍可访问）。需在阿里云百炼控制台充值或确认账户状态后，配置即可直接生效，无需改代码。

**注意**：LLM 请求已在客户端串行化并带 429 退避重试，密集请求仍会因 Kimi RPM 上限产生累计等待，属预期行为。

**费用教训**：为探测"哪个视频模型已开通"，用真实提交生成任务的方式循环试了 5 个模型，全部成功执行并按量扣费（约 ¥17–27）。正确做法应是只读查询开通状态，不提交真实生成任务。任何付费服务的连通性/可用性探测，必须先只读，且真正生成前告知用户镜头数与预估成本。

## 补充：切换到 Agnes AI 免费方案（文本 + 图像 + 视频全免费）

**背景**：百炼账户欠费后不能再生成，用户要求换免费模型。选用 Agnes AI（`api.agnes-ai.cn`，国内直连、OpenAI 兼容、三个模型均免费）。

**探测结论**（只读列模型 + 各提交 1 个最小任务验证，不再批量提交）：
- 域名：国内站 `https://api.agnes-ai.cn/v1` 有效（国际站 `apihub.agnes-ai.com` key 无效）。
- 文本 `agnes-3.0-flash`：`/chat/completions`，普通模型（非推理），temperature 0.7 可用，Function Calling 返回合法 JSON 参数——项目代码无需改。
- 图像 `agnes-image-2.5-flash`：`/images/generations`，返回 `data[0].url`（国内 COS 域名，可下载）——项目 OpenAI 兼容分支直接可用，无需改。
- 视频 `agnes-video-2.5-flash`：`POST /videos` 返回 `video_id`，轮询域名根路径 `/agnesapi?video_id=&model_name=`，状态 `completed` 时返回顶层 `url` 字段（国内 COS，可下载）。图生视频用 `mode=keyframe` + `first_frame=<图片URL>`。

**配置改动**（`.env`）：
```
TEXT_BASE_URL=https://api.agnes-ai.cn/v1
TEXT_MODEL=agnes-3.0-flash
TEXT_FORCE_TEMPERATURE=      # 清空：Agnes 非推理模型，无需强制 temperature
TEXT_REASONING_EFFORT=       # 清空：不传该字段
IMAGE_BASE_URL=https://api.agnes-ai.cn/v1
IMAGE_MODEL=agnes-image-2.5-flash
IMAGE_ENDPOINT=/images/generations
VIDEO_BASE_URL=https://api.agnes-ai.cn/v1
VIDEO_MODEL=agnes-video-2.5-flash
VIDEO_ENDPOINT=
VIDEO_TIMEOUT_MS=300000
```

**代码改动**（`video.service.ts`）：新增 Agnes 视频分支 `generateAgnesVideo()` + `pollAgnesVideo()`——`baseUrl` 含 `agnes` 时走 `POST /v1/videos`（body: model/prompt/mode/seconds/size/aspect_ratio/first_frame），再用 `video_id` 轮询 `/agnesapi`。`config/app.config.ts` 新增 `videoTimeoutMs` 配置项。

**验证**：2 镜头「纸鸢引」端到端跑通，`status: completed`——文本大纲「晨光纸香」、2 张各不相同的首帧图、2 段各不相同的视频（task_R7LCq8… / task_7CeSHl…）、成片 `final.mp4`（1.6MB，HTTP 200）。关键成果：镜头画面与成片不再是固定旧素材，全部按提示词真实生成。两包 typecheck 通过。

**注意**：Agnes 免费视频有限流（约 1 次/分钟），多镜头生成时任务会在服务端排队，属正常；免费政策可能调整，以官网为准。

### 修复：第 5、6 镜头视频生成失败（503 队列满）

**现象**：6 镜头项目只有前 4 个镜头出视频，第 5、6 个失败，重试多次仍失败，报 `镜头视频生成失败：镜头 5、6`。

**根因**：Agnes 免费视频有队列上限，连续提交多个镜头任务时服务端返回 `HTTP 503 {"code":"video_queue_full"}`。`generateAgnesVideo()` 原先遇到非 200 直接抛错、无任何重试；一旦某个镜头撞上队列满就中断整条流程。重试时已成功的镜头会被跳过（增量），但 5、6 仍会立刻撞上尚未清空的队列。

**修复**（`video.service.ts` + `config/app.config.ts` + `.env`）：
- `generateAgnesVideo()` 提交任务改为带重试的循环：503 / 429 / 502 / 504 或错误体含 `queue_full`/`队列已满`/`rate limit` 时自动重试。
- 退避策略：优先读 `Retry-After` 头，否则 `2^n` 指数（基础 8s，封顶 120s）再加 0–3s 随机抖动，避免多镜头同时重试再次撞满。
- 新增配置 `VIDEO_MAX_RETRIES=8`、`VIDEO_RETRY_BASE_MS=8000`。
- 非重试类错误（如 401、400）仍立即抛出，不浪费时间。

**验证**：项目 23 用 `target_stage=render_shot_images` 续跑（复用已有图片和前 4 个视频），日志出现 `[AgnesVideo] 提交被限流/队列满 (HTTP 503)，9s 后重试 (1/8)`，重试后镜头 5、6 均成功，`status: succeeded`，成片 `final.mp4`（4.4MB，HTTP 200）重新合成完成。typecheck 通过。

## 前端视觉重设计：纸墨设计系统

**动机**：旧视觉是典型的"AI 味"——蓝色主色 `#2563eb` + teal 副色、外链 Google Fonts 的 `ZCOOL KuaiLe` 卡通字体、圆点点阵背景、重投影 + 大圆角。用户明确表示不满意。

**方案**：改为「纸墨」体系，结构固定为「中性底 + 单一品牌点缀 + 三个语义色」。

**页面分类（同一套原理、两套强度）**
- A 类首页 `HomePage`：承担气质，允许氛围层与一次性入场。
- B 类 `ProjectsPage` / `ProjectPage` / `NewProjectPage` / `UniversesPage` / `UniverseDetailPage`：效率优先，零渐变、零光斑、零逐字动画，仅保留 ≤150ms 交互反馈。

**token（集中在 `src/styles/globals.css` 的 `@theme`，组件只引用语义类）**

| 类别 | 浅色（纸墨） | 深色（墨夜） |
|---|---|---|
| 页面底 | `#fcfbf8` | `#16150f` |
| 卡片面 | `#ffffff` | `#1c1b15` |
| 文字四级 | `#191917 / #54514a / #8b877c / #a9a49a` | `#f1eee4 / #c6c1b3 / #948f80 / #706b5d` |
| 描边 | `#e6e3da` / `#efede6` | `#333027` / `#282519` |
| 品牌 | `#8c1d2f`（深红，仅点缀） | `#c9576b` |
| 语义色 | error `#a12d24` / warning `#9a6f1c` / success `#3f6b4a` | 对应提亮值 |
| 字体 | 系统栈：PingFang SC / 思源宋体 / SF Mono | 同 |
| 主缓动 | `cubic-bezier(.22,1,.36,1)`，全站唯一 | 同 |

**关键做法**
- 删除 Google Fonts 外链与卡通字体，全部改系统栈（零外部资源）。
- 卡片用 `box-shadow: inset 0 0 0 1px` 做 ring 描边，不占布局宽度。
- 蓝色/青色/圆点点阵/重阴影全部替换为纸墨描边与语义色 tint。
- 风格选择器从 14 组彩色渐变改为「真实封面图（低饱和）+ 极小代表色点」，保留具体信息、去掉装饰。
- 工作台节点卡取消交错布局与手绘 SVG 连接线，改用 `01–05` 等宽编号表达顺序（更可靠、更少视觉噪音）。

**动效安全（A 类）**
- 元素默认可见；隐藏起始态只挂在 `[data-run='true'] .rise` 下。
- 挂载时置 `data-run=true`，`setTimeout` 1.4s 后移除，DOM 回到纯静态。
- `prefers-reduced-motion: reduce` 时隐藏态不生效，元素立即可见；全局另有 `animation-duration: .001ms` 兜底。
- 已用 headless Chrome 在 3.2s 后截图验证：内容完整可见，无白屏。

**验证**：`tsc --noEmit` 通过；`vite build` 通过（CSS 58.99 kB / gzip 11.18 kB）；浅色与深色（`data-theme=dark`）均截图核对，无白块残留、无对比度不足。业务逻辑与 API 调用未改动。

## 视觉重设计 · 收尾轮（未迁移界面 / 暗色主色 / 短缺口）

**背景**：首轮重设计覆盖了五大页面，但 `UniverseDetailPage`、`NodeDetail`、`SettingsDialog`、chat 组件仍是旧 DaisyUI 语汇（emoji 标题、`rounded-2xl`、`shadow-2xl`、`bg-primary/5` 色块），与纸墨系统不一致。

**本轮改动**
- `globals.css`
  - 补 `@utility btn-error` / `btn-success`（`NodeDetail` 里 3 处在用但从未定义，属真空缺），改为描边+浅 tint，不抢主按钮。
  - 新增 `--color-primary-fill` / `--color-primary-fill-foreground`：实心填充与「文字用主色」解耦。
  - 暗色 `--color-primary` 由 `#c9576b`（偏粉）调为 `#d4747f`（仅作文字/描边点缀），实心填充用 `#9c2e3c` + 米白文字 `#fbf6ef`。修掉暗色下主按钮变「亮粉块」的问题，同时保证文字对比度。
  - `btn-primary` / `checkbox:checked` 改用 fill token。
- `UniverseDetailPage`：整页重写（业务逻辑、API 调用未动）。去 emoji，改 lucide 图标；去掉重复的返回链接；标题区改 eyebrow + 衬线 h1 + 等宽计数；章节列表改 `01–04` 等宽编号行 + hover 才出现的删除按钮；世界观/风格规则改为标签 + 正文块；共享角色卡改 4:3 图位 + 衬线名字 + 描边标签 + 等宽版本号；弹窗改 `bg-black/35` + card + 无 `shadow-2xl`。
- `NodeDetail`：31 处旧类名归一（`text-muted-foreground`→`ink-3`、`border-base-200`→`line-soft`）；面板/卡片统一 `rounded-[6px]` + inset ring 描边；标题改 14px medium + 等宽 metric；角色/分镜卡、大纲预览改 eyebrow 标签 + 12.5px 正文；错误块改用 `error-tint` + tint 描边；删除 `btn-outline btn-error` 叠加（改单一 `btn-error`）。
- `SettingsDialog`：容器改 `bg-paper` + `ring-line` + 柔和投影；左栏 active 态改白面 + 描边；测试结果块改 tint + tint 描边；字段卡改 inset ring + 等宽 `source`。
- `ChatPanel` / `ChatDrawer` / `MessageInput` / `MessageList` / `OutlinePreviewCard`：emoji（🎬🎨💡）换成 `Film`/`Palette`/`Lightbulb`；气泡改 `rounded-[6px]`、用户侧用 5.5% 品牌 tint + 12% 描边；结构化输出卡头改 tint 底色 + 11px 副标；大纲预览卡改 10% 等宽 eyebrow。
- `ui/modal.tsx`：`bg-black/50`→`/35`、`rounded-2xl`→`rounded-[8px]`、`shadow-lg`→显式柔和投影 + ring；标题改衬线。

**验证**
- `tsc --noEmit` 0 错误；`vite build` 通过（UniverseDetailPage 9.60 kB / gzip 3.14 kB）。
- 截图核对：首页、项目列表、工作台、宇宙列表、宇宙详情（浅色 + 墨夜）、设置弹窗。
- 宇宙详情页数据用 CDP `Fetch` 拦截 mock 注入（含 OPTIONS 预检），因为后端无该接口，见下。

**发现（未修，待确认）**
- 后端只有 `config` / `projects` / `characters` / `shots` / `generation` 五个模块，**没有 universes 接口**，`db/schema.ts` 也没有 universes / shared_characters 表（仅 projects 上留了 `universe_id` 列）。
- 因此 `/universes` 与 `/universes/:id` 实际永远是空状态/「宇宙未找到」，IP 宇宙是纯前端空壳。已如实告知用户，未擅自实现后端。

## IP 宇宙下线（止血）

**决策**：后端从来没实现 universes 模块（只有 config / projects / characters / shots / generation），`db/schema.ts` 里也没有 universes / shared_characters 表，只在 projects 上留了个没人用的 `universe_id` 列。前端 `/universes` 与 `/universes/:id` 因此永远是空状态 /「宇宙未找到」，新建页还有个必然 404 的「关联宇宙」下拉。选「先下线、想清楚产品形态再建表」，避免点进去就是坏页面。

**改动**
- `App.tsx`：删除 `UniversesPage` / `UniverseDetailPage` 的 lazy import 与两条路由；`/universes` 和 `/universes/*` 改为 `<Navigate to="/projects" replace />`；新增 `<Route path="*">` → 首页兜底（原来未知路径是白屏）。
- `NewProjectPage.tsx`：移除 `universesApi` import、`FormData.universe_id`、`useQuery(["universes"])`、第一步的「关联宇宙（可选）」下拉及其说明文案、第三步的「宇宙 #id」徽标。创建 payload 不再携带 `universe_id`（后端默认 null）。
- `UniversesPage.tsx` / `UniverseDetailPage.tsx` / `services/universesApi.ts`：文件保留作设计留档，顶部加「已下线」注释说明原因与恢复前提，不再被任何路由引用。
- `types/index.ts` 的 `Universe*` 类型、`projectStore` / `useWebSocket` 的 `universe_id` 同步字段保留（后端 projects 表确有该列，删了反而要对齐 WS 协议）。

**验证**
- `tsc --noEmit` 0 错误；`vite build` 通过，产物中已无 UniversesPage / UniverseDetailPage chunk。
- CDP 实测：`/universes` → `/projects`、`/universes/1` → `/projects`、`/this-does-not-exist` → `/`，页面内均无「宇宙」字样；`/project/new` 第一步只剩「项目标题 / 故事内容」，布局无空洞。

**恢复前提（备忘）**：需先补 `universes` / `universe_projects` / `shared_characters` 三表 + 模块 + 接口，再接回两个页面与 TopBar 入口；核心待定问题是「跨项目角色一致性与复用」的产品规则。

## 对白配音：从「会动的分镜」到「能听的漫剧」

**背景**：成片 31 秒、6 个镜头，ffprobe 只有模型自带的环境底噪（mean −17.7dB），没有人声。分镜 `dialogue` 字段写得很完整（含「轻声」「画外音/闪回」），但一句都没进成片；`TtsService` 与 `FaceService` 写好后一直只挂在 `services.module` 的 providers 里，从未被调用。

**为什么不用 edge-tts**：`edge-tts-universal@1.4.0` 已是最新版，但微软端点固定返回 403 —— 手动按库的算法生成 `Sec-MS-GEC` 签名后握手仍被拒，直连与走代理结果一致，说明是令牌/协议轮换而非网络问题。因此改用 macOS 系统 `say`：离线、零成本、中文音色齐全，代价是仅限 macOS。

**踩到的坑**：`say -v Sandy` 会匹配到英文版并输出 0.016 秒的近乎空音频，必须写全名 `Sandy (中文（中国大陆）)`。代码里做了「音频小于 4KB 即判定失败并降级」的保护。

**新增与改动**
- `services/dialogue.ts`（新）：解析「角色（语气）：『台词』」，剥离说话人与舞台指示；按名字/角色描述推断性别年龄选音色，同一角色哈希稳定；语气（轻声/大喊/画外音）转成语速与音量微调；`无台词…` 这类纯音效描述不产生配音。
- `services/tts.service.ts`：重写为可切换引擎（`TTS_PROVIDER=macos|edge|none`），带超时、空音频检测、音色降级、`probe()` 自检与音色列表缓存。
- `services/video.service.ts`：`composeVideo` 增加第三参 `{ dialogues, characterDescriptions }`。逐镜头合成人声 → 原音轨压到 `TTS_BGM_VOLUME`（0.08 ≈ −22dB）作底噪 → 人声延迟 250ms 进主轨 → 台词超长时先 `atempo` 加速（上限 1.2，保音高）再 `tpad` 冻结末帧补画面 → 统一重编码后 concat。同时输出 `final.srt`。
- `agent.processor.ts`：合成前查分镜台词与角色描述，一并传给 `composeVideo`。
- `config/app.config.ts`：新增 `ffprobePath` 与 `TTS_PROVIDER / TTS_RATE / TTS_VOICE_MAP / TTS_VOICE_FALLBACK / TTS_TIMEOUT_MS / TTS_LEAD_MS / TTS_MAX_TEMPO / TTS_BGM_VOLUME`。

**验证**
- `dialogue.test.ts` 15 个用例（多角色连排、无台词描述、画外音、动作提示、裸文本、镜头说明冒号、音色稳定性、语气影响）。
- 后端测试 28 个全通过，`tsc --noEmit` 0 错误。
- 用 project-23 的真实 6 个镜头与台词重跑合成：34.3 秒（原 31 秒，长台词镜头各延长 0.4–1.1 秒），4/6 镜头带配音，人声区 mean −24.9dB / 峰值 −8.1dB，无台词镜头保留原环境声，句间停顿 0.5–0.7 秒，抽帧无黑边无花屏。旧成片备份为 `final-novoice-backup.mp4`。

**已知限制**
- 逐镜头独立配音再拼接，不跨镜头做整体音量归一，镜头间响度会有差异（原片环境声音量本身从 −53dB 到 −13dB 不等）。
- 无台词镜头保留原声，若原声本身接近静音（如镜头 1 的 −53dB），观感上会是「默片段」。
- 字幕只生成 `.srt` 外挂文件，未烧进画面（避免中文字体缺失），前端也还没有字幕显示 UI。

## 角色一致性校验：把「写好了没接线」的人脸模型真正跑起来

**背景**：`FaceService` 存在已久，但只在 `services.module` 的 providers 里挂着，全仓零调用；`characters` 表有 `face_embedding` / `reference_images` 两列也从没写入过。单测跑一遍才发现它**从来没加载成功过** —— 日志里每行都是 `failed to load models: The highest priority backend 'wasm' has not yet been initialized`，被 `console.warn` 吞掉，看起来"只是没用到"，实际是"跑不起来"。

**三个必须踩的坑**
1. **后端没初始化**：`face-api.node-wasm.js` 需要先 `setBackend` + `ready`。最初切到 `cpu` 只是能跑，但纯 JS 后端一次 SSD 要 4.5 秒（9 张图 41 秒）。真正的解法是把 wasm 后端拉起来：bundle 内部 `require("@tensorflow/tfjs-backend-wasm")`，所以只要对同一份模块 `setWasmPaths(dist)` 再 `setBackend("wasm")`，速度直接到 **1.8 秒 / 9 张图**（约 23 倍）。cpu 作为兜底保留。
2. **媒体类型注入**：face-api 用 tfjs env 里的 `Image`/`Canvas` 做 `instanceof` 判断，只改 `globalThis` 无效，必须 `faceapi.env.monkeyPatch({ Canvas, Image, ImageData })`，否则报 `toNetInput - expected media to be of type HTMLImageElement`。
3. **`face-api.node.js` 这条路走不通**：它 `require("@tensorflow/tfjs-node")`，而 pnpm 的隔离结构下 face-api 的目录里解析不到这个包（服务端 node_modules 里有，但那是给我们的代码用的）。

**改动**
- `services/face.service.ts`：重写初始化（wasm 优先 + cpu 兜底 + `env.monkeyPatch`）；新增 `detect(pathOrBuffer)` 返回原图坐标 + 128 维 descriptor，检测前按长边缩到 640；保留 `detectFaces(base64)` 兼容 sidecar。
- `services/consistency.ts`（新，纯函数）：判定逻辑。多角色同框用「全局最近优先的贪心指派」，保证一张脸只对应一个角色；额外人脸分三类 —— `other_character`（别的已登记角色）、`lookalike`（和本镜已指派的角色撞脸，多半是重复检出）、`unknown`（谁都不像）。
- `services/consistency.service.ts`（新）：下载图片（按 URL 哈希缓存到 tmp）、跑检测、调判定。进程内按 URL 缓存检测结果，重复调用不重算。
- `GET /api/v1/projects/:id/consistency?refresh=1`：按需计算返回报告，并把逐镜结论写回 shot（镜头图自动生成时也会写，见下一节）。
- `ConsistencyPanel.tsx`（新）：挂在「角色设定」「镜头画面」两个节点的详情面板底部，进入即自动检查一次，可「重新检查」；顶部汇总 + 每镜一行（编号 / 状态点 / 结论 / 右侧各角色距离）。
- `consistencyApi.ts` + `types/index.ts`：原来那套 `consistency-eval` / `consistency-report` / `eval_id` 的契约是设想中的异步方案（要建表存报告、跑后台任务），后端从未实现，前端也从没调用过 —— 连同 `FaceMatchDetailRead` / `CharacterConsistencyRead` / `ProjectConsistencyRead` 一并替换成实际契约。

**判定规则（可配置）**
- ≤ 0.45 一致；0.45–0.60 待确认；> 0.60 漂移（阈值 `FACE_OK_DISTANCE` / `FACE_DRIFT_DISTANCE`）。
- 参考图检不出脸的角色标 `no_reference`，**不参与判定也不算失败**，因为「检不出脸」不等于「长得不像」；若该镜头又出现陌生脸，提示里会补一句「可能是无法校验的 X」。

**project-23 实测（6 镜头 / 3 角色）**
- 沈鸢 4 个镜头 0.36–0.41（一致），2 个镜头 0.46（灰区，待确认）；镜头 3 另有一张脸也接近沈鸢（0.51）。
- 阿砚（半透明少年亡魂）参考图**检不出人脸**，无法自动校验 —— 这不是 bug，是检测器对人形半透明轮廓的固有限制。
- 镜头 4、6 各检出 1 张未登记人脸（0.73 / 0.64），后者提示可能是阿砚。
- 端到端 1.85 秒（含 9 张图下载 + 推理），命中缓存后更快。

**验证**：新增 16 个单测（多角色同框不抢脸、灰区措辞、缺人、无参考图不诬告、多参考图取最近、陌生脸/撞脸分类）；后端 44 个测试全通过；`tsc` 0 错误；浅色 + 墨夜双主题截图核对。

## 一致性校验接入生成流水线：镜头图一完成就自动查

**目标**：一致性面板原来要用户手动点进节点才知道结果。现在 `render_shot_images` 阶段一结束（含续跑 `target_stage=render_shot_images`）自动跑同一套校验，把结论写到每个镜头，工作台节点卡直接提示。

**改动**
- `shot` 表新增 `consistency_result` JSONB 列（迁移 `0002_tired_boomer.sql`），存 `ShotResult + checkedAt`。镜头图或角色参考图被重生成时立即清成 null，避免红点滞后。
- `ConsistencyService.analyzeAndStore()`：跑完判定后逐镜写库；`analyze()` 改为进程内串行队列 —— face-api 的 wasm 后端并发调用不安全，多个生成 worker 同时到达时排队而不是一起踩内存。
- `AgentProcessor.autoCheckConsistency()`：挂在 `generateShotFrames()` 末尾。人脸模型未就绪、图片下载失败只 warn，**不阻断生成流水线**；完成则发 `consistency_eval_completed` WebSocket 事件（`source=auto` + 逐镜结果）让前端即时更新。
- 前端：`Shot` 类型与 `normalizeShot` 认识 `consistency_result`；新增 `setShotConsistency` store action；节点卡在 `drift > 0` 时标题旁出现红点（hover 显示漂移/待确认数量）；「镜头画面」详情里漂移镜头直接标「角色长相漂移」。
- `GET /consistency?refresh=1` 也复用 `analyzeAndStore()`，手动复查与自动校验写的是同一份字段。

**为什么只给 drift 红点**：`review`（0.45–0.60 灰区）本身是不确定而非明确失败，已经由面板的黄色「待确认」呈现；节点卡红点只报确定的漂移，避免每个项目都常亮。

**验证**：后端 45 个测试全通过（新增 `consistency-auto.test.ts` 覆盖落库与时间戳）；前端 `tsc` 0 错误、`vite build` 通过。project-23 以 `target_stage=render_shot_images` 续跑，日志出现 `自动一致性检查完成 project=23 ok=2 review=4 drift=0`，6 个镜头的 `consistency_result` 全部落库，接口 `/projects/23/shots` 正常返回；临时把一个镜头改成 drift 后截图确认「角色设定」「镜头画面」节点卡红点出现，随后已恢复原值。

## 一致性反哺：按角色参考图重画漂移镜头

**目标**：校验只是发现问题，这一步提供修正闭环 —— 把镜头绑定角色的参考图喂给图生图模型重画该镜头，让人脸特征回到参考形象上。

**探测结论**：Agnes Image 2.5 Flash 支持图生图/多图合成，参考图必须放在 `extra_body.image`，`response_format` 必须也在 `extra_body` 里（放顶层会报错），官方标注输出图和参考图当前都免费。用 project-23 的沈鸢参考图 + 镜头 4 的原提示词做了一次单图对照：沈鸢人脸距离从灰区约 0.4 降到 0.22（判定转为一致），因此确认这条路径有效。

**改动**
- `ImageService.generateImage()` 新增 `referenceImages` 选项；抽出的 `buildAgnesImageBody()` 只在有参考图时加 `extra_body.image`，文生图请求体保持不变，不影响既有生成链路。
- `ShotRepairService`（新）：按 `shot.character_ids` 取角色图 + 参考图（每角色最多 3 张、全镜最多 4 张），拼一段「逐张说明参考图属于谁、保留原分镜与画风、不要增加角色」的提示词，走图生图重画；成功后清掉旧视频与旧一致性结果，再只对这一张跑人脸校验并把结果写回。参考图缺失直接报明确错误；人脸推理失败只 warn，不回滚已换好的图。
- `POST /api/v1/projects/:id/shots/:shotId/regenerate-with-references`：返回 `before/after` 判定与参考图数量，并发 `shot_updated` WebSocket。
- `ConsistencyService.analyzeShotAndStore()`：单镜头校验写回，不必为一张图重跑整页。
- `ConsistencyPanel.tsx`：`review` / `drift` 镜头多一个「按参考图修正」按钮，重画后自动刷新报告并提示新判定；沿用纸墨语义色与 `btn` 工具类。

**验证**：新增 5 个单测（请求体结构、提示词映射、参考图收集、写入字段、无参考图早失败）；后端 50 个测试全过，前后端 `tsc` 0 错误，`vite build` 通过。用一次性临时项目端到端调用新接口：生成 i2i 新图，沈鸢距离 0.2562、判定 `ok`，结果落库并广播 `shot_updated`，随后临时项目已删除，project-23 数据未改动。

---

## P0 加固：安全收口、配置治理、工程卫生、最小 CI

- **安全**：新增 `modules/config/admin.guard.ts`，`PUT /api/v1/config` 与 `POST /test-connection` 受 `X-Admin-Token` 保护（前端 `fetchApi` 已统一注入该 header）；未配置 `ADMIN_TOKEN` 时视为本地开发模式放行，由启动日志明确告警。移除无调用方的明文 `reveal` 接口及前端 `revealValue`。`main.ts` 的 `enableCors()` 改为读取既有 `app.corsOrigins` 白名单；WS 网关共用同一套解析，`join` 增加项目 ID 格式校验与 DB 存在性校验（抽成零依赖纯函数 `ws/room.ts`）。
- **配置治理**：新增 `config/cors.ts`、`config/startup-check.ts`（Zod 启动期诊断，只告警不 fail-fast，保留 fake provider 与运行时补配能力）；统一 Critic 前缀为 `CRITIC_SCORE_THRESHOLD=6.0` / `CRITIC_MAX_ROUNDS=2`，删除 `app.config.ts` 里无人消费的 `CRITIQUE_*` 与 `DOUBAO_*` 字段、`.env` 重复 `TTS_ENABLED`、DOUBAO 配置段及视频服务中的豆包兜底引用。
- **工程卫生**：删除 agent 层三处调试探针日志、已下线的宇宙页面与 `universesApi`（含两处 barrel 导出）、`db:push` 脚本；挂载此前定义但未使用的 `ErrorBoundary`；删除 `getProviderLabel` 里的 doubao 死映射。
- **CI**：新增 `.github/workflows/ci.yml`（`install --frozen-lockfile` → `build` → `typecheck` → `pnpm -r test`）；移除空转的 `test:e2e` 脚本（无 playwright 依赖与配置）。
- **验证**：`pnpm build` / `pnpm typecheck` 全通过，全仓 **167 个测试全过**（新增 `p0-hardening.test.ts` 18 个，覆盖 CORS 解析、房间 ID、常量时间比较、AdminGuard 四种分支、启动诊断六类告警）。后端进程在本环境未能后台拉起，端到端 curl 验证留待后续。

---

## P1-1 checkpoint 持久化：图执行位置落 PostgreSQL

**动机**：`checkpointer.ts` 导出了 `createCheckpointer()` 却全仓无人调用，`agent.processor.ts` 每个 job 都 `new MemorySaver()`。进程重启后 BullMQ 会重新拾起同一个 job，但内存里的图状态已经没了，于是整条生成从头再跑——这是「多轮记忆」与失败恢复里最实的一块短板。

**改动**
- `agent/src/checkpointer.ts`：`createCheckpointer(connectionString?)` 改为异步。有连接串时用 `PostgresSaver.fromConnString()` + `setup()` 幂等建表（`checkpoints` / `checkpoint_blobs` / `checkpoint_writes`），进程级共享同一个 saver（内部持有 pg.Pool，每 job 新建会打爆连接数）；没有连接串（单测、纯内存演示）仍退回 `MemorySaver`。建表失败不缓存坏 Promise，下一次 job 可以重试。新增 `resetCheckpointer()` 供测试清理。
- `server/src/agent/agent.processor.ts`：注入 `ConfigService`，用 `app.databaseUrl` 构造 checkpointer，替换 `new MemorySaver()`。`thread_id` 沿用既有的 `thread-{projectId}-{runId}`，不需要迁移历史数据。
- 不需要额外写「恢复扫描」：`AgentService.cancelStaleRuns()` 只清理 30 分钟前的 run，未完成的 BullMQ job 重启后会被重新消费，此时同 `thread_id` 的 checkpoint 已在库里，图从最后完成的节点继续。
- `agent/src/__tests__/checkpointer.test.ts`（新，4 个用例）：无连接串降级、有连接串建表、并发共用同一实例、建表失败可重试。

**验证**：agent 包 41 个测试全过（新增 4 个）。

---

## P1-2 critique_result：评审结论实时可视化

**动机**：`critique_result` 在 `shared/constants/events.ts`、`shared/types/ws-events.ts`、`frontend/types/index.ts` 三处都有定义，前端 `useWebSocket` 也监听了，**服务端从来没 emit 过**。结果是 Critic 的分数只躺在图状态里，用户看不到「AI 为什么说这段分镜不行」——Monitor 闭环最直观的一环是空的。

**改动**
- `shared/types/ws-events.ts`：重写 `CritiqueResultEventDataSchema`。原 schema 用 camelCase（`entityType` / `willRegenerate`）且 `entityId` 要求 uuid，与真实载荷（数字 id、snake_case）完全对不上，属于「定义了但没人能对上」的假契约。改为 snake_case 并补 `stage` / `threshold` / `passed` / `round` / `max_rounds`，让前端能解释「为什么没过、还有几次机会」。
- `agent/src/agents/base.ts`：新增 `CritiqueReport` 类型与可选方法 `AgentContext.reportCritique`。可选是刻意的——单测和 fake context 不实现时静默跳过，评审本身照常进行。
- `agent/src/agents/critic.ts`：算完 `score/passed/round` 后上报，单独 try/catch 包住。上报失败只是前端少一张卡片，不能让已经跑完的评审白费。
- `server/src/agent/critique-payload.ts`（新）：`toCritiqueResultPayload()` 把 camelCase 结论转成 snake_case 载荷。单独成文件而不是塞进 processor，是为了让测试不必拉起 BullMQ/ioredis 整套依赖。
- `server/src/agent/agent.processor.ts`：在 `ctx` 上实现 `reportCritique`，经 `wsGateway.sendToProject` 广播。
- `frontend/src/stores/critiqueStore.ts`（新）：`latest` + `history`（保留最近 10 轮，可看收敛轨迹）。
- `frontend/src/components/project/CritiquePanel.tsx`（新）：总分、阈值进度条、轮次徽章、四维条形、问题与建议列表；未通过时区分「回灌重写」与「到轮次上限转人工」；多轮时显示 `R1 5.5 → R2 8.2`。
- `frontend/src/components/project/NodeDetail.tsx`：面板挂在分镜节点详情下（与 `ConsistencyPanel` 同级）。
- `frontend/src/pages/ProjectPage.tsx`：离开项目时 `resetCritique()`，避免看到上一个项目的分数。

**验证**：全仓 **186 个测试全过**（shared 60 / agent 44 / server 72 / frontend 10）。新增 13 个用例：Critic 上报内容与「上报失败不影响结论」3 个（agent）、载荷映射 + 能被 shared schema 校验 + entity_id 省略 4 个（server）、面板渲染与 store 历史截断 6 个（frontend）。其中 server 那条 `safeParse(toCritiqueResultPayload(report))` 是真正的前后端契约测试——只改一侧字段名就会红。

---

## P1-4 并发上下文治理：删掉全局兜底，只留 ALS

**动机**：processor 的 BullMQ worker 是 `concurrency: 8`，但节点上下文原先有两套来源：`AsyncLocalStorage` 和模块级 `_nodeCtx`。`setNodeContext(ctx)` 写全局、`clearNodeContext()` 在 job 结束时清全局——A 项目的 job 完全可能拿到 B 项目的 ctx 去写库；更隐蔽的是取不到上下文时返回 mock ctx，`callLlm` 直接吐 `"{}"`，产物静默变空而任务状态还是成功。这类 bug 不会报错，只会「生成出来的东西莫名其妙」。

**改动**
- `agent/src/nodes/index.ts`：删除 `_nodeCtx`、`setNodeContext()`、`clearNodeContext()` 与整段 mock 降级；`getNodeCtx()` 只读 ALS，取不到抛 `[agent:ctx] 图节点拿不到 AgentContext：图必须在 runWithNodeContext(ctx, ...) 作用域内执行。并发场景不提供全局兜底，以免多个 job 串号。`
- `agent/src/index.ts`：导出收敛为只剩 `runWithNodeContext`（删掉另外两个，避免有人再写全局注入）。
- `server/src/agent/agent.processor.ts`：去掉 `setNodeContext(ctx)` 与 `finally` 里的 `clearNodeContext()`；上下文只由 `runWithNodeContext(ctx, () => graph.invoke(...))` 绑定。
- `server/src/__tests__/supervisor-e2e.spec.ts`：同步去掉全局注入调用。
- `agent/src/__tests__/graph.test.ts`：原先用 `try/catch` 吞掉图执行的任何异常来「通过」，去掉兜底后这种写法会掩盖真实错误。改为在 `runWithNodeContext` 里 invoke，并断言 `isInterrupted(result)` 为真、`gate === "outline_approval"`——这一步同时验证了 **ALS 能穿透 LangGraph 内部的异步边界**（这是删兜底的唯一前提风险）。
- `agent/src/__tests__/node-context.test.ts`（新，4 个用例）：无上下文时 `planOutlineNode` 拒绝并给出可定位的错误文案；8 个不同 `projectId` 的 job 并发跑 Critic 节点、故意错开 LLM 延迟，断言每份 `reportCritique` 回报的 issues/suggestions/score 都来自自己的 job、`critiqueScores` 也各归各的；单个 job 缺上下文不影响其它 job。

**为什么不是所有共享都要清**：模块级共享只剩两类——Agent 实例（`BaseAgent` 只有 `readonly name`，无状态）和 `checkpointer` 单例（内部 pg 连接池，本来就该复用，且不持有项目上下文）。这两者共享是正确设计，与「用全局变量传请求上下文」是两回事，面试时可以明确区分。

**验证**：全仓 **190 个测试全过**（shared 60 / agent 48 / server 72 / frontend 10），`pnpm build`、`pnpm typecheck` 均通过。真实双项目并发生成未实测（要跑两次完整生成），但单元级 8 路并发已覆盖上下文隔离语义。

---

## P1-3 工具层统一 + MCP：从「硬编码方法」到「可插拔工具」

**动机**：工具层原本只覆盖大纲节点，协议是自研 JSON Schema，和 LangChain 生态不通；MCP 是六大考点里最明确的一条空白。旧路线图的验收标准只有一句：**至少一个 Agent 通过 MCP 工具完成一次真实调用，工具清单可枚举。**

**先解决一个硬约束**：这个工作区里 `pnpm install` 必然失败（WorkBuddy 文件代理拦截 `node_modules` 内的 rename/unlink），所以**不能新增依赖** —— `@langchain/mcp-adapters` 用不了。两条替代路径都验证可行后选了后者：
- `tool()` / `DynamicStructuredTool` 实测接受**纯 JSON Schema**（不强制 zod），所以协议互通不需要装 zod；
- MCP 的 stdio 传输本身很小（每行一个 JSON-RPC 消息），按规范自实现比引依赖更可控。

**改动**

- `tools/langchain-bridge.ts`（新）：`fromLangChainTool` / `toLangChainTool` / `toOpenAiToolSpec` 三向适配。刻意**拒绝 zod schema 并报错**而不是静默降级 —— 静默降级会让模型收到错误参数定义，比报错更难查。（`invoke` 参数必须用 `any`，用 `unknown` 会因函数参数逆变而无法接受 LangChain 的具体输入类型。）
- `tools/mcp/client.ts`（新，~230 行零依赖）：JSON-RPC 2.0 over stdio 客户端。请求 id 递增配对、可配超时、子进程退出时 `failAll` 拒绝所有 pending、stdout 混入非协议内容记进诊断而不崩、`close()` 先关 stdin 再 1s 后 SIGKILL。实现了 `initialize` → `notifications/initialized` → `tools/list` → `tools/call`。
- `tools/mcp/servers/assets-server.mjs`（新，零依赖）：真实可跑的 MCP server，暴露项目内文件。安全上做了两层：`resolve` 后校验必须在项目根内（防 `../` 穿越），以及拒绝 `node_modules`/`.git`/`dist` 与 `.env`/`*.pem`/`*.key` 类文件；读取默认 16KB、上限 64KB，二进制只在含 `\0` 时返回元数据。日志一律走 stderr（stdout 只能有协议消息）。
- `tools/mcp/adapter.ts`（新）：远端描述符 → `AgentTool`，把 `isError` 转成 `ERROR:` 前缀，沿用本地工具的失败约定。
- `tools/mcp/assets-toolkit.ts`（新）：连接 + 注册 + **失败即降级**。`findProjectRoot()` 向上找 `pnpm-workspace.yaml`/`.git`，支持 `MIRAFRAME_ROOT` / `MIRAFRAME_MCP_ASSETS_SERVER` 覆盖，`MIRAFRAME_MCP_ASSETS=0` 关闭。
- `agents/outline.ts`：把 MCP 工具注册进大纲节点的同一个 `ToolRegistry`（与本地工具重名时保留本地实现），`finally` 里关闭子进程。模型因此能在写大纲前自主查项目里真实存在的参考素材。
- `packages/agent/scripts/copy-mcp-servers.mjs`（新）：**tsup 是 bundle 模式，`.mjs` 子进程脚本不会进 dist**，而生产镜像「只拷 dist」，缺它则 `node dist` 形态下 MCP 永远降级。build 脚本末尾调用它复制。
- `Dockerfile.server`：显式 `ENV MIRAFRAME_MCP_ASSETS=0` —— 生产镜像不带源码，素材库没有可暴露的文件，避免每个 job 白起一个子进程再降级。
- `vitest.config.ts`（agent/server）：默认 `MIRAFRAME_MCP_ASSETS=0`，MCP 用例显式传 `enabled: true`。

**验证**：全仓 **220 个测试全过**（shared 60 / agent 78 / server 72 / frontend 10），`pnpm build`、`pnpm typecheck` 通过。新增 30 个用例，分四层：

| 层 | 文件 | 关键断言 |
| --- | --- | --- |
| 协议桥接 | `langchain-bridge.test.ts`（7） | `tool()` → AgentTool → 执行；往返转换后注册进 Registry 仍可执行；zod schema 被拒 |
| MCP 客户端 | `mcp-client.test.ts`（10） | 真 spawn 子进程走完整往返；`tools/list` 缓存命中同一引用；越界路径与受限目录被拒；close 后拒绝新请求；脚本缺失时 reject 而非挂死 |
| 工具层集成 | `mcp-toolkit.test.ts`（11） | `registry.names()` 可枚举；远端工具调用方式与本地一致；`ERROR:` 前缀约定；三条降级路径 |
| 端到端闭环 | `mcp-tool-loop.test.ts`（2） | 预设 tool_calls 驱动真实 ToolLoop：模型先调 `list_project_assets` 查 docs，再写草稿落库；**断言第二轮上下文里出现了 `architecture-walkthrough.md`**，证明工具结果真的回填给了模型 |

另外用 `node` 直接加载 `dist/index.js` 验证过构建产物形态：`serverInfo` 正确、工具清单可枚举、能列真实 `docs` 目录 —— 确认「复制脚本进 dist」这一步真的解决了问题。

---

## MCP 连接层升级：自实现 stdio → 官方 `@langchain/mcp-adapters`

**动机**：P1-3 当时因为工作区装不了依赖，MCP 客户端是按规范自写的。装上官方 SDK 后，连接层应该收敛到官方实现上 —— 自研协议栈是学习手段，不是产品形态。但这次不是「推翻重写」，而是**换连接层、保留转换层**，正好验证了当初分层的价值。

**版本选择（关键取舍）**

| 版本 | peer 要求 | 与项目现状（core 1.1.48 / langgraph 1.3.2） |
| --- | --- | --- |
| `2.0.3`（最新） | `core ^1.2.6`、`langgraph ^1.4.18` | 两个都不满足，会被迫升 Agent 骨架 |
| `1.1.4` | `core ^1.0.0`、`langgraph ^1.4.10` | langgraph 不满足 |
| **`1.0.1`** | `core ^1.0.0`、`langgraph ^1.0.0` | **全部满足，零升级** |

`StateGraph`、`interrupt`、`PostgresSaver`、`Command` 都建在 core/langgraph 上，为一个增强能力去动骨架不值，所以钉死 `1.0.1`（带 `@modelcontextprotocol/sdk@1.32.2`）。

**改动**
- `tools/mcp/sdk-toolkit.ts`（新）：`MultiServerMCPClient` 连接 → `getTools()` → 转换 → `close()`。只做连接，不碰工具语义；失败时 `close()` 掉半开连接再抛。
- `tools/mcp/adapter.ts`：新增 `langChainMcpToolToAgentTool()`、`toMcpErrorText()`、`registerAgentTools()`。
- `tools/mcp/assets-toolkit.ts`：新增 `transport: "sdk" | "builtin" | "auto"`（默认 `auto`：先 SDK，失败回落自实现），返回结果里带 `transport` 字段说明实际用了哪条；重名注册逻辑抽成 `registerAgentTools()` 两条连接层共用。
- `tools/mcp/index.ts`：导出新入口与类型。
- `vitest.config.ts` 不变（仍默认 `MIRAFRAME_MCP_ASSETS=0`，MCP 用例显式 `enabled: true`）。

**换 SDK 时撞到的真实语义坑（这是本次最有价值的发现）**

MCP 规范里 `isError: true` 是**工具级错误**：参数不对、路径越界，模型看到它才能改参数重试。但官方 SDK 会把它包成一个抛出的异常：

```
MCP tool 'read_text_asset' on server 'assets' returned an error: ERROR: 路径越界…
```

如果任由异常冒泡，`ToolLoop` 会在 `registry.execute()` 之外中断（虽然 registry 有兜底 catch，但错误文案会变成两层前缀且丢失语义），工具错误就变成了传输错误，Agent 的自我修正能力随之消失。`toMcpErrorText()` 专门处理这件事：剥掉 SDK 包装前缀、还原成单层 `ERROR:` 文本；测试断言 `content` 里不含 `returned an error`。

**验证**：全仓 **234 个测试全过**（shared 60 / agent 92 / server 72 / frontend 10），`pnpm build`、`pnpm typecheck` 通过。新增 14 个用例（`mcp-sdk.test.ts`）：

| 组 | 断言 |
| --- | --- |
| SDK 连接层（6） | 默认走 sdk；工具清单与自实现完全一致；schema 是纯 JSON Schema 可直接转 AgentTool；`serverInfo` 来自 initialize 握手（`miraframe-assets` / `0.1.0`）；registry 调用与本地工具一致；工具级错误被还原成单层 `ERROR:` |
| 连接层可切换（4） | `builtin` 显式生效；`auto` 优先 sdk；sdk 模式脚本缺失 → null；auto 模式两条都失败 → null |
| `toMcpErrorText`（4） | 剥前缀；无 `ERROR:` 时补工具名；传输级错误保留工具名；非 Error 抛出物转文本 |

另外用 `node` 直接加载 `dist/index.js` 验证过构建产物形态：`transport: sdk`、`serverInfo` 正确、能列真实 `docs` 目录，且素材库日志里出现 `initialize from @langchain/mcp-adapters` —— 确认走的确实是官方 SDK 而不是兜底路径。

**保留自实现客户端的理由**：两条连接层契约一致、都有测试覆盖，SDK 因版本或环境问题不可用时不至于整个功能消失；`MIRAFRAME_MCP_TRANSPORT=sdk|builtin|auto` 可显式切换。这不是冗余 —— 而是「能力可降级」的同一原则在连接层的延续。

---

## 多轮记忆：从「拼接最近 N 轮」到「增量滚动摘要」

**动机**：历史上下文此前是把最近 5 轮原文拼进 prompt，超出就硬截断（`…（历史已截断）`）。用户说「改回第一版但保留结尾」时，只要第一版滑出窗口，模型就失去指代对象 —— 而这正是多轮记忆考点最典型的失败。

**设计（为什么是「滚动」而不是「每轮重新总结」）**

| 方案 | 问题 |
| --- | --- |
| 每次任务把全部历史重新总结一遍 | 重复烧钱，且摘要不可复现（同一段历史今天压出来和昨天不一样） |
| 只保留最近 N 轮原文 | 就是旧做法，早期偏好会丢 |
| **增量折叠 + 游标** | 每轮只折叠一次，摘要随会话单调生长，成本与消息量线性而非平方 |

**改动**
- `db/schema.ts` + `drizzle/0003_broad_starbolt.sql`：新增 `conversation_memory`（`project_id` 主键、`summary`、`covered_through_id`、`covered_turns`、`updated_at`，级联删除）。
- `agent/conversation-memory.ts`（纯函数，无 IO）：`groupConversationTurns`（用户发言 = 轮次起点）、`planMemoryUpdate`（判断该不该折、折到哪）、`serializeTurnsForSummary`、`buildSummaryPrompt`（与旧摘要合并而非追加）、`applyMemoryPlan`、`renderMemoryBlock`、`readMemoryConfig`。
- `agent/conversation-memory.store.ts`：抽出 `MemoryStore` 接口 + drizzle 实现（`onConflictDoUpdate` 幂等 upsert）。抽接口是为了让编排逻辑可单测，不必伪造 drizzle 链式查询。
- `agent/conversation-memory.service.ts`：编排 `ensure()`，三条失败语义见下。
- `agent/agent.module.ts`：工厂装配，把「存储」与「摘要模型」作为两个依赖出入，单测可 `new ConversationMemoryService(fakeStore, fakeSummarizer)`。
- `agent/agent.processor.ts`：读消息时带上 `id`、扫描上限 60 → 120；先 `ensure()` 再 `buildConversationHistory({ memorySummary, coveredThroughId })`。
- `agent/agent-run-state.ts`：`buildConversationHistory` 支持按 `coveredThroughId` 跳过已折叠轮次；超长时**从最旧的整块开始丢**（下一轮就会被折叠），最后才硬截断，保证最近一轮永远不被切掉。
- `services/text.service.ts`：fake provider 增加 `memory` 分支，本地 fake 模式也能演示记忆链路。

**三条失败语义（都刻意不抛）**
1. 记忆表不存在（迁移没跑）→ 打一条提示、当空记忆，生成照常；
2. 模型调用失败 → 沿用旧摘要，历史上限逻辑兜底；
3. 模型返回空 → `applyMemoryPlan` 返回 null，**不覆盖**旧摘要。远端摘要器故障时把记忆写成空，是这类系统最常见的事故。

另外 `coveredThroughId` 取 `Math.max(旧, 新)`：job 重放、并发重入都不会把游标推回去重复折叠。

**验证**
- 单测 30 个（`conversation-memory.test.ts`）：分组、窗口判定、阈值攒批、游标不重复折叠、`excludeLatestUser` 不提前折叠当前轮、序列化截断、prompt 合并语义、空输出不清空、超长截断、配置夹取、服务层 6 种路径、以及与 `buildConversationHistory` 的联动。
- 真实 Postgres 跑通一遍：6 轮对话 → 折叠第 1-3 轮、`covered_through_id=388` 落库、prompt 里只剩第 4-6 轮原文 + 摘要块、重复调用 `updated=false`、删项目后记忆行与消息级联清零。
- 全仓 **264 个测试全过**（shared 60 / agent 92 / server 102 / frontend 10），`pnpm build` / `pnpm typecheck` 通过。

**没做**：token 预算按模型上下文动态分配（目前是固定字符上限）；长期记忆只是单段散文，没有分槽（角色设定 / 分镜决定 / 风格偏好）或向量检索，跨项目不复用。

---

## Provider 选路与降级：从「重试同一个 URL」到「换一家继续」

**动机**：原来的失败恢复只有一层——对同一个 URL 重试。429 退避、503 退避都对，但主 provider 出的是**结构性故障**（密钥失效、账号欠费、区域不可用）时，重试只会一路撞到超时，用户等到的是「生成失败」而不是「换一家继续」。旧计划第 6 条「无 provider 路由策略」一直没落地，正好是「工具调用 / 失败恢复」叙事里最软的一环。

**设计：重试负责抖动，选路负责故障**

| 层 | 负责 | 触发 |
| --- | --- | --- |
| 单 provider 重试（已有） | 瞬时抖动 | 429、503、`queue_full`、网络错误 |
| 跨 provider 选路（本次） | 结构性故障 | 401/403、5xx 连续失败、重试耗尽 |

- **候选链**：`TEXT_PROVIDERS=agnes,kimi` 按声明顺序尝试；每项的 `TEXT_<NAME>_BASE_URL` / `_API_KEY` / `_MODEL` / `_ENDPOINT` 覆盖通用 `TEXT_*`，缺省自动继承。不配 `*_PROVIDERS` 时链长度为 1，**行为与改造前完全一致**。
- **熔断**：同一家连续失败 3 次（可配）进入冷却，冷却 `30s × 2^(n-1)`、封顶 5 分钟；冷却期内跳过，到期后放一个 half-open 试探，成功即清零恢复。
- **错误分类**：可切换 = 网络 / 超时 / 429 / 408 / 401 / 403 / 5xx；不可切换 = 其余 4xx（400/422 换谁都一样，切了只会再错一次，还会污染健康度）。
- **观测**：`GET /api/v1/providers` 返回每家的 `state / successes / failures / successRate / avgLatencyMs / consecutiveFailures / cooldownRemainingMs / lastError`，只读脱敏（不含 baseUrl 与密钥）。

**改动**
- `services/provider-routing.ts`（新，纯逻辑零 IO）：`resolveProviderChain`、`chainFingerprint`、`classifyProviderFailure`、`ProviderHttpError`、`ProviderRouter`（plan / attemptOrder / recordSuccess / recordFailure / syncChain / snapshot）、`readRouterOptions`。
- `services/text.service.ts`：`generate` 与 `generateWithTools` 都改为「解析链 → 路由循环 → 单次尝试」；抽出 `attemptGenerate` / `attemptWithTools`；`envReader` 保留 `TEXT_* → ANTHROPIC_* → app.*` 的旧兜底顺序，避免只配 `ANTHROPIC_AUTH_TOKEN` 的环境被判成「没有 key」。
- `services/image.service.ts`：同样接入，`fake` fixture、无 key 占位、dashscope 轮询等旧分支原样保留。
- `services/video.service.ts`：同样接入；`attemptVideo` 里按 `baseUrl` 嗅探 dashscope / agnes / 通用三种请求体，Agnes 的提交错误改抛 `ProviderHttpError` 以便按状态码分类。
- `modules/config/providers.controller.ts`（新）+ `config.module.ts`：注册只读观测端点。
- `config/startup-check.ts`：provider 检查改为按链逐项校验（多链时摘要输出 `providers=a(openai) → b(openai)`），保留单链时的旧文案；`ALLOWED_PROVIDERS` 放宽到 `openai / fake / dashscope / agnes / anthropic`（该值只影响日志与嗅探提示，实际协议看 baseUrl）。
- `.env.example`：新增多 provider 与熔断参数示例，三个能力段各加一句写法指引。

**两个被测试逼出来的修正（值得记下来）**

1. **半开必须排在最前面**。最初排序是「健康 → 半开 → 冷却」，结果备用一直健康、每次都先成功，主 provider 冷却到期后永远轮不到试探，等于被永久摘除。改成 probe 优先，代价是一次探测请求。
2. **备用也会熔断**。单测里主备同时 5xx，两家都进冷却，此时请求走「全链冷却」分支：不直接失败，best-effort 尝试最早恢复的一家。硬失败对调用方没有价值，而抖动常常已经恢复。

**工具通道的专属取舍**：`function calling` 返回 400 在普通调用里是「参数错、不切换」，但在工具通道里通常意味着「这家不支持 tools」，换一家有意义。所以 `ProviderHttpError` 支持 `switchableOverride` 覆盖默认分类；整条链都不支持时才回 `TOOLS_UNSUPPORTED`，ToolLoop 仍按原设计降级 JSON——**降级路径没变，只是多了一次换家的机会**。429 不被 override 影响，仍是 `rate_limit` 语义。

**验证**
- 34 个用例（`provider-routing.test.ts` 23 + `provider-failover.test.ts` 11）：链解析与 scoped 覆盖、去重、空 key 不剔除、指纹不含密钥；错误分类七类 + override；熔断状态机（阈值、冷却、half-open 顺序、指数翻倍与封顶、全熔断 best-effort、无 key 过滤、`syncChain` 保留健康度、成功率/延迟统计）；text / image 两个服务的真实切换、400 不切换、熔断后跳过、聚合错误、fake 兜底、tools 400/429 两条路径。
- 本地起两个真实 HTTP server（主 401 / 备 200）跑 4 次 `generate`：请求序列 `primary → backup → primary → backup → primary → backup → backup`，第 3 次日志出现「primary 连续失败 3 次，熔断 30s」，第 4 次「primary 冷却中（剩 30s），本次跳过」；快照里 `state=open`、`skips=1`、`backup.successRate=1`、`avgLatencyMs≈2`。
- 全仓 **298 个测试全过**（shared 60 / agent 92 / server 136 / frontend 10），`pnpm build` / `pnpm typecheck` 通过。

**顺手修的工程问题**：根 `package.json` 的 `test` 是 `vitest run`，而 `vitest.workspace.ts` 在 vitest 4 已不再被读取（CI 用的是 `pnpm -r test`，所以一直没暴露）。根目录直接跑会收集所有包但用根配置，导致 `@/` 别名与 `MIRAFRAME_MCP_ASSETS=0` 都失效。改为 `test: pnpm -r test`（与 CI 一致），删掉失效的 `vitest.workspace.ts`。

**没做**：按成本/延迟动态加权的负载均衡（当前是静态优先级 + 熔断）；熔断状态跨进程共享（多实例各算各的，要做得上 Redis）；协议仍按 baseUrl 嗅探，新增特殊协议的供应商还要改代码。候选名默认 `openai` 的规则也值得注意：只写 `TEXT_PROVIDERS=a,b` 而忘了 `TEXT_PROVIDER` 时按 OpenAI 兼容处理，不会静默变成 fake。

---

## i2i 自动联动：把「人点按钮」换成「有闸门的闭环」

**动机**：一致性链路的第三步一直是手动。检测是自动的（`generateShotFrames` 末尾跑 `autoCheckConsistency`，结果写回 `shot` 并广播），修复能力也早就写好了（`ShotRepairService.repairWithReferences`，有单测、有路由、有面板按钮），唯独中间那一步没人接。结果是「自动发现漂移 → 亮个红点 → 等人来点」，闭环缺了最后一环。

**为什么不做成无限制自动**：一致性判定本身有波动，重画又是按张计费。无上限的自动修复会在一个本来就判不准的指标上反复花钱，还会出现「修脸把构图修坏 → 再修 → 来回震荡」。所以做的是**有预算、有闸门、可关**的自动版本，手动面板保留为兜底。

**三层结构**

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 策略（纯函数） | `services/auto-repair.ts` | 读配置、判断图像服务可用性、选片与排序、逐张执行并判定是否修好 |
| 编排 | `agent/agent.processor.ts` 的 `autoRepairDriftedShots` | 查绑定关系、组装候选、调服务、广播结果 |
| 执行（复用） | `services/shot-repair.service.ts` | 取参考图、拼保脸提示词、走 i2i、换图、清视频、复检 |

**三道闸（按成本从低到高）**

1. `MIRAFRAME_AUTO_REPAIR`（默认开）+ `MIRAFRAME_AUTO_REPAIR_MAX_SHOTS`（默认 2，上限 10，设 0 等于只告警不修）。
2. **图像服务是否真能出图**：`isImageRepairAvailable()` 解析候选链，要求至少一家「非 fake 且带 key」。
3. **这一轮有没有漂移**：只修 `verdict=drift`，灰区 `review` 不修。

**两个被测试和环境逼出来的修正**

1. **占位图陷阱（最危险的一个）**：`generateImage` 在 fake provider 或没配 key 时**不抛错，而是静默返回 `data:` 占位图**。第一版没有这道闸，跑通之后才发现「修复」会把一张真图换成灰底占位图、还顺手清掉视频。修法两层：编排层先判 provider 可用性；`shot-repair.service.ts` 在写库前检查返回值是否 `data:` 开头，是就抛错、原图不动。
2. **`unverifiable` 不算修好**：复检判定有四种，最初写成「不是 drift 就算修好」，于是「没检出人脸」也被报成已恢复——那等于没有证据却宣称修好了。改成只有 `ok` / `review` 算 resolved。

**预算怎么花**：按漂移程度从重到轻排序（取该镜头里 `distance` 最大的角色），取前 N 个；每个镜头在计划里只出现一次，所以不存在同一张图被反复重画。排序并列时按镜头顺序，保证日志可复现。

**位置上的一个巧合，正好省掉一次重合成**：修复挂在 `generateShotFrames` 末尾、`generateShotVideos` 之前，所以视频阶段拿到的就是新图。`repairWithReferences` 清空 `videoUrl` 在这里不是代价而是正确性保证——万一是有部分视频的续跑场景，旧视频也不会配着新图留下来。

**观测**：新增 `consistency_repair_completed` 事件（snake_case，带 `repaired` / `skipped` / `failed`；`skipped` 的 reason 是 `not_drift | no_references | over_budget`）。前端收下后写入消息流：「已按参考图重画 N 个镜头，M 个已恢复」。同时在每个修复成功的镜头上补发 `shot_updated`，因为修复服务只改库不广播，前端不刷新就能看到新图。

**验证**
- 25 个策略用例（`auto-repair.test.ts`）：配置解析、provider 可用性四类、`worstDistance` 取值、选片（只修 drift / 无参考图跳过 / 按漂移排序 / 预算截断 / 预算 0）、执行（成功 / 仍漂移 / 复检失败 / 单张失败继续 / 跳过原因回传）、参考图收集（每角色 3 张、整镜 4 张、去重、无图返回空）。
- 7 个编排用例（`consistency-auto-repair.test.ts`）：直接 new `AgentProcessor` + 链式查询替身，覆盖 fake 跳过、缺 key 跳过、开关关闭、正常修复并广播两个事件、预算只修最严重的那张、无漂移不动作、修复失败只记录不改图。
- 4 个契约用例（shared `ws-events.test.ts`）：接受 snake_case、`verdict` 允许 null、拒绝 camelCase、拒绝未知 reason。
- 本地端到端（真实 HTTP 图生图服务 + 真实 `ImageService` / `ConsistencyService`，人脸模型按图片字节区分参考图/旧图/新图）：请求体 `extra_body.image` 带上了参考图、提示词带「第 1 张：沈鸢」、返回新图后写库并清空 `videoUrl`、复检 `ok`、事件 `shot_updated → consistency_repair_completed{resolved:true}`；HTTP 轨迹 `POST /v1/images/generations → GET ref.png → GET fixed.png`。
- 全仓 **334 个测试全过**（shared 64 / agent 92 / server 168 / frontend 10），`pnpm build` / `pnpm typecheck` 通过。

**没做**：预算是「每次跑」而不是「全项目总量」，长项目反复续跑仍可能累计花钱；没有跨进程共享预算（多 worker 各修各的，要做得上 Redis）；`ENABLE_IMAGE_TO_IMAGE` 这个老开关目前仍不参与判定（自动修复盯的是 provider + key，因为那个开关既不拦手动路径也不拦生成路径）；修不好只标红不自动降级重写提示词。

---

## 多模态 Critic：让评分机制真的「看」到画面

**动机**：质量检查原来有两个洞。文本 Critic 读的是分镜脚本，对「图出来长什么样」一无所知；face-api 只认人脸向量，画风从国漫变成 3D 渲染、手画成六根指头、构图把主角半个头切出画——它一句话都说不出。`CRITIC_SYSTEM_PROMPT` 其实一直躺在那（图像四维 rubric），只是从没被调用过。所以这次不是造新能力，是把早就写好的设计接上。

**为什么不是一张图调一次**：6 镜项目就是 6 次请求，而每次都要重复发同样的项目风格、角色设定、评分规则——固定开销乘以请求数，比图本身还贵。改成一次带 4 张（可配），6 镜走 2 次调用。

批量带来一个新风险：模型会数错图。所以提示词把它写成对照表——`图 1 = 镜头 #1；出场角色：沈鸢；画面要求：少女撑伞停在熄灭路灯下`，不让模型自己数。

**三个必须绕过的实现坑**

1. **图片必须内联成 base64**。不是为省流量，是供应商根本访问不到：镜头图由图像供应商生成，返回的是它们域名的 URL；本机 `/static/` 更不可能被外部访问。`image-encoder.ts` 统一处理 `data:` / `http(s)` / `/static/` / 绝对路径四种形态，`/static/` 走路径越界校验（这个值来自数据库，不该变成任意文件读取入口）。
2. **压到长边 768 / JPEG 0.8**。原图 1024 PNG 常有 1–2MB，base64 再膨胀 1/3，6 张就是 10MB 量级请求体；压完单张 100KB 上下，而判画风与肢体不需要原始分辨率。透明 PNG 必须先铺白底——JPEG 不支持 alpha，不铺底会出来一片黑。
3. **响应解析必须假设模型会骗人**。这层的四个决定都是为了「别让不可靠的判定变成不可靠的动作」：

| 情况 | 处理 | 为什么 |
| --- | --- | --- |
| 自报总分 9.9、分项全是 5 | 总分取镜头均值 | 实测里两者经常矛盾，分项更接近真实 |
| 漏评某个镜头 | 记进 `missingOrders`，前端显示「未返回评分」 | 补满分是自欺，当成通过是放过 |
| `needs_regenerate: "true"` / `1` | 一律算 false | 重画是花钱动作，只认明确的布尔 true |
| 多给了别的镜头 | 不计入统计 | 分批时偶发串批，脏数据不该拉偏均分 |

**重画的两个条件与一个复用**

条件必须同时满足：模型明确 `needs_regenerate` **且** 分数低于阈值。只看标记会把 8 分的图重画掉，只看分数会在模型认为「小修可用」时白花一次生成。

重画没有走「纯文生图重来一张」，而是复用 i2i 那条保脸路径（`ShotRepairService.repairWithReferences` 新增可选 `extraPrompt`）：带角色参考图，把 Critic 的 suggestions 拼进提示词。拼的是 suggestions 不是 issues——issues 说哪里错，suggestions 才是怎么改。否则重画一次脸又漂了，等于用视觉问题换了个几何问题。

**两个被测试逼出来的修正**

1. **阈值不做 clamp**。第一版用统一的 `readNumber(..., 0, 10)`，配成 `11` 会被静默夹到 `10`，用户以为配置生效了。改成越界回落默认值——配置错误应该暴露，不该被温柔地藏起来。
2. **`runRouted` 把两种「兜底」混成了一种**。重构 `generate` 时把「没有 key → 返回 `[LLM not configured]` 占位文本」和「候选链上是 fake provider → 返回演示 fixture」合并成一个 `fallback`，`provider-failover.test.ts` 立刻炸了：无 key 环境拿到了 fake 生成的大纲 JSON。拆成 `noProvider` / `fake` 两个回调，语义才对齐。

**验证**
- 53 个用例：29 个纯策略（配置解析与越界回落、占位图识别、分批、提示词对照表、七类畸形响应、跨批合并、重画四条件）+ 14 个编排（开关/占位图/分批/单张取图失败剔除/坏 JSON 降级/模型整体失败/问题清单合并/重画成功·跳过·失败·预算 0·开关关）+ 10 个协议（多模态消息结构、`VISION_MODEL` 覆盖、不传 reasoning_effort、温度 0.2、空图拒绝、401 切换、400 不切换、聚合错误、视觉失败不影响文本、fake 分支）。
- 前端 3 个新用例：视觉阶段用不同标题与文案不冒充分镜审查；两阶段结果互不覆盖（主卡片 + 另一阶段摘要）；收敛轨迹只统计同一阶段。
- 本地端到端（真实 HTTP 视觉服务 + 真实 `TextService` + 真实 canvas 编码）：请求体 `messages[1].content` 为 `text + image_url × 2`，`model=qwen-vl-max`、`temperature=0.2`、图片是 18.7KB 的 `data:image/jpeg;base64`；提示词带「图 1 = 镜头 #1；出场角色：沈鸢」；解析出总分 5.2、逐镜 `#2=4 #1=6.4`、问题清单带镜头号；重画只挑 #2（#1 标 `passed`），`extraPrompt` 正确带上两条 suggestions。
- 全仓 **390 个测试全过**（shared 64 / agent 92 / server 221 / frontend 13），`pnpm build` / `pnpm typecheck` 通过。

**没做**：不审视频（要抽帧，成本和时延另算）；重画后不复审，否则「审-改-审」会在主观判定上无限循环；视觉判定没有校准集，换模型后阈值该不该调只能靠观察；复用文本 provider 链只换模型名，如果视觉服务是独立账号/域名，得先扩 `resolveProviderChain` 的 capability；单轮只审前 8 个镜头，是额度保护不是能力上限。

---

## 字幕叠加：把 `dialogue` 从「配音分支」接到「画面分支」

**动机**：`shots.dialogue` 一直有两份消费者却只接了一份。`video.service.ts` 用 `planDialogue` 拆台词送 TTS，还在合成时顺手写了外挂 `final.srt`；但播放器里一个字都看不见。想让台词上屏，最直接的想法是 ffmpeg 烧录（`subtitles` 滤镜 + ASS 样式），可本机 Homebrew ffmpeg 9.0.2 没编 libass，`-filters` 里连 `subtitles`/`ass`/`drawtext` 都没有，系统字体目录也没有 PingFang。为了一个渲染依赖去换 ffmpeg 静态构建，还要把字体挂载进容器，收益只是「字幕不可逆地固化进 mp4」——不划算。

**所以选 DOM 叠加**：字幕是盖在 `<video>` 上的一层 React 组件，不碰视频像素。改一句台词不用重新编码、可以随时开关、导出 mp4 也不会被字幕污染。代价是**导出的成片不带字幕**（下面「没做」里写清楚）。

**解析规则必须只有一份**。第一反应是在前端再写一个正则把「沈鸢（轻声）：『……』」拆开，但这正是漂移的开始：TTS 念的字和屏幕上显示的字会慢慢对不上。于是把 `parseDialogue` / `cleanLine` / `estimateSeconds` 从 `server/src/services/dialogue.ts` 抽到 `shared/src/utils/dialogue.ts`，服务端只保留「解析结果 → 音色/语速/音量」的配音编排，并 re-export 原 API，既有 `dialogue.test.ts` 一行没改。

**时间轴是这次真正要设计的部分**

`planSubtitleCues(segments, options)` 输出 `{start, end, text, speaker}[]`：

1. 先把每句台词按标点切成不超过 18 字的字幕条（句末标点优先、逗号次之、没有标点就硬切）——中文没空格，一屏塞三段话读不完。
2. 段内按字数比例分配时长，并给短句一个 `minSeconds` 兜底。抬高低谷的时长要从高峰等比例扣回来，否则总长会溢出到下一段。
3. 段与段按镜头顺序累加。单镜头的 duration 直接取 `<video>` 的 `onLoadedMetadata`，精确；成片则把 `shots[].duration` 按比例缩放到视频真实总时长——因为台词过长时 `buildStagedClip` 会冻结末帧延长画面，各镜头 duration 之和并不等于成片时长，硬用累加值会越漂越远。

**组件层两个刻意的克制**

- 用 `timeupdate` 驱动，不启 `requestAnimationFrame`：浏览器约 250ms 派发一次，对字幕切换足够准，又不会每帧触发 React 重渲染；监听里只在「当前 cue 真的换了」时才 `setState`。
- 开关状态放 `localStorage`，单镜头灯箱和成片播放器共用；字幕层 `pointer-events-none`，不抢原生 controls 的点击。

**接入点**：`NodeDetail.tsx` 的 `MediaTile / MediaPreview` 增加可选 `subtitleShots`，镜头缩略图点开灯箱时带该镜台词，成片按钮带整组镜头；`MediaLightbox` 拿到视频真实时长后重算 cue，工具条多一个「字幕」开关。

**验证**
- shared 15 个新用例（`subtitle.test.ts`）：shared 版解析、长句断句、单镜头铺满、旁白/说话人前缀、多角色长句拆条与不重叠、无 duration 时估算、多段累加、`totalDuration` 缩放、超长台词压缩不越界、空输入。
- 前端 10 个新用例（`subtitle-overlay.test.tsx`）：时间落在区间内显示、切换条目、空隙不残留、关闭不渲染、无台词不渲染、`seeked` 重新定位、单镜头/成片时间轴、开关持久化到 localStorage。
- 全仓 **415 个测试全过**（shared 79 / agent 92 / server 221 / frontend 23），`pnpm -r build` / `pnpm -r typecheck` 通过。

**没做**：导出的 `final.mp4` 不带字幕，字幕只在本站播放器里可见（要带出去得配带 libass 的 ffmpeg 做真烧录，或让下载同时给 `final.srt`）；成片时间轴是按镜头 duration **比例**估算，个别镜头被延长较多时字幕会偏几百毫秒；字幕没有字号/位置自定义，也没做双语或卡拉 OK 逐字高亮。

## 部署止血：WS 同源 + 生产镜像模块解析

**动机**：静态体检发现两处「必然失败」的运行时问题，都不涉及业务逻辑，先修掉。

**WS 地址硬编码**。`useWebSocket.ts` 原来无条件拼 `http://${location.hostname}:3000`：nginx 明明已经反代 `/ws/`，前端却完全绕开；换成 HTTPS 域名后还会被 mixed content 直接拦掉。现在与 API 共用 `client.ts` 的地址解析——显式 `VITE_API_URL` 优先、开发环境换端口 3000、生产用 `window.location.origin`、SSR 回落 localhost。解析逻辑抽成纯函数 `resolveApiBase(location, env)`，环境读取只剩薄薄一层，四种形态都能直接测（新增 4 个用例）。

**Dockerfile 生产镜像**。原来只拷 `.pnpm`，软链入口全丢，`node dist/main.js` 必然 `MODULE_NOT_FOUND`。核查后发现是两层问题：

1. pnpm 的 bare import 软链分布在**各包自己的 `node_modules`**（顶层只有 dev 工具），要把 shared / agent / server 三层的 `node_modules` 一起拷过去；
2. workspace 包的 `main` / `exports` 在源码态指向 `src/index.ts`（给 tsx 开发期直跑用），而生产镜像只有 `dist` —— 就算软链补齐，bare import 仍会解析到不存在的 `.ts`。生产阶段用一段 Node 脚本把 `main` / `types` / `exports` 改指 `dist/index.js` / `dist/index.d.ts`。tsup 只产出单入口 bundle，`dist/constants`、`dist/types` 都是空目录，所以子路径导出一并收敛成只有 `"."`。

本机没有 docker，没法实测镜像构建。改用临时目录按 Dockerfile 的拷贝布局重建生产目录做验证：`@miraframe/shared` / `@miraframe/agent` / `@langchain/*` / `@nestjs/common` / face-api / drizzle-orm / bullmq / socket.io 的 ESM `import.meta.resolve` 全部命中 `dist` 或 `.pnpm`，face-api 的模型文件也在软链目标里。

**仍未解决**：镜像里没有 ffmpeg/ffprobe，`TTS_PROVIDER=macos` 依赖的 `say` 在 Linux 上不存在，数据库迁移不自动跑，compose 没传 `env_file` / `ADMIN_TOKEN` / `PUBLIC_BASE_URL`，`static/` 没挂卷。这两项只是把「必挂」变成「还差配置」，**仍然不建议公网部署**。

## 面试准备：测试矩阵、演示脚本与脱稿速记

**补前端组件测试**。`NodeDetail` 10 个用例覆盖大纲/角色/分镜/画面/输出五类节点的空态、确认门、错误翻译、修改面板与灯箱字幕；`useWebSocket` 14 个用例按事件逐个断言 store 落点（run 生命周期、审批门、实体增删改、Critique 分阶段、一致性回执、yolo 自动确认）。前端从 27 升到 51 个，全仓 443。

测试里抓到一个真实 UI bug：镜头画面的 issue 原本写成 `videoIssue(s) ?? (drift ? "角色长相漂移" : null)`，视频还没生成时前者总返回「等待镜头视频」，把漂移提示短路了。改成漂移优先——进度提示不该盖住已经发现的问题。

**演示脚本**。`docs/DEMO_SCRIPT.md` 给出 2 分钟、7 段的分镜表：每段的时间、画面、操作和讲解要点；README 产品截图章节预留五张图的文件名与时间点（注释占位，图没到齐不会破图）。录制重点是人工确认门、一致性自动修复、两阶段 Critique 和字幕开关这些只有本项目才有的东西，不是堆生成结果。

**脱稿速记卡**。`docs/INTERVIEW_CHEATSHEET.md` 把 Q1–Q17 压成「一句话锚点 + 三个关键词」，Q14–Q17 展开讲法层次（旧痛点 → 设计 → 被测试逼出来的取舍 → 边界），另附主动交代的边界清单与代码定位表。`INTERVIEW_GUIDE.md` 顶部加了入口。
