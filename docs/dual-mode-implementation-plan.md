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

## Phase 0 — Branch & scaffolding *(PR #7, needs revision)*

**Goal:** config schema + CLI for the two axes, zero behavior change.

* [ ] `runtime.mode: docker | nono` → revise to `runtime.mode: docker | host` on the Phase 0 branch before merge.
* [ ] Add `sandbox.backend: nono | none` to the schema with per-mode defaults (see open questions) — or defer `sandbox` to Phase 3 if that keeps Phase 0 minimal; decide in PR review.
* [ ] `--mode <docker|host>` CLI flag, invocation-only, never written back.
* [ ] Tests: config parsing, precedence, CLI override, invalid rejection (the existing 20 tests carry over with `nono` → `host`).

**Exit criteria:** `npm test` green; `wpi --mode docker` identical to `wpi` today.

## Phase 1 — RuntimeBackend interface + DockerBackend extraction

Pure refactor, behavior-identical. Unchanged from the original plan.

```typescript
// src/runtime/backend.ts
export interface RuntimeBackend {
  readonly mode: "docker" | "host";
  checkPrerequisites(config: ResolvedConfig): Promise<PrereqReport>;
  setup(config: ResolvedConfig, opts: SetupOpts): Promise<SetupResult>;
  run(piArgs: string[], config: ResolvedConfig): Promise<number>;
  buildOrPrepare(config: ResolvedConfig): Promise<PrepareResult>;
  shell(config: ResolvedConfig): Promise<number>;
  doctor(config: ResolvedConfig): Promise<DoctorReport>;
  dryRun(config: ResolvedConfig): Promise<DryRunReport>;
}
```

* [ ] `DockerBackend` in `src/runtime/docker-backend.ts` owns all Docker calls; `cli.ts` delegates via `resolveBackend(mode)`.
* [ ] Existing `docker.test.ts` passes against `DockerBackend`; `wpi dry-run` output byte-identical to `main`.

**Exit criteria:** suite green; manual dry-run/build parity.

## Phase 2 — Mode-aware doctor (Docker only)

Unchanged from the original plan, plus sandbox-awareness in the report shape:

* [ ] `wpi doctor` sections: Runtime, Sandbox, Pi, Docker, Configuration — the Sandbox section reports "not configured" gracefully until Phase 3 lands.
* [ ] Exit codes `0/1/2`; secret-looking YAML `env` values warn.

## Phase 3 — Host mode with nono *(was: "nono mode")*

The original Phase 3, reframed: `HostBackend` whose supported sandbox is nono.

* [ ] `src/runtime/host-backend.ts` implementing `RuntimeBackend`.
* [ ] `checkPrerequisites`: platform support (Seatbelt/Landlock), `nono` binary, `pi` binary.
* [ ] Profile generation: derive `wpi` profile from signed `nolabs-ai/pi` pack; detect-and-report drift, never overwrite.
* [ ] `run`: `nono run --profile wpi --allow-cwd --rollback -- pi <args>`, flags profile-driven.
* [ ] Config mapping: `workspace.access` → fs rules; `network.*` → network rules + credential routes; `nono.*` → profile merges. `docker.*` in host mode → doctor warnings.
* [ ] Ports: host mode validates availability, reports "no forwarding needed"; `host:container` mismatch is an error.
* [ ] `host` + `sandbox: none`: allowed but doctor warns; run prints a one-line notice that the session is unsandboxed.
* [ ] Tests: profile generation, config→profile mapping, command assembly, port errors, drift detection, unsandboxed notice.

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
| 0     | `runtime.mode: docker\|host` (+ maybe `sandbox.backend`) | —                            | Low — **revise PR #7 before merge**                                  |
| 1     | `RuntimeBackend` + `DockerBackend` extraction            | 0                            | **High** (regression) — pure refactor                                |
| 2     | `wpi doctor` (Docker)                                    | 1                            | Low                                                                  |
| 3     | `HostBackend` + nono (original "nono mode")              | 1                            | Medium                                                               |
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