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
  }
}
