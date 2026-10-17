import type { RuleContext } from "./index.js";
import { ModelReviewError, type ModelReviewRequest, ModelUnavailableError } from "./model.js";
import { writeRepositoryDiagnostic } from "./repository-diagnostics.js";

export const INCOMPLETE_REVIEW_SUMMARY =
  "Review completed with limited coverage. Supported findings are retained; no whole-change clean opinion is available.";

export type ReviewIncompleteReason =
  | "candidate_validation"
  | "assessment_validation"
  | "source_coverage";
export interface CandidateValidationIssue {
  field: string;
  code:
    | "missing"
    | "invalid_type"
    | "invalid_value"
    | "too_short"
    | "too_long"
    | "placeholder"
    | "repetition";
  actualLength?: number;
  minimumLength?: number;
  maximumLength?: number;
}
export interface CandidateRecoveryOptions<T extends object> {
  candidates: readonly T[];
  /** Diagnostic identity only. Never include source text. */
  reviewer?: string;
  kind?: "candidate" | "assessment";
  /** Return content-free issues. Programming errors thrown by validators propagate. */
  validate(
    candidate: T,
  ): readonly CandidateValidationIssue[] | Promise<readonly CandidateValidationIssue[]>;
  repair?: {
    /** Only these rejected top-level fields can change. Identity/evidence remain untouched. */
    fields: readonly (keyof T & string)[];
    request(input: {
      candidate: T;
      issues: readonly CandidateValidationIssue[];
      remainingTimeoutMs: number;
    }): ModelReviewRequest<Partial<T>>;
  };
  /** Total repair calls across the batch, default 2; maximum 10. */
  maximumRepairCalls?: number;
  /** Shared repair deadline, default ten minutes; explicit shorter limits are preserved. */
  timeoutMs?: number;
}
export interface CandidateRecoveryResult<T> {
  candidates: T[];
  withheld: { index: number; issues: readonly CandidateValidationIssue[] }[];
  repaired: number;
  repairCalls: number;
}

/** Independent validation/recovery; an invalid candidate never discards valid peers. */
export async function recoverReviewCandidates<T extends object>(
  context: {
    model: Pick<RuleContext["model"], "review">;
    review: Pick<RuleContext["review"], "incomplete">;
  },
  options: CandidateRecoveryOptions<T>,
): Promise<CandidateRecoveryResult<T>> {
  if (options.kind !== undefined && !["candidate", "assessment"].includes(options.kind))
    throw new TypeError("Invalid candidate recovery kind.");
  const maximumRepairCalls = options.maximumRepairCalls ?? 2;
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (
    !Number.isInteger(maximumRepairCalls) ||
    maximumRepairCalls < 0 ||
    maximumRepairCalls > 10 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600_000 ||
    options.candidates.length > 100
  ) {
    throw new TypeError(
      "Candidate recovery requires at most 100 candidates, 0–10 repair calls, and a 1–600000ms deadline.",
    );
  }
  for (const field of options.repair?.fields ?? []) requireField(field);
  const startedAt = performance.now();
  const result: CandidateRecoveryResult<T> = {
    candidates: [],
    withheld: [],
    repaired: 0,
    repairCalls: 0,
  };
  for (const [index, original] of options.candidates.entries()) {
    let repairAttempted = false;
    let candidate = original;
    let issues = safeIssues(await options.validate(candidate));
    if (issues.length === 0) {
      result.candidates.push(candidate);
      continue;
    }
    diagnostic(options.reviewer, index, issues, 0, "rejected");
    const fields = new Set(
      issues
        .map((issue) => issue.field)
        .filter((field) => options.repair?.fields.includes(field as keyof T & string)),
    );
    const remainingTimeoutMs = Math.floor(timeoutMs - (performance.now() - startedAt));
    if (
      options.repair &&
      fields.size > 0 &&
      issues.every((issue) => fields.has(issue.field)) &&
      result.repairCalls < maximumRepairCalls &&
      remainingTimeoutMs > 0
    ) {
      // Request-construction errors are programming errors, not malformed model output.
      const request = options.repair.request({ candidate, issues, remainingTimeoutMs });
      const requestedTimeout = request.budget?.timeoutMs ?? remainingTimeoutMs;
      if (
        !Number.isInteger(requestedTimeout) ||
        requestedTimeout < 1 ||
        requestedTimeout > 600_000
      ) {
        throw new ModelReviewError("Invalid candidate repair request timeout.", {
          code: "invalid_model_budget",
        });
      }
      repairAttempted = true;
      result.repairCalls += 1;
      try {
        const { output } = await context.model.review<Partial<T>>({
          ...request,
          budget: { ...request.budget, timeoutMs: Math.min(requestedTimeout, remainingTimeoutMs) },
        });
        if (typeof output !== "object" || output === null || Array.isArray(output)) {
          throw new ModelReviewError("Candidate repair returned a non-object.", {
            code: "invalid_model_output",
          });
        }
        candidate = { ...original };
        for (const field of fields) {
          if (Object.hasOwn(output, field))
            (candidate as Record<string, unknown>)[field] = (output as Record<string, unknown>)[
              field
            ];
        }
      } catch (error) {
        if (!(error instanceof ModelReviewError) && !(error instanceof ModelUnavailableError))
          throw error;
        if (
          error instanceof ModelReviewError &&
          [
            "invalid_model_request",
            "model_request_too_large",
            "invalid_model_schema",
            "invalid_model_budget",
            "invalid_broker_endpoint",
            "invalid_broker_token",
          ].includes(error.code ?? "")
        )
          throw error;
        diagnostic(options.reviewer, index, issues, 1, "repair_failed");
      }
      // Validation is outside the model-error catch: never swallow validator bugs.
      issues = safeIssues(await options.validate(candidate));
      if (issues.length === 0) {
        result.repaired += 1;
        result.candidates.push(candidate);
        diagnostic(options.reviewer, index, [], 1, "repaired");
        continue;
      }
    }
    result.withheld.push({ index, issues });
    diagnostic(options.reviewer, index, issues, repairAttempted ? 1 : 0, "withheld");
  }
  if (result.withheld.length > 0)
    context.review.incomplete(
      options.kind === "assessment" ? "assessment_validation" : "candidate_validation",
    );
  return result;
}

/** Shared prose checks, with domain-specific length limits supplied by the reviewer. */
export function validateReviewText(
  value: unknown,
  options: { field: string; minimumLength: number; maximumLength: number },
): CandidateValidationIssue[] {
  requireField(options.field);
  const { minimumLength, maximumLength } = options;
  if (
    !Number.isInteger(minimumLength) ||
    minimumLength < 1 ||
    !Number.isInteger(maximumLength) ||
    maximumLength < minimumLength
  )
    throw new TypeError("Invalid review text length limits.");
  const issue = (
    code: CandidateValidationIssue["code"],
    actualLength?: number,
  ): CandidateValidationIssue[] => [
    { ...options, code, ...(actualLength === undefined ? {} : { actualLength }) },
  ];
  if (value == null) return issue("missing");
  if (typeof value !== "string") return issue("invalid_type");
  const text = value.trim();
  if (text.length < minimumLength) return issue("too_short", text.length);
  if (text.length > maximumLength) return issue("too_long", text.length);
  if (
    /^(?:assessment|detail|impact|none|placeholder|principle|quote|recommendation|string|summary|title|tradeoffs?)$/i.test(
      text,
    )
  )
    return issue("placeholder", text.length);
  const counts = new Map<string, number>();
  for (const unit of text
    .toLowerCase()
    .split(/(?:\r?\n+|(?<=[.!?])\s+)/)
    .map((unit) => unit.replace(/[.!?]+$/u, "").trim())
    .filter((unit) => unit.length >= 2)) {
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count >= 4) ? issue("repetition", text.length) : [];
}

function requireField(field: string): void {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field) ||
    ["__proto__", "constructor", "prototype"].includes(field)
  )
    throw new TypeError("Invalid candidate validation field.");
}
function safeIssues(issues: readonly CandidateValidationIssue[]): CandidateValidationIssue[] {
  if (issues.length > 32) throw new TypeError("Too many candidate validation issues.");
  return issues.map((issue) => {
    requireField(issue.field);
    if (
      ![
        "missing",
        "invalid_type",
        "invalid_value",
        "too_short",
        "too_long",
        "placeholder",
        "repetition",
      ].includes(issue.code)
    )
      throw new TypeError("Invalid candidate validation code.");
    const safe: CandidateValidationIssue = { field: issue.field, code: issue.code };
    for (const key of ["actualLength", "minimumLength", "maximumLength"] as const) {
      const value = issue[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0)
          throw new TypeError("Invalid candidate length diagnostic.");
        safe[key] = value;
      }
    }
    return safe;
  });
}
function diagnostic(
  reviewer: string | undefined,
  index: number,
  issues: readonly CandidateValidationIssue[],
  attempt: number,
  outcome: string,
): void {
  const identity = (value: string | undefined) =>
    value && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) ? value : "unknown";
  writeRepositoryDiagnostic({
    event: "review.candidate-validation",
    jobId: identity(process.env.HOSTED_REVIEW_JOB_ID),
    reviewer: identity(reviewer),
    stage: "candidate_validation",
    provider: identity(process.env.ADVERSARY_MODEL_PROVIDER),
    model: identity(process.env.ADVERSARY_MODEL),
    candidateIndex: index,
    attempt,
    outcome,
    issues,
  });
}
