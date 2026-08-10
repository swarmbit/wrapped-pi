# Verification Plan — Phase 0: Runtime Mode Scaffolding

Scope: `runtime.mode` in `wpi.yml` + `--mode` CLI flag. No behavior change to Docker execution paths. Part of the [dual-mode runtime plan](https://github.com/swarmbit/wrapped-pi) tracked in the wiki (`wpi-nono-runtime-implementation-plan`).

## Automated tests

`src/runtime-mode.test.ts` — run with `npm test` (builds first, then vitest):

| Area | Cases |
|---|---|
| `parseRuntimeMode` | accepts all declared modes; rejects unknown/empty/wrong-case with source-labeled error |
| Defaults | `DEFAULT_RUNTIME_MODE` is `docker`; no config → `docker`; config without `runtime:` section → `docker` |
| Config parsing | project `runtime.mode`; user `runtime.mode`; coexists with `docker.*` sections undisturbed |
| Precedence | CLI `--mode` > user config > project config > default |
| CLI semantics | override applies with no config files; override **never writes back** to YAML |
| Invalid rejection | invalid value rejected from project file, user file, and CLI flag — each error names its source |
| Precedence vs. validation | invalid user config surfaces over valid project config; invalid project config is masked when CLI wins |

Also covered by the existing suite (must stay green — regression guard):

- `src/config.test.ts` — all pre-existing config behavior unchanged
- `src/cli.test.ts`, `src/docker.test.ts`, `src/templates.test.ts` — Docker paths untouched

## Manual verification checklist

### 1. Backwards compatibility (most important)

- [ ] `wpi --version` works
- [ ] `wpi dry-run` with no config files prints `runtime mode:   docker` and the same output as `main` otherwise
- [ ] `wpi dry-run` diff vs. `main`: only the added `runtime mode:` line differs
- [ ] `wpi build` on a real project builds the image exactly as before
- [ ] `wpi` interactive session launches as before
- [ ] `wpi -- -p "say hi"` print mode works as before

### 2. Config file mode selection

- [ ] Project `.pi/wpi.yml` with `runtime:\n  mode: host` → `wpi dry-run` shows `runtime mode:   host`
- [ ] `~/.pi/wpi.yml` with `mode: host` + project with `mode: docker` → `dry-run` shows `host` (user wins)
- [ ] No `runtime:` section anywhere → `docker`

### 3. CLI flag

- [ ] `wpi --mode host dry-run` → shows `host` regardless of config files
- [ ] `wpi --mode docker dry-run` with `mode: host` in user config → shows `docker`
- [ ] After `wpi --mode host dry-run`, both YAML files are byte-identical (no write-back)
- [ ] `wpi --mode` (missing value) → clean error `Error: --mode requires a value (docker or host).`, exit 1

### 4. Invalid values

- [ ] `wpi --mode podman dry-run` → `Error: Invalid runtime mode "podman" in --mode flag. Expected one of: docker, host.`, exit 1 (no stack trace)
- [ ] `mode: podman` in project config → same error naming `.pi/wpi.yml`, exit 1
- [ ] `mode: podman` in user config → same error naming `~/.pi/wpi.yml`, exit 1
- [ ] `mode: DOCKER` (uppercase) → rejected (case-sensitive)

### 5. Help & docs

- [ ] `wpi --help` documents `--mode` and the `runtime:` config section
- [ ] Help example for host notes it is Phase 3+ (flag parses; backend doesn't exist yet)

## Known limitations (accepted for Phase 0)

- `--mode host` for `run`/`build`/`shell` still executes the **Docker** backend — the mode is resolved and visible but not yet dispatched. Dispatch lands in Phase 1 (`RuntimeBackend` factory). This is intentional: Phase 0 is scaffolding only.
- No `doctor` command yet (Phase 2).

## Exit criteria for merge

1. `npm test` green (new + existing suites)
2. Checklist sections 1–5 verified on macOS (Bruno's machine)
3. Zero diff in Docker behavior vs. `main` except the `runtime mode:` dry-run line
