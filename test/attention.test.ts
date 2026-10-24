import { afterEach, expect, it, vi } from "vitest";
import {
  BrokerReviewModel,
  createModelFromEnvironment,
  enhanceReviewModel,
  formatOpinionAsync,
  rewriteOpinionConcern,
} from "../src/index.js";
import type { ChoiceRequest, ReviewModel } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());
const request: ChoiceRequest = {
  state: { candidate: "claim" },
  questions: {
    q: {
      type: "choice",
      instructions: "Select",
      criteria: { yes: "supported", no: "unsupported" },
    },
  },
};

it("keeps System 1 absent from ordinary review models", () => {
  expect(
    createModelFromEnvironment({
      ADVERSARY_MODEL_ENDPOINT: "http://127.0.0.1:12345/v1/review",
      ADVERSARY_MODEL_TOKEN: "secret",
    }).classify,
  ).toBeUndefined();
  expect(
    createModelFromEnvironment({
      ADVERSARY_MODEL_ENDPOINT: "http://127.0.0.1:12345/v1/review",
      ADVERSARY_MODEL_TOKEN: "secret",
      ADVERSARY_ATTENTION_SYSTEM1: "1",
    }).classify,
  ).toBeTypeOf("function");
});
it("sends typed choices to the authenticated loopback route", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        answers: {
          q: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } },
        },
      }),
    ),
  );
  const model = new BrokerReviewModel("http://127.0.0.1:12345/v1/review", "secret", {
    attentionSystem1: true,
  });
  if (!model.classify) throw new Error("classifier unavailable");
  expect((await model.classify(request)).q.choice).toBe("yes");
  expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:12345/v1/choices");
  expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer secret" });
});
it("rejects unrecognized and incomplete choices", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        answers: {
          q: { type: "choice", choice: "invented", confidence: 1, probabilities: { yes: 1 } },
        },
      }),
    ),
  );
  const model = new BrokerReviewModel("http://127.0.0.1:12345/v1/review", "secret", {
    attentionSystem1: true,
  });
  if (!model.classify) throw new Error("classifier unavailable");
  await expect(model.classify(request)).rejects.toMatchObject({ code: "invalid_choice_response" });
});
it("preserves explicit concern rewriting through attention context wrappers", async () => {
  const review = vi.fn().mockResolvedValue({
    output: { concern: "inherited context replacement" },
    provider: "fixture",
    model: "rewrite",
  });
  const model: ReviewModel = { review, classify: async () => ({}) };
  const context = enhanceReviewModel(model);
  expect(context.classify).toBeTypeOf("function");
  const result = await rewriteOpinionConcern(context, {
    text: "commands replace inherited context with another context",
  });
  expect(result).toMatchObject({
    concern: "inherited context replacement",
    rewritten: true,
    provider: "fixture",
    model: "rewrite",
  });
  expect(review).toHaveBeenCalledTimes(1);
  const opinion = await formatOpinionAsync({
    ship: false,
    concern: "commands replace inherited context with another context",
    model: context,
  });
  expect(JSON.stringify(opinion)).toContain("inherited context replacement");
  expect(JSON.stringify(opinion)).not.toContain("the reported concern");
});

it("selects prepared reads with System 1 and retains a single final generation", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { reviewWithRepositoryTools } = await import("../src/repository-model.js");
  const root = await mkdtemp(join(tmpdir(), "attention-sdk-"));
  try {
    await writeFile(join(root, "app.ts"), "export const value = 1;\n");
    let generations = 0;
    const model: ReviewModel = {
      async classify(request) {
        const state = request.state as {
          candidates: Array<{ path: string }>;
          evidence: Array<{ tool: string }>;
        };
        const read = state.evidence.some((e) => e.tool === "read_file");
        return Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => {
            const choice = id === "ready" ? (read ? "ready" : "continue") : "yes";
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
      },
      async review<T>(request) {
        expect(request.prompt.startsWith("REPOSITORY RETRIEVAL")).toBe(false);
        generations++;
        return { output: { findings: [] } as T, provider: "fixture", model: "discovery" };
      },
    };
    const result = await reviewWithRepositoryTools(model, root, {
      prompt: "Review the value",
      input: {},
      schema: { type: "object" },
      tools: { repository: {} },
    });
    expect(generations).toBe(1);
    expect(result.citations).toHaveLength(1);
    expect(result.citations?.[0]?.path).toBe("app.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
