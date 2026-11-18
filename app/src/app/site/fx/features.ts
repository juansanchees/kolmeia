// Feature holograms: one canvas per panel, one shared loop, only panels in view draw. Same gold additive look as the hero.
// Returns a cleanup function.

export type HoloLabels = { tiers: readonly string[]; roles: readonly string[]; langs: readonly string[] };

type Pt = [number, number, number];
type Holo = {
  cv: HTMLCanvasElement; x: CanvasRenderingContext2D; box: HTMLElement; W: number; H: number; dpr: number;
  vis: boolean; hot: number; hov: boolean; draw: (h: Holo, t: number) => void; still: number; off: number;
};

export function initFeatures(root: HTMLElement, reduce: boolean, labels: HoloLabels): () => void {
  const cvs = Array.from(root.querySelectorAll<HTMLCanvasElement>("canvas[data-holo]"));
  if (!cvs.length || !cvs[0].getContext) return () => {};
  const TAU = Math.PI * 2, D = 3.4;
  let X: CanvasRenderingContext2D, cx = 0, cy = 0, S = 1, cY = 1, sY = 0, cP = 1, sP = 0, CW = 1, CH = 1; // CW/CH: canvas size, so glows and labels keep an 8% safety margin
  // Canvas text needs a real family name: take it from the heading the page already renders with next/font.
  let fontFamily = getComputedStyle(root.querySelector("h3") ?? root).fontFamily;
  const spr = document.createElement("canvas");
  spr.width = spr.height = 64;
  {
    const g = spr.getContext("2d")!, r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,244,205,1)"); r.addColorStop(0.25, "rgba(255,211,107,.55)"); r.addColorStop(1, "rgba(245,164,0,0)");
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  }
  const sm = (x: number) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
  const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const lerp = (a: number, b: number, q: number) => a + (b - a) * q;
  const cam = (h: Holo, yaw: number, pitch: number, sc: number, ox: number, oy: number) => {
    cx = h.W / 2 + (ox || 0) * h.W; cy = h.H / 2 + (oy || 0) * h.H; S = Math.min(h.W, h.H) * 0.5 * sc * 0.8; // scale from the short side: the whole drawing, glow included, stays inside
    cY = Math.cos(yaw); sY = Math.sin(yaw); cP = Math.cos(pitch); sP = Math.sin(pitch);
  };
  const pj = (x: number, y: number, z: number): Pt => {
    const x1 = x * cY + z * sY, z1 = -x * sY + z * cY, y2 = y * cP - z1 * sP, z2 = y * sP + z1 * cP, s = D / (D - z2);
    return [cx + x1 * S * s, cy - y2 * S * s, z2];
  };
  const dm = (z: number) => 0.3 + 0.7 * cl((z + 1.3) / 2.6);
  const ln = (a: Pt, b: Pt, al: number, w = 1) => {
    if (al <= 0.01) return;
    X.beginPath(); X.moveTo(a[0], a[1]); X.lineTo(b[0], b[1]);
    if (w > 1.5) { X.strokeStyle = "rgba(255,196,60," + (al * 0.16).toFixed(3) + ")"; X.lineWidth = w * 3.4; X.stroke(); }
    X.strokeStyle = "rgba(255,205,80," + Math.min(1, al).toFixed(3) + ")"; X.lineWidth = w; X.stroke();
  };
  const path = (pts: Pt[], al: number, w: number, close?: boolean) => {
    const n = pts.length - (close ? 0 : 1);
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; ln(a, b, al * dm((a[2] + b[2]) / 2), w); }
  };
  const cir = (x: number, y: number, z: number, r: number, al: number, w: number, n = 48, xy?: boolean) => {
    const pts: Pt[] = [];
    for (let k = 0; k <= n; k++) { const an = k / n * TAU; pts.push(xy ? pj(x + Math.cos(an) * r, y + Math.sin(an) * r, z) : pj(x + Math.cos(an) * r, y, z + Math.sin(an) * r)); }
    path(pts, al, w, false);
  };
  const gl = (p: Pt, r: number, al: number) => {
    r = Math.min(r, p[0] - CW * 0.1, CW * 0.9 - p[0], p[1] - CH * 0.1, CH * 0.9 - p[1]); if (r < 1) return;
    const ga = X.globalAlpha; X.globalAlpha = Math.min(1, al) * ga; X.drawImage(spr, p[0] - r, p[1] - r, r * 2, r * 2); X.globalAlpha = ga;
  };
  const tx = (s: string, x: number, y: number, al: number, sz = 11, align: CanvasTextAlign = "center") => {
    X.font = "600 " + sz + "px " + fontFamily; X.textAlign = align; X.textBaseline = "middle";
    X.fillStyle = "rgba(255,226,150," + Math.min(1, al).toFixed(3) + ")"; X.fillText(s, x, y);
  };
  const sp = (x: number, y: number): Pt => [x, y, 0];

  // Lead com prova: hex prism with four sources orbiting it, a check at the core.
  function dProof(h: Holo, t: number) {
    cam(h, t * 0.4, 0.5, 0.95, 0, -0.03);
    const R = 0.85, hy = 0.5, top: Pt[] = [], bot: Pt[] = [], mid: Pt[] = [], c = pj(0, 0, 0);
    for (let k = 0; k < 6; k++) { const an = k / 6 * TAU + TAU / 12; top.push(pj(Math.cos(an) * R, hy, Math.sin(an) * R)); bot.push(pj(Math.cos(an) * R, -hy, Math.sin(an) * R)); mid.push(pj(Math.cos(an) * R * 0.55, 0, Math.sin(an) * R * 0.55)); }
    path(top, 0.8, 1.4, true); path(bot, 0.8, 1.4, true); path(mid, 0.3, 1, true);
    for (let k = 0; k < 6; k++) { ln(top[k], bot[k], 0.5 * dm((top[k][2] + bot[k][2]) / 2), 1.2); ln(top[k], mid[k], 0.12, 1); ln(bot[k], mid[k], 0.12, 1); }
    const lit = Math.floor(t * 1.1) % 4;
    for (let k = 0; k < 4; k++) {
      const an = t * 0.5 + k * TAU / 4, p = pj(Math.cos(an) * 1.3, 0.15 * Math.sin(an * 2 + k), Math.sin(an) * 1.3), on = k === lit;
      ln(c, p, on ? 0.5 : 0.12, on ? 1.6 : 1); gl(p, on ? 16 : 9, (on ? 1 : 0.35) * dm(p[2]));
    }
    gl(sp(cx, cy), S * 0.6, 0.28);
    const pu = 0.75 + 0.25 * Math.sin(t * 3);
    ln(sp(cx - 0.24 * S, cy + 0.02 * S), sp(cx - 0.07 * S, cy + 0.19 * S), pu, 2.4); ln(sp(cx - 0.07 * S, cy + 0.19 * S), sp(cx + 0.26 * S, cy - 0.2 * S), pu, 2.4);
  }
  // Caçador: tilted radar disc, rotating sweep, blips light up as it passes.
  const blips = [[0.6, 0.55], [2.0, 0.8], [3.1, 0.4], [4.0, 0.7], [5.0, 0.3], [5.7, 0.85]];
  function dRadar(h: Holo, t: number) {
    cam(h, Math.sin(t * 0.3) * 0.2, 0.95, 0.76, 0, 0);
    const a = t * 1.6, o = pj(0, 0, 0);
    [0.33, 0.66, 1].forEach((r, i) => { cir(0, 0, 0, r, i === 2 ? 0.7 : 0.38, i === 2 ? 1.6 : 1, 60); });
    for (let k = 0; k < 8; k++) { const an = k * TAU / 8; ln(o, pj(Math.cos(an), 0, Math.sin(an)), 0.2, 1); }
    for (let k = 0; k < 48; k++) { const an = k / 48 * TAU, r2 = k % 4 === 0 ? 1.08 : 1.035; ln(pj(Math.cos(an), 0, Math.sin(an)), pj(Math.cos(an) * r2, 0, Math.sin(an) * r2), 0.35, 1); }
    for (let i = 0; i < 26; i++) { const aa = a - i * 0.035; ln(o, pj(Math.cos(aa), 0, Math.sin(aa)), 0.55 * Math.pow(1 - i / 26, 1.6), i === 0 ? 2 : 2.2); }
    blips.forEach((b) => {
      const d = (((a - b[0]) % TAU) + TAU) % TAU, lit = Math.max(0.15, Math.exp(-d * 1.1)), x = Math.cos(b[0]) * b[1], z = Math.sin(b[0]) * b[1], p = pj(x, 0, z), p2 = pj(x, 0.22 * (0.4 + lit), z);
      ln(p, p2, 0.15 + 0.5 * lit, 1); gl(p2, 6 + 11 * lit, (0.25 + 0.75 * lit) * dm(p2[2]));
      if (lit > 0.75) cir(x, 0, z, 0.05 + (1 - lit) * 1.2, (lit - 0.75) * 2.4, 1, 20);
    });
  }
  // Qualificador: three tier rings, a level that rises through the three tiers.
  function dGauge(h: Holo, t: number) {
    cam(h, t * 0.3, 0.38, 0.72, -0.14, 0.02);
    const u = (t % 6) / 6, L = u < 0.6 ? sm(u / 0.6) : u < 0.85 ? 1 : 1 - sm((u - 0.85) / 0.15), ys = [-0.62, 0, 0.62], rs = [0.48, 0.74, 1], yy = -0.62 + L * 1.24, rr = 0.48 + L * 0.52;
    for (let k = 0; k < 6; k++) { const an = k * TAU / 6 + 0.3, c = Math.cos(an), s = Math.sin(an); ln(pj(c * 0.48, -0.62, s * 0.48), pj(c * 0.74, 0, s * 0.74), 0.18, 1); ln(pj(c * 0.74, 0, s * 0.74), pj(c, 0.62, s), 0.18, 1); }
    ys.forEach((yv, j) => { const on = yy >= yv - 0.02; cir(0, yv, 0, rs[j], on ? 0.9 : 0.3, on ? 1.8 : 1, 56); });
    for (let y = -0.62; y < yy; y += 0.1) cir(0, y, 0, lerp(0.48, 1, (y + 0.62) / 1.24), 0.1, 1, 36);
    ln(pj(0, -0.75, 0), pj(0, 0.75, 0), 0.25, 1);
    cir(0, yy, 0, rr, 0.85, 2, 56);
    for (let k = 0; k < 6; k++) { const an = k * TAU / 6; ln(pj(0, yy, 0), pj(Math.cos(an) * rr, yy, Math.sin(an) * rr), 0.3, 1); }
    gl(pj(0, yy, 0), 16, 0.9);
    ys.forEach((yv, j) => {
      const p = pj(rs[j], yv, 0), on = yy >= yv - 0.02;
      const lx = h.W * 0.9, ex = Math.max(p[0] + 6, lx - 70); ln(p, sp(ex, p[1]), on ? 0.45 : 0.14, 1); tx(labels.tiers[j] ?? "", lx, p[1], on ? 1 : 0.5, 11, "right");
    });
  }
  // Fila do dia: cards stacked in depth; the top one slides away, the rest step forward.
  function dQueue(h: Holo, t: number) {
    cam(h, -0.5, 0.16, 0.88, 0.04, 0.02);
    const N = 5, f = t / 2.4, st = Math.floor(f), u = f - st, fp = st + sm((u - 0.2) / 0.65);
    for (let k = 0; k < N; k++) {
      const s = (((k - fp + 1) % N) + N) % N - 1;
      let x = 0, y: number, z: number, al: number;
      if (s < 0) { const e = -s; x = -e * Math.min(1.9, 0.36 * h.W / S - 0.72); /* slide distance fits the canvas width */ y = 0.35 * e; z = 0.45 + e * 0.25; al = 1 - e; }
      else { z = 0.45 - s * 0.3; y = s * 0.06 - 0.04; al = 1 - s / N * 0.75; if (s > N - 2) al *= Math.max(0, N - 1 - s); }
      const hw = 0.72, hh = 0.44;
      path([pj(x - hw, y + hh, z), pj(x + hw, y + hh, z), pj(x + hw, y - hh, z), pj(x - hw, y - hh, z)], al * 0.9, s < 0.5 ? 1.6 : 1.1, true);
      const da = al * (s < 0 ? 1 : Math.max(0, 1 - s * 0.6));
      if (da > 0.05) {
        ln(pj(x - 0.5, y + 0.22, z), pj(x + 0.05, y + 0.22, z), da * 0.8, 2); ln(pj(x - 0.5, y + 0.04, z), pj(x + 0.35, y + 0.04, z), da * 0.4, 1.2); ln(pj(x - 0.5, y - 0.12, z), pj(x + 0.15, y - 0.12, z), da * 0.4, 1.2);
        path([pj(x + 0.28, y - 0.34, z), pj(x + 0.6, y - 0.34, z), pj(x + 0.6, y - 0.18, z), pj(x + 0.28, y - 0.18, z)], da * 0.7, 1, true);
      }
    }
  }
  // Campanhas: three steps on a path, a pulse travels 1 > 2 > 3 and stops.
  const cn: Pt[] = [[-1, -0.12, 0.25], [0, 0.24, -0.2], [1, -0.12, 0.25]];
  const cpt = (j: number, q: number): Pt => { const a = cn[j], b = cn[j + 1]; return [lerp(a[0], b[0], q), lerp(a[1], b[1], q) + 0.14 * Math.sin(q * Math.PI), lerp(a[2], b[2], q)]; };
  function dCamp(h: Holo, t: number) {
    cam(h, Math.sin(t * 0.4) * 0.35, 0.5, 0.68, 0, -0.02);
    const u = (t % 5) / 5, p = u < 0.6 ? u / 0.6 * 2 : 2, fade = u > 0.88 ? 1 - sm((u - 0.88) / 0.12) : 1;
    for (let i = -2; i <= 2; i++) { ln(pj(i * 0.5, -0.55, -1), pj(i * 0.5, -0.55, 1), 0.08, 1); ln(pj(-1.25, -0.55, i * 0.5), pj(1.25, -0.55, i * 0.5), 0.08, 1); }
    for (let j = 0; j < 2; j++) {
      const pr = cl(p - j) * fade;
      let prev: Pt | null = null;
      for (let q = 0; q <= 16; q++) {
        const c3 = cpt(j, q / 16), pp = pj(c3[0], c3[1], c3[2]);
        if (prev) ln(prev, pp, (q / 16 <= pr ? 0.85 : 0.2) * dm(pp[2]), q / 16 <= pr ? 1.7 : 1);
        prev = pp;
      }
    }
    for (let k = 0; k < 3; k++) {
      const n = cn[k], lit = (p >= k ? 1 : cl((p - (k - 0.25)) / 0.25)) * fade, c = pj(n[0], n[1], n[2]);
      cir(n[0], n[1], n[2], 0.24, 0.35 + 0.6 * lit, 1 + lit, 6, true); cir(n[0], n[1], n[2], 0.13, 0.15 + 0.5 * lit, 1, 6, true);
      gl(c, 7 + 17 * lit, (0.2 + 0.8 * lit) * dm(c[2]));
      tx(String(k + 1), c[0], c[1] + 0.5, 0.55 + 0.45 * lit, 13);
    }
    if (p < 2) { const j = Math.floor(p), hd = cpt(j, p - j); gl(pj(hd[0], hd[1], hd[2]), 15, 1); }
    else if (fade > 0.05) { const n3 = cn[2], rp = (t * 1.2) % 1; cir(n3[0], n3[1], n3[2], 0.24 + rp * 0.32, (1 - rp) * 0.6 * fade, 1, 6, true); }
  }
  // Equipe: three roles orbit a core and stay linked to it.
  function dTeam(h: Holo, t: number) {
    cam(h, t * 0.25, 0.62, 1, 0, -0.02);
    const c = pj(0, 0, 0), p3: Pt[] = [], pts: Pt[] = [];
    cir(0, 0, 0, 0.85, 0.22, 1, 64); cir(0, 0, 0, 0.22, 0.9, 1.8, 6); cir(0, 0, 0, 0.32, 0.3, 1, 6);
    for (let k = 0; k < 3; k++) { const an = t * 0.6 + k * TAU / 3, q: Pt = [Math.cos(an) * 0.85, 0.22 * Math.sin(an + k), Math.sin(an) * 0.85]; p3.push(q); pts.push(pj(q[0], q[1], q[2])); }
    for (let k = 0; k < 3; k++) {
      ln(c, pts[k], 0.35 + 0.25 * Math.sin(t * 2 + k), 1.2); ln(pts[k], pts[(k + 1) % 3], 0.18, 1);
      const u = (t * 0.7 + k * 0.33) % 1; gl(sp(lerp(c[0], pts[k][0], u), lerp(c[1], pts[k][1], u)), 8, 0.9);
    }
    gl(c, 24, 0.9);
    for (let k = 0; k < 3; k++) {
      const d = dm(pts[k][2]); cir(p3[k][0], p3[k][1], p3[k][2], 0.1, 0.9, 1.4, 6, true); gl(pts[k], 15, 0.9 * d);
      tx(labels.roles[k] ?? "", pts[k][0], pts[k][1] - 17, d, 11);
    }
  }
  // PT e EN: wireframe globe, two language chips taking turns.
  function dLang(h: Holo, t: number) {
    cam(h, t * 0.45, 0.34, 0.8, -0.12, -0.02);
    const ph = (t / 2.2) % 1, act = Math.floor(t / 2.2) % 2, w = sm(ph * 6);
    [-60, -30, 0, 30, 60].forEach((d) => { const la = d * Math.PI / 180; cir(0, Math.sin(la), 0, Math.cos(la), d === 0 ? 0.6 : 0.28, d === 0 ? 1.5 : 1, 48); });
    for (let k = 0; k < 6; k++) {
      const lo = k * Math.PI / 6, pts: Pt[] = [];
      for (let i = 0; i <= 48; i++) { const an = i / 48 * TAU; pts.push(pj(Math.cos(an) * Math.cos(lo), Math.sin(an), Math.cos(an) * Math.sin(lo))); }
      path(pts, 0.3, 1);
    }
    X.strokeStyle = "rgba(255,205,80,.5)"; X.lineWidth = 1.4; X.beginPath(); X.arc(cx, cy, S * D / Math.sqrt(D * D - 1), 0, TAU); X.stroke();
    gl(sp(cx, cy), S * 1.3, 0.2);
    ([[labels.langs[0] ?? "PT", -0.38], [labels.langs[1] ?? "EN", 0.38]] as [string, number][]).forEach((c, j) => {
      const x = cx + S * 1.5, y = cy + c[1] * S, a = j === act ? 0.3 + 0.7 * w : 0.3 + 0.7 * (1 - w), hw = 22, hh = 12;
      path([sp(x - hw, y - hh), sp(x + hw, y - hh), sp(x + hw, y + hh), sp(x - hw, y + hh)], a, 1.2, true);
      gl(sp(x, y), 28, a * 0.5); tx(c[0], x, y + 0.5, a, 13);
      if (j === act) ln(sp(cx + S * 1.05, cy), sp(x - hw, y), a * 0.6, 1);
    });
  }

  const list: Holo[] = [];
  let raf = 0;
  const t0 = performance.now();
  const draws: Record<string, [Holo["draw"], number]> = { proof: [dProof, 1.5], radar: [dRadar, 2.3], gauge: [dGauge, 3.4], queue: [dQueue, 1.0], camp: [dCamp, 3.2], team: [dTeam, 1.0], lang: [dLang, 0.5] };
  function frame(h: Holo, t: number) {
    X = h.x; const d = h.dpr; CW = h.W; CH = h.H;
    X.setTransform(d, 0, 0, d, 0, 0); X.clearRect(0, 0, h.W, h.H);
    X.globalCompositeOperation = "lighter"; X.lineCap = "round"; X.lineJoin = "round"; X.globalAlpha = 0.86 + 0.14 * h.hot;
    h.draw(h, t);
    const by = h.H * 0.88 - S * 0.13; X.strokeStyle = "rgba(255,200,70,.3)"; X.lineWidth = 1; X.beginPath(); X.ellipse(cx, by, S * 0.85, S * 0.13, 0, 0, TAU); X.stroke();
    X.strokeStyle = "rgba(255,200,70,.16)"; X.beginPath(); X.ellipse(cx, by, S * 0.55, S * 0.085, 0, 0, TAU); X.stroke();
    gl(sp(cx, cy), S * 1.5, 0.18);
    X.globalAlpha = 1; X.globalCompositeOperation = "source-over";
  }
  function loop(now: number) {
    const t = (now - t0) / 1000;
    let any = false;
    list.forEach((h) => { if (!h.vis) return; any = true; h.hot += ((h.hov ? 1 : 0) - h.hot) * 0.1; frame(h, t + h.off); });
    raf = any ? requestAnimationFrame(loop) : 0;
  }
  function sync() {
    const run = !document.hidden && !reduce && list.some((h) => h.vis);
    if (run && !raf) raf = requestAnimationFrame(loop);
    else if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  const still = (h: Holo) => frame(h, h.still);
  const undo: (() => void)[] = [];
  cvs.forEach((cv, i) => {
    const d = draws[cv.getAttribute("data-holo") ?? ""];
    const x = cv.getContext("2d");
    if (!d || !x) return;
    const h: Holo = { cv, x, box: cv.parentElement as HTMLElement, W: 0, H: 0, dpr: 1, vis: false, hot: 0, hov: false, draw: d[0], still: d[1], off: i * 1.7 };
    list.push(h);
    const size = () => {
      h.W = h.box.clientWidth; h.H = h.box.clientHeight; if (!h.W || !h.H) return;
      h.dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = Math.round(h.W * h.dpr); cv.height = Math.round(h.H * h.dpr); still(h);
    };
    const ro = new ResizeObserver(size);
    ro.observe(h.box);
    const io = new IntersectionObserver((en) => { h.vis = en[0].isIntersecting; sync(); }, { rootMargin: "80px" });
    io.observe(h.box);
    const art = cv.closest(".feat");
    const on = () => { h.hov = true; }, off = () => { h.hov = false; };
    const evs: [string, () => void][] = [["pointerenter", on], ["pointerleave", off], ["focusin", on], ["focusout", off]];
    evs.forEach(([n, f]) => art?.addEventListener(n, f));
    undo.push(() => { ro.disconnect(); io.disconnect(); evs.forEach(([n, f]) => art?.removeEventListener(n, f)); });
  });
  document.addEventListener("visibilitychange", sync);
  let dead = false;
  // Redraw once the web fonts are in, so canvas labels use them.
  document.fonts?.ready.then(() => {
    if (dead) return;
    fontFamily = getComputedStyle(root.querySelector("h3") ?? root).fontFamily;
    list.forEach((h) => { if (h.W && !raf) still(h); });
  });
  sync();

  return () => {
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    document.removeEventListener("visibilitychange", sync);
    undo.forEach((f) => f());
  };
}
