"""Assessor verification: both contracts and measurable seeded performance defect.

No AWS operations. Uses a deterministic dependency-latency clock, not flaky sleep.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_solution import CANDIDATE, reference_app, build


class Clock:
    value = 0.0

    def perf_counter(self):
        return self.value

    def time(self):
        return 1_700_000_000 + self.value


def invoke(source):
    clock = Clock()
    calls = []

    def get_object(**kwargs):
        calls.append(kwargs)
        clock.value += 0.25
        return {"Body": io.BytesIO(b'{"order_id":"order-1042","status":"confirmed"}')}

    sdk = types.ModuleType("boto3")
    sdk.client = lambda name: types.SimpleNamespace(get_object=get_object)
    app = types.ModuleType("fixture_app")
    with patch.dict(sys.modules, {"boto3": sdk}), patch.dict(os.environ, {"BUCKET_NAME": "test", "ORDER_PREFIX": "orders/"}):
        exec(compile(source, "fixture_app.py", "exec"), app.__dict__)
        app.time = clock
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = app.handler({"order_id": "order-1042"}, types.SimpleNamespace(aws_request_id="test", function_name="fixture"))
    return result, calls, [json.loads(line) for line in output.getvalue().splitlines()]


class FixtureTests(unittest.TestCase):
    def test_seed_and_reference_preserve_response_while_reducing_dependency_work(self):
        baseline, calls, logs = invoke((CANDIDATE / "app.py").read_text(encoding="utf-8"))
        repaired, fixed_calls, fixed_logs = invoke(reference_app())
        self.assertEqual(baseline, repaired)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(fixed_calls), 1)
        self.assertEqual(logs[-1]["DurationMs"], 750)
        self.assertEqual(fixed_logs[-1]["DurationMs"], 250)
        self.assertEqual(sum(log["event"] == "dependency_span" for log in logs), 3)
        self.assertEqual(sum(log["event"] == "dependency_span" for log in fixed_logs), 1)

    def test_reference_contains_bounded_policy_and_alarm(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = build(Path(temporary) / "reference")
            main = (result / "main.tf").read_text(encoding="utf-8")
            self.assertIn('/orders/*', main)
            self.assertNotIn('/archive/*', main)
            self.assertIn('resource "aws_cloudwatch_metric_alarm" "service_errors"', main)
            self.assertNotIn('resource "aws_lambda_function"', main)
            self.assertIn('aws lambda publish-version', (result / "pipeline.sh").read_text(encoding="utf-8"))

    def test_reference_will_not_overwrite_candidate_or_existing_work(self):
        with self.assertRaises(ValueError):
            build(CANDIDATE)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            (path / "existing.txt").write_text("preserve", encoding="utf-8")
            with self.assertRaises(ValueError):
                build(path)
            self.assertEqual((path / "existing.txt").read_text(encoding="utf-8"), "preserve")


if __name__ == "__main__":
    unittest.main()
