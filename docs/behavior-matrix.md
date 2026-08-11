# wpi behavior matrix — mode × sandbox × setting

Every configuration setting documented against every (runtime mode × sandbox)
combination. Semantics: **apply** = takes effect; **warn** = no effect and wpi
reports it (doctor / run-time notice); **ignored** = no effect, silently
accepted (documented here so it is never a surprise).

Legend for the `docker` / `host` columns under each sandbox: the setting's
behavior in that cell.

| Setting | docker + none | docker + nono | host + none | host + nono |
|---|---|---|---|---|
| `runtime.mode` | applies (selects backend) | — | — | — |
| `sandbox.backend` | none (explicit opt-out; doctor warns) | nono (default) | none (explicit opt-out; doctor warns, run prints ⚠ UNSANDBOXED) | nono (default) |
| `pi.version` | **applies** — pins the image's pi (`pi-agent:<version>`) | same | **ignored** — host runs the installed `pi` binary | same |
| `docker.socket` | **ignored** — the client uses `$DOCKER_HOST` as-is | **applies** — granted as `filesystem.unix_socket` in the wpi-docker profile | **ignored** | **ignored** |
| `docker.ports` | **applies** — published `127.0.0.1:host:container` | same (inside the nono-wrapped `docker run`) | **ignored** (simple ports are no-op grants without nono; host:container mapping → **error**) | **applies** — simple ports become `--listen-port` grants; host:container mapping → **error** |
| `docker.mounts` | **applies** — `-v host:container[:mode]` | **applies** — `-v` inside the sandbox AND the host side is granted in the profile (ro → read, rw → allow); a drifted profile missing a grant → **error** (doctor + run-time fail-fast) | **ignored** | **ignored** |
| `docker.volumes` | **applies** — named volumes (daemon-side) | **applies** — named volumes need no host grant (they live in the daemon) | **ignored** | **ignored** |
| `docker.memory` / `docker.memorySwap` | **applies** | **applies** | **ignored** | **ignored** |
| `docker.env` | **applies** — `-e` into the container; secret-looking keys → **warn** (prefer credential routes) | same | **ignored as injection** — values are NOT passed to the host pi process; secret-looking keys still **warn**; keys covered by a credential route → **warn** ("host+none leaks the real key") | **ignored as injection** — use `network.credentials` / `customCredentials` (nono injects phantoms; covered real keys are denied) |
| `docker.extension` | **applies** — appended to the Dockerfile | **applies** | **warn** — "ignored in host mode (no image build)" | **warn** |
| `git.user.name` / `git.user.email` | **applies** — set inside the container | **applies** | **ignored** — host git config is used directly | **ignored** |
| `network.mode` / `allowDomains` / `credentials` / `customCredentials` | **warn** — "host+nono only; no effect in docker mode" | **warn** (same; Phase 4 slice 1 keeps the docker client's network open) | **ignored** — no nono to filter | **applies** — nono proxy, credential routes (route wins → deny_vars) |
| `workspace.allowPaths` / `readPaths` | **ignored** — the project dir is always mounted rw | **ignored** — the wpi-docker profile grants socket/build-ctx/mounts/`~/.pi` only | **ignored** — no nono to grant to | **applies** — merged into `filesystem.allow/read` of the wpi profile |
| `nono.allowPaths` / `readPaths` | **ignored** | **ignored** | **ignored** | **applies** — merged with `workspace.*` |
| `nono.dockerProfile` | **ignored** — no profile used | **applies** — profile name for `nono run --profile <name>` and the authored file | **ignored** | **ignored** — host uses the `wpi` profile |

## Why the surprising cells are the way they are

- **`docker.env` is not injected in host mode.** The host pi process gets its
  environment from nono / your shell. Secrets in `docker.env` would neither be
  passed nor protected — that is why doctor warns and why the documented path
  for host mode is `network.credentials` / `customCredentials` (nono holds the
  real keys in its keystore and injects phantoms).
- **`network.*` does not work in docker mode.** Docker's container networking is
  Docker's; nono only wraps the *client* on the host. Phase 4 slice 1 leaves the
  client's network open (so registry pulls work) — L7 filtering of client
  traffic is a documented later refinement. `network.*` therefore only takes
  effect in host+nono.
- **`pi.version` is docker-only.** The docker image pins a pi version; host mode
  runs whatever `pi` is on PATH (doctor reports which one).
- **Ports in host mode** are *grants*, not forwards — there is no container to
  forward to. Simple ports become `--listen-port` (nono) and are inert without
  nono; a `host:container` mapping is an error in host mode.
- **Grants are per-combination.** The wpi-docker profile grants what the docker
  *client* needs (socket, build context, declared mounts, `~/.pi`); the wpi
  profile grants what *pi* needs (workdir rw + `workspace`/`nono` fs grants +
  network routes). `workspace.*`/`nono.*` fs grants therefore apply only in
  host+nono.

## Warnings & errors at a glance

| Condition | Where | Status |
|---|---|---|
| `docker.extension` set in host mode | doctor — Configuration | warn |
| `network.*` set in docker mode | doctor — Configuration | warn |
| Secret-looking `docker.env` key | doctor — Configuration | warn |
| `docker.env` key covered by a credential route (host+nono) | doctor — Profile | warn ("real key denied, phantom injected") |
| `docker.env` key covered by a route but sandbox=none | doctor — Configuration/Profile | warn ("leaks the real key") |
| host:container port in host mode | run/shell | error |
| `sandbox: none` (either mode) | doctor — Sandbox; run prints ⚠ UNSANDBOXED | warn |
| Mount/socket grant missing from on-disk wpi-docker profile | doctor — Sandbox; run/build fail-fast | error |
| nono binary missing with `sandbox: nono` | checkPrerequisites, doctor, setup | error (with install command) |
