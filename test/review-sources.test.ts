import { describe, expect, it } from "vitest";
import { Adversary, createAdversaryRunEnvelope, validateRunEnvelope } from "../src/index.js";
import { type ReviewSource, normalizeReviewSource } from "../src/review-sources.js";

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
    expect(() => validateRunEnvelope(envelope)).not.toThrow();
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
