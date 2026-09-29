# Laya multilingual — local Jev-compatible API

Run [Laya](https://github.com/NandhaKishorM/laya) on CPU with
`POST /v1/systemone`, the Jev/System One typed-question protocol. This example
installs Laya 0.3.21 and CPU-only PyTorch 2.14.0, runs as a non-root user, and
preloads the multilingual checkpoint. No hosted Jev account or GPU is needed.

## Start and test

Requirements: Docker with Compose v2+, internet access for the image build and
first model download. Budget 8 GB of Docker memory and 10 GB of free disk.

```bash
cd example/laya
docker compose up -d --build --wait --wait-timeout 900
curl --fail-with-body http://127.0.0.1:8000/health
curl --fail-with-body http://127.0.0.1:8000/v1/systemone \
  -H 'Content-Type: application/json' --data-binary @request.json
```

The bundled request is Portuguese. Inspect `answers.department.choice`,
`answers.department.probabilities`, and `usage` in the JSON response. Predictions
are model outputs, not guaranteed classifications.

First startup can take several minutes while weights download from Hugging Face;
check progress with `docker compose logs -f laya`. Models persist in a named
volume. `docker compose down` keeps them; `docker compose down --volumes` deletes
them. Adjust host port or CPU threads with `LAYA_PORT=9000` or `LAYA_THREADS=2`
before the Compose command. Keep threads at or below available physical cores.

**Always send `"model": "multilingual"`**, including for English requests.
`LAYA_MODELS=multilingual` only selects what to preload; omitting the request model
allows Laya's router to select and download another checkpoint. Multilingual's
default context is 1,024 tokens and long inputs may be truncated. Standalone API
clients can set `max_len` explicitly; the current wpi adapter does not set it.

## Connect wpi's orchestrator

Merge [`wpi-laya.yml`](wpi-laya.yml) into `~/.pi/wpi.yml` or your project's
`.pi/wpi.yml`, then start a new wpi process. The endpoint includes
`/v1/systemone`, and `WPI_ORCHESTRATOR_DECISION_MODEL` pins `multilingual`.
Use `/orchestrator on <name>` to enable routing.

wpi runs in a separate container: **localhost there is not the host or Laya**.
The Compose port defaults to host loopback for safe host-only testing.

- **Docker Desktop:** use `host.docker.internal` as in the config example. If
  loopback publication is not reachable from your container, publish on a
  reachable host interface as described below.
- **Linux Docker Engine:** `host.docker.internal` is not automatically available
  in wpi. Use a host IP reachable from the wpi container (such as the Docker bridge
  gateway), and publish Laya on that interface. The Compose service name `laya`
  only resolves for containers on this Compose network, not wpi's default network.
- **Native Pi on the host:** use `http://127.0.0.1:8000/v1/systemone` and export
  the decision URL/model in the Pi process environment instead of wpi config.

For publication beyond loopback, set a strong bearer key and restrict access with
a firewall. For example, supply `LAYA_API_KEY` privately in your shell, then run:

```bash
# LAYA_API_KEY must already contain your chosen secret.
: "${LAYA_API_KEY:?Set a strong private bearer key first}"
export LAYA_API_KEY
LAYA_BIND_ADDRESS=0.0.0.0 docker compose up -d --build --wait --wait-timeout 900
```

Prefer a specific reachable interface over `0.0.0.0` when possible. Set the same
key as `WPI_ORCHESTRATOR_DECISION_API_KEY` in your private wpi config, and add
`-H "Authorization: Bearer $LAYA_API_KEY"` to API test requests. `/health` does
not require authentication. Never commit secrets or embed them in endpoint URLs;
use a TLS reverse proxy for remote access. Compose's server key is a runtime
environment variable, visible to users with Docker inspection access.

The orchestrator sends incoming text and up to three session context summaries to
this endpoint. Preloading avoids cold-start requests exceeding its eight-second
timeout. Ambiguous scores, errors, or timeouts fall back to manual selection.
Validate routing on your workload: its experimental thresholds are not a
calibration guarantee. See the [orchestrator README](../../package/extensions/orchestrator/README.md).

Upstream references: [HTTP serving and Docker](https://nandhakishorm.github.io/laya/docker/)
and [Jev-compatible server](https://github.com/NandhaKishorM/laya#self-hosting-http-server-jev-compatible).
