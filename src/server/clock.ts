import "server-only";

/** Server "now". `MOCK_NOW` pins it, so TODAY() and "within last N days" are reproducible. */
export function now(): Date {
  const mocked = process.env.MOCK_NOW;
  return mocked ? new Date(mocked) : new Date();
}
