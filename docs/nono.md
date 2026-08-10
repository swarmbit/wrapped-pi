# Wrapped Pi — Docker and nono Runtime Modes

*Architecture brainstorm for evolving&#x20;*`wpi`*&#x20;from a Docker-only wrapper into one consistent CLI with Docker and nono execution backends.*

> **Update 2026-08-01:** the mode axis was revised to `docker | host` with nono as a sandboxing layer available on *both* modes (including nono-wrapped `docker run`). The `docker | nono` framing below is kept for history; the current model lives in [[wpi-nono-runtime-implementation-plan]] §0.

***

## 1. Current Project

`swarmbit/wrapped-pi` is a TypeScript CLI (`wpi`) that runs Pi Coding Agent in Docker with team-standard extensions and settings.

Current design highlights:

* `wpi` is installed globally from npm.

* Pi is pinned and baked into a generated Docker image.

* The built-in package and settings are copied into a temporary Docker build context.

* `pi install /opt/pi-package` registers the default extensions and themes at startup.

* The current working directory is mounted into the container.

* `~/.pi` is mounted so settings, auth, sessions, extensions, and package state persist.

* Host identity, home path, UID/GID, and Git author identity are mirrored into the container.

* Ports are forwarded to localhost.

* `.pi/wpi.yml` is team-shared; `~/.pi/wpi.yml` provides personal overrides.

* `wpi build`, `wpi shell`, and `wpi dry-run` are Docker-oriented management commands.

The current package is TypeScript and already separates configuration resolution from Docker operations, which is a good foundation for adding a second backend.

## 2. Why Add a nono Mode?

Docker provides a highly reproducible userspace: Pi, Node, package versions, system packages, and the default package can all be frozen in an image. This is valuable for teams and for extensions that depend on native binaries.

However, Docker Desktop on macOS introduces a Linux VM and can consume substantial memory even when the workload is small. It also adds image/build/mount/user-identity complexity.

[nono](https://nono.sh/) provides a different isolation model:

* native process execution;

* kernel-enforced filesystem isolation via Landlock on Linux and Seatbelt on macOS;

* supervisor-managed network filtering and credential injection;

* audit logs and optional rollback;

* no container or VM overhead;

* child processes inherit the sandbox.

nono is not a replacement for Docker’s reproducible userspace. It is a replacement for much of Docker’s **process isolation**. The two modes should therefore be presented as explicit trade-offs, not as interchangeable implementations.

## 3. Recommended Product Model

Make `wpi` the stable user-facing interface and make the runtime backend configurable:

```text
wpi CLI
  ├── shared config loader / validation / precedence
  ├── shared Pi package + settings preparation
  ├── shared doctor / diagnostics
  ├── shared argument and port handling
  └── runtime backend
        ├── docker: build image, docker run, docker shell
        └── nono: install/check Pi + nono, profile, nono run
```

The default should remain **Docker** initially for backwards compatibility. Users can opt into nono per project or globally:

```yaml
runtime:
  mode: docker # docker | nono
```

A CLI override is useful for experimentation:

```bash
wpi --mode docker
wpi --mode nono
```

The CLI override should not rewrite the YAML file.

## 4. Configuration Strategy

Keep one `wpi.yml`, but separate portable Pi settings from backend-specific settings. Do not pretend that every Docker setting has a nono equivalent.

Example:

```yaml
runtime:
  mode: nono

pi:
  version: 0.83.0
  packages:
    - ./package
  settings:
    defaultThinkingLevel: medium
    autoCompact: true

# Portable intent: what the process should be able to access.
workspace:
  path: ${workspaceDir}
  access: readwrite

network:
  mode: filtered
  allowDomains:
    - api.anthropic.com
    - api.openai.com
    - github.com
  credentials:
    - anthropic
    - github

# Docker implementation details.
docker:
  ports:
    - 3000
  mounts: []
  volumes: []
  memory: 4g
  memorySwap: 4g
  extension: |
    RUN apt-get update && apt-get install -y python3

# nono implementation details.
nono:
  profile: wpi
  allowPaths: []
  readPaths: []
  allowCommands: []
  profileBase: nolabs-ai/pi
```

A less disruptive migration can retain the existing `docker.*` keys and add `nono.*` first. Over time, introduce portable sections (`workspace`, `network`, `pi`) and mark backend-specific fields clearly.

### Configuration precedence

Retain the current precedence:

1. CLI flags

2. `~/.pi/wpi.yml`

3. project `.pi/wpi.yml`

4. built-in defaults

Merge rules should be explicit and backend-neutral where possible. For example, `network.allowDomains` can merge in both modes, while `docker.mounts` only affects Docker and `nono.allowPaths` only affects nono.

### Environment variables

Avoid treating `docker.env` as the canonical secret mechanism. In Docker mode it currently injects values into the container. In nono mode, secrets should preferably be represented as credential routes and resolved by nono’s credential proxy or keychain. `wpi doctor` should warn when a secret-looking value is configured in a plain YAML `env` map.

## 5. Backend Semantics

### Docker backend

`wpi run` should preserve today’s behavior:

```text
resolve config → ensure Docker → ensure image → ensure volumes → docker run
```

`wpi build` has a clear meaning here: regenerate the temporary build context and build/tag the image.

`wpi shell` opens a new container shell or execs into an existing container.

### nono backend

`wpi run` should use nono’s supervised mode:

```text
resolve config → ensure Pi/nono/package/profile → nono run --profile ... -- pi ...
```

Use `nono run`, not `nono wrap`, when filtered networking, credential injection, audit logging, or rollback is needed. The nono supervisor remains outside the sandbox and Pi runs as its child.

A conceptual command:

```bash
nono run \
  --profile wpi \
  --allow-cwd \
  --rollback \
  -- pi --your-arguments
```

The exact generated flags should be profile-driven rather than assembled ad hoc. A user-editable profile should extend the signed `nolabs-ai/pi` pack where appropriate:

```bash
nono pull nolabs-ai/pi
nono profile init wpi --extends nolabs-ai/pi --full
```

### Important non-equivalence

Docker’s `docker.extension` installs arbitrary OS packages in an image. nono cannot reproduce that. In nono mode:

* host tools must already be installed;

* `setup` can check or install dependencies;

* a project can declare required commands and versions;

* `doctor` should report missing tools;

* a Docker-only extension must produce a clear warning or error, not silently disappear.

## 6. Should `build` Be Shared?

The command name can remain shared, but its meaning must be mode-aware.

| Command           | Docker mode                                             | nono mode                                                                                    |
| ----------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `wpi` / `wpi run` | `docker run` Pi                                         | `nono run` Pi                                                                                |
| `wpi build`       | Build/rebuild the Pi image                              | Validate/generate nono profile; optionally prepare local package artifacts                   |
| `wpi setup`       | Install/check Docker and prepare image prerequisites    | Install/check Pi, nono, pack, profile, credentials prerequisites                             |
| `wpi doctor`      | Docker daemon, image, mounts, ports, config, Pi package | nono version/backend, kernel support, profile, Pi binary, package wiring, credentials, paths |
| `wpi shell`       | New Docker shell or `docker exec`                       | `nono run --profile ... -- shell` or a clearly named native shell with the same profile      |
| `wpi dry-run`     | Resolved config + Docker command                        | Resolved config + nono command/profile summary                                               |
| `wpi update`      | Update Pi/image/package and rebuild as needed           | Update Pi/package/nono pack without overwriting custom profile                               |

For nono, `build` should probably be an alias for `prepare` or `validate`, while retaining `build` for cross-mode consistency. The output should say exactly what happened:

```text
nono mode: no image build required
validated profile: ~/.config/nono/profiles/wpi.json
Pi package: installed
```

An eventual `wpi prepare` command could be the semantic command, with `wpi build` retained as a compatibility alias.

## 7. Setup and Doctor

### `wpi setup`

`setup` is the mutating command. It should be explicit, idempotent, and mode-aware.

Docker mode:

1. Check Docker CLI and daemon.

2. Check Node/npm only if building from source is required.

3. Ensure `~/.pi/agent` exists.

4. Build the image when missing or requested.

5. Validate the bundled package and settings.

nono mode:

1. Check platform support: macOS Seatbelt or Linux Landlock.

2. Install or guide installation of `nono` using the platform-appropriate official mechanism.

3. Install or verify Pi.

4. Pull `nolabs-ai/pi`.

5. Create or update a derived `wpi` profile without overwriting user edits.

6. Wire the Pi package/extension into `~/.pi/agent/settings.json`.

7. Validate configured credential routes and network domains.

8. Run a harmless smoke test such as `nono run --profile wpi -- pi --version`.

Do not silently install packages requiring `sudo`. Print the exact command and ask for confirmation, or fail with an actionable instruction in non-interactive mode.

### `wpi doctor`

`doctor` should always report both the selected mode and the relevant state. It can optionally report the inactive backend too, because this helps users switch modes:

```typescript
wpi doctor

Runtime
  active mode: nono
  configured mode: nono

Pi
  executable: OK (0.83.0)
  ~/.pi/agent: OK
  bundled package: OK
  settings wiring: OK

nono
  executable: OK (0.55.x)
  platform backend: OK (macOS Seatbelt)
  profile: OK (~/.config/nono/profiles/wpi.json)
  registry pack: OK (nolabs-ai/pi)
  credentials: WARN anthropic route not configured

Docker (inactive)
  executable: OK
  daemon: not checked / inactive mode
  image: pi-agent:0.83.0 (stale or absent)

Configuration
  project: .pi/wpi.yml
  user: ~/.pi/wpi.yml
  warnings: docker.extension is ignored in nono mode
```

Exit codes should distinguish healthy, warnings, and failures if practical (`0`, `1`, `2`), but avoid making warnings fatal by default.

## 8. Package and Extension Strategy

The Docker implementation currently bakes the default package into the image and installs it on startup. For nono, the same package should be installed natively into Pi’s package area or referenced from the npm-installed `wpi` package.

Recommended approach:

* Keep the default package source in the `wpi` npm package.

* Add a backend-neutral package preparation step.

* Docker copies it into the build context and registers it inside the image.

* nono copies/links it into a controlled host package directory and adds the package entry to Pi settings.

* Make package installation idempotent and versioned.

* Never silently remove user-added packages.

* Detect package collisions and report them in `doctor`.

This preserves the current “stable defaults” advantage without requiring a container in nono mode. It does mean native dependencies from extensions must be supported separately—either through npm packages, host prerequisites, or a documented Docker-only capability.

## 9. Ports and Path Semantics

Docker port forwarding is a container feature. In nono mode Pi runs natively, so a requested port is already a host port. `wpi` should not attempt to forward it.

Recommended behavior:

* `ports` remains a portable declaration of ports the workflow expects.

* Docker maps `host:container`.

* nono validates host-port availability and reports that no forwarding is needed.

* If `host:container` differs in nono mode, fail or warn because there is no container-side port to map.

Paths are more straightforward in nono mode because the host filesystem is used directly. But this removes Docker’s path mirroring illusion and increases the importance of the nono profile. Never translate a Docker mount into broad host access automatically. Require explicit conversion or report it as unsupported.

### Backend-neutral service URLs

Extensions should not hard-code runtime-specific hostnames such as `localhost`, `host.docker.internal`, or a Docker Compose service name. The same extension configuration may need different URLs depending on whether Pi runs in Docker or natively under nono.

Use logical service names in `wpi.yml`, and resolve them centrally in the shared configuration layer:

```yaml
services:
  firecrawl:
    port: 3002
    access: host

extensions:
  web:
    service: firecrawl
```

The resolver turns the logical service into a runtime-specific URL:

| Service location    | Docker URL                         | nono URL                |
| ------------------- | ---------------------------------- | ----------------------- |
| Host service        | `http://host.docker.internal:3002` | `http://127.0.0.1:3002` |
| Same Docker network | `http://firecrawl:3002`            | Not applicable          |
| Remote service      | `https://api.example.com`          | Same URL                |

Extensions should consume environment variables or a resolved configuration value rather than perform this mapping themselves:

```ts
const baseUrl = process.env.FIRECRAWL_BASE_URL;
```

`wpi` injects `FIRECRAWL_BASE_URL` as follows:

```text
Docker → http://host.docker.internal:3002
nono   → http://127.0.0.1:3002
```

For Docker on Linux, `wpi` may need to add `host.docker.internal:host-gateway` to the container. On macOS and Windows Docker Desktop usually provides the hostname automatically. In nono mode, Pi is a host process, so loopback is normally the correct address.

The resolver must distinguish service locations instead of blindly replacing `localhost`: a URL may refer to the host, another container, Pi itself, or a remote service. It should run once after configuration loading and be used for environment injection, `dry-run`, and `doctor` connectivity checks.

Suggested resolver shape:

```ts
function resolveServiceUrl(service: ServiceConfig, mode: "docker" | "nono") {
  if (service.url) return service.url;
  const host = mode === "docker" ? "host.docker.internal" : "127.0.0.1";
  return `http://${host}:${service.port}`;
}
```

`wpi doctor` should report the logical service, resolved URL, and connectivity result. It should warn when a Docker-only hostname appears in a nono configuration, when a `host:container` port mapping has no meaningful nono equivalent, or when an extension references an undefined service.

This keeps extension code backend-agnostic while making runtime differences explicit, testable, and visible to users.

## 11. Security Comparison

| Concern               | Docker mode                                                       | nono mode                                                |
| --------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Filesystem boundary   | Container mounts and permissions                                  | Landlock/Seatbelt capabilities                           |
| Network filtering     | Docker networking plus application behavior                       | Supervisor proxy and kernel restrictions                 |
| Credentials           | Often environment variables or mounts unless carefully configured | Phantom credentials and nono proxy/keychain              |
| Child processes       | Container-contained                                               | Inherit nono restrictions                                |
| Reproducible OS tools | Strong: image pins userspace                                      | Weak-to-moderate: uses host tools                        |
| macOS overhead        | Docker Desktop VM and daemon                                      | Native process, low overhead                             |
| Rollback              | Not inherent; image/container lifecycle                           | nono session rollback available when enabled             |
| Auditability          | Docker logs and host inspection                                   | nono audit chain and supervisor records                  |
| Main risk             | Docker daemon/socket, mounts, VM boundary complexity              | Incorrect profile grants or missing native prerequisites |

Neither mode is automatically “secure.” Docker can be weakened by mounting the Docker socket, SSH keys, broad home paths, or privileged options. nono can be weakened by broad path grants, permissive network rules, or running without the intended profile. `doctor` should flag both classes of risk.

## 12. Recommended Migration Plan

1. Introduce `runtime.mode` with `docker` as the default.

2. Refactor the CLI around a `RuntimeBackend` interface:

   * `checkPrerequisites()`

   * `setup()`

   * `run(piArgs)`

   * `buildOrPrepare()`

   * `shell()`

   * `doctor()`

   * `dryRun()`

3. Move current Docker calls behind `DockerBackend` without changing behavior.

4. Add shared config validation and `wpi doctor` before adding nono execution.

5. Add `NonoBackend` that generates/validates a derived profile and launches `nono run`.

6. Add native package installation and wiring for nono mode.

7. Add cross-backend tests for config merging, command generation, mode-specific warnings, and unsupported settings.

8. Document a migration command such as:

```bash
wpi setup --mode nono
wpi doctor
wpi --mode nono
```

9. Keep Docker as a fallback for projects that require `docker.extension`, native system packages, or exact userspace reproducibility.

## 13. Verdict

The two-mode design is worthwhile, but the abstraction should be **“same wpi workflow, different runtime guarantees,”** not “Docker flags translated mechanically to nono flags.”

Recommended defaults:

* Docker remains the default for compatibility and reproducible environments.

* nono becomes the preferred macOS mode for lightweight native execution and stronger credential/network supervision.

* `wpi.yml` owns intent and shared Pi configuration.

* Backend-specific sections are explicit and validated.

* `setup`, `build`/`prepare`, `doctor`, `shell`, `dry-run`, and `run` remain shared commands with mode-specific implementations.

* `doctor` reports active and inactive backend state, clearly labels ignored settings, and never claims parity where none exists.

* Preserve Docker for extensions that need image-level OS packages; do not force those into nono.

## Key References

* [swarmbit/wrapped-pi](https://github.com/swarmbit/wrapped-pi)

* [wrapped-pi README](https://github.com/swarmbit/wrapped-pi/blob/main/README.md)

* [wrapped-pi CLI](https://github.com/swarmbit/wrapped-pi/blob/main/src/cli.ts)

* [wrapped-pi configuration](https://github.com/swarmbit/wrapped-pi/blob/main/src/config.ts)

* [wrapped-pi Docker backend](https://github.com/swarmbit/wrapped-pi/blob/main/src/docker.ts)

* [nono documentation](https://nono.sh/docs/introduction)

* [nono supervisor mode](https://nono.sh/docs/cli/features/supervisor)

* [nono networking](https://nono.sh/docs/cli/features/networking)

* [nono Pi pack](https://github.com/nolabs-ai/nono-packs/tree/main/pi)

***

## Tags

#wrapped-pi #wpi #docker #nono #pi #sandboxing #developer-tools #typescript #architecture

*Last researched: 2026-08-01.*