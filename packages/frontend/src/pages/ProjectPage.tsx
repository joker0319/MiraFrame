"use client";

import { forwardRef, useEffect, useRef, useCallback } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Download,
  FileText,
  Film,
  Image,
  Play,
  RefreshCw,
  Users,
} from "lucide-react";
import { TopBar } from "@/components/layout/TopBar";
import { StagePipeline } from "@/components/layout/StagePipeline";
import { ChatDrawer } from "@/components/chat/ChatDrawer";
import { NodeDetail } from "@/components/project/NodeDetail";
import { WorkflowStatusBadge } from "@/components/project/WorkflowStatusBadge";
import { useProjectStore } from "@/stores/projectStore";
import { useCharacterStore } from "@/stores/characterStore";
import { useShotStore } from "@/stores/shotStore";
import { useRunStore } from "@/stores/runStore";
import { useMessageStore } from "@/stores/messageStore";
import { useCritiqueStore } from "@/stores/critiqueStore";
import { useChatPanelStore } from "@/stores/chatPanelStore";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useProjectWorkspaceData } from "@/hooks/useProjectWorkspaceData";
import { useWorkflowNodeSelection } from "@/hooks/useWorkflowNodeSelection";
import { projectsApi } from "@/services/projectsApi";
import { cn } from "@/lib/utils";
import { BRAND } from "@/lib/brand";
import type { ProjectRevisionPayload } from "@/types";
import {
  buildMaterialStages,
  consistencyAlert,
  getOutlineActs,
  getOutlineLogline,
  isFinalVideoUrl,
  isInternalCompositionUrl,
  isPlayableVideoUrl,
  isTaskVideoUrl,
  nodeIdForStage,
  stageForRevision,
  type WorkflowNode,
} from "@/utils/projectWorkflow";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectId = id ? parseInt(id) : null;

  // ── State from Zustand stores ──
  // IMPORTANT: each field needs its own selector, or use useShallow.
  // Returning a new object { a, b } from a selector causes infinite loops.
  const clearProject = useProjectStore((s) => s.clearProject);
  const clearCharacters = useCharacterStore((s) => s.clearCharacters);
  const clearShots = useShotStore((s) => s.clearShots);
  const clearMessages = useMessageStore((s) => s.clearMessages);

  // Subscriptions for rendering (single-value selectors are safe)
  const projectTitle = useProjectStore((s) => s.projectTitle);
  const isGenerating = useRunStore((s) => s.isGenerating);
  const currentStage = useRunStore((s) => s.currentStage);
  const currentRunId = useRunStore((s) => s.currentRunId);
  const awaitingConfirm = useRunStore((s) => s.awaitingConfirm);
  const awaitingAgent = useRunStore((s) => s.awaitingAgent);
  const recoveryControl = useRunStore((s) => s.recoveryControl);
  const runError = useRunStore((s) => s.error);
  const projectVideoUrl = useProjectStore((s) => s.projectVideoUrl);
  const storyOutline = useProjectStore((s) => s.projectStoryOutline);
  const outlineApproved = useProjectStore((s) => s.projectOutlineApproved);
  const characters = useCharacterStore((s) => s.characters);
  const shots = useShotStore((s) => s.shots);
  const setGenerating = useRunStore((s) => s.setGenerating);
  const setCurrentStage = useRunStore((s) => s.setCurrentStage);
  const setCurrentRunId = useRunStore((s) => s.setCurrentRunId);
  const setAwaitingConfirm = useRunStore((s) => s.setAwaitingConfirm);
  const resetRunState = useRunStore((s) => s.resetRunState);
  const resetCritique = useCritiqueStore((s) => s.reset);
  const setProjectOutlineApproved = useProjectStore((s) => s.setProjectOutlineApproved);

  // Local UI
  const autoStartTriggered = useRef(false);
  const generateRequestToken = useRef(0);
  const openChatPanel = useChatPanelStore((s) => s.open);

  // WebSocket — always connected
  useWebSocket(projectId);

  const { projectQuery, latestRunQuery } = useProjectWorkspaceData(projectId, isGenerating);

  // ---- Mutations ----
  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("No project");
      const token = ++generateRequestToken.current;
      const result = await projectsApi.generate(projectId);
      if (token !== generateRequestToken.current) throw new Error("STALE_REQUEST");
      return result;
    },
    onSuccess: (data: { run_id?: number; id?: number }) => {
      setGenerating(true);
      setCurrentRunId(data.run_id ?? data.id ?? null);
      setCurrentStage("outline");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => projectsApi.cancel(projectId!, currentRunId),
    onSuccess: () => resetRunState(),
  });

  const feedbackMutation = useMutation({
    mutationFn: (content: string) => projectsApi.feedback(projectId!, content),
  });

  const revisionMutation = useMutation({
    mutationFn: (payload: ProjectRevisionPayload) => projectsApi.submitRevision(projectId!, payload),
    onSuccess: (data, payload) => {
      if (data.run_id) setCurrentRunId(data.run_id);
      setGenerating(true);
      setCurrentStage(stageForRevision(payload.entity_type));
      openChatPanel();
      queryClient.invalidateQueries({ queryKey: ["project", projectId, "messages"] });
    },
  });

  const approveOutlineMutation = useMutation({
    mutationFn: (feedback?: string) => projectsApi.approveOutline(projectId!, feedback),
    onSuccess: (data) => {
      setProjectOutlineApproved(true);
      setAwaitingConfirm(false);
      if (data.run_id) {
        setCurrentRunId(data.run_id);
        setGenerating(true);
        setCurrentStage("characters");
      }
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: ({ runId, feedback }: { runId: number; feedback?: string }) =>
      projectsApi.resume(projectId!, runId, feedback),
    onSuccess: () => {
      setAwaitingConfirm(false);
      setGenerating(true);
    },
  });

  // ---- Handlers ----
  const handleGenerate = useCallback(() => {
    clearMessages();
    setCurrentStage("outline");
    generateMutation.mutate();
  }, [clearMessages, setCurrentStage, generateMutation]);

  const handleCancel = useCallback(() => cancelMutation.mutate(), [cancelMutation]);

  const handleSendFeedback = useCallback((content: string) => feedbackMutation.mutate(content), [feedbackMutation]);

  const handleSubmitRevision = useCallback((payload: ProjectRevisionPayload) => {
    revisionMutation.mutate(payload);
  }, [revisionMutation]);

  const handleConfirm = useCallback((feedback?: string) => {
    const isOutlineGate = awaitingAgent === "outline" || !!projectQuery.data?.story_outline && !projectQuery.data?.outline_approved;
    if (projectId && isOutlineGate) {
      approveOutlineMutation.mutate(feedback);
      return;
    }
    if (currentRunId) resumeMutation.mutate({ runId: currentRunId, feedback });
  }, [approveOutlineMutation, awaitingAgent, currentRunId, projectId, projectQuery.data?.outline_approved, projectQuery.data?.story_outline, resumeMutation]);

  const handleContinuePlanning = useCallback(async () => {
    if (!projectId) return;
    const result = await projectsApi.generate(projectId, { target_stage: "plan_characters" });
    const queuedRun = result as typeof result & { run_id?: number };
    setGenerating(true);
    setCurrentRunId(queuedRun.run_id ?? result.id ?? null);
    setCurrentStage("outline");
    openChatPanel();
  }, [openChatPanel, projectId, setCurrentRunId, setCurrentStage, setGenerating]);

  const handleRetryMaterials = useCallback(async () => {
    if (!projectId) return;
    const result = await projectsApi.generate(projectId, { target_stage: "render_shot_images" });
    const queuedRun = result as typeof result & { run_id?: number };
    setGenerating(true);
    setCurrentRunId(queuedRun.run_id ?? result.id ?? null);
    setCurrentStage("shot_images");
    openChatPanel();
  }, [openChatPanel, projectId, setCurrentRunId, setCurrentStage, setGenerating]);

  // ---- Auto-start ----
  useEffect(() => {
    if (searchParams.get("autoStart") === "true" && projectQuery.data && !autoStartTriggered.current && !isGenerating) {
      autoStartTriggered.current = true;
      clearMessages();
      setCurrentStage("outline");
      generateMutation.mutate();
      openChatPanel();
      searchParams.delete("autoStart");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, projectQuery.data, isGenerating, clearMessages, setCurrentStage, generateMutation, openChatPanel, setSearchParams]);

  // ---- Invalidate React Query when generation completes ----
  const prevGeneratingRef = useRef(isGenerating);
  useEffect(() => {
    if (prevGeneratingRef.current && !isGenerating && projectId) {
      queryClient.invalidateQueries({ queryKey: ["project", projectId, "characters"] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId, "shots"] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId, "latest-run"] });
    }
    prevGeneratingRef.current = isGenerating;
  }, [isGenerating, projectId, queryClient]);

  // ---- Cleanup ----
  useEffect(() => () => { clearProject(); clearCharacters(); clearShots(); clearMessages(); resetCritique(); }, [resetCritique]);

  // ---- Render states ----
  if (!projectId) return <div className="min-h-screen flex items-center justify-center bg-paper text-ink-2">无效的项目 ID</div>;
  if (projectQuery.isLoading) return <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-paper"><span className="loading loading-spinner loading-lg" /><p className="text-[12.5px] text-ink-3">正在读取项目</p></div>;
  if (projectQuery.isError || !projectQuery.data) return <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-paper"><p className="font-serif text-[17px] text-ink-1">项目未找到</p><button onClick={() => navigate("/")} className="btn btn-primary">返回首页</button></div>;

  const hasRecovery = recoveryControl?.state === "recoverable";
  const latestRunError = runError || latestRunQuery.data?.error || null;
  const topStages = buildMaterialStages({
    currentStage,
    isGenerating,
    awaitingConfirm,
    awaitingAgent,
    outline: storyOutline as unknown as Record<string, unknown> | null,
    outlineApproved,
    characters,
    shots,
    projectVideoUrl,
    latestRunError,
  });

  return (
    <div className="h-screen flex flex-col bg-paper">
      <TopBar />
      <StagePipeline currentStage={currentStage} isGenerating={isGenerating} awaitingConfirm={awaitingConfirm} hasRecovery={hasRecovery} onResume={() => {}} onCancel={handleCancel} stages={topStages} />
      <div className="flex flex-1 overflow-hidden">
        {/* Canvas — reads from store (real-time WS updates) */}
        <CanvasArea
          projectId={parseInt(id ?? "", 10)}
          projectTitle={projectTitle}
          currentStage={currentStage}
          isGenerating={isGenerating}
          awaitingConfirm={awaitingConfirm}
          awaitingAgent={awaitingAgent}
          onConfirm={handleConfirm}
          onGenerate={handleGenerate}
          onContinuePlanning={handleContinuePlanning}
          onRetryMaterials={handleRetryMaterials}
          latestRunError={latestRunError}
          onSubmitRevision={handleSubmitRevision}
          isSubmittingRevision={revisionMutation.isPending}
        />
        {/* Chat — auto-opens when generating */}
        <ChatDrawer onSendFeedback={handleSendFeedback} onConfirm={handleConfirm} onGenerate={handleGenerate} onCancel={handleCancel} isGenerating={isGenerating} />
      </div>
    </div>
  );
}

/** Canvas area — reads from Zustand stores for real-time WS updates */
function CanvasArea({
  projectId,
  projectTitle,
  currentStage,
  isGenerating,
  awaitingConfirm,
  awaitingAgent,
  onConfirm,
  onGenerate,
  onContinuePlanning,
  onRetryMaterials,
  latestRunError,
  onSubmitRevision,
  isSubmittingRevision,
}: {
  projectId: number;
  projectTitle: string | null;
  currentStage: string;
  isGenerating: boolean;
  awaitingConfirm: boolean;
  awaitingAgent: string | null;
  onConfirm: (feedback?: string) => void;
  onGenerate: () => void;
  onContinuePlanning: () => void;
  onRetryMaterials: () => void;
  latestRunError: string | null;
  onSubmitRevision: (payload: ProjectRevisionPayload) => void;
  isSubmittingRevision: boolean;
}) {
  const characters = useCharacterStore((s) => s.characters);
  const shots = useShotStore((s) => s.shots);
  const storyOutline = useProjectStore((s) => s.projectStoryOutline);
  const visualBible = useProjectStore((s) => s.projectVisualBible);
  const projectVideoUrl = useProjectStore((s) => s.projectVideoUrl);
  const outlineApproved = useProjectStore((s) => s.projectOutlineApproved);
  const outlineRecord = storyOutline as unknown as Record<string, unknown> | null;
  const hasOutline = !!outlineRecord && Object.keys(outlineRecord).length > 0;
  const sortedShots = [...shots].sort((a, b) => a.order - b.order);
  const consistency = consistencyAlert(sortedShots);
  const hasCharacterImages = characters.length > 0 && characters.every((c) => !!c.image_url);
  const characterImageCount = characters.filter((c) => !!c.image_url).length;
  const hasPartialCharacters = characters.length > 0 && characterImageCount < characters.length;
  const hasShotImages = shots.length > 0 && shots.every((s) => !!s.image_url);
  const shotImageCount = shots.filter((s) => !!s.image_url).length;
  const playableVideoCount = shots.filter((s) => isPlayableVideoUrl(s.video_url)).length;
  const taskVideoCount = shots.filter((s) => isTaskVideoUrl(s.video_url)).length;
  const hasShotVideos = shots.length > 0 && playableVideoCount === shots.length;
  const hasMaterialFailure = !!latestRunError && latestRunError.length > 0;
  const awaitingOutline = awaitingConfirm && (awaitingAgent === "outline");
  const awaitingCharacters = awaitingConfirm && awaitingAgent === "characters";
  const awaitingShots = awaitingConfirm && awaitingAgent === "shots";
  const awaitingFrames = awaitingConfirm && awaitingAgent === "frames";
  const needsOutlineApproval = hasOutline && !outlineApproved;
  const canContinuePlanning = hasOutline && outlineApproved && characters.length === 0 && !isGenerating;
  const activeNodeId = nodeIdForStage(currentStage);

  const nodes: WorkflowNode[] = [
    {
      id: "outline",
      label: "故事大纲",
      description: hasOutline ? getOutlineLogline(outlineRecord) || "已生成剧情结构" : "从剧本提炼叙事骨架",
      icon: FileText,
      status: hasOutline ? (awaitingOutline || needsOutlineApproval ? "review" : "done") : currentStage === "outline" && isGenerating ? "active" : "pending",
      metric: hasOutline ? `${getOutlineActs(outlineRecord).length || 1} 段` : "待生成",
    },
    {
      id: "characters",
      label: "角色设定",
      description: characters.length > 0
        ? characters.slice(0, 3).map((c) => c.name).join("、") + (hasCharacterImages ? "（含角色图）" : `（角色图 ${characterImageCount}/${characters.length}）`)
        : "抽取人物并生成角色形象",
      icon: Users,
      status: awaitingCharacters
        ? "review"
        : hasCharacterImages
          ? "done"
          : hasPartialCharacters && !isGenerating
            ? "error"
            : characters.length > 0 || currentStage === "characters" || currentStage === "characters_approval"
              ? hasMaterialFailure && !isGenerating ? "error" : "active"
              : hasOutline && outlineApproved && isGenerating ? "active" : "pending",
      metric: characters.length ? `${characterImageCount}/${characters.length} 图` : "待生成",
      alert: consistency,
    },
    {
      id: "shots",
      label: "分镜脚本",
      description: shots.length > 0 ? `${shots.length} 个镜头，动作、对白与提示词` : "拆解可生成镜头",
      icon: Film,
      status: shots.length > 0 ? (awaitingShots ? "review" : "done") : characters.length > 0 && isGenerating && (currentStage === "shots" || currentStage === "shots_approval") ? "active" : "pending",
      metric: `${shots.length} 镜`,
    },
    {
      id: "shotImages",
      label: "镜头画面",
      description: hasShotVideos ? "镜头视频片段已生成" : hasShotImages ? "分镜帧已生成，继续生成视频" : "由分镜生成镜头视频",
      icon: Image,
      status: awaitingFrames
        ? "review"
        : hasShotVideos
          ? "done"
          : shots.length > 0 && (hasMaterialFailure || taskVideoCount > 0) && !isGenerating
            ? "error"
            : currentStage === "shot_images" && isGenerating || playableVideoCount > 0 || shotImageCount > 0
              ? "active"
              : "pending",
      metric: `${playableVideoCount}/${shots.length || 0} 视频`,
      alert: consistency,
    },
    {
      id: "output",
      label: "合成输出",
      description: isFinalVideoUrl(projectVideoUrl) ? "最终视频已输出" : projectVideoUrl ? "镜头连续播放预览已生成" : hasShotVideos ? "视频片段准备输出" : "合成最终漫剧视频",
      icon: Download,
      status: projectVideoUrl && !isInternalCompositionUrl(projectVideoUrl) ? "done" : currentStage === "output" && isGenerating ? "active" : awaitingFrames ? "pending" : hasShotVideos ? "active" : "pending",
      metric: isFinalVideoUrl(projectVideoUrl) ? "成片" : projectVideoUrl ? "预览" : `${playableVideoCount} 段`,
    },
  ];

  const { selectedNode, setSelectedNodeId, nodeRefs } = useWorkflowNodeSelection({
    nodes,
    activeNodeId,
    isGenerating,
    awaitingConfirm,
  });

  if (!selectedNode) return null;

  return (
    <div className="flex-1 overflow-hidden bg-paper">
      <div className="h-full flex flex-col">
        <div className="min-h-14 shrink-0 border-b border-line bg-paper px-4 py-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium truncate text-ink-1">{projectTitle || BRAND.fullName}</p>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-4">{BRAND.cnName} · 工作台</p>
          </div>
          <div className="flex items-center gap-2">
            {(awaitingConfirm || needsOutlineApproval) && (
              <button onClick={() => onConfirm()} className="btn btn-primary btn-sm gap-1">
                <CheckCircle2 className="h-4 w-4" />
                确认进入下一步
              </button>
            )}
            {!isGenerating && !hasOutline && (
              <button onClick={onGenerate} className="btn btn-primary btn-sm gap-1">
                <Play className="h-4 w-4" />
                开始生成
              </button>
            )}
            {canContinuePlanning && (
              <button onClick={onContinuePlanning} className="btn btn-primary btn-sm gap-1">
                <Play className="h-4 w-4" />
                生成角色和分镜
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 grid-rows-[minmax(320px,0.9fr)_minmax(360px,1.1fr)] xl:grid-cols-[minmax(560px,1fr)_500px] xl:grid-rows-1 overflow-hidden">
          <div className="relative overflow-auto">
            <div className="p-5">
              <div className="mb-3 flex items-baseline justify-between">
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-4">
                  制作流程 · 5 阶段
                </p>
                <p className="font-mono text-[10px] text-ink-4 tabular-nums">
                  {nodes.filter((n) => n.status === "done").length} / {nodes.length} 完成
                </p>
              </div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {nodes.map((node, index) => (
                  <WorkflowNodeCard
                    ref={(element) => { nodeRefs.current[node.id] = element; }}
                    key={node.id}
                    node={node}
                    index={index}
                    selected={node.id === selectedNode.id}
                    onSelect={() => setSelectedNodeId(node.id)}
                  />
                ))}
              </div>
            </div>
          </div>

          <aside className="border-t xl:border-t-0 xl:border-l border-line bg-surface overflow-y-auto">
            <NodeDetail
              projectId={projectId}
              selectedNode={selectedNode}
              outline={outlineRecord}
              visualBible={visualBible}
              characters={characters}
              shots={sortedShots}
              projectVideoUrl={projectVideoUrl}
              awaitingConfirm={awaitingConfirm}
              awaitingAgent={awaitingAgent}
              awaitingOutline={awaitingOutline}
              needsOutlineApproval={needsOutlineApproval}
              latestRunError={latestRunError}
              taskVideoCount={taskVideoCount}
              onRetryMaterials={onRetryMaterials}
              onConfirm={onConfirm}
              onSubmitRevision={onSubmitRevision}
              isSubmittingRevision={isSubmittingRevision}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

const WorkflowNodeCard = forwardRef<HTMLButtonElement, {
  node: WorkflowNode;
  index: number;
  selected: boolean;
  onSelect: () => void;
}>(function WorkflowNodeCard({
  node,
  index,
  selected,
  onSelect,
}, ref) {
  const Icon = node.icon;

  const iconTone =
    node.status === "done"
      ? "bg-success-tint text-success"
      : node.status === "active"
        ? "bg-warning-tint text-warning"
        : node.status === "review"
          ? "bg-primary/10 text-primary"
          : node.status === "error"
            ? "bg-error-tint text-error"
            : "bg-base-200 text-ink-3";

  return (
    <button
      ref={ref}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group relative min-h-[142px] text-left rounded-md bg-surface p-3.5 transition-[box-shadow] duration-150",
        selected
          ? "shadow-[inset_0_0_0_1.5px_var(--color-primary),0_10px_24px_-20px_rgba(25,25,23,.55)]"
          : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-ink-4)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={cn("flex h-8 w-8 items-center justify-center rounded", iconTone)}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="font-mono text-[10px] text-ink-4 tabular-nums">
          {String(index + 1).padStart(2, "0")}
        </span>
      </div>
      <div className="mt-3">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-medium text-ink-1">{node.label}</p>
          {node.alert && node.alert.drift > 0 && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-error"
              title={`${node.alert.drift} 个镜头长相漂移，${node.alert.review} 个待确认`}
              aria-label={`${node.alert.drift} 个镜头角色一致性告警`}
            />
          )}
          <WorkflowStatusBadge status={node.status} />
        </div>
        <p className="mt-1 text-[11.5px] leading-6 text-ink-3 line-clamp-2">{node.description}</p>
      </div>
      <p className="mt-2.5 font-mono text-[11px] text-ink-2 tabular-nums">{node.metric}</p>
    </button>
  );
});

