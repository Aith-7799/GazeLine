/** Visible browser area in the same CSS pixels as getBoundingClientRect(). */
export function visibleViewport() {
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? document.documentElement.clientWidth,
    height: viewport?.height ?? document.documentElement.clientHeight,
  };
}

export function visibleGazePoint(point: { x: number; y: number }) {
  const view = visibleViewport();
  return {
    x: Math.max(view.left, Math.min(view.left + view.width, point.x)),
    y: Math.max(view.top, Math.min(view.top + view.height, point.y)),
  };
}
