"use client";

import { useEffect, useRef } from "react";
import { Film, Lightbulb, Palette } from "lucide-react";
import { useRunStore } from "@/stores/runStore";
import { useMessageStore } from "@/stores/messageStore";
import { MessageList } from "./MessageList";
import { getWorkflowStageInfo } from "@/utils/workflowStage";

function StageIcon({ icon, className }: { icon?: string; className?: string }) {
  const Cmp = icon === "film" ? Film : icon === "palette" ? Palette : Lightbulb;
  return <Cmp className={className} strokeWidth={1.6} aria-hidden="true" />;
}

interface ChatPanelProps {
  onCancel: () => void;
  isGenerating: boolean;
}

export function ChatPanel({
  onCancel,
  isGenerating,
}: ChatPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Store reads
  const messages = useMessageStore((s) => s.messages);
  const currentAgent = useRunStore((s) => s.currentAgent);
  const awaitingConfirm = useRunStore((s) => s.awaitingConfirm);
  const currentStage = useRunStore((s) => s.currentStage);

  // Derived
  const info = getWorkflowStageInfo(currentStage);
  const hasMessages = messages.length > 0;
  const agentDisplayName = currentAgent || "AI";

  // Auto-scroll
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="flex h-full flex-col bg-base-100">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        {info && (
          <>
            <StageIcon icon={info.icon} className="h-3.5 w-3.5 text-ink-3" />
            <span className="flex-1 text-[12.5px] font-medium text-ink-1">{info.label}</span>
          </>
        )}
      </div>

      {/* Generating indicator */}
      {isGenerating && !awaitingConfirm && (
        <div className="flex items-center gap-2 border-b border-line-soft bg-warning-tint px-3 py-1.5">
          <span className="loading loading-dots loading-xs text-warning" />
          <span className="flex-1 text-[11.5px] text-ink-2">{agentDisplayName}</span>
          <span className="badge badge-xs badge-warning">AUTO</span>
          <button onClick={onCancel} className="btn btn-xs btn-ghost text-error">
            停止
          </button>
        </div>
      )}

      {/* Scrollable messages area */}
      <div
        ref={scrollContainerRef}
        className="halftone-bg flex-1 overflow-y-auto"
      >
        {!hasMessages && !isGenerating && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <StageIcon icon={info?.icon} className="h-6 w-6 text-ink-4" />
            <p className="max-w-[220px] text-[12px] leading-6 text-ink-3">
              {info?.description || "准备开始生成"}
            </p>
          </div>
        )}

        <MessageList messages={messages} />
      </div>
    </div>
  );
}
