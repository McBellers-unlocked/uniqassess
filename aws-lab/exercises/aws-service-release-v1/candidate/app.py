"""Fictional order-status Lambda. Structured spans are request evidence, not X-Ray."""
import json
import os
import re
import time

import boto3

s3 = boto3.client("s3")
ORDER_ID = re.compile(r"^order-[0-9]{1,12}$")


def _response(status, payload):
    return {"statusCode": status, "headers": {"Content-Type": "application/json"},
            "body": json.dumps(payload, separators=(",", ":"))}


def handler(event, context):
    started = time.perf_counter()
    request_id = getattr(context, "aws_request_id", "local-test")
    function_name = getattr(context, "function_name", os.getenv("AWS_LAMBDA_FUNCTION_NAME", "local-test"))
    status = 500
    try:
        order_id = event.get("order_id") if isinstance(event, dict) else None
        if not isinstance(order_id, str) or not ORDER_ID.fullmatch(order_id):
            status = 400
            return _response(status, {"error": "invalid_order_id"})
        # Documented, bounded fault injection for this fictional assessment only.
        if event.get("exercise_fault") == "dependency_unavailable":
            print(json.dumps({"event": "exercise_fault", "request_id": request_id,
                              "fault": "dependency_unavailable", "synthetic_fault": True}))
            status = 503
            return _response(status, {"error": "dependency_unavailable"})

        key = os.getenv("ORDER_PREFIX", "orders/") + order_id + ".json"
        records = []
        for read_number in range(3):
            span_started = time.perf_counter()
            result = "OK"
            try:
                response = s3.get_object(Bucket=os.environ["BUCKET_NAME"], Key=key)
                body = response["Body"]
                try:
                    records.append(json.loads(body.read()))
                finally:
                    body.close()
            except Exception as error:
                result = getattr(error, "response", {}).get("Error", {}).get("Code", type(error).__name__)
                raise
            finally:
                ended = time.perf_counter()
                print(json.dumps({"event": "dependency_span", "request_id": request_id,
                                  "span": "S3.GetObject", "read_number": read_number + 1,
                                  "key": key, "result": result,
                                  "start_ms": round((span_started - started) * 1000, 3),
                                  "duration_ms": round((ended - span_started) * 1000, 3)}))
        record = records[-1]
        if record.get("order_id") != order_id or not isinstance(record.get("status"), str):
            status = 502
            return _response(status, {"error": "invalid_dependency_response"})
        status = 200
        return _response(status, {"order_id": order_id, "status": record["status"]})
    except Exception as error:
        code = getattr(error, "response", {}).get("Error", {}).get("Code", type(error).__name__)
        print(json.dumps({"event": "dependency_error", "request_id": request_id, "code": code}))
        # S3 can report AccessDenied for a missing object when GetObject cannot
        # establish bucket-list permission. A protected prefix-scoped list lets
        # us distinguish absence without disguising denial of an existing key.
        if code == "AccessDenied":
            try:
                listing = s3.list_objects_v2(Bucket=os.environ["BUCKET_NAME"], Prefix=key, MaxKeys=1)
                if not any(item.get("Key") == key for item in listing.get("Contents", [])):
                    status = 404
                    return _response(status, {"error": "order_not_found"})
            except Exception as listing_error:
                listing_code = getattr(listing_error, "response", {}).get("Error", {}).get("Code", type(listing_error).__name__)
                print(json.dumps({"event": "existence_check_error", "request_id": request_id, "code": listing_code}))
        if code in ("NoSuchKey", "NotFound", "404"):
            status = 404
            return _response(status, {"error": "order_not_found"})
        status = 503
        return _response(status, {"error": "dependency_unavailable"})
    finally:
        duration = round((time.perf_counter() - started) * 1000, 3)
        print(json.dumps({
            "_aws": {"Timestamp": int(time.time() * 1000), "CloudWatchMetrics": [{
                "Namespace": "UNIQassess/Lab", "Dimensions": [["FunctionName"]],
                "Metrics": [{"Name": "Requests", "Unit": "Count"},
                            {"Name": "Errors", "Unit": "Count"},
                            {"Name": "DurationMs", "Unit": "Milliseconds"}],
            }]},
            "event": "request_summary", "request_id": request_id, "FunctionName": function_name,
            "Requests": 1, "Errors": 1 if status >= 500 else 0,
            "DurationMs": duration, "status": status,
        }))
