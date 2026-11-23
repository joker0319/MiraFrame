"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ScanFace } from "lucide-react";
import { cn } from "@/lib/utils";
import { consistencyApi } from "@/services/consistencyApi";
import type { ConsistencyReportRead, ConsistencyShotVerdict, ConsistencyExpectedStatus } from "@/types";

const VERDICT_META: Record<ConsistencyShotVerdict, { label: string; tone: string; dot: string }> = {
  ok: { label: "一致", tone: "text-success", dot: "bg-success" },
  review: { label: "待确认", tone: "text-warning", dot: "bg-warning" },
  drift: { label: "漂移", tone: "text-error", dot: "bg-error" },
  unverifiable: { label: "无法校验", tone: "text-ink-3", dot: "bg-ink-4" },
};

const STATUS_LABEL: Record<ConsistencyExpectedStatus, string> = {
  consistent: "一致",
  review: "待确认",
  drift: "漂移",
  missing: "未检出",
  no_reference: "无参考",
};

/**
 * 角色一致性面板：拿角色参考图的人脸特征，比每个镜头里的人脸。
 * 数据由后端按需计算，不落库，所以这里只有「检查」没有「历史」。
 */
export function ConsistencyPanel({ projectId }: { projectId: number }) {
  const [report, setReport] = useState<ConsistencyReportRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await consistencyApi.check(projectId, { refresh }));
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : "检查失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // 进入面板即自动跑一次，命中缓存时约 2 秒
  useEffect(() => {
    void run();
  }, [run]);

  return (
    <section className="mt-6 border-t border-line-soft pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">角色一致性</p>
          <p className="mt-1 text-[11.5px] leading-5 text-ink-4">
            比对每个镜头里的人脸与角色参考图，判断长相是否漂移。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void run(true)}
          disabled={loading}
          className="btn btn-outline btn-xs shrink-0 gap-1"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          {loading ? "检查中" : "重新检查"}
        </button>
      </div>

      {loading && !report && (
        <div className="mt-3 flex items-center gap-2 rounded-[6px] bg-base-200/60 px-3 py-3 text-[12px] text-ink-3">
          <ScanFace className="h-4 w-4 shrink-0 text-ink-4" />
          正在比对画面中的人脸，首次检查约 2–3 秒…
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-[6px] border border-error/25 bg-error-tint px-3 py-2.5">
          <p className="text-[12px] leading-5 text-error">{error}</p>
        </div>
      )}

      {report && !error && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {(["ok", "review", "drift", "unverifiable"] as ConsistencyShotVerdict[]).map((key) => {
              const count = report.summary[key];
              if (!count) return null;
              const meta = VERDICT_META[key];
              return (
                <span
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-[4px] bg-base-200/70 px-2 py-1 font-mono text-[10.5px] tabular-nums text-ink-3"
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
                  {meta.label} {count}
                </span>
              );
            })}
            <span className="ml-auto font-mono text-[10.5px] tabular-nums text-ink-4">
              {report.shots.length} 个镜头
            </span>
          </div>

          {report.characters.some((c) => c.referenceFaces === 0) && (
            <p className="mt-2 rounded-[6px] border border-warning/25 bg-warning-tint px-2.5 py-2 text-[11.5px] leading-5 text-warning">
              {report.characters
                .filter((c) => c.referenceFaces === 0)
                .map((c) => c.name)
                .join("、")}
              ：参考图里检不出人脸，这类角色无法自动校验（半透明、背影或非人形都会导致检测失败）。
            </p>
          )}

          <ul className="mt-3 space-y-1.5">
            {report.shots.map((shot) => {
              const meta = VERDICT_META[shot.verdict];
              const checked = shot.expected.filter((e) => e.status !== "no_reference");
              return (
                <li key={shot.shotId} className="rounded-[6px] ring-1 ring-line-soft px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10.5px] tabular-nums text-ink-4">
                      {String(shot.order).padStart(2, "0")}
                    </span>
                    <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", meta.dot)} />
                    <span className={cn("text-[11px] font-medium", meta.tone)}>{meta.label}</span>
                    <span className="ml-auto flex items-center gap-2 font-mono text-[10px] tabular-nums text-ink-4">
                      {checked.map((e) => (
                        <span key={e.characterId} title={`${e.name}：${STATUS_LABEL[e.status]}`}>
                          {e.name} {e.distance !== null ? e.distance.toFixed(2) : "—"}
                        </span>
                      ))}
                    </span>
                  </div>
                  <p className="mt-1 pl-[26px] text-[12px] leading-5 text-ink-2">{shot.message}</p>
                </li>
              );
            })}
          </ul>

          <p className="mt-2 font-mono text-[10px] leading-4 text-ink-4">
            阈值 ≤{report.thresholds.ok} 一致 · &gt;{report.thresholds.drift} 漂移（人脸特征欧氏距离）
          </p>
        </>
      )}
    </section>
  );
}
