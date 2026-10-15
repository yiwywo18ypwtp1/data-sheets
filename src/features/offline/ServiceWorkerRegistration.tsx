"use client";

import { useEffect } from "react";
import { setActingUser } from "@/features/grid/api";
import { forgetOtherUsers } from "./windowCache";

/**
 * Ties this device's offline data to the signed-in user, and registers /sw.js (pages and
 * static files for offline use). Rendered by the app layout with the cookie's user:
 * - writes name that user (`x-acting-user`), so a page left open across a user switch
 *   can't save under the new user's name;
 * - row copies made for other users are removed from IndexedDB;
 * - the service worker is told who is current: it keeps pages per user and serves offline
 *   only the current user's, dropping the others'.
 * The worker is registered by production builds only: in development a cached page or
 * chunk would fight hot reloading.
 */
export function ServiceWorkerRegistration({ userId }: { userId: string }) {
  useEffect(() => {
    setActingUser(userId);
    void forgetOtherUsers(userId);
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const tell = (worker: ServiceWorker | null | undefined) => worker?.postMessage({ type: "user", userId });
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => tell(registration.active))
      .catch(() => undefined);
    // A page opened while another worker version takes over tells the new one, too.
    const onControllerChange = () => tell(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, [userId]);
  return null;
}
