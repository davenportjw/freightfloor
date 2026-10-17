locals {
  services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "aiplatform.googleapis.com",
    "firestore.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "modelarmor.googleapis.com",
  ]

  sites = {
    den-1 = { min = 1, idle = "run", agents = 20 }
    slc-2 = { min = 0, idle = "break", agents = 12 }
    phx-3 = { min = 0, idle = "break", agents = 12 }
    abq-4 = { min = 0, idle = "break", agents = 12 }
  }
}

# 1. Enable Required Google Cloud APIs
resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# 2. Artifact Registry Repository with Cleanup Policy (keep last 5 images)
resource "google_artifact_registry_repository" "warehouse" {
  count         = var.suffix == "" ? 1 : 0
  project       = var.project_id
  location      = var.region
  repository_id = "warehouse"
  description   = "Container images for Warehouse multiplayer distribution network"
  format        = "DOCKER"

  cleanup_policies {
    id     = "keep-recent-5"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }

  depends_on = [google_project_service.apis]
}

# 3. Service Accounts & IAM Roles
resource "google_service_account" "site" {
  project      = var.project_id
  account_id   = "warehouse-site${var.suffix}"
  display_name = "Warehouse Site Server (${var.suffix == "" ? "prod" : var.suffix})"
}

resource "google_service_account" "lobby" {
  project      = var.project_id
  account_id   = "warehouse-lobby${var.suffix}"
  display_name = "Warehouse Lobby Server (${var.suffix == "" ? "prod" : var.suffix})"
}

resource "google_service_account" "pubsub_push" {
  project      = var.project_id
  account_id   = "warehouse-pubsub-push${var.suffix}"
  display_name = "Warehouse Pub/Sub Push Invoker (${var.suffix == "" ? "prod" : var.suffix})"
}

resource "google_service_account" "loadtest" {
  project      = var.project_id
  account_id   = "warehouse-loadtest${var.suffix}"
  display_name = "Warehouse Loadtest & Gemini Pilots (${var.suffix == "" ? "prod" : var.suffix})"
}

resource "google_project_iam_member" "site_roles" {
  for_each = toset([
    "roles/aiplatform.user",
    "roles/datastore.user",
    "roles/pubsub.publisher",
    "roles/modelarmor.user",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.site.email}"
}

resource "google_project_iam_member" "lobby_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.lobby.email}"
}

resource "google_project_iam_member" "loadtest_aiplatform" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.loadtest.email}"
}

# 4. Secret Manager: Ticket HMAC Key (never hardcoded in repo)
resource "random_password" "ticket_hmac_key" {
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "ticket_hmac_key" {
  project   = var.project_id
  secret_id = "ticket-hmac-key${var.suffix}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "ticket_hmac_key" {
  secret      = google_secret_manager_secret.ticket_hmac_key.id
  secret_data = random_password.ticket_hmac_key.result
}

resource "google_secret_manager_secret_iam_member" "site_secret_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.ticket_hmac_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.site.email}"
}

resource "google_secret_manager_secret_iam_member" "lobby_secret_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.ticket_hmac_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.lobby.email}"
}

# 5. Firestore TTL Policy on `journal` collection group (`expireAt` field)
resource "google_firestore_field" "journal_ttl" {
  count      = var.suffix == "" ? 1 : 0
  project    = var.project_id
  database   = var.firestore_database_id
  collection = "journal"
  field      = "expireAt"

  ttl_config {}

  depends_on = [google_project_service.apis]
}

# 6. Pub/Sub Topics & Subscriptions for Cross-Site Transfers
resource "google_pubsub_topic" "site_transfers_dlq" {
  project    = var.project_id
  name       = "site-transfers-dlq${var.suffix}"
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "site_transfers" {
  project    = var.project_id
  name       = "site-transfers${var.suffix}"
  depends_on = [google_project_service.apis]
}

# 7. Cloud Run v2 Services: 4 Sites (den-1, slc-2, phx-3, abq-4)
resource "google_cloud_run_v2_service" "site" {
  for_each            = local.sites
  project             = var.project_id
  name                = "site-${each.key}${var.suffix}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.site.email
    timeout                          = "3600s"
    max_instance_request_concurrency = 300

    scaling {
      min_instance_count = var.suffix == "-stg" ? 0 : each.value.min
      max_instance_count = 1
    }

    containers {
      image = var.site_image

      resources {
        cpu_idle = false
        limits = {
          cpu    = "2"
          memory = "4Gi"
        }
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "SITE_ID"
        value = each.key
      }
      env {
        name  = "SUFFIX"
        value = var.suffix
      }
      env {
        name  = "IDLE_POLICY"
        value = each.value.idle
      }
      env {
        name  = "AGENTS"
        value = tostring(each.value.agents)
      }
      env {
        name  = "GEMINI_MODEL"
        value = "gemini-3.5-flash-lite"
      }
      env {
        name  = "GEMINI_LOCATION"
        value = "global"
      }
      env {
        name  = "TRANSFERS_TOPIC"
        value = google_pubsub_topic.site_transfers.name
      }
      env {
        name  = "MODEL_ARMOR_TEMPLATE"
        value = "projects/${var.project_id}/locations/${var.region}/templates/warehouse-orders${var.suffix}"
      }
      env {
        name  = "REQUIRE_PROXY_AUTH"
        value = "1"
      }
      env {
        name = "TICKET_HMAC_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.ticket_hmac_key.secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_version.ticket_hmac_key,
    google_secret_manager_secret_iam_member.site_secret_accessor,
    google_project_iam_member.site_roles,
  ]
}

# Lobby Gateway Invoker IAM for Site Services (No public allUsers access on backend engines)
resource "google_cloud_run_v2_service_iam_member" "site_lobby_invoker" {
  for_each = google_cloud_run_v2_service.site
  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.lobby.email}"
}

# Pub/Sub Push Invoker IAM for Site Services
resource "google_cloud_run_v2_service_iam_member" "site_pubsub_invoker" {
  for_each = google_cloud_run_v2_service.site
  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

# Filtered Push Subscriptions per Site
resource "google_pubsub_subscription" "site_transfer_push" {
  for_each = local.sites
  project  = var.project_id
  name     = "site-transfers-${each.key}${var.suffix}"
  topic    = google_pubsub_topic.site_transfers.name
  filter   = "attributes.toSite = \"${each.key}\""

  ack_deadline_seconds = 30

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.site[each.key].uri}/internal/transfer"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.site_transfers_dlq.id
    max_delivery_attempts = 10
  }

  retry_policy {
    minimum_backoff = "5s"
    maximum_backoff = "60s"
  }
}

# 8. Cloud Run v2 Service: Warehouse Lobby (Only Publicly Exposed Service)
resource "google_cloud_run_v2_service" "lobby" {
  project             = var.project_id
  name                = "warehouse-lobby${var.suffix}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.lobby.email
    timeout                          = "3600s"
    max_instance_request_concurrency = 300

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = var.lobby_image

      resources {
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "SUFFIX"
        value = var.suffix
      }
      env {
        name  = "RATE_LIMIT_PER_MIN"
        value = "1000"
      }
      env {
        name = "SITE_URLS_JSON"
        value = jsonencode({
          for k, svc in google_cloud_run_v2_service.site : k => svc.uri
        })
      }
      env {
        name = "TICKET_HMAC_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.ticket_hmac_key.secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_version.ticket_hmac_key,
    google_secret_manager_secret_iam_member.lobby_secret_accessor,
    google_project_iam_member.lobby_datastore,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "lobby_public_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.lobby.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# 9. Optional Edge Cloud Armor Security Policy (when var.enable_edge_lb is true)
resource "google_compute_security_policy" "edge_throttle" {
  count       = var.enable_edge_lb ? 1 : 0
  project     = var.project_id
  name        = "warehouse-edge-throttle${var.suffix}"
  description = "Per-IP rate limiting on /api/* when edge LB is enabled"

  rule {
    action   = "throttle"
    priority = 1000
    match {
      expr {
        expression = "request.path.matches('^/api/.*')"
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 60
        interval_sec = 60
      }
    }
  }

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow rule"
  }
}

# 10. Cloud Run v2 Job: loadtest-128 (112 protocol bots + 16 Gemini pilots)
resource "google_cloud_run_v2_job" "loadtest_128" {
  count    = var.enable_loadtest_job ? 1 : 0
  project  = var.project_id
  name     = "loadtest-128${var.suffix}"
  location = var.region

  template {
    task_count = 1
    template {
      service_account = google_service_account.loadtest.email
      timeout         = "1200s"
      max_retries     = 0

      containers {
        image = var.loadtest_image

        resources {
          limits = {
            cpu    = "2"
            memory = "2Gi"
          }
        }

        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "LOBBY_URL"
          value = google_cloud_run_v2_service.lobby.uri
        }
        env {
          name  = "PROTOCOL_BOTS"
          value = "112"
        }
        env {
          name  = "PILOT_AGENTS"
          value = "16"
        }
        env {
          name  = "PILOT_BUDGET_USD"
          value = "1.5"
        }
        env {
          name  = "GEMINI_MODEL"
          value = "gemini-3.5-flash-lite"
        }
        env {
          name  = "GEMINI_LOCATION"
          value = "global"
        }
      }
    }
  }

  depends_on = [google_project_service.apis]
}
