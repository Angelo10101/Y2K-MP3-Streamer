// WebKitGTK on X11 only presents the changed region of a transparent window: after the first
// frame every later frame repaints just the damage (the visualizer, a hovered button), and the
// rest of the page goes blank. A page-sized layer that changes every frame makes each frame
// repaint the whole page. Its alpha is 1/255, so it is invisible, and it ignores the pointer.
// Linux only, and only while the window is visible.
export function keepRepainting() {
  if (!/Linux/.test(navigator.userAgent)) return;
  const layer = document.createElement("div");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;background:rgba(0,0,0,0.004);z-index:2147483647";
  document.body.appendChild(layer);
  let flip = false;
  const tick = () => {
    if (!document.hidden) layer.style.opacity = (flip = !flip) ? "1" : "0.98";
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
