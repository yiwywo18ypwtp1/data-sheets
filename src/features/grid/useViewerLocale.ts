import { useSyncExternalStore } from "react";

export type ViewerLocale = { locale: string; timeZone: string };

/** What the server renders with: it can't know the viewer's locale or zone. */
const SERVER_LOCALE: ViewerLocale = { locale: "en-US", timeZone: "UTC" };
let clientLocale: ViewerLocale | null = null;

function getClientLocale(): ViewerLocale {
  clientLocale ??= { locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  return clientLocale;
}

const subscribe = () => () => {};

/**
 * The viewer's locale and time zone. `useSyncExternalStore` with a server snapshot
 * makes hydration use the server's values first and then switch to the browser's,
 * so formatted numbers and dates never cause a hydration mismatch.
 */
export function useViewerLocale(): ViewerLocale {
  return useSyncExternalStore(subscribe, getClientLocale, () => SERVER_LOCALE);
}
