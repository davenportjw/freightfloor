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
- Inbound transfers arrive by **streaming pull** on `site-transfers-<siteId>` (override with `TRANSFERS_SUBSCRIPTION`); see `docs/architecture.md`. The legacy push route remains: `PUBSUB_PUSH_SERVICE_ACCOUNT` (set by Terraform to `warehouse-pubsub-push@`) is the only identity whose OIDC token `/internal/transfer` accepts. `TRANSFER_PUSH_AUDIENCE` optionally adds accepted audiences (comma-separated) (default `https://<host>/internal/transfer`, which matches the Pub/Sub default of the push endpoint URL).
- `GEMINI_PRICE_INPUT_PER_M` / `GEMINI_PRICE_OUTPUT_PER_M` (USD per 1M tokens, default Vertex list price `0.30` / `2.50` from `GEMINI_FLASH_LITE_PRICE_PER_M_TOKENS`) price every call on the `budget/{yyyy-mm-dd}` ledger. Before 2026-11-02 the ledger used `0.075` / `0.30` and under-counted real spend about 5x, so the daily cap never engaged.
- Shard failures in message handlers, timers and async paths are logged as `[<siteId>] <what> failed: …` and the shard keeps serving. Watch for these lines and for `unhandledRejection` / `uncaughtException` in Cloud Logging.

**`TRUSTED_PROXY_HOPS`** (`warehouse-lobby`, default `1`, range `0..4`): number of right-most `X-Forwarded-For` hops the lobby trusts when resolving client IPs for rate limiting. `1` matches the Cloud Run `*.run.app` front end; use `2` if an external HTTPS load balancer sits in front of Cloud Run.

---

## 2. Cloud Build & Production Deployment (`davenporter-freightfloor`)

### Step 1: Build and Push Container Images
`scripts/deploy.sh` does Steps 1 and 2 in one go. It refuses a dirty tree, builds with `_TAG=<short git SHA>`, writes `image_tag = "<sha>"` to the gitignored `infra/image_tag.auto.tfvars`, then runs `terraform fmt -check`, `validate` and `apply`. Terraform is the only thing that should change running images: a `gcloud run services update --image` deploy leaves Terraform pointing at a different tag, and the next plain `terraform apply` rolls the services back.

To build by hand, submit the multi-stage Docker builds (`Dockerfile.site`, `Dockerfile.lobby`, `Dockerfile.loadtest`) to Google Cloud Build using the least-privilege `warehouse-cloudbuild` service account, which pushes to Artifact Registry (`us-central1-docker.pkg.dev/davenporter-freightfloor/warehouse/`) as both `:<_TAG>` and `:latest`:

```bash
gcloud builds submit --config=cloudbuild.yaml --project=davenporter-freightfloor \
  --service-account=projects/davenporter-freightfloor/serviceAccounts/warehouse-cloudbuild@davenporter-freightfloor.iam.gserviceaccount.com \
  --substitutions=_TAG=$(git rev-parse --short HEAD) .
```

Then set `image_tag` to that SHA (in `infra/image_tag.auto.tfvars` or with `-var image_tag=...`) before applying.

### Step 2: Format, Validate, and Apply Terraform (`infra/`)
Terraform state is stored remotely in GCS (`gs://davenporter-freightfloor-tfstate/terraform/state` with object versioning, uniform bucket-level access, and public access prevention enabled). Always run `terraform fmt` and `terraform validate` before applying infrastructure changes:

```bash
terraform -chdir=infra fmt
terraform -chdir=infra init
terraform -chdir=infra validate
terraform -chdir=infra apply   # reads infra/terraform.tfvars (gitignored)
```

Copy `infra/terraform.tfvars.example` to `infra/terraform.tfvars` and fill in your own values
(`project_id`, `ga_measurement_id`, `billing_account_id`, …). `*.tfvars` is gitignored, so
account IDs and analytics IDs stay out of the repo; equivalent `-var=` flags work too.

`ga_measurement_id` is optional; see [§8 Analytics Setup (GA4)](#8-analytics-setup-ga4).

This provisions:
- **4 Private Site Shards (Pattern A — Scale-to-Zero Shards)**: `site-den-1` (`min=0`, `IDLE_POLICY=break`, 20 agents) and `site-slc-2`, `site-phx-3`, `site-abq-4` (`min=0`, `IDLE_POLICY=break`, 12 agents), each **1 vCPU / 1 GiB** (`site_cpu` / `site_memory`, `cpu_idle=false`, `startup_cpu_boost=true`). All shards sleep at \$0 when empty and wake on demand when a player joins via the lobby; inbound Pub/Sub transfers no longer wake them (pull delivery). Restricted via Cloud Run IAM (`roles/run.invoker`) exclusively to `warehouse-lobby` with `REQUIRE_PROXY_AUTH=1`.
- **Opt-In Rack Height Fork-Lift Minigame Feature Flag**: Controlled via Terraform `enable_rack_lift_minigame = false` (default disabled), which sets `ENABLE_RACK_LIFT_MINIGAME="0"` (`FEATURE_RACK_LIFT_MINIGAME`) on `@warehouse/site` and advertises `welcome.limits.rackLiftMinigame` to clients. Clients can also toggle or override the minigame per-browser via `?rackLift=1|0` URL query params, `localStorage['warehouse.feature.rackLift']`, or the **☰ → Settings (`⚙`)** flyout toggle.
- **Dispatcher's Call Feature Flag (default on)**: Terraform `enable_dispatchers_call = true` sets `ENABLE_DISPATCHERS_CALL="1"` on `@warehouse/site` (`0|false|off|no` disables it cleanly; unset = on) and advertises `welcome.limits.dispatchersCall`. When on, each Blitz run may get one Gemini question (`gemini-3.5-flash-lite` or the `GEMINI_MODEL` override, Vertex AI `global` via ADC, 4 s timeout, strict response schema, numeric telemetry only). Usage is charged to the daily `agent` budget category; an exhausted budget, model error or invalid output skips the call for that run with a logged error (no fallback question). Players can opt out with the **☰ → Settings** toggle, `?dispatch=1|0` or `localStorage['warehouse.feature.dispatchersCall']`; the client then sends `dispatchersCallPref { enabled: false }`.
- **Public Lobby & WebSocket Gateway Service**: `warehouse-lobby` (`min=1` in prod / `0` for `-stg`, `max=2`, `cpu_idle=true` request-based CPU billing), the only service with `allUsers` invoker access, serving static assets instantly and proxying `/ws?site=<siteId>` to the private site shards.
- **Pub/Sub**: `site-transfers` topic, `site-transfers-dlq`, and 4 filtered **pull** subscriptions (`attributes.toSite = "<siteId>"`, 7-day retention, no expiry) with `roles/pubsub.subscriber` for `warehouse-site@` on each.
- **Cost visibility (prod only)**: the `google_billing_budget` "freightfloor monthly" budget (`monthly_budget_usd`, default \$400; emails billing admins at 50/90/100% actual and 100% forecast). Created only when `billing_account_id` is set; see [§7](#7-cloud-billing-export--cost-review).
- **Secret Manager**: `ticket-hmac-key` with a generated 64-character secret version used for both join tickets and `x-warehouse-proxy` headers.
- **Firestore**: 7-day TTL policy on `journal.expireAt`; TTL policy on the `entries` collection group's `expireAt` (`google_firestore_field.daily_entries_ttl`): Daily Shift entries expire 120 days after their day, Weekly League entries 400 days after their week ends.
- **Weekly League**: no scheduler. The first `GET /api/league` of a new week finalizes the previous week (podium, `leagueWins`, `bestLeagueRank`) in an idempotent transaction; a failure is logged as `league week finalization failed` and retried on the next read without failing the board. A board read failure returns `503 league_unavailable`. A site write failure is logged and sent to the driver as `error` `league_record_failed`.

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

- **Isolated Pilot Budget**: Pilots track spend against `PILOT_BUDGET_USD` (default **$1.50 per run**), separate from the sites' $10/day Firestore brain ledger. If a pilot's Gemini call fails, the pilot holds position and logs the error—it never falls back to scripted play.
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
| **Site AI Brains (`gemini-3.5-flash-lite`)** | **$10 / UTC day** global cap across all sites + **120 RPM** / **8 concurrent** per shard | Firestore ledger (`budget/{yyyy-mm-dd}`) + `BRAIN_MAX_RPM` sliding-window rate cap in `AgentBrainScheduler`. Each instance buffers spend and writes `FieldValue.increment` every 10 s and on shutdown, and checks a cached doc plus its unflushed delta. When exhausted, agents hold with `"daily brain budget reached"`. Brain calls time out after 4 s. |
| **GCP Cloud Quotas (`aiplatform.googleapis.com` & `modelarmor.googleapis.com`)** | **50M input tokens/day**, **1M input tokens/min**, **120 Model Armor RPM**, **Quota Adjuster DISABLED** | Enforced via Terraform `google_cloud_quotas_quota_preference` (`GlobalGenerateContentInputTokensPerDayPerBaseModel`, `GlobalGenerateContentInputTokensPerMinutePerBaseModel`, `RequestsPerMinute`) and `google_cloud_quotas_quota_adjuster_settings` (`DISABLED`). |
| **Typed Orders (`nlCommand`)** | **$1.50 / UTC day** cap on the daily ledger | Dedicated counter on `budget/{yyyy-mm-dd}` + 6/min per player rate limit + 3-strike 15-min mute. |
| **Loadtest Gemini Pilots** | **$1.50 / job run** (`PILOT_BUDGET_USD=1.5`) | In-process token counter inside `tools/loadtest`; pilots hold when cap is reached. |
| **Overflow Shards (`slc-2`, `phx-3`, `abq-4`)** | `min_instance_count = 0`, `IDLE_POLICY = break`, 12 agents | Automatically enter factory break after `IDLE_BREAK_MS` (default 90 s) with 0 players, freezing the clock and stopping all Gemini calls so Cloud Run scales to zero. |
| **Crawler join gate (`warehouse-lobby`)** | `POST /api/join` → `403 crawler_not_allowed` for self-identified crawlers | `isCrawlerUserAgent` matches AdsBot/Googlebot/GoogleOther/Chrome-Lighthouse, SEO/AI scrapers, and generic `FooBot/1.0` / `(+https://…)` agents, so they never wake a shard or spend Gemini calls. `node` and `HeadlessChrome` (smoke/load harnesses) are allowed. |
| **Lobby (`warehouse-lobby`)** | `min_instance_count = 1` (prod; `0` for `-stg`), max 2 | One warm instance avoids the ~10 s cold start on a first visit (pick-up-and-play). Together with `den-1` (`min = 1`), it is the only always-on cost. |
| **Artifact Registry (`warehouse`)** | Keep last **5 image versions**, delete anything older than **7 days** | Terraform `cleanup_policies` `keep-recent-5` (KEEP, wins) + `delete-older-than-7d` (DELETE). A KEEP rule alone deletes nothing. |
| **Project spend** | **\$400 / month** budget alert | `google_billing_budget.monthly` (50/90/100% actual, 100% forecast). Detailed cost data comes from the Cloud Billing BigQuery export (see §7). |
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

---

## 7. Cloud Billing Export & Cost Review

Budgets only alert; to see *where* money goes you need the Cloud Billing export to BigQuery.
The export is configured per **billing account** (it covers every project on that account), so
keep it in a shared admin project rather than in this stack. Account IDs belong in your
gitignored `infra/terraform.tfvars`, never in docs or code.

**1. Find your billing account.**

```bash
gcloud billing projects describe <project_id> --format='value(billingAccountName)'
# -> billingAccounts/XXXXXX-XXXXXX-XXXXXX
```

**2. Create a destination dataset** (US multi-region is required for backfill) in your admin project:

```bash
bq --location=US mk --dataset <admin_project>:billing_export
```

**3. Turn the export on (console only).** Billing → *your account* → **Billing export** →
**BigQuery export** → *Detailed usage cost* → **Edit settings** → choose `<admin_project>` and
`billing_export` → **Save**. Data appears within a few hours. The detailed export has no
historical backfill; the standard export backfills the current and previous month. Tables are
named `gcp_billing_export_resource_v1_<ACCOUNT_ID_WITH_UNDERSCORES>` (detailed) and
`gcp_billing_export_v1_…` (standard).

**4. Add the budget alert.** Set `billing_account_id` (and optionally `monthly_budget_usd`) in
`infra/terraform.tfvars` and `terraform apply`. Leaving it empty skips the budget, which is what
you want if your budgets are managed centrally (e.g. in the same admin project as the export).

**5. Query spend.** Weekly net spend for this project by service:

```sql
SELECT service.description AS service,
       ROUND(SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 2) AS net_usd
FROM `<admin_project>.billing_export.gcp_billing_export_resource_v1_<ACCOUNT_ID>`
WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
  AND project.id = '<project_id>'
GROUP BY service ORDER BY net_usd DESC;
```

**Before the export has data**, Cloud Monitoring still shows the main cost drivers:

| Driver | Metric |
|---|---|
| Gemini calls / tokens | `aiplatform.googleapis.com/publisher/online_serving/model_invocation_count`, `.../token_count` (split by `type` = input/output) |
| Site wakeups | `run.googleapis.com/container/instance_count` per `service_name` |
| Who woke a site | Cloud Run request logs for `POST /api/join` (`httpRequest.userAgent`) and `/internal/wake` |

Multiply tokens by the prices in `GEMINI_PRICE_INPUT_PER_M` / `GEMINI_PRICE_OUTPUT_PER_M`
(`apps/site/src/persistence.ts`) for an estimate.

Cost levers already applied (2026-11-02 review of week 1, Oct 24–31, est. ~\$130/week):

| Lever | Change |
|---|---|
| Gemini ledger pricing | `estimateGeminiFlashCostUsd` uses \$0.30 / \$2.50 per 1M (was \$0.075 / \$0.30, ~5x under-count). |
| Gemini tokens per call | Lean `GEMINI_RESPONSE_SCHEMAS` (descriptions are billed as prompt tokens, ~-45 input tokens), `reason`/`note` ≤ 40 chars, `maxOutputTokens: 80`. |
| Site compute | 1 vCPU / 1 GiB shards (was 2 vCPU / 4 GiB at <5% p95 CPU), startup CPU boost. |
| Idle shard wakeups | Pull transfer subscriptions instead of push, so idle shards can scale to zero. |
| Egress | `permessage-deflate` on site→lobby and lobby→browser WebSockets (~-92% bytes). |
| Lobby min instance | Removed the `cab` traffic tags. A tagged revision keeps its own `min_instance_count`, which had kept a second lobby instance warm 24/7. Avoid leaving tags on `min=1` services. Both services now declare `traffic { type = LATEST, percent = 100 }` in Terraform, because removing tags with `gcloud run services update-traffic` pins the named revision, and later applies then roll out revisions that get no traffic. |
| Firestore | Ranked leaderboard query + 30 s cache; callsign point lookups instead of a 500-doc scan per new player. |
| Log volume | Transfer publish retries back off 5 s and log once per failure streak (a stale `site-transfers-cab` revision logged 1.26M stack-trace lines in one day). |
| Crawler wakeups | Lobby `POST /api/join` returns `403 crawler_not_allowed` for self-identified crawlers (AdsBot, Googlebot, Lighthouse, …), which were waking `den-1` for ~5 min of brain calls each. |
| Idle brain window | `DEFAULT_IDLE_BREAK_MS` 5 min → 90 s (`IDLE_BREAK_MS` env override); most visitors bounce within seconds. |

## 8. Analytics Setup (GA4)

The client ships GA4 support, but it is off until you give the lobby a measurement ID.

1. In [Google Analytics](https://analytics.google.com/) create a property and a **Web** data
   stream for your domain. Copy its **Measurement ID** (`G-XXXXXXXXXX`) from Admin → Data streams.
2. Put it in the gitignored `infra/terraform.tfvars` as `ga_measurement_id = "G-XXXXXXXXXX"` and
   `terraform apply`. Terraform sets `GA_MEASUREMENT_ID` on `warehouse-lobby` (prod stack only;
   `-stg` stacks never get it). For local runs, set `GA_MEASUREMENT_ID` in `.env`.
3. The lobby serves the ID at `GET /api/config` and only then adds Google's tag hosts to its CSP.
   With no ID the CSP stays strict and no tag loads.
4. Mark the key events in GA4 → Admin → Events: `site_join`, `level_start`, `level_end`,
   `manager_command`, `agent_command`, `return_visit`, `unlock_achievement` (mapping in
   `apps/client/src/analytics.ts`). `unlock_achievement` `{ achievement_id: 'livery_<id>' }` fires
   once per livery the browser announces; `livery_equip` `{ livery_id }` fires on each equip sent.
5. Verify with GA4 **DebugView** or **Realtime** after loading the site once.

To script steps 1 and 4 (property, stream, key events, custom dimensions and metrics) instead of
using the console, see [analytics-automation.md](analytics-automation.md).

Note: the measurement ID is public by design (every visitor's browser sees it), but keeping it
in tfvars lets forks point analytics at their own property instead of yours.

### Retention

Day boundaries for retention (and for the upcoming Daily Shift, streaks, and weekly league) are
**UTC midnight**, with ISO weeks starting Monday 00:00 UTC (`dayKey` / `weekKey` in
`@warehouse/protocol`).

- **GA4 `return_visit`** `{ days_since_last, active_days }` fires on the first boot of a later
  UTC day than the browser's previous visit (`localStorage['ff.visits']`, `apps/client/src/visits.ts`).
  It is not sent on a player's first day (GA4's own `first_visit` covers that). Use a GA4 cohort
  exploration on `return_visit` for classic D1/D7 retention.
- **Server ledger.** On every human `POST /api/join` the lobby advances `firstSeenDay`,
  `lastSeenDay`, and `activeDays` on `players/{clientId}` (`LobbyStore.recordVisit`, a Firestore
  transaction, at most one write per player per day). It runs off the response path: a failed
  write is logged as `recordVisit failed` and never blocks the join. Bots are never recorded.
- **Report.** `npm run report:retention -- [--as-of YYYY-MM-DD] [--json]` reads that ledger with
  ADC (read-only, creates nothing) and prints **unbounded** D1/D7/D30 retention: the share of each
  eligible cohort whose `lastSeenDay` is at least N days after `firstSeenDay`. Players who
  predate the ledger are listed as skipped.
