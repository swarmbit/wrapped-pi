# WPI Dual-Mode Runtime Implementation Plan

*Implementation plan for evolving&#x20;*&#x57;rapped P&#x69;*&#x20;to a host/docker dual-runtime model with nono sandboxing on both, based on the architecture defined in&#x20;*&#x57;rapped Pi — Docker and nono Runtime Mode&#x73;*. Branch:&#x20;*`feat/nono-runtime`*.*

> ** Revised 2026-08-01:** the mode axis changed from `docker | nono` to `docker | host`. nono is not a runtime mode — it is a **sandboxing layer available on both modes**. See §0.

***

## 0. Key revision: nono is a layer, not a mode

The original framing (`runtime.mode: docker | nono`) treated nono as an alternative runtime. That is wrong: nono sandboxes **any** child process — including the `docker` CLI itself. The two axes are independent:

| Axis           | Values                             | Meaning                                                        |
| -------------- | ---------------------------------- | -------------------------------------------------------------- |
| `runtime.mode` | `docker` (default) | `host`        | Where Pi executes: container userspace vs. native host process |
| `sandbox`      | `nono` | `none` (default per mode) | Whether the launched process tree runs under nono supervision  |

Resulting combinations:

| Mode     | Sandbox | What runs                                        | When to use                                                                                                                                                                                                                                                          |
| -------- | ------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker` | `none`  | `docker run pi` (today's behavior)               | Explicit opt-out only — no longer the default                                                                                                                                                                                                                        |
| `docker` | `nono`  | `nono run --profile wpi-docker -- docker run pi` | **Default from Phase 4 on** — Docker reproducibility **plus** kernel-enforced fs/network limits on the container's host-side access (mounted paths, forwarded ports, credential proxy). Blunts the "Docker socket / broad mounts" risk class from the security table |
| `host`   | `nono`  | `nono run --profile wpi -- pi`                   | **Default in host mode** — the lightweight macOS path: native process, Landlock/Seatbelt isolation, credential injection, audit, rollback                                                                                                                            |
| `host`   | `none`  | `pi` directly                                    | Almost never recommended — exists for debugging and for environments where nono can't run. `doctor` warns loudly                                                                                                                                                     |

### 0.1 Breaking change: nono becomes the default sandbox on both modes

Decided 2026-08-01 — **breaking changes are accepted**; wpi is pre-1.0 in practice and the user base is small.

* From the phase where each combination lands, `sandbox.backend` defaults to `nono` on **both** `docker` and `host` modes.

* `sandbox: none` always remains available, but only as an **explicit** opt-out. `doctor` warns when running unsandboxed.

* Migration for existing Docker users: after upgrading, `wpi setup` (or the first `wpi run`) requires nono installed. If nono is missing, the error message names the install command and the explicit escape hatch:

```yaml
Error: sandbox.backend defaults to "nono" but nono is not installed.
Install:  curl -fsSL https://nono.sh/install.sh | sh
Opt out:  add `sandbox: { backend: none }` to ~/.pi/wpi.yml (unsandboxed — doctor will warn)
```

* No silent downgrade ever: missing nono with default config is an **error**, not a fallback.

* This is the project taking a position: sandboxed-by-default is a feature, and unsandboxed execution is the thing you must ask for — not the other way around.

Implications:

* **The original "nono mode" is now&#x20;**`host`**&#x20;+&#x20;**`nono` — all Phase 3–5 work from the first version of this plan applies, unchanged in substance.

* **New capability:&#x20;**`docker`**&#x20;+&#x20;**`nono` — nono wraps the `docker run` invocation. The nono profile for this combination grants what the Docker client needs (socket access, build context, mounts declared in config) and nothing else. This directly addresses the architecture note's main Docker risk: daemon/socket exposure and broad mounts.

* Config schema gains a `sandbox` section rather than overloading `runtime.mode`.

* `host` + `none` must be an explicit choice — never a silent fallback when nono is missing. Missing nono on `sandbox: nono` is a **setup/doctor failure**, not a downgrade.

Revised config sketch:

```yaml
runtime:
  mode: host          # docker | host (default: docker)

sandbox:
  backend: nono       # nono | none (default: nono on BOTH modes — breaking change, see §0.1)
  # nono-specific tuning lives under nono:* keys below

pi:
  version: 0.83.0

network:
  mode: filtered
  allowDomains:
    - api.anthropic.com
    - github.com
  credentials:
    - anthropic
    - github

docker:
  ports: [3000]
  mounts: []
  volumes: []
  memory: 4g
  extension: |
    RUN apt-get install -y python3

nono:
  profile: wpi              # host-mode profile
  dockerProfile: wpi-docker # profile used when sandboxing docker mode
  allowPaths: []
  readPaths: []
  allowCommands: []
  profileBase: nolabs-ai/pi
```

## Context

[[wrapped-pi]] (`swarmbit/wrapped-pi`) is a TypeScript CLI (`wpi`) that runs Pi Coding Agent in Docker. The [[wrapped-pi]] — Docker and nono Runtime Modes note established the target design; this note turns it into a phased implementation plan, revised for the host/docker + sandbox-layer model.

Current codebase facts (from `swarmbit/wrapped-pi` @ `main`):

* Entry point `src/cli.ts` calls Docker operations directly — no backend abstraction yet.

* `src/config.ts` resolves config with precedence: CLI flags → `~/.pi/wpi.yml` → project `.pi/wpi.yml` → built-in defaults.

* `src/docker.ts` owns image build, container run, shell, port/volume mapping.

* `src/templates.ts` generates the temporary Docker build context.

* Tests per module (vitest, `npm test` = build + run).

* The bundled default package (extensions + settings) lives in `package/`, copied into the image; `pi install /opt/pi-package` runs at container start.

* **Phase 0 PR (#7)** adds `runtime.mode: docker | nono` — superseded by this revision; the branch will be updated to `docker | host` before merge.

## Guiding constraints

1. **Two independent axes** — runtime (docker/host) × sandbox (nono/none). Never conflate them in config, CLI, or docs.

2. **Docker stays the default mode** — no behavior change for existing users.

3. **No silent downgrades** — `sandbox: nono` with nono missing is an error, not a fallback to `none`.

4. **No fake parity** — backend-specific settings validated and reported per mode/sandbox combination.

5. **Never silently mutate user state** — no overwriting customized nono profiles, no `sudo` installs without confirmation, no removing user-added Pi packages.

## Phase 0 — Branch & scaffolding  ✅ done (commit cf1b6e3)

**Goal:** config schema + CLI for the runtime mode axis, zero behavior change.

* [x] `runtime.mode: docker | host` (revised from `docker | nono`).
* [x] `sandbox.backend` **deferred to Phase 3** — Phase 0 keeps the runtime axis only; `doctor` reports sandbox as "not configured (Phase 3+)".
* [x] `--mode <docker|host>` CLI flag, invocation-only, never written back.
* [x] Tests: `src/runtime-mode.test.ts` — config parsing, precedence, CLI override, invalid rejection with source-labeled errors.
* [x] Manual verification: `docs/verification-plan-phase0.md` checklist sections 2–5 passed (live-Docker items in §1 pending a running daemon).

**Exit criteria met:** `npm test` green (340 tests); `wpi --mode docker` identical to `wpi` today — dry-run diff vs `main` is exactly one added `runtime mode:` line.

## Phase 1 — RuntimeBackend interface + DockerBackend extraction  ✅ done (commit cd7f816)

Pure refactor, behavior-identical.

```typescript
// src/runtime/backend.ts
export interface RuntimeBackend {
  readonly mode: RuntimeMode;
  checkPrerequisites(): void;
  build(config: ResolvedConfig): void;
  run(config: ResolvedConfig, piArgs: string[]): Promise<void>;
  shell(config: ResolvedConfig): Promise<void>;
  execShell(containerId: string): Promise<void>;
  dryRun(config: ResolvedConfig, piArgs: string[]): void;
  doctor(config: ResolvedConfig): Promise<DoctorReport>;  // added in Phase 2
}
```

* [x] `DockerBackend` in `src/runtime/docker-backend.ts` delegates to `docker.ts`; `cli.ts` delegates via `resolveBackend(mode)`.
* [x] `--mode host` still dispatches to `DockerBackend` (Phase 3 adds `HostBackend`) — Phase 0 limitation preserved.
* [x] Existing `docker.test.ts` passes unchanged; `wpi dry-run` output byte-identical to `main` (only the `runtime mode:` line differs).
* [x] New `src/runtime/backend.test.ts` locks the dispatch contract.

**Deviations from the original sketch (noted for later phases):**
* `run`/`shell`/`execShell` return `Promise<void>` and exit internally (today's `process.exit` behavior), **not** `Promise<number>`. Exit-code propagation is a behavior change deferred to a later phase.
* `checkPrerequisites()` takes no `config` argument (Phase 1 only needs the default-backend check); Phase 3 will make it mode-aware and likely move it post-config.

**Exit criteria met:** suite green (344 tests); manual dry-run parity verified across default, full-config, and `--` pi-args scenarios.

## Phase 2 — Mode-aware doctor (Docker only)  ✅ done

* [x] `wpi doctor` sections: **Runtime, Pi, Docker, Configuration**. A **Sandbox** sub-check lives under Runtime as `info` ("not configured — Phase 3+") and never affects the exit code; it becomes a full section in Phase 3.
* [x] Exit codes `0/1/2`: `0` healthy, `1` warn (non-blocking: secret-looking env, image not built), `2` error (blocking: Docker CLI missing or daemon unreachable). Error dominates warn.
* [x] Secret-looking YAML `env` values warn — `looksLikeSecretKey` matches `KEY`/`API_KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`/`PRIVATE`; message pushes users toward nono credential routes (Phase 3+).
* [x] `DoctorReport` is backend-produced and CLI-rendered (`renderDoctorReport`); `DockerBackend.doctor` shells out for the Docker CLI/daemon/image checks.
* [x] Tests: `src/runtime/doctor.test.ts` (24 cases — secret detection, exit codes, sections, rendering, mocked Docker checks) + 2 end-to-end CLI cases in `cli.test.ts`.

**Exit criteria met:** suite green (370 tests); manual `wpi doctor` confirmed with daemon-down (exit 2) and secret-env (warn) scenarios; no dry-run regression.

## Phase 3 — Host mode with nono  ✅ slice 1 done (commit pending); commit 2 TODO

The original Phase 3, reframed: `HostBackend` whose supported sandbox is nono.

* [x] `src/runtime/host-backend.ts` implementing `RuntimeBackend`.
* [x] `checkPrerequisites(config)`: platform support (Seatbelt/Landlock), `nono` binary (only when sandbox=nono), `pi` binary. Moved post-config so it is mode- and sandbox-aware.
* [x] **Sandbox axis** `sandbox.backend: nono | none` parsed (`src/config.ts`), with per-mode defaults: **host → nono**, **docker → none** (docker flips to nono in Phase 4). `--sandbox` CLI flag added (overrides config, never written back). docker+nono rejected in Phase 3 with an actionable "lands in Phase 4" error (no silent downgrade).
* [x] Profile generation: `src/runtime/profile.ts` authors a `wpi` profile JSON that **extends** the signed `nolabs-ai/pi` pack (no stale copy of pi's policy); `workdir.access: read-write`. Written to `~/.config/nono/profiles/wpi.json` by `ensureWpiProfile` — **write-if-absent, never overwrites** an existing profile.
* [x] `run`: `nono run --profile wpi --allow-cwd --rollback [--listen-port P ...] -- pi <args>` (sandboxed); bare `pi <args>` + unsandboxed notice when `sandbox: none`.
* [x] `shell`: `nono shell --profile wpi --allow-cwd --rollback` (sandboxed) or bare `$SHELL` (unsandboxed).
* [x] `host` + `sandbox: none`: allowed, doctor warns, run/shell print a one-line `⚠ UNSANDBOXED` notice.
* [x] Ports: host mode rejects `host:container` mismatch (no container to forward to); simple ports become `--listen-port` grants.
* [x] `docker.*` in host mode → doctor `Configuration` warns (`docker.extension` ignored in host mode).
* [x] `doctor` host section set: Runtime, Sandbox, Pi, Platform, Configuration (Sandbox promoted to its own section across both modes).
* [x] Tests: `src/sandbox-config.test.ts` (parsing/precedence/Phase-3 guard/invalid), `src/runtime/profile.test.ts` (shape/determinism/never-overwrite), `src/runtime/host-backend.test.ts` (command assembly, port errors, execShell error, dryRun, doctor sections). Full suite 416 green.

**Commit 2 TODO (still Phase 3):**
* [ ] Profile **drift detection**: compare existing `wpi.json` to the canonical; report differences in `doctor` and `build` (never overwrite — only warn).
* [ ] Config mapping: `network.*` → nono `network` (allow_domain / network_profile / credentials), `workspace.access` → fs rules, `nono.*` → profile merges.
* [ ] **Credential routes**: `network.credentials` + `custom_credentials` (move `ANTHROPIC_API_KEY` / Firecrawl to phantom-token routes; the `web` extension already accepts `*_BASE_URL`, so no extension change needed).
* [ ] End-to-end live run with nono installed (slice 1 was unit-tested only — nono is not on the dev machine; `doctor` reports nono-missing as error exit 2).

**Deviations / decisions noted:**
* `checkPrerequisites(config)` now takes config and runs **post-config** (the plan's interface sketch already had a config arg). Docker's check ignores config; this moves the docker-missing error to after config load (minor, acceptable).
* `run`/`shell` return `Promise<void>` and exit internally (carried from Phase 1) — not `Promise<number>`.
* `wpi build --mode host` is a no-op that ensures pi present + the wpi profile (if nono), prints "no image build needed" — `build` stays shared and mode-aware.


## Phase 4 — Docker mode with nono *(new)*

**Goal:** `nono run --profile wpi-docker -- docker run ...` — sandbox the container's host-side footprint.

* [ ] A second derived profile (`nono.dockerProfile`, default `wpi-docker`) scoped to what the Docker client needs: Docker socket, build context dir, declared mounts/volumes (read per declared mode), `~/.pi` state.
* [ ] `DockerBackend` gains sandbox wrapping: when `sandbox.backend: nono`, the `docker run`/`docker build`/`docker exec` invocations execute as nono children.
* [ ] Mounts declared in `docker.mounts` must map to nono path grants — a mount the profile doesn't grant is a setup/doctor error with a clear message, not a runtime failure.
* [ ] Network: container networking stays Docker's; nono's supervisor filters the client's host-side traffic (registry pulls, credential proxy). Document the boundary honestly — nono does not filter in-container traffic.
* [ ] Tests: profile derivation from declared mounts, docker-command wrapping, mount-without-grant error, dry-run rendering of the wrapped command.

**This phase is the main new work introduced by the revision.** It directly mitigates the architecture note's top Docker risk (daemon/socket + broad mounts) without giving up image reproducibility.

## Phase 5 — Native package wiring for host mode

Unchanged from the original Phase 4.

* [ ] Default package source stays in the `wpi` npm package.
* [ ] Host mode: versioned `~/.pi/wpi-package/<wpi-version>/`, idempotent `settings.json` wiring, user packages untouched, collision reporting.
* [ ] Extensions needing native binaries: manifest-declared, doctor checks host, `docker.extension` in host mode → clear warning.

## Phase 6 — Setup command (both modes, both sandbox states)

* [ ] `wpi setup [--mode host] [--sandbox nono]`.
* [ ] Docker+none: current behavior.
* [ ] Docker+nono: additionally check/install nono, derive `wpi-docker` profile, validate mount grants.
* [ ] Host+nono: platform check → nono install → Pi install → pull pack → derive profile → wire package → validate credentials/domains → smoke test `nono run --profile wpi -- pi --version`.
* [ ] Host+none: verify Pi binary only; print unsandboxed warning.
* [ ] Idempotent; no silent sudo.

## Phase 7 — Shell, docs, migration polish

* [ ] `wpi shell` per combination: docker+none (today), docker+nono (wrapped exec), host+nono (`nono run --profile wpi -- shell`), host+none (native shell + warning).
* [ ] README: two-axis model, combination table from §0, config example.
* [ ] Every mode×sandbox combination has documented behavior for every `docker.*`/`nono.*` setting (apply / warn / error).

## Phase summary & dependencies

| Phase | Deliverable                                              | Depends on                   | Risk                                                                 |
| ----- | -------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| 0     | `runtime.mode: docker\|host` (+ maybe `sandbox.backend`) | —                            | Low — **done (cf1b6e3)**                                  |
| 1     | `RuntimeBackend` + `DockerBackend` extraction            | 0                            | **High** (regression) — **done (cd7f816)**                |
| 2     | `wpi doctor` (Docker)                                    | 1                            | Low — **done**                                |
| 3     | `HostBackend` + nono (original "nono mode")              | 1                            | Medium — **slice 1 done; commit 2 TODO**                               |
| 4     | Docker + nono sandboxing (**new**)                       | 3 (shares profile machinery) | Medium-high — profile must cover socket/mounts without over-granting |
| 5     | Native package wiring                                    | 3                            | Medium (idempotency critical)                                        |
| 6     | `wpi setup` all combinations                             | 3, 4, 5                      | Medium (installers, sudo UX)                                         |
| 7     | Shell, docs, migration                                   | 3–6                          | Low                                                                  |

## Resolved design decisions

* [x] **Mode axis is&#x20;**`docker | host`**; nono is a sandbox layer on both** (this revision).
* [x] **nono is the default sandbox on BOTH modes — breaking change accepted** (2026-08-01). `sandbox: none` is explicit opt-out; missing nono is an error with an actionable message, never a silent downgrade.
* [x] Docker remains the default mode.
* [x] No silent downgrade from `sandbox: nono` to unsandboxed — missing nono is an error.
* [x] `nono run` (supervised), not `nono wrap`.
* [x] Derived profiles extend signed packs; never silently overwritten.
* [x] Secrets via nono credential routes, not `env` maps; doctor warns on secret-looking YAML values.
* [x] `build` stays shared, mode-aware in meaning.

## Open questions

* [x] ~~Default sandbox per mode~~ → **resolved:&#x20;**`nono`**&#x20;on both, breaking change accepted** (§0.1).
* [ ] Does the `wpi-docker` profile belong in the same profile file as `wpi`, or separate files? Separate is cleaner (different lifecycles), one file is easier to diff. Leaning separate.
* [ ] Docker+nono on macOS: the Docker Desktop VM already isolates the container from the host fs — is nono's added value there mostly credential proxying + audit? Validate the honest benefit before marketing Phase 4 for macOS; the clearest win is Linux where the daemon is local.
* [ ] `wpi update` semantics per combination (pack vs. derived profiles vs. wired package) — define before Phase 7.
* [ ] Should `--sandbox` get a CLI flag too, or config-only? Leaning config-only to keep the CLI surface small.