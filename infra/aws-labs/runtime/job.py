"""Runs inside the candidate's disposable CodeBuild container, never app compute.

The job identity can read only its lease resources. Output is candidate evidence,
not an authoritative grade. Only the controller writes source archives.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from datetime import datetime, timezone

ROOT = Path('/tmp/workspace')
AWS = shutil.which('aws')
BUCKET = os.environ['LAB_BUCKET']
JOB = os.environ['LAB_JOB_ID']
LIMIT = 32768


def cloud(*args, check=True):
    return subprocess.run([AWS, *args, '--region', 'eu-west-1'], capture_output=True, check=check)


def safe_extract(archive, destination):
    target = destination.resolve()
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        if len(members) > 4000 or any(m.size < 0 for m in members) or sum(m.size for m in members) > 100 * 1024 * 1024:
            raise ValueError('Workspace exceeded the permitted size')
        for item in members:
            path = (target / item.name).resolve()
            if not path.is_relative_to(target) or not (item.isfile() or item.isdir()):
                raise ValueError('Unsupported workspace archive entry')
        source.extractall(target, members=members, filter='data')


def save_workspace():
    files = []
    total = 0
    for p in ROOT.rglob('*'):
        if p.is_symlink() or '.terraform' in p.parts or '__pycache__' in p.parts:
            continue
        if p.is_file():
            total += p.stat().st_size
            files.append(p)
    if total > 100 * 1024 * 1024 or len(files) > 4000:
        raise ValueError('Workspace exceeded the permitted size')
    archive = Path('/tmp/saved-workspace.tar.gz')
    with tarfile.open(archive, 'w:gz') as dest:
        for p in files:
            dest.add(p, arcname=str(p.relative_to(ROOT)), recursive=False)
    cloud('s3', 'cp', str(archive), f's3://{BUCKET}/workspace/current.tar.gz', '--only-show-errors')


def install_terraform():
    # A fixed version is supplied by the operator, never a request parameter.
    version = os.environ.get('LAB_TERRAFORM_VERSION', '1.14.7')
    if not __import__('re').fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Invalid tool version')
    base = f'https://releases.hashicorp.com/terraform/{version}/'
    name = f'terraform_{version}_linux_amd64.zip'
    archive = urllib.request.urlopen(base + name, timeout=30).read(80 * 1024 * 1024)
    manifest = urllib.request.urlopen(base + f'terraform_{version}_SHA256SUMS', timeout=20).read(100000).decode()
    expected = next(line.split()[0] for line in manifest.splitlines() if line.split()[-1] == name)
    if hashlib.sha256(archive).hexdigest() != expected:
        raise ValueError('Tool checksum mismatch')
    path = Path('/tmp/terraform.zip')
    path.write_bytes(archive)
    bindir = Path('/tmp/lab-bin')
    bindir.mkdir(exist_ok=True)
    with zipfile.ZipFile(path) as z:
        (bindir / 'terraform').write_bytes(z.read('terraform'))
    (bindir / 'terraform').chmod(0o755)
    os.environ['PATH'] = str(bindir) + ':' + os.environ['PATH']


def main():
    ROOT.mkdir(exist_ok=True)
    archive = Path('/tmp/workspace.tar.gz')
    cloud('s3', 'cp', f's3://{BUCKET}/workspace/current.tar.gz', str(archive), '--only-show-errors')
    safe_extract(archive, ROOT)
    install_terraform()
    command = Path('command.txt').read_text()
    result = {'stdout': '', 'stderr': '', 'exitCode': None, 'truncated': False}
    started = time.monotonic()
    # Redirect to bounded files via active draining, not capture_output (unbounded).
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        process = subprocess.Popen(['/bin/bash', '-c', command], cwd=ROOT, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True,
                                   env={**os.environ, 'TF_IN_AUTOMATION': '1', 'TF_INPUT': '0'})
        import threading
        truncated = [False, False]
        def drain(stream, file, index):
            count = 0
            while block := stream.read(4096):
                file.write(block[:max(0, LIMIT - count)])
                count += len(block)
                if count > LIMIT:
                    truncated[index] = True
        threads = [threading.Thread(target=drain, args=(stream, file, i), daemon=True)
                   for i, (stream, file) in enumerate(((process.stdout, out), (process.stderr, err)))]
        for t in threads:
            t.start()
        try:
            expires = datetime.fromisoformat(os.environ['LAB_EXPIRES_AT'].replace('Z', '+00:00')).timestamp()
            # Leave time for bounded evidence/workspace persistence. The IAM
            # boundary independently denies all AWS calls at the exact deadline.
            remaining = max(0, min(240, expires - time.time() - 5))
            result['exitCode'] = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            result['exitCode'] = 124
        finally:
            # Retire background processes even after a successful shell exit.
            import signal
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            for t in threads:
                t.join(timeout=5)
        for field, file in [('stdout', out), ('stderr', err)]:
            file.seek(0)
            result[field] = file.read(LIMIT).decode('utf-8', 'replace')
        result['truncated'] = any(truncated)
    if result['exitCode'] == 124:
        result['stderr'] = (result['stderr'] + '\nThis job reached its execution limit. Check the actual cloud state before retrying.')[:LIMIT]
    try:
        save_workspace()
    except Exception:
        result['stderr'] = (result['stderr'] + '\nWorkspace persistence failed; contact the assessment organiser.')[:LIMIT]
        result['exitCode'] = result['exitCode'] or 70
    result['durationSeconds'] = round(time.monotonic() - started, 3)
    receipt = Path('/tmp/result.json')
    receipt.write_text(json.dumps(result))
    cloud('s3', 'cp', str(receipt), f's3://{BUCKET}/results/{JOB}.json', '--only-show-errors')
    print(json.dumps({'jobFinished': True, 'exitCode': result['exitCode']}))


if __name__ == '__main__':
    main()
