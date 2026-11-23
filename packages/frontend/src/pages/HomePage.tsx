"use client";

import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { TopBar } from "@/components/layout/TopBar";
import { projectsApi } from "@/services/projectsApi";
import { cn } from "@/lib/utils";
import { BRAND } from "@/lib/brand";
import {
  ArrowUp,
  ChevronDown,
  Plus,
  SlidersHorizontal,
  X,
  FileText,
  Users,
  Film,
  Image as ImageIcon,
  Clapperboard,
} from "lucide-react";

/* 风格谱系：保留真实的封面图（具体信息），去掉装饰性渐变。
   tone 仅用于极小面积的代表色点，全部为低饱和。 */
const STYLES: {
  slug: string;
  label: string;
  category: string;
  mood: string;
  cover: number;
  tone: string;
}[] = [
  { slug: "anime", label: "日式动漫", category: "2D 动画", mood: "清透 / 高光", cover: 2, tone: "#7d8aa8" },
  { slug: "shonen", label: "热血少年", category: "2D 动画", mood: "速度线 / 爆发", cover: 2, tone: "#a85c4a" },
  { slug: "slice-of-life", label: "日常系", category: "2D 动画", mood: "柔光 / 治愈", cover: 1, tone: "#a89478" },
  { slug: "manga", label: "黑白漫画", category: "2D 动画", mood: "网点 / 线稿", cover: 3, tone: "#6f6a62" },
  { slug: "donghua", label: "国风动画", category: "2D 动画", mood: "水墨 / 云气", cover: 4, tone: "#5d7a6b" },
  { slug: "guofeng-manga", label: "国风漫画", category: "2D 动画", mood: "卷轴 / 墨线", cover: 4, tone: "#8a6a4a" },
  { slug: "cinematic", label: "电影级", category: "3D 风格", mood: "宽银幕 / 质感", cover: 6, tone: "#4a4a52" },
  { slug: "pixar", label: "皮克斯", category: "3D 风格", mood: "圆润 / 明亮", cover: 2, tone: "#b08a5a" },
  { slug: "cyberpunk", label: "赛博朋克", category: "3D 风格", mood: "霓虹 / 夜色", cover: 5, tone: "#6b5a82" },
  { slug: "lowpoly", label: "低多边形", category: "3D 风格", mood: "几何 / 玩具感", cover: 3, tone: "#7a8478" },
  { slug: "watercolor", label: "水彩", category: "艺术风格", mood: "晕染 / 纸纹", cover: 1, tone: "#8fa2b0" },
  { slug: "fairy-tale", label: "童话", category: "艺术风格", mood: "梦境 / 暖光", cover: 6, tone: "#a08a9a" },
  { slug: "sketch", label: "素描", category: "艺术风格", mood: "铅笔 / 草图", cover: 3, tone: "#7f7b74" },
  { slug: "realistic", label: "写实", category: "艺术风格", mood: "自然光 / 细节", cover: 5, tone: "#6b6357" },
];

const PIPELINE = [
  { step: "01", label: "故事大纲", icon: FileText, note: "提炼叙事骨架" },
  { step: "02", label: "角色设定", icon: Users, note: "抽取人物并出形象" },
  { step: "03", label: "分镜脚本", icon: Film, note: "拆解可拍摄镜头" },
  { step: "04", label: "镜头视频", icon: ImageIcon, note: "首帧驱动逐镜生成" },
  { step: "05", label: "合成输出", icon: Clapperboard, note: "拼接为完整成片" },
];

export default function HomePage() {
  const navigate = useNavigate();

  const [story, setStory] = useState("");
  const [style, setStyle] = useState("anime");
  const [shotCount, setShotCount] = useState(6);
  const [characterHints, setCharacterHints] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isComposing, setIsComposing] = useState(false);

  /* A 类一次性入场：挂载时置运行态，动画结束后移除，DOM 回到纯静态 */
  const [runAnim, setRunAnim] = useState(false);
  useEffect(() => {
    setRunAnim(true);
    const timer = window.setTimeout(() => setRunAnim(false), 1400);
    return () => window.clearTimeout(timer);
  }, []);

  const createMutation = useMutation({
    mutationFn: async () => {
      const title = story.split("\n")[0].trim().slice(0, 50) || "未命名项目";
      return projectsApi.create({
        title,
        story,
        style,
        target_shot_count: shotCount || undefined,
        character_hints: characterHints.filter((h) => h.trim()),
      });
    },
    onSuccess: (project) => {
      navigate(`/project/${project.id}?autoStart=true`);
    },
  });

  const handleSubmit = useCallback(() => {
    if (!story.trim()) return;
    createMutation.mutate();
  }, [story, createMutation]);

  const addCharacterHint = () => {
    if (characterHints.length < 6) setCharacterHints([...characterHints, ""]);
  };
  const updateCharacterHint = (index: number, value: string) => {
    const updated = [...characterHints];
    updated[index] = value;
    setCharacterHints(updated);
  };
  const removeCharacterHint = (index: number) => {
    setCharacterHints(characterHints.filter((_, i) => i !== index));
  };

  const categories = [...new Set(STYLES.map((s) => s.category))];
  const currentStyle = STYLES.find((s) => s.slug === style);

  return (
    <div className="min-h-screen bg-paper" data-run={runAnim ? "true" : "false"}>
      {/* A 类氛围层：固定底层，不拦截事件 */}
      <div className="atmosphere" aria-hidden="true">
        <div className="aurora" />
        <div className="paper-grid" />
        <div className="grain" />
      </div>

      <TopBar />

      <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-14 sm:pt-20">
        {/* 标题区 */}
        <section className="mb-10">
          <p className="eyebrow rise" style={{ ["--d" as string]: "0ms" }}>
            {BRAND.name.toUpperCase()} · 漫剧生成工作台
          </p>
          <h1
            className="display-serif mt-4 text-ink-1 rise"
            style={{ ["--d" as string]: "70ms" }}
          >
            把一段故事，
            <br />
            拆成能看的镜头
          </h1>
          <p
            className="mt-5 max-w-xl text-[14px] leading-[1.95] text-ink-2 rise"
            style={{ ["--d" as string]: "150ms" }}
          >
            写下角色、冲突与收尾，系统会先拆大纲，再推进角色形象、分镜脚本、镜头视频，最后合成为一条成片。
            每一步都留痕，可回看、可单点重生成。
          </p>
        </section>

        {/* 主输入卡 */}
        <section
          className="card p-1.5 rise"
          style={{ ["--d" as string]: "230ms" }}
        >
          <div className="relative">
            <textarea
              className="textarea w-full resize-none border-0 bg-transparent px-4 py-4 text-[14.5px] leading-[2] shadow-none focus:shadow-none"
              style={{ boxShadow: "none" }}
              rows={7}
              maxLength={5000}
              placeholder="把这一幕交给弥镜：角色是谁，冲突在哪，镜头想怎么收尾。写几句也行，我会先拆成大纲，再推进成角色、分镜与镜头视频。"
              value={story}
              onChange={(e) => setStory(e.target.value)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !isComposing) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              aria-label="故事梗概输入"
            />
            <div className="flex items-center justify-between gap-3 border-t border-line-soft px-3 py-2">
              <span className="font-mono text-[11px] text-ink-4 tabular-nums">
                {story.length} / 5000
              </span>
              <button
                onClick={handleSubmit}
                disabled={!story.trim() || createMutation.isPending}
                className="btn btn-primary rounded-md gap-1.5 px-4"
                aria-label="开始生成漫剧"
              >
                {createMutation.isPending ? (
                  <>
                    <span className="loading loading-spinner loading-sm" />
                    <span>创建中</span>
                  </>
                ) : (
                  <>
                    <span>开始生成</span>
                    <ArrowUp className="h-4 w-4" strokeWidth={1.8} />
                  </>
                )}
              </button>
            </div>
          </div>
        </section>

        {createMutation.isError && (
          <div className="alert alert-error mt-3" role="alert">
            <span>
              创建失败：{(createMutation.error as Error)?.message || "请重试"}
            </span>
          </div>
        )}

        {/* 风格谱系 */}
        <section
          className="mt-10 rise"
          style={{ ["--d" as string]: "310ms" }}
        >
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-[15px] font-semibold text-ink-1">风格谱系</h2>
              <p className="mt-1 text-[12.5px] leading-7 text-ink-3">
                选一张封面作为基调，后续角色与镜头会沿用同一套画风约束。
              </p>
            </div>
            <span className="shrink-0 rounded border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink-2">
              {currentStyle?.label}
            </span>
          </div>

          <div className="space-y-5">
            {categories.map((category) => (
              <div key={category}>
                <p className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-4">
                  {category}
                </p>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {STYLES.filter((s) => s.category === category).map((s) => {
                    const active = style === s.slug;
                    return (
                      <button
                        key={s.slug}
                        onClick={() => setStyle(s.slug)}
                        aria-pressed={active}
                        className={cn(
                          "group relative overflow-hidden rounded-md bg-surface text-left transition-[box-shadow,transform] duration-150",
                          active
                            ? "shadow-[inset_0_0_0_1.5px_var(--color-primary),0_6px_18px_-14px_rgba(25,25,23,.5)]"
                            : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-ink-4)]",
                        )}
                      >
                        <span className="relative block h-[68px] w-full overflow-hidden bg-base-200">
                          <img
                            src={`/style-covers/shot-${s.cover}.png`}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                            style={{
                              filter: active
                                ? "saturate(.72) contrast(1.02)"
                                : "saturate(.5) contrast(1) brightness(1.01)",
                              transition: "filter .15s ease",
                            }}
                          />
                          {/* 代表色点：极小面积，不构成装饰 */}
                          <span
                            className="absolute left-2 top-2 h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: s.tone }}
                            aria-hidden="true"
                          />
                        </span>
                        <span className="flex items-center justify-between gap-2 px-2.5 py-2">
                          <span className="min-w-0">
                            <span className="block truncate text-[12.5px] font-medium text-ink-1">
                              {s.label}
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] text-ink-3">
                              {s.mood}
                            </span>
                          </span>
                          {active && (
                            <span className="shrink-0 font-mono text-[10px] text-primary">
                              已选
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 更多选项 */}
        <section className="mt-8">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            aria-expanded={showAdvanced}
            className="flex items-center gap-2 text-[12.5px] text-ink-3 transition-colors duration-150 hover:text-ink-1"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.7} />
            更多选项
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                showAdvanced && "rotate-180",
              )}
              strokeWidth={1.7}
            />
          </button>

          {showAdvanced && (
            <div className="card-flat mt-3 space-y-5 p-4">
              <div>
                <label
                  htmlFor="shot-count"
                  className="mb-2 flex items-baseline justify-between text-[12.5px] text-ink-2"
                >
                  <span>分镜数量</span>
                  <span className="font-mono text-[12px] text-primary tabular-nums">
                    {shotCount || "默认"}
                  </span>
                </label>
                <input
                  id="shot-count"
                  type="range"
                  min={1}
                  max={20}
                  value={shotCount}
                  onChange={(e) => setShotCount(Number(e.target.value))}
                  className="range range-primary w-full"
                />
              </div>

              <div>
                <p className="mb-2 text-[12.5px] text-ink-2">角色提示</p>
                <div className="space-y-2">
                  {characterHints.map((hint, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        type="text"
                        className="input input-sm flex-1"
                        placeholder={`角色 ${i + 1}`}
                        value={hint}
                        onChange={(e) => updateCharacterHint(i, e.target.value)}
                        aria-label={`角色 ${i + 1} 提示`}
                      />
                      <button
                        onClick={() => removeCharacterHint(i)}
                        className="btn btn-ghost btn-xs btn-circle text-ink-3 hover:text-error"
                        aria-label={`移除角色 ${i + 1}`}
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={1.8} />
                      </button>
                    </div>
                  ))}
                </div>
                {characterHints.length < 6 && (
                  <button
                    onClick={addCharacterHint}
                    className="btn btn-ghost btn-xs mt-2 gap-1 text-ink-3"
                  >
                    <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
                    添加角色提示
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        {/* 流程说明：用真实阶段名替代装饰性口号 */}
        <section className="mt-14 border-t border-line-soft pt-8">
          <h2 className="mb-5 text-[13px] font-semibold text-ink-2">
            一条内容要经过的五道工序
          </h2>
          <ol className="grid grid-cols-1 gap-px overflow-hidden rounded-md bg-line sm:grid-cols-5">
            {PIPELINE.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.step} className="bg-surface px-3.5 py-4">
                  <div className="flex items-center justify-between">
                    <Icon className="h-4 w-4 text-ink-3" strokeWidth={1.6} />
                    <span className="font-mono text-[10.5px] text-ink-4 tabular-nums">
                      {item.step}
                    </span>
                  </div>
                  <p className="mt-2.5 text-[12.5px] font-medium text-ink-1">
                    {item.label}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-6 text-ink-3">
                    {item.note}
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      </main>
    </div>
  );
}
