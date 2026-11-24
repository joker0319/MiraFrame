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
 * 自动审查（LLM-as-Judge）结果卡片。
 * 数据来自 WS `critique_result` 事件，由 CriticAgent 每轮评审后上报；
 * 后端同时会往消息流写一条文本，这里负责把分数、阈值、打回原因结构化展示。
 */
export function CritiquePanel({ critique }: { critique?: CritiqueResultEventData | null }) {
  const latest = useCritiqueStore((s) => s.latest);
  const history = useCritiqueStore((s) => s.history);
  const entry = critique !== undefined ? critique : latest;

  return (
    <section className="mt-6 border-t border-line-soft pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">自动审查</p>
          <p className="mt-1 text-[11.5px] leading-5 text-ink-4">
            Critic 按叙事、连贯性、镜头语言、可生成性四个维度给分，未达阈值会把意见回灌给分镜节点重写。
          </p>
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
                ? "本轮未通过，评审意见已回灌，分镜将重写后重新审查。"
                : "本轮未通过，但已到轮次上限，转人工确认。"}
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

          {history.length > 1 && (
            <p className="mt-3 font-mono text-[10.5px] tabular-nums text-ink-4">
              收敛轨迹：
              {history
                .map((h, i) => `R${i + 1} ${h.score.toFixed(1)}`)
                .join(" → ")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
