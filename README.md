# wpi

Run [Pi Coding Agent](https://pi.dev/) with team-standard extensions and settings —
**in Docker or natively on your host**, and **sandboxed by [nono](https://nono.sh) by default** on both.

`wpi` is two independent axes, never conflated:

| Axis | Values | Meaning |
|---|---|---|
| `runtime.mode` | `docker` (default) \| `host` | Where pi executes: container userspace vs. native host process |
| `sandbox.backend` | `nono` (default on **both**) \| `none` | Whether the launched process tree runs under nono supervision |

| Mode | Sandbox | What runs | When to use |
|---|---|---|---|
| `docker` | `nono` | `nono run --profile wpi-docker -- docker run pi` | **Default** — Docker reproducibility **plus** kernel-enforced fs/socket limits on the container's host-side access |
| `docker` | `none` | `docker run pi` (classic wpi) | Explicit opt-out — `doctor` warns |
| `host` | `nono` | `nono run --profile wpi -- pi` | The lightweight native path: no image, Landlock/Seatbelt isolation, credential injection, audit, rollback |
| `host` | `none` | `pi` directly | Debugging / environments where nono can't run — `doctor` warns loudly |

> **Breaking change (wpi ≥ 1.0):** `sandbox.backend` now defaults to `nono` on
> both modes. `sandbox: none` is an explicit opt-out, never a silent fallback.
> See [Upgrading](#upgrading).

## Why

- **One environment per team**: docker mode bakes the same pi version, safety
  gates, extensions, and settings into every container.
- **Host mode when you want native speed**: run pi directly on macOS/Linux with
  kernel sandboxing instead of a container.
- **Sandboxed by default**: nono constrains what the launched process tree can
  touch — on the host (pi) *and* around the docker client (socket + mounts).
- **Secrets via credential routes**: nono holds the real keys; pi gets phantoms.
- **CWD-respect mounts** (docker): `$(pwd)/` is always mounted as `/<dirname>`,
  and the container user/home mirror the host — identical paths inside and out.
- **Baked-in defaults**: safety extension, github theme, sensible settings.
- **One install**: `npm install -g wpi` works from any directory.

## Install

### Prerequisites

- Node.js ≥ 22 (runtime + build)
- **Docker** — required for `docker` mode (build and run containers)
- **nono** — required for `sandbox: nono` (the default):
  `curl -fsSL https://nono.sh/install.sh | sh`
- **pi** — required for `host` mode: `npm install -g @earendil-works/pi-coding-agent`

### From npm (recommended)

```bash
npm install -g wpi
wpi setup          # verify + provision the default (docker+nono) combination
```

### From source

```bash
git clone https://github.com/swarmbit/wrapped-pi.git
cd wpi

npm install        # install TypeScript, vitest, and runtime deps
npm run build      # compile TypeScript → dist/

# Run directly (during development):
node dist/cli.js

# Or install globally from the local checkout:
npm install -g .
wpi build

# Alternatively, use the quick-install script:
./install.sh       # build, uninstall old, install globally, build image
```

## Usage

```bash
# From any project directory — docker+nono is the default:
cd my-project
wpi                    # interactive session
wpi -- -p "Summarize"  # print mode
wpi -- -r              # resume session

# Host mode (native, sandboxed by nono):
wpi --mode host

# Explicitly unsandboxed (doctor will warn):
wpi --mode host --sandbox none

# With port forwarding for web dev (docker mode):
wpi -p 3000              # expose port 3000
wpi -p 3000 -p 6006    # expose multiple ports
wpi -p 8080:3000        # host 8080 → container 3000

# Management:
wpi build              # docker: build/rebuild the image · host: no-op, provisions profile + package
wpi setup              # verify + provision the current mode/sandbox combination (exit 0/1/2)
wpi doctor             # health check (runtime/sandbox/docker/pi/config) (exit 0/1/2)
wpi shell              # docker: shell in a new container · host: sandboxed native shell
wpi shell <id>         # docker only: exec into an existing container
wpi dry-run            # print resolved config and the exact commands (debugging)
```

### `wpi shell` per combination

| Combination | Command |
|---|---|
| docker + none | `docker run … /bin/bash` (classic) |
| docker + nono | `nono run --profile wpi-docker … -- docker run … /bin/bash` |
| host + nono | `nono shell --profile wpi --allow-cwd --rollback` |
| host + none | `$SHELL` natively + `⚠ UNSANDBOXED` notice |

## How it works

### Docker mode

```
┌──────────────────────────────────────────────────────────┐
│                    Docker Container                       │
│                                                          │
│  ┌─────────────────────────────────────────┐             │
│  │  /opt/pi-package/                       │  ◄── Baked  │
│  │    ├── package.json                     │      into   │
│  │    ├── extensions/                      │      image  │
│  │    └── themes/                          │             │
│  └─────────────────────────────────────────┘             │
│         │                                                  │
│         │ pi install /opt/pi-package                      │
│         │ (registers extensions, themes in settings)      │
│         ▼                                                  │
│  <host-home>/.pi  ◄── Host mount (path mirrored)          │
│  /<project-dir>   ◄── CWD mount                           │
└──────────────────────────────────────────────────────────┘
```

When `sandbox: nono`, the whole `docker …` invocation runs under
`nono run --profile wpi-docker --allow-cwd --rollback -- docker …`. The
`wpi-docker` profile (authored by wpi at `~/.config/nono/profiles/wpi-docker.json`,
extends nono's `default`) scopes the **client's host-side footprint**: the daemon
socket (`docker.socket`), build-context temp dirs, declared `docker.mounts`
(ro → read, rw → read-write), and `~/.pi`. Everything else is denied. nono does
**not** filter in-container traffic — that boundary is Docker's.

### Host mode

```
nono run --profile wpi --allow-cwd --rollback -- pi <args>
```

pi runs natively. The `wpi` profile (authored at
`~/.config/nono/profiles/wpi.json`, extends the signed `nolabs-ai/pi` pack)
grants the workspace read-write plus whatever `workspace.*` / `nono.*` fs paths
you declared, and maps `network.*` to nono's proxy + credential routes. The
bundled package is wired natively to `~/.pi/wpi-package/<wpi-version>/` and
registered in `~/.pi/agent/settings.json`.

### Both modes

- **Baked-in package**: default extensions (confirm-dangerous, tool-sanitizer,
  worktree, llm-log, tps, git-files, web), the github theme, and the commit
  skill — from the `package/` dir shipped in the wpi npm package.
- **Shared state**: `~/.pi` (settings, auth, sessions) is used by both modes and
  by native pi directly.
- Each docker invocation creates a fresh container (`--rm`); multiple instances
  can run simultaneously.

## Configuration

wpi reads config from two files (YAML) plus CLI flags. All settings are
optional — zero config works out of the box (docker + nono).

| File | Purpose | Committed? |
|---|---|---|
| `.pi/wpi.yml` | Project-level defaults (team-shared) | Yes |
| `~/.pi/wpi.yml` | Personal overrides (all projects) | No |

**Precedence (highest wins):** CLI flags (`-p`, `--mode`, `--sandbox`) → user
config → project config. `docker.env` user keys override project keys; mounts
and volumes merge (user wins on matching container paths).

### Full config reference

```yaml
# ── Runtime & sandbox (two axes) ──────────────────────────
runtime:
  mode: docker        # docker | host (default: docker)
sandbox:
  backend: nono       # nono | none (default: nono on BOTH modes; none = opt-out)

# ── Pi settings ────────────────────────────────────────────
pi:
  version: 0.79.1     # docker mode: pin the image's pi (default: baked-in)

# ── Docker settings (docker mode) ──────────────────────────
docker:
  socket: /var/run/docker.sock  # daemon socket — granted in the wpi-docker profile
                                # ($DOCKER_HOST unix:// form is honoured)

  # Expose container ports on localhost (simple, host:container, or range).
  ports:
    - 3000
    - 8080:80
    - 9000-9010

  # Mount arbitrary host paths. HOST:CONTAINER[:MODE]
  # Placeholders: ~ or ${home}, ${workspaceDir}
  mounts:
    - /var/run/docker.sock:/var/run/docker.sock  # Docker-out-of-Docker
    - ~/.ssh:~/.ssh:ro                           # SSH keys (read-only)

  # Named Docker volumes that persist across containers.
  volumes:
    - wpi-m2:${home}/.m2

  memory: 4g
  memorySwap: 4g

  # Environment variables injected into the container (docker mode).
  # In host mode these are NOT injected — use network.credentials instead.
  env:
    CUSTOM_VAR: some-value

  # Extra Dockerfile instructions appended at image build time.
  extension: |
    RUN apt-get update && apt-get install -y python3 pip

# ── Git settings (docker mode; host uses your git config) ──
git:
  user:
    name: John Doe
    email: john@example.com

# ── Network / credential routes (host + nono) ──────────────
network:
  mode: filtered      # filtered (default) | open | blocked
  allowDomains:
    - api.anthropic.com
    - github.com
  credentials: [anthropic, github]   # preset services; real keys stay in the supervisor
  customCredentials:                 # non-preset APIs (e.g. Firecrawl)
    firecrawl:
      upstream: https://api.firecrawl.dev
      credentialKey: firecrawl_api_key   # keyring name | env://VAR | op://…
      envVar: FIRECRAWL_API_KEY
      injectHeader: Authorization
      credentialFormat: "Bearer {}"

# ── Extra fs grants beyond the read-write workdir (host + nono) ──
workspace:
  allowPaths: [~/src]
  readPaths: [/etc]

# ── nono profile tuning ────────────────────────────────────
nono:
  allowPaths: [/tmp/build]
  readPaths: [~/.config]
  dockerProfile: wpi-docker  # profile name used when sandboxing docker mode
```

> **Important (docker mode):** after changing `docker.extension` or updating
> wpi, rebuild the image with `wpi build` — it is only built when missing.

### Settings reference

| Key | Default | Mode | Description |
|---|---|---|---|
| `runtime.mode` | `docker` | both | `docker` (container) or `host` (native process) |
| `sandbox.backend` | `nono` | both | `nono` (default) or `none` (explicit opt-out; doctor warns) |
| `pi.version` | *(baked-in)* | docker | Pin the image's pi version (host mode uses the installed `pi`) |
| `docker.socket` | `/var/run/docker.sock` | docker+nono | Daemon socket granted in the wpi-docker profile |
| `docker.ports` | `[]` | docker | Container ports exposed on `127.0.0.1` (host mode: simple ports → `--listen-port` grants) |
| `docker.mounts` | `[]` | docker | Host→container mounts; host side also granted in the wpi-docker profile |
| `docker.volumes` | `[]` | docker | Named volumes (daemon-side; no host grant needed) |
| `docker.memory` / `memorySwap` | — | docker | `docker run --memory / --memory-swap` |
| `docker.env` | `{}` | docker | Container env vars (host mode: not injected — see matrix) |
| `docker.extension` | — | docker | Extra Dockerfile instructions (host mode: warned + ignored) |
| `git.user.name` / `email` | *(host git config)* | docker | Git identity inside the container |
| `network.mode` | `filtered` | host+nono | Proxy mode: filtered / open / blocked |
| `network.allowDomains` | `[]` | host+nono | Domains allowed through the proxy |
| `network.credentials` | `[]` | host+nono | Preset services (openai, anthropic, gemini, google-ai, github, gitlab) |
| `network.customCredentials` | `{}` | host+nono | Custom credential routes (any API) |
| `workspace.allowPaths` / `readPaths` | `[]` | host+nono | Extra fs grants beyond the read-write workdir |
| `nono.allowPaths` / `readPaths` | `[]` | host+nono | Merged with `workspace.*` into the wpi profile |
| `nono.dockerProfile` | `wpi-docker` | docker+nono | Profile name used when sandboxing docker mode |

For the complete behavior of every setting in every combination
(apply / warn / error), see **[docs/behavior-matrix.md](docs/behavior-matrix.md)**.

### CLI flags

| Flag | Description |
|---|---|
| `--mode MODE` | `docker` (default) or `host` — overrides config for this run only |
| `--sandbox BACKEND` | `nono` (default) or `none` — overrides config for this run only |
| `-p`, `--port PORT` | Publish a container port on localhost (repeatable). `3000` or `8080:3000`. Ranges are config-only. |
| `--debug`, `-d` | Debug logging (resolved config + commands to stderr) |

### Commands

| Command | Description |
|---|---|
| *(default)* | Run pi in the configured mode/sandbox |
| `setup` | Provision + verify the combination (profiles, pack, package wiring, smoke test). Exit 0 ready / 1 warn / 2 error |
| `doctor` | Read-only health check (runtime, sandbox, profile, pi, docker, package, config). Exit 0 healthy / 1 warn / 2 error |
| `build` | docker: build/rebuild the image · host: no-op (provisions profile + package) |
| `shell` | docker: bash in a new container · host: sandboxed native shell |
| `shell <id>` | docker only: exec into an existing container |
| `dry-run` | Print resolved config + exact commands without executing |

### Example: full project config

```yaml
# .pi/wpi.yml — committed to git, shared by the team
runtime:
  mode: docker

docker:
  ports:
    - 3000            # Next.js dev server
    - 6006            # Storybook

  mounts:
    - /var/run/docker.sock:/var/run/docker.sock

  env:
    NODE_ENV: development

  extension: |
    RUN apt-get update && apt-get install -y python3

git:
  user:
    name: Team Bot
    email: bot@example.com
```

### Example: host mode with credential routes

```yaml
# .pi/wpi.yml
runtime:
  mode: host

network:
  mode: filtered
  allowDomains:
    - api.anthropic.com
  credentials: [anthropic]
```

## Secrets

- `docker.env` values that look like secrets are flagged by `doctor` — prefer
  nono credential routes.
- **host+nono**: `network.credentials` / `customCredentials` hold the real keys
  in nono's keystore; the covered `env` var is denied in the child and a phantom
  is injected (route wins).
- **host+none**: `docker.env` is not injected at all — a covered key in env
  would leak nothing (it's ignored) but `doctor` still warns you to move it to a
  route.

## Bundled Extensions

The default package includes:

- **confirm-dangerous** — Prompts before destructive commands (`rm -rf`, `sudo`, force push, …)
- **tool-sanitizer** — Repairs malformed tool arguments (disabled by default, `/tool-sanitizer:enable`)
- **worktree** — Git worktree management (`/worktree:create`, …)
- **llm-log** — Logs LLM I/O as Markdown (`/llmlog on|off|status`)
- **tps** — Tokens-per-second metrics after each run
- **git-files** — TUI widget of changed git files, `/git-diff` picker
- **web** — Firecrawl-backed `web_fetch`, `web_search`, `web_screenshot`

The package ships in the wpi npm package (`package/`). Docker mode bakes it into
the image (`/opt/pi-package`); host mode copies it to
`~/.pi/wpi-package/<wpi-version>/` and wires it into settings (idempotent,
never overwrites — delete to regenerate). Extensions that shell out to native
binaries declare them in `package.json` (`wpi.nativeBinaries`); `doctor` and
`setup` verify them on the host.

### Web Extension (Firecrawl)

The **web** extension provides three LLM-callable tools backed by the
[Firecrawl](https://firecrawl.dev) API:

| Tool | Description |
|---|---|
| `web_fetch` | Fetch a URL and extract content as clean markdown |
| `web_search` | Search the web and return results with page content |
| `web_screenshot` | Capture a screenshot of a web page |

**Configuration** (environment variables):

- `FIRECRAWL_API_KEY` — API key (required for cloud; set via `docker.env` or as a credential route in host mode)
- `FIRECRAWL_BASE_URL` — Base URL; default `https://api.firecrawl.dev`; set to a self-hosted instance to use it
- `FIRECRAWL_ALLOWED_DOMAINS` — Comma-separated domain whitelist (empty = all)
- `FIRECRAWL_CACHE_TTL` — Cache TTL seconds (default 300)
- `WEB_VERIFY_ENABLED` / `WEB_VERIFY_MODEL` / `WEB_VERIFY_MAX_CHARS` / `WEB_VERIFY_TIMEOUT_MS` — optional opt-in guard-LLM verification of fetched content

Prompt-injection defenses are always active (sanitized content, truncation,
`<web_content>` delimiters, system-prompt trust guidance). Check status with
`/web:status`.

#### Self-hosted Firecrawl

Firecrawl is [AGPL-3.0](https://github.com/firecrawl/firecrawl/blob/main/LICENSE)
and free to self-host (no API key needed). A Docker Compose setup (Firecrawl +
SearXNG + Redis + PostgreSQL + Playwright) ships in `example/firecrawl/`:

```bash
cd example/firecrawl
cp .env.example .env          # defaults work for local dev
docker compose up -d
```

Then point wpi at it:

```yaml
docker:
  env:
    FIRECRAWL_BASE_URL: http://localhost:3002
    FIRECRAWL_ALLOWED_DOMAINS: github.com,docs.firecrawl.dev
    FIRECRAWL_CACHE_TTL: 600
```

## Upgrading

- **wpi ≥ 1.0 flips `sandbox.backend` to `nono` by default on both modes.** If
  you were running plain docker, add `sandbox: { backend: none }` to
  `~/.pi/wpi.yml` to keep the old behavior — `doctor` will warn until you
  sandbox.
- Missing nono with the default config is an **error** (with the install
  command), never a silent downgrade to unsandboxed.
- Docker-mode `~/.pi/agent/settings.json` may contain a stale `/opt/pi-package`
  entry from older runs; host mode replaces it with the host package path when
  `/opt/pi-package` does not exist on the host.
- Host mode wires the package to `~/.pi/wpi-package/<wpi-version>/` — upgrading
  wpi lands a new versioned copy; delete an old one when you no longer need it.

## Development

```bash
cd wpi
npm install
npm run build          # Compile TypeScript to dist/
npm test               # Run tests
node dist/cli.js dry-run  # Test config resolution
```

## License

MIT
