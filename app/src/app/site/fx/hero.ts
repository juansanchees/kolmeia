// Hero hologram: a hive core drawn by hand in 3D on a 2D canvas, plus HUD callout cards that follow lead nodes.
// Geometry is built once; each frame rotates, projects and batches strokes by alpha. Returns a cleanup function.

type V3 = [number, number, number];

export function initHero(root: HTMLElement, reduce: boolean): () => void {
  const box = root.querySelector<HTMLElement>(".holo");
  const cv = box?.querySelector("canvas");
  const hero = root.querySelector<HTMLElement>(".hero");
  const ctx = cv?.getContext("2d");
  if (!box || !cv || !ctx || !hero) return () => {};
  const cards = Array.from(box.querySelectorAll<HTMLElement>(".co"));
  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, R = 0, cw = 222, ch = 0;
  let inView = true, raf = 0, last = 0;
  const t0 = performance.now();
  const tp = { x: 0, y: 0 }, pp = { x: 0, y: 0 };
  const D = 3.4, NB = 8, TAU = Math.PI * 2;

  // Goldberg-style hex cells: dual of a subdivided icosahedron.
  const ph = (1 + Math.sqrt(5)) / 2;
  const iv: V3[] = [[-1, ph, 0], [1, ph, 0], [-1, -ph, 0], [1, -ph, 0], [0, -1, ph], [0, 1, ph], [0, -1, -ph], [0, 1, -ph], [ph, 0, -1], [ph, 0, 1], [-ph, 0, -1], [-ph, 0, 1]];
  const ifc = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const F = 4;
  const vmap: Record<string, number> = {};
  const verts: V3[] = [];
  const tris: number[][] = [];
  const nrm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const vid = (v: V3) => {
    const k = Math.round(v[0] * 1e4) + "," + Math.round(v[1] * 1e4) + "," + Math.round(v[2] * 1e4);
    if (!(k in vmap)) { vmap[k] = verts.length; verts.push(v); }
    return vmap[k];
  };
  ifc.forEach((f) => {
    const A = iv[f[0]], B = iv[f[1]], C = iv[f[2]];
    const P = (i: number, j: number) => { const a = F - i - j; return vid(nrm([(A[0] * a + B[0] * i + C[0] * j) / F, (A[1] * a + B[1] * i + C[1] * j) / F, (A[2] * a + B[2] * i + C[2] * j) / F])); };
    for (let i = 0; i < F; i++) for (let j = 0; j < F - i; j++) {
      tris.push([P(i, j), P(i + 1, j), P(i, j + 1)]);
      if (j < F - i - 1) tris.push([P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]);
    }
  });
  const cen = tris.map((t) => { const a = verts[t[0]], b = verts[t[1]], c = verts[t[2]]; return nrm([a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]]); });
  const emap: Record<string, number[]> = {};
  tris.forEach((t, ti) => {
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3], key = a < b ? a + "_" + b : b + "_" + a;
      (emap[key] = emap[key] || []).push(ti);
    }
  });
  const SEG = 4;
  const edges: V3[][] = [];
  Object.keys(emap).forEach((k) => { if (emap[k].length === 2) edges.push([cen[emap[k][0]], cen[emap[k][1]]]); });
  const NP = edges.length * (SEG + 1);
  const P0 = new Float32Array(NP * 3), sx = new Float32Array(NP), sy = new Float32Array(NP), sz = new Float32Array(NP);
  edges.forEach((e, ei) => {
    for (let k = 0; k <= SEG; k++) {
      const u = k / SEG, v = nrm([e[0][0] * (1 - u) + e[1][0] * u, e[0][1] * (1 - u) + e[1][1] * u, e[0][2] * (1 - u) + e[1][2] * u]), o = (ei * (SEG + 1) + k) * 3;
      P0[o] = v[0]; P0[o + 1] = v[1]; P0[o + 2] = v[2];
    }
  });

  // Rings, spokes, particles, lead nodes.
  const rings = [{ r: 1.12, tx: 1.2, tz: 0.3, sp: 0.3 }, { r: 1.22, tx: 0.45, tz: -0.9, sp: -0.2 }, { r: 1.06, tx: 1.5, tz: 0.9, sp: 0.14 }];
  const spokes: V3[] = [];
  for (let i = 0; i < 7; i++) { const sa = i * 2.399, sy2 = 1 - 2 * (i + 0.5) / 7, sr = Math.sqrt(1 - sy2 * sy2); spokes.push([Math.cos(sa) * sr, sy2, Math.sin(sa) * sr]); }
  const parts: { lon: number; lat: number; r: number; sp: number; st: boolean }[] = [];
  for (let i = 0; i < 380; i++) parts.push({ lon: Math.random() * TAU, lat: Math.asin(Math.random() * 2 - 1), r: 1 + (Math.random() - 0.35) * 0.22, sp: (Math.random() < 0.5 ? -1 : 1) * (0.08 + Math.random() * 0.35), st: i % 6 === 0 });
  const sph = (lon: number, lat: number): V3 => [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
  const nodes = [sph(0.55, 0.5), sph(1.0, -0.4), sph(-0.8, -0.45), sph(3.2, 0.2)];
  const npos = nodes.map(() => ({ x: 0, y: 0, z: 0, f: 0 }));
  const cpos = cards.map(() => ({ x: 0, y: 0, init: false }));

  let cY = 1, sY = 0, cP = 1, sP = 0, rx = 0, ry = 0, rz = 0;
  const rot = (x: number, y: number, z: number) => { const x1 = x * cY + z * sY, z1 = -x * sY + z * cY; ry = y * cP - z1 * sP; rz = y * sP + z1 * cP; rx = x1; };
  const pj = (k: number) => { const s = D / (D - rz); sx[k] = cx + rx * R * s; sy[k] = cy - ry * R * s; sz[k] = rz; };

  const bk: number[][] = [];
  for (let bi = 0; bi < NB; bi++) bk.push([]);
  const put = (ax: number, ay: number, bx: number, by: number, a: number) => { if (a <= 0) return; bk[Math.min(NB - 1, Math.floor(a * NB))].push(ax, ay, bx, by); };
  const flush = (lw: number, mul: number, minB: number) => {
    ctx.lineWidth = lw;
    for (let b = minB || 0; b < NB; b++) {
      const q = bk[b]; if (!q.length) continue;
      const k = b / (NB - 1);
      ctx.strokeStyle = "rgba(" + Math.round(245 + 10 * k) + "," + Math.round(164 + 47 * k) + "," + Math.round(107 * k) + "," + (((b + 0.5) / NB) * mul).toFixed(3) + ")";
      ctx.beginPath();
      for (let j = 0; j < q.length; j += 4) { ctx.moveTo(q[j], q[j + 1]); ctx.lineTo(q[j + 2], q[j + 3]); }
      ctx.stroke();
    }
  };
  const clr = () => { for (let b = 0; b < NB; b++) bk[b].length = 0; };
  const dep = (z: number, zr: number) => Math.max(0, Math.min(1, (z + zr) / (2 * zr)));

  function frame(now: number, still: boolean) {
    const t = still ? 1.2 : (now - t0) / 1000, dt = still ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    pp.x += (tp.x - pp.x) * 0.06; pp.y += (tp.y - pp.y) * 0.06;
    const yaw = t * 0.14 + pp.x, pitch = 0.3 + pp.y;
    cY = Math.cos(yaw); sY = Math.sin(yaw); cP = Math.cos(pitch); sP = Math.sin(pitch);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0); ctx!.clearRect(0, 0, W, H);
    ctx!.globalCompositeOperation = "lighter"; ctx!.lineCap = "round";
    const c = ctx!;
    let g: CanvasGradient;
    // outer halo
    g = c.createRadialGradient(cx, cy, R * 0.6, cx, cy, Math.min(R * 1.5, Math.min(W, H) / 2));
    g.addColorStop(0, "rgba(245,164,0,.16)"); g.addColorStop(1, "rgba(245,164,0,0)");
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    // hex shell
    for (let k = 0; k < NP; k++) { rot(P0[k * 3], P0[k * 3 + 1], P0[k * 3 + 2]); pj(k); }
    clr();
    for (let e = 0; e < edges.length; e++) for (let j = 0; j < SEG; j++) {
      const a = e * (SEG + 1) + j, b = a + 1, d = dep((sz[a] + sz[b]) / 2, 1);
      put(sx[a], sy[a], sx[b], sy[b], 0.1 + 0.8 * Math.pow(d, 1.4));
    }
    flush(3.4, 0.16, 5); flush(1, 1, 0);
    // rings
    clr();
    rings.forEach((rg, ri) => {
      const ctx1 = Math.cos(rg.tx), stx = Math.sin(rg.tx), ctz = Math.cos(rg.tz), stz = Math.sin(rg.tz), ph0 = rg.sp * t, N = 110;
      const rp = (an: number, rr: number): V3 => {
        const lx = Math.cos(an) * rr, lz = Math.sin(an) * rr, y1 = -lz * stx, z1 = lz * ctx1, x2 = lx * ctz - y1 * stz, y2 = lx * stz + y1 * ctz;
        rot(x2, y2, z1); const s = D / (D - rz); return [cx + rx * R * s, cy - ry * R * s, rz];
      };
      let prev = rp(0, rg.r);
      const base = ri === 1 ? 0.4 : 0.3;
      for (let j = 1; j <= N; j++) {
        const an = j / N * TAU, cur = rp(an, rg.r);
        const arc = (((an - ph0 * 2) % TAU) + TAU) % TAU < (ri === 0 ? 1.3 : 0.8) ? 3 : 1;
        put(prev[0], prev[1], cur[0], cur[1], Math.min(0.95, base * 0.35 * arc + 0.2 * dep((prev[2] + cur[2]) / 2, 1.3)));
        prev = cur;
      }
      for (let j = 0; j < 72; j++) {
        const an = j / 72 * TAU + ph0, long = j % 6 === 0, p1 = rp(an, rg.r), p2 = rp(an, rg.r * (long ? 1.07 : 1.035));
        put(p1[0], p1[1], p2[0], p2[1], 0.12 + 0.6 * dep(p1[2], 1.3));
      }
    });
    // spokes
    spokes.forEach((v) => {
      rot(v[0], v[1], v[2]); const s = D / (D - rz);
      put(cx, cy, cx + rx * R * 0.98 * s, cy - ry * R * 0.98 * s, 0.08 + 0.16 * dep(rz, 1));
    });
    flush(1, 1, 0);
    // streaking particles on meridians + dots
    clr();
    const dots: number[][] = [[], [], []];
    parts.forEach((p) => {
      p.lon += p.sp * dt;
      const cl = Math.cos(p.lat); rot(cl * Math.sin(p.lon) * p.r, Math.sin(p.lat) * p.r, cl * Math.cos(p.lon) * p.r);
      const s = D / (D - rz), x = cx + rx * R * s, y = cy - ry * R * s, d = dep(rz, 1.1);
      if (p.st) {
        const l2 = p.lon - p.sp * 0.9; rot(cl * Math.sin(l2) * p.r, Math.sin(p.lat) * p.r, cl * Math.cos(l2) * p.r);
        const s2 = D / (D - rz); put(x, y, cx + rx * R * s2, cy - ry * R * s2, 0.15 + 0.6 * d);
      } else dots[d > 0.66 ? 2 : d > 0.35 ? 1 : 0].push(x, y);
    });
    flush(1.2, 1, 0);
    [0.28, 0.6, 0.95].forEach((al, di) => {
      c.fillStyle = "rgba(255,211,107," + al + ")"; const q = dots[di], sz2 = di === 2 ? 2 : 1.4;
      for (let j = 0; j < q.length; j += 2) c.fillRect(q[j] - sz2 / 2, q[j + 1] - sz2 / 2, sz2, sz2);
    });
    // core
    g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.55);
    g.addColorStop(0, "rgba(255,244,205,.95)"); g.addColorStop(0.18, "rgba(255,211,107,.6)"); g.addColorStop(0.5, "rgba(245,164,0,.18)"); g.addColorStop(1, "rgba(245,164,0,0)");
    c.fillStyle = g; c.fillRect(cx - R, cy - R, R * 2, R * 2);
    // lead nodes
    nodes.forEach((v, ni) => {
      rot(v[0], v[1], v[2]); const s = D / (D - rz), x = cx + rx * R * s, y = cy - ry * R * s, fr = Math.max(0, Math.min(1, (rz - 0.02) / 0.35)), al = 0.25 + 0.75 * fr;
      npos[ni].x = x; npos[ni].y = y; npos[ni].z = rz; npos[ni].f = fr;
      const pz = (t * 0.6 + ni * 0.31) % 1, gg = c.createRadialGradient(x, y, 0, x, y, 16);
      gg.addColorStop(0, "rgba(255,244,205," + al + ")"); gg.addColorStop(0.3, "rgba(255,211,107," + (al * 0.6) + ")"); gg.addColorStop(1, "rgba(245,164,0,0)");
      c.fillStyle = gg; c.fillRect(x - 16, y - 16, 32, 32);
      c.strokeStyle = "rgba(255,211,107," + ((1 - pz) * 0.7 * al).toFixed(3) + ")"; c.lineWidth = 1.2;
      c.beginPath(); c.arc(x, y, 4 + pz * 16, 0, TAU); c.stroke();
    });
    // callouts: follow their node, eased, kept apart; leader line to the node
    const tg = cards.map((_el, ci) => {
      const n = npos[ci], side = n.x >= cx ? 1 : -1;
      let bx = side > 0 ? cx + R * 0.74 : cx - R * 0.74 - cw;
      bx = Math.max(2, Math.min(W - cw - 2, bx));
      return { x: bx, y: Math.max(4, Math.min(H - ch - 4, n.y - ch / 2 - 18)), side, f: n.f };
    });
    for (let j = 0; j < tg.length; j++) for (let k = j + 1; k < tg.length; k++) {
      const A = tg[j], B = tg[k];
      if (A.f < 0.05 || B.f < 0.05) continue;
      if (Math.abs(A.x - B.x) < cw + 6 && Math.abs(A.y - B.y) < ch + 8) { const lo = A.y <= B.y ? B : A, hi = lo === A ? B : A; lo.y = Math.min(H - ch - 4, hi.y + ch + 10); }
    }
    cards.forEach((el, ci) => {
      const cp = cpos[ci], T = tg[ci], fr = still ? 1 : T.f;
      if (!cp.init || still) { cp.x = T.x; cp.y = T.y; cp.init = true; } else { cp.x += (T.x - cp.x) * 0.12; cp.y += (T.y - cp.y) * 0.12; }
      el.style.opacity = fr.toFixed(2); el.style.transform = "translate3d(" + cp.x.toFixed(1) + "px," + cp.y.toFixed(1) + "px,0)";
      if (fr > 0.02 && el.offsetWidth) {
        const ax = T.side > 0 ? cp.x : cp.x + cw, ay = cp.y + ch / 2, n = npos[ci];
        c.strokeStyle = "rgba(245,164,0," + (0.7 * fr).toFixed(3) + ")"; c.lineWidth = 1;
        c.beginPath(); c.moveTo(n.x, n.y); c.lineTo(ax, ay); c.stroke();
      }
    });
    c.globalCompositeOperation = "source-over";
  }

  function size() {
    W = box!.clientWidth; H = box!.clientHeight; dpr = Math.min(2, window.devicePixelRatio || 1);
    cv!.width = Math.round(W * dpr); cv!.height = Math.round(H * dpr);
    cx = W / 2; cy = H / 2; R = Math.min(W, H) * 0.4;
    cards.forEach((c) => { if (c.offsetWidth) { cw = c.offsetWidth; ch = Math.max(ch, c.offsetHeight); } });
    if (reduce || !raf) frame(performance.now(), reduce);
  }
  function loop(now: number) { frame(now, false); raf = requestAnimationFrame(loop); }
  function sync() {
    const run = inView && !document.hidden && !reduce;
    if (run && !raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
    else if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  const ro = new ResizeObserver(size);
  ro.observe(box);
  const io = new IntersectionObserver((en) => { inView = en[0].isIntersecting; sync(); });
  io.observe(box);
  document.addEventListener("visibilitychange", sync);
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const b = box.getBoundingClientRect();
    tp.x = Math.max(-0.5, Math.min(0.5, ((e.clientX - b.left) / b.width - 0.5) * 0.5)); tp.y = Math.max(-0.3, Math.min(0.3, ((e.clientY - b.top) / b.height - 0.5) * 0.3));
  };
  const onLeave = () => { tp.x = 0; tp.y = 0; };
  if (!reduce) { hero.addEventListener("pointermove", onMove); hero.addEventListener("pointerleave", onLeave); }
  size(); sync();

  return () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ro.disconnect();
    io.disconnect();
    document.removeEventListener("visibilitychange", sync);
    hero.removeEventListener("pointermove", onMove);
    hero.removeEventListener("pointerleave", onLeave);
  };
}
