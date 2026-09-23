"""Build source-only artifacts, never candidate answers or local credentials."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[2]
output = root / 'build' / 'aws-lab'
output.mkdir(parents=True, exist_ok=True)
runtime = output / 'runtime.zip'
fixture = output / 'source.zip'
with zipfile.ZipFile(runtime, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in ('handler.py', 'job.py'):
        archive.writestr(name, (root / 'infra' / 'aws-labs' / 'runtime' / name).read_bytes())
    archive.writestr('candidate-boundary.json', (root / 'infra' / 'aws-labs' / 'candidate-boundary.json').read_bytes())
candidate = root / 'aws-lab' / 'exercises' / 'aws-service-release-v1' / 'candidate'
allowed = {'.py', '.tf', '.hcl', '.sh', '.md', '.json'}
with zipfile.ZipFile(fixture, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(candidate.rglob('*')):
        if path.is_file() and not path.is_symlink() and path.suffix in allowed and not any(part in ('__pycache__', '.terraform') for part in path.parts):
            archive.writestr('candidate/' + path.relative_to(candidate).as_posix(), path.read_text().replace('\r\n', '\n').encode())
    assert not any('assessor/' in name or 'build_solution' in name for name in archive.namelist())
manifest = {'runtimePath': str(runtime), 'runtimeSha256': hashlib.sha256(runtime.read_bytes()).hexdigest(),
            'fixturePath': str(fixture), 'fixtureSha256': hashlib.sha256(fixture.read_bytes()).hexdigest()}
(output / 'artifacts.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest))
