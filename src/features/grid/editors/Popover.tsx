import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * A panel under a cell, rendered into document.body with fixed positioning: cells
 * clip their content (overflow: hidden), so a dropdown inside one would be cut off.
 * It follows the cell while the grid scrolls.
 *
 * The anchor must be rendered before the popover as a sibling (not be its parent),
 * so its ref is already attached when the popover measures it.
 */
export function Popover({ anchor, children, className = "" }: { anchor: RefObject<HTMLElement | null>; children: ReactNode; className?: string }) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    const update = () => setRect(anchor.current?.getBoundingClientRect() ?? null);
    update();
    // Capture phase: scrolls of the grid (not just the window) move the anchor.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchor]);

  if (!rect) return null;
  const width = Math.max(rect.width, 220);
  // Keep the panel on screen next to the right edge of the window.
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  return createPortal(
    <div
      className={`fixed z-50 rounded-md border border-zinc-200 bg-white text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900 ${className}`}
      style={{ top: rect.bottom + 2, left, minWidth: width }}
    >
      {children}
    </div>,
    document.body,
  );
}
