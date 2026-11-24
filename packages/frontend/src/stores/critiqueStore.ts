import { create } from "zustand";
import type { CritiqueResultEventData } from "@/types";

/** 保留最近多少轮评审，够回溯一次完整打回循环即可 */
const HISTORY_LIMIT = 10;

interface CritiqueState {
  /** 最近一次评审结果，节点详情里的评分卡片直接读它 */
  latest: CritiqueResultEventData | null;
  /** 按时间正序的历史，用于看「第 1 轮 5.5 分 → 第 2 轮 8.2 分」的收敛过程 */
  history: CritiqueResultEventData[];

  record: (entry: CritiqueResultEventData) => void;
  reset: () => void;
}

export const useCritiqueStore = create<CritiqueState>((set) => ({
  latest: null,
  history: [],

  record: (entry) =>
    set((state) => ({
      latest: entry,
      history: [...state.history, entry].slice(-HISTORY_LIMIT),
    })),

  reset: () => set({ latest: null, history: [] }),
}));
