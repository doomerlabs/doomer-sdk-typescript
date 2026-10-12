import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADVERSARY_MODEL_PROTOCOL_VERSION,
  Adversary,
  BrokerReviewModel,
  ModelReviewError,
  type ModelReviewRequest,
  ModelUnavailableError,
  type ReviewModel,
  enhanceReviewModel,
  unavailableModel,
} from "../src/index.js";
import { reviewWithValidation } from "../src/model.js";

const servers: ReturnType<typeof createServer>[] = [];

it.each(["success", "retry", "timeout", "planning"])(
  "records content-free per-attempt timing for %s",
  async (outcome) => {
    const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.stubEnv("HOSTED_REVIEW_JOB_ID", "fixture-job");
    vi.stubEnv("ADVERSARY_MODEL_PROVIDER", "configured-provider");
    vi.stubEnv("ADVERSARY_MODEL", "configured-model");
    let calls = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      calls++;
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("diagnosticStage");
      if (outcome === "timeout") {
        await new Promise<void>((resolve) =>
          init?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new Error("private transport error");
      }
      if (outcome === "retry" && calls === 1) throw new Error("private transport error");
      return new Response(
        JSON.stringify({
          protocolVersion: ADVERSARY_MODEL_PROTOCOL_VERSION,
          provider: "actual-provider",
          model: "actual-model",
          output: {},
        }),
      );
    });
    try {
      const deadlineMs = outcome === "timeout" ? 10 : 5000;
      const model = new BrokerReviewModel("http://127.0.0.1:43123", "private-token", {
        initialRetryDelayMs: 0,
      });
      const result = model.review({
        diagnosticStage: outcome === "planning" ? "repository_planning" : "model_review",
        prompt: "private-prompt",
        input: { source: "private-source" },
        schema: { type: "object" },
        budget: { timeoutMs: deadlineMs },
      });
      if (outcome === "timeout")
        await expect(result).rejects.toMatchObject({
          code: "model_request_recovery_exhausted",
          retryable: false,
        });
      else await expect(result).resolves.toMatchObject({ output: {} });
      const records = log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(records).toHaveLength(outcome === "retry" ? 4 : 2);
      const terminals = records.filter((record) => record.outcome !== "started");
      expect(terminals.map((record) => record.attempt)).toEqual(outcome === "retry" ? [1, 2] : [1]);
      expect(new Set(records.map((record) => record.requestId)).size).toBe(1);
      for (const record of records) {
        expect(record).toMatchObject({
          event: "model.attempt",
          jobId: "fixture-job",
          stage: outcome === "planning" ? "repository_planning" : "model_review",
          deadlineMs,
        });
        expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(record.remainingDeadlineMs).toBeLessThanOrEqual(deadlineMs);
      }
      expect(terminals.at(-1)).toMatchObject(
        outcome === "timeout"
          ? {
              outcome: "failed",
              failureCode: "model_timeout",
              provider: "configured-provider",
              model: "configured-model",
            }
          : { outcome: "succeeded", provider: "actual-provider", model: "actual-model" },
      );
      expect(JSON.stringify(records)).not.toMatch(/private-|43123|"source"|"prompt"|"token"/i);
      expect(calls).toBe(outcome === "retry" ? 2 : 1);
    } finally {
      fetch.mockRestore();
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  },
);

it.each([false, true])(
  "records a retry-delay timeout without another attempt (broken sink=%s)",
  async (brokenSink) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const logs: string[] = [];
    const log = vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      logs.push(String(value));
      if (brokenSink) throw new Error("sink failed");
      return true;
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("private error"));
    try {
      const model = new BrokerReviewModel("http://127.0.0.1:43123", "private-token", {
        initialRetryDelayMs: 250,
        random: () => 0.5,
      });
      const result = model.review({
        prompt: "private-prompt",
        input: { source: "private-source" },
        schema: { type: "object" },
        budget: { timeoutMs: 100 },
      });
      const rejected = expect(result).rejects.toMatchObject({
        code: "model_request_recovery_exhausted",
        retryable: false,
        diagnostics: { attempts: 1, reason: "deadline" },
      });
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(fetch).toHaveBeenCalledOnce();
      const events = logs.map((value) => JSON.parse(value));
      expect(events).toHaveLength(3);
      expect(events.filter((event) => event.event === "model.attempt")).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({
        event: "model.retry-delay",
        stage: "broker_retry_delay",
        attempt: 1,
        deadlineMs: 100,
        remainingDeadlineMs: 100,
        elapsedMs: 100,
        outcome: "failed",
        failureCode: "model_timeout",
        requestId: events[0].requestId,
      });
      expect(logs.join("")).not.toMatch(/private|43123/);
    } finally {
      fetch.mockRestore();
      log.mockRestore();
      vi.useRealTimers();
    }
  },
);

it("redacts arbitrary broker failure codes in timing records", async () => {
  const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        error: { code: "private source content", message: "private message", retryable: false },
      }),
      { status: 400 },
    ),
  );
  try {
    await expect(
      new BrokerReviewModel("http://127.0.0.1:43123", "secret").review({
        prompt: "Review",
        input: {},
        schema: { type: "object" },
      }),
    ).rejects.toMatchObject({ code: "private source content" });
    const output = log.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain('"failureCode":"model_review_failed"');
    expect(output).not.toContain("private");
  } finally {
    fetch.mockRestore();
    log.mockRestore();
  }
});

it("a broken timing sink preserves broker success", async () => {
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => {
    throw new Error("sink failed");
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        protocolVersion: ADVERSARY_MODEL_PROTOCOL_VERSION,
        provider: "fixture",
        model: "fixture",
        output: {},
      }),
    ),
  );
  try {
    await expect(
      new BrokerReviewModel("http://127.0.0.1:43123", "secret").review({
        prompt: "Review",
        input: {},
        schema: { type: "object" },
      }),
    ).resolves.toMatchObject({ output: {} });
  } finally {
    fetch.mockRestore();
    log.mockRestore();
  }
});

it.each([false, true])(
  "normalizes a response-body failure (deadline fired=%s)",
  async (deadlineFired) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const fail = () => controller.error(new TypeError("body stream failed"));
              if (deadlineFired && !init?.signal?.aborted) {
                init?.signal?.addEventListener("abort", fail, { once: true });
              } else fail();
            },
          }),
        ),
    );
    try {
      const model = new BrokerReviewModel("http://127.0.0.1:43123", "secret", {
        maximumAttempts: 1,
      });
      const request = model.review({
        prompt: "Review",
        input: {},
        schema: { type: "object" },
        budget: { timeoutMs: deadlineFired ? 10 : 5_000 },
      });
      await expect(request).rejects.toBeInstanceOf(ModelReviewError);
      await expect(request).rejects.toMatchObject({
        code: "model_request_recovery_exhausted",
        retryable: false,
        diagnostics: { attempts: 1, reason: deadlineFired ? "deadline" : "attempt_limit" },
      });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      fetch.mockRestore();
    }
  },
);

it("keeps response size-limit failures typed and nonretryable", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("", { headers: { "content-length": String((4 << 20) + 1) } }));
  try {
    const model = new BrokerReviewModel("http://127.0.0.1:43123", "secret", {
      initialRetryDelayMs: 0,
    });
    await expect(
      model.review({ prompt: "Review", input: {}, schema: { type: "object" } }),
    ).rejects.toMatchObject({ code: "model_response_too_large", retryable: false });
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    fetch.mockRestore();
  }
});

it.each([true, false])(
  "dispatcher cleanup failure preserves request outcome (success=%s)",
  async (success) => {
    const originalDestroy = Agent.prototype.destroy;
    const cleanup = vi.spyOn(Agent.prototype, "destroy").mockImplementation(async function (
      this: Agent,
    ) {
      await new Promise<void>((resolve, reject) => {
        originalDestroy.call(this, null, (error) => (error ? reject(error) : resolve()));
      });
      throw new Error("cleanup failed");
    });
    try {
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            protocolVersion: ADVERSARY_MODEL_PROTOCOL_VERSION,
            provider: "fixture",
            model: "fixture",
            output: success ? {} : null,
          }),
        );
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const model = new BrokerReviewModel(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        "secret",
      );
      const result = model.review({ prompt: "Review", input: {}, schema: { type: "object" } });
      if (success) await expect(result).resolves.toMatchObject({ output: {} });
      else {
        await expect(result).rejects.toBeInstanceOf(ModelReviewError);
        await expect(result).rejects.toMatchObject({ code: "invalid_model_output" });
      }
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      cleanup.mockRestore();
    }
  },
);

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

describe("model review capability", () => {
  it("exposes an injectable provider-neutral model on rule context", async () => {
    const requests: ModelReviewRequest[] = [];
    const model: ReviewModel = {
      async review<T>(request: ModelReviewRequest) {
        requests.push(request);
        return {
          output: { verdict: "approve" } as T,
          provider: "fixture",
          model: "staff-reviewer",
        };
      },
    };
    const app = new Adversary({ name: "adversarylabs/model-test" });
    app.rule("review", async (ctx) => {
      const result = await ctx.model.review<{ verdict: string }>({
        prompt: "Review this change.",
        input: { files: ["src/index.ts"] },
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["verdict"],
          properties: { verdict: { type: "string" } },
        },
      });
      ctx.review.observe({ key: "model.verdict", summary: result.output.verdict });
    });

    const result = await app.run({
      input: { source: { path: process.cwd() } },
      model,
    });

    expect(requests).toHaveLength(1);
    expect(result.observations).toEqual([{ key: "model.verdict", summary: "approve" }]);
  });

  it("retries adversary validation with feedback and aggregated usage", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const model: ReviewModel = {
      async review<T>(request: ModelReviewRequest<T>) {
        calls += 1;
        prompts.push(request.prompt);
        expect(request.validation).toBeUndefined();
        return {
          output: { verdict: calls === 1 ? "incomplete" : "approve" } as T,
          provider: "fixture",
          model: "reviewer",
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      },
    };
    const app = new Adversary({ name: "adversarylabs/model-validation-test" });
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    app.rule("review", async (ctx) => {
      const result = await ctx.model.review<{ verdict: string }>({
        prompt: "Review this change.",
        input: {},
        schema: { type: "object" },
        validation: {
          validate: ({ output }) => {
            if (output.verdict !== "approve") throw new Error("verdict must be approve");
          },
        },
      });
      usage = result.usage;
    });

    await app.run({ input: { source: { path: process.cwd() } }, model });

    expect(calls).toBe(2);
    expect(prompts[0]).toBe("Review this change.");
    expect(prompts[1]).toContain('"error":"verdict must be approve"');
    expect(usage).toEqual({ inputTokens: 20, outputTokens: 4 });
  });

  it("returns a non-retryable typed error after validation attempts are exhausted", async () => {
    const model: ReviewModel = {
      async review<T>() {
        return { output: { verdict: "incomplete" } as T, provider: "fixture", model: "reviewer" };
      },
    };
    const app = new Adversary({ name: "adversarylabs/model-validation-failure-test" });
    app.rule("review", async (ctx) => {
      await ctx.model.review({
        prompt: "Review this change.",
        input: {},
        schema: { type: "object" },
        validation: {
          maximumAttempts: 2,
          validate: () => {
            throw new Error("missing required finding");
          },
        },
      });
    });

    await expect(
      app.run({ input: { source: { path: process.cwd() } }, model }),
    ).rejects.toMatchObject<ModelReviewError>({
      code: "model_validation_failed",
      retryable: false,
    });
  });

  it.each([1, 2])(
    "marks the shared validation deadline as terminal after %i completed attempts",
    async (attempts) => {
      let now = 1_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const budgets: number[] = [];
      const model: ReviewModel = {
        async review<T>(request: ModelReviewRequest<T>) {
          budgets.push(request.budget?.timeoutMs ?? 0);
          return { output: {} as T, provider: "fixture", model: "reviewer" };
        },
      };
      try {
        const result = reviewWithValidation(model, {
          prompt: "Private prompt",
          input: {},
          schema: { type: "object" },
          budget: { timeoutMs: attempts * 50 },
          validation: {
            validate: () => {
              now += 50;
              throw new Error("Private validator feedback");
            },
          },
        });
        await expect(result).rejects.toMatchObject({
          code: "model_request_recovery_exhausted",
          retryable: false,
          diagnostics: { attempts, reason: "deadline" },
          message: `model_request_recovery_exhausted: Model request recovery exhausted after ${attempts} attempt(s) (deadline).`,
        });
        expect(budgets).toEqual(attempts === 1 ? [50] : [100, 50]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("fails explicitly when an adversary requests an unavailable model", async () => {
    await expect(
      unavailableModel().review({
        prompt: "Review.",
        input: {},
        schema: { type: "object" },
      }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("requires repository tools to run through a rule-context model", async () => {
    const model = new BrokerReviewModel("http://127.0.0.1:43123/v1/review", "secret");
    await expect(
      model.review({
        prompt: "Review.",
        input: {},
        schema: { type: "object" },
        tools: { repository: {} },
      }),
    ).rejects.toMatchObject<ModelReviewError>({ code: "invalid_model_request" });
  });

  it("uses the authenticated loopback broker and validates its structured output", async () => {
    let authorization = "";
    let body: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      authorization = request.headers.authorization ?? "";
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          protocolVersion: ADVERSARY_MODEL_PROTOCOL_VERSION,
          provider: "fixture",
          model: "reviewer-v1",
          output: { verdict: "approve" },
          usage: { inputTokens: 12, outputTokens: 3 },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const model = new BrokerReviewModel(
      `http://127.0.0.1:${address.port}/v1/review`,
      "execution-secret",
    );

    const result = await model.review<{ verdict: string }>({
      prompt: "Act as a staff engineer.",
      input: { patch: "+ return value" },
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["verdict"],
        properties: { verdict: { enum: ["approve", "request_changes"] } },
      },
      budget: { maximumOutputTokens: 1024, timeoutMs: 5_000 },
    });

    expect(authorization).toBe("Bearer execution-secret");
    expect(body).toMatchObject({
      protocolVersion: ADVERSARY_MODEL_PROTOCOL_VERSION,
      prompt: "Act as a staff engineer.",
      budget: { maximumOutputTokens: 1024, timeoutMs: 5_000 },
    });
    expect(result).toEqual({
      output: { verdict: "approve" },
      provider: "fixture",
      model: "reviewer-v1",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it("retries transient broker failures within the original review timeout", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.setHeader("content-type", "application/json");
      if (requests < 3) {
        response.statusCode = 502;
        response.end(
          JSON.stringify({
            error: { code: "bad_gateway", message: "temporary gateway failure", retryable: true },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          protocolVersion: ADVERSARY_MODEL_PROTOCOL_VERSION,
          provider: "fixture",
          model: "reviewer-v1",
          output: { verdict: "approve" },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const model = new BrokerReviewModel(`http://127.0.0.1:${address.port}`, "secret", {
      maximumAttempts: 3,
      initialRetryDelayMs: 0,
      random: () => 0,
    });

    const result = await model.review<{ verdict: string }>({
      prompt: "Review.",
      input: {},
      schema: {
        type: "object",
        required: ["verdict"],
        properties: { verdict: { const: "approve" } },
      },
      budget: { timeoutMs: 5_000 },
    });

    expect(requests).toBe(3);
    expect(result.output).toEqual({ verdict: "approve" });
  });

  it("rejects a broker answer that violates the adversary schema", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          protocolVersion: ADVERSARY_MODEL_PROTOCOL_VERSION,
          provider: "fixture",
          model: "reviewer-v1",
          output: { verdict: "maybe" },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const model = new BrokerReviewModel(`http://127.0.0.1:${address.port}`, "secret");

    await expect(
      model.review({
        prompt: "Review.",
        input: {},
        schema: {
          type: "object",
          required: ["verdict"],
          properties: { verdict: { const: "approve" } },
        },
      }),
    ).rejects.toMatchObject<ModelReviewError>({ code: "invalid_model_output" });
  });

  it("enforces the review timeout while reading the broker response body", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.flushHeaders();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const model = new BrokerReviewModel(`http://127.0.0.1:${address.port}`, "secret");

    await expect(
      model.review({
        prompt: "Review.",
        input: {},
        schema: { type: "object" },
        budget: { timeoutMs: 25 },
      }),
    ).rejects.toMatchObject({ code: "model_request_recovery_exhausted", retryable: false });
  });

  it("retrieves repository evidence through bounded planning rounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "adversary-sdk-repository-tools-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src", "index.ts"),
        "export function important(): string {\n  return 'prepared evidence';\n}\n",
      );
      let planningCalls = 0;
      let finalCalls = 0;
      let finalInput: unknown;
      const model: ReviewModel = {
        async review<T>(request: ModelReviewRequest) {
          const properties = request.schema.properties as Record<string, unknown> | undefined;
          if (properties?.ready !== undefined) {
            planningCalls += 1;
            const encoded = JSON.stringify(request.input);
            if (planningCalls === 1) {
              expect(request.prompt).toContain("at most 8 operations");
              expect(JSON.stringify(request.schema)).toContain('"maxItems":8');
              expect(encoded).not.toContain("prepared evidence");
              return {
                output: {
                  ready: false,
                  operations: [
                    {
                      tool: "list_directory",
                      path: "src",
                      cursor: 0,
                      startLine: 0,
                      endLine: 0,
                    },
                  ],
                } as T,
                provider: "fixture",
                model: "planner",
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            }
            if (planningCalls === 2) {
              expect(encoded).toContain("src/index.ts");
              return {
                output: {
                  ready: false,
                  operations: [
                    {
                      tool: "read_file",
                      path: "src/index.ts",
                      cursor: 0,
                      startLine: 1,
                      endLine: 3,
                    },
                  ],
                } as T,
                provider: "fixture",
                model: "planner",
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            }
            expect(encoded).toContain("repo:read:1");
            expect(encoded).toContain("prepared evidence");
            return {
              output: { ready: true, operations: [] } as T,
              provider: "fixture",
              model: "planner",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
          finalCalls += 1;
          expect(request.validation).toBeUndefined();
          finalInput = request.input;
          return {
            output: { verdict: finalCalls === 1 ? "incomplete" : "approve" } as T,
            provider: "fixture",
            model: "reviewer",
            usage: { inputTokens: 2, outputTokens: 2 },
          };
        },
      };
      const app = new Adversary({ name: "adversarylabs/repository-tools" });
      let reviewResult: Awaited<ReturnType<ReviewModel["review"]>> | undefined;
      app.rule("review", async (ctx) => {
        reviewResult = await ctx.model.review({
          prompt: "Review the implementation.",
          input: { change: "all files" },
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["verdict"],
            properties: { verdict: { const: "approve" } },
          },
          tools: {
            repository: {
              include: ["**/*.ts"],
              maxRounds: 4,
              maxToolCalls: 4,
            },
          },
          validation: {
            validate: (result) => {
              expect(result.citations).toHaveLength(1);
              if (result.output.verdict !== "approve") throw new Error("verdict must be approve");
            },
          },
        });
      });

      await app.run({ input: { source: { path: root } }, model });

      expect(planningCalls).toBe(3);
      expect(finalCalls).toBe(2);
      expect(JSON.stringify(finalInput)).toContain("prepared evidence");
      expect(reviewResult?.citations).toEqual([
        {
          citationId: "repo:read:1",
          path: "src/index.ts",
          startLine: 1,
          endLine: 3,
          content: "export function important(): string {\n  return 'prepared evidence';\n}",
        },
      ]);
      expect(reviewResult?.retrieval).toMatchObject({
        rounds: 3,
        toolCalls: 2,
        filesRead: 1,
        directoriesListed: 2,
        exhausted: false,
      });
      expect(reviewResult?.usage).toEqual({ inputTokens: 7, outputTokens: 7 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows the exact change before asking the model to judge it", async () => {
    const root = await mkdtemp(join(tmpdir(), "adversary-sdk-change-tools-"));
    try {
      execFileSync("git", ["-C", root, "init", "-q"]);
      await writeFile(join(root, "service.ts"), "export function value() {\n  return 'safe';\n}\n");
      execFileSync("git", ["-C", root, "add", "service.ts"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "-qm",
        "base",
      ]);
      const baseRef = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      await writeFile(
        join(root, "service.ts"),
        "export function value() {\n  return 'broken';\n}\n",
      );
      execFileSync("git", ["-C", root, "add", "service.ts"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "-qm",
        "head",
      ]);
      const headRef = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();

      let planningCalls = 0;
      let finalInput: unknown;
      const model: ReviewModel = {
        async review<T>(request: ModelReviewRequest) {
          const properties = request.schema.properties as Record<string, unknown> | undefined;
          if (properties?.ready !== undefined) {
            planningCalls += 1;
            const encoded = JSON.stringify(request.input);
            if (planningCalls === 1) {
              expect(encoded).toContain('"tool":"change_summary"');
              expect(encoded).toContain("service.ts");
              return {
                output: {
                  ready: false,
                  operations: [
                    {
                      tool: "read_change",
                      path: "service.ts",
                      cursor: 0,
                      startLine: 0,
                      endLine: 0,
                    },
                  ],
                } as T,
                provider: "fixture",
                model: "planner",
              };
            }
            if (planningCalls === 2) {
              expect(encoded).toContain("+  return 'broken';");
              return {
                output: {
                  ready: false,
                  operations: [
                    {
                      tool: "read_file",
                      path: "service.ts",
                      cursor: 0,
                      startLine: 1,
                      endLine: 3,
                    },
                  ],
                } as T,
                provider: "fixture",
                model: "planner",
              };
            }
            return {
              output: { ready: true, operations: [] } as T,
              provider: "fixture",
              model: "planner",
            };
          }
          finalInput = request.input;
          return {
            output: { verdict: "approve" } as T,
            provider: "fixture",
            model: "reviewer",
          };
        },
      };
      const app = new Adversary({ name: "adversarylabs/change-tools" });
      app.rule("review", async (ctx) => {
        await ctx.model.review({
          prompt: "Review the changed behavior.",
          input: {},
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["verdict"],
            properties: { verdict: { const: "approve" } },
          },
          tools: { repository: { include: ["**/*.ts"] } },
        });
      });
      await app.run({
        input: {
          source: { path: root },
          change: {
            type: "diff",
            base_ref: baseRef,
            head_ref: headRef,
            changed_files: ["service.ts"],
          },
        },
        model,
      });

      expect(planningCalls).toBe(1);
      expect(JSON.stringify(finalInput)).toContain("+  return 'broken';");
      expect(JSON.stringify(finalInput)).toContain("repo:read:1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects repository plans that exceed the per-round operation bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "adversary-sdk-repository-plan-bound-"));
    try {
      await writeFile(join(root, "index.ts"), "export const value = true;\n");
      const model: ReviewModel = {
        async review<T>(request: ModelReviewRequest) {
          const properties = request.schema.properties as Record<string, unknown> | undefined;
          if (properties?.ready !== undefined) {
            return {
              output: {
                ready: false,
                operations: Array.from({ length: 9 }, (_, index) => ({
                  tool: "read_file",
                  path: "index.ts",
                  cursor: 0,
                  startLine: index + 1,
                  endLine: index + 1,
                })),
              } as T,
              provider: "fixture",
              model: "planner",
            };
          }
          return {
            output: { verdict: "approve" } as T,
            provider: "fixture",
            model: "reviewer",
          };
        },
      };
      const app = new Adversary({ name: "adversarylabs/repository-plan-bound" });
      app.rule("review", async (ctx) => {
        await ctx.model.review({
          prompt: "Review safely.",
          input: {},
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["verdict"],
            properties: { verdict: { const: "approve" } },
          },
          tools: { repository: { include: ["**/*.ts"] } },
        });
      });

      await expect(
        app.run({ input: { source: { path: root } }, model }),
      ).rejects.toMatchObject<ModelReviewError>({
        code: "invalid_model_output",
        retryable: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("paginates repository listings before reading a selected file", async () => {
    const root = await mkdtemp(join(tmpdir(), "adversary-sdk-repository-pages-"));
    try {
      for (let index = 1; index <= 5; index += 1) {
        await writeFile(join(root, `file-${index}.ts`), `export const value${index} = ${index};\n`);
      }
      let planningCalls = 0;
      const model: ReviewModel = {
        async review<T>(request: ModelReviewRequest) {
          const properties = request.schema.properties as Record<string, unknown> | undefined;
          if (properties?.ready === undefined) {
            return {
              output: { verdict: "approve" } as T,
              provider: "fixture",
              model: "reviewer",
            };
          }
          planningCalls += 1;
          const encoded = JSON.stringify(request.input);
          if (planningCalls === 1) {
            expect(encoded).toContain('"nextCursor":2');
            expect(encoded).not.toContain("file-3.ts");
            return {
              output: {
                ready: false,
                operations: [
                  {
                    tool: "list_directory",
                    path: ".",
                    cursor: 2,
                    startLine: 0,
                    endLine: 0,
                  },
                ],
              } as T,
              provider: "fixture",
              model: "planner",
            };
          }
          if (planningCalls === 2) {
            expect(encoded).toContain("file-3.ts");
            expect(encoded).toContain('"nextCursor":4');
            return {
              output: {
                ready: false,
                operations: [
                  {
                    tool: "list_directory",
                    path: ".",
                    cursor: 4,
                    startLine: 0,
                    endLine: 0,
                  },
                ],
              } as T,
              provider: "fixture",
              model: "planner",
            };
          }
          if (planningCalls === 3) {
            expect(encoded).toContain("file-5.ts");
            return {
              output: {
                ready: false,
                operations: [
                  {
                    tool: "read_file",
                    path: "file-5.ts",
                    cursor: 0,
                    startLine: 1,
                    endLine: 1,
                  },
                ],
              } as T,
              provider: "fixture",
              model: "planner",
            };
          }
          expect(encoded).toContain("export const value5 = 5;");
          return {
            output: { ready: true, operations: [] } as T,
            provider: "fixture",
            model: "planner",
          };
        },
      };
      const app = new Adversary({ name: "adversarylabs/repository-pages" });
      let citations: readonly { path: string }[] | undefined;
      app.rule("review", async (ctx) => {
        const result = await ctx.model.review({
          prompt: "Review a selected file.",
          input: {},
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["verdict"],
            properties: { verdict: { const: "approve" } },
          },
          tools: {
            repository: {
              include: ["**/*.ts"],
              directoryPageSize: 2,
              maxRounds: 5,
            },
          },
        });
        citations = result.citations;
      });

      await app.run({ input: { source: { path: root } }, model });

      expect(planningCalls).toBe(4);
      expect(citations).toMatchObject([{ path: "file-5.ts" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks repository traversal and symbolic-link reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "adversary-sdk-repository-safety-"));
    const outside = await mkdtemp(join(tmpdir(), "adversary-sdk-repository-secret-"));
    try {
      await writeFile(join(outside, "secret.ts"), "do not disclose");
      await symlink(join(outside, "secret.ts"), join(root, "linked.ts"));
      let planningCalls = 0;
      let finalInput: unknown;
      const model: ReviewModel = {
        async review<T>(request: ModelReviewRequest) {
          const properties = request.schema.properties as Record<string, unknown> | undefined;
          if (properties?.ready !== undefined) {
            planningCalls += 1;
            return {
              output:
                planningCalls === 1
                  ? {
                      ready: false,
                      operations: [
                        {
                          tool: "read_file",
                          path: "../secret.ts",
                          cursor: 0,
                          startLine: 1,
                          endLine: 20,
                        },
                        {
                          tool: "read_file",
                          path: "linked.ts",
                          cursor: 0,
                          startLine: 1,
                          endLine: 20,
                        },
                      ],
                    }
                  : ({ ready: true, operations: [] } as T),
              provider: "fixture",
              model: "planner",
            };
          }
          finalInput = request.input;
          return {
            output: { verdict: "approve" } as T,
            provider: "fixture",
            model: "reviewer",
          };
        },
      };
      const app = new Adversary({ name: "adversarylabs/repository-safety" });
      let citations: readonly unknown[] | undefined;
      app.rule("review", async (ctx) => {
        const result = await ctx.model.review({
          prompt: "Review safely.",
          input: {},
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["verdict"],
            properties: { verdict: { const: "approve" } },
          },
          tools: { repository: { include: ["**/*.ts"] } },
        });
        citations = result.citations;
      });

      await app.run({ input: { source: { path: root } }, model });

      expect(citations).toEqual([]);
      expect(JSON.stringify(finalInput)).not.toContain("do not disclose");
      expect(JSON.stringify(finalInput)).toContain("repository-relative path");
      expect(JSON.stringify(finalInput)).toContain("symbolic link");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("accepts bracketed IPv6 loopback endpoints", () => {
    expect(() => new BrokerReviewModel("http://[::1]:43123/v1/review", "secret")).not.toThrow();
  });

  it("rejects unknown output schema keywords", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          protocolVersion: ADVERSARY_MODEL_PROTOCOL_VERSION,
          provider: "fixture",
          model: "reviewer-v1",
          output: { verdict: "approve" },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const model = new BrokerReviewModel(`http://127.0.0.1:${address.port}`, "secret");

    await expect(
      model.review({
        prompt: "Review.",
        input: {},
        schema: { type: "object", propertiez: { verdict: { type: "string" } } },
      }),
    ).rejects.toMatchObject<ModelReviewError>({ code: "invalid_model_schema" });
  });
});

it.each([false, true])(
  "reuses gathered evidence across broker retries (exhausted=%s)",
  async (exhausted) => {
    const root = await mkdtemp(join(tmpdir(), "sdk-retained-evidence-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/index.ts"), "export const evidence = 'retained source';\n");
    let planningCalls = 0;
    const finalPayloads: unknown[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      let output: unknown;
      if (payload.schema.properties?.ready !== undefined) {
        planningCalls++;
        output =
          planningCalls === 1
            ? {
                ready: false,
                operations: [
                  { tool: "read_file", path: "src/index.ts", cursor: 0, startLine: 1, endLine: 1 },
                ],
              }
            : { ready: true, operations: [] };
      } else {
        finalPayloads.push(payload);
        if (finalPayloads.length < 3 || exhausted) {
          return new Response(
            JSON.stringify({
              error: { code: "model_timeout", message: "private upstream body", retryable: true },
            }),
            { status: 503 },
          );
        }
        output = { verdict: "approve" };
      }
      return new Response(
        JSON.stringify({
          protocolVersion: ADVERSARY_MODEL_PROTOCOL_VERSION,
          provider: "fixture",
          model: "fixture",
          output,
        }),
      );
    });
    try {
      const model = enhanceReviewModel(
        new BrokerReviewModel("http://127.0.0.1:43123", "private-token", {
          maximumAttempts: 3,
          initialRetryDelayMs: 0,
        }),
        root,
      );
      const result = model.review({
        prompt: "Review the source",
        input: {},
        schema: {
          type: "object",
          required: ["verdict"],
          properties: { verdict: { const: "approve" } },
          additionalProperties: false,
        },
        tools: { repository: { include: ["**/*.ts"], maxRounds: 3, maxToolCalls: 3 } },
        budget: { timeoutMs: 5000 },
      });
      if (exhausted) {
        await expect(result).rejects.toMatchObject({
          code: "model_request_recovery_exhausted",
          retryable: false,
          diagnostics: { attempts: 3, reason: "attempt_limit" },
        });
        await expect(result).rejects.toThrow("model_request_recovery_exhausted:");
        await expect(result).rejects.not.toThrow("private upstream body");
      } else {
        await expect(result).resolves.toMatchObject({ output: { verdict: "approve" } });
      }
      expect(planningCalls).toBe(2);
      expect(finalPayloads).toHaveLength(3);
      expect(finalPayloads[1]).toEqual(finalPayloads[0]);
      expect(finalPayloads[2]).toEqual(finalPayloads[0]);
      expect(JSON.stringify(finalPayloads[0])).toContain("retained source");
      expect(JSON.stringify(finalPayloads[0])).toContain("repo:read:1");
    } finally {
      fetch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
