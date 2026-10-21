import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { buildLabFileCommand } from "../src/lib/recruit/lab-file-command";
import { fileCommandPrefix, LAB_FILE_MAX_BYTES, parseLabFileResult, type LabFileRequest } from "../src/lib/recruit/lab-files";

const python = process.env.LAB_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const pythonAvailable = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;
const pythonTest = { skip: !pythonAvailable && "Python required: set LAB_TEST_PYTHON to run sandbox file-operation tests." };

function run(cwd: string, file: LabFileRequest) {
  const command = buildLabFileCommand(file, randomUUID());
  const packed = /b64decode\('([^']+)'\)/.exec(command)![1];
  const source = gunzipSync(Buffer.from(packed, "base64")).toString("utf8");
  // Execute the exact sandbox Python payload; never run shell text on this host.
  const result = spawnSync(python, ["-c", source], { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.ifError(result.error);
  return { ...result, result: () => parseLabFileResult(result.stdout) };
}

function workspace(action: (directory: string) => void) {
  const directory = mkdtempSync(join(process.env.LAB_TEST_TMPDIR ?? tmpdir(), "lab-editor-"));
  try { action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("file requests reject invalid paths, operations, versions and oversized text", () => {
  for (const path of ["/etc/passwd", "../outside", "folder/../outside", "C:\\temp\\file", "a\nb", "", "./main.tf", "folder//main.tf"]) {
    assert.throws(() => buildLabFileCommand({ operation: "read", path }, randomUUID()), /relative workspace path/);
  }
  assert.throws(() => buildLabFileCommand({ operation: "delete" }, randomUUID()), /file operation/);
  assert.throws(() => buildLabFileCommand({ operation: "list" }, "bad-id"), /request ID/);
  for (const content of ["x".repeat(LAB_FILE_MAX_BYTES + 1), "a\0b", "é".repeat(LAB_FILE_MAX_BYTES)]) {
    assert.throws(() => buildLabFileCommand({ operation: "write", path: "file.txt", content, version: null }, randomUUID()), /UTF-8/);
  }
  assert.throws(() => buildLabFileCommand({ operation: "write", path: "file.txt", content: "ok", version: "stale" }, randomUUID()), /version/);
  assert.throws(() => buildLabFileCommand({ operation: "write", path: "file.txt", content: randomBytes(11000).toString("base64"), version: null }, randomUUID()), /too large for one editor save/);
});

test("identical requests generate identical bounded commands for existing queue idempotency", () => {
  const id = randomUUID();
  const request = { operation: "read", path: "main.tf" } as const;
  const command = buildLabFileCommand(request, id);
  assert.equal(command, buildLabFileCommand(request, id));
  assert.ok(command.startsWith(fileCommandPrefix(id)));
  assert.ok(command.length < 8000);
});

test("the actual AWS project and full reference pipeline fit in a single editor save", () => {
  const fixture = join(process.cwd(), "aws-lab/exercises/aws-service-release-v1");
  for (const file of ["candidate/main.tf", "candidate/app.py", "candidate/variables.tf", "candidate/pipeline.sh", "assessor/pipeline.sh"]) {
    const content = readFileSync(join(fixture, file), "utf8");
    assert.ok(buildLabFileCommand({ operation: "write", path: file.split("/").pop(), content, version: null }, randomUUID()).length <= 8000);
  }
});

test("real editor payload lists, creates, opens and saves multiline Unicode source without executing it", pythonTest, () => workspace((directory) => {
  const content = "# café 🧪\nprint(\"$HOME `quoted` $(touch should-not-exist)\")\n";
  const created = run(directory, { operation: "write", path: "nested/app.py", content, version: null }).result();
  assert.ok(created.operation !== "list");
  assert.equal(created.content, content);
  assert.equal(readFileSync(join(directory, "nested/app.py"), "utf8"), content);
  const opened = run(directory, { operation: "read", path: "nested/app.py" }).result();
  assert.ok(opened.operation !== "list");
  assert.equal(opened.version, created.version);
  run(directory, { operation: "write", path: "nested/app.py", content: "", version: opened.version }).result();
  assert.equal(readFileSync(join(directory, "nested/app.py"), "utf8"), "");
  mkdirSync(join(directory, ".terraform"));
  writeFileSync(join(directory, ".terraform/provider"), "hidden");
  assert.deepEqual(run(directory, { operation: "list" }).result(), { operation: "list", files: ["nested/app.py"], truncated: false });
}));

test("save refuses stale versions and new-file collisions without changing source", pythonTest, () => workspace((directory) => {
  writeFileSync(join(directory, "main.tf"), "original");
  const opened = run(directory, { operation: "read", path: "main.tf" }).result();
  assert.ok(opened.operation !== "list");
  writeFileSync(join(directory, "main.tf"), "changed by command");
  for (const version of [null, opened.version]) {
    assert.throws(() => run(directory, { operation: "write", path: "main.tf", content: "overwrite", version }).result(), /changed since you opened/);
    assert.equal(readFileSync(join(directory, "main.tf"), "utf8"), "changed by command");
  }
}));

test("editor refuses binary, oversized and missing files and directories", pythonTest, () => workspace((directory) => {
  writeFileSync(join(directory, "binary"), Buffer.from([0, 1, 2]));
  writeFileSync(join(directory, "large"), "x".repeat(LAB_FILE_MAX_BYTES + 1));
  mkdirSync(join(directory, "folder"));
  for (const path of ["binary", "large", "missing", "folder"]) {
    assert.throws(() => run(directory, { operation: "read", path }).result());
  }
}));

test("editor refuses outside symlink targets", { skip: !pythonAvailable || process.platform === "win32" }, () => workspace((directory) => {
  workspace((outside) => {
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(outside, join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => run(directory, { operation: "read", path: "linked/secret.txt" }).result(), /inside the workspace/);
    assert.throws(() => run(directory, { operation: "write", path: "linked/new.txt", content: "outside", version: null }).result(), /inside the workspace/);
  });
}));

test("saving a script preserves its execute mode on POSIX", { skip: !pythonAvailable || process.platform === "win32" }, () => workspace((directory) => {
  const path = join(directory, "pipeline.sh");
  writeFileSync(path, "#!/bin/sh\ntrue\n"); chmodSync(path, 0o755);
  const opened = run(directory, { operation: "read", path: "pipeline.sh" }).result();
  assert.ok(opened.operation !== "list");
  run(directory, { operation: "write", path: "pipeline.sh", content: "#!/bin/sh\necho ok\n", version: opened.version }).result();
  assert.equal(statSync(path).mode & 0o777, 0o755);
}));
