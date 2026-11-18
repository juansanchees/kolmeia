"use client";

import { useEffect, useRef } from "react";
import { initFeatures, type HoloLabels } from "./fx/features";
import { initHero } from "./fx/hero";
import { initMotion } from "./fx/motion";

/** Starts the landing's canvas holograms, tilt and scroll effects once the server-rendered page is in the browser. Renders nothing. */
export function LandingFx({ labels }: { labels: HoloLabels }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const { tiers, roles, langs } = labels;
  useEffect(() => {
    const root = anchor.current?.closest<HTMLElement>(".lp");
    if (!root) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stops = [initHero(root, reduce), initFeatures(root, reduce, { tiers, roles, langs }), initMotion(root, reduce)];
    return () => stops.forEach((stop) => stop());
  }, [tiers, roles, langs]);
  return <span ref={anchor} hidden />;
}
