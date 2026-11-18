// Pointer parallax on the product panels, tilt on the feature panels and the scroll "settle". All mouse-only or
// motion-safe; the content is visible without any of it. Returns a cleanup function.

export function initMotion(root: HTMLElement, reduce: boolean): () => void {
  if (reduce) return () => {};
  const undo: (() => void)[] = [];
  const listen = (el: Element, name: string, fn: (e: PointerEvent) => void) => {
    el.addEventListener(name, fn as EventListener);
    undo.push(() => el.removeEventListener(name, fn as EventListener));
  };

  // Pointer parallax with easing (no gyro).
  const area = root.querySelector<HTMLElement>(".panels"), target = root.querySelector<HTMLElement>(".pstage");
  if (area && target) {
    const kx = 14, ky = -10;
    let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    const tick = () => {
      cx += (tx - cx) * 0.08; cy += (ty - cy) * 0.08;
      target.style.setProperty("--mx", cx.toFixed(2) + "deg");
      target.style.setProperty("--my", cy.toFixed(2) + "deg");
      raf = Math.abs(tx - cx) > 0.01 || Math.abs(ty - cy) > 0.01 ? requestAnimationFrame(tick) : 0;
    };
    const go = () => { if (!raf) raf = requestAnimationFrame(tick); };
    listen(area, "pointermove", (e) => {
      if (e.pointerType === "touch") return;
      const b = area.getBoundingClientRect();
      tx = ((e.clientX - b.left) / b.width - 0.5) * kx;
      ty = ((e.clientY - b.top) / b.height - 0.5) * ky;
      go();
    });
    listen(area, "pointerleave", () => { tx = 0; ty = 0; go(); });
    undo.push(() => { if (raf) cancelAnimationFrame(raf); });
  }

  // Feature panels tilt toward the pointer; the hologram shifts more (higher Z plane). Mouse only.
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    root.querySelectorAll<HTMLElement>(".feat").forEach((el) => {
      const fp = el.querySelector<HTMLElement>(".fp");
      if (!fp) return;
      listen(el, "pointermove", (e) => {
        if (e.pointerType !== "mouse") return;
        const b = el.getBoundingClientRect(), nx = (e.clientX - b.left) / b.width - 0.5, ny = (e.clientY - b.top) / b.height - 0.5;
        fp.style.setProperty("--ry", (nx * 12).toFixed(2) + "deg"); fp.style.setProperty("--rx", (ny * -12).toFixed(2) + "deg");
        fp.style.setProperty("--px", (nx * 16).toFixed(1) + "px"); fp.style.setProperty("--py", (ny * 12).toFixed(1) + "px");
      });
      listen(el, "pointerleave", () => {
        ["--rx", "--ry"].forEach((k) => fp.style.setProperty(k, "0deg"));
        ["--px", "--py"].forEach((k) => fp.style.setProperty(k, "0px"));
      });
    });
  }

  // Depth reveal: content is visible at rest; entering the viewport only adds a short 3D settle.
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
  }, { rootMargin: "0px 0px -8% 0px" });
  const vh = window.innerHeight;
  root.querySelectorAll(".reveal").forEach((el) => { if (el.getBoundingClientRect().top > vh) io.observe(el); });
  undo.push(() => io.disconnect());

  return () => undo.forEach((f) => f());
}
