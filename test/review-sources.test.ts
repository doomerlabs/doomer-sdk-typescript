import { describe, expect, it } from "vitest";
import {
  Adversary,
  type ReviewSource,
  ReviewSourceCapacityError,
  ReviewSourceValidationError,
  createAdversaryRunEnvelope,
  validateRunEnvelope,
} from "../src/index.js";
import { normalizeReviewSource } from "../src/review-sources.js";

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
    expect(result.data).toEqual({ token: "[REDACTED]" });
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
          field: `ctx.review.source.${field === "scope" && Array.isArray(value) ? "scope[0]" : field}`,
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

describe("source contract boundary regressions", () => {
  it("redacts separator-prefixed credential names without matching unrelated words", () => {
    for (const key of [
      "GITHUB_TOKEN",
      "client_secret",
      "AWS_SECRET_ACCESS_KEY",
      "service-private-key",
    ]) {
      const normalized = normalizeReviewSource({
        ...source,
        output: `${key}=hunter2`,
        data: { [key]: "hunter2", tokenizer: "visible", secretive: "visible" },
        url: `https://example.com/?${key}=hunter2&tokenizer=visible`,
      });
      expect(normalized.output).not.toContain("hunter2");
      expect(normalized.data?.[key]).toBe("[REDACTED]");
      expect(normalized.data?.tokenizer).toBe("visible");
      expect(normalized.data?.secretive).toBe("visible");
      expect(normalized.url).not.toContain("hunter2");
      expect(new URL(normalized.url ?? "").searchParams.get("tokenizer")).toBe("visible");
    }
  });

  it("preserves URL separators and accepts literal percent signs while scrubbing paths", () => {
    const url = "https://example.com/100%/a%2Fb/token%3Dhunter2%3Fextra%23tail?q=safe#100%";
    const normalized = new URL(normalizeReviewSource({ ...source, url }).url ?? "");
    expect(normalized.pathname).toContain("/100%/a%2Fb/");
    expect(normalized.pathname).not.toContain("hunter2");
    expect(normalized.search).toBe("?q=safe");
    expect(normalized.hash).toBe("#100%");
    expect(normalizeReviewSource({ ...source, url: normalized.toString() }).url).toBe(
      normalized.toString(),
    );
  });

  it("wraps wire data serialization failures in typed errors", async () => {
    const result = await new Adversary({ name: "wire-json" }).run({
      input: { source: { path: process.cwd() } },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const data of [
      circular,
      { value: 1n },
      {
        toJSON() {
          throw new Error("private details");
        },
      },
    ]) {
      const envelope = createAdversaryRunEnvelope(result);
      envelope.result.sources = [{ ...source, data }];
      await expect(validateRunEnvelope(envelope)).rejects.toMatchObject({
        name: "ReviewSourceValidationError",
        code: "invalid_review_source",
        field: "result.sources[0].data",
        sourceId: source.id,
      });
    }
  });

  it("validates active and suppressed references at construction and wire boundaries", async () => {
    const app = new Adversary({ name: "manual-references" });
    app.rule("sources", (ctx) => {
      ctx.review.source(source);
      ctx.finding({
        title: "Finding",
        summary: "Details",
        category: "ci",
        severity: "high",
        confidence: "high",
        evidence: [{ file: "ci.yml", line: 1 }],
        sourceIds: [source.id],
      });
    });
    const result = await app.run({ input: { source: { path: process.cwd() } } });
    const finding = result.findings[0];
    for (const field of ["findings", "suppressedFindings"] as const) {
      for (const invalidId of ["missing", "", "bad id"]) {
        const manual = { ...result, [field]: [{ ...finding, sourceIds: [invalidId] }] };
        expect(() => createAdversaryRunEnvelope(manual)).toThrow(ReviewSourceValidationError);
        const envelope = createAdversaryRunEnvelope(result);
        envelope.result[field] = [{ ...envelope.result.findings[0], sourceIds: [invalidId] }];
        await expect(validateRunEnvelope(envelope)).rejects.toBeInstanceOf(
          ReviewSourceValidationError,
        );
      }
    }
    const envelope = createAdversaryRunEnvelope({
      ...result,
      findings: [{ ...finding, sourceIds: [source.id, source.id] }],
    });
    expect(envelope.result.findings[0].sourceIds).toEqual([source.id]);
    await expect(validateRunEnvelope(envelope)).resolves.toBeUndefined();
  });

  it("rejects blank or malformed context source IDs instead of dropping them", async () => {
    for (const method of ["finding", "observe"] as const) {
      for (const id of ["", "bad id"]) {
        const app = new Adversary({ name: "invalid-id" });
        app.rule("sources", (ctx) =>
          ctx[method]({
            ruleId: "sources",
            subject: "ci.yml",
            title: "Finding",
            summary: "Details",
            category: "ci",
            severity: "high",
            confidence: "high",
            evidence: [{ file: "ci.yml", line: 1 }],
            sourceIds: [id],
          } as never),
        );
        await expect(
          app.run({ input: { source: { path: process.cwd() } } }),
        ).rejects.toBeInstanceOf(ReviewSourceValidationError);
      }
    }
  });

  it("labels capacity exhaustion as a source operation rather than an invalid ID", async () => {
    const app = new Adversary({ name: "source-capacity" });
    app.rule("sources", (ctx) => {
      for (let i = 0; i < 33; i++) ctx.review.source({ ...source, id: `source-${i}` });
    });
    await expect(app.run({ input: { source: { path: process.cwd() } } })).rejects.toMatchObject({
      field: "ctx.review.source",
      code: "review_source_capacity_exceeded",
    });
  });
});

describe("source error policy", () => {
  it("preserves specific typed URL and data rejection reasons", () => {
    expect(() =>
      normalizeReviewSource({ ...source, url: "https://user:pass@example.com" }),
    ).toThrow("without credentials");
    expect(() =>
      normalizeReviewSource({ ...source, url: `https://example.com/${"x".repeat(2100)}` }),
    ).toThrow("must be at most 2000 characters");
    expect(() =>
      normalizeReviewSource({ ...source, data: { toJSON: () => "not an object" } }),
    ).toThrow("must serialize to an object");
  });

  it("enforces the same URL policy on raw envelopes", async () => {
    const result = await new Adversary({ name: "raw-url" }).run({
      input: { source: { path: process.cwd() } },
    });
    for (const url of [
      "https://user:pass@example.com",
      "http://user@example.com",
      "javascript:alert(1)",
    ]) {
      const envelope = createAdversaryRunEnvelope(result);
      envelope.result.sources = [{ ...source, url }];
      await expect(validateRunEnvelope(envelope)).rejects.toMatchObject({
        name: "ReviewSourceValidationError",
        field: "result.sources[0].url",
      });
    }
  });

  it("anchors deferred reference errors to the original caller and rule", async () => {
    for (const method of ["finding", "observe"] as const) {
      const app = new Adversary({ name: "source-caller" });
      app.rule("sources", (ctx) =>
        ctx[method]({
          ruleId: "sources",
          subject: "ci.yml",
          title: "Finding",
          summary: "Details",
          category: "ci",
          severity: "high",
          confidence: "high",
          evidence: [{ file: "ci.yml", line: 1 }],
          sourceIds: ["missing"],
        } as never),
      );
      await expect(app.run({ input: { source: { path: process.cwd() } } })).rejects.toMatchObject({
        field: `ctx.${method} (rule sources)[0].sourceIds`,
        sourceId: "missing",
      });
    }
  });

  it("exports a distinct capacity error on the public SDK surface", () => {
    const error = new ReviewSourceCapacityError("extra");
    expect(error).toBeInstanceOf(ReviewSourceValidationError);
    expect(error.code).toBe("review_source_capacity_exceeded");
  });
});

it("reports the actual position of later invalid source references", async () => {
  for (const method of ["finding", "observe"] as const) {
    const app = new Adversary({ name: "later-reference" });
    app.rule("sources", (ctx) => {
      ctx.review.source(source);
      for (const id of [source.id, "missing"])
        ctx[method]({
          ruleId: "sources",
          subject: "ci.yml",
          title: "Finding",
          summary: "Details",
          category: "ci",
          severity: "high",
          confidence: "high",
          evidence: [{ file: "ci.yml", line: 1 }],
          sourceIds: [id],
        } as never);
    });
    await expect(app.run({ input: { source: { path: process.cwd() } } })).rejects.toMatchObject({
      field: `ctx.${method} (rule sources)[1].sourceIds`,
      sourceId: "missing",
    });
  }
});

it("identifies later sources in wire serialization and byte-budget errors", async () => {
  const result = await new Adversary({ name: "later-source" }).run({
    input: { source: { path: process.cwd() } },
  });
  for (const data of [{ value: 1n }, { value: "x".repeat(40000) }]) {
    const envelope = createAdversaryRunEnvelope(result);
    envelope.result.sources = [source, { ...source, id: "second", data }];
    await expect(validateRunEnvelope(envelope)).rejects.toMatchObject({
      field:
        typeof data.value === "bigint" ? "result.sources[1].data" : "result.sources[1].data/output",
      sourceId: "second",
    });
  }
});

it("keeps structured evidence by shortening UTF-8 output to the remaining budget", () => {
  for (const data of [{ count: 3 }, { value: "x".repeat(32756) }, { value: "x".repeat(40000) }]) {
    const result = normalizeReviewSource({ ...source, output: "λ".repeat(40000), data });
    const dataBytes = Buffer.byteLength(JSON.stringify(data));
    expect(result.data).toEqual(dataBytes <= 32768 ? data : undefined);
    expect(
      Buffer.byteLength(result.output ?? "") + Buffer.byteLength(JSON.stringify(result.data) ?? ""),
    ).toBeLessThanOrEqual(32768);
    expect(result.output).not.toContain("\uFFFD");
    expect(result.truncated).toBe(true);
  }
});

it("rejects duplicate source IDs at construction and raw wire boundaries", async () => {
  const result = await new Adversary({ name: "duplicate-sources" }).run({
    input: { source: { path: process.cwd() } },
  });
  result.sources = [source, { ...source, summary: "Updated invocation" }];
  expect(() => createAdversaryRunEnvelope(result)).toThrow("duplicate source ID");
  const envelope = createAdversaryRunEnvelope({ ...result, sources: [] });
  envelope.result.sources = result.sources;
  await expect(validateRunEnvelope(envelope)).rejects.toMatchObject({
    field: "result.sources[1].id",
    sourceId: source.id,
  });
});

it("indexes source normalization errors and omits invalid IDs from URL diagnostics", async () => {
  const result = await new Adversary({ name: "safe-id" }).run({
    input: { source: { path: process.cwd() } },
  });
  const invalid = { ...source, id: "password=private-value", url: "https://user:pass@example.com" };
  result.sources = [source, invalid];
  expect(() => createAdversaryRunEnvelope(result)).toThrow("result.sources[1].id");
  const envelope = createAdversaryRunEnvelope({ ...result, sources: [] });
  envelope.result.sources = result.sources;
  try {
    await validateRunEnvelope(envelope);
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewSourceValidationError);
    expect(error).toMatchObject({ field: "result.sources[1].url", sourceId: undefined });
    expect((error as Error).message).not.toContain("private-value");
  }
});

it("preserves benign display metadata while scrubbing raw credentials", () => {
  const text = "Bearer token required for API access; token: rotation pending";
  const result = normalizeReviewSource({
    ...source,
    kind: "token: rotation pending",
    title: text,
    summary: text,
    scope: ["secret: rotation pending"],
    output: `${text}\npassword=hunter2`,
  });
  expect(result.title).toBe(text);
  expect(result.summary).toBe(text);
  expect(result.kind).toBe("token: rotation pending");
  expect(result.scope).toEqual(["secret: rotation pending"]);
  expect(result.output).not.toContain("hunter2");
});

it("gives malformed references the same caller, rule and position context", async () => {
  for (const method of ["finding", "observe"] as const) {
    const app = new Adversary({ name: "early-context" });
    app.rule("sources", (ctx) => {
      for (const sourceIds of [undefined, [123]])
        ctx[method]({
          ruleId: "sources",
          subject: "ci.yml",
          title: "Finding",
          summary: "Details",
          category: "ci",
          severity: "high",
          confidence: "high",
          evidence: [{ file: "ci.yml", line: 1 }],
          sourceIds,
        } as never);
    });
    await expect(app.run({ input: { source: { path: process.cwd() } } })).rejects.toMatchObject({
      field: `ctx.${method} (rule sources)[1].sourceIds`,
    });
  }
});

it("omits empty manual sources and reports the failing scope item", async () => {
  const result = await new Adversary({ name: "empty-sources" }).run({
    input: { source: { path: process.cwd() } },
  });
  expect(createAdversaryRunEnvelope({ ...result, sources: [] }).result).not.toHaveProperty(
    "sources",
  );
  try {
    normalizeReviewSource(
      { ...source, scope: ["valid", 42] } as unknown as ReviewSource,
      "ctx.review.source",
    );
    throw new Error("expected scope rejection");
  } catch (error) {
    expect(error).toMatchObject({ field: "ctx.review.source.scope[1]", sourceId: source.id });
  }
});

it("records a machine-readable context reason for incomplete sources", async () => {
  const app = new Adversary({ name: "source-reason" });
  app.rule("sources", (ctx) => ctx.review.source({ ...source, status: "unavailable" }));
  const result = await app.run({ input: { source: { path: process.cwd() } } });
  expect(
    result.observations.find((note) => note.key === "code-review.coverage-gap.sources")?.metadata,
  ).toMatchObject({ role: "context", incomplete: true, reason: "source_coverage" });
});

it("redacts credentials followed by inline text across raw output, data and URLs", () => {
  for (const text of [
    "token: abc123 # rotated",
    "password=hunter2 (see run 4)",
    "Bearer ghp_abc was revoked",
    '"password": "hunter2" rest',
  ]) {
    const result = normalizeReviewSource({
      ...source,
      output: text,
      data: { note: text },
      url: `https://example.com/${encodeURIComponent(text)}?note=${encodeURIComponent(text)}#${encodeURIComponent(text)}`,
    });
    for (const secret of ["abc123", "hunter2", "ghp_abc"]) {
      expect(result.output).not.toContain(secret);
      expect(JSON.stringify(result.data)).not.toContain(secret);
      expect(result.url).not.toContain(secret);
    }
    expect(result.output).toContain("[REDACTED]");
  }
});

it("composes Bearer and assignment redaction without exposing the assignment value", () => {
  for (const text of [
    "Bearer\npassword=hunter2",
    "Bearer token=hunter2",
    "Bearer password= hunter2",
    "Bearer\tGITHUB_TOKEN=hunter2",
    "Bearer ghp_abc was revoked",
    "Bearer abc123== (expired)",
    "Bearer\n  ghp_abc",
    "Bearer\r\n\tghp_abc was revoked",
  ]) {
    const result = normalizeReviewSource({
      ...source,
      output: text,
      data: { note: text },
      url: `https://example.com/${encodeURIComponent(text)}?note=${encodeURIComponent(text)}`,
    });
    for (const secret of ["hunter2", "ghp_abc", "abc123"]) {
      expect(result.output).not.toContain(secret);
      expect(JSON.stringify(result.data)).not.toContain(secret);
      expect(result.url).not.toContain(secret);
    }
    expect(result.output).toContain("[REDACTED]");
    expect(normalizeReviewSource(result).output).toBe(result.output);
  }
});
