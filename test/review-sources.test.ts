import { describe, expect, it } from "vitest";
import { Adversary, createAdversaryRunEnvelope, validateRunEnvelope } from "../src/index.js";
import {
  type ReviewSource,
  ReviewSourceValidationError,
  normalizeReviewSource,
} from "../src/review-sources.js";

const source: ReviewSource = {
  id: "actionlint",
  kind: "tool",
  title: "Actionlint",
  status: "passed",
  summary: "No diagnostics.",
  version: "1.0",
  scope: [".github/workflows/ci.yml"],
};

describe("review evidence sources", () => {
  it("reports clean runs, updates the same invocation, and emits linked findings", async () => {
    const app = new Adversary({ name: "source-contract" });
    app.rule("sources", (ctx) => {
      ctx.review.source(source);
      ctx.review.source({
        ...source,
        status: "findings",
        summary: "Invalid workflow.",
        output: "ci.yml:3: invalid expression",
      });
      ctx.finding({
        id: "invalid",
        title: "Invalid workflow",
        summary: "The workflow expression is invalid.",
        category: "ci",
        severity: "high",
        confidence: "high",
        evidence: [{ file: ".github/workflows/ci.yml", line: 3 }],
        sourceIds: [source.id],
      });
    });
    const result = await app.run({ input: { source: { path: process.cwd() } } });
    expect(result.sources).toHaveLength(1);
    expect(result.sources?.[0].status).toBe("findings");
    expect(result.findings[0].sourceIds).toEqual([source.id]);
    const envelope = createAdversaryRunEnvelope(result);
    await expect(validateRunEnvelope(envelope)).resolves.toBeUndefined();
    expect(envelope.result.findings[0].sourceIds).toEqual([source.id]);
  });

  it("retains clean, unavailable, partial and failed sources without findings", async () => {
    const app = new Adversary({ name: "source-status" });
    app.rule("sources", (ctx) => {
      for (const status of ["passed", "unavailable", "partial", "error"] as const)
        ctx.review.source({ ...source, id: status, status });
    });
    const result = await app.run({ input: { source: { path: process.cwd() } } });
    expect(result.findings).toEqual([]);
    expect(result.opinion?.ship).not.toBe(true);
    expect(result.sources?.map((s) => s.status)).toEqual([
      "passed",
      "unavailable",
      "partial",
      "error",
    ]);
  });

  it("bounds UTF-8 output, marks truncation and removes common secrets", () => {
    const result = normalizeReviewSource({
      ...source,
      output: `Bearer abc.def\npassword=topsecret\n${"λ".repeat(40000)}`,
      data: { token: "secret" },
    });
    expect(Buffer.byteLength(result.output ?? "")).toBeLessThanOrEqual(32768);
    expect(result.truncated).toBe(true);
    expect(result.output).not.toContain("topsecret");
    expect(result.output).not.toContain("abc.def");
    expect(result.data).toBeUndefined();
    expect(
      normalizeReviewSource({ ...source, data: { nested: { api_key: "secret" }, count: 3 } }).data,
    ).toEqual({ nested: { api_key: "[REDACTED]" }, count: 3 });
  });

  it("rejects dangerous links and unknown finding source IDs", async () => {
    expect(() => normalizeReviewSource({ ...source, url: "javascript:alert(1)" })).toThrow();
    expect(() =>
      normalizeReviewSource({ ...source, url: "https://name:password@example.com" }),
    ).toThrow();
    const app = new Adversary({ name: "bad-source-ref" });
    app.rule("sources", (ctx) =>
      ctx.finding({
        title: "Invalid",
        summary: "Invalid source.",
        category: "ci",
        severity: "high",
        confidence: "high",
        evidence: [{ file: "ci.yml", line: 1 }],
        sourceIds: ["missing"],
      }),
    );
    await expect(app.run({ input: { source: { path: process.cwd() } } })).rejects.toThrow(
      "Unknown review source",
    );
  });

  it("does not add the optional field to legacy reviews", async () => {
    const result = await new Adversary({ name: "legacy" }).run({
      input: { source: { path: process.cwd() } },
    });
    expect(createAdversaryRunEnvelope(result).result).not.toHaveProperty("sources");
  });
});

describe("review source validation regressions", () => {
  it("redacts every supported credential assignment, including quoted JSON", () => {
    for (const key of [
      "password",
      "passwd",
      "secret",
      "token",
      "access_token",
      "api-key",
      "authorization",
      "private_key",
    ]) {
      for (const output of [
        `${key}=hunter2`,
        `"${key}": "hunter2"`,
        `'${key}': 'hunter2'`,
        `${key}: Basic hunter2`,
      ]) {
        expect(normalizeReviewSource({ ...source, output }).output).not.toContain("hunter2");
      }
    }
    const output = normalizeReviewSource({
      ...source,
      output: '{"password":"hunter2","count":3}',
    }).output;
    expect(JSON.parse(output ?? "")).toEqual({ password: "[REDACTED]", count: 3 });
  });

  it("canonicalizes URLs and redacts decoded query, path and fragment credentials", () => {
    const result = normalizeReviewSource({
      ...source,
      url: "HTTPS://example.com/token=pathsecret?%74oken=querysecret&note=Bearer%20bearersecret#password=hashsecret",
    });
    expect(result.url).toMatch(/^https:\/\//);
    for (const secret of ["pathsecret", "querysecret", "bearersecret", "hashsecret"])
      expect(result.url).not.toContain(secret);
    expect(new URL(result.url ?? "").searchParams.get("token")).toBe("[REDACTED]");
  });

  it("reports typed errors with safe field and caller context", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const [field, value] of [
      ["url", "secret invalid URL"],
      ["data", circular],
      ["data", { value: 1n }],
      ["scope", "not-an-array"],
      ["scope", [1]],
      ["summary", 4],
    ] as const) {
      try {
        normalizeReviewSource({ ...source, [field]: value } as ReviewSource, "ctx.review.source");
        throw new Error("expected validation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewSourceValidationError);
        expect(error).toMatchObject({
          code: "invalid_review_source",
          field: `ctx.review.source.${field}`,
          sourceId: source.id,
        });
        expect((error as Error).message).not.toContain("secret invalid URL");
      }
    }
  });

  it("rejects malformed finding and observation source references", async () => {
    for (const method of ["finding", "observe"] as const) {
      const app = new Adversary({ name: "invalid-references" });
      app.rule("sources", (ctx) => {
        ctx[method]({
          ruleId: "sources",
          subject: "ci.yml",
          title: "Invalid",
          summary: "Invalid",
          category: "ci",
          severity: "high",
          confidence: "high",
          evidence: [{ file: "ci.yml", line: 1 }],
          sourceIds: [123],
        } as never);
      });
      await expect(app.run({ input: { source: { path: process.cwd() } } })).rejects.toThrow(
        "sourceIds",
      );
    }
  });

  it("normalizes manually constructed results and validates combined wire bytes", async () => {
    const result = await new Adversary({ name: "wire-budget" }).run({
      input: { source: { path: process.cwd() } },
    });
    result.sources = [{ ...source, output: "λ".repeat(32768), data: { token: "hunter2" } }];
    const envelope = createAdversaryRunEnvelope(result);
    expect(envelope.result.sources?.[0].truncated).toBe(true);
    await expect(validateRunEnvelope(envelope)).resolves.toBeUndefined();
    envelope.result.sources = [{ ...source, output: "λ".repeat(20000) }];
    await expect(validateRunEnvelope(envelope)).rejects.toBeInstanceOf(ReviewSourceValidationError);
    envelope.result.sources = [
      { ...source, output: "x".repeat(20000), data: { value: "x".repeat(20000) } },
    ];
    await expect(validateRunEnvelope(envelope)).rejects.toBeInstanceOf(ReviewSourceValidationError);
    envelope.result.sources = [{ ...source, data: { value: "x".repeat(40000) } }];
    await expect(validateRunEnvelope(envelope)).rejects.toBeInstanceOf(ReviewSourceValidationError);
  });
});
