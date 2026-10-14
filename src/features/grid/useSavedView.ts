import { useRef, useState } from "react";
import type { View } from "@/lib/domain/view";
import { ApiRequestError, saveView } from "./api";

export type SavedView = {
  /** The view as last saved on the server (by anyone, as far as this tab knows). */
  view: View;
  /** Saves part of the view: the column layout or the panel's filter and sorts. */
  save: (patch: Partial<View>) => Promise<View>;
  /** Another user saved the view: later saves build on their version instead of hitting a 412. */
  applyRemote: (view: View, version: number) => void;
};

/**
 * One place that saves the open view, used by the column layout and the view panel.
 * Both send only their part (a patch); saves go out one at a time, each on top of
 * the latest saved version, so the two never race each other into a 412.
 *
 * Concurrency with other users: every save sends the version it's based on (If-Match).
 * If someone else saved meanwhile (412), the patch is re-applied on top of their
 * version and sent again, so their changes to other parts of the view survive.
 */
export function useSavedView(initialView: View, initialVersion: number): SavedView {
  const [view, setView] = useState(initialView);
  const latest = useRef({ view: initialView, version: initialVersion });
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  function save(patch: Partial<View>): Promise<View> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          latest.current = await saveView({ ...latest.current.view, ...patch }, latest.current.version);
          setView(latest.current.view);
          return latest.current.view;
        } catch (cause) {
          const current = cause instanceof ApiRequestError && cause.status === 412 ? (cause.details as { view: View; version: number } | undefined) : undefined;
          if (!current || attempt > 0) throw cause;
          latest.current = current;
        }
      }
    };
    const result = queue.current.then(run, run);
    queue.current = result.catch(() => undefined);
    return result;
  }

  function applyRemote(remote: View, version: number) {
    if (version <= latest.current.version) return;
    latest.current = { view: remote, version };
    setView(remote);
  }

  return { view, save, applyRemote };
}
