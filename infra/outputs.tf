output "lobby_url" {
  description = "Public URL of the Warehouse Lobby service"
  value       = google_cloud_run_v2_service.lobby.uri
}

output "site_urls" {
  description = "Map of site IDs to their internal Cloud Run URLs (IAM-restricted to warehouse-lobby and pubsub-push)"
  value = {
    for k, svc in google_cloud_run_v2_service.site : k => svc.uri
  }
}

output "transfers_topic" {
  description = "Pub/Sub topic name for cross-site pallet transfers"
  value       = google_pubsub_topic.site_transfers.name
}

output "service_accounts" {
  description = "Service account emails created for the Warehouse stack"
  value = {
    site        = google_service_account.site.email
    lobby       = google_service_account.lobby.email
    pubsub_push = google_service_account.pubsub_push.email
    loadtest    = google_service_account.loadtest.email
    cloudbuild  = var.suffix == "" ? google_service_account.cloudbuild[0].email : ""
  }
}

output "ai_quotas_and_caps" {
  description = "Configured AI usage quotas and daily USD budget caps"
  value = {
    agent_daily_budget_usd              = var.agent_daily_budget_usd
    nl_command_daily_budget_usd         = var.nl_command_daily_budget_usd
    brain_max_rpm_per_site              = var.brain_max_rpm_per_site
    max_concurrent_brain_calls          = var.max_concurrent_brain_calls
    vertex_daily_input_token_quota      = var.vertex_daily_input_token_quota
    vertex_per_minute_input_token_quota = var.vertex_per_minute_input_token_quota
    model_armor_rpm_quota               = var.model_armor_rpm_quota
    quota_adjuster_auto_increase        = "DISABLED"
  }
}
