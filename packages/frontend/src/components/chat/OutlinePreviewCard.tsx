"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, FileText, RotateCcw } from "lucide-react";
import type { StoryOutline } from "@/types";
import { cn } from "@/lib/utils";

interface OutlinePreviewCardProps {
  outline: StoryOutline;
  visualBible?: string | null;
  onConfirm: () => void;
  onRegenerate: (feedback: string) => void;
}

export function OutlinePreviewCard({
  outline,
  visualBible,
  onConfirm,
  onRegenerate,
}: OutlinePreviewCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(outline, null, 2));
  const [feedback, setFeedback] = useState("");

  const handleRegenerate = () => {
    let combined = feedback;
    try {
      const edited = JSON.parse(draft);
      combined += `\n\n大纲编辑:\n${JSON.stringify(edited, null, 2)}`;
    } catch {
      // Use feedback alone
    }
    onRegenerate(combined);
  };

  return (
    <div className="overflow-hidden rounded-[6px] bg-base-100 shadow-[inset_0_0_0_1px_rgba(140,29,47,0.18)]">
      <div className="border-b border-line-soft bg-primary/[0.04] px-3 py-3">
        <div className="flex items-start gap-2">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] bg-surface text-primary">
            <FileText className="h-3.5 w-3.5" strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-primary">故事大纲节点</span>
            <h3 className="mt-0.5 text-[13px] font-medium text-ink-1">项目规划已完成，等待确认</h3>
          </div>
          <span className="badge badge-sm badge-info">待确认</span>
        </div>
      </div>

      <div className="space-y-3 p-3">
        {outline.logline && (
          <p className="text-[12.5px] leading-6 text-ink-2">{outline.logline}</p>
        )}

        {/* Genres */}
        {outline.genre?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {outline.genre.map((g, i) => (
              <span key={i} className="badge badge-sm badge-outline">
                {g}
              </span>
            ))}
          </div>
        )}

        {/* Acts */}
        <div className="space-y-2">
          {outline.acts?.map((act) => (
            <div key={act.act} className="rounded-[5px] bg-base-200 p-2 text-[11.5px]">
              <span className="font-medium text-ink-1">
                第{act.act}幕 {act.title}
              </span>
              <p className="mt-1 leading-5 text-ink-3">{act.summary}</p>
            </div>
          ))}
        </div>

        {/* Visual Bible preview */}
        {visualBible && (
          <div className="border-t border-line-soft pt-2 text-[11.5px] leading-5 text-ink-3">
            <span className="font-medium text-ink-2">视觉风格: </span>
            {visualBible.length > 120 ? visualBible.slice(0, 120) + "..." : visualBible}
          </div>
        )}

        {/* Toggle expand */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
          {expanded ? "收起编辑" : "展开详细大纲"}
        </button>

        {/* Expanded editor */}
        {expanded && (
          <div className="space-y-2">
            <textarea
              className="textarea w-full font-mono text-[11px]"
              rows={8}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <textarea
              className="textarea w-full text-[11.5px]"
              rows={3}
              placeholder="输入重新生成的反馈意见..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button onClick={onConfirm} className="btn btn-primary btn-sm gap-1">
            <CheckCircle2 className="h-4 w-4" />
            确认并进入角色
          </button>
          <button onClick={handleRegenerate} className="btn btn-outline btn-sm gap-1">
            <RotateCcw className="h-4 w-4" />
            按反馈重生成
          </button>
        </div>
      </div>
    </div>
  );
}
