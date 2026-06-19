// ============================================================
// Tests for web extension helper functions
// ============================================================
// Tests the exported helper functions: isValidUrl, getHostname,
// isDomainAllowed. These contain the safety-critical logic
// (URL validation and domain whitelist enforcement).
//
// The pi-coding-agent and typebox modules are mocked since they
// are only available at runtime inside the pi agent, not in this
// test environment.
// ============================================================

import { describe, it, expect, vi } from "vitest";

// Mock @earendil-works/pi-coding-agent before importing the extension
vi.mock("@earendil-works/pi-coding-agent", () => ({
  default: {},
}));

// Mock typebox — only used for tool schema registration at runtime,
// not needed for the pure helper functions under test.
vi.mock("typebox", () => ({
  Type: {
    Object: vi.fn(() => ({})),
    String: vi.fn(() => ({})),
    Number: vi.fn(() => ({})),
    Boolean: vi.fn(() => ({})),
    Optional: vi.fn((x: unknown) => x),
  },
}));

import { isValidUrl, getHostname, isDomainAllowed } from "./index";

// ── isValidUrl ──────────────────────────────────────────────

describe("isValidUrl", () => {
  it("accepts http URLs", () => {
    expect(isValidUrl("http://example.com")).toBe(true);
    expect(isValidUrl("http://localhost:3000/path")).toBe(true);
    expect(isValidUrl("http://192.168.1.1/api")).toBe(true);
  });

  it("accepts https URLs", () => {
    expect(isValidUrl("https://example.com")).toBe(true);
    expect(isValidUrl("https://docs.firecrawl.dev/api")).toBe(true);
    expect(isValidUrl("https://github.com/swarmbit/wrapped-pi")).toBe(true);
  });

  it("rejects non-http protocols", () => {
    expect(isValidUrl("ftp://example.com/file")).toBe(false);
    expect(isValidUrl("file:///etc/passwd")).toBe(false);
    expect(isValidUrl("ssh://user@host")).toBe(false);
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
    expect(isValidUrl("data:text/html,<h1>hi</h1>")).toBe(false);
  });

  it("rejects malformed strings", () => {
    expect(isValidUrl("")).toBe(false);
    expect(isValidUrl("not a url")).toBe(false);
    expect(isValidUrl("example.com")).toBe(false);
    expect(isValidUrl("http://")).toBe(false);
  });
});

// ── getHostname ─────────────────────────────────────────────

describe("getHostname", () => {
  it("extracts hostname from URLs", () => {
    expect(getHostname("https://example.com/path")).toBe("example.com");
    expect(getHostname("http://docs.firecrawl.dev/api/v2")).toBe("docs.firecrawl.dev");
    expect(getHostname("https://github.com/swarmbit/wrapped-pi")).toBe("github.com");
  });

  it("returns lowercase hostname", () => {
    expect(getHostname("https://Example.COM/Path")).toBe("example.com");
    expect(getHostname("http://API.GitHub.com/v3")).toBe("api.github.com");
  });

  it("strips port numbers", () => {
    expect(getHostname("http://localhost:3000")).toBe("localhost");
    expect(getHostname("https://example.com:443/path")).toBe("example.com");
    expect(getHostname("http://192.168.1.1:8080/api")).toBe("192.168.1.1");
  });

  it("returns undefined for invalid URLs", () => {
    expect(getHostname("")).toBeUndefined();
    expect(getHostname("not a url")).toBeUndefined();
    expect(getHostname("example.com")).toBeUndefined();
  });
});

// ── isDomainAllowed ─────────────────────────────────────────

describe("isDomainAllowed", () => {
  it("allows all domains when whitelist is empty", () => {
    expect(isDomainAllowed("https://example.com", [])).toBe(true);
    expect(isDomainAllowed("https://random-site.org", [])).toBe(true);
    expect(isDomainAllowed("http://192.168.1.1:8080", [])).toBe(true);
  });

  it("allows exact domain matches", () => {
    const whitelist = ["github.com", "docs.firecrawl.dev"];
    expect(isDomainAllowed("https://github.com/swarmbit/wrapped-pi", whitelist)).toBe(true);
    expect(isDomainAllowed("https://docs.firecrawl.dev/api", whitelist)).toBe(true);
  });

  it("allows subdomains of whitelisted domains", () => {
    const whitelist = ["github.com"];
    expect(isDomainAllowed("https://api.github.com/v3", whitelist)).toBe(true);
    expect(isDomainAllowed("https://raw.githubusercontent.com/file", whitelist)).toBe(false);
  });

  it("is case-insensitive", () => {
    const whitelist = ["GitHub.com"];
    expect(isDomainAllowed("https://github.com/repo", whitelist)).toBe(true);
    expect(isDomainAllowed("https://API.GITHUB.com/v3", whitelist)).toBe(true);
  });

  it("rejects domains not in whitelist", () => {
    const whitelist = ["github.com", "docs.firecrawl.dev"];
    expect(isDomainAllowed("https://example.com", whitelist)).toBe(false);
    expect(isDomainAllowed("https://gitlab.com/repo", whitelist)).toBe(false);
    expect(isDomainAllowed("https://github.io/page", whitelist)).toBe(false);
  });

  it("does not allow lookalike domains", () => {
    const whitelist = ["github.com"];
    // github.io is not a subdomain of github.com
    expect(isDomainAllowed("https://github.io", whitelist)).toBe(false);
    // github.com.evil.com is not a subdomain of github.com
    expect(isDomainAllowed("https://github.com.evil.com", whitelist)).toBe(false);
    // notgithub.com is not a subdomain of github.com
    expect(isDomainAllowed("https://notgithub.com", whitelist)).toBe(false);
  });

  it("rejects invalid URLs when whitelist is set", () => {
    const whitelist = ["github.com"];
    expect(isDomainAllowed("not a url", whitelist)).toBe(false);
    expect(isDomainAllowed("", whitelist)).toBe(false);
  });

  it("handles IP addresses in whitelist", () => {
    const whitelist = ["192.168.1.1"];
    expect(isDomainAllowed("http://192.168.1.1:8080/api", whitelist)).toBe(true);
    expect(isDomainAllowed("http://192.168.1.2/api", whitelist)).toBe(false);
  });
});
