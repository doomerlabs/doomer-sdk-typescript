import { randomUUID } from "node:crypto";

import { normalizeRepositoryPath } from "./repository-path.js";

export type RepositoryReadReason =
  | "excluded_file"
  | "symlink_rejected"
  | "not_regular_file"
  | "unsafe_path"
  | "invalid_range"
  | "range_past_eof"
  | "per_read_byte_limit"
  | "binary_file"
  | "change_context_missing"
  | "file_not_changed"
  | "invalid_revision";

export class RepositoryReadError extends Error {
  constructor(
    readonly reason: RepositoryReadReason,
    message: string,
  ) {
    super(message);
    this.name = "RepositoryReadError";
  }
}

export function readErrorReason(error: unknown): string {
  if (error instanceof RepositoryReadError) return error.reason;
  const code = (error as { code?: unknown } | null)?.code;
  const codes: Record<string, string> = {
    ENOENT: "file_missing",
    EACCES: "permission_denied",
    EPERM: "permission_denied",
    ENOTDIR: "parent_not_directory",
    EIO: "io_error",
    ENOBUFS: "command_output_limit",
  };
  return typeof code === "string" && Object.hasOwn(codes, code) ? codes[code] : "read_failed";
}

export function safeDiagnosticPath(path: string, knownPaths: ReadonlySet<string>): string {
  const normalized = normalizeRepositoryPath(path);
  if (normalized === undefined) return "[invalid repository path]";
  return knownPaths.has(normalized) ? normalized : "[unverified repository path]";
}

/** Optional diagnostics must never alter a review result or replace its error. */
export function writeRepositoryDiagnostic(record: Record<string, unknown>): void {
  try {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    // A failed diagnostic sink does not affect repository retrieval.
  }
}

type Counts = { rounds: number; toolCalls: number; bytes: number };
type Limits = {
  maxRounds: number;
  maxToolCalls: number;
  maxTotalBytes: number;
  maxBytesPerRead: number;
  maxLinesPerRead: number;
};
export function repositoryDiagnostics(
  reviewer: string | undefined,
  limits: Limits,
  enabled = true,
) {
  const readingId = randomUUID();
  // Each retrieval is already bounded to 128 operations. Cap gap diagnostics too.
  let records = 0;
  let omitted = 0;
  const emit = (details: Record<string, string | number | boolean>, counts: Counts) => {
    if (!enabled) return;
    if (records++ >= 1024) {
      omitted++;
      return;
    }
    writeRepositoryDiagnostic({
      event: "repository.read-detail",
      readingId,
      reviewer:
        reviewer && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/.test(reviewer) ? reviewer : "unknown",
      ...details,
      ...counts,
      callsRemaining: Math.max(0, limits.maxToolCalls - counts.toolCalls),
      bytesRemaining: Math.max(0, limits.maxTotalBytes - counts.bytes),
    });
  };
  return {
    readingId,
    emit,
    start: () =>
      emit(
        { kind: "session", outcome: "started", ...limits },
        { rounds: 0, toolCalls: 0, bytes: 0 },
      ),
    finish: (counts: Counts, complete: boolean) => {
      // Reserve a completion record even when the diagnostic cap was reached.
      records = Math.min(records, 1023);
      emit({ kind: "session", outcome: "finished", complete, omittedRecords: omitted }, counts);
    },
  };
}
