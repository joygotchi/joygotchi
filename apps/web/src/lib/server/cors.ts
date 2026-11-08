/**
 * Who may call the AI endpoints from a browser.
 *
 * The desktop app is a webview, so its `fetch` carries an `Origin` and is
 * subject to CORS like any page. Nothing here sent the headers and `OPTIONS`
 * answered 405, which means the pet's speech bubble has never once reached
 * this server from the app — `react()` catches the failure and shrugs, so it
 * looked like a model with nothing to say.
 *
 * Not `*`. These endpoints spend NEAR AI credits on every call and take no
 * authentication, so an open door is an open tab on somebody's bill. The
 * list is the app, the gallery, and a dev server.
 */
const ALLOWED = [
  // Tauri's webview origin, which differs by platform.
  /^tauri:\/\/localhost$/,
  /^https?:\/\/tauri\.localhost$/,
  // The gallery itself, and its previews.
  /^https:\/\/joygotchi\.vercel\.app$/,
  /^https:\/\/joygotchi-[a-z0-9-]+\.vercel\.app$/,
  // Anything local, for `pnpm dev` and the window's browser mock.
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
];

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED.some((pattern) => pattern.test(origin))) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '86400',
    // The answer depends on who asked, so a cache must not serve one
    // origin's headers to another.
    vary: 'Origin'
  };
}

/** The preflight. Without it the browser never sends the POST at all. */
export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) });
}
