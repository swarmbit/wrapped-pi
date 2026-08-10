// ============================================================
// Tests for runtime backend factory — Phase 1
// ============================================================
// Locks in the dispatch contract introduced in Phase 1:
//   - resolveBackend("docker") -> DockerBackend
//   - resolveBackend("host")   -> DockerBackend (Phase 1 fallthrough;
//                                  HostBackend lands in Phase 3)
//   - resolveBackend(unknown)  -> throws (defensive; parseRuntimeMode
//                                  rejects unknown modes earlier)
// ============================================================

import { describe, it, expect } from "vitest";
import { resolveBackend, resolveDefaultBackend } from "./backend";
import { DockerBackend } from "./docker-backend";
import { DEFAULT_RUNTIME_MODE } from "../config";

describe("resolveBackend", () => {
  it("returns DockerBackend for docker mode", () => {
    const backend = resolveBackend("docker");
    expect(backend).toBeInstanceOf(DockerBackend);
    expect(backend.mode).toBe("docker");
  });

  it("falls back to DockerBackend for host mode (Phase 1; Phase 3 adds HostBackend)", () => {
    const backend = resolveBackend("host");
    // Phase 1 contract: host is parsed + visible but not yet dispatched,
    // so it still executes via the Docker backend. Update this test in
    // Phase 3 when HostBackend lands.
    expect(backend).toBeInstanceOf(DockerBackend);
    expect(backend.mode).toBe("docker");
  });

  it("throws for an unknown mode (defensive — parseRuntimeMode guards earlier)", () => {
    expect(() => resolveBackend("podman" as never)).toThrow(
      /No backend implemented for runtime mode "podman"/
    );
  });
});

describe("resolveDefaultBackend", () => {
  it("resolves the default mode (docker) backend", () => {
    const backend = resolveDefaultBackend();
    expect(backend).toBeInstanceOf(DockerBackend);
    expect(backend.mode).toBe(DEFAULT_RUNTIME_MODE);
  });
});