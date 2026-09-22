import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  ModelRepositoryCitation,
  ModelRepositoryRetrieval,
  ModelRepositoryToolOptions,
} from "./repository-model.js";

export const ADVERSARY_MODEL_PROTOCOL_VERSION = 1;
export const ADVERSARY_MODEL_ENDPOINT_ENV = "ADVERSARY_MODEL_ENDPOINT";
export const ADVERSARY_MODEL_TOKEN_ENV = "ADVERSARY_MODEL_TOKEN";

const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
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

interface ModelBrokerRequest extends Omit<ModelReviewRequest, "validation" | "tools"> {
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
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
}

type NormalizedModelReviewRequest = Omit<ModelReviewRequest, "budget" | "validation" | "tools"> & {
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

  constructor(message: string, options: { code?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = "ModelReviewError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), normalized.budget.timeoutMs);
    try {
      for (let attempt = 1; attempt <= this.#maximumAttempts; attempt += 1) {
        try {
          return await this.#reviewOnce<T>(normalized, controller.signal);
        } catch (error) {
          if (
            !(error instanceof ModelReviewError) ||
            !error.retryable ||
            controller.signal.aborted ||
            attempt === this.#maximumAttempts
          ) {
            throw error;
          }
          const exponential = Math.min(
            MAX_BROKER_RETRY_DELAY_MS,
            this.#initialRetryDelayMs * 2 ** (attempt - 1),
          );
          const jittered = Math.round(exponential * (0.75 + 0.5 * this.#random()));
          await waitForRetry(jittered, controller.signal, normalized.budget.timeoutMs);
        }
      }
      throw new ModelReviewError("Model broker retry loop exhausted unexpectedly.", {
        code: "broker_unavailable",
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #reviewOnce<T>(
    normalized: NormalizedModelReviewRequest,
    signal: AbortSignal,
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
      });
    } catch (error) {
      if (signal.aborted) {
        throw modelTimeoutError(normalized.budget.timeoutMs);
      }
      throw new ModelReviewError(
        `Model broker request failed: ${error instanceof Error ? error.message : String(error)}`,
        { code: "broker_unavailable", retryable: true },
      );
    }

    let body: string;
    try {
      body = await readBoundedResponse(response);
    } catch (error) {
      if (signal.aborted) {
        throw modelTimeoutError(normalized.budget.timeoutMs);
      }
      throw error;
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
      throw new ModelReviewError(
        failure.error?.message ?? `Model broker returned HTTP ${response.status}.`,
        {
          code: failure.error?.code ?? "model_review_failed",
          retryable: failure.error?.retryable ?? response.status >= 500,
        },
      );
    }

    const envelope = requireBrokerResponse(decoded);
    validateModelOutput(normalized.schema, envelope.output);
    return {
      output: envelope.output as T,
      provider: envelope.provider,
      model: envelope.model,
      ...(envelope.usage === undefined ? {} : { usage: envelope.usage }),
    };
  }
}

/**
 * Run adversary-owned semantic validation with SDK-owned bounded regeneration.
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
    if (remainingTimeoutMs <= 0) throw modelTimeoutError(timeoutMs);
    const result = decorate(
      await model.review<T>({
        ...baseRequest,
        prompt:
          feedback === undefined
            ? baseRequest.prompt
            : `${baseRequest.prompt}\n\nSDK VALIDATION FEEDBACK:\nThe previous response failed adversary-defined validation. Correct the response using this trusted validation result and return the complete response again.\n${JSON.stringify({ attempt, error: feedback })}`,
        budget: {
          ...baseRequest.budget,
          timeoutMs: remainingTimeoutMs,
        },
      }),
    );
    usage = addModelUsage(usage, result.usage);
    try {
      await validation.validate(result);
      return {
        ...result,
        ...(usage.inputTokens === undefined && usage.outputTokens === undefined ? {} : { usage }),
      };
    } catch (error) {
      feedback = boundedValidationFeedback(error);
      if (attempt === maximumAttempts) {
        throw new ModelReviewError(
          `Model output failed adversary validation after ${maximumAttempts} attempts: ${feedback}`,
          { code: "model_validation_failed", retryable: false },
        );
      }
    }
  }
  throw new ModelReviewError("Model validation retry loop exhausted unexpectedly.", {
    code: "model_validation_failed",
    retryable: false,
  });
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

function validateModelOutput(schema: Record<string, unknown>, output: unknown): void {
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
    });
  }
}
