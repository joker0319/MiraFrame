import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import type { SubtitleCue } from "@miraframe/shared";
import {
  planClipSubtitles,
  planProjectSubtitles,
  SubtitleOverlay,
  SubtitleToggle,
  useSubtitlePreference,
} from "../components/project/SubtitleOverlay";

const CUES: SubtitleCue[] = [
  { start: 0, end: 2, text: "沈鸢：起风了。", speaker: "沈鸢" },
  { start: 2.2, end: 5, text: "阿砚：我听见了。", speaker: "阿砚" },
];

function Harness({ cues = CUES, enabled = true }: { cues?: SubtitleCue[]; enabled?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  return (
    <div>
      <video ref={ref} data-testid="video" />
      <SubtitleOverlay videoRef={ref} cues={cues} enabled={enabled} />
    </div>
  );
}

function seekTo(seconds: number) {
  const video = screen.getByTestId("video") as HTMLVideoElement;
  Object.defineProperty(video, "currentTime", {
    value: seconds,
    configurable: true,
    writable: true,
  });
  act(() => {
    video.dispatchEvent(new Event("timeupdate"));
  });
}

function ToggleHarness() {
  const [enabled, setEnabled] = useSubtitlePreference();
  return (
    <div>
      <span data-testid="state">{enabled ? "on" : "off"}</span>
      <SubtitleToggle enabled={enabled} onToggle={setEnabled} />
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("SubtitleOverlay", () => {
  it("播放时间落在字幕区间内时显示对应台词", () => {
    render(<Harness />);
    seekTo(1);
    expect(screen.getByText("沈鸢：起风了。")).toBeInTheDocument();
  });

  it("时间推进后切换到下一条，旧字幕消失", () => {
    render(<Harness />);
    seekTo(1);
    expect(screen.getByText("沈鸢：起风了。")).toBeInTheDocument();
    seekTo(3);
    expect(screen.queryByText("沈鸢：起风了。")).not.toBeInTheDocument();
    expect(screen.getByText("阿砚：我听见了。")).toBeInTheDocument();
  });

  it("两条字幕之间的空隙不残留上一条", () => {
    render(<Harness />);
    seekTo(2.1);
    expect(screen.queryByText("沈鸢：起风了。")).not.toBeInTheDocument();
    expect(screen.queryByText("阿砚：我听见了。")).not.toBeInTheDocument();
  });

  it("关闭字幕后不渲染任何字幕层", () => {
    render(<Harness enabled={false} />);
    seekTo(1);
    expect(screen.queryByText("沈鸢：起风了。")).not.toBeInTheDocument();
  });

  it("没有台词时不渲染字幕层", () => {
    render(<Harness cues={[]} />);
    seekTo(1);
    expect(screen.queryByText(/起风了/)).not.toBeInTheDocument();
  });

  it("seeked 事件也会重新定位字幕", () => {
    render(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { value: 3, configurable: true, writable: true });
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    expect(screen.getByText("阿砚：我听见了。")).toBeInTheDocument();
  });
});

describe("字幕时间轴（前端集成）", () => {
  it("单镜头用视频真实时长铺满整条字幕", () => {
    const cues = planClipSubtitles("沈鸢（轻声）：『起风了。』", 5);
    expect(cues).toHaveLength(1);
    expect(cues[0].end).toBeCloseTo(5, 2);
  });

  it("还没拿到视频元数据时不产字幕，避免用估算时长错配", () => {
    expect(planClipSubtitles("沈鸢：『起风了。』", 0)).toEqual([]);
  });

  it("成片按镜头顺序排时间轴，并缩放到真实总时长", () => {
    const cues = planProjectSubtitles(
      [
        { dialogue: "沈鸢：『起风了。』", duration: 5 },
        { dialogue: "无台词，只有风声。", duration: 5 },
        { dialogue: "阿砚：『我听见了。』", duration: 5 },
      ],
      12,
    );
    expect(cues).toHaveLength(2);
    expect(cues[0].end).toBeCloseTo(4, 2);
    expect(cues[1].start).toBeGreaterThanOrEqual(8);
    expect(cues[1].end).toBeCloseTo(12, 2);
  });
});

describe("字幕开关", () => {
  it("默认开启，关闭后写入 localStorage 并在下次挂载时保持", () => {
    const first = render(<ToggleHarness />);
    expect(screen.getByTestId("state")).toHaveTextContent("on");
    fireEvent.click(screen.getByRole("button", { name: /字幕/ }));
    expect(screen.getByTestId("state")).toHaveTextContent("off");
    expect(window.localStorage.getItem("miraframe.subtitles.enabled")).toBe("off");

    first.unmount();
    render(<ToggleHarness />);
    expect(screen.getByTestId("state")).toHaveTextContent("off");
  });
});
