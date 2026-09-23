"""Offline guard tests; no SSH, AWS calls or credential material."""
import ast
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cleanup_host', Path(__file__).with_name('cleanup-bootstrap-host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
# Exercise the exact worker selection functions without importing Linux-only
# pwd or entering its fixed-path mutation entry point on an operator machine.
worker_tree = ast.parse(host.WORKER_SOURCE)
selection = ast.Module(body=[n for n in worker_tree.body if isinstance(n, ast.FunctionDef)
                            and n.name in ('need', 'replacement_for')], type_ignores=[])
namespace = {'base64': base64, 'hashlib': hashlib, 'shlex': shlex}
exec(compile(selection, 'worker-selection', 'exec'), namespace)
replacement_for = namespace['replacement_for']
reviewed = b'reviewed bootstrap public key fixture'
encoded = base64.b64encode(reviewed)
fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(reviewed).digest()).decode().rstrip('=')
keyline = b'ssh-ed25519 ' + encoded + b' pilot-bootstrap\n'


class KeySelectionGuards(unittest.TestCase):
    def test_removes_exact_key_preserving_other_lines_byte_for_byte(self):
        other = b'# retain this comment\r\n\nssh-ed25519 b3RoZXI= pilot-bootstrap\r\n'
        rsa = b'ssh-rsa cnNh another-key'
        self.assertEqual(replacement_for(other + keyline + rsa, fingerprint), other + rsa)

    def test_matches_fingerprint_with_authorized_key_options(self):
        line = b'from="10.88.0.10",command="echo restricted" ' + keyline
        self.assertEqual(replacement_for(line, fingerprint), b'')

    def test_same_comment_does_not_authorize_removing_a_different_key(self):
        with self.assertRaisesRegex(RuntimeError, 'exactly one'):
            replacement_for(b'ssh-ed25519 b3RoZXI= pilot-bootstrap\n', fingerprint)

    def test_duplicate_matching_key_requires_review(self):
        with self.assertRaisesRegex(RuntimeError, 'exactly one'):
            replacement_for(keyline + keyline, fingerprint)

    def test_malformed_key_fails_closed(self):
        with self.assertRaises(Exception):
            replacement_for(keyline + b'ssh-ed25519 ? broken\n', fingerprint)

    def test_control_private_key_fingerprint_must_be_ed25519(self):
        self.assertEqual(host.key_fingerprint(keyline.decode()), fingerprint)
        with self.assertRaisesRegex(RuntimeError, 'key type'):
            host.key_fingerprint('ssh-rsa ' + encoded.decode())


class HostPreconditions(unittest.TestCase):
    def test_live_labs_stop_execution_before_secret_or_ssh_changes(self):
        nodes = {'items': [{'metadata': {'name': name}, 'status': {'conditions': [
            {'type': 'Ready', 'status': 'True'}]}} for name in ('lab-control', 'lab-sandbox')]}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(host, 'BOOT', Path(directory).resolve()), \
                patch.object(host.os, 'geteuid', return_value=0, create=True), \
                patch.object(sys, 'argv', ['cleanup', '--execute-after-acceptance']), \
                patch.object(host, 'kubectl', side_effect=[json.dumps(nodes), json.dumps({'items': [{'metadata': {'name': 'active-lab'}}]})]) as k, \
                patch.object(host, 'run') as remote:
            with self.assertRaisesRegex(RuntimeError, 'active test labs'):
                host.main()
            self.assertEqual(k.call_count, 2)
            remote.assert_not_called()

    def test_unknown_mode_cannot_start_host_operations(self):
        with patch.object(sys, 'argv', ['cleanup', '--force']), patch.object(host, 'kubectl') as k:
            with self.assertRaisesRegex(RuntimeError, 'Unknown cleanup mode'):
                host.main()
            k.assert_not_called()


if __name__ == '__main__':
    unittest.main()
