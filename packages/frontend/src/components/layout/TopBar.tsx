"use client";

import { Link } from "react-router-dom";
import { useThemeStore } from "@/stores/themeStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { BRAND } from "@/lib/brand";
import { FolderKanban, Settings, Sun, Moon } from "lucide-react";

export function TopBar() {
  const { isDark, toggleTheme } = useThemeStore();
  const { openModal: openSettings } = useSettingsStore();

  return (
    <header className="flex-shrink-0 flex items-center h-12 z-30 px-4 bg-paper/85 backdrop-blur-sm border-b border-line">
      {/* 品牌标识：方印 + 衬线中文字，克制不喧哗 */}
      <div className="flex items-center gap-2.5">
        <Link
          to="/"
          className="flex items-center gap-2.5 group"
          aria-label={`${BRAND.fullName} 首页`}
        >
          <span
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] font-serif text-[15px] leading-none text-primary select-none"
            style={{
              boxShadow: "inset 0 0 0 1.5px var(--color-primary)",
              fontFamily: "var(--font-serif)",
            }}
            aria-hidden="true"
          >
            弥
          </span>
          <span className="flex items-baseline gap-2">
            <span className="text-[13.5px] font-semibold tracking-tight text-ink-1">
              {BRAND.name}
            </span>
            <span className="hidden sm:inline font-serif text-[13px] text-ink-3 tracking-[0.02em]">
              {BRAND.cnName}
            </span>
          </span>
        </Link>
      </div>

      <div className="flex-1" />

      <nav className="flex items-center gap-0.5" aria-label="全局导航">
        <Link
          to="/projects"
          className="btn btn-xs btn-ghost gap-1.5"
          aria-label="项目列表"
        >
          <FolderKanban className="h-[15px] w-[15px]" strokeWidth={1.6} />
          <span className="hidden sm:inline">项目</span>
        </Link>

        <button
          onClick={toggleTheme}
          className="btn btn-xs btn-ghost btn-circle"
          aria-label={isDark ? "切换到亮色主题" : "切换到暗色主题"}
          title={isDark ? "亮色" : "暗色"}
        >
          {isDark ? (
            <Sun className="h-[15px] w-[15px]" strokeWidth={1.6} />
          ) : (
            <Moon className="h-[15px] w-[15px]" strokeWidth={1.6} />
          )}
        </button>

        <button
          onClick={openSettings}
          className="btn btn-xs btn-ghost btn-circle"
          aria-label="打开设置"
          title="设置"
        >
          <Settings className="h-[15px] w-[15px]" strokeWidth={1.6} />
        </button>
      </nav>
    </header>
  );
}
