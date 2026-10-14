import { useEffect, useRef, type RefObject } from "react";

/** Calls `handler` when the pointer goes down outside all `refs` (clicking elsewhere ends editing). */
export function useOutsidePointerDown(refs: RefObject<HTMLElement | null>[], handler: () => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (refs.some((ref) => ref.current?.contains(event.target as Node))) return;
      latest.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
    // The refs are stable objects; the handler is read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
