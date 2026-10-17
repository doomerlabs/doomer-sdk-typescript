export const REVIEW_SOURCE_STATUSES = [
  "passed",
  "findings",
  "error",
  "partial",
  "unavailable",
] as const;

/** Evidence reported by a scanner or artifact reader. Output is untrusted text, never HTML. */
export interface ReviewSource {
  id: string;
  kind: string;
  title: string;
  status: (typeof REVIEW_SOURCE_STATUSES)[number];
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

const sourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const secretNames =
  "password|passwd|secret|token|access[_-]?token|access[_-]?key|api[_-]?key|authorization|private[_-]?key";
const credentialName = `(?:[a-z0-9]+[_-])*(?:${secretNames})`;
const secretKey = new RegExp(`^${credentialName}$`, "i");
const secretAssignment = new RegExp(
  `((?<![\\w-])["']?${credentialName}["']?\\s*[=:]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:Basic|Bearer)\\s+[^\\s,;]+|[^\\s,;]+)`,
  "gi",
);

export class ReviewSourceValidationError extends Error {
  readonly code: string = "invalid_review_source";
  readonly sourceId?: string;
  constructor(
    readonly field: string,
    detail: string,
    sourceId?: string,
  ) {
    const safeId =
      typeof sourceId === "string" && sourceIdPattern.test(sourceId) ? sourceId : undefined;
    super(`${field}${safeId ? ` (source ${safeId})` : ""}: ${detail}`);
    this.sourceId = safeId;
    this.name = "ReviewSourceValidationError";
  }
}

export class ReviewSourceCapacityError extends ReviewSourceValidationError {
  override readonly code = "review_source_capacity_exceeded";
  constructor(sourceId: string) {
    super("ctx.review.source", "at most 32 sources are allowed", sourceId);
    this.name = "ReviewSourceCapacityError";
  }
}

export function parseReviewSourceUrl(value: unknown, field: string, sourceId?: string): URL {
  if (typeof value !== "string")
    throw new ReviewSourceValidationError(field, "must be an HTTP(S) URL", sourceId);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReviewSourceValidationError(field, "must be a valid HTTP(S) URL", sourceId);
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new ReviewSourceValidationError(
      field,
      "must be an HTTP(S) URL without credentials",
      sourceId,
    );
  return url;
}

function redact(text: string): string {
  // Hide assignment values first so a Bearer mention cannot consume their keys.
  return text
    .replace(secretAssignment, '$1"[REDACTED]"')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*(?![A-Za-z0-9._~+\/=-])/gi, "$1[REDACTED]");
}

/** JSON Schema limits characters; the wire validator also enforces this shared UTF-8 budget. */
export function validateReviewSourceBudget(source: ReviewSource, label: string): void {
  let data: string;
  try {
    data = JSON.stringify(source.data) ?? "";
  } catch {
    throw new ReviewSourceValidationError(`${label}.data`, "must be JSON-serializable", source.id);
  }
  if (Buffer.byteLength(source.output ?? "") + Buffer.byteLength(data) > 32768)
    throw new ReviewSourceValidationError(
      `${label}.data/output`,
      "combined UTF-8 payload exceeds 32768 bytes",
      source.id,
    );
}

/** Decode valid runs only; lone percent signs and invalid UTF-8 remain legal URL text. */
function redactUrlComponent(encoded: string): string {
  const decoded = encoded.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
  const safe = redact(decoded);
  // Re-encode changed components so decoded separators cannot alter URL structure.
  return safe === decoded ? encoded : encodeURIComponent(safe);
}

export function validateSourceIds(
  value: unknown,
  field: string,
): asserts value is string[] | undefined {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== "string" || !sourceIdPattern.test(id))
  )
    throw new ReviewSourceValidationError(field, "must be an array of valid source IDs");
}

/** Producers must remove domain-specific secrets before reporting. This is defense in depth. */
export function normalizeReviewSource(input: ReviewSource, label = "reviewSource"): ReviewSource {
  const safeId =
    typeof input?.id === "string" && sourceIdPattern.test(input.id) ? input.id : undefined;
  const fail = (field: string, detail: string): never => {
    throw new ReviewSourceValidationError(`${label}.${field}`, detail, safeId);
  };
  if (!safeId) fail("id", "must be a valid source ID");
  if (!REVIEW_SOURCE_STATUSES.some((status) => status === input.status))
    fail("status", "must be a supported source status");
  if (input.truncated !== undefined && typeof input.truncated !== "boolean")
    fail("truncated", "must be a boolean");
  let truncated = input.truncated ?? false;
  const bound = (value: string, max: number, field: string) => {
    if (typeof value !== "string") fail(field, "must be a string");
    const safe = field === "output" ? redact(value) : value;
    const bytes = Buffer.from(safe);
    if (bytes.length <= max) return safe;
    truncated = true;
    return new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.subarray(0, max))
      .replace(/\uFFFD$/, "");
  };
  const required = (value: string, max: number, field: string) => {
    const text = bound(value, max, field).trim();
    if (!text) fail(field, "must be non-empty");
    return text;
  };
  const result: ReviewSource = {
    id: input.id,
    kind: required(input.kind, 80, "kind"),
    title: required(input.title, 200, "title"),
    status: input.status,
    summary: required(input.summary, 2000, "summary"),
  };
  if (input.output !== undefined) result.output = bound(input.output, 32768, "output");
  if (input.data !== undefined) {
    if (!input.data || Array.isArray(input.data) || typeof input.data !== "object")
      fail("data", "must be an object");
    let serialized = "";
    try {
      serialized = JSON.stringify(input.data, (key, value) =>
        secretKey.test(key) ? "[REDACTED]" : typeof value === "string" ? redact(value) : value,
      );
      const parsed: unknown = JSON.parse(serialized);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        fail("data", "must serialize to an object");
    } catch (error) {
      if (error instanceof ReviewSourceValidationError) throw error;
      fail("data", "must be a JSON-serializable object (received object)");
    }
    const dataBytes = Buffer.byteLength(serialized);
    if (dataBytes > 32768) {
      truncated = true;
    } else {
      result.data = JSON.parse(serialized);
      if (result.output !== undefined)
        result.output = bound(result.output, 32768 - dataBytes, "output");
    }
  }
  if (input.reviewer !== undefined) result.reviewer = bound(input.reviewer, 500, "reviewer");
  if (input.version !== undefined) result.version = bound(input.version, 200, "version");
  if (input.headSha !== undefined) result.headSha = bound(input.headSha, 100, "headSha");
  if (input.scope !== undefined) {
    if (!Array.isArray(input.scope)) fail("scope", "must be an array of strings");
    const invalidIndex = input.scope.findIndex((item) => typeof item !== "string");
    if (invalidIndex !== -1) fail(`scope[${invalidIndex}]`, "must be a string");
    if (input.scope.length > 100) truncated = true;
    result.scope = input.scope
      .slice(0, 100)
      .map((item, index) => bound(item, 500, `scope[${index}]`));
  }
  if (input.url !== undefined) {
    if (typeof input.url !== "string") fail("url", "must be an HTTP(S) URL without credentials");
    try {
      const url = parseReviewSourceUrl(input.url, `${label}.url`, safeId);
      const params = new URLSearchParams();
      for (const [key, value] of url.searchParams) {
        params.append(key, secretKey.test(key) ? "[REDACTED]" : redact(value));
      }
      url.search = params.toString();
      url.pathname = url.pathname.split("/").map(redactUrlComponent).join("/");
      if (url.hash) url.hash = `#${redactUrlComponent(url.hash.slice(1))}`;
      result.url = url.toString();
      if (result.url.length > 2000) fail("url", "must be at most 2000 characters");
    } catch (error) {
      if (error instanceof ReviewSourceValidationError) throw error;
      fail("url", "must be a valid HTTP(S) URL without credentials, at most 2000 characters");
    }
  }
  if (truncated) result.truncated = true;
  return result;
}
