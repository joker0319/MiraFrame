"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/services/projectsApi";
import { agentForGate } from "@/utils/workflowStage";
import { useCharacterStore } from "@/stores/characterStore";
import { useMessageStore } from "@/stores/messageStore";
import { useProjectStore } from "@/stores/projectStore";
import { useRunStore } from "@/stores/runStore";
import { useShotStore } from "@/stores/shotStore";

export function useProjectWorkspaceData(projectId: number | null, isGenerating: boolean) {
  const setProject = useProjectStore((s) => s.setProject);
  const setCharacters = useCharacterStore((s) => s.setCharacters);
  const setShots = useShotStore((s) => s.setShots);
  const setMessages = useMessageStore((s) => s.setMessages);
  const setGenerating = useRunStore((s) => s.setGenerating);
  const setAwaitingConfirm = useRunStore((s) => s.setAwaitingConfirm);

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!),
    enabled: !!projectId,
  });

  const charactersQuery = useQuery({
    queryKey: ["project", projectId, "characters"],
    queryFn: () => projectsApi.getCharacters(projectId!),
    enabled: !!projectId,
  });

  const shotsQuery = useQuery({
    queryKey: ["project", projectId, "shots"],
    queryFn: () => projectsApi.getShots(projectId!),
    enabled: !!projectId,
  });

  const messagesQuery = useQuery({
    queryKey: ["project", projectId, "messages"],
    queryFn: () => projectsApi.getMessages(projectId!),
    enabled: !!projectId,
  });

  const latestRunQuery = useQuery({
    queryKey: ["project", projectId, "latest-run"],
    queryFn: () => projectsApi.getLatestRun(projectId!),
    enabled: !!projectId,
    refetchInterval: isGenerating ? 5000 : false,
  });

  useEffect(() => {
    if (projectQuery.data) setProject(projectQuery.data);
  }, [projectQuery.data, setProject]);

  useEffect(() => {
    if (charactersQuery.data) setCharacters(charactersQuery.data);
  }, [charactersQuery.data, setCharacters]);

  useEffect(() => {
    if (shotsQuery.data) setShots(shotsQuery.data);
  }, [shotsQuery.data, setShots]);

  useEffect(() => {
    if (!messagesQuery.data?.length) return;

    const latestRunStatus = latestRunQuery.data?.status;
    const hasActiveRun = latestRunStatus === "running" || latestRunStatus === "queued";
    setMessages(messagesQuery.data.map((msg) => ({
      id: `db_${msg.id}`,
      agent: msg.agent,
      role: msg.role,
      content: msg.content,
      summary: msg.summary || undefined,
      progress: msg.progress || undefined,
      isLoading: hasActiveRun ? msg.is_loading || false : false,
      timestamp: msg.created_at,
    })));
  }, [latestRunQuery.data?.status, messagesQuery.data, setMessages]);

  useEffect(() => {
    const run = latestRunQuery.data;
    if (!run) return;
    const status = run.status;

    // Terminal states — clear any lingering run state
    if (status !== "running" && status !== "queued") {
      setGenerating(false);
      setAwaitingConfirm(false);
      return;
    }

    // Active run — restore run state from DB so a page refresh keeps the
    // confirm button visible while the worker waits at an approval gate.
    setGenerating(true);
    if (run.awaiting_gate) {
      setAwaitingConfirm(true, agentForGate(run.awaiting_gate), run.id);
    }
  }, [latestRunQuery.data, setAwaitingConfirm, setGenerating]);

  return {
    projectQuery,
    charactersQuery,
    shotsQuery,
    messagesQuery,
    latestRunQuery,
  };
}
