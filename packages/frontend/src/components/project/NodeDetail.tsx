"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  Maximize2,
  Play,
  RefreshCw,
  SendHorizontal,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Character, ProjectRevisionPayload, Shot } from "@/types";
import {
  formatRunError,
  getOutlineActs,
  getOutlineLogline,
  isEditableWorkflowNode,
  isFinalVideoUrl,
  isInternalCompositionUrl,
  isPlayableVideoUrl,
  playableOrPreviewUrl,
  revisionTargetForNode,
  textOf,
  videoIssue,
  type WorkflowNode,
} from "@/utils/projectWorkflow";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";
import { ConsistencyPanel } from "./ConsistencyPanel";
import { CritiquePanel } from "./CritiquePanel";
import {
  planClipSubtitles,
  planProjectSubtitles,
  SubtitleOverlay,
  SubtitleToggle,
  useSubtitlePreference,
  type SubtitleShotInput,
} from "./SubtitleOverlay";

export function NodeDetail({
  projectId,
  selectedNode,
  outline,
  visualBible,
  characters,
  shots,
  projectVideoUrl,
  awaitingConfirm,
  awaitingAgent,
  awaitingOutline,
  needsOutlineApproval,
  latestRunError,
  taskVideoCount,
  onRetryMaterials,
  onConfirm,
  onSubmitRevision,
  isSubmittingRevision,
}: {
  projectId: number;
  selectedNode: WorkflowNode;
  outline: Record<string, unknown> | null;
  visualBible: string | null;
  characters: Character[];
  shots: Shot[];
  projectVideoUrl: string | null;
  awaitingConfirm: boolean;
  awaitingAgent: string | null;
  awaitingOutline: boolean;
  needsOutlineApproval: boolean;
  taskVideoCount: number;
  latestRunError: string | null;
  onRetryMaterials: () => void;
  onConfirm: (feedback?: string) => void;
  onSubmitRevision: (payload: ProjectRevisionPayload) => void;
  isSubmittingRevision: boolean;
}) {
  const [preview, setPreview] = useState<MediaPreview | null>(null);
  const missingCharacterImages = characters.filter((c) => !c.image_url);
  const hasMissingCharacterImages = missingCharacterImages.length > 0;
  const playableVideoCount = shots.filter((s) => isPlayableVideoUrl(s.video_url)).length;
  const missingShotVideos = shots.filter((s) => !isPlayableVideoUrl(s.video_url));
  const showMaterialIssue =
    selectedNode.id === "characters" && hasMissingCharacterImages ||
    selectedNode.id === "shotImages" && (missingShotVideos.length > 0 || taskVideoCount > 0) && latestRunError ||
    selectedNode.id === "output" && missingShotVideos.length > 0 && latestRunError;

  return (
    <div className="h-full p-5">
      <div className="flex items-start justify-between gap-3 border-b border-line-soft pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-[14px] font-medium text-ink-1">{selectedNode.label}</p>
            <WorkflowStatusBadge status={selectedNode.status} />
          </div>
          <p className="mt-1.5 text-[12.5px] leading-6 text-ink-3">{selectedNode.description}</p>
          <p className="mt-2 font-mono text-[10.5px] text-ink-4 tabular-nums">
            {selectedNode.metric}
          </p>
        </div>
        {selectedNode.id === "outline" && (awaitingOutline || needsOutlineApproval) && (
          <button onClick={() => onConfirm()} className="btn btn-primary btn-sm gap-1 shrink-0">
            <CheckCircle2 className="h-4 w-4" />
            确认大纲
          </button>
        )}
        {selectedNode.id === "characters" && awaitingConfirm && awaitingAgent === "characters" && (
          <button onClick={() => onConfirm()} className="btn btn-primary btn-sm gap-1 shrink-0">
            <CheckCircle2 className="h-4 w-4" />
            确认角色
          </button>
        )}
        {selectedNode.id === "shots" && awaitingConfirm && awaitingAgent === "shots" && (
          <button onClick={() => onConfirm()} className="btn btn-primary btn-sm gap-1 shrink-0">
            <CheckCircle2 className="h-4 w-4" />
            确认分镜
          </button>
        )}
        {selectedNode.id === "shotImages" && awaitingConfirm && awaitingAgent === "frames" && (
          <button onClick={() => onConfirm()} className="btn btn-primary btn-sm gap-1 shrink-0">
            <CheckCircle2 className="h-4 w-4" />
            确认画面
          </button>
        )}
      </div>

      {showMaterialIssue && (
        <div className="mt-4 rounded-[6px] bg-error-tint p-3 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-error)_22%,transparent)]">
          <div className="flex items-start gap-2">
            <TriangleAlert className="h-4 w-4 text-error mt-0.5 shrink-0" strokeWidth={1.8} />
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium text-error">生成未完成</p>
              <p className="mt-1 text-[12px] leading-6 text-ink-2">
                {selectedNode.id === "characters" && !latestRunError
                  ? `还有 ${missingCharacterImages.length} 个角色缺少角色图，可以重新生成缺失图片。`
                  : formatRunError(latestRunError)}
              </p>
              {taskVideoCount > 0 && (
                <p className="mt-1 text-[12px] leading-6 text-ink-3">
                  检测到 {taskVideoCount} 条视频仍是任务地址，尚不是可播放视频。
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedNode.id === "characters" ? (
                  <button
                    onClick={() => onSubmitRevision({
                      content: `重新生成缺失的角色图：${missingCharacterImages.map((c) => c.name).join("、")}`,
                      entity_type: "characters",
                      feedback_type: "regenerate_image",
                    })}
                    disabled={isSubmittingRevision}
                    className="btn btn-error btn-xs gap-1"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    重试缺失角色图
                  </button>
                ) : (
                  <button onClick={onRetryMaterials} className="btn btn-error btn-xs mt-3 gap-1">
                    <RefreshCw className="h-3.5 w-3.5" />
                    重试未完成物料
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mt-4">
        {selectedNode.id === "outline" && outline && (
          <OutlineCanvasPreview outline={outline} visualBible={visualBible} />
        )}

        {selectedNode.id === "characters" && (
          <CharacterNodeDetail
            characters={characters}
            latestRunError={latestRunError}
            isSubmittingRevision={isSubmittingRevision}
            onOpen={setPreview}
            onSubmitRevision={onSubmitRevision}
          />
        )}

        {selectedNode.id === "shots" && <ShotNodeDetail shots={shots} />}

        {selectedNode.id === "shots" && <CritiquePanel />}

        {selectedNode.id === "shotImages" && (
          <AssetStrip
            emptyText="镜头视频尚未生成"
            items={shots.map((s) => ({
              id: s.id,
              title: `镜头 ${s.order}`,
              subtitleShots: [{ dialogue: s.dialogue }],
              url: playableOrPreviewUrl(s),
              posterUrl: s.image_url || null,
              kind: isPlayableVideoUrl(s.video_url) ? "video" : "image",
              // 漂移比「等待镜头视频」更值得先看：后者是进度，前者是已经发现的问题。
              issue: s.consistency_result?.verdict === "drift" ? "角色长相漂移" : videoIssue(s),
              actionLabel: "重生成视频",
              onAction: () => onSubmitRevision({
                content: `重新生成镜头 ${s.order} 的视频，保留分镜含义，但优化动作节奏和画面连续性。`,
                entity_type: "shot",
                entity_id: s.id,
                feedback_type: "regenerate_video",
              }),
            }))}
            onOpen={setPreview}
            actionDisabled={isSubmittingRevision}
          />
        )}

        {selectedNode.id === "output" && (
          <OutputNodeDetail
            projectVideoUrl={projectVideoUrl}
            playableVideoCount={playableVideoCount}
            shotCount={shots.length}
            shots={shots}
            onOpen={setPreview}
          />
        )}
      </div>

      {(selectedNode.id === "characters" || selectedNode.id === "shotImages") &&
        characters.length > 0 &&
        shots.some((s) => s.image_url) && <ConsistencyPanel projectId={projectId} />}

      {isEditableWorkflowNode(selectedNode.id) && (
        <RevisionPanel
          selectedNode={selectedNode}
          disabled={isSubmittingRevision}
          onSubmit={onSubmitRevision}
        />
      )}
      <MediaLightbox preview={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

function CharacterNodeDetail({
  characters,
  latestRunError,
  isSubmittingRevision,
  onOpen,
  onSubmitRevision,
}: {
  characters: Character[];
  latestRunError: string | null;
  isSubmittingRevision: boolean;
  onOpen: (preview: MediaPreview) => void;
  onSubmitRevision: (payload: ProjectRevisionPayload) => void;
}) {
  if (characters.length === 0) return <EmptyNodeContent text="角色设定尚未生成" />;

  return (
    <div className="space-y-3">
      {characters.map((character) => (
        <div key={character.id} className="rounded-[6px] bg-base-100 p-3 shadow-[inset_0_0_0_1px_var(--color-line-soft)]">
          <div className="grid grid-cols-[148px_1fr] gap-3">
            <MediaTile
              title={character.name}
              url={character.image_url || null}
              kind="image"
              emptyText={!character.image_url ? "角色图缺失" : "等待角色图"}
              issue={!character.image_url ? "可重新生成" : null}
              onOpen={onOpen}
            />
            <div className="min-w-0">
              <p className="font-serif text-[14px] font-medium text-ink-1">{character.name}</p>
              {!character.image_url && (
                <div className="mt-2 rounded-[5px] bg-error-tint p-2 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-error)_20%,transparent)]">
                  <p className="text-[11.5px] leading-5 text-error">
                    {latestRunError ? formatRunError(latestRunError) : "这个角色还没有生成角色图。"}
                  </p>
                  <button
                    type="button"
                    onClick={() => onSubmitRevision({
                      content: `重新生成角色「${character.name}」的角色图，保持角色设定一致。`,
                      entity_type: "character",
                      entity_id: character.id,
                      feedback_type: "regenerate_image",
                    })}
                    disabled={isSubmittingRevision}
                    className="btn btn-error btn-xs mt-2 gap-1"
                  >
                    <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
                    重生成角色图
                  </button>
                </div>
              )}
              <p className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-ink-3">
                {character.description || "暂无角色介绍"}
              </p>
              {character.visual_notes && (
                <div className="mt-3 rounded-[5px] bg-base-200 p-2">
                  <p className="eyebrow mb-1">视觉设定</p>
                  <p className="whitespace-pre-wrap text-[11.5px] leading-5 text-ink-2">
                    {character.visual_notes}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ShotNodeDetail({ shots }: { shots: Shot[] }) {
  if (shots.length === 0) return <EmptyNodeContent text="分镜脚本尚未生成" />;

  return (
    <div className="space-y-3">
      {shots.map((shot) => (
        <div key={shot.id} className="rounded-[6px] bg-base-100 p-3 shadow-[inset_0_0_0_1px_var(--color-line-soft)]">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-[10.5px] text-ink-4 tabular-nums">
              镜头 {String(shot.order).padStart(2, "0")}
            </p>
            <span className="font-mono text-[10.5px] text-ink-4 tabular-nums">
              {shot.duration ? `${shot.duration}s` : ""}
            </span>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-6 text-ink-2">
            {shot.description || shot.prompt || "暂无镜头描述"}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-[11.5px]">
            {shot.scene && <ShotMeta label="场景" value={shot.scene} />}
            {shot.camera && <ShotMeta label="镜头" value={shot.camera} />}
            {shot.action && <ShotMeta label="动作" value={shot.action} />}
            {shot.expression && <ShotMeta label="表情" value={shot.expression} />}
            {shot.lighting && <ShotMeta label="光线" value={shot.lighting} />}
            {shot.dialogue && <ShotMeta label="台词" value={shot.dialogue} />}
          </dl>
          {shot.image_prompt && (
            <div className="mt-3 rounded-[5px] bg-base-200 p-2">
              <p className="eyebrow mb-1">图像提示词</p>
              <p className="whitespace-pre-wrap text-[11.5px] leading-5 text-ink-2">
                {shot.image_prompt}
              </p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function OutputNodeDetail({
  projectVideoUrl,
  playableVideoCount,
  shotCount,
  shots,
  onOpen,
}: {
  projectVideoUrl: string | null;
  playableVideoCount: number;
  shotCount: number;
  shots: Shot[];
  onOpen: (preview: MediaPreview) => void;
}) {
  return (
    <div className="rounded-[6px] bg-base-100 p-4 shadow-[inset_0_0_0_1px_var(--color-line-soft)]">
      {projectVideoUrl && !isInternalCompositionUrl(projectVideoUrl) ? (
        <div className="space-y-3">
          {isFinalVideoUrl(projectVideoUrl) ? (
            <button
              type="button"
              onClick={() => onOpen({
                title: "合成输出",
                url: projectVideoUrl,
                kind: "video",
                subtitleShots: shots.map((shot) => ({
                  dialogue: shot.dialogue,
                  duration: shot.duration,
                })),
              })}
              className="group w-full rounded-lg border border-line-soft bg-black overflow-hidden relative"
            >
              <video src={projectVideoUrl} className="w-full max-h-[320px] bg-black object-contain" controls />
              <span className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100">
                <Maximize2 className="h-4 w-4" />
              </span>
            </button>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <a href={projectVideoUrl} target="_blank" rel="noreferrer" className="btn btn-outline btn-sm">
              <ExternalLink className="h-4 w-4" />
              {isFinalVideoUrl(projectVideoUrl) ? "打开输出视频" : "查看合成预览"}
            </a>
            {isFinalVideoUrl(projectVideoUrl) && (
              <a href={projectVideoUrl} download={`miraframe-project-video-${Date.now()}.mp4`} className="btn btn-primary btn-sm">
                <Download className="h-4 w-4" />
                导出成片
              </a>
            )}
          </div>
          {!isFinalVideoUrl(projectVideoUrl) && (
            <p className="text-xs text-ink-3">当前是按镜头顺序连续播放的合成预览，还不是单个 mp4 成片。</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-ink-3">等待全部镜头视频完成后输出。</p>
          {isInternalCompositionUrl(projectVideoUrl) && (
            <p className="text-xs text-error">检测到旧版内部合成地址，需要重新执行合成输出。</p>
          )}
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <Info className="h-4 w-4" />
            当前可播放镜头 {playableVideoCount}/{shotCount || 0}
          </div>
        </div>
      )}
    </div>
  );
}

function RevisionPanel({
  selectedNode,
  disabled,
  onSubmit,
}: {
  selectedNode: WorkflowNode;
  disabled: boolean;
  onSubmit: (payload: ProjectRevisionPayload) => void;
}) {
  const [content, setContent] = useState("");
  const target = revisionTargetForNode(selectedNode.id);
  const trimmed = content.trim();

  const handleSubmit = () => {
    if (!trimmed) return;
    onSubmit({
      content: trimmed,
      entity_type: target.entityType,
      feedback_type: target.feedbackType,
    });
    setContent("");
  };

  return (
    <div className="mt-5 rounded-[6px] bg-base-100 p-3 shadow-[inset_0_0_0_1px_var(--color-line-soft)]">
      <div className="flex items-start gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] bg-base-200 text-primary">
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-ink-1">提交{selectedNode.label}修改</p>
          <p className="mt-1 text-[11.5px] leading-5 text-ink-3">{target.helper}</p>
        </div>
      </div>
      <textarea
        className="textarea mt-3 w-full"
        rows={3}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={target.placeholder}
        disabled={disabled}
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          className="btn btn-primary btn-sm gap-1"
          onClick={handleSubmit}
          disabled={disabled || !trimmed}
        >
          {disabled ? <span className="loading loading-spinner loading-xs" /> : <SendHorizontal className="h-4 w-4" />}
          提交修改
        </button>
      </div>
    </div>
  );
}

function EmptyNodeContent({ text }: { text: string }) {
  return (
    <p className="col-span-3 rounded-[6px] border border-dashed border-line py-8 text-center text-[12.5px] text-ink-3">
      {text}
    </p>
  );
}

function ShotMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[5px] bg-base-200 p-2">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap leading-6 text-ink-2">{value}</dd>
    </div>
  );
}

type MediaPreview = {
  title: string;
  url: string;
  kind: "image" | "video";
  posterUrl?: string | null;
  subtitleShots?: SubtitleShotInput[];
};

function MediaTile({
  title,
  url,
  kind,
  posterUrl,
  subtitleShots,
  emptyText,
  issue,
  onOpen,
}: {
  title: string;
  url: string | null;
  kind: "image" | "video";
  posterUrl?: string | null;
  subtitleShots?: SubtitleShotInput[];
  emptyText: string;
  issue?: string | null;
  onOpen: (preview: MediaPreview) => void;
}) {
  if (!url) {
    return (
      <div className={cn("flex aspect-[4/3] w-full items-center justify-center rounded-[5px] border border-dashed bg-base-200 text-[11.5px] text-ink-3", issue && "border-[color-mix(in_srgb,var(--color-error)_30%,transparent)] text-error")}>
        {emptyText}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen({ title, url, kind, posterUrl, subtitleShots })}
      className={cn("group relative aspect-[4/3] w-full overflow-hidden rounded-[5px] border bg-base-200", issue ? "border-[color-mix(in_srgb,var(--color-error)_40%,transparent)]" : "border-line-soft")}
      title={`查看${title}`}
    >
      {kind === "video" ? (
        <>
          {posterUrl ? (
            <img src={posterUrl} alt={title} className="h-full w-full object-contain" />
          ) : (
            <video src={url} className="h-full w-full object-contain" muted preload="metadata" />
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-black/10">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/65 text-white">
              <Play className="h-5 w-5 fill-current" />
            </span>
          </span>
        </>
      ) : (
        <img src={url} alt={title} className="h-full w-full object-contain" />
      )}
      <span className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100">
        <Maximize2 className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

function AssetStrip({
  items,
  emptyText,
  onOpen,
  actionDisabled = false,
}: {
  items: Array<{
    id: number;
    title: string;
    url: string | null;
    kind: "image" | "video";
    posterUrl?: string | null;
    subtitleShots?: SubtitleShotInput[];
    issue?: string | null;
    actionLabel?: string;
    onAction?: () => void;
  }>;
  emptyText: string;
  onOpen: (preview: MediaPreview) => void;
  actionDisabled?: boolean;
}) {
  const visible = items.filter((item) => item.url || item.issue);
  if (visible.length === 0) return <EmptyNodeContent text={emptyText} />;

  return (
    <div className="grid grid-cols-2 gap-3">
      {visible.map((item) => (
        <div key={item.id} className={cn("overflow-hidden rounded-[6px] bg-base-100 p-2 shadow-[inset_0_0_0_1px_var(--color-line-soft)]", item.issue && "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-error)_28%,transparent)]")}>
          <MediaTile
            title={item.title}
            url={item.url}
            kind={item.kind}
            posterUrl={item.posterUrl}
            subtitleShots={item.subtitleShots}
            emptyText="等待生成"
            issue={item.issue}
            onOpen={onOpen}
          />
          <div className="px-1.5 pb-1 pt-2">
            <p className="truncate text-[12px] font-medium text-ink-1">{item.title}</p>
            {item.issue && <p className="mt-1 text-[11px] text-error">{item.issue}</p>}
            {item.onAction && item.actionLabel && (
              <button
                type="button"
                onClick={item.onAction}
                disabled={actionDisabled}
                className="btn btn-outline btn-xs mt-2 w-full gap-1"
              >
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
                {item.actionLabel}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function MediaLightbox({ preview, onClose }: { preview: MediaPreview | null; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [subtitlesOn, setSubtitlesOn] = useSubtitlePreference();

  useEffect(() => {
    if (!preview) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, preview]);

  useEffect(() => {
    setDuration(0);
  }, [preview?.url]);

  const subtitleShots = preview?.subtitleShots;
  const cues = useMemo(() => {
    if (!subtitlesOn || !subtitleShots || subtitleShots.length === 0) return [];
    if (subtitleShots.length === 1) {
      return planClipSubtitles(subtitleShots[0].dialogue, duration);
    }
    // 成片：拿到真实时长后按各镜头 duration 比例重新分配时间轴
    return planProjectSubtitles(subtitleShots, duration);
  }, [subtitlesOn, subtitleShots, duration]);

  if (!preview) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 p-5 flex flex-col">
      <div className="flex items-center justify-between gap-3 text-white">
        <p className="text-sm font-medium truncate">{preview.title}</p>
        <div className="flex items-center gap-2">
          {preview.kind === "video" && subtitleShots && subtitleShots.length > 0 && (
            <SubtitleToggle
              enabled={subtitlesOn}
              onToggle={setSubtitlesOn}
              className="bg-white/10 text-white hover:bg-white/20"
            />
          )}
          <a href={preview.url} target="_blank" rel="noreferrer" className="btn btn-sm bg-white/10 text-white border-white/20 hover:bg-white/20">
            <ExternalLink className="h-4 w-4" />
            打开
          </a>
          {preview.kind === "video" && (
            <a href={preview.url} download className="btn btn-sm bg-white text-black hover:bg-white/90">
              <Download className="h-4 w-4" />
              导出
            </a>
          )}
          <button type="button" onClick={onClose} className="btn btn-circle bg-white/10 text-white border-white/20 hover:bg-white/20" aria-label="关闭预览">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 mt-4 flex items-center justify-center">
        {preview.kind === "video" ? (
          <div className="relative inline-flex max-h-full max-w-full items-center justify-center">
            <video
              ref={videoRef}
              src={preview.url}
              poster={preview.posterUrl || undefined}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
              className="max-h-full max-w-full rounded-lg bg-black"
              controls
              autoPlay
            />
            <SubtitleOverlay videoRef={videoRef} cues={cues} enabled={subtitlesOn} />
          </div>
        ) : (
          <img src={preview.url} alt={preview.title} className="max-h-full max-w-full rounded-lg object-contain" />
        )}
      </div>
    </div>
  );
}

function OutlineCanvasPreview({
  outline,
  visualBible,
}: {
  outline: Record<string, unknown>;
  visualBible: string | null;
}) {
  const title = textOf(outline.title);
  const logline = getOutlineLogline(outline);
  const acts = getOutlineActs(outline);

  return (
    <div className="rounded-[6px] bg-base-100 p-4 shadow-[inset_0_0_0_1px_var(--color-line-soft)]">
      {title && <p className="font-serif text-[16px] font-medium text-ink-1">{title}</p>}
      {logline && (
        <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-6 text-ink-3">{logline}</p>
      )}
      {acts.length > 0 && (
        <div className="mt-4 space-y-2">
          {acts.map((act, index) => (
            <div key={`${act}-${index}`} className="rounded-[5px] bg-base-200 p-3">
              <p className="eyebrow">剧情段落 {String(index + 1).padStart(2, "0")}</p>
              <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-6 text-ink-2">{act}</p>
            </div>
          ))}
        </div>
      )}
      {visualBible && (
        <div className="mt-4 rounded-[5px] p-3 shadow-[inset_0_0_0_1px_var(--color-line-soft)]">
          <p className="eyebrow">视觉风格</p>
          <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-6 text-ink-2">{visualBible}</p>
        </div>
      )}
    </div>
  );
}
