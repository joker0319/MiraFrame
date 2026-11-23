"use client";

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "@/services/projectsApi";
import { GenerationServiceNotice } from "@/components/settings/GenerationServiceNotice";
import { TopBar } from "@/components/layout/TopBar";
import { BRAND } from "@/lib/brand";
import { ArrowUpRight, FolderOpen, Plus, Trash2 } from "lucide-react";
import type { Project } from "@/types";

export default function ProjectsPage() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<number[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const { data: projects, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list(),
    retry: 1,
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => projectsApi.deleteMany(ids),
    onSuccess: (_, deletedIds) => {
      setSelectedIds((prev) => prev.filter((id) => !deletedIds.includes(id)));
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const allSelected = projects?.length ? selectedIds.length === projects.length : false;

  const toggleSelectAll = () => {
    if (!projects) return;
    if (allSelected) setSelectedIds([]);
    else setSelectedIds(projects.map((p) => p.id));
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleDeleteClick = (id: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleteTarget([id]);
  };

  const handleBatchDelete = () => {
    if (selectedIds.length === 0) return;
    setDeleteTarget([...selectedIds]);
  };

  const renderStatus = (status?: string | null) => {
    if (status === "ready")
      return <span className="badge badge-success badge-sm">已完成</span>;
    if (status === "processing" || status === "running")
      return <span className="badge badge-warning badge-sm">生成中</span>;
    if (status === "failed")
      return <span className="badge badge-error badge-sm">失败</span>;
    return <span className="badge badge-outline badge-sm">草稿</span>;
  };

  return (
    <div className="min-h-screen bg-paper">
      <TopBar />

      <main className="mx-auto w-full max-w-4xl px-5 py-10">
        {/* 页头 */}
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-[26px] leading-tight tracking-[-0.02em] text-ink-1">
              全部项目
            </h1>
            <p className="mt-1.5 text-[12.5px] text-ink-3">
              {projects?.length
                ? `共 ${projects.length} 个漫剧项目，按最近更新排列`
                : `管理 ${BRAND.cnName} 里的漫剧项目与生成记录`}
            </p>
          </div>
          <Link to="/" className="btn btn-primary gap-1.5">
            <Plus className="h-4 w-4" strokeWidth={1.8} />
            新建项目
          </Link>
        </div>

        <GenerationServiceNotice />

        {/* 工具条 */}
        <div className="mb-3 flex items-center justify-between gap-3 border-y border-line-soft py-2.5">
          <label className="flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-ink-2">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleSelectAll}
              disabled={!projects?.length}
              className="checkbox"
            />
            全选
            {selectedIds.length > 0 && (
              <span className="font-mono text-[11px] text-ink-3 tabular-nums">
                已选 {selectedIds.length}
              </span>
            )}
          </label>
          <button
            onClick={handleBatchDelete}
            disabled={selectedIds.length === 0}
            className="btn btn-ghost btn-sm gap-1.5 text-ink-2 hover:text-error"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
            批量删除
          </button>
        </div>

        {/* 内容 */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20">
            <span className="loading loading-spinner" />
            <p className="text-[12.5px] text-ink-3">正在读取项目列表</p>
          </div>
        )}

        {error && (
          <div className="alert alert-error" role="alert">
            <span>加载项目失败，请刷新重试。</span>
          </div>
        )}

        {!isLoading && !error && (!projects || projects.length === 0) && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-line py-20">
            <FolderOpen className="h-7 w-7 text-ink-4" strokeWidth={1.4} />
            <p className="text-[13px] text-ink-2">还没有项目</p>
            <p className="text-[12px] text-ink-3">从首页写下第一段故事开始。</p>
            <Link to="/" className="btn btn-ghost btn-sm mt-1">
              回到首页
            </Link>
          </div>
        )}

        {!isLoading && !error && projects && projects.length > 0 && (
          <ul className="overflow-hidden rounded-md border border-line bg-surface">
            {projects.map((project: Project) => {
              const selected = selectedIds.includes(project.id);
              return (
                <li key={project.id} className="border-b border-line-soft last:border-b-0">
                  <div
                    className={`group flex items-center gap-3 px-4 py-3 transition-colors duration-150 ${
                      selected ? "bg-primary/[0.04]" : "hover:bg-base-200/70"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleSelect(project.id)}
                      className="checkbox"
                      aria-label={`选择 ${project.title}`}
                    />
                    <Link
                      to={`/project/${project.id}`}
                      className="flex min-w-0 flex-1 items-center gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-medium text-ink-1">
                            {project.title}
                          </span>
                          {renderStatus(project.status)}
                        </div>
                        {project.story && (
                          <p className="mt-0.5 truncate text-[12px] text-ink-3">
                            {project.story}
                          </p>
                        )}
                      </div>
                      <ArrowUpRight
                        className="h-4 w-4 shrink-0 text-ink-4 transition-colors duration-150 group-hover:text-ink-2"
                        strokeWidth={1.6}
                      />
                    </Link>
                    <button
                      onClick={(e) => handleDeleteClick(project.id, e)}
                      className="shrink-0 rounded p-1.5 text-ink-4 opacity-0 transition-all duration-150 hover:bg-error-tint hover:text-error group-hover:opacity-100 focus-visible:opacity-100"
                      title="删除项目"
                      aria-label={`删除 ${project.title}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {/* 删除确认 */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          onClick={() => setDeleteTarget(null)}
          role="dialog"
          aria-modal="true"
          aria-label="确认删除项目"
        >
          <div
            className="card w-full max-w-sm p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[15px] font-semibold text-ink-1">删除项目</h3>
            <p className="mt-2 text-[12.5px] leading-7 text-ink-2">
              将删除选中的 {deleteTarget.length} 个项目，包含其大纲、角色、分镜与成片记录。此操作不可撤销。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="btn btn-ghost btn-sm"
              >
                取消
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteTarget)}
                disabled={deleteMutation.isPending}
                className="btn btn-destructive btn-sm"
              >
                {deleteMutation.isPending ? "删除中" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
