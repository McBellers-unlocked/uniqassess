/** Shared editor protocol. File operations use the existing, audited lab queue. */
export const LAB_FILE_MAX_BYTES = 16_384;
export const LAB_FILE_RESULT = "UNIQASSESS_FILE_V1:";
export type LabFileRequest =
  | { operation: "list" }
  | { operation: "read"; path: string }
  | { operation: "write"; path: string; content: string; version: string | null };
export type LabFileResult =
  | { operation: "list"; files: string[]; truncated: boolean }
  | { operation: "read" | "write"; path: string; content: string; version: string };

export function fileCommandPrefix(requestId: string) {
  return `# lab-file ${requestId}\n`;
}

export function parseLabFileResult(stdout: string): LabFileResult {
  const line = stdout.split("\n").find((value) => value.startsWith(LAB_FILE_RESULT));
  if (!line) throw new Error("No file result was recorded. Refresh the lab and retry.");
  const result = JSON.parse(line.slice(LAB_FILE_RESULT.length));
  if (result.error) throw new Error(String(result.error));
  if (result.operation === "list" && Array.isArray(result.files) && result.files.every((file: unknown) => typeof file === "string")) return result;
  if (["read", "write"].includes(result.operation) && typeof result.path === "string" && typeof result.content === "string" && /^[a-f0-9]{64}$/.test(result.version)) return result;
  throw new Error("The file result was unreadable. Your editor text has been kept.");
}
