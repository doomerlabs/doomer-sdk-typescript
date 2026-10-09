import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ModelReviewRequest, ReviewModel } from "../src/model.js";
import {
  type ModelRepositoryToolOptions,
  reviewWithRepositoryTools,
} from "../src/repository-model.js";

it.each(["complete", "partial"])(
  "broken diagnostic stderr preserves a %s review",
  async (status) => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
      if (String(line).includes('"event":"repository.')) {
        throw new Error("diagnostic sink unavailable");
      }
      return true;
    });
    try {
      const { result, finalCalls } = await fixture(undefined, {
        readDiagnostics: true,
        ...(status === "partial" ? { maxToolCalls: 1 } : {}),
      });
      expect(result.output).toEqual({ findings: [] });
      expect(result.retrieval?.coverage?.status).toBe(status);
      expect(finalCalls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  },
);

it("broken diagnostic stderr does not replace the original planning error", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdk-broken-diagnostic-"));
  const error = new Error("original provider error");
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {
    throw new Error("diagnostic sink unavailable");
  });
  const model: ReviewModel = {
    async review() {
      throw error;
    },
  };
  try {
    await expect(
      reviewWithRepositoryTools(model, root, {
        prompt: "Review",
        input: {},
        schema: { type: "object" },
        tools: { repository: { readDiagnostics: true } },
      }),
    ).rejects.toBe(error);
  } finally {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["provider error", "invalid plan"])(
  "finishes diagnostics when retrieval stops on %s",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "sdk-diagnostic-failure-"));
    const logs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
      logs.push(String(line));
      return true;
    });
    const error = new Error("provider failed");
    const model: ReviewModel = {
      async review<T>() {
        if (failure === "provider error") throw error;
        return { output: null as T };
      },
    };
    try {
      await expect(
        reviewWithRepositoryTools(model, root, {
          prompt: "Review",
          input: {},
          schema: { type: "object" },
          tools: { repository: { readDiagnostics: true } },
        }),
      ).rejects.toThrow();
      const records = logs
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.filter((record) => record.outcome === "finished")).toHaveLength(1);
      expect(records.at(-1)).toMatchObject({
        kind: "session",
        outcome: "finished",
        complete: false,
        rounds: 1,
      });
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["src/app/tags/[tag]/page.tsx", `${"a".repeat(160)}/${"b".repeat(110)}.ts`])(
  "logs requested and returned ranges for %s without logging source",
  async (path) => {
    const logs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
      logs.push(String(line));
      return true;
    });
    try {
      await fixture(
        [path],
        { readDiagnostics: true },
        { ready: true, operations: [] },
        "private source line\nsecond\nthird\n",
        "old\nsecond\nthird\n",
        false,
        path,
      );
      const records = logs
        .join("")
        .split("\n")
        .filter((line) => line.startsWith('{"event":"repository.read-detail"'))
        .map((line) => JSON.parse(line));
      const read = records.find((r) => r.tool === "read_file" && r.outcome === "succeeded");
      expect(read).toMatchObject({
        file: path,
        requestedStart: 1,
        requestedEnd: 3,
        returnedStart: 1,
        returnedEnd: 3,
        citation: "repo:read:1",
        retained: true,
        stopReason: "end_of_file",
      });
      expect(records.every((r) => r.readingId === read.readingId)).toBe(true);
      expect(records.at(-1)).toMatchObject({
        kind: "session",
        outcome: "finished",
        complete: true,
      });
      expect(logs.join("")).not.toContain("private source line");
    } finally {
      spy.mockRestore();
    }
  },
);

it("logs a past-end-of-file read with the requested range and a fixed error", async () => {
  const logs: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
    logs.push(String(line));
    return true;
  });
  try {
    await fixture(
      undefined,
      { readDiagnostics: true },
      {
        ready: false,
        operations: [
          { tool: "read_file", path: "source.ts", cursor: 0, startLine: 999, endLine: 1000 },
        ],
      },
    );
    const records = logs
      .join("")
      .split("\n")
      .filter((line) => line.startsWith('{"event":"repository.read-detail"'))
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: "operation",
        outcome: "failed",
        reason: "range_past_eof",
        requestedStart: 999,
        requestedEnd: 1000,
        citation: "",
      }),
    );
  } finally {
    spy.mockRestore();
  }
});

it("logs results discarded at the total text limit rather than claiming a retained read", async () => {
  const logs: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
    logs.push(String(line));
    return true;
  });
  try {
    await fixture(
      undefined,
      { readDiagnostics: true, maxTotalBytes: 4096, maxBytesPerRead: 64000 },
      { ready: true, operations: [] },
      "x".repeat(6000),
    );
    const records = logs
      .join("")
      .split("\n")
      .filter((line) => line.startsWith('{"event":"repository.read-detail"'))
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(
      expect.objectContaining({
        outcome: "discarded_limit",
        reason: "result_exceeds_total_byte_limit",
        file: "source.ts",
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: "gap",
        reason: "patch_discarded_byte_limit",
        file: "source.ts",
      }),
    );
    expect(records.at(-1)).toMatchObject({ kind: "session", complete: false });
    expect(logs.join("")).not.toContain("x".repeat(100));
  } finally {
    spy.mockRestore();
  }
});

async function fixture(
  changedFiles: string[] = ["source.ts"],
  options: ModelRepositoryToolOptions = {},
  firstPlan: unknown = { ready: true, operations: [] },
  source = "export const value = 'source evidence';\nsecond line\nthird line\n",
  baseSource = "export const value = 'old';\nsecond line\nthird line\n",
  modeOnly = false,
  sourcePath = "source.ts",
  baseRef: string | undefined = "HEAD",
  untracked = false,
  deleted = false,
) {
  const root = await mkdtemp(join(tmpdir(), "sdk-source-recovery-"));
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    await mkdir(join(root, sourcePath, ".."), { recursive: true });
    await writeFile(join(root, sourcePath), baseSource);
    execFileSync("git", ["-C", root, "add", sourcePath]);
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
    await writeFile(join(root, sourcePath), source);
    if (modeOnly) await chmod(join(root, "source.ts"), 0o755);
    await mkdir(join(root, "vendor"), { recursive: true });
    await writeFile(join(root, "vendor", "hidden.ts"), "excluded source");
    await symlink(join(root, "source.ts"), join(root, "link.ts"));
    if (untracked) {
      execFileSync("git", ["-C", root, "rm", "--cached", sourcePath]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "-qm",
        "remove source",
      ]);
    }
    if (deleted) await rm(join(root, sourcePath));
    const indexBefore = execFileSync("git", ["-C", root, "ls-files", "--stage"], {
      encoding: "utf8",
    });
    const requests: ModelReviewRequest[] = [];
    let planningCalls = 0;
    let finalCalls = 0;
    const model: ReviewModel = {
      async review<T>(request: ModelReviewRequest) {
        requests.push(request);
        const planning = request.prompt.startsWith("REPOSITORY RETRIEVAL CONTROLLER:");
        if (planning) planningCalls += 1;
        else finalCalls += 1;
        return {
          output: (planning
            ? planningCalls === 1
              ? firstPlan
              : { ready: true, operations: [] }
            : { findings: [] }) as T,
          provider: "fixture",
          model: "same-model",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const result = await reviewWithRepositoryTools(
      model,
      root,
      {
        prompt: "Review the change.",
        input: {},
        schema: {
          type: "object",
          required: ["findings"],
          properties: { findings: { type: "array" } },
        },
        tools: { repository: { maxRounds: 4, ...options } },
      },
      { baseRef, changedFiles, worktree: true },
      "fixture-reviewer",
    );
    expect(execFileSync("git", ["-C", root, "ls-files", "--stage"], { encoding: "utf8" })).toBe(
      indexBefore,
    );
    return { result, requests, planningCalls, finalCalls };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

it.each([true, false])(
  "recovers an empty plan (ready=%s) before the final review",
  async (ready) => {
    const { result, requests, planningCalls, finalCalls } = await fixture(undefined, undefined, {
      ready,
      operations: [],
    });
    expect(planningCalls).toBe(1);
    expect(requests[0]?.budget?.timeoutMs).toBe(600_000);
    expect(finalCalls).toBe(1);
    expect(result.retrieval).toMatchObject({
      filesRead: 1,
      toolCalls: 2,
      sourceReadRecoveries: 2,
      exhausted: false,
    });
    expect(result.citations?.[0].content).toContain("source evidence");
    expect(JSON.stringify(requests.at(-1)?.input)).toContain("repo:read:1");
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 2 });
  },
);

it("leaves fully covered source plans alone", async () => {
  const { result } = await fixture(undefined, undefined, {
    ready: false,
    operations: [
      { tool: "read_change", path: "source.ts", cursor: 0, startLine: 0, endLine: 0 },
      { tool: "read_file", path: "source.ts", cursor: 0, startLine: 1, endLine: 3 },
    ],
  });
  expect(result.retrieval?.sourceReadRecoveries).toBe(2);
  expect(result.citations?.[0].content).toContain("second line");
});

it("recovers a failed model-selected source window", async () => {
  const { result, planningCalls } = await fixture(undefined, undefined, {
    ready: false,
    operations: [
      { tool: "read_file", path: "source.ts", cursor: 0, startLine: 1000, endLine: 1010 },
    ],
  });
  expect(planningCalls).toBe(2);
  expect(result.retrieval).toMatchObject({ filesRead: 1, toolCalls: 3, sourceReadRecoveries: 2 });
});

it("keeps missing source, symlinks, and traversal as gaps without reading unsafe files", async () => {
  for (const path of ["missing.ts", "link.ts", "../secret.ts", "/secret.ts"]) {
    const { result, finalCalls } = await fixture([path]);
    expect(finalCalls).toBe(1);
    expect(result.citations).toEqual([]);
    expect(result.retrieval).toMatchObject({
      changedHunksCovered: false,
      coverage: { status: "partial", reasons: ["patch_read_failed"] },
    });
  }
});

it("recovers only in-scope changed files", async () => {
  const { result } = await fixture(["vendor/hidden.ts", "source.ts"], {
    exclude: ["**/vendor/**"],
  });
  expect(result.citations?.map((c) => c.path)).toEqual(["source.ts"]);
});

it("obeys existing line and tool limits", async () => {
  const { result } = await fixture(undefined, { maxLinesPerRead: 1, maxToolCalls: 4 });
  expect(result.retrieval).toMatchObject({ filesRead: 3, toolCalls: 4, exhausted: true });
  expect(result.citations?.every((c) => c.startLine === c.endLine)).toBe(true);
  const partial = await fixture(undefined, { maxToolCalls: 2, maxLinesPerRead: 1 });
  expect(partial.finalCalls).toBe(1);
  expect(partial.result.citations).toHaveLength(1);
  expect(partial.result.retrieval).toMatchObject({
    exhausted: true,
    changedHunksCovered: false,
    coverage: { status: "partial" },
  });
});

it("does not force source reads when there is no changed-file context", async () => {
  const { result, planningCalls } = await fixture([]);
  expect(planningCalls).toBe(1);
  expect(result.retrieval?.sourceReadRecoveries).toBeUndefined();
});

it("recovers a planner that repeats an already completed directory operation", async () => {
  const { result } = await fixture(undefined, undefined, {
    ready: false,
    operations: [{ tool: "list_directory", path: ".", cursor: 0, startLine: 0, endLine: 0 }],
  });
  expect(result.retrieval).toMatchObject({ filesRead: 1, sourceReadRecoveries: 2 });
});

it("preloads changed evidence independently of planning rounds and preserves byte limits", async () => {
  const complete = await fixture(undefined, { maxRounds: 1 });
  expect(complete.result.retrieval?.changedHunksCovered).toBe(true);
  const partial = await fixture(undefined, { maxTotalBytes: 4096 }, undefined, "x".repeat(6000));
  expect(partial.finalCalls).toBe(1);
  expect(partial.result.retrieval).toMatchObject({
    changedHunksCovered: false,
    exhausted: true,
    coverage: { status: "partial" },
  });
  expect(partial.result.retrieval?.bytes).toBeLessThanOrEqual(4096);
});

it("reads a changed line500 instead of satisfying recovery with unchanged prefixes", async () => {
  const prefix = Array.from({ length: 499 }, (_, i) => `// line ${i + 1}`).join("\n");
  const source = `${prefix}\nexport const value = 'changed500';\n`;
  const base = `${prefix}\nexport const value = 'old';\n`;
  const { result } = await fixture(undefined, {}, undefined, source, base);
  expect(
    result.citations?.some(
      (c) => c.startLine <= 500 && c.endLine >= 500 && c.content.includes("changed500"),
    ),
  ).toBe(true);
});

it("unrelated prefix citations cannot bypass patch or changed-line recovery", async () => {
  const prefix = "// unchanged\n".repeat(499);
  const { result } = await fixture(
    undefined,
    {},
    {
      ready: false,
      operations: [{ tool: "read_file", path: "source.ts", cursor: 0, startLine: 1, endLine: 200 }],
    },
    `${prefix}changed500\n`,
    `${prefix}old500\n`,
  );
  expect(result.retrieval?.sourceReadRecoveries).toBeGreaterThan(0);
  expect(
    result.citations?.some(
      (c) => c.startLine <= 500 && c.endLine >= 500 && c.content.includes("changed500"),
    ),
  ).toBe(true);
});

it("mode-only and binary patches complete without nonexistent text reads", async () => {
  const text = "export const value = 0;\n";
  const mode = await fixture(undefined, {}, undefined, text, text, true);
  expect(mode.result.retrieval).toMatchObject({ filesRead: 0, changedHunksCovered: true });
  const binary = await fixture(undefined, {}, undefined, "\0new", "\0old");
  expect(binary.result.retrieval).toMatchObject({ filesRead: 0, changedHunksCovered: true });
});

it.each(["docs/vendor/helm-install-release.md", "vendor/guide.md"])(
  "reads changed source and patches in a folder named vendor: %s",
  async (path) => {
    const { result, requests } = await fixture(
      [path],
      {},
      undefined,
      undefined,
      undefined,
      false,
      path,
    );
    expect(result.retrieval?.changedHunksCovered).toBe(true);
    expect(
      result.citations?.some((c) => c.path === path && c.content.includes("source evidence")),
    ).toBe(true);
    const input = requests.at(-1)?.input as {
      repository: { toolResults: Array<{ tool: string; path: string; content?: string }> };
    };
    expect(
      input.repository.toolResults.some(
        (r) =>
          r.tool === "read_change" && r.path === path && r.content?.includes("source evidence"),
      ),
    ).toBe(true);
  },
);

it.each([{ exclude: ["**/*.ts"] }, { include: ["**/*.go"] }])(
  "completes an entirely out-of-scope change: %j",
  async (options) => {
    const { result, planningCalls } = await fixture(["source.ts"], options);
    expect(planningCalls).toBe(1);
    expect(result.retrieval?.toolCalls).toBe(0);
  },
);

it("captures untracked worktree text without changing the index", async () => {
  const { result } = await fixture(
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    false,
    "source.ts",
    "HEAD",
    true,
  );
  expect(result.retrieval?.changedHunksCovered).toBe(true);
  expect(result.citations?.[0].content).toContain("source evidence");
});

it("rejects a missing base revision before asking the model to plan", async () => {
  const model: ReviewModel = { review: vi.fn() };
  await expect(
    reviewWithRepositoryTools(
      model,
      ".",
      {
        prompt: "review",
        input: {},
        schema: {},
        tools: { repository: {} },
      },
      { changedFiles: ["source.ts"], worktree: true },
    ),
  ).rejects.toMatchObject({ code: "invalid_model_request" });
  expect(model.review).not.toHaveBeenCalled();
});

it("reports files outside the 500-file summary as a gap without claiming full coverage", async () => {
  const { result, requests } = await fixture(
    ["source.ts", ...Array.from({ length: 499 }, (_, i) => `excluded-${i}.go`), "omitted.ts"],
    { include: ["**/*.ts"] },
  );
  expect(result.retrieval?.omittedChangedFiles).toBe(1);
  expect(result.retrieval?.changedHunksCovered).toBe(false);
  expect(JSON.stringify(requests.at(-1)?.input)).toContain('"omittedChangedFiles":1');
});

it("reports nonfatal coverage diagnostics without source or prompt content", async () => {
  const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const { result, requests, finalCalls } = await fixture(undefined, { maxToolCalls: 1 });
    expect(finalCalls).toBe(1);
    expect(result.retrieval?.coverage).toMatchObject({
      status: "partial",
      hunkCount: 1,
      coveredHunkCount: 0,
    });
    expect(JSON.stringify(requests.at(-1)?.input)).toContain('"status":"partial"');
    expect(requests.at(-1)?.prompt).toContain("never claim the entire change is clean");
    const output = log.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain('"stage":"repository_evidence_recovery"');
    expect(output).toContain('"event":"repository.coverage-gap"');
    expect(output).not.toMatch(/source evidence|Review the change|source\.ts/);
  } finally {
    log.mockRestore();
  }
});

it("accepts sixteen retrieval rounds but rejects an unbounded round budget", async () => {
  const { result } = await fixture(undefined, { maxRounds: 16 });
  expect(result.retrieval?.changedHunksCovered).toBe(true);
  await expect(fixture(undefined, { maxRounds: 17 })).rejects.toThrow(/tools.repository.maxRounds/);
});

it("finishes with explicit zero-source coverage and the same job identity", async () => {
  const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.stubEnv("HOSTED_REVIEW_JOB_ID", "fixture-zero-evidence-job");
  try {
    const { result, finalCalls } = await fixture(undefined, { maxRounds: 16, maxToolCalls: 1 });
    expect(finalCalls).toBe(1);
    expect(result.retrieval).toMatchObject({
      filesRead: 0,
      exhausted: true,
      changedHunksCovered: false,
      coverage: {
        status: "partial",
        reasons: expect.arrayContaining(["retrieval_budget_exhausted"]),
      },
    });
    const events = log.mock.calls
      .map(([value]) => String(value))
      .filter((value) => value.startsWith('{"event":"repository.coverage-gap"'))
      .map((value) => JSON.parse(value));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ job_id: "fixture-zero-evidence-job", sourceCount: 0 });
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});

// Reproduce the companion reviewer's 45 text files and eight separated hunks.
// The recorded production-head source replay lives in repository-job-replay.test.ts.
async function largeChangeFixture(
  maxRounds: number,
  finalRequests: ModelReviewRequest[],
  maxToolCalls = 128,
) {
  const root = await mkdtemp(join(tmpdir(), "sdk-large-change-budget-"));
  const paths = Array.from({ length: 45 }, (_, index) => `model_${index}.sql`);
  const hunkFile = paths.at(-1);
  const source = (value: number) =>
    `${Array.from({ length: 800 }, (_, index) =>
      index % 100 === 0 ? `select ${value} as value_${index};` : "-- unchanged",
    ).join("\n")}\n`;
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    for (const path of paths)
      await writeFile(join(root, path), path === hunkFile ? source(0) : "select 0;\n");
    execFileSync("git", ["-C", root, "add", ...paths]);
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
    for (const path of paths)
      await writeFile(join(root, path), path === hunkFile ? source(1) : "select 1;\n");
    const output = { findings: [{ title: "Existing verified finding" }] };
    const model: ReviewModel = {
      async review<T>(request: ModelReviewRequest) {
        const planning = request.prompt.startsWith("REPOSITORY RETRIEVAL CONTROLLER:");
        if (!planning) finalRequests.push(request);
        return {
          output: (planning ? { ready: true, operations: [] } : output) as T,
          provider: "fixture",
          model: "same-model",
        };
      },
    };
    const result = await reviewWithRepositoryTools(
      model,
      root,
      {
        prompt: "Review the change.",
        input: {},
        schema: {
          type: "object",
          required: ["findings"],
          properties: { findings: { type: "array" } },
        },
        tools: { repository: { maxRounds, maxToolCalls } },
      },
      { baseRef: "HEAD", changedFiles: paths, worktree: true },
      "large-change-reviewer",
    );
    return { result, output, paths };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

it("retains model findings and available citations when a large change exceeds the call budget", async () => {
  const finalRequests: ModelReviewRequest[] = [];
  const { result, output } = await largeChangeFixture(12, finalRequests, 64);
  expect(finalRequests).toHaveLength(1);
  expect(result.output).toEqual(output);
  expect(result.citations?.length).toBeGreaterThan(0);
  expect(result.retrieval).toMatchObject({
    toolCalls: 64,
    changedHunksCovered: false,
    exhausted: true,
    coverage: { status: "partial" },
  });
});

it("sixteen rounds cover all 45 files and eight separated hunks without altering findings", async () => {
  const finalRequests: ModelReviewRequest[] = [];
  const { result, output, paths } = await largeChangeFixture(16, finalRequests);
  expect(result.output).toEqual(output);
  expect(finalRequests).toHaveLength(1);
  expect(result.retrieval).toMatchObject({
    rounds: 1,
    toolCalls: 97,
    filesRead: 52,
    exhausted: false,
    changedHunksCovered: true,
  });
  expect(new Set(result.citations?.map((citation) => citation.path))).toEqual(new Set(paths));
  for (let line = 1; line <= 701; line += 100) {
    expect(
      result.citations?.some(
        (citation) =>
          citation.path === paths.at(-1) && citation.startLine <= line && citation.endLine >= line,
      ),
    ).toBe(true);
  }
});

it("gives the first planner changed evidence before exploratory lookups", async () => {
  const { result, requests } = await fixture(
    undefined,
    {},
    {
      ready: false,
      operations: [
        { tool: "read_file", path: "missing-support.ts", cursor: 0, startLine: 1, endLine: 10 },
      ],
    },
  );
  expect(JSON.stringify(requests[0].input)).toContain("source evidence");
  expect(result.retrieval?.coverage?.status).toBe("complete");
  expect(result.citations?.[0].path).toBe("source.ts");
  expect(JSON.stringify(requests.at(-1)?.input)).toContain("missing-support.ts");
});

it("retains valid source when another changed file is unavailable", async () => {
  const { result, finalCalls } = await fixture(["missing.ts", "source.ts"]);
  expect(finalCalls).toBe(1);
  expect(
    result.citations?.some((c) => c.path === "source.ts" && c.content.includes("source evidence")),
  ).toBe(true);
  expect(result.retrieval?.coverage).toMatchObject({
    status: "partial",
    reasons: ["patch_read_failed"],
  });
});

it("paginates the patch but keeps oversized source lines partial without retrying the final review", async () => {
  const { result, finalCalls } = await fixture(
    undefined,
    { maxBytesPerRead: 1024 },
    undefined,
    "x".repeat(6000),
  );
  expect(finalCalls).toBe(1);
  expect(result.citations).toEqual([]);
  expect(result.retrieval?.coverage).toMatchObject({
    status: "partial",
    reasons: ["source_window_not_covered", "source_line_byte_limit"],
  });
});

it("finishes when a changed file was deleted without inventing a head citation", async () => {
  const { result, finalCalls } = await fixture(
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    false,
    "source.ts",
    "HEAD",
    false,
    true,
  );
  expect(finalCalls).toBe(1);
  expect(result.citations).toEqual([]);
  expect(result.retrieval?.coverage).toMatchObject({
    status: "partial",
    reasons: ["patch_read_failed"],
  });
});

it("reports byte exhaustion when initial context fills the budget before any preload", async () => {
  const changedFiles = ["source.ts", `${"x".repeat(4100)}.go`];
  const summary = { tool: "change_summary", baseRef: "HEAD", changedFiles, worktree: true };
  const initialDirectory = {
    tool: "list_directory",
    path: ".",
    cursor: 0,
    nextCursor: -1,
    entries: [
      { path: "vendor", type: "directory" },
      { path: "source.ts", type: "file" },
    ],
  };
  const maxTotalBytes =
    Buffer.byteLength(JSON.stringify(summary)) +
    Buffer.byteLength(JSON.stringify(initialDirectory));
  const { result, requests, planningCalls, finalCalls } = await fixture(changedFiles, {
    maxTotalBytes,
    include: ["**/*.ts"],
  });
  expect(
    (
      requests.at(-1)?.input as { repository: { toolResults: unknown[] } }
    ).repository.toolResults.slice(0, 2),
  ).toEqual([summary, initialDirectory]);
  expect(planningCalls).toBe(0);
  expect(finalCalls).toBe(1);
  expect(result.retrieval).toMatchObject({
    bytes: maxTotalBytes,
    toolCalls: 0,
    exhausted: true,
    coverage: {
      status: "partial",
      reasons: expect.arrayContaining(["retrieval_budget_exhausted"]),
    },
  });
});

it("preserves an explicit shorter repository planning timeout", async () => {
  const { requests } = await fixture(undefined, { planningTimeoutMs: 1_234 });
  expect(requests[0]?.budget?.timeoutMs).toBe(1_234);
});

it("does not log free text supplied as a model operation path", async () => {
  const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await fixture(
      undefined,
      { readDiagnostics: true },
      {
        ready: false,
        operations: [
          { tool: "read_file", path: "private model text", cursor: 0, startLine: 1, endLine: 2 },
        ],
      },
    );
    const output = log.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("[unverified repository path]");
    expect(output).not.toContain("private model text");
    expect(output).toContain('"file":"source.ts"');
  } finally {
    log.mockRestore();
  }
});

it("classifies repository planning separately from the final review", async () => {
  const { requests, planningCalls, finalCalls } = await fixture();
  expect(planningCalls).toBeGreaterThan(0);
  expect(finalCalls).toBe(1);
  for (const request of requests) {
    expect(request.diagnosticStage).toBe(
      request.prompt.startsWith("REPOSITORY RETRIEVAL CONTROLLER:")
        ? "repository_planning"
        : "model_review",
    );
  }
});

it("recovers every UTF-8 patch page before checking hunks, including headers split across pages", async () => {
  const source = Array.from(
    { length: 600 },
    (_, i) => `export const value_${i} = '😀 changed ${i}';\n`,
  ).join("");
  const base = source.replaceAll("changed", "original");
  const { result, requests } = await fixture(
    undefined,
    { maxBytesPerRead: 4096, maxToolCalls: 128, maxTotalBytes: 640000 },
    undefined,
    source,
    base,
  );
  expect(result.retrieval?.coverage?.status).toBe("complete");
  const results = (
    requests.at(-1)?.input as {
      repository: {
        toolResults: { tool: string; content: string; cursor: number; nextCursor: number }[];
      };
    }
  ).repository.toolResults;
  const pages = results.filter((r) => r.tool === "read_change");
  expect(pages.length).toBeGreaterThan(2);
  expect(pages[0].cursor).toBe(0);
  expect(pages.at(-1)?.nextCursor).toBe(-1);
  for (let i = 1; i < pages.length; i++) expect(pages[i].cursor).toBe(pages[i - 1].nextCursor);
  const patch = pages.map((r) => r.content).join("");
  expect(patch).not.toContain("�");
  expect(patch).toContain("😀 changed 599");
  expect(result.citations?.some((r) => r.endLine === 600)).toBe(true);
});

it("a missing terminal patch page stays partial and names the call budget", async () => {
  const { result } = await fixture(
    undefined,
    { maxBytesPerRead: 1024, maxToolCalls: 1 },
    undefined,
    "long line".repeat(1000),
  );
  expect(result.retrieval?.coverage).toMatchObject({
    status: "partial",
    reasons: expect.arrayContaining(["patch_truncated", "tool_call_limit"]),
  });
  expect(result.retrieval?.limits?.maxToolCalls).toBe(1);
});

it("scopes a batch to runner-supplied paths without counting other batches as omitted", async () => {
  const { result, requests } = await fixture(["source.ts", "other.ts"], {
    changedFiles: ["source.ts"],
  });
  expect(result.retrieval?.coverage).toMatchObject({
    status: "complete",
    changedFiles: 1,
    omittedChangedFiles: 0,
  });
  const input = requests.at(-1)?.input as {
    repository: { toolResults: { tool: string; changedFiles: string[] }[] };
  };
  expect(
    input.repository.toolResults.find((r) => r.tool === "change_summary")?.changedFiles,
  ).toEqual(["source.ts"]);
});

it.each([
  { changedFiles: [] },
  { changedFiles: ["outside.ts"] },
  { changedFiles: ["source.ts", "source.ts"] },
])("rejects invalid batch scope %j", async ({ changedFiles }) => {
  await expect(fixture(undefined, { changedFiles })).rejects.toMatchObject({
    code: "invalid_model_request",
  });
});
