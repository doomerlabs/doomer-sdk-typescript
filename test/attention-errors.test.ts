import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BrokerReviewModel, ModelReviewError } from "../src/index.js";
import type {
  ChoiceAnswers,
  ChoiceRequest,
  ModelReviewRequest,
  ReviewModel,
} from "../src/index.js";
import { reviewWithRepositoryTools } from "../src/repository-model.js";

afterEach(() => vi.restoreAllMocks());
const request: ChoiceRequest = {
  state: {},
  questions: {
    q: {
      type: "choice",
      instructions: "Select",
      criteria: { yes: "Supported", no: "Unsupported" },
    },
  },
};
function classify(input = request) {
  const model = new BrokerReviewModel("http://127.0.0.1:43123/v1/review", "fixture", {
    attentionSystem1: true,
  });
  if (!model.classify) throw new Error("Missing attention capability");
  return model.classify(input);
}

it("normalizes classifier connection failures", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection reset"));
  await expect(classify()).rejects.toMatchObject({
    name: "ModelReviewError",
    code: "broker_unavailable",
    retryable: true,
  });
});
it("normalizes classifier response stream failures", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("connection reset"));
        },
      }),
    ),
  );
  await expect(classify()).rejects.toMatchObject({ code: "broker_unavailable", retryable: true });
});
it("normalizes classifier timeout failures", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  await expect(classify({ ...request, timeoutMs: 5 })).rejects.toMatchObject({
    code: "model_timeout",
    retryable: true,
  });
});
it.each([
  [500, "", "attention_classification_failed", true],
  [502, "<html>gateway unavailable</html>", "attention_classification_failed", true],
  [404, "not found", "attention_classification_failed", false],
  [429, JSON.stringify({ error: { code: "rate_limited", retryable: true } }), "rate_limited", true],
  [
    503,
    JSON.stringify({ error: { code: "classifier_policy_blocked", retryable: false } }),
    "classifier_policy_blocked",
    false,
  ],
])("retains HTTP %s classifier failure semantics", async (status, body, code, retryable) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }));
  await expect(classify()).rejects.toMatchObject({ code, retryable });
});
it.each(["invalid JSON", "null", "[]", "{}"])(
  "rejects malformed successful classifier payloads: %s",
  async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    await expect(classify()).rejects.toMatchObject({ code: "invalid_choice_response" });
  },
);
it.each([
  { confidence: -0.01 },
  { confidence: 1.01 },
  { confidence: null },
  { probabilities: { yes: 0.5, no: 0.1 } },
  { probabilities: { yes: 1.1, no: -0.1 } },
  { probabilities: { yes: 1 } },
  { probabilities: { yes: 1, no: 0, extra: 0 } },
])("rejects invalid confidence or distribution: %j", async (invalid) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        answers: {
          q: {
            type: "choice",
            choice: "yes",
            confidence: 1,
            probabilities: { yes: 1, no: 0 },
            ...invalid,
          },
        },
      }),
    ),
  );
  await expect(classify()).rejects.toMatchObject({ code: "invalid_choice_response" });
});
it.each([0, 1])("accepts bounded probability endpoints and confidence %s", async (confidence) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        answers: {
          q: { type: "choice", choice: "yes", confidence, probabilities: { yes: 1, no: 0 } },
        },
      }),
    ),
  );
  expect((await classify()).q.confidence).toBe(confidence);
});

function answersFor(request: ChoiceRequest): ChoiceAnswers {
  const state = request.state as { evidence?: Array<{ tool: string }> };
  const hasSource = state.evidence?.some((result) => result.tool === "read_file");
  return Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => {
      const choice =
        id === "plan" ? "plan_0" : id === "ready" ? (hasSource ? "ready" : "continue") : "yes";
      return [
        id,
        {
          type: "choice" as const,
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0]),
          ),
        },
      ];
    }),
  );
}

it("falls back to generation when a selected configuration violates the requested schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "attention-schema-"));
  const review = vi.fn(async <T>(_request: ModelReviewRequest<T>) => ({
    output: { tags: ["production"] } as T,
    provider: "fixture",
    model: "fallback",
  }));
  try {
    await writeFile(join(root, "Makefile"), "check:\n\tgosec ./...\n");
    const result = await reviewWithRepositoryTools(
      { classify: async (request) => answersFor(request), review },
      root,
      {
        prompt: "Select the gosec configuration",
        input: {},
        attentionTask: "configuration-gosec",
        schema: {
          type: "object",
          required: ["tags"],
          properties: { tags: { type: "array", items: { type: "string" }, minItems: 1 } },
        },
        tools: { repository: {} },
      },
    );
    expect(result.output).toEqual({ tags: ["production"] });
    expect(result.provider).toBe("fixture");
    expect(review).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["broker_unavailable", "model_timeout", "attention_classification_failed", "rate_limited"])(
  "disables %s for one retrieval, then probes again on the next retrieval",
  async (code) => {
    const root = await mkdtemp(join(tmpdir(), "attention-availability-"));
    const classifier = vi
      .fn()
      .mockRejectedValue(new ModelReviewError("Unavailable", { code, retryable: true }));
    let rounds = 0;
    const model: ReviewModel = {
      classify: classifier,
      async review<T>(request: ModelReviewRequest<T>) {
        const planning = request.diagnosticStage === "repository_planning";
        if (planning) rounds++;
        const output = !planning
          ? { findings: [] }
          : rounds % 3 === 0
            ? { ready: true, operations: [] }
            : {
                ready: false,
                operations: [
                  {
                    tool: "read_file",
                    path: rounds % 3 === 1 ? "a.ts" : "b.ts",
                    cursor: 0,
                    startLine: 1,
                    endLine: 10,
                  },
                ],
              };
        return { output: output as T, provider: "fixture", model: "fallback" };
      },
    };
    try {
      await writeFile(join(root, "a.ts"), "export const a = 1;\n");
      await writeFile(join(root, "b.ts"), "export const b = 2;\n");
      for (let run = 0; run < 2; run++) {
        await reviewWithRepositoryTools(model, root, {
          prompt: "Review",
          input: {},
          schema: { type: "object" },
          attentionTask: "configuration-gosec",
          tools: { repository: {} },
        });
        expect(classifier).toHaveBeenCalledTimes(run + 1);
        expect(rounds).toBe((run + 1) * 3);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("uses generation to repair a selected configuration rejected by semantic validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "attention-semantic-"));
  const review = vi.fn(async <T>(request: ModelReviewRequest<T>) => {
    expect(request.prompt).toContain("SDK VALIDATION FEEDBACK");
    return { output: { tags: ["production"] } as T, provider: "fixture", model: "repair" };
  });
  try {
    await writeFile(join(root, "Makefile"), "check:\n\tgosec ./...\n");
    const result = await reviewWithRepositoryTools<{ tags: string[] }>(
      { classify: async (request) => answersFor(request), review },
      root,
      {
        prompt: "Select gosec configuration",
        input: {},
        attentionTask: "configuration-gosec",
        schema: {
          type: "object",
          required: ["tags"],
          properties: { tags: { type: "array", items: { type: "string" } } },
        },
        validation: {
          validate(result) {
            if (!(result.output as { tags: string[] }).tags.includes("production"))
              throw new Error("The production tag is required");
          },
        },
        tools: { repository: {} },
      },
    );
    expect(result.output).toEqual({ tags: ["production"] });
    expect(review).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("never bypasses a host classifier policy rejection with generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "attention-policy-"));
  const review = vi.fn();
  try {
    await expect(
      reviewWithRepositoryTools(
        {
          review,
          classify: async () => {
            throw new ModelReviewError("Blocked", { code: "classifier_policy_blocked" });
          },
        },
        root,
        {
          prompt: "Review",
          input: {},
          schema: { type: "object" },
          tools: { repository: {} },
        },
      ),
    ).rejects.toMatchObject({ code: "classifier_policy_blocked" });
    expect(review).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["invalid_choice_response", "model_response_too_large"])(
  "retains classification after a %s protocol error",
  async (code) => {
    const root = await mkdtemp(join(tmpdir(), "attention-protocol-recovery-"));
    const classifier = vi
      .fn()
      .mockRejectedValueOnce(new ModelReviewError("Malformed response", { code }))
      .mockImplementation(async (request) => answersFor(request));
    const review = vi.fn(async <T>(request: ModelReviewRequest<T>) => ({
      output: (request.diagnosticStage === "repository_planning"
        ? {
            ready: false,
            operations: [
              { tool: "read_file", path: "app.ts", cursor: 0, startLine: 1, endLine: 10 },
            ],
          }
        : { findings: [] }) as T,
      provider: "fixture",
      model: "fallback",
    }));
    try {
      await writeFile(join(root, "app.ts"), "export const value = 1;\n");
      const result = await reviewWithRepositoryTools({ classify: classifier, review }, root, {
        prompt: "Review",
        input: {},
        schema: { type: "object" },
        tools: { repository: {} },
      });
      expect(result.output).toEqual({ findings: [] });
      expect(classifier).toHaveBeenCalledTimes(2);
      expect(review).toHaveBeenCalledTimes(2);
      expect(
        review.mock.calls.filter(([request]) => request.diagnosticStage === "repository_planning"),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
