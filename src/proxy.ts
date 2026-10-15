import { NextResponse, type NextRequest } from "next/server";
import { resolveUserId, USER_COOKIE } from "@/server/auth";
import { getBase, getFirstBaseId, getView } from "@/server/tables";

/**
 * Real status codes for base/table/view URLs. The pages stream (their loading.tsx is the
 * first thing sent), and a streamed response is already committed to 200: a `notFound()`
 * in the page arrives as a 404 page with status 200, a `redirect()` as a client-side
 * redirect. These id checks are a few primary-key lookups, so they run here, before
 * rendering starts. The pages keep their own checks; this only fixes the status.
 */
export function proxy(request: NextRequest) {
  const response = route(request);
  // The service worker files a page under the user it was rendered for (public/sw.js).
  if (!request.nextUrl.pathname.startsWith("/f/")) response.headers.set("x-ds-user", resolveUserId(request.cookies.get(USER_COOKIE)?.value));
  return response;
}

function route(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // A public form: the view must exist and be a form.
  if (pathname.startsWith("/f/")) {
    const form = getView(pathname.split("/")[2] ?? "");
    return form?.view.kind === "form" ? NextResponse.next() : notFound(request);
  }
  // `/` opens the first base, like `/b/<baseId>`; with no bases at all the home page says so.
  const firstBaseId = pathname === "/" ? getFirstBaseId() : null;
  if (pathname === "/" && !firstBaseId) return NextResponse.next();
  const [, baseId, tableId, viewId] = firstBaseId ? ["b", firstBaseId] : pathname.split("/").filter(Boolean);

  const base = getBase(baseId);
  if (!base) return notFound(request);

  const table = tableId === undefined ? base.tables[0] : base.tables.find((candidate) => candidate.id === tableId);
  if (!table) return notFound(request);
  if (viewId === "import") return NextResponse.next(); // the table's CSV import page
  if (viewId === undefined) return NextResponse.redirect(new URL(`/b/${base.id}/${table.id}/${table.defaultViewId}`, request.url), 307);

  const view = getView(viewId);
  if (!view || view.tableId !== table.id) return notFound(request);
  return NextResponse.next();
}

function notFound(request: NextRequest) {
  return NextResponse.rewrite(new URL("/_not-found", request.url), { status: 404 });
}

export const config = {
  // Only the grid page and the redirects above it; deeper paths are left to the router.
  matcher: ["/", "/b/:baseId", "/b/:baseId/:tableId", "/b/:baseId/:tableId/:viewId", "/f/:viewId"],
};
