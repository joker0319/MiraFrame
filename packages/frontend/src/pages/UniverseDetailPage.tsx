/**
 * 【已下线】IP 宇宙详情页。
 *
 * 同 UniversesPage：后端无 universes 接口与表，路由已移除。
 * 此文件仅作设计留档，恢复前需先补齐后端，见 MODIFICATIONS.md「IP 宇宙下线」。
 */
"use client";

import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  Globe2,
  Palette,
  Plus,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { universesApi } from "@/services/universesApi";
import { projectsApi } from "@/services/projectsApi";
import { getStaticUrl } from "@/services/client";
import { TopBar } from "@/components/layout/TopBar";
import type { UniverseDetail, SharedCharacterRead } from "@/types";

export default function UniverseDetailPage() {
  const { universeId } = useParams<{ universeId: string }>();
  const queryClient = useQueryClient();
  const [showAddProject, setShowAddProject] = useState(false);
  const id = universeId ? parseInt(universeId) : null;

  const { data: universe, isLoading } = useQuery({
    queryKey: ["universe", id],
    queryFn: () => universesApi.get(id!),
    enabled: !!id,
  });

  const { data: allProjects } = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list(),
    enabled: showAddProject,
  });

  const addProjectMutation = useMutation({
    mutationFn: (projectId: number) => {
      const existingChapters = universe?.chapters || [];
      const maxChapter = existingChapters.reduce((max, c) => Math.max(max, c.chapter_number || 0), 0);
      return universesApi.addProject(id!, projectId, maxChapter + 1);
    },
    onSuccess: () => {
      setShowAddProject(false);
      queryClient.invalidateQueries({ queryKey: ["universe", id] });
    },
  });

  const removeProjectMutation = useMutation({
    mutationFn: (projectId: number) => universesApi.removeProject(id!, projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["universe", id] }),
  });

  if (!id) {
    return (
      <div className="min-h-screen bg-paper">
        <TopBar />
        <div className="px-5 py-20 text-center text-[13px] text-ink-3">无效的宇宙 ID</div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-paper">
        <TopBar />
        <div className="flex items-center justify-center py-24">
          <span className="loading loading-spinner" />
        </div>
      </div>
    );
  }

  if (!universe) {
    return (
      <div className="min-h-screen bg-paper">
        <TopBar />
        <div className="flex flex-col items-center justify-center gap-3 py-24">
          <p className="text-[13px] text-ink-2">宇宙未找到</p>
          <Link to="/universes" className="btn btn-sm btn-outline">
            返回宇宙列表
          </Link>
        </div>
      </div>
    );
  }

  const availableProjects = allProjects?.filter(
    (p) => !universe.chapters?.some((c) => c.project_id === p.id),
  );
  const chapters = [...(universe.chapters || [])].sort(
    (a, b) => (a.chapter_number || 0) - (b.chapter_number || 0),
  );
  const characterCount = universe.shared_characters?.length ?? 0;

  return (
    <div className="min-h-screen bg-paper">
      <TopBar />

      <main className="mx-auto w-full max-w-5xl px-5 py-8">
        <Link
          to="/universes"
          className="mb-6 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 transition-colors duration-150 hover:text-ink-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.7} />
          返回 IP 宇宙
        </Link>

        <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">IP 宇宙</p>
            <h1 className="mt-2 font-serif text-[26px] leading-tight tracking-[-0.02em] text-ink-1">
              {universe.name}
            </h1>
            {universe.description && (
              <p className="mt-2 max-w-xl text-[12.5px] leading-6 text-ink-3">
                {universe.description}
              </p>
            )}
            <div className="mt-3 flex items-center gap-4 font-mono text-[10.5px] text-ink-3 tabular-nums">
              <span className="flex items-center gap-1">
                <BookOpen className="h-3 w-3" strokeWidth={1.7} />
                {chapters.length} 章
              </span>
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" strokeWidth={1.7} />
                {characterCount} 共享角色
              </span>
            </div>
          </div>
          <button onClick={() => setShowAddProject(true)} className="btn btn-primary gap-1.5">
            <Plus className="h-4 w-4" strokeWidth={1.8} />
            添加章节
          </button>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
          {/* 左：章节 + 设定 */}
          <div className="space-y-6">
            <section className="card-flat">
              <div className="flex h-11 items-center justify-between border-b border-line-soft px-4">
                <h2 className="flex items-center gap-2 text-[13px] font-medium text-ink-1">
                  <BookOpen className="h-3.5 w-3.5 text-ink-3" strokeWidth={1.7} />
                  章节列表
                </h2>
                <span className="font-mono text-[10.5px] text-ink-4 tabular-nums">
                  {String(chapters.length).padStart(2, "0")}
                </span>
              </div>

              {chapters.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-[12.5px] text-ink-3">还没有章节</p>
                  <button
                    onClick={() => setShowAddProject(true)}
                    className="btn btn-ghost btn-sm mt-2"
                  >
                    添加第一个项目
                  </button>
                </div>
              ) : (
                <ul>
                  {chapters.map((chapter) => (
                    <li
                      key={chapter.id}
                      className="group flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0"
                    >
                      <span className="w-7 shrink-0 font-mono text-[11px] text-ink-4 tabular-nums">
                        {String(chapter.chapter_number ?? 0).padStart(2, "0")}
                      </span>
                      <Link
                        to={`/project/${chapter.project_id}`}
                        className="min-w-0 flex-1 truncate text-[13px] text-ink-1 transition-colors duration-150 hover:text-primary"
                      >
                        {chapter.project_title || `项目 #${chapter.project_id}`}
                      </Link>
                      {!chapter.is_main_story && (
                        <span className="badge badge-outline badge-xs shrink-0">外传</span>
                      )}
                      <button
                        onClick={() => removeProjectMutation.mutate(chapter.project_id)}
                        className="shrink-0 rounded-[4px] p-1 text-ink-4 opacity-0 transition-all duration-150 hover:bg-error-tint hover:text-error focus-visible:opacity-100 group-hover:opacity-100"
                        aria-label={`从宇宙移除 ${chapter.project_title || `项目 #${chapter.project_id}`}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {universe.world_setting && (
              <section className="card-flat p-4">
                <h2 className="flex items-center gap-2 text-[12px] font-medium tracking-[0.01em] text-ink-2">
                  <Globe2 className="h-3.5 w-3.5 text-ink-4" strokeWidth={1.7} />
                  世界观
                </h2>
                <p className="mt-2.5 whitespace-pre-wrap text-[12.5px] leading-7 text-ink-2">
                  {universe.world_setting}
                </p>
              </section>
            )}

            {universe.style_rules && (
              <section className="card-flat p-4">
                <h2 className="flex items-center gap-2 text-[12px] font-medium tracking-[0.01em] text-ink-2">
                  <Palette className="h-3.5 w-3.5 text-ink-4" strokeWidth={1.7} />
                  风格规则
                </h2>
                <p className="mt-2.5 whitespace-pre-wrap text-[12.5px] leading-7 text-ink-2">
                  {universe.style_rules}
                </p>
              </section>
            )}
          </div>

          {/* 右：共享角色库 */}
          <section className="card-flat h-fit">
            <div className="flex h-11 items-center justify-between border-b border-line-soft px-4">
              <h2 className="flex items-center gap-2 text-[13px] font-medium text-ink-1">
                <Users className="h-3.5 w-3.5 text-ink-3" strokeWidth={1.7} />
                共享角色库
              </h2>
              <span className="font-mono text-[10.5px] text-ink-4 tabular-nums">
                {String(characterCount).padStart(2, "0")}
              </span>
            </div>

            {characterCount === 0 ? (
              <div className="px-4 py-10 text-center">
                <UserRound className="mx-auto h-6 w-6 text-ink-4" strokeWidth={1.4} />
                <p className="mt-2 text-[12.5px] text-ink-3">还没有共享角色</p>
                <p className="mt-1 text-[11.5px] leading-5 text-ink-4">
                  从项目角色中提升后，会出现在这里
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 p-3">
                {universe.shared_characters?.map((character) => (
                  <SharedCharacterCard key={character.id} character={character} />
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

      {showAddProject && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          onClick={() => setShowAddProject(false)}
          role="dialog"
          aria-modal="true"
          aria-label="添加项目到宇宙"
        >
          <div
            className="card max-h-[80vh] w-full max-w-md overflow-y-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 font-serif text-[17px] font-medium text-ink-1">
              添加项目到宇宙
            </h3>
            <p className="mb-4 text-[12px] text-ink-3">
              选中的项目将作为下一章加入本书时间线
            </p>

            {!availableProjects || availableProjects.length === 0 ? (
              <p className="py-6 text-center text-[12.5px] text-ink-3">没有可添加的项目</p>
            ) : (
              <div className="max-h-[46vh] space-y-0.5 overflow-y-auto">
                {availableProjects.map((project) => (
                  <button
                    key={project.id}
                    onClick={() => addProjectMutation.mutate(project.id)}
                    disabled={addProjectMutation.isPending}
                    className="w-full truncate rounded-[5px] px-3 py-2 text-left text-[13px] text-ink-2 transition-colors duration-150 hover:bg-base-200 hover:text-ink-1 disabled:opacity-50"
                  >
                    {project.title}
                  </button>
                ))}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShowAddProject(false)} className="btn btn-ghost btn-sm">
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SharedCharacterCard({ character }: { character: SharedCharacterRead }) {
  const imageUrl = getStaticUrl(character.canonical_image_url);
  const tags =
    character.character_tags?.split(",").map((t) => t.trim()).filter(Boolean) || [];

  return (
    <div className="rounded-[6px] p-2.5 transition-shadow duration-150 hover:shadow-[inset_0_0_0_1px_var(--color-line)]">
      <div className="mb-2 h-20 w-full overflow-hidden rounded-[4px] bg-base-200 shadow-[inset_0_0_0_1px_var(--color-line-soft)]">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={character.name}
            className="h-full w-full object-cover"
            style={{ filter: "saturate(.9)" }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <UserRound className="h-5 w-5 text-ink-4" strokeWidth={1.4} />
          </div>
        )}
      </div>

      <div className="flex items-baseline justify-between gap-1">
        <h3 className="truncate font-serif text-[13px] font-medium text-ink-1">
          {character.name}
        </h3>
        <span className="shrink-0 font-mono text-[10px] text-ink-3 tabular-nums">
          v{character.version}
        </span>
      </div>

      {tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {tags.slice(0, 3).map((tag, i) => (
            <span key={i} className="badge badge-outline badge-xs">
              {tag}
            </span>
          ))}
        </div>
      )}

      {character.description && (
        <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-5 text-ink-2">
          {character.description}
        </p>
      )}
    </div>
  );
}
