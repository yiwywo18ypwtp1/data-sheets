"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js (pages and static files for offline use). Production builds only:
 * in development a cached page or chunk would fight hot reloading.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return null;
}
