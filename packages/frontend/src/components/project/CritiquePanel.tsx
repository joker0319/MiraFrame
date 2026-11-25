"use client";

import { useCritiqueStore } from "@/stores/critiqueStore";
import { cn } from "@/lib/utils";
import type { CritiqueResultEventData } from "@/types";

/** Critic 提示词里约定的四个维度；模型偶尔会多给或换名，未知 key 直接原样显示 */
const DIMENSION_LABELS: Record<string, string> = {
  narrative: "叙事",
  continuity: "连贯性",
  camera: "镜头语言",
  generatable: "可生成性",
  clarity: "清晰度",
  creativity: "创意",
  consistency: "一致性",
  // 关键帧视觉审查的四个维度（CRITIC_SYSTEM_PROMPT）
  quality: "画面质量",
  style: "画风",
  composition: "构图",
};

function dimensionLabel(key: string): string {
  return DIMENSION_LABELS[key] ?? key;
}

function ScoreBar({ value, tone }: { value: number; tone: "ok" | "bad" }) {
  const pct = Math.max(0, Math.min(100, (value / 10) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-base-300/70">
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", tone === "ok" ? "bg-success" : "bg-error")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * 两个阶段共用一张卡片，靠 `stage` 区分：
 * - `critique_shots`：分镜脚本审查（读文本），不通过会回灌重写；
 * - `keyframe`：关键帧视觉审查（读图），不通过时只重画个别镜头。
 * 数据都来自 WS `critique_result`，后端同时往消息流写一条文本。
 */
function stageCopy(stage: string): { title: string; hint: string; failed: string } {
  if (stage === "keyframe") {
    return {
      title: "关键帧视觉审查",
      hint: "视觉模型逐张看画面，检查画风、肢体结构、构图与乱码文字；结构性问题会按参考图重画。",
      failed: "画面未达标，问题清单已记录；可在镜头详情里手动重画或调整提示词。",
    };
  }
  return {
    title: "自动审查",
    hint: "Critic 按叙事、连贯性、镜头语言、可生成性四个维度给分，未达阈值会把意见回灌给分镜节点重写。",
    failed: "本轮未通过，但已到轮次上限，转人工确认。",
  };
}
export function CritiquePanel({ critique }: { critique?: CritiqueResultEventData | null }) {
  const latest = useCritiqueStore((s) => s.latest);
  const history = useCritiqueStore((s) => s.history);
  const byStage = useCritiqueStore((s) => s.byStage);
  const entry = critique !== undefined ? critique : latest;
  const copy = stageCopy(entry?.stage ?? "critique_shots");
  // 两个阶段的分数各自收敛，混在一起画轨迹会得到一条没有意义的曲线
  const stageHistory = entry ? history.filter((item) => item.stage === entry.stage) : [];
  // 主卡片显示最近一次，另一阶段的结果压缩成一行，避免各看各的时信息缺失
  const sibling = entry
    ? Object.values(byStage).find((item) => item.stage !== entry.stage) ?? null
    : null;

  return (
    <section className="mt-6 border-t border-line-soft pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">{copy.title}</p>
          <p className="mt-1 text-[11.5px] leading-5 text-ink-4">{copy.hint}</p>
        </div>
        {entry && (
          <span
            className={cn(
              "shrink-0 rounded-[4px] px-2 py-1 font-mono text-[10.5px] tabular-nums",
              entry.passed ? "bg-success-tint text-success" : "bg-error-tint text-error",
            )}
          >
            第 {entry.round}/{entry.max_rounds} 轮
          </span>
        )}
      </div>

      {!entry ? (
        <div className="mt-3 rounded-[6px] bg-base-200/60 px-3 py-3 text-[12px] text-ink-3">
          还没有评审结果。分镜生成后会自动跑一次审查，结果实时出现在这里。
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-end gap-3">
            <div className="flex items-baseline gap-1">
              <span
                className={cn(
                  "font-mono text-[26px] leading-none tabular-nums",
                  entry.passed ? "text-success" : "text-error",
                )}
              >
                {entry.score.toFixed(1)}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-ink-4">/10</span>
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <ScoreBar value={entry.score} tone={entry.passed ? "ok" : "bad"} />
              <p className="mt-1 font-mono text-[10.5px] tabular-nums text-ink-4">
                阈值 {entry.threshold} · {entry.passed ? "已通过" : "未达阈值"}
              </p>
            </div>
          </div>

          {!entry.passed && (
            <p className="mt-2 rounded-[6px] border border-warning/25 bg-warning-tint px-2.5 py-2 text-[11.5px] leading-5 text-warning">
              {entry.will_regenerate
                ? entry.stage === "keyframe"
                  ? "画面未达标，已按参考图重画问题镜头。"
                  : "本轮未通过，评审意见已回灌，分镜将重写后重新审查。"
                : copy.failed}
            </p>
          )}

          {Object.keys(entry.dimensions).length > 0 && (
            <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
              {Object.entries(entry.dimensions).map(([key, value]) => (
                <li key={key}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-ink-3">{dimensionLabel(key)}</span>
                    <span className="font-mono text-[10.5px] tabular-nums text-ink-4">{value}</span>
                  </div>
                  <div className="mt-1">
                    <ScoreBar value={value} tone={value >= entry.threshold ? "ok" : "bad"} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {entry.issues.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] font-medium text-error">问题 {entry.issues.length}</p>
              <ul className="mt-1 space-y-1">
                {entry.issues.map((issue, i) => (
                  <li key={i} className="text-[11.5px] leading-5 text-ink-2">
                    · {issue}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {entry.suggestions.length > 0 && (
            <div className="mt-2.5">
              <p className="text-[11px] font-medium text-ink-3">修改建议</p>
              <ul className="mt-1 space-y-1">
                {entry.suggestions.map((suggestion, i) => (
                  <li key={i} className="text-[11.5px] leading-5 text-ink-3">
                    · {suggestion}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sibling && (
            <p className="mt-3 border-t border-line-soft pt-2 font-mono text-[10.5px] tabular-nums text-ink-4">
              {stageCopy(sibling.stage).title}：{sibling.score.toFixed(1)} 分 ·{" "}
              {sibling.passed ? "通过" : `${sibling.issues.length} 个问题`}
            </p>
          )}

          {stageHistory.length > 1 && (
            <p className="mt-3 font-mono text-[10.5px] tabular-nums text-ink-4">
              收敛轨迹：
              {stageHistory
                .map((h, i) => `R${i + 1} ${h.score.toFixed(1)}`)
                .join(" → ")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
