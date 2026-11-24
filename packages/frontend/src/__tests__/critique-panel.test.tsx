import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CritiquePanel } from "../components/project/CritiquePanel";
import { useCritiqueStore } from "../stores/critiqueStore";
import type { CritiqueResultEventData } from "@/types";

const makeCritique = (overrides: Partial<CritiqueResultEventData> = {}): CritiqueResultEventData => ({
  stage: "critique_shots",
  entity_type: "shots",
  score: 8.4,
  threshold: 7,
  passed: true,
  round: 1,
  max_rounds: 2,
  dimensions: { narrative: 9, continuity: 8 },
  issues: [],
  suggestions: [],
  will_regenerate: false,
  ...overrides,
});

beforeEach(() => {
  useCritiqueStore.setState({ latest: null, history: [] });
});

afterEach(() => {
  cleanup();
});

describe("CritiquePanel", () => {
  it("没有评审结果时给出等待提示，而不是空白面板", () => {
    render(<CritiquePanel />);
    expect(screen.getByText(/还没有评审结果/)).toBeInTheDocument();
  });

  it("展示总分、阈值与轮次", () => {
    render(<CritiquePanel critique={makeCritique()} />);
    expect(screen.getByText("8.4")).toBeInTheDocument();
    expect(screen.getByText(/阈值 7/)).toBeInTheDocument();
    expect(screen.getByText("第 1/2 轮")).toBeInTheDocument();
    expect(screen.getByText(/阈值 7 · 已通过/)).toBeInTheDocument();
  });

  it("未通过时说明是「回灌重写」还是「到轮次上限转人工」", () => {
    render(
      <CritiquePanel
        critique={makeCritique({ score: 5.5, passed: false, will_regenerate: true, issues: ["场景矛盾"] })}
      />,
    );
    expect(screen.getByText(/评审意见已回灌/)).toBeInTheDocument();
    expect(screen.getByText(/场景矛盾/)).toBeInTheDocument();
  });

  it("最后一轮仍未通过时提示转人工确认", () => {
    render(
      <CritiquePanel
        critique={makeCritique({ score: 5, passed: false, round: 2, will_regenerate: false })}
      />,
    );
    expect(screen.getByText(/已到轮次上限，转人工确认/)).toBeInTheDocument();
  });

  it("从 store 读取历史时展示收敛轨迹", () => {
    useCritiqueStore.setState({
      latest: makeCritique({ score: 8.2, round: 2 }),
      history: [makeCritique({ score: 5.5, passed: false }), makeCritique({ score: 8.2, round: 2 })],
    });

    render(<CritiquePanel />);

    expect(screen.getByText(/R1 5\.5 → R2 8\.2/)).toBeInTheDocument();
  });

  it("store 只保留最近 10 轮，避免长跑项目无限增长", () => {
    useCritiqueStore.getState().reset();
    for (let i = 1; i <= 12; i++) {
      useCritiqueStore.getState().record(makeCritique({ round: i, score: i }));
    }

    const { history, latest } = useCritiqueStore.getState();
    expect(history).toHaveLength(10);
    expect(history[0].round).toBe(3);
    expect(latest?.round).toBe(12);
  });
});
