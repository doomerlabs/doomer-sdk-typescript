import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  BrokerReviewModel,
  ModelReviewError,
  type ModelReviewResult,
  type ModelReviewUsage,
  enhanceReviewModel,
} from "../src/index.js";
import { reviewWithValidation } from "../src/model.js";

afterEach(() => vi.restoreAllMocks());

type BrokerPayload = {
  prompt: string;
  input: unknown;
  schema: { properties?: Record<string, unknown> };
  budget: { timeoutMs: number };
};

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: {
      type: "string",
      minLength: 20,
      maxLength: 800,
      not: {
        description: "Leading or trailing whitespace is forbidden; trim the value.",
        pattern: "^\\s|\\s$",
      },
    },
  },
};
const valid = { summary: "The prepared source proves no engineering concern." };
const fixtures = [
  {
    value: "PRIVATE-MODEL-TEXT".padEnd(801, "x"),
    detail: "maxLength: got 801, want 800",
    feedback: /maxLength.*801.*800/,
  },
  { value: "short", detail: "minLength: got 5, want 20", feedback: /minLength.*5.*20/ },
  { value: "summary", detail: "minLength: got 7, want 20", feedback: /minLength.*7.*20/ },
  {
    value: " PRIVATE-MODEL-TEXT with sufficient length ",
    detail: "'not' failed",
    feedback: /Leading or trailing whitespace is forbidden/,
  },
];

it.each(fixtures)(
  "repairs broker schema rejection with retained evidence: $detail",
  async (fixture) => {
    await exercise("broker", fixture);
  },
);
it.each(fixtures)(
  "repairs client schema rejection with retained evidence: $detail",
  async (fixture) => {
    await exercise("client", fixture);
  },
);

async function exercise(mode: "broker" | "client", fixture: (typeof fixtures)[number]) {
  const root = await mkdtemp(join(tmpdir(), "sdk-schema-repair-"));
  const path = join(root, "source.ts");
  await writeFile(path, "export const evidence = 'ORIGINAL-SOURCE';\n");
  let planning = 0;
  const generations: BrokerPayload[] = [];
  const validations: ModelReviewResult[] = [];
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as BrokerPayload;
    expect(request).not.toHaveProperty("validation");
    if (request.schema.properties?.ready) {
      planning++;
      return reply(
        planning === 1
          ? {
              ready: false,
              operations: [
                { tool: "read_file", path: "source.ts", cursor: 0, startLine: 1, endLine: 1 },
              ],
            }
          : { ready: true, operations: [] },
      );
    }
    generations.push(request);
    if (generations.length === 1) {
      now += 100;
      await writeFile(path, "export const evidence = 'REPLACED-SOURCE';\n");
      return mode === "broker" ? failure(fixture.detail) : reply({ summary: fixture.value });
    }
    expect(request.input).toEqual(generations[0].input);
    expect(request.prompt).toContain("SDK VALIDATION FEEDBACK");
    expect(request.prompt).toContain("/summary");
    if (mode === "broker" || fixture.detail === "'not' failed")
      expect(request.prompt).toMatch(fixture.feedback);
    expect(request.prompt).not.toContain("PRIVATE-MODEL-TEXT");
    expect(request.budget.timeoutMs).toBe(generations[0].budget.timeoutMs - 100);
    return reply(valid);
  });
  try {
    const model = enhanceReviewModel(
      new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token", { maximumAttempts: 1 }),
      root,
    );
    const result = await model.review({
      prompt: "Review the source.",
      input: {},
      schema,
      budget: { timeoutMs: 5000 },
      tools: { repository: { include: ["*.ts"], maxRounds: 3, maxToolCalls: 3 } },
      validation: {
        maximumAttempts: 2,
        validate: (value) => {
          validations.push(value);
        },
      },
    });
    expect(generations).toHaveLength(2);
    expect(planning).toBe(2);
    expect(validations).toHaveLength(1);
    expect(result.output).toEqual(valid);
    expect(result.citations?.[0].content).toContain("ORIGINAL-SOURCE");
    expect(result.citations?.[0].content).not.toContain("REPLACED-SOURCE");
    expect(validations[0].citations).toEqual(result.citations);
    expect(validations[0].retrieval).toEqual(result.retrieval);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("makes persistent schema rejection terminal after the configured generation attempts", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => failure("maxLength: got 801, want 800"));
  const validate = vi.fn();
  const model = enhanceReviewModel(
    new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token", { maximumAttempts: 1 }),
    process.cwd(),
  );
  await expect(
    model.review({
      prompt: "Review",
      input: {},
      schema,
      validation: { maximumAttempts: 2, validate },
    }),
  ).rejects.toMatchObject({
    code: "model_validation_failed",
    retryable: false,
    message: expect.stringMatching(/2 attempts.*maxLength.*801.*800/),
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(validate).not.toHaveBeenCalled();
});

it("redacts quoted model text and unknown instance keys from schema repair feedback", async () => {
  const payloads: BrokerPayload[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as BrokerPayload;
    payloads.push(payload);
    return payloads.length === 1
      ? new Response(
          JSON.stringify({
            error: {
              code: "invalid_model_output",
              retryable: false,
              message:
                "model output does not match requested schema:\n- at '/PRIVATE-INSTANCE-KEY': 'PRIVATE-REJECTED-TEXT must NOT have more than 999 characters; maxLength: got 999, want 1000' does not match pattern 'PRIVATE-PATTERN'",
            },
          }),
          { status: 502 },
        )
      : reply(valid);
  });
  const model = enhanceReviewModel(
    new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token"),
    process.cwd(),
  );
  await expect(
    model.review({
      prompt: "Review",
      input: {},
      schema,
      validation: { maximumAttempts: 2, validate: () => {} },
    }),
  ).resolves.toMatchObject({ output: valid });
  expect(payloads[1].prompt).toContain("at /*");
  expect(payloads[1].prompt).toContain("schema pattern");
  expect(payloads[1].prompt).not.toMatch(/PRIVATE-/);
});

it.each([
  "invalid_model_schema",
  "invalid_model_request",
  "invalid_broker_response",
  "model_canceled",
])("does not treat %s as a schema output repair", async (code) => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code, message: "Fixture failure", retryable: false } }),
        { status: 400 },
      ),
    );
  const model = enhanceReviewModel(
    new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token"),
    process.cwd(),
  );
  await expect(
    model.review({
      prompt: "Review",
      input: {},
      schema,
      validation: { maximumAttempts: 2, validate: () => {} },
    }),
  ).rejects.toMatchObject({ code });
  expect(fetch).toHaveBeenCalledTimes(1);
});

function reply(output: unknown, usage?: ModelReviewUsage) {
  return new Response(
    JSON.stringify({ protocolVersion: 1, provider: "fixture", model: "fixture", output, usage }),
  );
}
function failure(detail: string, usage?: ModelReviewUsage, retryable = false) {
  return new Response(
    JSON.stringify({
      usage,
      error: {
        code: "invalid_model_output",
        retryable,
        message: `model output does not match requested schema:\n- at '/summary': ${detail}`,
      },
    }),
    { status: 502 },
  );
}

it.each(["broker", "client", "semantic"] as const)(
  "aggregates rejected completion usage exactly once before %s repair",
  async (mode) => {
    let calls = 0;
    const validate = vi.fn(({ output }: ModelReviewResult) => {
      if ((output as { summary: string }).summary === "A substantive but incorrect assessment.")
        throw new Error("The assessment is incorrect; use the retained evidence.");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      if (calls > 1) return reply(valid, { inputTokens: 10, outputTokens: 5 });
      const usage = { inputTokens: 100, outputTokens: 50 };
      if (mode === "broker") return failure("maxLength: got 801, want 800", usage);
      return reply(
        { summary: mode === "client" ? "short" : "A substantive but incorrect assessment." },
        usage,
      );
    });
    const model = enhanceReviewModel(
      new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token", { maximumAttempts: 1 }),
      process.cwd(),
    );
    const result = await model.review({
      prompt: "Review",
      input: {},
      schema,
      validation: { maximumAttempts: 2, validate },
    });
    expect(result.usage).toEqual({ inputTokens: 110, outputTokens: 55 });
    expect(calls).toBe(2);
    expect(validate).toHaveBeenCalledTimes(mode === "semantic" ? 2 : 1);
  },
);

it.each(["broker", "client"] as const)(
  "preserves usage on exhausted %s schema repairs",
  async (mode) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const usage = { inputTokens: 100, outputTokens: 50 };
      return mode === "broker"
        ? failure("minLength: got 5, want 20", usage)
        : reply({ summary: "short" }, usage);
    });
    const model = enhanceReviewModel(
      new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token", { maximumAttempts: 1 }),
      process.cwd(),
    );
    await expect(
      model.review({
        prompt: "Review",
        input: {},
        schema,
        validation: { maximumAttempts: 2, validate: () => {} },
      }),
    ).rejects.toMatchObject({
      code: "model_validation_failed",
      usage: { inputTokens: 200, outputTokens: 100 },
    });
  },
);

it("validates usage on broker error envelopes before accounting or repair", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(failure("minLength: got 5, want 20", { inputTokens: -1 }));
  const model = enhanceReviewModel(
    new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token", { maximumAttempts: 1 }),
    process.cwd(),
  );
  await expect(
    model.review({
      prompt: "Review",
      input: {},
      schema,
      validation: { maximumAttempts: 2, validate: () => {} },
    }),
  ).rejects.toMatchObject({ code: "invalid_broker_response" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["broker", "client", "semantic"] as const)(
  "preserves completed usage when %s repair is canceled",
  async (mode) => {
    let calls = 0;
    const validate = vi.fn(() => {
      throw new Error("Use the retained evidence.");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      if (calls > 1)
        return new Response(
          JSON.stringify({
            error: {
              code: "model_canceled",
              message: "Fixture review was canceled.",
              retryable: false,
            },
          }),
          { status: 503 },
        );
      const usage = { inputTokens: 100, outputTokens: 50 };
      return mode === "broker"
        ? failure("minLength: got 5, want 20", usage)
        : reply(mode === "client" ? { summary: "short" } : valid, usage);
    });
    const model = enhanceReviewModel(
      new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token", { maximumAttempts: 1 }),
      process.cwd(),
    );
    await expect(
      model.review({
        prompt: "Review",
        input: {},
        schema,
        validation: { maximumAttempts: 3, validate },
      }),
    ).rejects.toMatchObject({
      code: "model_canceled",
      retryable: false,
      message: "Fixture review was canceled.",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(calls).toBe(2);
    expect(validate).toHaveBeenCalledTimes(mode === "semantic" ? 1 : 0);
  },
);

it.each(["broker", "client", "semantic"] as const)(
  "preserves completed usage when the %s repair deadline expires",
  async (mode) => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      now += 100;
      const usage = { inputTokens: 100, outputTokens: 50 };
      return mode === "broker"
        ? failure("minLength: got 5, want 20", usage)
        : reply(mode === "client" ? { summary: "short" } : valid, usage);
    });
    const model = enhanceReviewModel(
      new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token", { maximumAttempts: 1 }),
      process.cwd(),
    );
    await expect(
      model.review({
        prompt: "Review",
        input: {},
        schema,
        budget: { timeoutMs: 100 },
        validation: {
          maximumAttempts: 3,
          validate: () => {
            throw new Error("Use the retained evidence.");
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "model_request_recovery_exhausted",
      retryable: false,
      diagnostics: { attempts: 1, reason: "deadline" },
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  "preserves model-error metadata and current usage (retryable=%s)",
  async (retryable) => {
    const interruption = new ModelReviewError("Fixture interruption", {
      code: "model_canceled",
      retryable,
      diagnostics: { reason: "fixture interruption" },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    let calls = 0;
    await expect(
      reviewWithValidation(
        {
          review: async () => {
            if (++calls > 1) throw interruption;
            throw new ModelReviewError(
              "Model output does not match the requested schema: data/summary must NOT have fewer than 20 characters",
              {
                code: "invalid_model_output",
                usage: { inputTokens: 100, outputTokens: 50 },
              },
            );
          },
        },
        {
          prompt: "Review",
          input: {},
          schema,
          validation: { maximumAttempts: 3, validate: () => {} },
        },
      ),
    ).rejects.toMatchObject({
      code: interruption.code,
      retryable,
      message: interruption.message,
      diagnostics: interruption.diagnostics,
      usage: { inputTokens: 110, outputTokens: 55 },
    });
    expect(calls).toBe(2);
    expect(interruption.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  },
);

it("schema repairs cannot extend the shared generation deadline", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    now += 100;
    return failure("maxLength: got 801, want 800");
  });
  const model = enhanceReviewModel(
    new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token", { maximumAttempts: 1 }),
    process.cwd(),
  );
  await expect(
    model.review({
      prompt: "Review",
      input: {},
      schema,
      budget: { timeoutMs: 100 },
      validation: { maximumAttempts: 3, validate: () => {} },
    }),
  ).rejects.toMatchObject({
    code: "model_request_recovery_exhausted",
    retryable: false,
    diagnostics: { attempts: 1, reason: "deadline" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("routes retryable broker schema rejection through bounded repair with feedback and usage", async () => {
  const payloads: BrokerPayload[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)) as BrokerPayload);
    return payloads.length > 1
      ? reply(valid, { inputTokens: 10, outputTokens: 5 })
      : failure("maxLength: got 801, want 800", { inputTokens: 100, outputTokens: 50 }, true);
  });
  const model = enhanceReviewModel(
    new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token", {
      maximumAttempts: 5,
      initialRetryDelayMs: 0,
    }),
    process.cwd(),
  );
  const result = await model.review({
    prompt: "Review",
    input: { evidence: "retained" },
    schema,
    validation: { maximumAttempts: 2, validate: () => {} },
  });
  expect(payloads).toHaveLength(2);
  expect(payloads[1].prompt).toContain("SDK VALIDATION FEEDBACK");
  expect(payloads[1].prompt).toMatch(/maxLength.*801.*800/);
  expect(payloads[1].input).toEqual(payloads[0].input);
  expect(result.usage).toEqual({ inputTokens: 110, outputTokens: 55 });
});

it("does not multiply the validation budget for retryable schema envelopes", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      failure("minLength: got 5, want 20", { inputTokens: 100, outputTokens: 50 }, true),
    );
  const model = enhanceReviewModel(
    new BrokerReviewModel("http://127.0.0.1:43123", "fixture-token", {
      maximumAttempts: 5,
      initialRetryDelayMs: 0,
    }),
    process.cwd(),
  );
  await expect(
    model.review({
      prompt: "Review",
      input: {},
      schema,
      validation: { maximumAttempts: 2, validate: () => {} },
    }),
  ).rejects.toMatchObject({
    code: "model_validation_failed",
    retryable: false,
    usage: { inputTokens: 200, outputTokens: 100 },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
