"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-reads the server data of the current page every `seconds` (read-only screens of runs the cron drives). */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
