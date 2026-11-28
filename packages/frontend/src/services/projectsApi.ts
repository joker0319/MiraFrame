/**
 * Projects API — CRUD、生成、大纲、消息、反馈。
 *
 * 这里的返回类型全部来自 @miraframe/shared；服务端也按同一份契约序列化，
 * 所以不再需要 normalizeProject / normalizeCharacter 这类兼容层。
 */
import { fetchApi } from "./client";
import type {
  AgentRun,
  ApproveOutlineResponse,
  CancelRunResponse,
  Character,
  CreateProjectPayload,
  FeedbackResponse,
  GenerateRunResponse,
  Message,
  Project,
  ProjectRevisionPayload,
  ResumeRunResponse,
  RevisionResponse,
  Shot,
  StoryOutline,
  StoryOutlineUpdatePayload,
  UpdateProjectPayload,
  UploadReferenceResponse,
} from "@/types";

export const projectsApi = {
  list: () => fetchApi<Project[]>("/api/v1/projects"),

  get: (id: number) => fetchApi<Project>(`/api/v1/projects/${id}`),

  create: (data: CreateProjectPayload) =>
    fetchApi<Project>("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  update: (id: number, data: UpdateProjectPayload) =>
    fetchApi<Project>(`/api/v1/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  delete: (id: number) => fetchApi<void>(`/api/v1/projects/${id}`, { method: "DELETE" }),

  deleteMany: (ids: number[]) =>
    fetchApi<void>("/api/v1/projects/batch-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  uploadReference: async (projectId: number, file: File): Promise<UploadReferenceResponse> => {
    const formData = new FormData();
    formData.append("file", file);
    const base = (() => {
      if (typeof window === "undefined") return "http://localhost:3000";
      try {
        const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
        if (env?.DEV) {
          return `${window.location.protocol}//${window.location.hostname}:3000`;
        }
      } catch {
        /* SSR / non-Vite */
      }
      return window.location.origin;
    })();
    const res = await fetch(`${base}/api/v1/projects/${projectId}/upload-reference`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json() as Promise<UploadReferenceResponse>;
  },

  getCharacters: (id: number) => fetchApi<Character[]>(`/api/v1/projects/${id}/characters`),

  getShots: (id: number) => fetchApi<Shot[]>(`/api/v1/projects/${id}/shots`),

  getOutline: (id: number) => fetchApi<StoryOutline | null>(`/api/v1/projects/${id}/outline`),

  updateOutline: (id: number, data: StoryOutlineUpdatePayload) =>
    fetchApi<StoryOutline>(`/api/v1/projects/${id}/outline`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  getMessages: (id: number) => fetchApi<Message[]>(`/api/v1/projects/${id}/messages`),

  getLatestRun: (id: number) => fetchApi<AgentRun | null>(`/api/v1/projects/${id}/runs/latest`),

  generate: (id: number, data?: { auto_mode?: boolean; target_stage?: string }) =>
    fetchApi<GenerateRunResponse>(`/api/v1/projects/${id}/generate`, {
      method: "POST",
      body: JSON.stringify(data || {}),
    }),

  cancel: (id: number, runId?: number | null) =>
    fetchApi<CancelRunResponse>(
      runId
        ? `/api/v1/projects/${id}/generate/${runId}/cancel`
        : `/api/v1/projects/${id}/generate/cancel`,
      { method: "POST" },
    ),

  resume: (id: number, runId: number, feedback?: string) =>
    fetchApi<ResumeRunResponse>(`/api/v1/projects/${id}/generate/${runId}/resume`, {
      method: "POST",
      body: JSON.stringify({ confirm: true, feedback }),
    }),

  approveOutline: (id: number, feedback?: string) =>
    fetchApi<ApproveOutlineResponse>(`/api/v1/projects/${id}/approve-outline`, {
      method: "POST",
      body: JSON.stringify({ feedback }),
    }),

  feedback: (id: number, content: string, runId?: number, feedbackType?: string) =>
    fetchApi<FeedbackResponse>(`/api/v1/projects/${id}/feedback`, {
      method: "POST",
      body: JSON.stringify({ content, run_id: runId, feedback_type: feedbackType }),
    }),

  submitRevision: (id: number, data: ProjectRevisionPayload) =>
    fetchApi<RevisionResponse>(`/api/v1/projects/${id}/revisions`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
};
