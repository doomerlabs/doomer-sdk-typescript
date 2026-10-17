/** Evidence reported by a scanner or artifact reader. Output is untrusted text, never HTML. */
export interface ReviewSource {
  id: string;
  kind: string;
  title: string;
  status: "passed" | "findings" | "error" | "partial" | "unavailable";
  summary: string;
  output?: string;
  data?: Record<string, unknown>;
  truncated?: boolean;
  version?: string;
  reviewer?: string;
  scope?: string[];
  headSha?: string;
  url?: string;
}

const secretKey =
  /^(password|passwd|secret|token|access[_-]?token|api[_-]?key|authorization|private[_-]?key)$/i;
function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

/** Producers must remove domain-specific secrets before reporting. This is defense in depth. */
export function normalizeReviewSource(input: ReviewSource): ReviewSource {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.id))
    throw new Error("Invalid review source ID.");
  if (!["passed", "findings", "error", "partial", "unavailable"].includes(input.status))
    throw new Error("Invalid review source status.");
  let truncated = input.truncated ?? false;
  const bound = (value: string, max: number) => {
    if (typeof value !== "string") throw new Error("Source text must be a string.");
    const safe = redact(value);
    if (safe.length > max) truncated = true;
    // These budgets are UTF-8 bytes, including multi-byte scanner output.
    const bytes = Buffer.from(safe);
    if (bytes.length <= max) return safe;
    truncated = true;
    return new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.subarray(0, max))
      .replace(/\uFFFD$/, "");
  };
  const required = (value: string, max: number) => {
    const text = bound(value, max).trim();
    if (!text) throw new Error("Source kind, title and summary must be non-empty.");
    return text;
  };
  const result: ReviewSource = {
    id: input.id,
    kind: required(input.kind, 80),
    title: required(input.title, 200),
    status: input.status,
    summary: required(input.summary, 2000),
  };
  if (input.output !== undefined) result.output = bound(input.output, 32768);
  if (input.data !== undefined) {
    if (!input.data || Array.isArray(input.data) || typeof input.data !== "object")
      throw new Error("Source data must be an object.");
    const serialized = JSON.stringify(input.data, (key, value) =>
      secretKey.test(key) ? "[REDACTED]" : typeof value === "string" ? redact(value) : value,
    );
    if (Buffer.byteLength(serialized) + Buffer.byteLength(result.output ?? "") > 32768)
      truncated = true;
    else result.data = JSON.parse(serialized);
  }
  if (input.reviewer !== undefined) result.reviewer = bound(input.reviewer, 500);
  if (input.version !== undefined) result.version = bound(input.version, 200);
  if (input.headSha !== undefined) result.headSha = bound(input.headSha, 100);
  if (input.scope !== undefined) {
    if (input.scope.length > 100) truncated = true;
    result.scope = input.scope.slice(0, 100).map((item) => bound(item, 500));
  }
  if (input.url !== undefined) {
    const url = new URL(input.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      input.url.length > 2000
    )
      throw new Error("Source URL must be HTTP(S) without credentials.");
    result.url = input.url;
  }
  if (truncated) result.truncated = true;
  return result;
}
