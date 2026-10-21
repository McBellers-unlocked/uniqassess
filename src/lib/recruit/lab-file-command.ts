import { gzipSync } from "node:zlib";
import { LAB_COMMAND_MAX_CHARS, labCommandIssue } from "./kubernetes-lab-config";
import { LabError } from "./kubernetes-lab-runner";
import { fileCommandPrefix, LAB_FILE_MAX_BYTES, LAB_FILE_RESULT, type LabFileRequest } from "./lab-files";

/** Runs ONLY in the candidate container, under its existing identity and limits.
 * No app-host filesystem access or separate privileged file service is needed.
 * Compression fits ordinary manifests/source files into the bounded command API.
 */
export function buildLabFileCommand(input: unknown, requestId: unknown): string {
  const issue = labCommandIssue("file operation", requestId);
  if (issue) throw new LabError(issue, 400);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LabError("Choose a file operation.", 400);
  const file = input as LabFileRequest;
  if (!["list", "read", "write"].includes(file.operation)) throw new LabError("Choose a file operation.", 400);
  if (file.operation !== "list" && (typeof file.path !== "string" || !file.path || file.path.length > 240
      || file.path.startsWith("/") || /[\\\x00-\x1f\x7f:]/.test(file.path) || file.path.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new LabError("Use a relative workspace path, such as main.tf or manifests/checkout.yaml.", 400);
  }
  if (file.operation === "write" && (typeof file.content !== "string" || file.content.includes("\0")
      || Buffer.byteLength(file.content, "utf8") > LAB_FILE_MAX_BYTES
      || (file.version !== null && (typeof file.version !== "string" || !/^[a-f0-9]{64}$/.test(file.version))))) {
    throw new LabError("Save UTF-8 text up to 16 KiB, with the version from opening the file.", 400);
  }
  // Pick fields explicitly; JSON data is never interpolated as shell or Python source.
  const data = file.operation === "list" ? { operation: file.operation }
    : file.operation === "read" ? { operation: file.operation, path: file.path }
      : { operation: file.operation, path: file.path, content: file.content, version: file.version };
  const source = `import os, json, base64, hashlib, stat, tempfile
from pathlib import Path
r = json.loads(base64.b64decode('${Buffer.from(JSON.stringify(data)).toString("base64")}'))
root = Path.cwd().resolve()
limit = ${LAB_FILE_MAX_BYTES}
def read(p):
    if p.is_symlink(): raise ValueError('Open a regular workspace file, not a symbolic link.')
    if not p.exists(): return None
    if not stat.S_ISREG(p.stat().st_mode): raise ValueError('Open a regular text file.')
    with p.open('rb') as f: raw = f.read(limit + 1)
    if len(raw) > limit: raise ValueError('This file exceeds the 16 KiB editor limit. Use the command console.')
    if b'\\0' in raw: raise ValueError('This is a binary file. Open a UTF-8 text file.')
    raw.decode('utf-8')
    return raw
def digest(raw): return hashlib.sha256(raw).hexdigest() if raw is not None else None
try:
    if r['operation'] == 'list':
        files, size, truncated = [], 0, False
        for visited, (folder, dirs, names) in enumerate(os.walk(root)):
            if visited >= 1000:
                truncated = True
                break
            dirs[:] = sorted(d for d in dirs if d not in ('.terraform', '.git', '__pycache__', 'node_modules') and not (Path(folder) / d).is_symlink())
            for name in sorted(names):
                p = Path(folder) / name
                if p.is_symlink() or not p.is_file(): continue
                value = p.relative_to(root).as_posix()
                size += len(json.dumps(value)) + 2
                if len(files) >= 200 or size > 20000:
                    truncated = True
                    break
                files.append(value)
            if truncated: break
        result = dict(operation='list', files=files, truncated=truncated)
    else:
        p = root / r['path']
        if p.is_symlink() or not p.resolve().is_relative_to(root): raise ValueError('Choose a file inside the workspace, without symbolic links outside it.')
        raw = read(p)
        if r['operation'] == 'write':
            if digest(raw) != r['version']: raise ValueError('The file changed since you opened it. Copy your edits, then reopen the file before saving.')
            content = r['content'].encode('utf-8')
            if len(content) > limit: raise ValueError('This file exceeds the 16 KiB editor limit.')
            if len(json.dumps(r['content'], ensure_ascii=False).encode('utf-8')) > 30000: raise ValueError('This file exceeds the editor output limit. Use the command console.')
            if raw is not None and not os.access(p, os.W_OK): raise PermissionError()
            mode = stat.S_IMODE(p.stat().st_mode) if raw is not None else 0o644
            p.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=p.parent, delete=False) as f:
                    temporary = f.name
                    f.write(content)
                os.chmod(temporary, mode)
                os.replace(temporary, p)
                temporary = None
            finally:
                if temporary is not None: os.unlink(temporary)
            raw = content
        if raw is None: raise ValueError('File not found. Use New file to create it.')
        result = dict(operation=r['operation'], path=r['path'], content=raw.decode('utf-8'), version=digest(raw))
    # ensure_ascii=False keeps UTF-8 source within the output recording budget.
    encoded = json.dumps(result, ensure_ascii=False)
    if len(encoded.encode('utf-8')) > 32000: raise ValueError('This file cannot be displayed within the output limit. Use the command console.')
    print('${LAB_FILE_RESULT}' + encoded)
except PermissionError:
    print('${LAB_FILE_RESULT}' + json.dumps(dict(error='Permission denied. Only writable project files can be edited; system and tool files are protected.')))
    raise SystemExit(1)
except (ValueError, OSError) as error:
    print('${LAB_FILE_RESULT}' + json.dumps(dict(error=str(error))))
    raise SystemExit(1)
`;
  const packed = gzipSync(source).toString("base64");
  const command = `${fileCommandPrefix(requestId as string)}python -c "import base64,gzip;exec(gzip.decompress(base64.b64decode('${packed}')))"`;
  if (command.length > LAB_COMMAND_MAX_CHARS) throw new LabError("This file is too large for one editor save. Reduce its size or use the command console.", 413);
  return command;
}
