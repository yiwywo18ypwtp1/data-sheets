import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

/** Component tests (`// @vitest-environment jsdom`) unmount what they rendered after each test. */
afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
