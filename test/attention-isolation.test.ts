import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BrokerReviewModel, createModelFromEnvironment, enhanceReviewModel } from "../src/index.js";
import type { ModelReviewRequest, ReviewModel } from "../src/index.js";
import { reviewWithRepositoryTools } from "../src/repository-model.js";

afterEach(() => vi.restoreAllMocks());

it.each([undefined, "", "0", "false"])(
  "keeps classification absent when the host opt-in is %s",
  (flag) => {
    const model = createModelFromEnvironment({
      ADVERSARY_MODEL_ENDPOINT: "http://127.0.0.1:43123/v1/review",
      ADVERSARY_MODEL_TOKEN: "fixture",
      ADVERSARY_ATTENTION_SYSTEM1: flag,
    });
    expect(model.classify).toBeUndefined();
    expect(Object.hasOwn(model, "classify")).toBe(false);
    expect(enhanceReviewModel(model).classify).toBeUndefined();
  },
);

it("keeps ordinary broker requests on the original generative protocol", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        protocolVersion: 1,
        provider: "fixture",
        model: "fixture",
        output: { findings: [] },
      }),
    ),
  );
  const model = new BrokerReviewModel("http://127.0.0.1:43123/v1/review", "fixture");
  await model.review({
    prompt: "Check the change",
    input: { value: 1 },
    schema: { type: "object" },
  });
  expect(model.classify).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:43123/v1/review");
  const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({
    protocolVersion: 1,
    prompt: "Check the change",
    input: { value: 1 },
    schema: { type: "object" },
  });
  expect(body).not.toHaveProperty("questions");
  expect(body).not.toHaveProperty("attentionTask");
});

it("retains generative planning and final review without attention capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-sdk-isolation-"));
  const calls: ModelReviewRequest[] = [];
  const model: ReviewModel = {
    async review<T>(request: ModelReviewRequest<T>) {
      calls.push(request);
      const output =
        request.diagnosticStage === "repository_planning"
          ? { ready: true, operations: [] }
          : { findings: [] };
      return { output: output as T, provider: "fixture", model: "legacy" };
    },
  };
  try {
    await reviewWithRepositoryTools(model, root, {
      prompt: "Review the repository",
      input: {},
      schema: { type: "object" },
      attentionTask: "configuration-go-vet",
      tools: { repository: {} },
    });
    expect(calls.filter((c) => c.diagnosticStage === "repository_planning")).toHaveLength(1);
    expect(calls.filter((c) => c.diagnosticStage === "model_review")).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("REPOSITORY RETRIEVAL CONTROLLER");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
