"""Fast local contract tests. No real AWS credential, network or boto3 install required."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


class ServiceError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


class ObjectStore:
    def __init__(self):
        self.calls = []
        self.list_calls = []
        self.error = None
        self.list_error = None

    def get_object(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise ServiceError(self.error)
        return {"Body": io.BytesIO(json.dumps({"order_id": "order-1042", "status": "confirmed"}).encode())}

    def list_objects_v2(self, **kwargs):
        self.list_calls.append(kwargs)
        if self.list_error:
            raise ServiceError(self.list_error)
        return {"Contents": [{"Key": "orders/order-1042.json"}] if kwargs["Prefix"] == "orders/order-1042.json" else []}


def load_app():
    store = ObjectStore()
    sdk = types.ModuleType("boto3")
    sdk.client = lambda name: store
    spec = importlib.util.spec_from_file_location("candidate_app", Path(__file__).resolve().parents[1] / "app.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"boto3": sdk}):
        spec.loader.exec_module(module)
    return module, store


class HandlerContract(unittest.TestCase):
    def setUp(self):
        self.app, self.store = load_app()
        self.context = types.SimpleNamespace(aws_request_id="test-request", function_name="test-function")
        self.environment = patch.dict(os.environ, {"BUCKET_NAME": "synthetic-unit-bucket", "ORDER_PREFIX": "orders/"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def invoke(self, event):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            response = self.app.handler(event, self.context)
        return response, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_successful_order(self):
        result, logs = self.invoke({"order_id": "order-1042"})
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(json.loads(result["body"]), {"order_id": "order-1042", "status": "confirmed"})
        self.assertTrue(all(call["Key"] == "orders/order-1042.json" for call in self.store.calls))
        self.assertEqual(logs[-1]["Errors"], 0)
        self.assertEqual(logs[-1]["Requests"], 1)
        self.assertEqual(self.store.list_calls, [])

    def test_missing_order_is_not_found(self):
        self.store.error = "NoSuchKey"
        result, logs = self.invoke({"order_id": "order-9999"})
        self.assertEqual(result["statusCode"], 404)
        self.assertEqual(json.loads(result["body"])["error"], "order_not_found")
        self.assertEqual(logs[-1]["Errors"], 0)

    def test_access_denied_is_not_success_or_missing(self):
        self.store.error = "AccessDenied"
        result, logs = self.invoke({"order_id": "order-1042"})
        self.assertEqual(result["statusCode"], 503)
        self.assertEqual(logs[-1]["Errors"], 1)
        self.assertTrue(any(log.get("code") == "AccessDenied" for log in logs))
        self.assertEqual(self.store.list_calls, [{"Bucket": "synthetic-unit-bucket", "Prefix": "orders/order-1042.json", "MaxKeys": 1}])

    def test_missing_object_with_access_denied_uses_exact_scoped_existence_check(self):
        self.store.error = "AccessDenied"
        result, logs = self.invoke({"order_id": "order-9999"})
        self.assertEqual(result["statusCode"], 404)
        self.assertEqual(logs[-1]["Errors"], 0)
        self.assertEqual(self.store.list_calls[0]["Prefix"], "orders/order-9999.json")

    def test_failed_existence_check_does_not_hide_access_denial(self):
        self.store.error = "AccessDenied"
        self.store.list_error = "AccessDenied"
        result, logs = self.invoke({"order_id": "order-1042"})
        self.assertEqual(result["statusCode"], 503)
        self.assertEqual(logs[-1]["Errors"], 1)

    def test_invalid_id_does_not_call_s3(self):
        for order_id in ("../outside", "order-1042/../private", None, 123):
            result, _ = self.invoke({"order_id": order_id})
            self.assertEqual(result["statusCode"], 400)
        self.assertEqual(self.store.calls, [])

    def test_bounded_fault_emits_error_and_next_request_recovers(self):
        failed, logs = self.invoke({"order_id": "order-1042", "exercise_fault": "dependency_unavailable"})
        self.assertEqual(failed["statusCode"], 503)
        self.assertEqual(logs[-1]["Errors"], 1)
        self.assertEqual(self.store.calls, [])
        success, logs = self.invoke({"order_id": "order-1042"})
        self.assertEqual(success["statusCode"], 200)
        self.assertEqual(logs[-1]["Errors"], 0)


if __name__ == "__main__":
    unittest.main()
