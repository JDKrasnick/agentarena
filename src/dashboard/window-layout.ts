export type DesktopWindowMode = "battle" | "results";

export interface DesktopWindowSize {
  width: number;
  height: number;
}

const desiredSizes: Record<DesktopWindowMode, DesktopWindowSize> = {
  battle: { width: 1600, height: 1020 },
  results: { width: 1180, height: 820 },
};

export function desktopWindowSize(
  mode: DesktopWindowMode,
  workArea: DesktopWindowSize,
): DesktopWindowSize {
  const desired = desiredSizes[mode];
  return {
    width: Math.max(320, Math.min(desired.width, workArea.width - 40)),
    height: Math.max(480, Math.min(desired.height, workArea.height - 40)),
  };
}
