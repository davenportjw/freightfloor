# Operations, Deployment, Load Testing & Budgets

## 1. Local Development & Testing

 Note: Docker is not installed on the local Apple Silicon host. Local execution is strictly limited to fast unit tests, TypeScript builds, and in-process integration tests; container image builds run on Google Cloud Build (`gcloud builds submit`).

```bash
# Install dependencies across all workspaces
npm install

# Build all packages, apps, and tools
npm run build

# Run fast offline unit tests (sim, protocol, armor, site, lobby)
npm test

# Run live Vertex AI Gemini 3.5 Flash-Lite brain verification
RUN_LIVE=1 npm run test:live -w @warehouse/site

# Run live Model Armor + Gemini red-team verification against corpus.jsonl
RUN_LIVE=1 npm run test:redteam -w @warehouse/site
```

---

## 2. Cloud Build & Production Deployment (`davenport-boutique`)

### Step 1: Build and Push Container Images
Submit the multi-stage Docker builds (`Dockerfile.site`, `Dockerfile.lobby`, `Dockerfile.loadtest`) to Google Cloud Build, which pushes to Artifact Registry (`us-central1-docker.pkg.dev/davenport-boutique/warehouse/`):

```bash
gcloud builds submit --config=cloudbuild.yaml --project=davenport-boutique .
```

### Step 2: Format, Validate, and Apply Terraform (`infra/`)
Always run `terraform fmt` and `terraform validate` before applying infrastructure changes:

```bash
terraform -chdir=infra fmt
terraform -chdir=infra init
terraform -chdir=infra validate
terraform -chdir=infra apply -var="project_id=davenport-boutique" -var="suffix="
```

This provisions:
- **4 Site Shards**: `site-den-1` (`min=1`, `IDLE_POLICY=run`, 20 agents), `site-slc-2`, `site-phx-3`, `site-abq-4` (`min=0`, `IDLE_POLICY=break`, 12 agents).
- **Lobby Service**: `warehouse-lobby` (`min=0, max=3`).
- **Pub/Sub**: `site-transfers` topic, `site-transfers-dlq`, and 4 filtered OIDC push subscriptions (`attributes.toSite = "<siteId>"`).
- **Secret Manager**: `ticket-hmac-key` with a generated 64-character secret version.
- **Firestore**: 7-day TTL policy on `journal.expireAt`.

### Step 3: Live Verification Probes
After deploying, verify the live stack before marking any deployment complete:

```bash
# 1. Check HTTP healthz endpoints
LOBBY_URL=$(terraform -chdir=infra output -raw lobby_url)
curl -fsS "${LOBBY_URL}/healthz"

# 2. Run live end-to-end game smoke probe (join, WS snapshot, drive 10s, verify gemini-3.5-flash-lite decisions, verify cross-site transfer, cleanup smoke-* docs)
node tools/smoke/live.mjs "${LOBBY_URL}"

# 3. Run live prompt-armor smoke probe (send 5 injection vectors, verify armor_blocked / clamping and journal entries)
node tools/smoke/armor.mjs "${LOBBY_URL}"

# 4. Run the live UI smoke (headless system Chrome via playwright-core; no browser download).
#    Checks clock format, every panel folds + persists across reload, drawer tabs, driving
#    updates the inspector, card hand, live Strategy Board / Value chart updates within 60 s,
#    no console errors. Screenshots (1600x1000, 1280x760) go to tools/smoke/out/ (git-ignored).
#    Teardown: closes the browser/WS and deletes smoke-* player docs (SMOKE_SKIP_FIRESTORE=1 to skip).
#    Override the Chrome binary with CHROME_PATH=...
node tools/smoke/ui.mjs "${LOBBY_URL}"
```

---

## 3. Staging Stack (`-stg`) & 128-Client Load Test (`tools/loadtest`)

To validate 128 concurrent drivers without disrupting production, deploy an isolated staging stack by passing `suffix="-stg"`:

```bash
terraform -chdir=infra apply \
  -var="project_id=davenport-boutique" \
  -var="suffix=-stg" \
  -var="enable_loadtest_job=true"
```

### Full-Flow Bot Architecture (112 Protocol Bots + 16 Gemini Pilots)
The Cloud Run Job `loadtest-128-stg` runs as service account `warehouse-loadtest-stg@`, which has **only `roles/aiplatform.user`** and zero access to Firestore or Secret Manager. Every bot connects purely as an external client through the public lobby and WebSockets:
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
  gcloud run jobs execute loadtest-128-stg --region=us-central1 --project=davenport-boutique --wait
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
     terraform -chdir=infra destroy -var="project_id=davenport-boutique" -var="suffix=-stg" -auto-approve
     ```

---

## 5. Cost Controls & Budget Guardrails

| Resource | Guardrail / Cap | Enforcement Mechanism |
|---|---|---|
| **Site AI Brains (`gemini-3.5-flash-lite`)** | **$12.50 / UTC day** global cap across all sites | Firestore transactional ledger (`budget/{yyyy-mm-dd}`). When exhausted, agents hold with `"daily brain budget reached"`. |
| **Typed Orders (`nlCommand`)** | **$1.50 / UTC day** cap on the daily ledger | Dedicated counter on `budget/{yyyy-mm-dd}` + 6/min per player rate limit + 3-strike 15-min mute. |
| **Loadtest Gemini Pilots** | **$1.50 / job run** (`PILOT_BUDGET_USD=1.5`) | In-process token counter inside `tools/loadtest`; pilots hold when cap is reached. |
| **Overflow Shards (`slc-2`, `phx-3`, `abq-4`)** | `min_instance_count = 0`, `IDLE_POLICY = break`, 12 agents | Automatically enter factory break after 2 minutes with 0 players, freezing the clock and stopping all Gemini calls so Cloud Run scales to zero. |
| **Artifact Registry (`warehouse`)** | Keep last **5 image versions** | Enforced via Terraform `cleanup_policies` (`keep-recent-5`). |
| **Firestore `journal` Collection** | **7-day TTL** | Enforced via Terraform `google_firestore_field.journal_ttl` on `expireAt`. |
