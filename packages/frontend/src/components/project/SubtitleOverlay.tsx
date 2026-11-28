"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Captions } from "lucide-react";
import { planSubtitleCues, type SubtitleCue } from "@miraframe/shared/utils/dialogue";
import { cn } from "@/lib/utils";

/**
 * 字幕是 DOM 层，不碰视频像素。
 *
 * 之所以不做烧录：本机 ffmpeg 没编 libass，而且烧录会把字幕永久固化进 mp4，
 * 改一句台词就得重新编码整条片子。DOM 叠加可以随时开关、随时改文案，
 * 生成链路的正确性验证也不会被渲染依赖卡住。
 */

const STORAGE_KEY = "miraframe.subtitles.enabled";

export interface SubtitleShotInput {
  dialogue?: string | null;
  duration?: number | null;
}

/** 字幕开关，偏好记在 localStorage，所有播放器共用 */
export function useSubtitlePreference(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const update = useCallback((next: boolean) => {
    setEnabled(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
      // 隐私模式下写不进去也不影响本次会话
    }
  }, []);
  return [enabled, update];
}

/** 单镜头：整段视频时长就是这一条台词的可用时长 */
export function planClipSubtitles(
  dialogue: string | null | undefined,
  duration: number,
): SubtitleCue[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  return planSubtitleCues([{ dialogue, duration }], { totalDuration: duration });
}

/**
 * 成片：按镜头顺序累加时间轴。
 * 各镜头 duration 之和不一定等于成片时长（台词过长时服务端会冻结末帧延长画面），
 * 所以拿到视频真实时长后按比例把误差摊回每个镜头。
 */
export function planProjectSubtitles(
  shots: SubtitleShotInput[],
  totalDuration: number,
): SubtitleCue[] {
  if (shots.length === 0) return [];
  return planSubtitleCues(
    shots.map((shot) => ({
      dialogue: shot.dialogue,
      duration: shot.duration && shot.duration > 0 ? shot.duration : 5,
    })),
    { totalDuration: totalDuration > 0 ? totalDuration : undefined },
  );
}

type VideoRef = { current: HTMLVideoElement | null };

/**
 * 用 timeupdate 驱动，不启 rAF：浏览器约 250ms 派发一次，
 * 对字幕切换足够准，又不会每帧触发 React 重渲染。
 */
export function SubtitleOverlay({
  videoRef,
  cues,
  enabled = true,
}: {
  videoRef: VideoRef;
  cues: SubtitleCue[];
  enabled?: boolean;
}) {
  const [active, setActive] = useState<SubtitleCue | null>(null);
  const activeRef = useRef<SubtitleCue | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !enabled || cues.length === 0) {
      activeRef.current = null;
      setActive(null);
      return;
    }

    const sync = () => {
      const time = video.currentTime;
      const next = cues.find((cue) => time >= cue.start && time < cue.end) ?? null;
      // 只有真正换条时才 setState，绝大多数 timeupdate 都是空转
      if (next !== activeRef.current) {
        activeRef.current = next;
        setActive(next);
      }
    };

    sync();
    video.addEventListener("timeupdate", sync);
    video.addEventListener("seeked", sync);
    video.addEventListener("loadedmetadata", sync);
    return () => {
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("seeked", sync);
      video.removeEventListener("loadedmetadata", sync);
      activeRef.current = null;
    };
  }, [videoRef, cues, enabled]);

  if (!enabled || !active) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[7%] flex justify-center px-4">
      <p
        className={cn(
          "max-w-[82%] rounded-[5px] bg-black/55 px-3 py-1.5 text-center",
          "text-[14px] font-medium leading-6 text-white md:text-[16px]",
          "shadow-[0_1px_10px_rgba(0,0,0,0.45)] [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]",
        )}
      >
        {active.text}
      </p>
    </div>
  );
}

export function SubtitleToggle({
  enabled,
  onToggle,
  className,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={enabled}
      onClick={() => onToggle(!enabled)}
      title={enabled ? "关闭字幕" : "开启字幕"}
      className={cn(
        "inline-flex items-center gap-1 rounded-[5px] px-2.5 py-1.5 text-[12px] transition-colors",
        enabled ? "text-current" : "opacity-55 line-through",
        className,
      )}
    >
      <Captions className="h-4 w-4" strokeWidth={1.8} />
      字幕
    </button>
  );
}
