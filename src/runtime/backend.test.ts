// ============================================================
// Tests for runtime backend factory — Phase 1 / Phase 3
// ============================================================
// Locks in the dispatch contract:
//   - resolveBackend("docker") -> DockerBackend
//   - resolveBackend("host")   -> HostBackend  (Phase 3 replaced the
//                                            Phase 1 Docker fallthrough)
//   - resolveBackend(unknown)  -> throws (defensive; parseRuntimeMode
//                                  rejects unknown modes earlier)
//   - resolveDefaultBackend() -> DockerBackend (default mode)
// ============================================================

import { describe, it, expect } from "vitest";
import { resolveBackend, resolveDefaultBackend } from "./backend";
import { DockerBackend } from "./docker-backend";
import { HostBackend } from "./host-backend";
import { DEFAULT_RUNTIME_MODE } from "../config";

describe("resolveBackend", () => {
  it("returns DockerBackend for docker mode", () => {
    const backend = resolveBackend("docker");
    expect(backend).toBeInstanceOf(DockerBackend);
    expect(backend.mode).toBe("docker");
  });

  it("returns HostBackend for host mode (Phase 3)", () => {
    const backend = resolveBackend("host");
    expect(backend).toBeInstanceOf(HostBackend);
    expect(backend.mode).toBe("host");
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