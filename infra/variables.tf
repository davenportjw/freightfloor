variable "project_id" {
  description = "Google Cloud Project ID"
  type        = string
  default     = "davenport-boutique"
}

variable "region" {
  description = "Default Google Cloud region"
  type        = string
  default     = "us-central1"
}

variable "suffix" {
  description = "Environment suffix (e.g., '' for prod, '-stg' for staging)"
  type        = string
  default     = ""
}

variable "site_image" {
  description = "Container image URI for warehouse-site"
  type        = string
  default     = "us-central1-docker.pkg.dev/davenport-boutique/warehouse/site:latest"
}

variable "lobby_image" {
  description = "Container image URI for warehouse-lobby"
  type        = string
  default     = "us-central1-docker.pkg.dev/davenport-boutique/warehouse/lobby:latest"
}

variable "loadtest_image" {
  description = "Container image URI for loadtest-128 job"
  type        = string
  default     = "us-central1-docker.pkg.dev/davenport-boutique/warehouse/loadtest:latest"
}

variable "enable_edge_lb" {
  description = "Whether to provision an optional Cloud Armor edge policy and global HTTPS load balancer"
  type        = bool
  default     = false
}

variable "enable_loadtest_job" {
  description = "Whether to provision the Cloud Run v2 Job loadtest-128"
  type        = bool
  default     = true
}

variable "firestore_database_id" {
  description = "Firestore database ID"
  type        = string
  default     = "(default)"
}
