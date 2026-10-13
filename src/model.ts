import { Ajv2020 } from "ajv/dist/2020.js";
import { Agent, type Dispatcher } from "undici";
import { modelAttemptDiagnostics } from "./model-diagnostics.js";
import type {
  ModelRepositoryCitation,
  ModelRepositoryRetrieval,
  ModelRepositoryToolOptions,
} from "./repository-model.js";

export const ADVERSARY_MODEL_PROTOCOL_VERSION = 1;
export const ADVERSARY_MODEL_ENDPOINT_ENV = "ADVERSARY_MODEL_ENDPOINT";
export const ADVERSARY_MODEL_TOKEN_ENV = "ADVERSARY_MODEL_TOKEN";

const DEFAULT_MODEL_TIMEOUT_MS = 600_000;
const MAX_MODEL_TIMEOUT_MS = 600_000;
const DEFAULT_MAXIMUM_OUTPUT_TOKENS = 8_192;
const MAX_MAXIMUM_OUTPUT_TOKENS = 65_536;
const MAX_PROMPT_BYTES = 256 << 10;
const MAX_INPUT_BYTES = 4 << 20;
const MAX_SCHEMA_BYTES = 512 << 10;
const MAX_RESPONSE_BYTES = 4 << 20;
const DEFAULT_BROKER_MAXIMUM_ATTEMPTS = 3;
const DEFAULT_BROKER_RETRY_DELAY_MS = 250;
const MAX_BROKER_RETRY_DELAY_MS = 5_000;
const DEFAULT_VALIDATION_MAXIMUM_ATTEMPTS = 3;
const MAX_VALIDATION_MAXIMUM_ATTEMPTS = 5;
const MAX_VALIDATION_FEEDBACK_BYTES = 8 << 10;
// Internal request metadata survives wrapper spreads but never enters broker JSON.
const outputRepairRequest = Symbol("sdk.output-repair");
type OutputRepairRequest = ModelReviewRequest & { [outputRepairRequest]?: true };

// Fetch supplies its own five-minute header timeout, overriding Agent defaults.
// Override dispatch options for this review only; its shared AbortSignal remains
// the authoritative deadline across connection, headers, body, and retries.
class ModelBrokerDispatcher extends Agent {
  constructor(private readonly deadlineMs: number) {
    super({ connectTimeout: deadlineMs });
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandlers,
  ): boolean {
    return super.dispatch(
      {
        ...options,
        headersTimeout: this.deadlineMs,
        bodyTimeout: this.deadlineMs,
      },
      handler,
    );
  }
}

export interface ModelReviewBudget {
  maximumOutputTokens?: number;
  timeoutMs?: number;
}

export interface ModelReviewValidation<T = unknown> {
  /** Validate a completed model result. Throw to retry generation with the error as feedback. */
  validate(result: ModelReviewResult<T>): void | Promise<void>;
  /** Total generation attempts, including the first. Defaults to 3 and is capped at 5. */
  maximumAttempts?: number;
}

export interface ModelReviewRequest<T = unknown> {
  /** Local timing classification only; never sent to the broker or model. */
  diagnosticStage?: "model_review" | "repository_planning";
  prompt: string;
  input: unknown;
  schema: Record<string, unknown>;
  budget?: ModelReviewBudget;
  validation?: ModelReviewValidation<T>;
  tools?: {
    repository: ModelRepositoryToolOptions;
  };
}

export interface ModelReviewUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelReviewResult<T = unknown> {
  output: T;
  provider: string;
  model: string;
  usage?: ModelReviewUsage;
  citations?: readonly ModelRepositoryCitation[];
  retrieval?: ModelRepositoryRetrieval;
}

export interface ReviewModel {
  review<T = unknown>(request: ModelReviewRequest<T>): Promise<ModelReviewResult<T>>;
}

export interface BrokerReviewModelOptions {
  maximumAttempts?: number;
  initialRetryDelayMs?: number;
  random?: () => number;
}

/**
 * Request a short noun-phrase concern suitable after "I would address …".
 * Implemented by the SDK via {@link ReviewModel.review} (CLI broker pass-through).
 */
export interface ModelConcernRequest {
  /** Free-form title, clause, or draft concern to rewrite. */
  text: string;
  budget?: ModelReviewBudget;
  /**
   * Extra attempts when the model returns a phrase that fails noun-phrase validation.
   * Defaults to 1 retry (2 total attempts).
   */
  maxAttempts?: number;
}

export interface ModelConcernResult {
  /** Validated noun phrase (see requireOpinionConcern). */
  concern: string;
  /** False when `text` was already a valid noun phrase (no broker call). */
  rewritten: boolean;
  provider: string;
  model: string;
  usage?: ModelReviewUsage;
}

/** Rule-context model: broker review plus opinion-concern rewrite. */
export type ContextualReviewModel = ReviewModel & {
  concern(request: ModelConcernRequest): Promise<ModelConcernResult>;
};

export type ModelEnvironment = Readonly<Record<string, string | undefined>>;

interface ModelBrokerRequest
  extends Omit<ModelReviewRequest, "validation" | "tools" | "diagnosticStage"> {
  protocolVersion: typeof ADVERSARY_MODEL_PROTOCOL_VERSION;
}

interface ModelBrokerResponse {
  protocolVersion: typeof ADVERSARY_MODEL_PROTOCOL_VERSION;
  output: unknown;
  provider: string;
  model: string;
  usage?: ModelReviewUsage;
}

interface ModelBrokerErrorResponse {
  usage?: ModelReviewUsage;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
}

type NormalizedModelReviewRequest = Omit<
  ModelReviewRequest,
  "budget" | "validation" | "tools" | "diagnosticStage"
> & {
  budget: Required<ModelReviewBudget>;
};

export class ModelUnavailableError extends Error {
  constructor(message = "Model review is unavailable for this adversary execution.") {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export class ModelReviewError extends Error {
  readonly code?: string;
  readonly retryable: boolean;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
  /** Reported usage from completed requests, including rejected output. */
  readonly usage?: ModelReviewUsage;

  constructor(
    message: string,
    options: {
      code?: string;
      retryable?: boolean;
      diagnostics?: Readonly<Record<string, unknown>>;
      usage?: ModelReviewUsage;
    } = {},
  ) {
    super(message);
    this.name = "ModelReviewError";
    this.code = options.code;
    this.diagnostics = options.diagnostics;
    this.usage = options.usage;
    this.retryable = options.retryable ?? false;
  }
}

// The message carries the code because subprocess runners may only retain stderr.
// Never include an upstream error body, prompt, or validator feedback here.
function exhaustedModelRecovery(
  attempts: number,
  reason: "deadline" | "attempt_limit",
): ModelReviewError {
  return new ModelReviewError(
    `model_request_recovery_exhausted: Model request recovery exhausted after ${attempts} attempt(s) (${reason}).`,
    {
      code: "model_request_recovery_exhausted",
      retryable: false,
      diagnostics: Object.freeze({ attempts, reason }),
    },
  );
}

export function createModelFromEnvironment(
  environment: ModelEnvironment = process.env,
): ReviewModel {
  const endpoint = environment[ADVERSARY_MODEL_ENDPOINT_ENV]?.trim();
  const token = environment[ADVERSARY_MODEL_TOKEN_ENV]?.trim();
  if (endpoint === undefined || endpoint === "" || token === undefined || token === "") {
    return unavailableModel();
  }
  return new BrokerReviewModel(endpoint, token);
}

export function unavailableModel(): ReviewModel {
  return Object.freeze({
    async review(): Promise<never> {
      throw new ModelUnavailableError();
    },
  });
}

export class BrokerReviewModel implements ReviewModel {
  readonly endpoint: string;
  readonly #token: string;
  readonly #maximumAttempts: number;
  readonly #initialRetryDelayMs: number;
  readonly #random: () => number;

  constructor(endpoint: string, token: string, options: BrokerReviewModelOptions = {}) {
    const parsed = new URL(endpoint);
    if (
      parsed.protocol !== "http:" ||
      (parsed.hostname !== "127.0.0.1" &&
        parsed.hostname !== "::1" &&
        parsed.hostname !== "[::1]" &&
        parsed.hostname !== "localhost")
    ) {
      throw new ModelReviewError(
        "The model broker endpoint must use HTTP on the local loopback interface.",
        { code: "invalid_broker_endpoint" },
      );
    }
    if (token.trim() === "") {
      throw new ModelReviewError("The model broker token must not be empty.", {
        code: "invalid_broker_token",
      });
    }
    this.endpoint = parsed.toString();
    this.#token = token;
    const maximumAttempts = options.maximumAttempts ?? DEFAULT_BROKER_MAXIMUM_ATTEMPTS;
    const initialRetryDelayMs = options.initialRetryDelayMs ?? DEFAULT_BROKER_RETRY_DELAY_MS;
    requireIntegerRange(maximumAttempts, "maximumAttempts", 1, 5);
    requireIntegerRange(initialRetryDelayMs, "initialRetryDelayMs", 0, MAX_BROKER_RETRY_DELAY_MS);
    this.#maximumAttempts = maximumAttempts;
    this.#initialRetryDelayMs = initialRetryDelayMs;
    this.#random = options.random ?? Math.random;
  }

  async review<T = unknown>(request: ModelReviewRequest<T>): Promise<ModelReviewResult<T>> {
    if (request.tools?.repository !== undefined) {
      throw new ModelReviewError(
        "Repository model tools require ctx.model so the SDK can enforce the repository boundary.",
        { code: "invalid_model_request" },
      );
    }
    const normalized = normalizeRequest(request);
    const validationOwnsRetries = (request as OutputRepairRequest)[outputRepairRequest] === true;
    const diagnostics = modelAttemptDiagnostics(
      normalized.budget.timeoutMs,
      request.diagnosticStage === "repository_planning" ? "repository_planning" : "model_review",
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), normalized.budget.timeoutMs);
    const dispatcher = new ModelBrokerDispatcher(normalized.budget.timeoutMs);
    let usage: ModelReviewUsage = {};
    try {
      for (let attempt = 1; attempt <= this.#maximumAttempts; attempt += 1) {
        const outcome = await this.#reviewAttempt<T>(
          normalized,
          controller.signal,
          dispatcher,
          diagnostics,
          attempt,
        );
        if (outcome.ok) return withAccumulatedResultUsage(outcome.result, usage);
        const error = outcome.error;
        if (!(error instanceof ModelReviewError)) throw error;
        // Only an opted-in validation loop takes ownership of schema retries.
        // Other callers retain the broker's existing retryable-error behavior.
        if (!error.retryable || (validationOwnsRetries && error.code === "invalid_model_output"))
          throw error;
        usage = addModelUsage(usage, error.usage);
        if (controller.signal.aborted) throw exhaustedModelRecovery(attempt, "deadline");
        if (attempt === this.#maximumAttempts)
          throw exhaustedModelRecovery(attempt, "attempt_limit");
        await this.#waitForRetry(
          attempt,
          controller.signal,
          normalized.budget.timeoutMs,
          diagnostics,
        );
      }
      throw exhaustedModelRecovery(this.#maximumAttempts, "attempt_limit");
    } catch (error) {
      if (!(error instanceof ModelReviewError)) throw error;
      throw withAccumulatedUsage(error, usage);
    } finally {
      clearTimeout(timeout);
      // Cleanup must not replace the typed request error or a successful response.
      try {
        await dispatcher.destroy();
      } catch {
        // The dispatcher is no longer used after this request.
      }
    }
  }

  // One attempt owns its timing and error outcome; retry decisions belong to review().
  async #reviewAttempt<T>(
    normalized: NormalizedModelReviewRequest,
    signal: AbortSignal,
    dispatcher: ModelBrokerDispatcher,
    diagnostics: ReturnType<typeof modelAttemptDiagnostics>,
    attempt: number,
  ): Promise<{ ok: true; result: ModelReviewResult<T> } | { ok: false; error: unknown }> {
    const finish = diagnostics.start(attempt);
    try {
      const result = await this.#reviewOnce<T>(normalized, signal, dispatcher);
      finish("succeeded", result.provider, result.model);
      return { ok: true, result };
    } catch (error) {
      finish(
        "failed",
        undefined,
        undefined,
        error instanceof ModelReviewError ? error.code : "broker_unavailable",
      );
      return { ok: false, error };
    }
  }

  // Keep backoff, timeout diagnostics, and error translation together.
  async #waitForRetry(
    attempt: number,
    signal: AbortSignal,
    timeoutMs: number,
    diagnostics: ReturnType<typeof modelAttemptDiagnostics>,
  ): Promise<void> {
    const exponential = Math.min(
      MAX_BROKER_RETRY_DELAY_MS,
      this.#initialRetryDelayMs * 2 ** (attempt - 1),
    );
    const jittered = Math.round(exponential * (0.75 + 0.5 * this.#random()));
    const retryDelayFailed = diagnostics.startRetryDelay(attempt);
    try {
      await waitForRetry(jittered, signal, timeoutMs);
    } catch (error) {
      retryDelayFailed(
        error instanceof ModelReviewError
          ? (error.code ?? "model_review_failed")
          : "model_review_failed",
      );
      if (error instanceof ModelReviewError && error.retryable) {
        throw exhaustedModelRecovery(attempt, "deadline");
      }
      throw error;
    }
  }

  async #reviewOnce<T>(
    normalized: NormalizedModelReviewRequest,
    signal: AbortSignal,
    dispatcher: ModelBrokerDispatcher,
  ): Promise<ModelReviewResult<T>> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          "x-adversary-model-protocol": String(ADVERSARY_MODEL_PROTOCOL_VERSION),
        },
        body: JSON.stringify({
          protocolVersion: ADVERSARY_MODEL_PROTOCOL_VERSION,
          prompt: normalized.prompt,
          input: normalized.input,
          schema: normalized.schema,
          budget: normalized.budget,
        } satisfies ModelBrokerRequest),
        signal,
        dispatcher,
      } as RequestInit & { dispatcher: Dispatcher });
    } catch (error) {
      throw brokerTransportError(error, signal, normalized.budget.timeoutMs);
    }

    let body: string;
    try {
      body = await readBoundedResponse(response);
    } catch (error) {
      throw brokerTransportError(error, signal, normalized.budget.timeoutMs);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      throw new ModelReviewError("Model broker returned malformed JSON.", {
        code: "invalid_broker_response",
      });
    }
    if (!response.ok) {
      const failure = decoded as ModelBrokerErrorResponse;
      if (failure.usage !== undefined) validateUsage(failure.usage);
      throw new ModelReviewError(
        failure.error?.message ?? `Model broker returned HTTP ${response.status}.`,
        {
          code: failure.error?.code ?? "model_review_failed",
          retryable: failure.error?.retryable ?? response.status >= 500,
          ...(failure.usage === undefined ? {} : { usage: failure.usage }),
        },
      );
    }

    const envelope = requireBrokerResponse(decoded);
    validateModelOutput(normalized.schema, envelope.output, envelope.usage);
    return {
      output: envelope.output as T,
      provider: envelope.provider,
      model: envelope.model,
      ...(envelope.usage === undefined ? {} : { usage: envelope.usage }),
    };
  }
}

/**
 * Run schema and adversary-owned semantic validation with SDK-owned bounded regeneration.
 *
 * Each retry receives the validator failure as trusted SDK feedback while retaining the
 * original input. The original timeout is shared by all validation attempts, and usage is
 * aggregated across them. Repository callers may decorate the raw result with citations before
 * validation without repeating repository retrieval.
 */
export async function reviewWithValidation<T>(
  model: ReviewModel,
  request: ModelReviewRequest<T>,
  decorate: (result: ModelReviewResult<T>) => ModelReviewResult<T> = (result) => result,
): Promise<ModelReviewResult<T>> {
  const validation = request.validation;
  const { validation: _validation, tools: _tools, ...baseRequest } = request;
  if (validation === undefined) return decorate(await model.review<T>(baseRequest));

  const maximumAttempts = validation.maximumAttempts ?? DEFAULT_VALIDATION_MAXIMUM_ATTEMPTS;
  requireIntegerRange(
    maximumAttempts,
    "validation.maximumAttempts",
    1,
    MAX_VALIDATION_MAXIMUM_ATTEMPTS,
  );
  const timeoutMs = request.budget?.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const startedAt = Date.now();
  let usage: ModelReviewUsage = {};
  let feedback: string | undefined;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const elapsed = Date.now() - startedAt;
    const remainingTimeoutMs = timeoutMs - elapsed;
    if (remainingTimeoutMs <= 0)
      throw withAccumulatedUsage(exhaustedModelRecovery(attempt - 1, "deadline"), usage);
    let outcome: OutputValidationAttempt<T>;
    try {
      outcome = await reviewValidationAttempt(
        model,
        {
          ...baseRequest,
          prompt:
            feedback === undefined
              ? baseRequest.prompt
              : `${baseRequest.prompt}\n\nSDK VALIDATION FEEDBACK:\nThe previous response failed output validation. Correct the response using this trusted validation result and return the complete response again.\n${JSON.stringify({ attempt, error: feedback })}`,
          budget: { ...baseRequest.budget, timeoutMs: remainingTimeoutMs },
        },
        validation,
        decorate,
      );
    } catch (error) {
      if (!(error instanceof ModelReviewError)) throw error;
      throw withAccumulatedUsage(error, usage);
    }
    usage = addModelUsage(usage, outcome.ok ? outcome.result.usage : outcome.usage);
    if (outcome.ok) {
      return {
        ...outcome.result,
        ...(usage.inputTokens === undefined && usage.outputTokens === undefined ? {} : { usage }),
      };
    }
    feedback = outcome.feedback;
    if (attempt === maximumAttempts)
      throw exhaustedOutputValidation(maximumAttempts, feedback, usage);
  }
  throw new ModelReviewError("Model validation retry loop exhausted unexpectedly.", {
    code: "model_validation_failed",
    retryable: false,
  });
}

type OutputValidationAttempt<T> =
  | { ok: true; result: ModelReviewResult<T> }
  | { ok: false; feedback: string; usage?: ModelReviewUsage };

// Keep generation and semantic validation failures together for one prepared
// request. Neither kind of rejection repeats repository evidence gathering.
async function reviewValidationAttempt<T>(
  model: ReviewModel,
  request: ModelReviewRequest<T>,
  validation: ModelReviewValidation<T>,
  decorate: (result: ModelReviewResult<T>) => ModelReviewResult<T>,
): Promise<OutputValidationAttempt<T>> {
  let result: ModelReviewResult<T>;
  try {
    const prepared: OutputRepairRequest = { ...request, [outputRepairRequest]: true };
    result = decorate(await model.review<T>(prepared));
  } catch (error) {
    if (!(error instanceof ModelReviewError) || error.code !== "invalid_model_output") throw error;
    return {
      ok: false,
      feedback: schemaValidationFeedback(error, request.schema),
      usage: error.usage,
    };
  }
  try {
    await validation.validate(result);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, feedback: boundedValidationFeedback(error), usage: result.usage };
  }
}

function withAccumulatedResultUsage<T>(
  result: ModelReviewResult<T>,
  accumulated: ModelReviewUsage,
): ModelReviewResult<T> {
  const usage = addModelUsage(accumulated, result.usage);
  return {
    ...result,
    ...(usage.inputTokens === undefined && usage.outputTokens === undefined ? {} : { usage }),
  };
}

// Keep interruption classification and metadata intact without mutating an error
// that a model implementation may reuse. Current-error usage is counted once.
function withAccumulatedUsage(error: ModelReviewError, usage: ModelReviewUsage): ModelReviewError {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return error;
  return new ModelReviewError(error.message, {
    code: error.code,
    retryable: error.retryable,
    diagnostics: error.diagnostics,
    usage: addModelUsage(usage, error.usage),
  });
}

function exhaustedOutputValidation(
  attempts: number,
  feedback: string,
  usage: ModelReviewUsage,
): ModelReviewError {
  return new ModelReviewError(
    `Model output failed adversary validation after ${attempts} attempts: ${feedback}`,
    {
      code: "model_validation_failed",
      retryable: false,
      ...(usage.inputTokens === undefined && usage.outputTokens === undefined ? {} : { usage }),
    },
  );
}

// Broker pattern/enum errors can quote rejected model text. Retain only schema-owned
// locations, fixed keywords, numeric limits, and trusted schema descriptions as feedback.
function schemaValidationFeedback(
  error: ModelReviewError,
  schema: Record<string, unknown>,
): string {
  const goLocations = [...error.message.matchAll(/- at '([^'\n]*)': ([^\n]*)/g)];
  const locations =
    goLocations.length > 0
      ? goLocations
      : [...error.message.matchAll(/data((?:\/[^\s;:]*)*) (must [^;\n]*)/g)];
  const messages =
    locations.length === 0
      ? [schemaFailureFeedback(undefined, "", schema)]
      : locations
          .slice(0, 32)
          .map((location) => schemaFailureFeedback(location[1], location[2], schema));
  return boundedValidationFeedback(new Error([...new Set(messages)].join("\n")));
}

function schemaFailureFeedback(
  rawPath: string | undefined,
  detail: string,
  schema: Record<string, unknown>,
): string {
  let node = schema;
  const safePath: string[] = [];
  for (const token of (rawPath ?? "").split("/").filter(Boolean).slice(0, 32)) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties && Object.hasOwn(properties, key)) {
      safePath.push(token.slice(0, 128));
      node = properties[key];
    } else if (
      node.type === "array" &&
      /^\d{1,8}$/.test(key) &&
      node.items &&
      typeof node.items === "object"
    ) {
      safePath.push(key);
      node = node.items as Record<string, unknown>;
    } else {
      safePath.push("*");
      node = {};
    }
  }
  const at = rawPath !== undefined ? ` at /${safePath.join("/")}` : "";
  const length = /^(minLength|maxLength): got (\d{1,8}), want (\d{1,8})$/.exec(detail);
  let reason = "Return a complete response that satisfies the supplied schema.";
  if (length) {
    reason = `${length[1]}: got ${length[2]} characters; required ${length[3]}.`;
  } else if (/^must NOT have (more|fewer) than \d+ characters$/.test(detail)) {
    reason = detail;
  } else if (
    /^(?:'not' failed|must NOT be valid)$/.test(detail) &&
    typeof node.not === "object" &&
    node.not !== null
  ) {
    const description = (node.not as Record<string, unknown>).description;
    reason =
      typeof description === "string"
        ? description
        : "The value violates a 'not' schema constraint.";
  } else if (/pattern/.test(detail)) {
    reason = "The value does not satisfy its schema pattern.";
  }
  return `Model output does not match the requested schema${at}. ${reason}`;
}

function boundedValidationFeedback(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const encoded = Buffer.from(message, "utf8");
  return encoded.byteLength <= MAX_VALIDATION_FEEDBACK_BYTES
    ? message
    : `${encoded.subarray(0, MAX_VALIDATION_FEEDBACK_BYTES).toString("utf8")}…`;
}

function addModelUsage(
  total: ModelReviewUsage,
  next: ModelReviewUsage | undefined,
): ModelReviewUsage {
  if (next === undefined) return total;
  return {
    ...(total.inputTokens === undefined && next.inputTokens === undefined
      ? {}
      : { inputTokens: (total.inputTokens ?? 0) + (next.inputTokens ?? 0) }),
    ...(total.outputTokens === undefined && next.outputTokens === undefined
      ? {}
      : { outputTokens: (total.outputTokens ?? 0) + (next.outputTokens ?? 0) }),
  };
}

async function waitForRetry(
  delayMs: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted) {
    throw modelTimeoutError(timeoutMs);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(modelTimeoutError(timeoutMs));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function modelTimeoutError(timeoutMs: number): ModelReviewError {
  return new ModelReviewError(`Model review exceeded its ${timeoutMs}ms timeout.`, {
    code: "model_timeout",
    retryable: true,
  });
}

function normalizeRequest(request: ModelReviewRequest): NormalizedModelReviewRequest {
  if (typeof request !== "object" || request === null) {
    throw new ModelReviewError("Model review request must be an object.", {
      code: "invalid_model_request",
    });
  }
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
    throw new ModelReviewError("Model review prompt must be a non-empty string.", {
      code: "invalid_model_request",
    });
  }
  const promptBytes = Buffer.byteLength(request.prompt, "utf8");
  if (promptBytes > MAX_PROMPT_BYTES) {
    throw new ModelReviewError(`Model review prompt exceeds ${MAX_PROMPT_BYTES} bytes.`, {
      code: "model_request_too_large",
    });
  }
  requireJsonSize(request.input, "input", MAX_INPUT_BYTES);
  if (
    typeof request.schema !== "object" ||
    request.schema === null ||
    Array.isArray(request.schema)
  ) {
    throw new ModelReviewError("Model review schema must be a JSON Schema object.", {
      code: "invalid_model_schema",
    });
  }
  requireJsonSize(request.schema, "schema", MAX_SCHEMA_BYTES);

  const maximumOutputTokens = request.budget?.maximumOutputTokens ?? DEFAULT_MAXIMUM_OUTPUT_TOKENS;
  const timeoutMs = request.budget?.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  requireIntegerRange(
    maximumOutputTokens,
    "budget.maximumOutputTokens",
    1,
    MAX_MAXIMUM_OUTPUT_TOKENS,
  );
  requireIntegerRange(timeoutMs, "budget.timeoutMs", 1, MAX_MODEL_TIMEOUT_MS);
  return {
    prompt: request.prompt,
    input: request.input,
    schema: request.schema,
    budget: { maximumOutputTokens, timeoutMs },
  };
}

function requireJsonSize(value: unknown, name: string, maximum: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new ModelReviewError(
      `Model review ${name} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
      { code: "invalid_model_request" },
    );
  }
  if (encoded === undefined) {
    throw new ModelReviewError(`Model review ${name} must be JSON-serializable.`, {
      code: "invalid_model_request",
    });
  }
  if (Buffer.byteLength(encoded, "utf8") > maximum) {
    throw new ModelReviewError(`Model review ${name} exceeds ${maximum} bytes.`, {
      code: "model_request_too_large",
    });
  }
}

function requireIntegerRange(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ModelReviewError(`${name} must be an integer from ${minimum} through ${maximum}.`, {
      code: "invalid_model_budget",
    });
  }
}

function brokerTransportError(
  error: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): ModelReviewError {
  if (signal.aborted) return modelTimeoutError(timeoutMs);
  if (error instanceof ModelReviewError) return error;
  return new ModelReviewError(
    `Model broker request failed: ${error instanceof Error ? error.message : String(error)}`,
    { code: "broker_unavailable", retryable: true },
  );
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new ModelReviewError(`Model broker response exceeds ${MAX_RESPONSE_BYTES} bytes.`, {
      code: "model_response_too_large",
    });
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ModelReviewError(`Model broker response exceeds ${MAX_RESPONSE_BYTES} bytes.`, {
        code: "model_response_too_large",
      });
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function requireBrokerResponse(value: unknown): ModelBrokerResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelReviewError("Model broker response must be an object.", {
      code: "invalid_broker_response",
    });
  }
  const response = value as Partial<ModelBrokerResponse>;
  if (response.protocolVersion !== ADVERSARY_MODEL_PROTOCOL_VERSION) {
    throw new ModelReviewError(
      `Model broker protocol version must be ${ADVERSARY_MODEL_PROTOCOL_VERSION}.`,
      { code: "unsupported_model_protocol" },
    );
  }
  if (typeof response.provider !== "string" || response.provider.trim() === "") {
    throw new ModelReviewError("Model broker response provider must be a non-empty string.", {
      code: "invalid_broker_response",
    });
  }
  if (typeof response.model !== "string" || response.model.trim() === "") {
    throw new ModelReviewError("Model broker response model must be a non-empty string.", {
      code: "invalid_broker_response",
    });
  }
  if (!Object.hasOwn(response, "output")) {
    throw new ModelReviewError("Model broker response is missing output.", {
      code: "invalid_broker_response",
    });
  }
  if (response.usage !== undefined) {
    validateUsage(response.usage);
  }
  return response as ModelBrokerResponse;
}

function validateUsage(value: unknown): asserts value is ModelReviewUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelReviewError("Model broker response usage must be an object.", {
      code: "invalid_broker_response",
    });
  }
  for (const field of ["inputTokens", "outputTokens"] as const) {
    const count = (value as ModelReviewUsage)[field];
    if (count !== undefined && (!Number.isInteger(count) || count < 0)) {
      throw new ModelReviewError(
        `Model broker response usage.${field} must be a non-negative integer.`,
        {
          code: "invalid_broker_response",
        },
      );
    }
  }
}

function validateModelOutput(
  schema: Record<string, unknown>,
  output: unknown,
  usage?: ModelReviewUsage,
): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  let validate: ReturnType<Ajv2020["compile"]>;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new ModelReviewError(
      `Model review schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { code: "invalid_model_schema" },
    );
  }
  if (!validate(output)) {
    const detail = ajv.errorsText(validate.errors, { separator: "; " });
    throw new ModelReviewError(`Model output does not match the requested schema: ${detail}`, {
      code: "invalid_model_output",
      ...(usage === undefined ? {} : { usage }),
    });
  }
}
