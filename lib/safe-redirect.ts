/**
 * Same-origin redirect sanitisation for post-auth `next` targets.
 * Extracted from app/auth/confirm/route.ts so it can be unit-tested in
 * isolation (see tests/safe-redirect.test.ts) — it is the guard against turning
 * the post-login redirect into an open redirect (a phishing amplifier).
 */

/**
 * True if the string contains any C0 control char (code point <= 0x1F) or DEL
 * (0x7F). Matters because the WHATWG URL parser strips tab (0x09), LF (0x0A)
 * and CR (0x0D) from anywhere in a URL string before parsing — so a control
 * char smuggled into `next` (e.g. "/<TAB>/evil.com") can slip past a plain
 * "//" prefix check and then normalise to an external host. We reject on the
 * raw string using char codes (no control chars in this source, no regex).
 */
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/**
 * Resolves the post-login `next` redirect target to a SAME-ORIGIN absolute URL,
 * or falls back to /events. Returns a fully-resolved `URL` object (never a
 * string) on purpose: the caller must redirect to it directly and never
 * re-parse it. Handing back a string path and letting the caller do
 * `new URL(path, origin)` would re-introduce relative-reference ambiguity —
 * e.g. `next="/.//evil.com"` passes the "//" prefix check, then RFC3986
 * dot-segment removal normalises the pathname to "//evil.com"; re-parsing that
 * string treats "//" as an authority and escapes to evil.com even though the
 * first parse was correctly same-origin.
 *
 * Layers: (1) reject control chars; (2) require a single-slash relative path
 * (not "//" or "/\"); (3) resolve against our origin and confirm
 * `resolved.origin === origin`. The verified URL object is then the redirect
 * target with no further parsing.
 */
export function safeNext(raw: string | null, origin: string): URL {
  const fallback = new URL("/events", origin);
  if (!raw || hasControlChar(raw)) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  try {
    const resolved = new URL(raw, origin);
    if (resolved.origin !== origin) return fallback;
    return resolved;
  } catch {
    return fallback;
  }
}
