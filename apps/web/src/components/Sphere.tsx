import { useEffect, useRef } from "react";

/**
 * The hero's swarm: a few thousand particles on a sphere that turn slowly, lean towards
 * the pointer, scatter where it passes, and unwind into a ribbon as the page scrolls.
 * Plain 2D canvas: no library, and it stops drawing when it is off screen.
 */
export function Sphere({ count = 3400 }: { count?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const n = window.innerWidth < 700 ? Math.round(count * 0.55) : count;

    // two shapes per particle: a point on a sphere and a point on a twisted ribbon
    const sphere = new Float32Array(n * 3);
    const ribbon = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    const tone = new Uint8Array(n);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const a = i * golden;
      sphere.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
      const t = (i / n) * Math.PI * 2;
      const w = ((i * 7919) % 1000) / 1000 - 0.5;
      const twist = t * 1.5;
      ribbon.set([Math.cos(t) * (1.5 + w * 0.5 * Math.cos(twist)), w * 0.62 * Math.sin(twist) + Math.sin(t * 2) * 0.22, Math.sin(t) * (1.5 + w * 0.5 * Math.cos(twist))], i * 3);
      seed[i] = ((i * 2654435761) % 4096) / 4096;
      tone[i] = i % 11 === 0 ? 2 : i % 4 === 0 ? 1 : 0;
    }
    const colours = ["243,240,232", "233,201,207", "170,181,155"];

    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    const pointer = { x: 0, y: 0, tx: 0, ty: 0, px: -9999, py: -9999, active: 0 };
    const onMove = (e: PointerEvent) => {
      const b = canvas.getBoundingClientRect();
      pointer.tx = (e.clientX - (b.left + b.width / 2)) / b.width;
      pointer.ty = (e.clientY - (b.top + b.height / 2)) / b.height;
      pointer.px = e.clientX - b.left;
      pointer.py = e.clientY - b.top;
      pointer.active = 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(canvas);

    let raf = 0;
    let morph = 0;
    const start = performance.now();
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (!visible) return;
      const t = (now - start) / 1000;
      const target = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * 0.75)));
      morph += (target - morph) * 0.06;
      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;
      pointer.active *= 0.97;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const radius = Math.min(w * 0.36, h * 0.86);
      const cx = w / 2;
      const cy = h * (1.02 - morph * 0.42);
      const ry = t * 0.16 + pointer.x * 1.1;
      const rx = -0.32 + pointer.y * 0.7 + morph * 0.55;
      const cosY = Math.cos(ry);
      const sinY = Math.sin(ry);
      const cosX = Math.cos(rx);
      const sinX = Math.sin(rx);
      const ease = morph * morph * (3 - 2 * morph);

      for (let i = 0; i < n; i++) {
        const j = i * 3;
        const s = seed[i]!;
        // breathing: each particle rides its own slow wave off the surface
        const swell = 1 + Math.sin(t * 0.9 + s * 40) * 0.035;
        let x = (sphere[j]! * (1 - ease) + ribbon[j]! * ease) * swell;
        let y = (sphere[j + 1]! * (1 - ease) + ribbon[j + 1]! * ease) * swell;
        let z = (sphere[j + 2]! * (1 - ease) + ribbon[j + 2]! * ease) * swell;
        const x1 = x * cosY + z * sinY;
        z = -x * sinY + z * cosY;
        x = x1;
        const y1 = y * cosX - z * sinX;
        z = y * sinX + z * cosX;
        y = y1;
        const depth = 2.6 / (2.6 - z);
        let sx = cx + x * radius * depth;
        let sy = cy + y * radius * depth;
        // the pointer pushes nearby particles aside
        const dx = sx - pointer.px;
        const dy = sy - pointer.py;
        const d2 = dx * dx + dy * dy;
        if (d2 < 16_000 && pointer.active > 0.02) {
          const f = (1 - d2 / 16_000) * 26 * pointer.active;
          const d = Math.sqrt(d2) || 1;
          sx += (dx / d) * f;
          sy += (dy / d) * f;
        }
        const alpha = Math.max(0.06, Math.min(0.95, (z + 1.25) * 0.42));
        const size = (0.7 + s * 1.3) * depth;
        ctx.fillStyle = `rgba(${colours[tone[i]!]},${alpha.toFixed(3)})`;
        ctx.fillRect(sx, sy, size, size);
      }
    };
    if (reduce) draw(start);
    else raf = requestAnimationFrame(draw);
    if (reduce) cancelAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
    };
  }, [count]);

  return <canvas ref={ref} aria-hidden="true" />;
}
