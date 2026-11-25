import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NodeDetail } from "../components/project/NodeDetail";
import { useCritiqueStore } from "../stores/critiqueStore";
import type { Character, Shot } from "@/types";
import type { WorkflowNode } from "@/utils/projectWorkflow";

// 一致性面板挂载时会主动拉报告；组件测试只关心它是否被渲染，不关心报告内容。
vi.mock("../services/consistencyApi", () => ({
  consistencyApi: {
    check: vi.fn().mockResolvedValue({ shots: [], summary: null }),
    repairShot: vi.fn().mockResolvedValue({}),
  },
}));

type NodeDetailProps = ComponentProps<typeof NodeDetail>;

const makeNode = (id: string): WorkflowNode => ({
  id,
  label: "测试节点",
  description: "节点说明",
  icon: () => null,
  status: "active",
  metric: "0/0",
});

function setup(selectedNode: WorkflowNode, overrides: Partial<NodeDetailProps> = {}) {
  const props: NodeDetailProps = {
    projectId: 1,
    selectedNode,
    outline: null,
    visualBible: null,
    characters: [],
    shots: [],
    projectVideoUrl: null,
    awaitingConfirm: false,
    awaitingAgent: null,
    awaitingOutline: false,
    needsOutlineApproval: false,
    latestRunError: null,
    taskVideoCount: 0,
    onRetryMaterials: vi.fn(),
    onConfirm: vi.fn(),
    onSubmitRevision: vi.fn(),
    isSubmittingRevision: false,
    ...overrides,
  };
  return { props, ...render(<NodeDetail {...props} />) };
}

const makeCharacter = (overrides: Partial<Character> = {}): Character => ({
  id: 1,
  project_id: 1,
  name: "沈鸢",
  description: "女主",
  image_url: "/static/character-1.png",
  ...overrides,
});

const makeShot = (overrides: Partial<Shot> = {}): Shot => ({
  id: 1,
  project_id: 1,
  order: 1,
  description: "雨夜巷口",
  image_url: "/static/frame-1.png",
  video_url: null,
  ...overrides,
});

beforeEach(() => {
  useCritiqueStore.setState({ latest: null, history: [], byStage: {} });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("NodeDetail 节点分支", () => {
  it("大纲节点展示大纲、分幕与视觉风格，待确认时给出确认入口", () => {
    const { props } = setup(makeNode("outline"), {
      outline: {
        title: "雾中字条",
        logline: "一封字条引发的追逐",
        acts: ["相遇", "告别"],
      },
      visualBible: "冷色调，雨夜",
      awaitingOutline: true,
    });

    expect(screen.getByText("雾中字条")).toBeInTheDocument();
    expect(screen.getByText("一封字条引发的追逐")).toBeInTheDocument();
    expect(screen.getByText("冷色调，雨夜")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /确认大纲/ }));
    expect(props.onConfirm).toHaveBeenCalledWith();
  });

  it("大纲节点的修改以 outline/rewrite 提交，空白内容不可提交", () => {
    const { props } = setup(makeNode("outline"));
    const submit = screen.getByRole("button", { name: "提交修改" });

    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/加强反派动机/), {
      target: { value: "  更悬疑  " },
    });
    fireEvent.click(submit);

    expect(props.onSubmitRevision).toHaveBeenCalledWith({
      content: "更悬疑",
      entity_type: "outline",
      feedback_type: "rewrite",
    });
  });

  it("角色节点空态与缺图重试都指向角色维度，限流错误被翻译成人话", () => {
    setup(makeNode("characters"));
    expect(screen.getByText("角色设定尚未生成")).toBeInTheDocument();

    cleanup();
    const { props } = setup(makeNode("characters"), {
      characters: [makeCharacter({ image_url: null })],
      latestRunError: "RateQuota exceeded",
    });

    expect(screen.getByText("角色图缺失")).toBeInTheDocument();
    // 顶部错误框与缺图角色卡片都会格式化同一条错误，两处都显示是预期的。
    expect(screen.getAllByText(/外部生成服务触发限流/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /重试缺失角色图/ }));
    expect(props.onSubmitRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: "characters",
        feedback_type: "regenerate_image",
      }),
    );
  });

  it("确认按钮按 agent 精确匹配，不把别的节点的确认入口显示出来", () => {
    setup(makeNode("characters"), {
      characters: [makeCharacter()],
      awaitingConfirm: true,
      awaitingAgent: "shots",
    });
    expect(screen.queryByRole("button", { name: /确认角色/ })).not.toBeInTheDocument();

    cleanup();
    const { props } = setup(makeNode("characters"), {
      characters: [makeCharacter()],
      awaitingConfirm: true,
      awaitingAgent: "characters",
    });
    fireEvent.click(screen.getByRole("button", { name: /确认角色/ }));
    expect(props.onConfirm).toHaveBeenCalledWith();
  });

  it("分镜节点展示镜头元信息、评审空态，并以 script 类型提交修改", () => {
    const { props } = setup(makeNode("shots"), {
      shots: [
        makeShot({
          scene: "旧巷",
          camera: "特写",
          dialogue: "沈鸢：『走吧。』",
          duration: 5,
        }),
      ],
      awaitingConfirm: true,
      awaitingAgent: "shots",
    });

    expect(screen.getByText("旧巷")).toBeInTheDocument();
    expect(screen.getByText("沈鸢：『走吧。』")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /确认分镜/ })).toBeInTheDocument();
    expect(screen.getByText(/还没有评审结果/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/减少铺垫镜头/), {
      target: { value: "增加雨戏" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交修改" }));
    expect(props.onSubmitRevision).toHaveBeenCalledWith({
      content: "增加雨戏",
      entity_type: "shots",
      feedback_type: "script",
    });
  });

  it("画面节点把漂移镜头标红，重生成视频携带正确的镜头 id", () => {
    const { props } = setup(makeNode("shotImages"), {
      shots: [
        makeShot({
          id: 7,
          order: 3,
          consistency_result: { verdict: "drift" } as never,
        }),
      ],
    });

    expect(screen.getByText("角色长相漂移")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重生成视频/ }));
    expect(props.onSubmitRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: "shot",
        entity_id: 7,
        feedback_type: "regenerate_video",
      }),
    );
  });

  it("画面节点遇到任务地址时提示重试未完成物料", () => {
    const { props } = setup(makeNode("shotImages"), {
      shots: [makeShot({ video_url: "/tasks/abc" })],
      latestRunError: "boom",
      taskVideoCount: 1,
    });

    expect(screen.getByText(/检测到 1 条视频仍是任务地址/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重试未完成物料/ }));
    expect(props.onRetryMaterials).toHaveBeenCalled();
  });

  it("输出节点对内部合成地址给出警告，并按可播放镜头数显示进度", () => {
    setup(makeNode("output"), {
      shots: [
        makeShot({ video_url: "/static/frame-1.mp4" }),
        makeShot({ id: 2, order: 2, image_url: null, video_url: null }),
      ],
      projectVideoUrl: "miraframe:composition:legacy",
    });

    expect(screen.getByText(/等待全部镜头视频完成后输出/)).toBeInTheDocument();
    expect(screen.getByText(/旧版内部合成地址/)).toBeInTheDocument();
    expect(screen.getByText(/当前可播放镜头 1\/2/)).toBeInTheDocument();
  });

  it("成片灯箱带字幕开关，Esc 可以关闭", () => {
    setup(makeNode("output"), {
      shots: [makeShot({ dialogue: "沈鸢：『走吧。』", duration: 5 })],
      projectVideoUrl: "/static/exports/project-1/final.mp4",
    });

    expect(screen.getByRole("link", { name: /导出成片/ })).toBeInTheDocument();
    const trigger = document.querySelector("button.group") as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);

    expect(screen.getByRole("button", { name: "关闭预览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "字幕" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "关闭预览" })).not.toBeInTheDocument();
  });

  it("只有大纲、角色、分镜节点提供修改面板", () => {
    setup(makeNode("output"));
    expect(screen.queryByRole("button", { name: "提交修改" })).not.toBeInTheDocument();

    cleanup();
    setup(makeNode("shotImages"));
    expect(screen.queryByRole("button", { name: "提交修改" })).not.toBeInTheDocument();
  });
});
