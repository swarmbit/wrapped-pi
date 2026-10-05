# wpi

Run [Pi Coding Agent](https://pi.dev/) in Docker with a safety extension and default settings baked into the image.

## Why

Running pi in Docker ensures every team member uses the same environment — same pi version, same safety gates.

`wpi` makes this simple:

- **CWD-respect mounts**: uses `docker run` directly, so `$(pwd)` is always mounted at the same absolute path inside the container
- **Identity mirroring**: the container user and home directory match the host — paths are the same inside and outside the container
- **One install**: install once globally, then run `wpi` from any directory
- **Baked-in defaults**: safety extension, github theme, and sensible settings — no setup required
- **Port forwarding**: expose container ports for web dev with `-p`

## Install

wpi is installed from source.

> **Do not run `npm install -g wpi`.** The `wpi` name on the npm registry belongs to an
> unrelated package; this project is not published there.

```bash
git clone https://github.com/swarmbit/wrapped-pi.git
cd wrapped-pi

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
wpi build          # optional: the first `wpi` run builds the image anyway

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
│  │    │   ├── secret-redaction/            │             │
│  │    │   ├── worktree/                    │             │
│  │    │   ├── tps/                         │             │
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
│  │  <project path>                ◄── CWD mount         │
│  │    (same absolute path as on the host)  │             │
│  └─────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────┘
```

- **Baked into the image**: pi binary (pinned version), default pi package (safety extension, github theme), default settings
- **Installed on startup**: `pi install /opt/pi-package` registers the built-in package — extensions and themes are discovered by pi automatically
- **Additional packages**: use `pi install` inside the container to add packages at runtime
- **Mounted from host** (persists across runs): `~/.pi` (settings, auth, sessions, extensions) — mounted at `<host-home>/.pi` so the path is identical inside and outside the container
- **Mounted from CWD** (your project): mounts `$(pwd)` at the same absolute path (e.g., `/Users/alice/dev/myproject`), so file paths in tool output match the host
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

### Precedence

Which file wins depends on what the setting is for.

**Personal runtime settings — your choice wins:**

| Setting | Order (highest first) |
|---------|-----------------------|
| `docker.ports` | CLI flags (`-p`, `--port`) > user config > project config |
| `docker.env` | User keys override project keys with the same name; the rest are merged |
| `docker.mounts`, `docker.volumes` | Merged; a user entry replaces a project entry with the same container path |

**Settings that define the shared environment — the project's choice wins:**

| Setting | Order (highest first) |
|---------|-----------------------|
| `pi.version` | Project config > user config > version bundled with wpi |
| `docker.extension` | Project config > user config (one block is used, they are not concatenated) |
| `docker.memory`, `docker.memorySwap` | Project config > user config |
| `git.user.name`, `git.user.email` | Project config > user config > host git config |

---

### Full config reference

Here is every supported key in a `wpi.yml` file:

```yaml
# ── Pi settings ────────────────────────────────────────────
pi:
  version: 1.0.0    # pin to a specific pi version (default: baked-in)

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
  # Use this to install system packages or tools. Changing it
  # produces a new image, built automatically on the next run.
  extension: |
    RUN apt-get update && apt-get install -y python3 pip
    ENV PYTHONUNBUFFERED=1

# ── Git settings ───────────────────────────────────────────
# Set the Git author identity for commits made inside the container.
# If not set, wpi infers them from the host git config.
git:
  user:
    name: John Doe
    email: john@example.com
```

### Images

Each image is tagged `pi-agent:<pi version>-<fingerprint>`. The fingerprint covers everything
that goes into the build: the Dockerfile (including `docker.extension`), the entrypoint, and the
bundled extensions and settings. So:

- Changing `docker.extension`, changing `pi.version`, or updating wpi gives a tag that does not
  exist yet, and the next `wpi` run builds it. No manual rebuild is needed.
- Projects with different `docker.extension` blocks get separate images instead of overwriting
  each other.
- `wpi build` still forces a rebuild of the current image, for example to pick up newer base
  image or OS packages.

Images of earlier configurations are not removed automatically. List them with
`docker images pi-agent` and delete the ones you no longer need with `docker rmi <tag>`.

### Settings reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `pi.version` | `string` | *(baked-in)* | Pin to a specific pi version. Overrides the version bundled with this wpi release. |
| `docker.ports` | `list` | `[]` | Container ports to expose on `127.0.0.1`. Accepts simple ports (`3000`), host:container mappings (`8080:80`), and ranges (`9000-9010`). |
| `docker.mounts` | `list` | `[]` | Custom host-to-container volume mounts. Each entry is `HOST:CONTAINER[:MODE]` (e.g., `/var/run/docker.sock:/var/run/docker.sock` or `~/.ssh:~/.ssh:ro`). Placeholders: `~` or `${home}` (host home dir), `${workspaceDir}` (project dir). User mounts override project mounts on matching container paths. |
| `docker.volumes` | `list` | `[]` | Named Docker volumes created and mounted into the container. Each entry is `VOLUME_NAME:CONTAINER_PATH[:MODE]`. Placeholders: `~` or `${home}` (host home dir), `${workspaceDir}` (project dir). Volumes persist across runs — useful for caches like `.m2`, `.gradle`, or `node_modules`. |
| `docker.memory` | `string` | — | Maximum memory for the container (`docker run --memory`). Example: `4g`. |
| `docker.memorySwap` | `string` | — | Memory+swap limit for the container (`docker run --memory-swap`). Example: `4g`. |
| `docker.env` | `map` | `{}` | Key-value pairs injected as environment variables. Values are handed to Docker through a private temporary env file rather than the command line, so they do not appear in process listings. User config overrides project config per-key. |
| `docker.extension` | `string` | — | Extra Dockerfile content appended at image build time. Use it to install system packages or set image-level `ENV` vars. Each distinct block gets its own image, built on the next run. |
| `git.user.name` | `string` | *(host git config)* | Git author name for commits inside the container. Falls back to `git config user.name` from the host. |
| `git.user.email` | `string` | *(host git config)* | Git author email for commits inside the container. Falls back to `git config user.email` from the host. |

### CLI flags

| Flag | Description |
|------|-------------|
| `-p`, `--port PORT` | Publish a container port on localhost (repeatable). Formats: `3000` or `8080:3000`. Port ranges are not supported via CLI — use the config file. |
| `--debug`, `-d` | Enable debug logging. Prints resolved config, docker commands, and container output to stderr. `docker.env` values are masked. |

### Commands

| Command | Description |
|---------|-------------|
| *(default)* | Run pi interactively in a new container |
| `build` | Build or rebuild the Docker image for the current configuration. Optional: a missing image is built on first use. |
| `shell` | Open a bash shell in a new container (useful for debugging or running arbitrary commands) |
| `shell <id>` | Exec into an existing running container by ID or name. |
| `dry-run` | Print the resolved config and the docker commands that would run, without executing anything. Useful for debugging config resolution. `docker.env` keys are listed with their values masked. |

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

The first `wpi` run after adding or changing `docker.extension` builds the matching image.

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
| `$(pwd)` | `$(pwd)` | Your project (CWD mount, same absolute path) |
| `~/.pi` | `<host-home>/.pi` | Full pi config (mounted at the same path as host) |
| `~/.pi/agent/settings.json` | `<host-home>/.pi/agent/settings.json` | Model, thinking level, preferences |
| `~/.pi/agent/auth.json` | `<host-home>/.pi/agent/auth.json` | OAuth tokens |
| `~/.pi/agent/sessions/` | `<host-home>/.pi/agent/sessions/` | Conversation history |
| `~/.pi/agent/extensions/` | `<host-home>/.pi/agent/extensions/` | User extensions |
| `~/.pi/agent/npm/` | `<host-home>/.pi/agent/npm/` | Installed package data |
| `~/.pi/wpi.yml` | *(not mounted)* | User-level wpi config |

> **Note:** `<host-home>` is the host user's home directory (e.g. `/Users/<user>` on macOS, `/home/<user>` on Linux). The container creates a user with the same username, UID/GID, and home path, so all paths are identical inside and outside the container. If the entrypoint cannot assign the host UID/GID it prints a `wpi: warning:` line at startup.

If you use pi both natively and in the container, they share the same config.

## Bundled Extensions

The default package includes several extensions:

- **confirm-dangerous** — Allows simple standalone `rm` commands scoped to the workspace or `/tmp` without confirmation; prompts for other destructive commands (`sudo`, force push, forced/recursive removals elsewhere, etc.) and for writes or edits outside the workspace, `/tmp`, and `~/.pi`. Paths are judged where they really land: `~`, `..`, and symlinks are resolved first
- **secret-redaction** — Automatically replaces detected credentials with reversible placeholders in model-visible content
- **dynamic-system-prompts** — Select Markdown instructions from `.pi/system-prompts/` to append to the session system prompt (`/system-prompts`; see [extension README](package/extensions/dynamic-system-prompts/README.md))
- **subagent** — Delegates work to isolated agents with live parallel/nested progress and reported cost (see `package/extensions/subagent/PLAN.md` for interactive controls)
- **multiagent** — Persistent background agents with separate live Pi conversation views, steering, follow-ups, and individual stop controls (`/multiagents`; see `package/extensions/multiagent/README.md`)
- **worktree** — Git worktree management with per-worktree sessions (`/worktree:create`, `/worktree:open`, etc.)
- **orchestrator** — Experimental named virtual sessions, editor-based task routing, and aggregate usage (`/orchestrator`; see [extension README](package/extensions/orchestrator/README.md) and [local Laya Compose example](example/laya/README.md))
- **tps** — Displays tokens-per-second metrics after each agent run
- **web** — Firecrawl-based web browsing and scraping tools (`web_fetch`, `web_search`, `web_screenshot`)

### Secret redaction

Enabled automatically with the bundled package; no configuration or proxy is needed.
After installing an updated wpi, start a new container; the image is rebuilt on that run.

The extension learns credential values from environment variables, Pi `auth.json`
and `models.json`, wpi configuration, and `.env`/`.env.*` and `.npmrc` files in the
current directory. Files accessed through `read`, `edit`, or `write` are also scanned.
Source scanning skips symlinks, non-regular files, and files larger than 1 MiB; it
never executes credential commands or sources shell files. Request and tool-result
text is inspected for credential field names, authorization headers, URL passwords,
private keys, and common provider-token formats. Short/common values are masked only
in credential contexts to avoid corrupting ordinary code.

Source code assigns expressions to names like `password` and `token` far more often
than literals, so the unquoted right-hand side of an assignment found in free text is
judged by its shape:

| Right-hand side | Example | Treatment |
|-----------------|---------|-----------|
| Unmistakably code | `generatePassword()`, `await`, `null`, `string` | Left as is |
| Shaped like an identifier | `accessToken`, `req.headers.authorization`, `hunter` | Masked where it is assigned, not searched for elsewhere |
| Anything else | `Summer2024x`, `a-hyphenated-value`, `sk-...` | Masked everywhere |

Quoted strings, structured credential fields, environment variables, and values in
`.env`/`.npmrc` files are literals and are always masked everywhere, whatever they look
like. A value first seen as identifier-shaped becomes a full secret as soon as one of
those sources confirms it.

To add credential field or environment-variable names, set `secretRedaction.keys`
in `~/.pi/wpi.yml` or the project's `.pi/wpi.yml`:

```yaml
secretRedaction:
  keys:
    - CUSTOM_CREDENTIAL
    - databaseCode
```

Both lists are combined with built-in detection. Names match exactly after
camelCase, case, and separator normalization (`databaseCode` matches
`DATABASE_CODE`); they are not regexes or suffix patterns. Values under these names
are learned from environment variables, scanned files, structured fields, and text
assignments. Changes are picked up on the next request; previously learned secrets
remain protected for the session. Invalid key lists block redaction rather than
silently disabling it. Do not put secret values in this list.

Detected values become opaque `__WPI_SECRET_...__` placeholders in user input,
tool results, conversation context, system prompts, and provider request bodies.
Before tool execution, placeholders in string arguments are restored. Original files,
environment variables, and provider authentication remain unchanged. Subagent tasks
stay masked, and child agents can resolve the same mappings. Compaction, branch
summaries, and the web verification LLM also receive sanitized content.

Mappings persist locally under `<agent-dir>/secret-redaction/` (normally
`~/.pi/agent/secret-redaction/`) to support resume, reload, forks, and subagents.
These files **contain plaintext credentials**, with `0600` files in `0700` directories;
they are not included as session entries. Treat them as sensitive, including in backups.
Removing them invalidates old placeholders; re-read the original credential source
rather than reusing an unresolved token. Retain mappings while their sessions are useful.

Unknown placeholders block tool execution. Literal shell substitutions containing
shell metacharacters are also blocked: use a quoted environment-variable reference
or load the credential from its local file instead. Sanitizer failures abort the
operation and withhold content rather than returning the original request/output.

**Scope:** this is best-effort LLM privacy, not credential isolation. Tools can still
read secrets and use them in network requests. Detection can miss unknown formats,
encoded/transformed values, partial values, and credentials in images or binary data;
opaque provider signatures are left untouched. Local transcripts, partial tool output,
and other extensions' logs are not guaranteed secret-free. Third-party extensions
making direct LLM requests must explicitly use the shared
`redactForLlm(value, ctx)` helper from `secret-redaction/state.ts`; arbitrary API calls
and later hooks that reintroduce secrets are outside this filter's coverage.

### Web Extension (Firecrawl)

The **web** extension provides three LLM-callable tools backed by the [Firecrawl](https://firecrawl.dev) API:

| Tool | Description |
|------|-------------|
| `web_fetch` | Fetch a URL and extract content as clean markdown |
| `web_search` | Search the web and return results with page content |
| `web_screenshot` | Capture a screenshot of a web page |

**Configuration** (environment variables, set via `docker.env` in `wpi.yml` or passed at runtime):

- `FIRECRAWL_API_KEY` — API key. Required for Firecrawl cloud; without it the tools return a helpful error. Optional when `FIRECRAWL_BASE_URL` points at a self-hosted instance, where it is sent only if set.
- `FIRECRAWL_BASE_URL` — Base URL for the Firecrawl API. Defaults to `https://api.firecrawl.dev` (cloud). Set to your self-hosted instance URL to use that instead.
- `FIRECRAWL_ALLOWED_DOMAINS` — Comma-separated domain whitelist (e.g. `github.com,docs.firecrawl.dev`). If set, only these domains (and their subdomains) may be fetched/screenshotted. Empty/unset = all domains allowed.
- `FIRECRAWL_CACHE_TTL` — Cache time-to-live in seconds for repeated fetches. Default 300 (5 min). Set to 0 to disable caching.

**Prompt injection defenses** (always active):
- Fetched content is sanitized — HTML/XML tags stripped, `<web_content>` delimiter tags removed to prevent forgery. Search result titles and URLs are sanitized the same way, since they are page-controlled too
- Content truncated to 50KB (`web_fetch`) / 2KB per result (`web_search`)
- Content wrapped in `<web_content>` delimiters signaling the LLM it's external data
- System prompt guidelines explicitly tell the LLM to treat web content as untrusted

**LLM verification** (optional, opt-in):
- `WEB_VERIFY_ENABLED` — Set to `"true"` to enable. Disabled by default.
- `WEB_VERIFY_MODEL` — Model ID for the guard LLM (e.g. `gpt-4o-mini`). Must be a model already configured in Pi via `/login` or `models.json`. Uses Pi's built-in auth — **no separate API key or base URL needed**.
- `WEB_VERIFY_MAX_CHARS` — Max chars sent to guard (default 5000). Injections are usually at the top.
- `WEB_VERIFY_TIMEOUT_MS` — Guard request timeout (default 10000).

When enabled, a tool-less guard LLM checks fetched/searched content for prompt injection before it reaches the main agent. The request goes through Pi's model registry, which selects the provider and supplies its credentials — the guard model must already be configured in Pi. If injection is detected, the content is blocked and a warning is returned instead. Fails open on guard errors (passes content through with a warning) to avoid blocking all web access when the guard is down.

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
    # The agent runs in its own container, where "localhost" is that container.
    # host.docker.internal reaches services published on the host.
    FIRECRAWL_BASE_URL: http://host.docker.internal:3002
    # No API key needed for self-hosted
    FIRECRAWL_ALLOWED_DOMAINS: github.com,docs.firecrawl.dev
    FIRECRAWL_CACHE_TTL: 600
```

`host.docker.internal` is provided by Docker Desktop and Colima. On a plain Linux Docker
engine, use the address of the host on the Docker bridge network instead (usually
`172.17.0.1`), or the address of the machine running Firecrawl.

Verify it's running, from the host:

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

#### Local screenshots with Playwright

Self-hosted Firecrawl engines may not support screenshots. An optional independent
Playwright service is included; fetch/search continue using Firecrawl.

1. In the Compose `.env`, set `SCREENSHOT_TOKEN` to a strong random secret
   (for example, generated with `openssl rand -hex 32`).
2. Start it: `docker compose --profile screenshots up -d --build screenshot`.
3. In `~/.pi/wpi.yml`, under `docker.env`, configure:

   ```yaml
   WEB_SCREENSHOT_URL: http://host.docker.internal:3003
   WEB_SCREENSHOT_TOKEN: your-secret-from-step-1
   ```

For a remote server, replace `host.docker.internal` with its address. The service
binds to host loopback by default; for Docker Desktop or remote clients, set
`SCREENSHOT_BIND` to a reachable host interface (or `0.0.0.0`) in Compose `.env`.
Restrict port 3003 with a firewall. Use TLS via a reverse proxy outside a trusted LAN:
the bearer token and screenshots otherwise travel over plain HTTP.

From the updated wrapped-pi checkout, run `npm run build && npm install -g .` and
restart wpi; the image is rebuilt with the extension changes on that run.
`web_screenshot` returns a PNG image directly when this backend is configured,
honors `fullPage`, and retains the extension's domain whitelist. It does not cache
local images. Unset `WEB_SCREENSHOT_URL` to use Firecrawl screenshots instead.

This is a trusted-client service: authenticated clients and rendered pages can
access networks reachable from its container, including private addresses. Do not
expose it publicly or treat the domain whitelist as network isolation. Screenshots
are limited to two concurrent requests, 10 MB per image, and a bounded browser
lifetime. No images are persisted.

#### Isolated browser computer use

With the screenshot service configured above, the `web_browser` tool controls a
persistent, isolated Chromium session on the same backend. Use `action: start`
(with optional `url`) to obtain a `sessionId`, then reuse it for `navigate`,
`inspect`, `screenshot`, `click`, `type`, `scroll`, `press`, `evaluate`, and `close`.
`inspect` returns bounded page text and selectors for visible controls; a
`screenshot` returns an inline image. `click` accepts either a CSS selector or
viewport `x`/`y`; `type` fills a selector or types into the focused element.
`evaluate` executes an expression **inside the web page** and returns a bounded
string/JSON result (it can change page state). Session cookies persist only
within that isolated browser; popups and downloads are disabled. Sessions expire
after 10 idle minutes, and at most four are allowed. Always close sessions when
done. Session state does not survive service restarts.

Only explicit `start`/`navigate` URLs are checked against the extension's domain
whitelist; redirects, links, scripts, and `evaluate` can access other network
addresses. Do not use this service for untrusted agents or expose it publicly.
Page content and `evaluate` results are untrusted and may contain prompt injection.
The tool is intentionally not a desktop controller or a bridge to your personal
browser profile.

## Development

```bash
cd wrapped-pi
npm install
npm run build          # Compile TypeScript to dist/
npm run typecheck      # Typecheck every bundled extension
npm test               # Build, typecheck, and run all tests
node dist/cli.js dry-run  # Test config resolution
```

The pi version wpi ships is set in `src/version.ts`. The `@earendil-works/*` devDependencies
are pinned to the same version, so the extensions are typechecked and tested against the pi
they run on; a test fails if the two drift apart. CI runs `npm test` on Linux and macOS.

## License

MIT
