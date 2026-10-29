# The hosted MCP server inside the VM — measure first, then decide (story 4804)

Status: **AC1 and a design paragraph only.** Nothing here changes any service. It is the order of work for story 4804 (INFRA-DIET ⑪): the Cloud Run service `sprintable-mcp-prod` is the largest single item left after the prod move and the removals (about 59 USD a month at the product owner's count: 2,601,864 s × (2.16e-5 per vCPU-s + 0.5 GiB × 2.4e-6)), and the VM's stack has no MCP in it. **Nothing goes to `main` until the prod move and one day after it are over** (the rule of step 4c to step 8 of [CUTOVER-prod.md](CUTOVER-prod.md) goes on to the day after); everything is done on `develop` and the dev VM first. The agent has no cloud access: it writes the lines, the product owner runs them and writes the numbers into the places marked **MEASURE**. A number nobody has measured is written «unmeasured», never guessed.

## 1. What the repository says about the MCP server (so the measurements ask the right question)

| Fact | Where |
|---|---|
| The hosted server is **stateless Streamable HTTP** (`stateless_http=True`): no session is kept between requests; every request carries its own bearer key (the agent's API key), the server holds no key of its own. | `backend/sprintable_mcp/__main__.py` `_run_http` |
| In the HTTP mode **the event bridge is not started** (it belongs to the stdio mode of the lane agents). The HTTP server is tools only. | same, docstring of `_run_http` |
| It listens on `$PORT` (else 8080), path `/mcp`, and refuses a `Host` that is not in `MCP_ALLOWED_HOSTS` (exact names) when that variable is set. | `config.py`, `server.py` (`transport_security`) |
| It is **the backend's own image** started with another command (`python -m sprintable_mcp`, `MCP_TRANSPORT=http`): no image of its own to build. | `backend/scripts/deploy_mcp_prod.sh`, `deploy_mcp_dev.sh` |
| It calls the backend over HTTP at `SPRINTABLE_API_URL` and keeps small caches (`mcp_scope_cache_max_size` 1000 keys); a request body can be as large as 16 MiB (attachments). | `config.py`, `server.py` |
| On Cloud Run it is deployed with `--min-instances=0 --max-instances=2`; the product owner reads **CPU throttling off** (instance-based billing) and about 0.99 billed instances over the last 24 hours. | `deploy_mcp_prod.sh`; product owner's reading |
| The customer-facing name is `mcp.sprintable.ai` (dev: `dev-mcp.sprintable.ai`), a Cloudflare name in front of the `run.app` address; `MCP_ALLOWED_HOSTS` lists both the `run.app` host and `mcp.sprintable.ai`. | `deploy_mcp_prod.sh`, [RUNBOOK §8](RUNBOOK.md) (the `dev-mcp` row of the DNS table) |

**The question the numbers must answer first: why is one instance billed all day?** Cloud Run keeps an instance for about 15 minutes after its last request, and with CPU throttling off it bills the instance for all of that time. The server is stateless, so its requests should be short; if requests come more often than every 15 minutes, round the clock, one instance is billed round the clock **without any long connection at all**. That is a different problem from «a stream is held open», and it has a different and much cheaper answer (below, case A). Only the request log of the service can tell the two apart.

## 2. AC1 — the measurements (read-only; the product owner runs them)

`PROJECT=sprintable-494803`, `REGION=asia-northeast3`; the MCP services are `sprintable-mcp-prod` and `sprintable-mcp-dev`; the VMs are `sprintable-vm-dev` and (after the window) `sprintable-vm-prod`.

**2a. The traffic of `sprintable-mcp-prod`, 7 days: how many requests, how long each lasts, who sends them.** (The platform's request log; paths and methods only, never a key.)

```
SVC=sprintable-mcp-prod
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SVC}\"" --project $PROJECT --freshness=7d --limit=100000 --format='value(timestamp)' | cut -c1-10 | sort | uniq -c
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SVC}\" AND httpRequest.latency>\"30s\"" --project $PROJECT --freshness=7d --limit=100000 --format='value(timestamp)' | cut -c1-10 | sort | uniq -c
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SVC}\"" --project $PROJECT --freshness=7d --limit=100000 --format='value(httpRequest.requestMethod,httpRequest.status)' | sort | uniq -c | sort -rn | head -12
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SVC}\"" --project $PROJECT --freshness=7d --limit=100000 --format='value(httpRequest.userAgent)' | sort | uniq -c | sort -rn | head -10
```

The first line is requests per day; the second is the requests that lasted more than 30 seconds per day (**a stateless server should have none**; any count is a held connection); the third is the methods and answers (a `GET` that answers 405 or 200, a `POST` that answers 200, a 401 for a key that is dead); the fourth is who sends them (user agents, no addresses). A count of 100000 means «at least»: read a shorter `--freshness`. **MEASURE:** requests a day, requests over 30 s a day, the gap between the two busiest-quiet hours, the five biggest user agents.

**2b. The instance and its memory, from Monitoring (7 days, hourly; read-only).** The metrics are Cloud Run's own: `run.googleapis.com/container/billable_instance_time` (seconds billed per second: the 0.99), `container/instance_count` (by `state`: active or idle), `container/memory/utilizations` (the 99th percentile and the maximum), `container/max_request_concurrencies` and `request_count`.

```
TOKEN=$(gcloud auth print-access-token)
END=$(date -u +%FT%TZ); START=$(date -u -v-7d +%FT%TZ)
mon() { curl -s -G -H "Authorization: Bearer $TOKEN" "https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries" --data-urlencode "filter=metric.type=\"$1\" AND resource.labels.service_name=\"${SVC}\"" --data-urlencode "interval.startTime=$START" --data-urlencode "interval.endTime=$END" --data-urlencode "aggregation.alignmentPeriod=3600s" --data-urlencode "aggregation.perSeriesAligner=$2" --data-urlencode "aggregation.crossSeriesReducer=$3"; }
mon run.googleapis.com/container/billable_instance_time ALIGN_RATE REDUCE_SUM | jq '[.timeSeries[]?.points[]?.value.doubleValue] | {hours: length, mean: (add / length), max: max}'
mon run.googleapis.com/container/memory/utilizations ALIGN_PERCENTILE_99 REDUCE_MAX | jq '[.timeSeries[]?.points[]?.value.doubleValue] | {hours: length, p99_max: max}'
mon run.googleapis.com/container/max_request_concurrencies ALIGN_PERCENTILE_99 REDUCE_MAX | jq '[.timeSeries[]?.points[]?.value.doubleValue] | {hours: length, max_concurrent: max}'
mon run.googleapis.com/request_count ALIGN_RATE REDUCE_SUM | jq '[.timeSeries[]?.points[]?.value.doubleValue] | {hours: length, mean_per_s: (add / length), max_per_s: max}'
```

`memory/utilizations` is a fraction of the container's limit (the service's memory is read with `gcloud run services describe $SVC --project $PROJECT --region $REGION --format='value(spec.template.spec.containers[0].resources.limits)'`): **MEASURE** the maximum in MiB = fraction × limit. (A control: `billable_instance_time` must read about 0.99 as the product owner counted; if it does not, the reading is wrong and nothing below is decided on it.)

**2c. The VM's room, on the dev VM now and on the prod VM after the window.** Three samples ten minutes apart in the busy hours (09:00–18:00 KST) and one at 04:00 KST; the figures that matter are what the stack really uses, not what the machine has.

```
gcloud compute ssh sprintable-vm-dev --project $PROJECT --zone asia-northeast3-a --tunnel-through-iap --command "free -m; echo; sudo docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'; echo; uptime; vmstat 1 5"
```

**MEASURE** per sample: `available` of `free -m`, the memory each container holds (`db`, `backend`, `frontend`, `caddy`, `gateway-db` on prod), the load average and the idle percentage of `vmstat`. The machine is an e2-medium (4 GiB, [RUNBOOK §4](RUNBOOK.md)); the database has `shared_buffers=256MB` and `max_connections=60`.

## 3. How the numbers decide

| What the log and Monitoring show | Case | What follows |
|---|---|---|
| Requests are short (none over 30 s) but come at least every 15 minutes all day, and CPU throttling is off | **A. Billing, not a connection** | **Do not move anything yet.** Switch `sprintable-mcp-prod` to request-based CPU (`gcloud run services update sprintable-mcp-prod --project $PROJECT --region $REGION --cpu-throttling`; undo: `--no-cpu-throttling`): an idle instance between short requests is then not billed, so the bill follows the time the requests are really being served. The new monthly figure = the measured active seconds × the request-based rates of the catalog (the product owner reads them), plus the per-request charge; **MEASURE** it after a day. If that is a few dollars, the story is closed without a move, and the VM is spared one more container. |
| Requests over 30 s exist every day (held connections: `GET` streams) | **B. A held connection** | A held request is billed as an active request on either mode of billing, so request-based CPU does not help. Moving the server into the VM is the answer (section 4). First find who holds them (user agent, and whether they come by `mcp.sprintable.ai` or by the `run.app` address): the holders by the Cloudflare name move with a DNS record; the holders of the `run.app` address need the forwarder of step 4c, **and a forwarder that holds the same streams is billed like the service it replaces** (one instance with 1 vCPU all day ≈ 58 USD by the same count) until they move — a saving only if the holders can be moved. |
| The server's memory maximum + the room on the VM | **Fit** | The server fits in the VM if the **lowest** `available` memory of the samples (2c) is at least the server's measured maximum + 256 MiB of margin + the largest request body it can be asked to hold (16 MiB, decoded twice at worst: take 48 MiB), **and** the lowest idle percentage of `vmstat` stays above 30. If it does not fit, the alternatives are written with their price before anything is built: a bigger VM class (e2-standard-2: the price of the class is read from the catalog) or case A on Cloud Run. |

The rule of the table is the author's proposal; the product owner decides it (question 1).

## 4. Design (case B, or case A if it is not enough) — one paragraph

A service `mcp` in `compose.yml`: **the backend's image** (`${BACKEND_IMAGE}`, so a release brings both at the same digest), command `python -m sprintable_mcp`, `MCP_TRANSPORT=http`, `SPRINTABLE_API_URL=http://backend:8000` (the compose network — no turn through the front door and the internet), `MCP_ALLOWED_HOSTS` the one name it is served under, no secret (it holds none: every request brings its own bearer key; the placeholder fallback key of `deploy_mcp_prod.sh` is a constant, not a secret), a memory limit set from the measured maximum (`mem_limit`), `restart: unless-stopped`, `expose: 8080`, a healthcheck on its own port, and `depends_on: backend (healthy)`. The front door gets one more site, `{$MCP_HOST}`, with `reverse_proxy mcp:8080 { flush_interval -1 }` (a stream is sent as it arrives, as for the API), the same filtered logs as the other two sites, and its certificate is Caddy's own; `hosts.mcp` joins `hosts.api`, `.realtime` and `.app` in `env/<environment>.yaml`, and `deployer.py` passes `MCP_HOST` to the Caddy container (a release without the name stops, as for the three others). **The addresses:** (1) the Cloudflare names `dev-mcp` and `mcp` change from a proxied record to the Cloud Run address into a **DNS-only A record to the VM** (a proxy buffers a stream, the reason the other three names are DNS-only): a client that uses the name changes nothing; (2) the `run.app` MCP addresses (`sprintable-mcp-dev-…`, `sprintable-mcp-prod-…`) keep working by the same device as step 4c: one revision of the same service, a Caddy that hands every request to the new name, with its own loop mark, no environment, no secret and an account with no role — built from the same `deploy/vm/forwarder/` (the upstream is a setting of the file, `FORWARD_TO`); (3) when the count of requests that reach the forwarder is zero for the product owner's days, the Cloud Run service goes (a removals sheet of its own, with the way back). **Order:** measure (this file) → decide → `develop` + dev VM (the compose service, the site, the host in `env/dev.yaml`, tests that go red when reverted) → the dev round (an agent lists the tools, calls one and holds a stream through the new name, with the server's own clock) → the security domain reads the key and path exposure → after the prod move and one day: prod.

## Questions for the owner (one line each)

1. Is the rule of section 3 right: «fits» = lowest `available` ≥ the server's maximum + 256 MiB + 48 MiB, and idle above 30%?
2. If the numbers say case A is enough, is closing the story with the billing switch (no move) what is wanted?
3. For case B, who moves the holders of the `run.app` address (nobody: the forwarder keeps them, and costs about the same until they move)?
