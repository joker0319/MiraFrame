"use client";

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { projectsApi } from "@/services/projectsApi";
import { cn } from "@/lib/utils";
import { BRAND } from "@/lib/brand";
import { ArrowLeft, Check } from "lucide-react";
import type { CreateProjectPayload } from "@/types";

type ProviderKey = string | null;

interface FormData {
  title: string;
  story: string;
  style: string;
  text_provider_override: ProviderKey;
  image_provider_override: ProviderKey;
  video_provider_override: ProviderKey;
}

const STYLES: { slug: string; label: string; category: string }[] = [
  { slug: "anime", label: "日式动漫", category: "2D 动画" },
  { slug: "shonen", label: "热血少年", category: "2D 动画" },
  { slug: "slice-of-life", label: "日常系", category: "2D 动画" },
  { slug: "manga", label: "黑白漫画", category: "2D 动画" },
  { slug: "donghua", label: "国风动画", category: "2D 动画" },
  { slug: "guofeng-manga", label: "国风漫画", category: "2D 动画" },
  { slug: "cinematic", label: "电影级", category: "3D 风格" },
  { slug: "pixar", label: "皮克斯", category: "3D 风格" },
  { slug: "cyberpunk", label: "赛博朋克", category: "3D 风格" },
  { slug: "lowpoly", label: "低多边形", category: "3D 风格" },
  { slug: "watercolor", label: "水彩", category: "艺术风格" },
  { slug: "fairy-tale", label: "童话", category: "艺术风格" },
  { slug: "sketch", label: "素描", category: "艺术风格" },
  { slug: "realistic", label: "写实", category: "艺术风格" },
];

const PROVIDER_OPTIONS = ["inherit-default", "anthropic", "openai", "fake"] as const;

function getProviderLabel(key: string): string {
  const map: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    fake: "Fake（本地测试）",
    "inherit-default": "继承默认",
  };
  return map[key] || key;
}

export default function NewProjectPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormData>({
    title: "",
    story: "",
    style: "cinematic",
    text_provider_override: null,
    image_provider_override: null,
    video_provider_override: null,
  });

  const createMutation = useMutation({
    mutationFn: () => projectsApi.create(form as CreateProjectPayload),
    onSuccess: (project) => {
      navigate(`/project/${project.id}?autoStart=true`);
    },
  });

  const updateForm = (patch: Partial<FormData>) => setForm((f) => ({ ...f, ...patch }));

  const categories = [...new Set(STYLES.map((s) => s.category))];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 h-12 border-b border-line bg-paper">
        <Link to="/" className="text-[12.5px] text-ink-3 hover:text-ink-1 flex items-center gap-1.5 transition-colors duration-150">
          <ArrowLeft className="h-4 w-4" strokeWidth={1.7} />
          返回
        </Link>
        <div className="flex items-center gap-2.5">
          <span
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] font-serif text-[15px] leading-none text-primary"
            style={{ boxShadow: "inset 0 0 0 1.5px var(--color-primary)" }}
            aria-hidden="true"
          >
            弥
          </span>
          <span className="text-[13.5px] font-semibold text-ink-1">{BRAND.name}</span>
          <span className="font-serif text-[13px] text-ink-3">{BRAND.cnName}</span>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-medium",
                  step > s ? "bg-success text-success-content" : step === s ? "bg-primary text-primary-foreground" : "bg-base-300 text-ink-3",
                )}
              >
                {step > s ? <Check className="h-4 w-4" /> : s}
              </div>
              {s < 3 && <div className={cn("w-8 h-px", step > s ? "bg-success" : "bg-line")} />}
            </div>
          ))}
        </div>

        {/* Step 1: Story */}
        {step === 1 && (
          <div className="card p-6 space-y-4">
            <h2 className="font-serif text-[19px] font-medium tracking-[-0.02em] text-ink-1">故事</h2>
            <div>
              <label className="text-sm font-medium block mb-1">项目标题 *</label>
              <input
                className="input input-bordered"
                placeholder="给你的项目起个名字"
                value={form.title}
                onChange={(e) => updateForm({ title: e.target.value })}
              />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">故事内容</label>
              <textarea
                className="textarea textarea-bordered"
                rows={8}
                placeholder="很久很久以前..."
                value={form.story}
                onChange={(e) => updateForm({ story: e.target.value })}
              />
            </div>
            <button
              onClick={() => setStep(2)}
              disabled={!form.title.trim()}
              className="btn btn-primary w-full"
            >
              下一步 →
            </button>
          </div>
        )}

        {/* Step 2: Style */}
        {step === 2 && (
          <div className="card p-6 space-y-6">
            <h2 className="font-serif text-[19px] font-medium tracking-[-0.02em] text-ink-1">风格</h2>

            {/* Style templates */}
            <div className="space-y-4">
              {categories.map((category) => (
                <div key={category}>
                  <p className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-4">{category}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {STYLES.filter((s) => s.category === category).map((s) => (
                      <button
                        key={s.slug}
                        onClick={() => updateForm({ style: s.slug })}
                        aria-pressed={form.style === s.slug}
                        className={cn(
                          "px-3 py-1.5 text-[12.5px] rounded transition-[box-shadow,color] duration-150",
                          form.style === s.slug
                            ? "bg-primary text-primary-foreground shadow-[inset_0_0_0_1px_var(--color-primary)]"
                            : "bg-surface text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-ink-1 hover:shadow-[inset_0_0_0_1px_var(--color-ink-4)]",
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Provider overrides */}
            <div className="space-y-3">
              <h3 className="text-[12.5px] font-medium text-ink-2">服务商覆盖（可选）</h3>
              {(["text", "image", "video"] as const).map((modality) => (
                <div key={modality}>
                  <label className="mb-1 block text-[11.5px] text-ink-3">
                    {modality === "text" ? "文本生成" : modality === "image" ? "图像生成" : "视频生成"}
                  </label>
                  <div className="flex flex-wrap gap-1">
                    {PROVIDER_OPTIONS.map((opt) => (
                      <button
                        key={opt}
                        onClick={() => {
                          const key = `${modality}_provider_override` as keyof FormData;
                          updateForm({ [key]: opt === "inherit-default" ? null : opt } as Partial<FormData>);
                        }}
                        className={cn(
                          "px-2 py-1 text-[11.5px] rounded transition-[box-shadow,color] duration-150",
                          (form[`${modality}_provider_override` as keyof FormData] ?? null) === (opt === "inherit-default" ? null : opt)
                            ? "bg-primary text-primary-foreground shadow-[inset_0_0_0_1px_var(--color-primary)]"
                            : "bg-base-200 text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-ink-1",
                        )}
                      >
                        {getProviderLabel(opt)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button onClick={() => setStep(1)} className="btn btn-ghost flex-1">
                ← 返回
              </button>
              <button onClick={() => setStep(3)} className="btn btn-primary flex-1">
                下一步 →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Confirm */}
        {step === 3 && (
          <div className="card p-6 space-y-4">
            <h2 className="text-xl font-bold">确认</h2>
            <div className="space-y-2">
              <h3 className="text-lg font-bold">{form.title || "未命名项目"}</h3>
              <span className="badge badge-primary badge-sm">{form.style}</span>
              {form.story && <p className="text-sm text-muted-foreground line-clamp-4 mt-2">{form.story}</p>}
            </div>

            {/* Provider summary */}
            <div className="border border-base-300 rounded-lg p-3 space-y-1">
              <p className="text-xs font-medium mb-2">服务商配置</p>
              {(["text", "image", "video"] as const).map((m) => (
                <p key={m} className="text-xs text-muted-foreground">
                  <span className="capitalize">{m}</span>: {getProviderLabel((form[`${m}_provider_override` as keyof FormData] as string | null) || "inherit-default")}
                </p>
              ))}
            </div>

            {createMutation.isError && (
              <div className="alert alert-error">
                创建失败: {(createMutation.error as Error)?.message || "请重试"}
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={() => setStep(2)} className="btn btn-ghost flex-1">
                ← 返回
              </button>
              <button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending}
                className="btn btn-primary flex-1"
              >
                {createMutation.isPending ? "创建中..." : "创建项目"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
