# Operations, Deployment, Load Testing & Budgets

## 1. Local Development & Testing

 Note: Docker is not installed on the local Apple Silicon host. Local execution is strictly limited to fast unit tests, TypeScript builds, and in-process integration tests; container image builds run on Google Cloud Build (`gcloud builds submit`).

```bash
# Install dependencies across all workspaces
npm install

# Build all packages, apps, and tools (orchestrated & cached via Wireit DAG)
npm run build

# Build a single workspace and its transitive dependencies automatically via Wireit
npm run build -w @warehouse/client

# Run fast offline unit tests (Wireit ensures upstream builds are up-to-date first)
npm test

# Run live Vertex AI Gemini 3.5 Flash-Lite brain verification
RUN_LIVE=1 npm run test:live -w @warehouse/site

# Run live Model Armor + Gemini red-team verification against corpus.jsonl
RUN_LIVE=1 npm run test:redteam -w @warehouse/site
```

**Local lobby + site secrets**: the lobby has no literal fallback HMAC secret. Without `TICKET_HMAC_SECRET` it generates a random per-process secret (with a warning), so tickets, proxy headers, and resume codes won't verify on a separately started site. To run them together locally, export one shared secret in both shells, e.g. `export TICKET_HMAC_SECRET=$(openssl rand -base64 32)`. On Cloud Run a missing secret is fatal. Rotating the secret invalidates every outstanding resume code.

**Site secrets & config** (`@warehouse/site`):
- The site also has no literal HMAC fallback. Outside Cloud Run, a missing `TICKET_SECRET` / `TICKET_HMAC_KEY` / `TICKET_HMAC_SECRET` gives a random per-process dev secret (with a warning). On Cloud Run it is fatal.
- `GEMINI_MODEL` must be one of `ALLOWED_GEMINI_MODELS` (`gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-4-argon`). Any other value aborts startup. Unset means `gemini-3.5-flash-lite`.
- `PUBSUB_PUSH_SERVICE_ACCOUNT` (set by Terraform to `warehouse-pubsub-push@`) is the only identity whose OIDC token `/internal/transfer` accepts. `TRANSFER_PUSH_AUDIENCE` optionally adds accepted audiences (comma-separated) (default `https://<host>/internal/transfer`, which matches the Pub/Sub default of the push endpoint URL).
- Shard failures in message handlers, timers and async paths are logged as `[<siteId>] <what> failed: …` and the shard keeps serving. Watch for these lines and for `unhandledRejection` / `uncaughtException` in Cloud Logging.

**`TRUSTED_PROXY_HOPS`** (`warehouse-lobby`, default `1`, range `0..4`): number of right-most `X-Forwarded-For` hops the lobby trusts when resolving client IPs for rate limiting. `1` matches the Cloud Run `*.run.app` front end; use `2` if an external HTTPS load balancer sits in front of Cloud Run.

---

## 2. Cloud Build & Production Deployment (`davenporter-freightfloor`)

### Step 1: Build and Push Container Images
Submit the multi-stage Docker builds (`Dockerfile.site`, `Dockerfile.lobby`, `Dockerfile.loadtest`) to Google Cloud Build using the least-privilege `warehouse-cloudbuild` service account, which pushes to Artifact Registry (`us-central1-docker.pkg.dev/davenporter-freightfloor/warehouse/`):

```bash
gcloud builds submit --config=cloudbuild.yaml --project=davenporter-freightfloor \
  --service-account=projects/davenporter-freightfloor/serviceAccounts/warehouse-cloudbuild@davenporter-freightfloor.iam.gserviceaccount.com .
```

### Step 2: Format, Validate, and Apply Terraform (`infra/`)
Terraform state is stored remotely in GCS (`gs://davenporter-freightfloor-tfstate/terraform/state` with object versioning, uniform bucket-level access, and public access prevention enabled). Always run `terraform fmt` and `terraform validate` before applying infrastructure changes:

```bash
terraform -chdir=infra fmt
terraform -chdir=infra init
terraform -chdir=infra validate
terraform -chdir=infra apply -var="project_id=davenporter-freightfloor" -var="suffix="
```

This provisions:
- **4 Private Site Shards (Pattern A — Scale-to-Zero Shards)**: `site-den-1` (`min=0`, `IDLE_POLICY=break`, 20 agents) and `site-slc-2`, `site-phx-3`, `site-abq-4` (`min=0`, `IDLE_POLICY=break`, 12 agents). All shards sleep at \$0 when empty and wake on demand when a player joins via the lobby. Restricted via Cloud Run IAM (`roles/run.invoker`) exclusively to `warehouse-lobby` and `warehouse-pubsub-push` with `REQUIRE_PROXY_AUTH=1`.
- **Opt-In Rack Height Fork-Lift Minigame Feature Flag**: Controlled via Terraform `enable_rack_lift_minigame = false` (default disabled), which sets `ENABLE_RACK_LIFT_MINIGAME="0"` (`FEATURE_RACK_LIFT_MINIGAME`) on `@warehouse/site` and advertises `welcome.limits.rackLiftMinigame` to clients. Clients can also toggle or override the minigame per-browser via `?rackLift=1|0` URL query params, `localStorage['warehouse.feature.rackLift']`, or the **☰ → Settings (`⚙`)** flyout toggle.
- **Dispatcher's Call Feature Flag (default on)**: Terraform `enable_dispatchers_call = true` sets `ENABLE_DISPATCHERS_CALL="1"` on `@warehouse/site` (`0|false|off|no` disables it cleanly; unset = on) and advertises `welcome.limits.dispatchersCall`. When on, each Blitz run may get one Gemini question (`gemini-3.5-flash-lite` or the `GEMINI_MODEL` override, Vertex AI `global` via ADC, 4 s timeout, strict response schema, numeric telemetry only). Usage is charged to the daily `agent` budget category; an exhausted budget, model error or invalid output skips the call for that run with a logged error (no fallback question). Players can opt out with the **☰ → Settings** toggle, `?dispatch=1|0` or `localStorage['warehouse.feature.dispatchersCall']`; the client then sends `dispatchersCallPref { enabled: false }`.
- **Public Lobby & WebSocket Gateway Service**: `warehouse-lobby` (`min=1` in prod / `0` for `-stg`, `max=2`, `cpu_idle=true` request-based CPU billing), the only service with `allUsers` invoker access, serving static assets instantly and proxying `/ws?site=<siteId>` to the private site shards.
- **Pub/Sub**: `site-transfers` topic, `site-transfers-dlq`, and 4 filtered OIDC push subscriptions (`attributes.toSite = "<siteId>"`).
- **Secret Manager**: `ticket-hmac-key` with a generated 64-character secret version used for both join tickets and `x-warehouse-proxy` headers.
- **Firestore**: 7-day TTL policy on `journal.expireAt`.

### Step 3: Live Verification Probes
After deploying, verify the live stack before marking any deployment complete. Cloud Run's
container startup probe hits `/healthz` every 5s (3s timeout, 12 failures, so about 60s), which
allows for the 15–25s cold snapshot restore before the server starts listening.

```bash
# 1. Check HTTP health endpoint. Google Front End intercepts the exact path `/healthz`
#    on *.a.run.app (returns its own 404), so probe with a trailing slash: the lobby
#    serves `/healthz/` (and `/sites/<siteId>/healthz/`) as aliases returning JSON.
LOBBY_URL=$(terraform -chdir=infra output -raw lobby_url)
curl -fsS "${LOBBY_URL}/healthz/"

# 2. Run live end-to-end game smoke probe (join, WS snapshot, drive 10s, verify gemini-3.5-flash-lite decisions, verify cross-site transfer, cleanup smoke-* docs).
#    Site services are private, so site checks authenticate: `siteAuthMode: "idtoken"` calls the
#    site's Cloud Run URL directly with an ADC ID token (direct URLs come from SITE_URLS_JSON or
#    the Firestore `sites` docs); otherwise it falls back explicitly to `"lobby-proxy"` via the
#    lobby's `/sites/<siteId>/...` routes (reason in `siteAuthNote`). Both send the
#    `x-warehouse-proxy` HMAC header, signed with `ticket-hmac-key` read from Secret Manager
#    (override with TICKET_HMAC_SECRET_NAME); the caller needs secretAccessor on it.
#    Use GRPC_DNS_RESOLVER=native if Firestore DNS fails locally.
node tools/smoke/live.mjs "${LOBBY_URL}"

# 3. Run live prompt-armor smoke probe (send 5 injection vectors, verify armor_blocked / clamping and journal entries)
node tools/smoke/armor.mjs "${LOBBY_URL}"

# 4. Run the live UI smoke (headless system Chrome via playwright-core; no browser download).
#    HUD v3, following the real drive-first join: intro → contract pick sheet (Esc minimises,
#    ☰ stays usable, ↵ takes the deal and starts the run) → Drive HUD (5 elements, ≤15% coverage
#    once a transient order-choice card has resolved,
#    driving moves the vehicle, hold-Tab Standings, Enter chat, drawer tabs, HUD Minimal (V)
#    persists across reload, Cab View (P) first-person canvas + acks, P back to iso) → Co-Pilot until the 5-minute Blitz ends (RUN_END_WAIT_MS, default
#    360000) → Run complete → "Watch the floor" → Floor HUD (KPI clock format, Floor orders with
#    disabled reasons, floorOrders WS frame, ★ P0 changes server floorOrders, B Team Standings /
#    ☰ Value updates within 60 s, 4 Dispatch drawer, 3 cone mode) → 🚜 Drive [F] again.
#    A spectator join (site at its driver cap) runs the Floor checks first.
#    Always: no overlapping HUD cards (incl. the alert line, feed and Floor-order line), no visible
#    .toast in either mode, ≤1 alert line in Drive, ≤3 feed cards in Floor, no console errors.
#    Takes ~8 min.
#    Screenshots (1600x1000, 1600x900, 1280x760 — Floor view, Team Standings and Dispatch are
#    also captured and overlap-checked at 1280x760) go to tools/smoke/out/ (git-ignored) or argv[3].
#    On any failure diag.json (console + WebSocket open/close/frame types, tickets redacted) is
#    written there too.
#    Teardown: closes the browser/WS and deletes smoke-* player docs (SMOKE_SKIP_FIRESTORE=1 to skip).
#    Override the Chrome binary with CHROME_PATH=... and pass extra flags with CHROME_ARGS=...
#    (e.g. "--disable-features=AsyncDns" if Chrome's own DNS client fails with ERR_NAME_NOT_RESOLVED).
node tools/smoke/ui.mjs "${LOBBY_URL}"
```

---

## 3. Staging Stack (`-stg`) & 128-Client Load Test (`tools/loadtest`)

To validate 128 concurrent drivers without disrupting production, deploy an isolated staging stack by passing `suffix="-stg"`:

```bash
terraform -chdir=infra apply \
  -var="project_id=davenporter-freightfloor" \
  -var="suffix=-stg" \
  -var="enable_loadtest_job=true"
```

### Full-Flow Bot Architecture (112 Protocol Bots + 16 Gemini Pilots)
The Cloud Run Job `loadtest-128-stg` runs as service account `warehouse-loadtest-stg@`, which has **only custom role `warehouseVertexPredict` (`aiplatform.endpoints.predict`)** and zero access to Firestore or Secret Manager. Every bot connects purely as an external client through the public lobby and WebSockets:
1. Calls `POST /api/join` on `warehouse-lobby-stg`.
2. Receives a signed 60-second HMAC ticket.
3. Connects via WebSocket `hello { ticket }`.
4. Plays exclusively using standard client messages (`input`, `interact`, `manager`, `nlCommand`, `keepCards`, `voteDifficulty`).

| Bot Type | Count | Naming Prefix | Behavior |
|---|---|---|---|
| **Protocol Bots** | **112** | `loadtest-001` .. `loadtest-112` | Reads the guide ring target from its own `delta` stream, steers toward it at 10 Hz (`input`), and sends `interact` when `inRange` is true. Exercises WebSocket fan-out, bandwidth quantization, and 10 Hz tick stability across all 4 shards. |
| **Gemini Pilot Agents** | **16** | `pilot-01` .. `pilot-16` | Powered by **Gemini 3.5 Flash-Lite** (`gemini-3.5-flash-lite`). Observes only its own player HUD state, nearby vehicles, open contracts, dealt cards, and event log from `welcome`/`delta`. Every 3–5 s, selects a high-level action (`driveTo(x,y)`, `pickUp`, `drop`, `keepCards`, `typeOrder(text)`, `vote(level)`), carried out by a local 10 Hz steering loop. |

- **Isolated Pilot Budget**: Pilots track spend against `PILOT_BUDGET_USD` (default **$1.50 per run**), separate from the sites' $12.50/day Firestore brain ledger. If a pilot's Gemini call fails, the pilot holds position and logs the error—it never falls back to scripted play.
- **Executing the Load Test**:
  ```bash
  gcloud run jobs execute loadtest-128-stg --region=us-central1 --project=davenporter-freightfloor --wait
  ```

### Load Test Pass Criteria (128 Concurrent Clients over 10 Minutes)
- All 128 clients placed across the 4 shards, with **no shard exceeding 32 drivers**.
- Server 10 Hz tick duration **p95 < 40 ms** per shard.
- Client `input` to `ack` round-trip latency **p95 < 250 ms**.
- Downlink delta bandwidth **< 6 KB/s per client**.
- **Zero** unexpected WebSocket disconnects over the 10-minute run.
- At least **12 of the 16 Gemini pilots** complete at least one pallet delivery.
- **Zero** pilot commands bypass multiplayer governance limits or prompt armor.

---

## 4. Automated Staging Teardown & Cleanup

In accordance with the resource lifecycle policy, every staging load test or smoke run cleans up its cloud state immediately upon completion:
1. **Smoke Cleanup**: `tools/smoke/live.mjs` and `tools/smoke/armor.mjs` delete all `smoke-*` documents from `players` and `journal` in a `finally` block.
2. **Loadtest Teardown (`loadtest-teardown`)**:
   - Deletes all `loadtest-*` and `pilot-*` documents from `players/{clientId}`.
   - Deletes staging snapshots under `sites/*-stg/snapshots/*` and directory docs `sites/*-stg`.
   - Scales all `-stg` Cloud Run services back to zero (or destroys the `-stg` Terraform workspace):
     ```bash
     terraform -chdir=infra destroy -var="project_id=davenporter-freightfloor" -var="suffix=-stg" -auto-approve
     ```

---

## 5. Cost Controls & Budget Guardrails

| Resource | Guardrail / Cap | Enforcement Mechanism |
|---|---|---|
| **Site AI Brains (`gemini-3.5-flash-lite`)** | **$12.50 / UTC day** global cap across all sites + **120 RPM** / **8 concurrent** per shard | Firestore ledger (`budget/{yyyy-mm-dd}`) + `BRAIN_MAX_RPM` sliding-window rate cap in `AgentBrainScheduler`. Each instance buffers spend and writes `FieldValue.increment` every 10 s and on shutdown, and checks a cached doc plus its unflushed delta. When exhausted, agents hold with `"daily brain budget reached"`. Brain calls time out after 4 s. |
| **GCP Cloud Quotas (`aiplatform.googleapis.com` & `modelarmor.googleapis.com`)** | **50M input tokens/day**, **1M input tokens/min**, **120 Model Armor RPM**, **Quota Adjuster DISABLED** | Enforced via Terraform `google_cloud_quotas_quota_preference` (`GlobalGenerateContentInputTokensPerDayPerBaseModel`, `GlobalGenerateContentInputTokensPerMinutePerBaseModel`, `RequestsPerMinute`) and `google_cloud_quotas_quota_adjuster_settings` (`DISABLED`). |
| **Typed Orders (`nlCommand`)** | **$1.50 / UTC day** cap on the daily ledger | Dedicated counter on `budget/{yyyy-mm-dd}` + 6/min per player rate limit + 3-strike 15-min mute. |
| **Loadtest Gemini Pilots** | **$1.50 / job run** (`PILOT_BUDGET_USD=1.5`) | In-process token counter inside `tools/loadtest`; pilots hold when cap is reached. |
| **Overflow Shards (`slc-2`, `phx-3`, `abq-4`)** | `min_instance_count = 0`, `IDLE_POLICY = break`, 12 agents | Automatically enter factory break after 2 minutes with 0 players, freezing the clock and stopping all Gemini calls so Cloud Run scales to zero. |
| **Lobby (`warehouse-lobby`)** | `min_instance_count = 1` (prod; `0` for `-stg`), max 2 | One warm instance avoids the ~10 s cold start on a first visit (pick-up-and-play). Together with `den-1` (`min = 1`), it is the only always-on cost. |
| **Artifact Registry (`warehouse`)** | Keep last **5 image versions** | Enforced via Terraform `cleanup_policies` (`keep-recent-5`). |
| **Firestore `journal` Collection** | **7-day TTL** | Enforced via Terraform `google_firestore_field.journal_ttl` on `expireAt`. |

---

## 6. AST GraphDB Sidecar, Traceability Queries & Benchmarking (`@warehouse/ast-sidecar`)

The repository includes an incremental multi-compiler AST & Cross-Layer Lineage GraphDB Sidecar (`tools/ast-sidecar`) storing its local SQLite Labeled Property Graph and exports in `.ast-graph/` (git-ignored).

### CLI & Traceability Commands
```bash
# Incrementally synchronize all workspace TypeScript, Zod, Fastify, Vitest, and Terraform files
npm run ast:sync

# Lookup a symbol's definition, signature, callers, callees, and covering Vitest suites
npm run ast:query -- symbol SimEngine.step

# Compute 3-hop transitive upstream blast radius and covering test files before editing
npm run ast:query -- blast-radius sanitizeDirective

# List exact Vitest suites and test cases covering a symbol or source file
npm run ast:query -- tests-for packages/sim/src/engine.ts

# Trace end-to-end lineage for a @warehouse/protocol schema, Fastify route, or Terraform resource
npm run ast:query -- lineage ClientMessageSchema

# Find shortest AST dependency path between two symbols
npm run ast:query -- path parseClientMessage step

# Run architectural coupling/instability (Ca, Ce, I), cycle detection, and untested hub analysis
npm run ast:analyze

# Run empirical indexing latency, warm single-file re-index, and token-savings benchmark suite
npm run ast:benchmark

# Export the property graph to openCypher (.ast-graph/export.cypher) and JSONL (.ast-graph/snapshot.jsonl)
npm run ast:export
```

> The sidecar Vitest suite enforces its wall-clock budgets (<100 ms single-file re-index, <50 ms p95 query) strictly only when `AST_STRICT_PERF=1` is set (e.g. `AST_STRICT_PERF=1 npx vitest run tools/ast-sidecar`). In the shared parallel `npx vitest run` it applies a load-tolerant 10× ceiling so that CPU contention from other workers doesn't fail the build.

### Multi-Harness Sidecar, Hooks & MCP Verification
```bash
# Probe the local HTTP sidecar daemon (port 4319)
curl -fsS http://127.0.0.1:4319/health
curl -fsS "http://127.0.0.1:4319/blast-radius?target=SimEngine.step&hops=3"

# Run the AST sidecar unit & integration test suite
npm run test:ast
```
