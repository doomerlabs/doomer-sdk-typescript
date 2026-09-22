import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADVERSARY_MODEL_PROTOCOL_VERSION,
  Adversary,
  BrokerReviewModel,
  type ModelReviewError,
  type ModelReviewRequest,
  ModelUnavailableError,
  type ReviewModel,
  unavailableModel,
} from "../src/index.js";

const servers: ReturnType<typeof createServer>[] = [];

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
    ).rejects.toMatchObject<ModelReviewError>({ code: "model_timeout", retryable: true });
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

      expect(planningCalls).toBe(3);
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
