"""Materialise a reference workspace OUTSIDE candidate/. Never a candidate artifact.

Usage: python assessor/build_solution.py <new-or-empty-output-directory>
Copy operator session.json/tfvars/state separately; this creates no credentials.
"""
from pathlib import Path
import shutil
import sys


ROOT = Path(__file__).resolve().parents[1]
CANDIDATE = ROOT / "candidate"

ALARM = '''
resource "aws_cloudwatch_metric_alarm" "service_errors" {
  alarm_name          = var.alarm_name
  alarm_description   = "Fictional order-status application 5xx signal; no external notification"
  namespace           = "UNIQassess/Lab"
  metric_name         = "Errors"
  dimensions          = { FunctionName = var.function_name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  actions_enabled     = false
}
'''


def reference_app():
    source = (CANDIDATE / "app.py").read_text(encoding="utf-8")
    needle = "for read_number in range(3):"
    if source.count(needle) != 1:
        raise ValueError("Candidate fixture changed; review the reference repair before use")
    return source.replace(needle, "for read_number in range(1):")


def build(output):
    output = Path(output).resolve()
    if output == CANDIDATE or CANDIDATE in output.parents:
        raise ValueError("Reference answers cannot be written into the candidate artifact")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use a new or empty output directory; existing work is never overwritten")
    shutil.copytree(CANDIDATE, output, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".terraform", "*.tfstate*"))
    (output / "app.py").write_text(reference_app(), encoding="utf-8", newline="\n")
    main = (output / "main.tf").read_text(encoding="utf-8")
    needle = '"arn:aws:s3:::${var.data_bucket}/archive/*"'
    if main.count(needle) != 1:
        raise ValueError("Candidate policy changed; review the reference repair")
    (output / "main.tf").write_text(main.replace(needle, '"arn:aws:s3:::${var.data_bucket}/orders/*"') + ALARM,
                                    encoding="utf-8", newline="\n")
    (output / "pipeline.sh").write_text((ROOT / "assessor" / "pipeline.sh").read_text(encoding="utf-8"),
                                        encoding="utf-8", newline="\n")
    return output


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: build_solution.py <new-or-empty-output-directory>")
    print(build(sys.argv[1]))
