import { describe, it, expect } from "vitest";
import { safeNext, hasControlChar } from "@/lib/safe-redirect";

const ORIGIN = "https://tickets.example.com";

/**
 * Regression lock for the open-redirect fix in app/auth/confirm/route.ts
 * (security audit H1, Phase 3+4). The invariant is simple and absolute: no
 * input may ever produce a redirect URL whose origin is not ORIGIN. These run
 * with no DB (pure function), unlike the rest of tests/.
 */
describe("safeNext — open redirect guard", () => {
  it("keeps legitimate same-origin relative paths", () => {
    expect(safeNext("/events/123", ORIGIN).href).toBe(`${ORIGIN}/events/123`);
    expect(safeNext("/tickets?ref=abc#top", ORIGIN).href).toBe(`${ORIGIN}/tickets?ref=abc#top`);
  });

  it("falls back to /events for null / empty / non-path input", () => {
    expect(safeNext(null, ORIGIN).href).toBe(`${ORIGIN}/events`);
    expect(safeNext("", ORIGIN).href).toBe(`${ORIGIN}/events`);
    expect(safeNext("events", ORIGIN).href).toBe(`${ORIGIN}/events`);
  });

  // The core security property: every one of these MUST stay on ORIGIN.
  const attacks: [string, string][] = [
    ["userinfo trick", "@evil.com"],
    ["protocol-relative", "//evil.com"],
    ["backslash-relative", "/\\evil.com"],
    ["absolute external", "https://evil.com"],
    ["tab-injected protocol-relative", "/\t/evil.com"],
    ["newline-injected", "/\n/evil.com"],
    ["cr-injected", "/\r/evil.com"],
    ["dot-segment to //", "/.//evil.com"],
    ["double-dot-segment to //", "/..//evil.com"],
  ];

  it.each(attacks)("never escapes origin: %s", (_label, raw) => {
    const url = safeNext(raw, ORIGIN);
    expect(url.origin).toBe(ORIGIN);
    expect(url.hostname).toBe("tickets.example.com");
    expect(url.hostname).not.toBe("evil.com");
  });
});

describe("hasControlChar", () => {
  it("detects C0 controls and DEL, ignores normal text", () => {
    expect(hasControlChar("/events")).toBe(false);
    expect(hasControlChar("/a\tb")).toBe(true);
    expect(hasControlChar("/a\nb")).toBe(true);
    expect(hasControlChar("/a\rb")).toBe(true);
    expect(hasControlChar("/a" + String.fromCharCode(0x7f))).toBe(true);
    expect(hasControlChar("/a" + String.fromCharCode(0x00))).toBe(true);
  });
});
