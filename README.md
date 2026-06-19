# wpi

Run [Pi Coding Agent](https://pi.dev/) in Docker with a safety extension and default settings baked into the image.

## Why

Running pi in Docker ensures every team member uses the same environment — same pi version, same safety gates.

`wpi` makes this simple:

- **CWD-respect mounts**: uses `docker run` directly, so `$(pwd)/` is always mounted as `/<dirname>`
- **Identity mirroring**: the container user and home directory match the host — paths are the same inside and outside the container
- **One install**: `npm install -g wpi` works from any directory
- **Baked-in defaults**: safety extension, github theme, and sensible settings — no setup required
- **Port forwarding**: expose container ports for web dev with `-p`

## Install

### From npm (recommended)

```bash
npm install -g wpi
```

### From source

```bash
git clone https://github.com/swarmbit/wrapped-pi.git
cd wpi

# Required dependencies:
#   - Node.js >= 22  (runtime + TypeScript compilation)
#   - Docker         (build and run containers)
#   - npm            (package manager)

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
# From any project directory:
cd my-project
wpi                    # interactive session
wpi -- -p "Summarize"  # print mode
wpi -- -r              # resume session

# With port forwarding for web dev:
wpi -p 3000              # expose port 3000
wpi -p 3000 -p 6006    # expose multiple ports
wpi -p 8080:3000        # host 8080 → container 3000

# Management:
wpi build              # build/rebuild the image
wpi shell              # open a shell in a new container
wpi shell <id>         # exec into an existing container
wpi dry-run            # print config and docker commands (debugging)
```

## How it works

```
┌──────────────────────────────────────────────────────────┐
│                    Docker Container                       │
│                                                          │
│  ┌─────────────────────────────────────────┐             │
│  │  /opt/pi-package/                       │  ◄── Baked  │
│  │    ├── package.json                      │      into   │
│  │    ├── extensions/                       │      image  │
│  │    │   ├── confirm-dangerous/           │             │
│  │    │   ├── tool-sanitizer/              │             │
│  │    │   ├── worktree/                    │             │
│  │    │   ├── llm-log/                     │             │
│  │    │   ├── tps/                         │             │
│  │    │   ├── git-files/                   │             │
│  │    │   └── web/                         │             │
│  │    └── themes/                          │             │
│  │        └── github.json                  │             │
│  └─────────────────────────────────────────┘             │
│         │                                                  │
│         │ pi install /opt/pi-package                      │
│         │ (registers extensions, themes in settings)      │
│         ▼                                                  │
│  ┌─────────────────────────────────────────┐             │
│  │  <host-home>/.pi/       ◄── Host mount (path mirrored) │
│  │  (e.g. /Users/<user>/.pi on macOS)                    │
│  │    └── agent/                                         │
│  │        ├── settings.json   (shared w/ native pi)      │
│  │        ├── auth.json       (shared w/ native pi)      │
│  │        ├── sessions/       (shared w/ native pi)      │
│  │        ├── extensions/                                │
│  │        ├── npm/                                       │
│  │        └── skills/                                    │
│  └─────────────────────────────────────────┘             │
│                                                          │
│  ┌─────────────────────────────────────────┐             │
│  │  /<project-dir>/               ◄── CWD mount         │
│  │    (your project directory)             │             │
│  └─────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────┘
```

- **Baked into the image**: pi binary (pinned version), default pi package (safety extension, github theme), default settings
- **Installed on startup**: `pi install /opt/pi-package` registers the built-in package — extensions and themes are discovered by pi automatically
- **Additional packages**: use `pi install` inside the container to add packages at runtime
- **Mounted from host** (persists across runs): `~/.pi` (settings, auth, sessions, extensions) — mounted at `<host-home>/.pi` so the path is identical inside and outside the container
- **Mounted from CWD** (your project): mounts `$(pwd)` as `/<dirname>` (e.g., `/myproject`)
- **Identity mirroring**: the container creates a user and home directory that match the host (username, UID/GID, and home path), so all paths are consistent between host and container
- **Port forwarding** (optional): `-p` flags expose container ports on `localhost`

Each invocation creates a fresh container. Multiple instances can run simultaneously (no `--name` collision).

## Configuration

wpi reads config from two files (both in YAML format) and CLI flags. All settings are optional — zero config works out of the box.

### Config files

| File | Purpose | Committed? |
|------|---------|------------|
| `.pi/wpi.yml` | Project-level defaults (team-shared) | Yes |
| `~/.pi/wpi.yml` | Personal overrides (all projects) | No |

### Precedence (highest wins)

1. CLI flags (`-p`, `--port`)
2. User config (`~/.pi/wpi.yml`)
3. Project config (`.pi/wpi.yml`)

For `docker.env`, user keys override project keys with the same name. For `docker.mounts` and `docker.volumes`, user entries override project entries on matching container paths and add new entries for different paths.

---

### Full config reference

Here is every supported key in a `wpi.yml` file:

```yaml
# ── Pi settings ────────────────────────────────────────────
pi:
  version: 0.79.1   # pin to a specific pi version (default: baked-in)

# ── Docker settings ────────────────────────────────────────
docker:
  # Expose container ports on localhost so you can access web
  # apps running inside the container from your browser.
  # Formats: simple port, host:container, or range.
  ports:
    - 3000            # localhost:3000 → container:3000
    - 8080:80         # localhost:8080 → container:80
    - 9000-9010       # port range — expands to 11 entries

  # Mount arbitrary host paths into the container.
  # Format: HOST_PATH:CONTAINER_PATH[:MODE]
  # Supported placeholders: ~ or ${home} (host home dir), ${workspaceDir} (project dir)
  # User mounts override project mounts on matching container paths.
  mounts:
    - /var/run/docker.sock:/var/run/docker.sock  # Docker-out-of-Docker
    - ~/.ssh:~/.ssh:ro                           # SSH keys (read-only)

  # Named Docker volumes that persist across all wpi containers.
  # Useful for caching build artifacts (Maven, Gradle, npm, etc.).
  # Format: VOLUME_NAME:CONTAINER_PATH[:MODE]
  # Supported placeholders: ~ or ${home} (host home dir), ${workspaceDir} (project dir)
  volumes:
    - wpi-m2:${home}/.m2
    - wpi-gradle:${home}/.gradle

  # Limit container memory (docker run --memory / --memory-swap).
  memory: 4g
  memorySwap: 4g

  # Environment variables injected into the container at runtime.
  env:
    CUSTOM_VAR: some-value
    NODE_ENV: development

  # Extra Dockerfile instructions appended at image build time.
  # Use this to install system packages or tools. After changing
  # this, rebuild the image with `wpi build`.
  extension: |
    RUN apt-get update && apt-get install -y python3 pip
    ENV PYTHONUNBUFFERED=1

# ── Git settings ───────────────────────────────────────────
# Set the Git author identity for commits made inside the container.
# If not set, wpi infers them from the host git config.
# Precedence: project config > user config > host git config.
git:
  user:
    name: John Doe
    email: john@example.com
```

> **Important:** After changing `docker.extension` or updating wpi,
> you must rebuild the image with `wpi build`. The image is not
> rebuilt automatically on each run — it's only built when it doesn't exist yet.

### Settings reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `pi.version` | `string` | *(baked-in)* | Pin to a specific pi version. Overrides the version bundled with this wpi release. |
| `docker.ports` | `list` | `[]` | Container ports to expose on `127.0.0.1`. Accepts simple ports (`3000`), host:container mappings (`8080:80`), and ranges (`9000-9010`). |
| `docker.mounts` | `list` | `[]` | Custom host-to-container volume mounts. Each entry is `HOST:CONTAINER[:MODE]` (e.g., `/var/run/docker.sock:/var/run/docker.sock` or `~/.ssh:~/.ssh:ro`). Placeholders: `~` or `${home}` (host home dir), `${workspaceDir}` (project dir). User mounts override project mounts on matching container paths. |
| `docker.volumes` | `list` | `[]` | Named Docker volumes created and mounted into the container. Each entry is `VOLUME_NAME:CONTAINER_PATH[:MODE]`. Placeholders: `~` or `${home}` (host home dir), `${workspaceDir}` (project dir). Volumes persist across runs — useful for caches like `.m2`, `.gradle`, or `node_modules`. |
| `docker.memory` | `string` | — | Maximum memory for the container (`docker run --memory`). Example: `4g`. |
| `docker.memorySwap` | `string` | — | Memory+swap limit for the container (`docker run --memory-swap`). Example: `4g`. |
| `docker.env` | `map` | `{}` | Key-value pairs injected as environment variables via `docker run -e`. User config overrides project config per-key. |
| `docker.extension` | `string` | — | Extra Dockerfile content appended during `wpi build`. Use it to install system packages or set image-level `ENV` vars. Requires a manual rebuild. |
| `git.user.name` | `string` | *(host git config)* | Git author name for commits inside the container. Falls back to `git config user.name` from the host. |
| `git.user.email` | `string` | *(host git config)* | Git author email for commits inside the container. Falls back to `git config user.email` from the host. |

### CLI flags

| Flag | Description |
|------|-------------|
| `-p`, `--port PORT` | Publish a container port on localhost (repeatable). Formats: `3000` or `8080:3000`. Port ranges are not supported via CLI — use the config file. |
| `--debug`, `-d` | Enable debug logging. Prints resolved config, docker commands, and container output to stderr. |

### Commands

| Command | Description |
|---------|-------------|
| *(default)* | Run pi interactively in a new container |
| `build` | Build or rebuild the Docker image. Run this after changing `docker.extension` or updating wpi. |
| `shell` | Open a bash shell in a new container (useful for debugging or running arbitrary commands) |
| `shell <id>` | Exec into an existing running container by ID or name. |
| `dry-run` | Print the resolved config and the docker commands that would run, without executing anything. Useful for debugging config resolution. |

### Port details

All ports bind to `127.0.0.1` (localhost only) for security. Ranges (`9000-9010`) are supported in config files but not via CLI flags. If a host port is already in use, `wpi` will report the conflict and exit.

### Example: full project config

```yaml
# .pi/wpi.yml — committed to git, shared by the team
docker:
  ports:
    - 3000            # Next.js dev server
    - 6006            # Storybook
    - 8080:80         # Reverse proxy

  mounts:
    - /var/run/docker.sock:/var/run/docker.sock

  env:
    NODE_ENV: development
    CUSTOM_API_URL: https://api.example.com

  extension: |
    RUN apt-get update && apt-get install -y python3

git:
  user:
    name: Team Bot
    email: bot@example.com
```

After adding `docker.extension`, rebuild the image:

```bash
wpi build
```

### Example: personal override

```yaml
# ~/.pi/wpi.yml — not committed, personal overrides
docker:
  ports:
    - 3000

  env:
    CUSTOM_VAR: personal-value
```

## Multiple instances

Each `wpi` invocation creates a new ephemeral container (`docker run --rm`). Containers don't interfere with each other. The pi config directory (`~/.pi`) is shared on the host, so settings and auth persist across runs.

If you need to run two agents on the same project simultaneously, that's a workflow concern (like two editors on the same files), not a container concern.

## Where config lives

| Host path | Container path | Contents |
|-----------|---------------|----------|
| `$(pwd)` | `/<basename>` | Your project (CWD mount, named after directory) |
| `~/.pi` | `<host-home>/.pi` | Full pi config (mounted at the same path as host) |
| `~/.pi/agent/settings.json` | `<host-home>/.pi/agent/settings.json` | Model, thinking level, preferences |
| `~/.pi/agent/auth.json` | `<host-home>/.pi/agent/auth.json` | OAuth tokens |
| `~/.pi/agent/sessions/` | `<host-home>/.pi/agent/sessions/` | Conversation history |
| `~/.pi/agent/extensions/` | `<host-home>/.pi/agent/extensions/` | User extensions |
| `~/.pi/agent/npm/` | `<host-home>/.pi/agent/npm/` | Installed package data |
| `~/.pi/wpi.yml` | *(not mounted)* | User-level wpi config |

> **Note:** `<host-home>` is the host user's home directory (e.g. `/Users/<user>` on macOS, `/home/<user>` on Linux). The container creates a user with the same username, UID/GID, and home path, so all paths are identical inside and outside the container.

If you use pi both natively and in the container, they share the same config.

## Bundled Extensions

The default package includes several extensions:

- **confirm-dangerous** — Prompts before destructive commands (`rm -rf`, `sudo`, force push, etc.), writes to system paths, and modifications to the pi config directory
- **tool-sanitizer** — Repairs malformed tool arguments before execution (disabled by default, toggle with `/tool-sanitizer:enable`)
- **worktree** — Git worktree management with per-worktree sessions (`/worktree:create`, `/worktree:open`, etc.)
- **llm-log** — Logs all LLM I/O as Markdown (`/llmlog on|off|status`)
- **tps** — Displays tokens-per-second metrics after each agent run
- **git-files** — TUI widget showing changed git files, with `/git-diff` picker
- **web** — Firecrawl-based web browsing and scraping tools (`web_fetch`, `web_search`, `web_screenshot`)

### Web Extension (Firecrawl)

The **web** extension provides three LLM-callable tools backed by the [Firecrawl](https://firecrawl.dev) API:

| Tool | Description |
|------|-------------|
| `web_fetch` | Fetch a URL and extract content as clean markdown |
| `web_search` | Search the web and return results with page content |
| `web_screenshot` | Capture a screenshot of a web page |

**Configuration** (environment variables, set via `docker.env` in `wpi.yml` or passed at runtime):

- `FIRECRAWL_API_KEY` — API key (required for cloud). If missing, tools return a helpful error.
- `FIRECRAWL_BASE_URL` — Base URL for the Firecrawl API. Defaults to `https://api.firecrawl.dev` (cloud). Set to your self-hosted instance URL to use that instead.
- `FIRECRAWL_ALLOWED_DOMAINS` — Comma-separated domain whitelist (e.g. `github.com,docs.firecrawl.dev`). If set, only these domains (and their subdomains) may be fetched/screenshotted. Empty/unset = all domains allowed.
- `FIRECRAWL_CACHE_TTL` — Cache time-to-live in seconds for repeated fetches. Default 300 (5 min). Set to 0 to disable caching.

**Prompt injection defenses** (always active):
- Fetched content is sanitized — HTML/XML tags stripped, `<web_content>` delimiter tags removed to prevent forgery
- Content truncated to 50KB (`web_fetch`) / 2KB per result (`web_search`)
- Content wrapped in `<web_content>` delimiters signaling the LLM it's external data
- System prompt guidelines explicitly tell the LLM to treat web content as untrusted

**LLM verification** (optional, opt-in):
- `WEB_VERIFY_ENABLED` — Set to `"true"` to enable. Disabled by default.
- `WEB_VERIFY_API_KEY` — API key for the guard model.
- `WEB_VERIFY_BASE_URL` — OpenAI-compatible API base URL. Defaults to `https://api.openai.com/v1`.
- `WEB_VERIFY_MODEL` — Model name (e.g. `gpt-4o-mini`, or a local model via `http://localhost:11434/v1` for Ollama).
- `WEB_VERIFY_MAX_CHARS` — Max chars sent to guard (default 5000). Injections are usually at the top.
- `WEB_VERIFY_TIMEOUT_MS` — Guard request timeout (default 10000).

When enabled, a tool-less guard LLM checks fetched/searched content for prompt injection before it reaches the main agent. If injection is detected, the content is blocked and a warning is returned instead. Fails open on guard errors (passes content through with a warning) to avoid blocking all web access when the guard is down.

Check status at any time with the `/web:status` slash command.

Example `wpi.yml` with Firecrawl cloud configured:

```yaml
docker:
  env:
    FIRECRAWL_API_KEY: fc-your-key-here
    FIRECRAWL_ALLOWED_DOMAINS: github.com,docs.firecrawl.dev,stackoverflow.com
    FIRECRAWL_CACHE_TTL: 600
```

### Self-Hosted Firecrawl

Firecrawl is [AGPL-3.0](https://github.com/firecrawl/firecrawl/blob/main/LICENSE) licensed and free to self-host. This avoids API costs and keeps all data on your infrastructure. No API key required for self-hosted instances.

A ready-to-use Docker Compose setup is included in `example/firecrawl/`. It runs Firecrawl **with SearXNG** for privacy-preserving search:

```bash
cd example/firecrawl
cp .env.example .env          # adjust if needed (defaults work for local dev)
docker compose up -d          # starts Firecrawl + SearXNG
```

Services started:

| Service | URL | Purpose |
|---------|-----|---------|
| Firecrawl API | `http://localhost:3002` | Scrape, search, screenshot endpoints |
| SearXNG UI | `http://localhost:8081` | Search engine aggregation (Brave, Startpage, Wikipedia, Wolfram Alpha) |
| Redis | (internal) | Firecrawl job queue |
| PostgreSQL | (internal) | Firecrawl database |
| Playwright | (internal) | Headless browser for JS-rendered pages |

Then point wpi at it — copy `wpi-firecrawl.yml` to your project as `.pi/wpi.yml`:

```yaml
docker:
  env:
    FIRECRAWL_BASE_URL: http://localhost:3002
    # No API key needed for self-hosted
    FIRECRAWL_ALLOWED_DOMAINS: github.com,docs.firecrawl.dev
    FIRECRAWL_CACHE_TTL: 600
```

Verify it's running:

```bash
# Test Firecrawl scrape
curl -X POST http://localhost:3002/v2/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "formats": ["markdown"]}'

# Test SearXNG search
curl 'http://localhost:8081/search?format=json&q=pi+coding+agent'
```

#### SearXNG

SearXNG is a privacy-focused metasearch engine that aggregates results from multiple search engines without tracking. It's included in the compose and wired to Firecrawl by default — the `/v2/search` endpoint uses SearXNG instead of Google.

**Default engines** (enabled out of the box): Brave, Startpage, Wikipedia, Wikidata, Wolfram Alpha. Google/Bing/DuckDuckGo are disabled by default because they rate-limit or block self-hosted instances. You can enable them by editing `searxng-settings.yml`.

**Customizing engines:** edit `example/firecrawl/searxng-settings.yml` and add an `engines` section:

```yaml
use_default_settings: true

server:
  bind_address: "0.0.0.0"
  port: 8080
  secret_key: "your-secret-key"

search:
  formats:
    - html
    - json

engines:
  - name: google
    disabled: false
  - name: duckduckgo
    disabled: false
```

See `example/firecrawl/` for the full setup including `.env.example` with all configurable options.

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
