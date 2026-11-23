/**
 * 【已下线】IP 宇宙列表页。
 *
 * 后端没有 universes 模块，`db/schema.ts` 里也没有 universes / shared_characters 表，
 * 路由 `/universes` 已在 App.tsx 移除并重定向到 /projects。
 * 此文件仅作设计留档，恢复前需先补齐后端，见 MODIFICATIONS.md「IP 宇宙下线」。
 */
"use client";

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { universesApi } from "@/services/universesApi";
import { TopBar } from "@/components/layout/TopBar";
import { ArrowLeft, BookOpen, Globe2, Plus, Users } from "lucide-react";
import type { Universe } from "@/types";

export default function UniversesPage() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    description: "",
    world_setting: "",
    style_rules: "",
  });

  const { data: universes, isLoading } = useQuery({
    queryKey: ["universes"],
    queryFn: () => universesApi.list(),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      universesApi.create({
        name: createForm.name,
        description: createForm.description || undefined,
        world_setting: createForm.world_setting || undefined,
        style_rules: createForm.style_rules || undefined,
      }),
    onSuccess: () => {
      setShowCreate(false);
      setCreateForm({ name: "", description: "", world_setting: "", style_rules: "" });
      queryClient.invalidateQueries({ queryKey: ["universes"] });
    },
  });

  return (
    <div className="min-h-screen bg-paper">
      <TopBar />

      <main className="mx-auto w-full max-w-5xl px-5 py-8">
        <Link
          to="/"
          className="mb-6 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 transition-colors duration-150 hover:text-ink-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.7} />
          返回首页
        </Link>

        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="eyebrow">共享世界观</p>
            <h1 className="mt-2 font-serif text-[26px] leading-tight tracking-[-0.02em] text-ink-1">
              IP 宇宙
            </h1>
            <p className="mt-1.5 text-[12.5px] text-ink-3">
              管理跨项目的共享世界观与角色库
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="btn btn-primary gap-1.5"
          >
            <Plus className="h-4 w-4" strokeWidth={1.8} />
            创建宇宙
          </button>
        </div>

        {isLoading && (
          <div className="flex justify-center py-20">
            <span className="loading loading-spinner" />
          </div>
        )}

        {!isLoading && (!universes || universes.length === 0) && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-line py-20">
            <Globe2 className="h-7 w-7 text-ink-4" strokeWidth={1.4} />
            <p className="text-[13px] text-ink-2">还没有 IP 宇宙</p>
            <p className="text-[12px] text-ink-3">
              创建宇宙来管理跨项目的世界观和共享角色
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="btn btn-ghost btn-sm mt-1"
            >
              创建第一个宇宙
            </button>
          </div>
        )}

        {!isLoading && universes && universes.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {universes.map((universe: Universe) => (
              <Link
                key={universe.id}
                to={`/universes/${universe.id}`}
                className="card group block transition-shadow duration-150 hover:shadow-[inset_0_0_0_1px_var(--color-ink-4),var(--shadow-card)]"
              >
                {universe.cover_image_url && (
                  <div className="h-28 overflow-hidden bg-base-200">
                    <img
                      src={universe.cover_image_url}
                      alt={universe.name}
                      className="h-full w-full object-cover"
                      style={{ filter: "saturate(.85)" }}
                    />
                  </div>
                )}
                <div className="p-4">
                  <h3 className="font-serif text-[15px] font-medium text-ink-1">
                    {universe.name}
                  </h3>
                  {universe.description && (
                    <p className="mt-1.5 line-clamp-2 text-[12px] leading-6 text-ink-3">
                      {universe.description}
                    </p>
                  )}
                  <div className="mt-3 flex items-center gap-4 font-mono text-[10.5px] text-ink-3 tabular-nums">
                    <span className="flex items-center gap-1">
                      <BookOpen className="h-3 w-3" strokeWidth={1.7} />
                      {universe.projects_count} 章
                    </span>
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" strokeWidth={1.7} />
                      {universe.shared_characters_count} 角色
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          onClick={() => setShowCreate(false)}
          role="dialog"
          aria-modal="true"
          aria-label="创建 IP 宇宙"
        >
          <div
            className="card max-h-[90vh] w-full max-w-lg overflow-y-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 font-serif text-[17px] font-medium text-ink-1">
              创建 IP 宇宙
            </h3>
            <div className="space-y-4">
              <div>
                <label htmlFor="uni-name" className="mb-1 block text-[12px] text-ink-2">
                  名称 *
                </label>
                <input
                  id="uni-name"
                  className="input"
                  placeholder="如：赛博修仙录"
                  value={createForm.name}
                  onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="uni-desc" className="mb-1 block text-[12px] text-ink-2">
                  描述
                </label>
                <textarea
                  id="uni-desc"
                  className="textarea"
                  rows={3}
                  value={createForm.description}
                  onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="uni-world" className="mb-1 block text-[12px] text-ink-2">
                  世界观设定
                </label>
                <textarea
                  id="uni-world"
                  className="textarea"
                  rows={3}
                  value={createForm.world_setting}
                  onChange={(e) => setCreateForm((f) => ({ ...f, world_setting: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="uni-style" className="mb-1 block text-[12px] text-ink-2">
                  风格规则
                </label>
                <textarea
                  id="uni-style"
                  className="textarea"
                  rows={2}
                  value={createForm.style_rules}
                  onChange={(e) => setCreateForm((f) => ({ ...f, style_rules: e.target.value }))}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className="btn btn-ghost btn-sm">
                取消
              </button>
              <button
                onClick={() => createMutation.mutate()}
                disabled={!createForm.name.trim() || createMutation.isPending}
                className="btn btn-primary btn-sm"
              >
                {createMutation.isPending ? "创建中" : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
