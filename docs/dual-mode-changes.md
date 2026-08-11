# Dual-mode runtime — complete branch changes

*Everything implemented on `feat/dual-mode` (9 commits, ~7,100 lines added), with code
examples and the reasoning behind each decision. Companion docs:
[dual-mode-implementation-plan.md](dual-mode-implementation-plan.md) (phase tracker),
[behavior-matrix.md](behavior-matrix.md) (setting × combination semantics),
[nono.md](nono.md) (original architecture brainstorm).*

---

## 1. What the branch delivers

`wpi` went from a Docker-only wrapper into a **dual-backend runtime** with two
independent axes:

| Axis | Values | Meaning |
|---|---|---|
| `runtime.mode` | `docker` (default) · `host` | *Where* pi executes: container userspace vs. native host process |
| `sandbox.backend` | `nono` (default on both) · `none` | *Whether* the launched process tree runs under [nono](https://nono.sh) kernel sandboxing |

All four combinations are implemented, tested, and documented:

| | docker | host |
|---|---|---|
| **nono** | `nono run --profile wpi-docker -- docker run … pi` | `nono run --profile wpi -- pi` |
| **none** | `docker run … pi` (classic wpi) | `pi` directly |

New user-facing surface:

- `--mode` / `--sandbox` CLI flags + `runtime:` / `sandbox:` config sections
- `network:`, `workspace:`, `nono:` config sections (credential routes, fs grants, profile tuning)
- `docker.socket` config key ( honoured `$DOCKER_HOST` unix:// form)
- `wpi doctor` — read-only health check (exit 0/1/2)
- `wpi setup` — provisioning counterpart of doctor (exit 0/1/2)
- `wpi shell` works in all four combinations
- Host-mode package wiring (`~/.pi/wpi-package/<version>` + settings entry)
- Two authored nono profiles: `wpi` (host) and `wpi-docker` (docker client)

## 2. Cross-cutting design principles

These principles were applied uniformly; every component below cites them:

1. **Never silently downgrade security.** `sandbox.backend` defaults to `nono` on
   both modes. A missing nono binary with the default config is an *error* with
   the install command — never a silent fallback to unsandboxed. `none` is a
   loud, explicit opt-out (doctor warns; run/shell print `⚠ UNSANDBOXED`).
2. **Never silently overwrite user state.** Profiles, settings.json, and package
   copies are written *if absent*; if present and different, wpi reports the
   drift/collision and keeps the on-disk version. The documented fix is always
   "delete to regenerate".
3. **Doctor is strictly read-only; setup writes.** `wpi doctor` never mutates
   the machine. `wpi setup` performs exactly the writes a first `build`/`run`
   would (profiles, package copy, settings wiring), so it's a no-op on a
   configured machine.
4. **No silent sudo / no auto-installs.** Missing prerequisites are error steps
   with the exact command to run. The single exception is
   `nono pull nolabs-ai/pi` in host setup — idempotent, unauthenticated, no sudo.
5. **Extend signed packs, don't fork them.** The host profile *extends* nono's
   signed `nolabs-ai/pi` pack, so wpi never carries a stale copy of pi's policy.

## 3. Config layer (`src/config.ts`, +344 lines)

### 3.1 The two axes

```ts
export const RUNTIME_MODES = ["docker", "host"] as const;
export const SANDBOX_BACKENDS = ["nono", "none"] as const;

export const DEFAULT_SANDBOX_FOR: Record<RuntimeMode, SandboxBackend> = {
  docker: "nono",   // flipped in Phase 4 (breaking, plan §0.1)
  host: "nono",
};
```

Both are validated with source-labeled errors so a typo tells you *which file*
broke:

```ts
throw new Error(
  `Invalid runtime mode "${value}" in ${source}. Expected one of: ${RUNTIME_MODES.join(", ")}.`
);
```

**Reasoning:** mode and sandbox are orthogonal concerns that were previously
conflated ("nono mode" in early sketches). Separating them lets docker users get
nono's kernel sandboxing *without* giving up image reproducibility — the central
insight of the redesign.

### 3.2 Precedence

CLI flag > user config (`~/.pi/wpi.yml`) > project config (`.pi/wpi.yml`) >
default. CLI overrides are never written back to YAML — verified by tests.

### 3.3 New sections: `network`, `workspace`, `nono`, `docker.socket`

```ts
export const PRESET_CREDENTIAL_ENV_VAR: Record<PresetCredentialService, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  // …gemini, google-ai, github, gitlab
};
```

`network.credentials` / `customCredentials` describe *credential routes*: nono's
supervisor holds the real key, injects a phantom into the child, and swaps in the
real credential at the L7 proxy for allowed upstreams only. `workspace`/`nono`
sections carry extra filesystem grants beyond the read-write workdir.
`docker.socket` resolves as: explicit config > `$DOCKER_HOST` (unix:// form) >
`/var/run/docker.sock`.

**Reasoning:** these map 1:1 onto nono profile vocabulary (`allow_domain`,
`credentials`, `custom_credentials`, `filesystem.allow/read`) so the profile
builder is a thin, testable pure function. They only *take effect* in host+nono —
in docker mode they're parsed, validated, and doctor warns that they're inert
(honesty over silent acceptance).

## 4. Backend abstraction (`src/runtime/backend.ts`)

```ts
export interface RuntimeBackend {
  readonly mode: RuntimeMode;
  checkPrerequisites(config: ResolvedConfig): void;
  build(config: ResolvedConfig): void;
  run(config: ResolvedConfig, piArgs: string[]): Promise<void>;
  shell(config: ResolvedConfig): Promise<void>;
  execShell(containerId: string): Promise<void>;
  dryRun(config: ResolvedConfig, piArgs: string[]): void;
  doctor(config: ResolvedConfig): Promise<DoctorReport>;
  setup(config: ResolvedConfig): Promise<SetupReport>;
}

export function resolveBackend(mode: RuntimeMode): RuntimeBackend {
  switch (mode) {
    case "docker": return new DockerBackend();
    case "host":   return new HostBackend();
  }
}
```

**Reasoning:** `cli.ts` was Docker-assumptive end to end. Extracting the
interface (Phase 1) first — with `DockerBackend` delegating to the untouched
`docker.ts` functions so behavior stayed byte-identical — meant the risky
refactor landed with the full test suite as a regression guard *before* any new
backend existed. `doctor` and `setup` were added to the interface in Phases 2/6
so cli.ts dispatch never grew mode conditionals.

One deliberate quirk: `wpi shell <id>` bypasses config entirely and uses the
default (docker) backend — container IDs only exist in docker mode, and
`execShell` on HostBackend is a descriptive error.

## 5. Docker mode + nono (Phase 4)

### 5.1 The sandbox prefix mechanism (`src/docker.ts`)

```ts
let _dockerSandboxPrefix: string[] = [];

export function setDockerSandboxPrefix(prefix: string[]): void {
  _dockerSandboxPrefix = prefix;
}

function dockerSpawnArgs(args: string[]): { bin: string; args: string[] } {
  if (_dockerSandboxPrefix.length === 0) return { bin: "docker", args };
  return { bin: "nono", args: [..._dockerSandboxPrefix, "--", "docker", ...args] };
}
```

Every docker CLI call in the module (`image inspect`, `build`, `run`,
`volume create`, …) funnels through `dockerSpawnArgs`. `DockerBackend` arms the
prefix in `enableSandboxOrWarn()` at the top of `build`/`run`/`shell` —
**dry-run, doctor, and `shell <id>` never arm it.**

**Reasoning:** one choke point beats threading a flag through a dozen call
sites. Module state is acceptable because wpi is a single-dispatch CLI process.
Keeping the wrap *outside* the container (nono supervises the **client**) is the
honest boundary: in-container traffic remains Docker's domain, which the docs
state explicitly.

### 5.2 The `wpi-docker` profile (`src/runtime/docker-profile.ts`)

Least privilege for the docker *client*:

```ts
// filesystem grants:
unix_socket: [dockerSocket]      // connect(2) to the daemon
allow:       [~/.pi, $TMPDIR, /tmp, …rw mount host paths]
read:        […ro mount host paths]
extends:     "default"           // docker binary + system paths readable
```

Everything else is denied. `$TMPDIR`/`/tmp` are granted because `docker build`
streams the build context from a temp dir wpi creates.

**Grant verification with fail-fast** (`checkProfileGrants`): a *drifted* profile
that lost a socket or mount grant would break the client mid-run with an opaque
nono denial. So run/build fail fast instead:

```ts
if (missing.length > 0) {
  console.error(`Error: on-disk profile ${res.path} does not grant:`);
  for (const m of missing) console.error(`  - ${m.kind}: ${m.path}`);
  process.exit(1);   // outside the try/catch — process.exit throws in tests
}
```

**Reasoning:** principle 2 says never overwrite a drifted profile; but silently
*using* a profile that lacks declared grants is worse than either option. The
escape hatch is always the same documented incantation: delete the file.

### 5.3 `nono.dockerProfile` config key

Teams can point at their own derived profile (`team-docker.json` is authored with
the same grants) — project > user > `wpi-docker`.

## 6. Host mode (Phase 3)

### 6.1 Launch shape (`src/runtime/host-backend.ts`)

```ts
buildNonoRunArgs(config, command) =>
  ["run", "--profile", "wpi", "--allow-cwd", "--rollback",
   …ports.map(p => ["--listen-port", p.host]),
   "--", ...command]
```

`--allow-cwd` grants the workdir read-write; `--rollback` gives atomic restore.
`wpi shell` uses nono's dedicated `nono shell` subcommand (a deliberate deviation
from the plan's `nono run … -- shell` sketch — it's the maintained path).

### 6.2 Ports are grants, not forwards

There is no container to forward *to* in host mode. So a simple port becomes a
`--listen-port` grant, and a `host:container` mapping is a hard error:

```ts
if (p.host !== p.container) {
  console.error(`Error: host:container port mapping "${p.host}:${p.container}" is not
    supported in host mode (there is no container to forward to).`);
  process.exit(1);
}
```

Both `run()` and `shell()` assert this (the polish pass fixed shell missing it).

### 6.3 The `wpi` profile (`src/runtime/profile.ts`)

```json
{
  "extends": "nolabs-ai/pi",
  "workdir": { "access": "readwrite" },
  "filesystem": { "allow": ["~/src"], "read": ["/etc"] },
  "network": { "allow_domain": ["api.anthropic.com"], "credentials": ["anthropic"] },
  "environment": { "deny_vars": ["ANTHROPIC_API_KEY"] }
}
```

The **route-wins** rule: any env var covered by a credential route is added to
`deny_vars`, so the *real* key never enters the child — nono injects a phantom
and swaps it at the proxy. Doctor's Profile section warns when `docker.env`
still holds a route-covered key.

**Reasoning:** extending the signed pack (principle 5) means pi upgrades don't
strand wpi with a stale policy fork. Deterministic serialization (sorted keys,
trailing newline — now shared via `canonical-json.ts`) makes drift detection a
byte comparison.

### 6.4 Platform gate

Host+nono requires macOS (Seatbelt) or Linux (Landlock); anything else is a
prereq error, surfaced in doctor's Platform section too.

## 7. Host package wiring (Phase 5, `src/runtime/package-wiring.ts`)

Docker mode bakes `package/` into the image at `/opt/pi-package`; host mode needs
the same extensions wired natively. Two artifacts:

**1. Versioned copy** — `~/.pi/wpi-package/<wpi-version>/`:

```ts
export function ensureWpiPackageCopy(sourceDir, homeDir, wpiVersion): CopyResult {
  // absent → copy ("copied")
  // identical (sha256 tree compare) → "in-sync"
  // differs → "collision": keep on-disk, report differing files
}
```

An upgrade lands in a *new* directory, so the same version can only collide if
the user edited the copy — exactly the case where overwriting would be hostile.

**2. Surgical settings merge** — adds the copy's absolute path to the `packages`
array in `~/.pi/agent/settings.json`:

- user packages (string **or** object-form filter entries) and every other
  settings key are preserved verbatim;
- wpi replaces only entries it *owns*: a different `wpi-package/<version>`, or
  the stale docker-mode default `/opt/pi-package` — and the latter only when
  that path doesn't exist on the host (it only exists inside the image);
- a malformed settings file is left **untouched** (`skipped-malformed`).

The manifest (`package/package.json`) declares what extensions need on the host:

```json
"wpi": { "nativeBinaries": ["git"] }
```

Doctor/setup verify each declared binary is on PATH (docker mode bakes them into
the image instead).

## 8. Doctor (Phase 2, `src/runtime/doctor.ts`)

Read-only health report, exit 0 healthy / 1 warn / 2 error (error dominates warn).
Mode-agnostic sections (Runtime, Configuration) are shared; each backend builds
its own:

- **docker**: Sandbox (nono binary, profile drift, socket/mount grants), Pi
  (image presence), Docker (cli + daemon via `docker info --format`).
- **host**: Sandbox, Profile (drift + credential routes + route-wins leaks), Pi
  (binary version), Platform (Seatbelt/Landlock), Package (copy state, settings
  wiring, native binaries).

Notable checks:

- **Secret-name heuristic** — `/(secret|token|password|api[_-]?key|_key$)/i` on
  env var *names* (never values) nudges users toward credential routes.
- **Cross-mode honesty** — `docker.extension` in host mode warns; `network.*` in
  docker mode warns (added in Phase 7 — the last silent-ignore gap).

## 9. Setup (Phase 6, `src/runtime/setup.ts`)

The write-triggered counterpart of doctor, per combination:

| Combination | Steps |
|---|---|
| docker+none | docker cli → daemon → unsandboxed warn |
| docker+nono | + nono binary → wpi-docker profile → grant validation → smoke (`nono run … -- docker --version`) |
| host+none | platform → pi binary → unsandboxed warn |
| host+nono | + nono binary → `nono pull nolabs-ai/pi` → wpi profile → package wiring → network surface → smoke (`nono run … -- pi --version`) |

Smoke tests use `spawnSync` with a timeout; `firstLine()` strips nono's WARN/
timestamp/ANSI noise to surface the real version string. Early-return on blocking
errors keeps reports short (no point checking the daemon when the CLI is missing).

**Reasoning:** "works on first `wpi`" and "nothing is provisioned silently" are
in tension; setup resolves it by making provisioning an explicit, inspectable
command whose writes are identical to a first run's.

## 10. CLI (`src/cli.ts`)

- New flags `--mode` / `--sandbox` (validated values, override-only).
- Dispatch is backend-polymorphic: `checkPrerequisites` is skipped for
  `dry-run` (read-only), `doctor`, and `setup` (they report prereqs as their
  own steps).
- `dry-run` shows the resolved config (now including `sandbox:`, and hiding the
  docker-only `image:`/`version:` lines in host mode) plus the backend's exact
  command preview.
- `checkPortAvailable` runs for both modes (host processes bind directly, so
  the check is equally valid).
- Help text documents the full config schema and per-mode command semantics.

## 11. Code-quality pass (commit `24069fe`)

Post-implementation review improvements:

| Change | Why |
|---|---|
| Removed `_voidHomeDeprecated` dead code + unused `os`/`DoctorStatus` imports | Leftovers from incremental phase commits |
| `canonical-json.ts` — shared deterministic serializer; `expandFsPath` unified (optional `workspaceDir`, defaults to `process.cwd()`) | `sortKeys`/`expandFsPath` were duplicated across both profile modules with subtly different signatures |
| `doctor.ts` uses a top-level `fs` import instead of a lazy `require("fs")` | No reason for the indirection |
| Fixed stale phase comments ("HostBackend lands in Phase 3", "docker defaults to none", "network.* lands in commit 2", "Host mode will render its own commands here in Phase 3") | Comments describing a future that already happened are worse than none |
| Docker backend prints `⚠ UNSANDBOXED` for `sandbox: none` | Host already did; the behavior matrix claimed "either mode" — code now matches docs |
| Removed the *duplicate* unsandboxed notice from host `checkPrerequisites` (kept in run/shell) | It printed twice per command |
| `HostBackend.shell()` now asserts host:container port mismatch | `run()` errored, `shell()` silently granted the wrong port — inconsistent |
| Extracted `ensureNamedVolumes()` in docker.ts | Identical ~20-line block in `runContainer` and `shellInContainer` |
| Deduplicated `buildArgs` in docker dry-run; removed redundant `as ResolvedConfig` casts | `loadConfig`'s return type already *is* `ResolvedConfig` |
| Removed unused `homeDir` param from `resolveNetwork` | `void homeDir` reserved-param smell |

## 12. Testing

**528 tests across 21 files, all green** (`npm test` = `tsc` build + `vitest run`;
cli.test.ts e2e exercises the built `dist/cli.js`).

Patterns worth knowing:

- **Backends are tested against mocked `child_process`** (`execSync`/`spawnSync`/
  `spawn`) and `docker.ts` module mocks; sandbox-prefix assertions verify the
  exact wrapped argv (`nono run --profile wpi-docker … -- docker image inspect …`).
- **`os.homedir()` can't be spied** in ESM — tests `vi.stubEnv("HOME", tmp)`
  (honored on POSIX) and use real temp homes for profile/wiring tests.
- **`process.exit` in a try/catch gets swallowed** — fail-fast exits are placed
  deliberately outside catch blocks (see §5.2 comment).
- **Capture spy output before `mockRestore()`** — restoring clears recorded calls.
- **Real `pi --version` takes 3–6 s** in a fresh HOME (model catalog fetch) — the
  setup e2e prepends a stub `pi` script to PATH.
- **Live verification** on the dev machine (real nono 0.73.0 / pi 0.84.1 /
  docker CLI) in isolated `HOME=/tmp/…` sandboxes per phase: `nono profile
  validate`, sandboxed `docker --version`, host setup end-to-end, doctor
  rendering.

## 13. Migration notes (for existing users)

- **Breaking:** `sandbox.backend` now defaults to `nono` in docker mode. Add
  `sandbox: { backend: none }` to `~/.pi/wpi.yml` to keep classic behavior —
  doctor will warn until you sandbox.
- Missing nono with the default config errors with the install command; it never
  silently runs unsandboxed.
- Old docker-mode `settings.json` may hold `/opt/pi-package`; host mode replaces
  it with the host path (only when `/opt/pi-package` doesn't exist on the host).
- Upgrading wpi lands a new `~/.pi/wpi-package/<version>/`; delete old version
  dirs when no longer needed.

## 14. Known limitations & future work

- **In-container network is not filtered by nono** (docker+nono wraps the
  *client*). L7 filtering of client pulls is a documented later refinement; the
  wpi-docker profile deliberately leaves client networking open so image pulls work.
- **`pi.version` is docker-only** — host mode runs the installed `pi` binary
  (doctor reports which one). Pinning host pi is out of scope.
- **`docker.env` is not injected in host mode** — use credential routes; doctor
  warns on secret-looking keys.
- **nono state-root overlap edge** (nono-side, not a wpi bug): nono refuses to
  sandbox when HOME is nested inside a granted dir — only reachable with a
  pathological HOME under `/tmp` (the wpi-docker profile grants `/tmp`).
- **`wpi update` semantics per combination** remain an open question in the plan.
- Windows is unsupported for host+nono (no Seatbelt/Landlock); docker mode
  unaffected.
