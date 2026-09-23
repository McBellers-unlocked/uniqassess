"""Bounded control-host cleanup; invoked by cleanup-bootstrap.mjs over SSM.

Default --inspect is read-only. No token, private key or Secret value is logged.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile

FINGERPRINT = 'SHA256:Ps56DR68SrVYycI2q0L/uWLU/CJe2QiTHWRL04loQn0'
BOOT = Path('/opt/uniqassess-bootstrap')
KEY = BOOT / 'worker-key'
MARKER = BOOT / 'bootstrap-access-cleanup.json'
ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration'
SSH = ['ssh', '-i', str(KEY), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
       '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no',
       '-o', 'PreferredAuthentications=publickey', '-o', 'StrictHostKeyChecking=yes',
       '-o', 'UserKnownHostsFile=' + str(BOOT / 'known-hosts'),
       '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', 'ubuntu@10.88.0.20']


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(argv, source=None, timeout=40):
    result = subprocess.run(argv, input=source, text=True, capture_output=True,
                            timeout=timeout, check=False)
    require(result.returncode == 0, 'A bounded host operation failed; output suppressed.')
    return result.stdout


def kubectl(*args):
    return run(['kubectl', '--request-timeout=20s', *args])


def atomic_json(path, value):
    require(path.parent.resolve() == BOOT, 'Unexpected marker directory.')
    require(not path.is_symlink(), 'Refusing marker symlink.')
    fd, temporary = tempfile.mkstemp(prefix='.cleanup-', dir=BOOT)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def key_fingerprint(public_key):
    tokens = public_key.split()
    require(len(tokens) >= 2 and tokens[0] == 'ssh-ed25519', 'Unexpected bootstrap key type.')
    digest = hashlib.sha256(base64.b64decode(tokens[1], validate=True)).digest()
    return 'SHA256:' + base64.b64encode(digest).decode().rstrip('=')


# Executed as root on exactly the known worker through host-key-verified SSH.
# Preserves all nonmatching lines and the original ownership/mode atomically.
WORKER_SOURCE = r'''
import base64,hashlib,json,os,pwd,shlex,stat,sys,tempfile
from pathlib import Path
def need(value,message):
    if not value: raise RuntimeError(message)
def replacement_for(original,expected):
    lines=original.splitlines(keepends=True)
    matches=[]
    for index,line in enumerate(lines):
        text=line.decode('utf-8').strip()
        if not text or text.startswith('#'): continue
        parts=shlex.split(text)
        for i,part in enumerate(parts[:-1]):
            if part=='ssh-ed25519':
                fingerprint='SHA256:'+base64.b64encode(hashlib.sha256(base64.b64decode(parts[i+1],validate=True)).digest()).decode().rstrip('=')
                if fingerprint==expected: matches.append(index)
                break
    need(len(matches)==1,'Expected exactly one matching bootstrap key.')
    replacement=b''.join(line for i,line in enumerate(lines) if i not in matches)
    return replacement
def main():
    expected,mode=sys.argv[1:]
    need(mode in ('--inspect','--execute-after-acceptance'),'Unknown cleanup mode.')
    p=Path('/home/ubuntu/.ssh/authorized_keys')
    need(os.geteuid()==0,'Root is required.')
    need(not p.is_symlink() and p.is_file(),'Unexpected authorized_keys path.')
    need(p.resolve()==p,'Unexpected authorized_keys resolution.')
    s=p.stat()
    need(s.st_uid==pwd.getpwnam('ubuntu').pw_uid,'Unexpected authorized_keys owner.')
    need(stat.S_IMODE(s.st_mode)==0o600,'Unexpected authorized_keys permissions.')
    original=p.read_bytes()
    replacement=replacement_for(original,expected)
    if mode=='--execute-after-acceptance':
        need(p.read_bytes()==original,'authorized_keys changed during inspection.')
        fd,name=tempfile.mkstemp(prefix='.uniqassess-key-',dir=p.parent)
        try:
            os.fchmod(fd,stat.S_IMODE(s.st_mode));os.fchown(fd,s.st_uid,s.st_gid)
            with os.fdopen(fd,'wb') as out:
                out.write(replacement);out.flush();os.fsync(out.fileno())
            os.replace(name,p)
        finally:
            if os.path.exists(name): os.unlink(name)
        need(p.read_bytes()==replacement,'Key removal verification failed.')
    print(json.dumps({'matchingBootstrapKeys':1,'removed':mode=='--execute-after-acceptance','otherLinesPreserved':True}))
if __name__=='__main__': main()
'''


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else '--inspect'
    require(mode in ('--inspect', '--execute-after-acceptance'), 'Unknown cleanup mode.')
    execute = mode == '--execute-after-acceptance'
    require(os.geteuid() == 0 and BOOT.resolve() == BOOT, 'Expected trusted control root context.')
    os.environ['KUBECONFIG'] = '/etc/rancher/k3s/k3s.yaml'
    nodes = json.loads(kubectl('get', 'nodes', '-o', 'json'))['items']
    require({n['metadata']['name'] for n in nodes} == {'lab-control', 'lab-sandbox'},
            'Unexpected cluster nodes.')
    for node in nodes:
        require(any(c['type'] == 'Ready' and c['status'] == 'True'
                    for c in node['status']['conditions']), 'A pilot node is not Ready.')
    labs = json.loads(kubectl('get', 'namespaces', '-l', 'labs.uniqassess.com/managed=true', '-o', 'json'))['items']
    if execute:
        require(not labs, 'Finish and clean up active test labs before revoking bootstrap access.')
    deployment = json.loads(kubectl('get', 'deployment', 'lab-broker', '-n', 'uniqassess-control', '-o', 'json'))
    require(deployment['status'].get('readyReplicas') == 1, 'Broker must be Ready before cleanup.')
    require(deployment['status'].get('observedGeneration', 0) >= deployment['metadata']['generation'],
            'Broker deployment has not settled.')

    secret = json.loads(kubectl('get', 'secret', 'lab-runner', '-n', 'uniqassess-control', '-o', 'json'))
    original_data = secret['data']
    secret_uid = secret['metadata']['uid']
    had_annotation = ANNOTATION in secret['metadata'].get('annotations', {})
    require('LAB_RUNNER_API_KEY' in original_data, 'Expected runner Secret key is absent.')
    # Validate the installer's current canonical-data/field-manager path without
    # persisting an apply operation. The manifest and result stay in memory.
    canonical = {'apiVersion': 'v1', 'kind': 'Secret',
                 'metadata': {'name': 'lab-runner', 'namespace': 'uniqassess-control'},
                 'type': 'Opaque', 'data': {'LAB_RUNNER_API_KEY': original_data['LAB_RUNNER_API_KEY']}}
    dry_result = json.loads(run(['kubectl', '--request-timeout=20s', 'apply', '--server-side',
                                 '--dry-run=server', '--field-manager=uniqassess-bootstrap',
                                 '-f', '-', '-o', 'json'], json.dumps(canonical)))
    require(dry_result['data'] == original_data, 'Secret apply dry-run changed the expected data.')
    after_dry_run = json.loads(kubectl('get', 'secret', 'lab-runner', '-n', 'uniqassess-control', '-o', 'json'))
    require(after_dry_run['metadata']['uid'] == secret_uid and after_dry_run['data'] == original_data and
            after_dry_run['metadata']['resourceVersion'] == secret['metadata']['resourceVersion'],
            'Secret changed during the read-only apply check; inspect before cleanup.')
    # Only a JSON pointer to an annotation and a nonsecret resource version go
    # into the patch; credential values never enter arguments, output or files.
    if execute and had_annotation:
        patch = [{'op': 'test', 'path': '/metadata/resourceVersion', 'value': secret['metadata']['resourceVersion']},
                 {'op': 'remove', 'path': '/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration'}]
        kubectl('patch', 'secret', 'lab-runner', '-n', 'uniqassess-control', '--type=json', '-p', json.dumps(patch))
        updated = json.loads(kubectl('get', 'secret', 'lab-runner', '-n', 'uniqassess-control', '-o', 'json'))
        require(updated['metadata']['uid'] == secret_uid and updated['data'] == original_data,
                'Runner Secret identity/data changed; inspect securely.')
        require(ANNOTATION not in updated['metadata'].get('annotations', {}), 'Annotation removal did not persist.')

    marker = {}
    if MARKER.exists():
        require(not MARKER.is_symlink() and MARKER.stat().st_uid == 0 and
                stat.S_IMODE(MARKER.stat().st_mode) == 0o600, 'Unexpected cleanup marker permissions.')
        marker = json.loads(MARKER.read_text())
        require(marker.get('fingerprint') == FINGERPRINT, 'Cleanup marker targets a different key.')
    if not KEY.exists():
        require(marker.get('privateKeyRemoved') and marker.get('newSshAuthenticationDenied'),
                'Private key absent without a completed cleanup record.')
        worker = {'removed': True, 'alreadyCompleted': True}
    else:
        require(not KEY.is_symlink() and KEY.resolve() == KEY and KEY.stat().st_uid == 0 and
                stat.S_IMODE(KEY.stat().st_mode) == 0o600, 'Unexpected private-key path/permissions.')
        require(key_fingerprint(run(['ssh-keygen', '-y', '-f', str(KEY)])) == FINGERPRINT,
                'Private key fingerprint differs from the reviewed bootstrap key.')
        worker = {'removed': True, 'resumedAfterRevocation': True}
        if not marker.get('workerKeyRevoked'):
            remote = 'sudo python3 - ' + shlex.quote(FINGERPRINT) + ' ' + shlex.quote(mode)
            worker = json.loads(run([*SSH, remote], WORKER_SOURCE))
            if execute:
                marker = {'fingerprint': FINGERPRINT, 'workerKeyRevoked': True}
                atomic_json(MARKER, marker)
        if execute:
            denied = subprocess.run([*SSH, 'true'], text=True, capture_output=True, timeout=20, check=False)
            require(denied.returncode == 255 and 'Permission denied (publickey)' in denied.stderr,
                    'Expected explicit public-key rejection was not observed; private key retained.')
            marker['newSshAuthenticationDenied'] = True
            atomic_json(MARKER, marker)
            KEY.unlink()
            marker['privateKeyRemoved'] = True
            atomic_json(MARKER, marker)
    print(json.dumps({'mode': mode, 'fingerprint': FINGERPRINT, 'worker': worker,
                      'privateKeyPresent': KEY.exists(), 'runnerSecretPreserved': True,
                      'runnerSecretServerSideDryRunAccepted': True,
                      'runnerSecretLastAppliedPreviouslyPresent': had_annotation,
                      'runnerSecretLastAppliedRemoved': execute and had_annotation,
                      'activeLabNamespaces': len(labs), 'nodesReady': True, 'brokerReady': True}))


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        print(json.dumps({'failed': True, 'reason': str(error)}))
        sys.exit(1)
    except Exception as error:
        # Tracebacks and subprocess output could contain Secret material.
        print(json.dumps({'failed': True, 'errorType': type(error).__name__, 'detailsSuppressed': True}))
        sys.exit(1)
