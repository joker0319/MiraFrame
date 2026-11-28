/**
 * REST 命令类接口的响应契约。
 *
 * 这些响应不是数据库实体，而是「动作回执」：建 run、确认、取消、提交修改。
 * 以前前端各自写内联类型，字段名和后端靠口头约定；现在集中在 shared。
 */

export interface GenerateRunResponse {
  run_id: number;
  status: string;
}

export interface ResumeRunResponse {
  status: string;
}

export interface CancelRunResponse {
  status: string;
  cancelled?: number;
  run_id?: number;
}

export interface ApproveOutlineResponse {
  status: string;
  action?: "started" | "regenerate";
  run_id?: number;
  resumed?: boolean;
  feedback?: string;
}

export interface RevisionResponse {
  status: string;
  run_id?: number;
  reason?: string;
}

export interface FeedbackResponse {
  status: string;
}

export interface UploadReferenceResponse {
  url: string;
  reference_images: string[];
}

export interface RegenerateCharacterResponse {
  status: string;
  character_id: number;
  project_id: number;
  run_id: number;
}

export interface RegenerateShotResponse {
  status: string;
  shot_id: number;
  project_id: number;
  type: "image" | "video";
  run_id: number;
}

export interface ComputeEmbeddingResponse {
  status: string;
  character_id: number;
}

/** 聊天/反馈入口的请求体。 */
export interface FeedbackPayload {
  content: string;
  run_id?: number;
  feedback_type?: string;
  entity_type?: string;
  entity_id?: number;
}

export interface GenerateRequest {
  auto_mode?: boolean;
  target_stage?: string;
}

export interface ResumeRequest {
  confirm?: boolean;
  feedback?: string;
}

export interface ApproveOutlineRequest {
  feedback?: string;
}

export interface BibleUpdatePayload {
  visual_notes?: string | null;
  reference_images?: string[];
}

export interface AddReferenceImagePayload {
  image_url: string;
}

export interface RegenerateShotRequest {
  type?: "image" | "video";
}
