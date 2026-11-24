/**
 * Consistency Evaluation API — 角色长相一致性校验。
 *
 * 后端是按需计算的：请求一次就把当前的角色参考图与所有镜头图做一遍人脸比对，
 * 结果不落库。首次请求需要下载并推理全部图片（约 2-3 秒），之后命中进程内缓存。
 */
import { fetchApi } from "./client";
import type { ConsistencyReportRead, ShotRepairResult } from "@/types";

export const consistencyApi = {
  check: (projectId: number, options?: { refresh?: boolean }) =>
    fetchApi<ConsistencyReportRead>(
      `/api/v1/projects/${projectId}/consistency${options?.refresh ? "?refresh=1" : ""}`,
    ),

  /** 用角色参考图重画一个镜头，后端会自动重新校验这一张。 */
  repairShot: (projectId: number, shotId: number) =>
    fetchApi<ShotRepairResult>(
      `/api/v1/projects/${projectId}/shots/${shotId}/regenerate-with-references`,
      { method: "POST" },
    ),
};
