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
  description = "Container image URI for warehouse-site (defaults to <region>-docker.pkg.dev/<project_id>/warehouse/site:latest when empty)"
  type        = string
  default     = ""
}

variable "lobby_image" {
  description = "Container image URI for warehouse-lobby (defaults to <region>-docker.pkg.dev/<project_id>/warehouse/lobby:latest when empty)"
  type        = string
  default     = ""
}

variable "loadtest_image" {
  description = "Container image URI for loadtest-128 job (defaults to <region>-docker.pkg.dev/<project_id>/warehouse/loadtest:latest when empty)"
  type        = string
  default     = ""
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

variable "max_warehouses" {
  description = "Maximum number of regional warehouse shards (including dynamic overflow warehouses)"
  type        = number
  default     = 8
}

variable "queue_scale_threshold" {
  description = "Queued driver count threshold before dynamic overflow warehouse shards are provisioned"
  type        = number
  default     = 8
}

variable "enable_rack_lift_minigame" {
  description = "Opt-in feature flag to enable the Rack Height Fork-Lift Minigame on regional site shards"
  type        = bool
  default     = false
}

variable "enable_dispatchers_call" {
  description = "Dispatcher's Call A2UI minigame (one Gemini-proposed dispatch choice per Blitz run) on regional site shards"
  type        = bool
  default     = true
}


