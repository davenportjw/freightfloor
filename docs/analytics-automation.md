# Automating Google Analytics 4 Setup

Clicking through the GA4 console is slow, easy to get wrong, and leaves no record. This guide
shows how to script GA4 setup with the **Google Analytics Admin API**: properties, web data
streams, key events, custom dimensions and metrics, retention, and Google signals. The setup
then lives in the repo next to the code that sends the events. The first half is general and
works for any web app. The second half is the Freight Floor spec.

> **No secrets belong in this repo.** Every ID below is a placeholder (`<account-id>`,
> `<property-id>`, `G-XXXXXXXXXX`). Auth uses Application Default Credentials (ADC) or
> service-account impersonation, never downloaded JSON keys. Real IDs go in gitignored files
> (`.env`, `infra/terraform.tfvars`) or are passed as flags at run time.

---

## 1. What can and can't be automated

| Task | Admin API | Notes |
|---|---|---|
| Create a GA account | `accounts:provisionAccountTicket` | Partly. A human must accept the terms of service in a browser. Usually you create the account once by hand or reuse an existing one. |
| Create a property | `v1beta properties.create` | Set `timeZone` (for example `Etc/UTC`) and `currencyCode`. |
| Create a web data stream | `v1beta properties.dataStreams.create` | The response contains `webStreamData.measurementId` (`G-…`). |
| Mark key events (formerly "conversions") | `v1beta properties.keyEvents.create` | Replaces the deprecated `conversionEvents`. |
| Custom dimensions | `v1beta properties.customDimensions.create` | Event, user, or item scope. |
| Custom metrics | `v1beta properties.customMetrics.create` | Event scope, with a unit (`STANDARD`, `CURRENCY`, `SECONDS`, …). |
| Data retention | `v1beta properties.updateDataRetentionSettings` | The default is 2 months; standard properties allow up to 14. |
| Google signals | `v1alpha properties.updateGoogleSignalsSettings` | Alpha surface. |
| Audiences | `v1alpha properties.audiences.create` | Alpha surface; the filter schema is verbose. |
| Explorations (funnels, cohorts) | none | Manual in the UI. |
| Reading report data | Analytics **Data** API (a separate API) | Not covered here. |

Terraform's official `google` provider has **no** GA4 resources. A small script against the
Admin API is the practical "infrastructure as code" for GA4.

---

## 2. Authentication without keys

You need the scope `https://www.googleapis.com/auth/analytics.edit`, plus a principal with the
**Editor** (or Administrator) role on the GA account or property. GA permissions are managed in
GA (Admin → Account access management), **not** in Cloud IAM.

### Option A: your user account through ADC

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/analytics.edit,https://www.googleapis.com/auth/cloud-platform

# Quota/billing project for the API calls (the API must be enabled there)
gcloud services enable analyticsadmin.googleapis.com --project=<quota-project>
gcloud auth application-default set-quota-project <quota-project>
```

> If Google blocks gcloud's built-in OAuth client for the Analytics scope ("This app is
> blocked"), create a **Desktop** OAuth client in your own project and pass
> `--client-id-file=<path-outside-the-repo>.json`. The client file identifies an app. It is not
> a user credential, but keep it out of git anyway.

### Option B: service-account impersonation (CI-friendly, still no keys)

1. Create a service account, for example `ga-provisioner@<quota-project>.iam.gserviceaccount.com`.
2. In GA → Admin → Account access management, add that email as **Editor**.
3. Grant yourself (or your CI identity) `roles/iam.serviceAccountTokenCreator` on it.
4. Mint short-lived tokens:

```bash
gcloud auth print-access-token \
  --impersonate-service-account=ga-provisioner@<quota-project>.iam.gserviceaccount.com \
  --scopes=https://www.googleapis.com/auth/analytics.edit
```

In CI, use Workload Identity Federation so no long-lived key ever exists.

---

## 3. The API by example (curl)

```bash
TOKEN=$(gcloud auth application-default print-access-token)
API=https://analyticsadmin.googleapis.com
H=(-H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: <quota-project>" -H "Content-Type: application/json")
```

**Find your account**

```bash
curl -s "${H[@]}" "$API/v1beta/accountSummaries"
```

**Create a property**

```bash
curl -s "${H[@]}" -X POST "$API/v1beta/properties" -d '{
  "parent": "accounts/<account-id>",
  "displayName": "My Game (prod)",
  "timeZone": "Etc/UTC",
  "currencyCode": "USD",
  "industryCategory": "GAMES"
}'
# → { "name": "properties/<property-id>", ... }
```

**Create a web data stream and read the measurement ID**

```bash
curl -s "${H[@]}" -X POST "$API/v1beta/properties/<property-id>/dataStreams" -d '{
  "type": "WEB_DATA_STREAM",
  "displayName": "web",
  "webStreamData": { "defaultUri": "https://example.com" }
}'
# → { "webStreamData": { "measurementId": "G-XXXXXXXXXX", ... } }
```

**Mark a key event**

```bash
curl -s "${H[@]}" -X POST "$API/v1beta/properties/<property-id>/keyEvents" -d '{
  "eventName": "level_end",
  "countingMethod": "ONCE_PER_EVENT"
}'
```

**Register an event-scoped custom dimension and metric**

```bash
curl -s "${H[@]}" -X POST "$API/v1beta/properties/<property-id>/customDimensions" -d '{
  "parameterName": "site_id",
  "displayName": "Site",
  "scope": "EVENT",
  "description": "Regional shard the event came from"
}'

curl -s "${H[@]}" -X POST "$API/v1beta/properties/<property-id>/customMetrics" -d '{
  "parameterName": "deliveries",
  "displayName": "Deliveries",
  "scope": "EVENT",
  "measurementUnit": "STANDARD"
}'
```

**Retention and Google signals**

```bash
curl -s "${H[@]}" -X PATCH \
  "$API/v1beta/properties/<property-id>/dataRetentionSettings?updateMask=eventDataRetention" \
  -d '{ "eventDataRetention": "FOURTEEN_MONTHS" }'

curl -s "${H[@]}" -X PATCH \
  "$API/v1alpha/properties/<property-id>/googleSignalsSettings?updateMask=state" \
  -d '{ "state": "GOOGLE_SIGNALS_DISABLED" }'
```

Client libraries wrap the same calls: `@google-analytics/admin` (Node,
`AnalyticsAdminServiceClient`) and `google-analytics-admin` (Python). Both pick up ADC
automatically.

---

## 4. Patterns for a provisioning script

1. **Declarative spec in the repo.** Keep one file listing key events, dimensions, and metrics,
   ideally next to the code that sends the events. The script reconciles GA4 toward it.
2. **Idempotent reconcile, not blind create.** `list` what exists (`keyEvents`,
   `customDimensions`, `customMetrics`, `dataStreams`), diff by `eventName` / `parameterName`,
   and create only what's missing. Re-running is a no-op.
3. **`--dry-run` first.** Print the plan (`+ create customDimension site_id`) before any
   writes, like `terraform plan`.
4. **Never delete automatically.** Custom definitions can't be renamed (`parameterName` and
   `scope` are immutable). Archiving frees a quota slot but is destructive. Have the script
   *report* extras and leave archiving to a human.
5. **Parity test in CI.** A unit test should assert that every param the client sends is in
   the spec and vice versa. GA4 config then can't silently drift from code.
6. **Print the measurement ID, don't commit it.** Output `G-…` and tell the operator where it
   goes (an env var, a gitignored tfvars file, or Secret Manager). The ID is visible to every
   browser, so it isn't secret. Keeping it out of git still lets forks use their own property.
7. **Separate prod and staging properties.** Pass the property ID as a flag or env var. Never
   hardcode it.

### Limits and gotchas

- **Registration isn't retroactive.** A param shows up in reports only from the moment its
  custom dimension or metric exists. Provision before launch.
- **Quotas (standard property):** 50 event-scoped custom dimensions, 25 user-scoped, and
  50 custom metrics. Key events are capped too; check current limits in the GA docs.
- **Param naming:** at most 40 characters, letters, digits, and underscores, starting with a
  letter. Reserved prefixes (`google_`, `ga_`, `firebase_`) are rejected.
- **One meaning per param name.** A custom dimension is keyed by `parameterName` across *all*
  events. If two events use the same param name with different meanings, their values mix in
  one dimension.
- **Recommended-event params** (`score`, `level`, `character`, `level_name`, `achievement_id`)
  get special treatment in some GA reports. Register any you want in explorations unless your
  property already lists them as predefined.
- **Alpha endpoints** (`v1alpha`) can change. Pin the client-library version.
- **Explorations aren't in the API.** Document the funnel and cohort definitions in prose so
  someone can rebuild them by hand.

---

## 5. Freight Floor spec

The source of truth for events is
[`apps/client/src/analytics.ts`](../apps/client/src/analytics.ts). Its tests forbid identifiers
and free text in params, so everything here is an enum, a boolean, or a number. Setup steps for
the measurement ID are in [operations.md §8](operations.md#8-analytics-setup-ga4).

### Property settings

| Setting | Value | Why |
|---|---|---|
| Time zone | `Etc/UTC` | Daily Shift, streaks, the league, and retention all roll over at UTC midnight. |
| Data retention | `FOURTEEN_MONTHS` | Room for year-over-year cohorts. |
| Google signals | Disabled | Matches the client's `allow_google_signals: false`. |
| Streams | One web stream for prod | `-stg` stacks never get a measurement ID. |

### Key events

`site_join`, `level_start`, `level_end`, `post_score`, `manager_command`, `agent_command`,
`return_visit`, `unlock_achievement`, `livery_equip`

### Custom dimensions (event scope)

| `parameterName` | Values | Sent on |
|---|---|---|
| `level_name` | `blitz` / `daily` / `freerange` | `level_start`, `level_end` |
| `character` | run mode (same values) | `post_score` |
| `run_mode` | run mode | `run_mode_select` |
| `site_id` | regional site ID | `site_join`, `level_start`, `level_end`, `post_score`, `site_transfer` |
| `via` | `join` / `queue` | `site_join` |
| `role` | player role | `site_join` |
| `success` | boolean | `level_end` |
| `achievement_id` | `livery_<id>` | `unlock_achievement` |
| `livery_id` | livery catalog ID | `livery_equip` |
| `op` | manager op | `floor_order`, `ai_card_action` |
| `kind` | `directive` / `text` / `mode` | `agent_command` |
| `mode` | agent mode | `agent_command` |
| `enabled` | boolean | `dispatchers_call_pref` |
| `level` | see the warning below | `difficulty_vote`, `post_score` |

> **`level` is overloaded.** `difficulty_vote` sends the difficulty (as a string), while
> `post_score` sends the run number (the GA recommended-event param). In one dimension these
> values mix. Either register it knowing that and filter by event name, or rename the
> difficulty param (for example `difficulty`) in the client and its tests *before* provisioning,
> since the definition can't be renamed afterwards.

### Custom metrics (event scope, `STANDARD` unit)

| `parameterName` | Sent on |
|---|---|
| `score` | `post_score` |
| `deliveries` | `post_score` |
| `on_time_pct` | `post_score` |
| `human_rank` | `post_score` |
| `human_runs` | `post_score` |
| `days_since_last` | `return_visit` |
| `active_days` | `return_visit` |
| `count` | `contracts_kept` |

### Events with no params

`take_wheel`, `release_wheel`, `order_chosen`, `manager_command`, `relocation_accept`,
`dispatchers_call_reveal`. No definitions are needed, but they still count as events.

### Explorations to rebuild by hand

- **Run funnel:** `site_join` → `level_start` → `level_end` → `post_score`, broken down by
  `level_name`.
- **Retention cohort:** entry `first_visit`, return `return_visit`, weekly granularity. Compare
  with the server-side `npm run report:retention`, which is authoritative.
- **Audiences:**
  - *Daily players*: `level_start` where `level_name = daily`.
  - *Collectors*: `unlock_achievement` count ≥ 3.
  - *Lapsed*: `return_visit` with `days_since_last` ≥ 7.

### Not tracked in GA4 (by design, for now)

Daily streaks and weekly-league tiers live server-side (`/api/daily`, `/api/league`, and the
player ledger). If they're added to GA4 later, use numeric or enum params only (for example
`daily_streak { streak }`, `league_finish { tier }`), then add them to this spec and the parity
test.

### Implementation checklist (for whoever builds the provisioner)

- [ ] Script under `tools/` (for example `npm run ga4:provision -- --property <id> [--dry-run]`)
      using ADC or impersonation. No key files, and no IDs committed.
- [ ] The spec above as data (TS module) that the script and a Vitest parity test both import.
- [ ] Idempotent reconcile: list, diff, create missing. Report extras; never archive.
- [ ] Optional `--create-property --account <id> --uri <url>` path that prints the new
      `G-…` for `ga_measurement_id` in the gitignored `infra/terraform.tfvars`.
- [ ] Update [operations.md §8](operations.md#8-analytics-setup-ga4) to point at the script.
