variable "project_id" {
  description = "Google Cloud Project ID"
  type        = string
  default     = "davenporter-freightfloor"
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

variable "agent_daily_budget_usd" {
  description = "Daily USD cap across all site shards for autonomous Gemini shift brains and Dispatcher's Call"
  type        = number
  default     = 12.5
}

variable "nl_command_daily_budget_usd" {
  description = "Daily USD cap across all site shards for natural-language manager orders (nlCommand)"
  type        = number
  default     = 1.5
}

variable "brain_max_rpm_per_site" {
  description = "Maximum Gemini brain calls per minute per regional site shard"
  type        = number
  default     = 120
}

variable "max_concurrent_brain_calls" {
  description = "Maximum concurrent in-flight Gemini brain calls per regional site shard"
  type        = number
  default     = 8
}

variable "vertex_daily_input_token_quota" {
  description = "Hard GCP Cloud Quotas daily input token limit for Gemini 3.5 Flash-Lite (GlobalGenerateContentInputTokensPerDayPerBaseModel)"
  type        = number
  default     = 50000000
}

variable "vertex_per_minute_input_token_quota" {
  description = "Hard GCP Cloud Quotas per-minute input token limit for Gemini 3.5 Flash-Lite (GlobalGenerateContentInputTokensPerMinutePerBaseModel)"
  type        = number
  default     = 1000000
}

variable "model_armor_rpm_quota" {
  description = "Hard GCP Cloud Quotas per-minute request limit for Model Armor (RequestsPerMinute)"
  type        = number
  default     = 120
}
