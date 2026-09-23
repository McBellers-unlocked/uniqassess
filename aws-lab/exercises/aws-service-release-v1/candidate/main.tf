terraform {
  required_version = ">= 1.5.0, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 5.100.0" }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
}

# The execution role itself and its permissions boundary are operator-owned.
resource "aws_iam_role_policy" "app_runtime" {
  name = "app-runtime"
  role = var.application_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadApplicationObjects"
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = ["arn:aws:s3:::${var.data_bucket}/archive/*"]
    }]
  })
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  description      = "Assessed service release"
  function_name    = var.function_name
  function_version = var.release_version
}

# Complete an appropriate service alert here using the supplied alarm_name.
# The function emits UNIQassess/Lab Requests, Errors and DurationMs metrics,
# with FunctionName as the dimension. Do not configure external notifications.
