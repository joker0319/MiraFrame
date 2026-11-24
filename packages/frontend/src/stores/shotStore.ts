import { create } from "zustand";
import type { Shot, ShotConsistencyResult } from "@/types";

interface ShotState {
  shots: Shot[];
  isLoading: boolean;
  selectedShotId: number | null;

  setShots: (shots: Shot[]) => void;
  addShot: (shot: Shot) => void;
  /** Upsert: update if exists (by id), otherwise append */
  updateShot: (shot: Shot) => void;
  /** WebSocket 收到自动一致性结果时局部更新，不覆盖其他镜头字段 */
  setShotConsistency: (shotId: number, result: ShotConsistencyResult | null) => void;
  removeShot: (shotId: number) => void;
  clearShots: () => void;
  setSelectedShot: (id: number | null) => void;
  reorderShots: (fromIndex: number, toIndex: number) => void;
}

export const useShotStore = create<ShotState>((set) => ({
  shots: [],
  isLoading: false,
  selectedShotId: null,

  setShots: (shots) =>
    set({ shots: [...shots].sort((a, b) => a.order - b.order) }),

  addShot: (shot) =>
    set((state) => ({
      shots: [...state.shots, shot].sort((a, b) => a.order - b.order),
    })),

  updateShot: (shot) =>
    set((state) => {
      const idx = state.shots.findIndex((s) => s.id === shot.id);
      if (idx >= 0) {
        const updated = [...state.shots];
        updated[idx] = { ...updated[idx], ...shot };
        return { shots: updated.sort((a, b) => a.order - b.order) };
      }
      return { shots: [...state.shots, shot].sort((a, b) => a.order - b.order) };
    }),

  setShotConsistency: (shotId, result) =>
    set((state) => ({
      shots: state.shots.map((shot) =>
        shot.id === shotId ? { ...shot, consistency_result: result } : shot,
      ),
    })),

  removeShot: (shotId) =>
    set((state) => ({
      shots: state.shots.filter((s) => s.id !== shotId),
    })),

  clearShots: () => set({ shots: [] }),

  setSelectedShot: (id) => set({ selectedShotId: id }),

  reorderShots: (fromIndex, toIndex) =>
    set((state) => {
      const newShots = [...state.shots];
      const [moved] = newShots.splice(fromIndex, 1);
      newShots.splice(toIndex, 0, moved);
      return { shots: newShots.map((s, i) => ({ ...s, order: i })) };
    }),
}));
