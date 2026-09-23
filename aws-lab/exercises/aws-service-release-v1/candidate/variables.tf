variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "Use the operator-supplied account ID."
  }
}
variable "region" { type = string }
variable "function_name" { type = string }
variable "application_role_name" { type = string }
variable "data_bucket" { type = string }
variable "alarm_name" { type = string }
variable "release_version" {
  type        = string
  description = "Immutable numeric Lambda version for the live alias."
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.release_version))
    error_message = "The live alias must point to an immutable published numeric version."
  }
}
