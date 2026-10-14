import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADVERSARY_RUN_PROTOCOL_VERSION,
  Adversary,
  Confidence,
  JsonRenderer,
  ModelReviewError,
  type ModelReviewRequest,
  type ReviewModel,
  type ReviewPosture,
  Severity,
  TerminalRenderer,
  createAdversaryRunEnvelope,
  defineRule,
  formatOpinion,
  formatOpinionAsync,
  isChangedLine,
  isOpinionConcernPhrase,
  log,
  normalizeChangeContext,
  normalizeConfidence,
  normalizeOpinionConcern,
  parseInput,
  rankFindings,
  requireOpinionConcern,
  resolveReviewPosture,
  ruleRegistry,
  writeOutput,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const originalEnv = {
  ADVERSARY_INCLUDE_SUPPRESSED: process.env.ADVERSARY_INCLUDE_SUPPRESSED,
  ADVERSARY_INPUT: process.env.ADVERSARY_INPUT,
  ADVERSARY_OUTPUT: process.env.ADVERSARY_OUTPUT,
  ADVERSARY_REPO: process.env.ADVERSARY_REPO,
  ADVERSARY_VERBOSE: process.env.ADVERSARY_VERBOSE,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.restoreAllMocks();
});

describe("input loading", () => {
  it("loads the source repo path from the runtime input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adversary-sdk-"));
    const inputPath = join(directory, "input.json");

    await writeFile(inputPath, JSON.stringify({ source: { path: "/repo" } }));

    await expect(parseInput(inputPath)).resolves.toEqual({
      source: {
        path: "/repo",
      },
    });
  });

  it("preserves the change block from the runtime input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adversary-sdk-"));
    const inputPath = join(directory, "input.json");
    const change = {
      type: "diff",
      base_ref: "origin/main",
      head_ref: "HEAD",
      scan_mode: "changed",
      changed_files: ["src/index.ts"],
    };

    await writeFile(inputPath, JSON.stringify({ source: { path: "/repo" }, change }));

    await expect(parseInput(inputPath)).resolves.toEqual({
      source: { path: "/repo" },
      change,
    });
  });

  it("accepts a null change block", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adversary-sdk-"));
    const inputPath = join(directory, "input.json");

    await writeFile(inputPath, JSON.stringify({ source: { path: "/repo" }, change: null }));

    await expect(parseInput(inputPath)).resolves.toEqual({
      source: { path: "/repo" },
      change: null,
    });
  });

  it("rejects a malformed change block", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adversary-sdk-"));
    const inputPath = join(directory, "input.json");

    await writeFile(
      inputPath,
      JSON.stringify({ source: { path: "/repo" }, change: { changed_files: "src/index.ts" } }),
    );

    await expect(parseInput(inputPath)).rejects.toThrow(
      "change.changed_files must be an array of strings",
    );
  });

  it("rejects changed files without a base revision at parse time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adversary-sdk-"));
    const inputPath = join(directory, "input.json");
    await writeFile(
      inputPath,
      JSON.stringify({ source: { path: "/repo" }, change: { changed_files: ["source.ts"] } }),
    );
    await expect(parseInput(inputPath)).rejects.toThrow(
      "change.base_ref is required for changed files",
    );
  });

  it("rejects an unsupported scan mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adversary-sdk-"));
    const inputPath = join(directory, "input.json");

    await writeFile(
      inputPath,
      JSON.stringify({ source: { path: "/repo" }, change: { scan_mode: "everything" } }),
    );

    await expect(parseInput(inputPath)).rejects.toThrow(
      'change.scan_mode must be "changed" or "all"',
    );
  });

  it.each([
    [{ path: "", startLine: 1, endLine: 2 }],
    [{ path: "src/index.ts", startLine: 0, endLine: 2 }],
    [{ path: "src/index.ts", startLine: 3, endLine: 2 }],
    [{ path: "src/index.ts", startLine: 1.5, endLine: 2 }],
  ])("rejects malformed changed ranges: %j", async (changedRanges) => {
    const directory = await mkdtemp(join(tmpdir(), "adversary-sdk-"));
    const inputPath = join(directory, "input.json");
    await writeFile(
      inputPath,
      JSON.stringify({ source: { path: "/repo" }, change: { changed_ranges: changedRanges } }),
    );

    await expect(parseInput(inputPath)).rejects.toThrow(
      "change.changed_ranges must contain valid path/startLine/endLine ranges",
    );
  });
});

describe("change context", () => {
  it("normalizes wire fields and defaults the scan mode to changed", () => {
    expect(
      normalizeChangeContext({
        type: "diff",
        base_ref: "origin/main",
        head_ref: "HEAD",
        changed_files: ["src/index.ts"],
        changed_ranges: [{ path: "src/index.ts", startLine: 12, endLine: 18 }],
      }),
    ).toEqual({
      type: "diff",
      baseRef: "origin/main",
      headRef: "HEAD",
      scanMode: "changed",
      changedFiles: ["src/index.ts"],
      changedRanges: [{ path: "src/index.ts", startLine: 12, endLine: 18 }],
      worktree: false,
    });
  });

  it("recognizes the WORKTREE sentinel and the all scan mode", () => {
    expect(
      normalizeChangeContext({ base_ref: "HEAD", head_ref: "WORKTREE", scan_mode: "all" }),
    ).toEqual({
      baseRef: "HEAD",
      headRef: "WORKTREE",
      scanMode: "all",
      changedFiles: [],
      changedRanges: [],
      worktree: true,
    });
  });

  it("returns null for an absent or null change", () => {
    expect(normalizeChangeContext(undefined)).toBeNull();
    expect(normalizeChangeContext(null)).toBeNull();
  });

  it("throws on an unsupported scan mode", () => {
    expect(() => normalizeChangeContext({ scan_mode: "everything" })).toThrow(
      'Unsupported change scan_mode "everything"',
    );
  });

  it("freezes the normalized change so rules cannot mutate the shared scope", () => {
    const change = normalizeChangeContext({
      scan_mode: "changed",
      changed_files: ["src/index.ts"],
    });

    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(change?.changedFiles)).toBe(true);
    expect(Object.isFrozen(change?.changedRanges)).toBe(true);
  });

  it("exposes the normalized change on the rule context", async () => {
    const app = new Adversary({ name: "adversarylabs/test" });
    app.rule("scope", (ctx) => {
      expect(ctx.change).toEqual({
        type: "diff",
        baseRef: "origin/main",
        headRef: "HEAD",
        scanMode: "changed",
        changedFiles: ["src/index.ts"],
        changedRanges: [],
        worktree: false,
      });
    });

    await app.run({
      input: {
        source: { path: process.cwd() },
        change: {
          type: "diff",
          base_ref: "origin/main",
          head_ref: "HEAD",
          scan_mode: "changed",
          changed_files: ["src/index.ts"],
        },
      },
    });
  });

  it("exposes a null change when the input has none", async () => {
    const app = new Adversary({ name: "adversarylabs/test" });
    app.rule("scope", (ctx) => {
      expect(ctx.change).toBeNull();
    });

    await app.run({ input: { source: { path: process.cwd() } } });
  });

  it("checks authoritative changed lines without rerunning Git", () => {
    const change = normalizeChangeContext({
      changed_files: ["src/index.ts"],
      changed_ranges: [{ path: "src/index.ts", startLine: 12, endLine: 18 }],
    });

    expect(isChangedLine(change, "./src/index.ts", 12)).toBe(true);
    expect(isChangedLine(change, "src/index.ts", 18)).toBe(true);
    expect(isChangedLine(change, "src/index.ts", 19)).toBe(false);
    expect(isChangedLine(null, "src/index.ts", 12)).toBe(false);
  });
});

describe("types", () => {
  it("serializes severity enum values as lowercase strings", () => {
    expect(Severity.Info).toBe("info");
    expect(Severity.Low).toBe("low");
    expect(Severity.Medium).toBe("medium");
    expect(Severity.High).toBe("high");
    expect(Severity.Critical).toBe("critical");
  });
});

describe("review posture and formatOpinion", () => {
  it("maps change scope to posture", () => {
    expect(resolveReviewPosture(null)).toBe("repository");
    expect(
      resolveReviewPosture(
        normalizeChangeContext({
          type: "diff",
          base_ref: "main",
          head_ref: "HEAD",
          scan_mode: "all",
          changed_files: ["a.go"],
        }),
      ),
    ).toBe("repository");
    expect(
      resolveReviewPosture(
        normalizeChangeContext({
          type: "diff",
          base_ref: "main",
          head_ref: "HEAD",
          scan_mode: "changed",
          changed_files: ["a.go"],
        }),
      ),
    ).toBe("change");
    expect(
      resolveReviewPosture(
        normalizeChangeContext({
          type: "diff",
          base_ref: "HEAD",
          head_ref: "WORKTREE",
          scan_mode: "changed",
          changed_files: ["a.go"],
        }),
      ),
    ).toBe("worktree");
  });

  it("normalizes clause titles for address sentences", () => {
    expect(normalizeOpinionConcern("Command code terminates the process directly")).toBe(
      "that the command code terminates the process directly",
    );
    expect(
      normalizeOpinionConcern("direct process termination below the application boundary"),
    ).toBe("direct process termination below the application boundary");
  });

  it("keeps verb-shaped noun phrases out of that-clause rewriting", () => {
    expect(normalizeOpinionConcern("memory leaks")).toBe("memory leaks");
    expect(normalizeOpinionConcern("stale reads")).toBe("stale reads");
    expect(normalizeOpinionConcern("concurrent writes")).toBe("concurrent writes");
    expect(formatOpinion({ ship: false, concern: "memory leaks", posture: "change" })).toEqual({
      ship: false,
      summary: "I would address memory leaks before merging.",
    });
  });

  it("rejects unsupported posture values at the public boundary", () => {
    expect(() =>
      formatOpinion({
        ship: true,
        // Callers in JavaScript can pass arbitrary strings.
        posture: "production" as ReviewPosture,
      }),
    ).toThrow(/posture must be one of repository, change, or worktree/);
  });

  it("frames blocking opinions by posture without hardcoding merge language in callers", () => {
    const concern = "direct process termination below the application boundary";

    expect(
      formatOpinion({
        ship: false,
        concern,
        change: null,
      }),
    ).toEqual({
      ship: false,
      summary:
        "I would address direct process termination below the application boundary before shipping.",
    });

    expect(
      formatOpinion({
        ship: false,
        concern,
        change: normalizeChangeContext({
          type: "diff",
          base_ref: "main",
          head_ref: "HEAD",
          scan_mode: "changed",
          changed_files: ["cmd/root.go"],
        }),
      }),
    ).toEqual({
      ship: false,
      summary:
        "I would address direct process termination below the application boundary before merging.",
    });

    expect(
      formatOpinion({
        ship: false,
        concern,
        change: normalizeChangeContext({
          type: "diff",
          base_ref: "HEAD",
          head_ref: "WORKTREE",
          scan_mode: "changed",
          changed_files: ["cmd/root.go"],
        }),
      }),
    ).toEqual({
      ship: false,
      summary:
        "I would address direct process termination below the application boundary before committing.",
    });
  });

  it("frames ship-with-follow-up opinions for change reviews", () => {
    expect(
      formatOpinion({
        ship: true,
        concern: "discarded command execution errors",
        posture: "change",
      }),
    ).toEqual({
      ship: true,
      summary:
        "I would merge this change and address discarded command execution errors as follow-up hardening.",
    });
  });

  it("frames plural remaining findings by posture", () => {
    expect(formatOpinion({ ship: false, remainingCount: 3, posture: "repository" })).toEqual({
      ship: false,
      summary: "I would address the remaining findings before shipping.",
    });
    expect(formatOpinion({ ship: false, remainingCount: 3, posture: "change" })).toEqual({
      ship: false,
      summary: "I would address the remaining findings before merging.",
    });
  });

  it("frames whole-target --all-files reviews as repository posture even when refs exist", () => {
    const opinion = formatOpinion({
      ship: false,
      concern: "direct process termination below the application boundary",
      change: normalizeChangeContext({
        type: "diff",
        base_ref: "main",
        head_ref: "HEAD",
        scan_mode: "all",
        changed_files: ["cmd/root.go"],
      }),
    });

    expect(opinion.summary).toBe(
      "I would address direct process termination below the application boundary before shipping.",
    );
    expect(opinion.summary).not.toContain("before merging");
  });

  it("requireOpinionConcern accepts noun phrases and rejects clauses", () => {
    expect(requireOpinionConcern("direct process termination below the application boundary")).toBe(
      "direct process termination below the application boundary",
    );
    expect(requireOpinionConcern("discarded command execution errors")).toBe(
      "discarded command execution errors",
    );
    expect(requireOpinionConcern("memory leaks")).toBe("memory leaks");
    expect(isOpinionConcernPhrase("forced exit code 124")).toBe(true);
    expect(isOpinionConcernPhrase("stdout/stderr contract violations")).toBe(true);
    // Comma-separated list noun phrases remain valid.
    expect(requireOpinionConcern("cancellation, exit codes, and stream contract issues")).toBe(
      "cancellation, exit codes, and stream contract issues",
    );

    expect(() => requireOpinionConcern("Command code terminates the process directly")).toThrow(
      /noun phrase/,
    );
    expect(() =>
      requireOpinionConcern(
        "commands replace inherited context with context.Background, breaking Ctrl+C",
      ),
    ).toThrow(/noun phrase|headline/);
    expect(() =>
      requireOpinionConcern("inherited context replacement, breaking Ctrl+C cancellation"),
    ).toThrow(/headline|noun phrase/);
    expect(() => requireOpinionConcern("defer os.Exit(124) forces exit code 124")).toThrow(
      /noun phrase/,
    );
    expect(isOpinionConcernPhrase("commands replace inherited context")).toBe(false);
    expect(isOpinionConcernPhrase("api get/post/patch/put silently no-op for v1 paths")).toBe(
      false,
    );
    expect(() =>
      requireOpinionConcern("api get/post/patch/put silently no-op for v1 paths"),
    ).toThrow(/headline|noun phrase/);
    expect(() => requireOpinionConcern("too long. with punctuation")).toThrow(
      /sentence|noun phrase/,
    );
    // Trailing terminal punctuation must not be stripped before rejection.
    expect(() => requireOpinionConcern("direct process termination.")).toThrow(
      /sentence|noun phrase/,
    );
    expect(() => requireOpinionConcern("memory leaks!")).toThrow(/sentence|noun phrase/);
    expect(isOpinionConcernPhrase("memory leaks.")).toBe(false);
    expect(() =>
      formatOpinion({ ship: false, concern: "commands replace inherited context" }),
    ).toThrow(/formatOpinion concern/);
  });

  it("formatOpinionAsync rewrites invalid concerns via the model", async () => {
    const requests: ModelReviewRequest[] = [];
    const model: ReviewModel = {
      async review<T>(request: ModelReviewRequest) {
        requests.push(request);
        return {
          output: { concern: "silent no-op v1 paths" } as T,
          provider: "fixture",
          model: "concern-rewriter",
        };
      },
    };

    const opinion = await formatOpinionAsync({
      ship: false,
      concern: "api get/post/patch/put silently no-op for v1 paths",
      posture: "repository",
      model,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.schema).toMatchObject({ required: ["concern"] });
    expect(opinion.summary).toBe("I would address silent no-op v1 paths before shipping.");
  });

  it.each([false, true])(
    "preserves ship=%s when both concern rewrites remain clauses",
    async (ship) => {
      const requests: ModelReviewRequest[] = [];
      const model: ReviewModel = {
        async review<T>(request: ModelReviewRequest) {
          requests.push(request);
          return {
            output: { concern: "commands replace inherited context" } as T,
            provider: "fixture",
            model: "concern-rewriter",
          };
        },
      };

      const opinion = await formatOpinionAsync({
        ship,
        concern: "commands replace inherited context",
        posture: "change",
        model,
      });

      expect(requests).toHaveLength(2);
      expect(opinion).toEqual(
        formatOpinion({ ship, concern: "the reported concern", posture: "change" }),
      );
      if (ship) expect(opinion.summary).toContain("follow-up");
      else expect(opinion.summary).toContain("before merging");
    },
  );

  it("does not hide provider failures during opinion rewriting", async () => {
    const error = new ModelReviewError("provider unavailable", { code: "provider_unavailable" });
    const model: ReviewModel = {
      async review() {
        throw error;
      },
    };
    await expect(
      formatOpinionAsync({
        ship: false,
        concern: "commands replace inherited context",
        posture: "change",
        model,
      }),
    ).rejects.toBe(error);
  });

  it("formatOpinionAsync skips the model when the concern is already valid", async () => {
    let called = false;
    const model: ReviewModel = {
      async review() {
        called = true;
        throw new Error("should not call model");
      },
    };

    const opinion = await formatOpinionAsync({
      ship: false,
      concern: "direct process termination below the application boundary",
      posture: "repository",
      model,
    });

    expect(called).toBe(false);
    expect(opinion.summary).toBe(
      "I would address direct process termination below the application boundary before shipping.",
    );
  });

  it("ctx.model.concern rewrites free-form text through the broker pass-through", async () => {
    const requests: ModelReviewRequest[] = [];
    const model: ReviewModel = {
      async review<T>(request: ModelReviewRequest) {
        requests.push(request);
        return {
          output: { concern: "broken command cancellation context" } as T,
          provider: "fixture",
          model: "concern-rewriter",
        };
      },
    };

    const app = new Adversary({ name: "adversarylabs/concern-test" });
    app.rule("rewrite", async (ctx) => {
      const result = await ctx.model.concern({
        text: "Commands discard inherited context, breaking Ctrl+C cancellation",
      });
      ctx.review.opinion(
        formatOpinion({
          ship: false,
          concern: result.concern,
          change: ctx.change,
        }),
      );
    });

    const output = await app.run({
      input: { source: { path: process.cwd() } },
      model,
    });

    expect(requests).toHaveLength(1);
    expect(output.opinion?.summary).toBe(
      "I would address broken command cancellation context before shipping.",
    );
  });
});

describe("Adversary", () => {
  it("registers rules and collects normalized findings", async () => {
    const app = new Adversary({ name: "adversarylabs/test" });

    app.rule("empty", () => undefined);
    app.rule("findings", (ctx) => {
      ctx.finding({
        ruleId: "single",
        title: "Single finding",
        category: "quality",
        severity: Severity.Low,
        confidence: "high",
        summary: "A normalized finding was reported.",
        evidence: [{ file: "src/index.ts", line: 1 }],
      });
      ctx.finding({
        ruleId: "second",
        title: "Second finding",
        category: "quality",
        severity: Severity.Medium,
        confidence: "medium",
        summary: "Another normalized finding was reported.",
        evidence: [{ file: "src/index.ts", line: 2 }],
      });
    });

    const output = await app.run({
      input: { source: { path: process.cwd() } },
    });

    expect(output.findings.map((finding) => finding.ruleId)).toEqual(["single", "second"]);
  });

  it("generates summary output and lets rules set summary fields", async () => {
    const app = new Adversary({ name: "adversarylabs/test" });

    app.rule("summary", (ctx) => {
      ctx.summary.files_scanned = 2;
    });

    const output = await app.run({
      input: { source: { path: process.cwd() } },
    });

    expect(output).toMatchObject({
      adversary: {
        name: "adversarylabs/test",
      },
      target: {
        filesScanned: 2,
      },
      findings: [],
    });
  });

  it("ranks collected findings deterministically", async () => {
    const app = new Adversary({ name: "adversarylabs/test" });

    app.rule("sort", (ctx) => {
      for (const [ruleId, file, line] of [
        ["b", "b.ts", 1],
        ["c", "a.ts", 2],
        ["a", "a.ts", 1],
      ] as const) {
        ctx.finding({
          ruleId,
          title: ruleId.toUpperCase(),
          category: "quality",
          severity: Severity.Low,
          confidence: "high",
          summary: `${ruleId} finding.`,
          evidence: [{ file, line }],
        });
      }
    });

    const output = await app.run({
      input: { source: { path: process.cwd() } },
    });

    expect(output.findings.map((finding) => finding.ruleId)).toEqual(["a", "b", "c"]);
  });

  it("writes output to disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adversary-sdk-"));
    const outputPath = join(directory, "output.json");
    const output = {
      protocolVersion: 1 as const,
      result: {
        adversary: { name: "adversarylabs/test" },
        target: { filesScanned: 1 },
        positives: [],
        observations: [],
        findings: [],
        suppressed: { observations: 0, findings: 0 },
      },
    };

    await writeOutput(output, outputPath);

    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(output);
  });

  it("creates protocol v1 run envelopes for runtime output", async () => {
    const result = {
      adversary: { name: "adversarylabs/test" },
      target: { repository: "/repo" },
      positives: [],
      observations: [],
      findings: [],
      suppressed: { observations: 0, findings: 0 },
    };

    expect(ADVERSARY_RUN_PROTOCOL_VERSION).toBe(1);
    const envelope = createAdversaryRunEnvelope(result);
    expect(envelope).toEqual({
      protocolVersion: 1,
      result,
    });
    expect(envelope.result).not.toHaveProperty("schemaVersion");
  });

  it("uses CLI environment defaults through the runtime adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adversary-sdk-env-"));
    const inputPath = join(directory, "input.json");
    const outputPath = join(directory, "output.json");
    const inputRepoPath = join(directory, "input-repo");
    const envRepoPath = join(directory, "env-repo");

    await writeFile(inputPath, JSON.stringify({ source: { path: inputRepoPath } }));

    process.env.ADVERSARY_INPUT = inputPath;
    process.env.ADVERSARY_OUTPUT = outputPath;
    process.env.ADVERSARY_REPO = envRepoPath;
    process.env.ADVERSARY_INCLUDE_SUPPRESSED = "true";

    const app = new Adversary({
      name: "adversarylabs/test",
      review: { maximumFindings: 1, minimumConfidence: "low" },
    });

    app.rule("env", (ctx) => {
      expect(ctx.repoPath).toBe(envRepoPath);
      ctx.finding({
        ruleId: "first",
        title: "First finding",
        category: "quality",
        severity: "low",
        confidence: "high",
        summary: "First finding.",
        evidence: [{ file: "a.ts", line: 1 }],
      });
      ctx.finding({
        ruleId: "second",
        title: "Second finding",
        category: "quality",
        severity: "low",
        confidence: "high",
        summary: "Second finding.",
        evidence: [{ file: "b.ts", line: 1 }],
      });
    });

    const result = await app.runFromEnvironment();
    const written = JSON.parse(await readFile(outputPath, "utf8"));

    expect(result.target.repository).toBe(envRepoPath);
    expect(result.findings).toHaveLength(1);
    expect(result.suppressed.findings).toBe(1);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(written).toEqual(createAdversaryRunEnvelope(result));
  });

  it("keeps programmatic runs independent of environment paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adversary-sdk-library-"));
    const ambientOutput = join(directory, "ambient-output.json");
    process.env.ADVERSARY_REPO = "/ambient-repo";
    process.env.ADVERSARY_OUTPUT = ambientOutput;

    const app = new Adversary({ name: "adversarylabs/test" });
    app.rule("repository", (ctx) => expect(ctx.repoPath).toBe("/explicit-repo"));

    const result = await app.run({ input: { source: { path: "/explicit-repo" } } });

    expect(result.target.repository).toBe("/explicit-repo");
    await expect(readFile(ambientOutput, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates review policies before execution", () => {
    expect(
      () =>
        new Adversary({
          name: "adversarylabs/test",
          review: { maximumFindings: -1 },
        }),
    ).toThrow('adversary "adversarylabs/test" review policy.maximumFindings');
  });

  it("omits timing by default and includes it only when requested", async () => {
    const app = new Adversary({ name: "adversarylabs/test" });
    const input = { source: { path: "/repo" } };

    expect((await app.run({ input })).timing).toBeUndefined();
    expect((await app.run({ input, includeTiming: true })).timing?.totalMs).toBeTypeOf("number");
  });

  it("exposes repo helpers on rule context", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "adversary-sdk-repo-"));
    await writeFile(join(repoPath, "index.ts"), "const value = 1;\n");
    await writeFile(join(repoPath, "README.md"), "# Test\n");

    const app = new Adversary({ name: "adversarylabs/test" });

    app.rule("helpers", async (ctx) => {
      expect(ctx.repoPath).toBe(repoPath);
      expect(ctx.relpath(join(repoPath, "index.ts"))).toBe("index.ts");
      expect(await ctx.glob("index.ts")).toEqual(["index.ts"]);
      expect(await ctx.rglob("*.md")).toEqual(["README.md"]);
    });

    await app.run({
      input: { source: { path: repoPath } },
    });
  });

  it("matches root-level and nested files with a `**/` prefix", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "adversary-sdk-glob-"));
    await writeFile(join(repoPath, "mold.yaml"), "name: root\n");
    await mkdir(join(repoPath, "ingots"), { recursive: true });
    await writeFile(join(repoPath, "ingots", "mold.yaml"), "name: nested\n");

    const app = new Adversary({ name: "adversarylabs/test" });

    app.rule("glob", async (ctx) => {
      // `**/` matches zero or more leading segments, so both the root-level and
      // the nested manifest are found.
      expect(await ctx.rglob("**/mold.yaml")).toEqual(["ingots/mold.yaml", "mold.yaml"]);
    });

    await app.run({ input: { source: { path: repoPath } } });
  });
});

describe("review pipeline", () => {
  it("converts numeric confidence using documented thresholds", () => {
    expect(normalizeConfidence(0.59)).toBe(Confidence.Low);
    expect(normalizeConfidence(0.6)).toBe(Confidence.Medium);
    expect(normalizeConfidence(0.84)).toBe(Confidence.Medium);
    expect(normalizeConfidence(0.85)).toBe(Confidence.High);
    expect(normalizeConfidence(0.7, { medium: 0.5, high: 0.7 })).toBe(Confidence.High);
  });

  it("groups three complete-sentence comment observations into one finding", async () => {
    const app = new Adversary({
      name: "comment-sentences",
      review: { includeInformational: true, minimumConfidence: "low" },
    });

    app.rule("comments.complete-sentence", (ctx) => {
      for (const [line, comment] of [
        [3, "This comment explains parser intent."],
        [11, "This comment explains fallback behavior."],
        [20, "This comment explains output formatting."],
      ] as const) {
        ctx.observe({
          ruleId: "comments.complete-sentence",
          subject: "src/index.ts",
          category: "code-style",
          severity: "info",
          confidence: 0.95,
          title: "Comments contain complete sentences",
          location: { file: "src/index.ts", line },
          evidence: {
            comment,
          },
          recommendation: {
            summary: "Use complete-sentence comments intentionally.",
          },
        });
      }
    });

    const output = await app.run({
      input: { source: { path: "/repo" } },
    });

    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]).toMatchObject({
      ruleId: "comments.complete-sentence",
      groupKey: "comments.complete-sentence:src/index.ts:code-style",
      category: "code-style",
      confidence: "high",
    });
    expect(output.findings[0]?.evidence.map((item) => item.location?.line)).toEqual([3, 11, 20]);
  });

  it("synthesizes grouped findings from declarative observation templates", async () => {
    const app = new Adversary({
      name: "declarative-review",
      review: { minimumConfidence: "low" },
    });

    app.rule("templates", (ctx) => {
      for (const [line, comment] of [
        [3, "// This parses command line arguments."],
        [11, "// This handles missing input safely."],
        [20, "// This writes normalized review output."],
      ] as const) {
        ctx.observe({
          ruleId: "comments.complete-sentence.template",
          title: {
            singular: "Comment is a complete sentence",
            plural: "Comments are complete sentences",
          },
          summary: {
            singular: "The comment at {location} is a complete sentence.",
            grouped: "{count} comments in {subject} are complete sentences.",
          },
          groupBy: ["ruleId", "subject"],
          subject: "src/index.ts",
          category: "maintainability",
          severity: "low",
          confidence: "high",
          location: {
            file: "src/index.ts",
            line,
          },
          evidence: {
            label: "complete sentence",
            snippet: comment,
          },
          whyItMatters:
            "Comments are most useful when they explain non-obvious intent instead of restating code.",
          impact: "Repeated prose can make otherwise straightforward code harder to scan.",
          recommendation: "Remove complete-sentence comments that restate nearby code.",
          remediation: {
            complexity: "trivial",
          },
        });
      }
    });

    const output = await app.run({ input: { source: { path: "/repo" } } });

    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]).toMatchObject({
      ruleId: "comments.complete-sentence.template",
      groupKey: "ruleId:comments.complete-sentence.template|subject:src/index.ts",
      title: "Comments are complete sentences",
      severity: "low",
      confidence: "high",
      summary: "Three comments in src/index.ts are complete sentences.",
      whyItMatters:
        "Comments are most useful when they explain non-obvious intent instead of restating code.",
      impact: "Repeated prose can make otherwise straightforward code harder to scan.",
      recommendation: "Remove complete-sentence comments that restate nearby code.",
      remediation: {
        complexity: "trivial",
      },
    });
    expect(output.findings[0]?.evidence.map((item) => item.message)).toEqual([
      "complete sentence",
      "complete sentence",
      "complete sentence",
    ]);
    expect(output.findings[0]?.evidence.map((item) => item.snippet)).toEqual([
      "// This parses command line arguments.",
      "// This handles missing input safely.",
      "// This writes normalized review output.",
    ]);
  });

  it("supports configurable grouped confidence and severity aggregation", async () => {
    const app = new Adversary({
      name: "aggregation-review",
      review: { minimumConfidence: "low" },
    });

    app.rule("aggregation", (ctx) => {
      for (const [line, severity, confidence] of [
        [1, "low", "high"],
        [2, "high", "low"],
      ] as const) {
        ctx.observe({
          ruleId: "example.aggregate",
          subject: "src/index.ts",
          groupBy: ["ruleId"],
          title: {
            singular: "Aggregated observation",
            plural: "Aggregated observations",
          },
          summary: {
            grouped: "{count} observations were aggregated.",
          },
          category: "quality",
          severity,
          severityAggregation: "lowest",
          confidence,
          confidenceAggregation: "minimum",
          location: { file: "src/index.ts", line },
          evidence: { label: `line ${line}` },
        });
      }
    });

    const output = await app.run({ input: { source: { path: "/repo" } } });

    expect(output.findings[0]).toMatchObject({
      title: "Aggregated observations",
      severity: "low",
      confidence: "low",
      summary: "Two observations were aggregated.",
    });
  });

  it("uses explicit groupKey and removes duplicate observations and evidence", async () => {
    const app = new Adversary({ name: "adversarylabs/test", review: { minimumConfidence: "low" } });

    app.rule("dup", (ctx) => {
      const observation = {
        ruleId: "r",
        subject: "a",
        groupKey: "custom-group",
        category: "quality",
        severity: Severity.Medium,
        confidence: "high" as const,
        title: "Repeated issue",
        location: { file: "a.ts", line: 1 },
        evidence: "same",
      };
      ctx.observe(observation);
      ctx.observe(observation);
    });

    const output = await app.run({ input: { source: { path: "/repo" } } });

    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]?.groupKey).toBe("custom-group");
    expect(output.findings[0]?.evidence).toHaveLength(1);
  });

  it("suppresses low-confidence and excess findings without discarding them", async () => {
    const app = new Adversary({
      name: "adversarylabs/test",
      review: { minimumConfidence: "medium", maximumFindings: 1 },
    });

    app.rule("findings", (ctx) => {
      ctx.finding({
        title: "Useful medium",
        category: "security",
        severity: "medium",
        confidence: "high",
        summary: "High-confidence medium issue.",
        evidence: [{ file: "a.ts", line: 1 }],
      });
      ctx.finding({
        title: "Speculative high",
        category: "security",
        severity: "high",
        confidence: "low",
        summary: "Low-confidence high issue.",
        evidence: [{ file: "b.ts", line: 1 }],
      });
      ctx.finding({
        title: "Second eligible",
        category: "security",
        severity: "low",
        confidence: "medium",
        summary: "Would exceed maximum findings.",
        evidence: [{ file: "c.ts", line: 1 }],
      });
    });

    const output = await app.run({
      input: { source: { path: "/repo" } },
      includeSuppressed: true,
    });

    expect(output.findings).toHaveLength(1);
    expect(output.suppressed.findings).toBe(2);
    expect(output.suppressedFindings).toHaveLength(2);
  });

  it("keeps distinct findings from one rule that share a category without a groupKey", async () => {
    const app = new Adversary({ name: "adversarylabs/test" });

    app.rule("manifests", (ctx) => {
      ctx.finding({
        ruleId: "manifests",
        title: "Missing version",
        category: "mold",
        severity: "medium",
        confidence: "high",
        summary: "a.yaml is missing version.",
        evidence: [{ file: "a.yaml", line: 1 }],
      });
      ctx.finding({
        ruleId: "manifests",
        title: "Missing name",
        category: "mold",
        severity: "medium",
        confidence: "high",
        summary: "b.yaml is missing name.",
        evidence: [{ file: "b.yaml", line: 1 }],
      });
    });

    const output = await app.run({ input: { source: { path: "/repo" } } });

    // Previously these collapsed into one finding because the dedupe id used
    // only ruleId + category.
    expect(output.findings).toHaveLength(2);
    expect(output.findings.map((finding) => finding.title).sort()).toEqual([
      "Missing name",
      "Missing version",
    ]);
  });

  it("captures completed findings, positives, review observations, assessment, and opinion", async () => {
    const app = new Adversary({
      name: "adversarylabs/test",
      review: { includeInformational: true },
    });

    app.rule("review", (ctx) => {
      ctx.review.assessment({ risk: "low", summary: "Well structured." });
      ctx.review.positive({
        key: "intentional-comments",
        summary: "Comments explain intent.",
        evidence: [{ file: "src/index.ts", line: 3 }],
      });
      ctx.review.positive({
        key: "intentional-comments",
        summary: "Comments explain intent.",
      });
      ctx.review.observe({
        key: "sentence-style",
        summary: "Some comments are complete sentences.",
      });
      ctx.review.opinion({ ship: true, summary: "I would ship this." });
      ctx.finding({
        title: "Comments contain complete sentences",
        category: "code-style",
        severity: "info",
        confidence: "high",
        summary: "A comment is written as a complete sentence.",
        whyItMatters: "Comments should add context.",
        impact: "Reviewers may spend time reading comments that restate code.",
        evidence: [{ file: "src/index.ts", line: 3, message: "Explains parser intent." }],
        recommendation: "Keep complete-sentence comments when they clarify intent.",
        remediation: { complexity: "trivial" },
      });
    });

    const output = await app.run({ input: { source: { path: "/repo" } } });

    expect(output.assessment?.risk).toBe("low");
    expect(output.positives).toHaveLength(1);
    expect(output.observations).toHaveLength(1);
    expect(output.opinion?.ship).toBe(true);
    expect(output.findings[0]?.whyItMatters).toBe("Comments should add context.");
  });

  it("uses stable note keys instead of domain vocabulary to deduplicate review notes", async () => {
    const app = new Adversary({ name: "comment-review" });
    app.rule("comments", (ctx) => {
      ctx.review.positive({
        key: "comments.behavior",
        summary: "Comments describe runtime behavior.",
      });
      ctx.review.observe({
        key: "comments.intent",
        summary: "Comments explain runtime intent.",
      });
    });

    const result = await app.run({ input: { source: { path: "/repo" } } });

    expect(result.positives).toHaveLength(1);
    expect(result.observations).toHaveLength(1);
  });

  it("keeps rule definitions isolated between adversary instances", async () => {
    const first = new Adversary({ name: "first", review: { minimumConfidence: "low" } });
    const second = new Adversary({ name: "second", review: { minimumConfidence: "low" } });
    const definition = (title: string) => ({
      id: "comments.isolated",
      category: "maintainability",
      defaultSeverity: "low" as const,
      defaultConfidence: "high" as const,
      aggregate: () => ({ title, summary: `${title}.` }),
    });

    first.defineRule(definition("First definition"));
    second.defineRule(definition("Second definition"));
    for (const app of [first, second]) {
      app.rule("comments", (ctx) => {
        ctx.observe({
          ruleId: "comments.isolated",
          subject: "src/index.ts",
          title: "Comment observation",
        });
      });
    }

    const [firstResult, secondResult] = await Promise.all(
      [first, second].map((app) => app.run({ input: { source: { path: "/repo" } } })),
    );

    expect(firstResult.findings[0]?.title).toBe("First definition");
    expect(secondResult.findings[0]?.title).toBe("Second definition");
  });

  it("rejects duplicate rule IDs and requires explicit replacement", async () => {
    const app = new Adversary({ name: "comment-review", review: { minimumConfidence: "low" } });
    const definition = (title: string) => ({
      id: "comments.replace",
      category: "maintainability",
      defaultSeverity: "low" as const,
      defaultConfidence: "high" as const,
      aggregate: () => ({ title, summary: `${title}.` }),
    });

    app.defineRule(definition("Initial definition"));
    expect(() => app.defineRule(definition("Duplicate definition"))).toThrow(
      'Rule definition "comments.replace" is already registered.',
    );
    app.replaceRule(definition("Replacement definition"));
    app.rule("comments", (ctx) => {
      ctx.observe({
        ruleId: "comments.replace",
        subject: "src/index.ts",
        title: "Comment observation",
      });
    });

    const result = await app.run({ input: { source: { path: "/repo" } } });
    expect(result.findings[0]?.title).toBe("Replacement definition");
  });

  it("renders terminal and JSON output", async () => {
    const app = new Adversary({
      name: "comment-sentences",
      review: { includeInformational: true },
    });
    app.rule("render", (ctx) => {
      ctx.review.assessment({ risk: "low", summary: "This is well structured." });
      ctx.review.opinion({
        ship: true,
        summary: "Comment sentence style does not block shipping.",
      });
      ctx.summary.files_scanned = 1;
      ctx.finding({
        title: "Comments contain complete sentences",
        category: "code-style",
        severity: "info",
        confidence: "high",
        summary: "A comment is written as a complete sentence.",
        evidence: [{ file: "src/index.ts", line: 3, message: "Explains parser intent." }],
        recommendation: "Keep complete-sentence comments when they clarify intent.",
        remediation: { complexity: "trivial" },
      });
    });
    const result = await app.run({ input: { source: { path: "/repo" } } });
    let terminal = "";
    let json = "";

    new TerminalRenderer((text) => {
      terminal += text;
    }).render(result);
    new JsonRenderer((text) => {
      json += text;
    }).render(result);

    expect(terminal).toContain("Overall assessment");
    expect(terminal).toContain("[info] Comments contain complete sentences");
    expect(terminal).not.toContain("Rules executed");
    expect(JSON.parse(json)).toEqual(createAdversaryRunEnvelope(result).result);
  });

  it("renders review-level scores, positives, observations, and tight opinion text", async () => {
    const app = new Adversary({
      name: "review-engine",
      review: { includeInformational: true },
    });

    app.rule("review", (ctx) => {
      ctx.review.assessment({
        risk: "low",
        summary: "The project is ready with one small improvement.",
      });
      ctx.review.score({
        key: "production-readiness",
        label: "Production readiness",
        score: 8.8,
        max: 10,
        summary: "Ready",
      });
      ctx.review.positive({
        key: "clear-layout",
        summary: "The implementation is easy to scan.",
      });
      ctx.review.observe({
        key: "comment-style",
        summary: "Some comments are complete sentences.",
      });
      ctx.review.opinion({
        ship: true,
        summary:
          "I would ship this as-is.\n\nComment cleanup is the only improvement I would recommend before production.",
      });
    });

    const result = await app.run({ input: { source: { path: "/repo" } } });
    let terminal = "";

    new TerminalRenderer((text) => {
      terminal += text;
    }).render(result);

    expect(terminal).toContain("Scores\n\nProduction readiness: 8.8 / 10 - Ready");
    expect(terminal).toContain("Positive signals\n\n- The implementation is easy to scan.");
    expect(terminal).toContain("Observations\n\n- Some comments are complete sentences.");
    expect(terminal).toContain(
      "Overall opinion\n\nI would ship this as-is. Comment cleanup is the only improvement I would recommend before production.",
    );
    expect(terminal).not.toContain("as-is.\n\nComment cleanup");
    expect(terminal).not.toContain("Scan complete");
    expect(terminal).not.toContain("Primary opportunity");
    expect(terminal).not.toContain("Additional observations");
  });

  it("renders synthesized structured evidence without leaking raw metadata", async () => {
    const app = new Adversary({
      name: "comment-review",
      review: { minimumConfidence: "low" },
    });

    const ruleId = "test.comments.complete-sentence.rendering";

    app.rule("complete-sentence-comments", (ctx) => {
      for (const [line, comment] of [
        [3, "// This parses command line arguments."],
        [11, "// This handles missing input safely."],
        [20, "// This writes normalized review output."],
      ] as const) {
        ctx.observe({
          ruleId,
          subject: "src/index.ts",
          category: "maintainability",
          severity: "low",
          confidence: "high",
          title: "Comment is a complete sentence",
          groupedTitle: "Comments are complete sentences",
          summary: "Three comments are written as complete sentences.",
          whyItMatters: "Sentence-style comments can repeat what nearby code already says.",
          impact: "No runtime impact, but repeated prose can make routine code harder to scan.",
          location: {
            file: "src/index.ts",
            line,
          },
          evidence: {
            comment,
            label: "complete sentence",
            parser: "line-comment",
            snippet: comment,
          },
          recommendation: {
            summary: "Keep complete-sentence comments only when they explain non-obvious intent.",
            details: "Remove comments that simply restate nearby code.",
          },
          remediation: {
            complexity: "trivial",
          },
        });
      }
    });

    const result = await app.run({ input: { source: { path: "/repo" } } });
    let terminal = "";

    new TerminalRenderer((text) => {
      terminal += text;
    }).render(result);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Comments are complete sentences");
    expect(result.findings[0]?.severity).toBe("low");
    expect(result.findings[0]?.confidence).toBe("high");
    expect(result.findings[0]?.summary).toBe("Three comments are written as complete sentences.");
    expect(result.findings[0]?.evidence.map((item) => item.message)).toEqual([
      "complete sentence",
      "complete sentence",
      "complete sentence",
    ]);
    expect(terminal).toContain("[low] Comments are complete sentences");
    expect(terminal).toContain("Category: maintainability");
    expect(terminal).toContain("Confidence: high");
    expect(terminal).toContain("Summary\n\nThree comments are written as complete sentences.");
    expect(terminal).toContain(
      "Why it matters\n\nSentence-style comments can repeat what nearby code already says.",
    );
    expect(terminal).toContain(
      "Impact\n\nNo runtime impact, but repeated prose can make routine code harder to scan.",
    );
    expect(terminal).toContain(
      "- src/index.ts:3 — complete sentence\n  // This parses command line arguments.",
    );
    expect(terminal).toContain(
      "- src/index.ts:11 — complete sentence\n  // This handles missing input safely.",
    );
    expect(terminal).toContain(
      "- src/index.ts:20 — complete sentence\n  // This writes normalized review output.",
    );
    expect(terminal).toContain(
      "Recommendation\n\nKeep complete-sentence comments only when they explain non-obvious intent. Remove comments that simply restate nearby code.",
    );
    expect(result.findings[0]?.remediation).toEqual({ complexity: "trivial" });
    expect(terminal.trimEnd().endsWith("Findings: 1")).toBe(true);
    expect(terminal).toContain("Findings (1)");
    expect(terminal).not.toContain('"comment"');
    expect(terminal).not.toContain("[{");
    expect(terminal).not.toContain("parser");
  });

  it("uses a registered rule aggregate instead of generic fallback", async () => {
    const ruleId = "test.comments.complete-sentence.aggregate";
    defineRule({
      id: ruleId,
      category: "maintainability",
      defaultSeverity: "low",
      groupBy: ["ruleId", "subject"],
      aggregate(observations) {
        return {
          title: "Comments are complete sentences",
          confidence: "high",
          summary: "Three comments are complete sentences.",
          whyItMatters: "Comments should clarify intent rather than restate straightforward code.",
          impact: "Repeated prose can slow review of routine code.",
          recommendation:
            "Keep complete-sentence comments only when they explain non-obvious intent.",
          remediation: {
            complexity: "trivial",
          },
          evidence: observations.map((observation) => ({
            file: observation.location?.file,
            line: observation.location?.line,
            message: "complete sentence",
            snippet:
              typeof observation.evidence === "object" && observation.evidence !== null
                ? String(observation.evidence.snippet)
                : undefined,
            data:
              typeof observation.evidence === "object" && observation.evidence !== null
                ? observation.evidence
                : undefined,
          })),
        };
      },
    });

    const app = new Adversary({
      name: "comment-review",
      review: { minimumConfidence: "low" },
    });

    expect(ruleRegistry.lookup(ruleId)?.id).toBe(ruleId);
    expect(ruleRegistry.has(ruleId)).toBe(true);

    app.rule("comments", (ctx) => {
      for (const [line, snippet] of [
        [3, "// This parses command line arguments."],
        [11, "// This handles missing input safely."],
        [20, "// This writes normalized review output."],
      ] as const) {
        ctx.observe({
          ruleId,
          subject: "src/index.ts",
          confidence: "medium",
          title: "Comment is a complete sentence",
          location: { file: "src/index.ts", line },
          evidence: { snippet, parser: "line-comment" },
        });
      }

      ctx.review.assessment({
        risk: "low",
        summary: "The code is easy to follow. The only suggestion is to trim repetitive comments.",
      });
      ctx.review.positive({
        key: "comments.focused",
        summary: "Comments are concentrated near the parsing flow.",
      });
      ctx.review.positive({
        key: "comments.intent",
        summary: "Intent-revealing comments are separated from implementation details.",
      });
      ctx.review.observe({
        key: "comments.focused",
        summary: "The same comment layout was also observed during scanning.",
      });
      ctx.review.opinion({
        ship: true,
        summary: "I would ship this as-is. Comment cleanup is the only improvement I would make.",
      });
    });

    const result = await app.run({ input: { source: { path: "/repo" } } });
    const finding = result.findings[0];

    expect(finding).toMatchObject({
      groupKey: `ruleId:${ruleId}|subject:src/index.ts`,
      title: "Comments are complete sentences",
      severity: "low",
      confidence: "high",
      summary: "Three comments are complete sentences.",
    });
    expect(finding?.evidence.map((item) => item.location?.line)).toEqual([3, 11, 20]);
    expect(result.assessment?.summary).toBe(
      "The code is easy to follow. The only suggestion is to trim repetitive comments.",
    );
    expect(result.assessment?.summary).not.toMatch(
      /SDK|structured observations|group|rank|synthesis/i,
    );
    expect(result.positives.map((item) => item.summary)).toEqual([
      "Comments are concentrated near the parsing flow.",
      "Intent-revealing comments are separated from implementation details.",
    ]);
    expect(result.observations).toHaveLength(0);
    expect(result.opinion?.summary).toBe(
      "I would ship this as-is. Comment cleanup is the only improvement I would make.",
    );
  });

  it("balances strengths and concerns in a synthesized assessment", async () => {
    const app = new Adversary({
      name: "assessment-review",
      review: { minimumConfidence: "low" },
    });

    app.rule("assessment", (ctx) => {
      ctx.review.positive({
        key: "focused-comments",
        summary: "Comments are concentrated near the parsing flow.",
      });
      ctx.finding({
        title: "Comments are complete sentences",
        category: "maintainability",
        severity: "low",
        confidence: "high",
        summary: "Three comments are complete sentences.",
        evidence: [{ file: "src/index.ts", line: 3 }],
      });
    });

    const result = await app.run({ input: { source: { path: "/repo" } } });

    expect(result.assessment?.summary).toBe(
      "Comments are concentrated near the parsing flow. The only material concern identified is that the three comments are complete sentences.",
    );
  });

  it("uses plural opinion text when multiple findings remain", async () => {
    const app = new Adversary({
      name: "multiple-finding-review",
      review: { minimumConfidence: "low" },
    });

    app.rule("multiple-findings", (ctx) => {
      ctx.finding({
        title: "Comments are complete sentences",
        category: "maintainability",
        severity: "low",
        confidence: "high",
        summary: "Three comments are complete sentences.",
        evidence: [{ file: "src/index.ts", line: 3 }],
        recommendation: "Remove complete-sentence comments that restate nearby code.",
      });
      ctx.finding({
        title: "Comments repeat implementation details",
        category: "maintainability",
        severity: "low",
        confidence: "high",
        summary: "Two comments repeat implementation details.",
        evidence: [{ file: "src/output.ts", line: 20 }],
      });
    });

    const result = await app.run({ input: { source: { path: "/repo" } } });

    expect(result.opinion?.summary).toMatchInlineSnapshot(
      `"I would address the remaining findings before shipping."`,
    );
  });

  it("uses concise opinion text when no findings remain", async () => {
    const app = new Adversary({ name: "empty-comment-review" });
    app.rule("comments", () => {});

    const result = await app.run({ input: { source: { path: "/repo" } } });

    expect(result.opinion?.summary).toMatchInlineSnapshot(`"I would ship this as-is."`);
  });

  it("synthesizes change-posture opinion language for scoped reviews", async () => {
    const app = new Adversary({
      name: "scoped-opinion",
      review: { minimumConfidence: "low" },
    });
    app.rule("findings", (ctx) => {
      ctx.finding({
        title: "Command code terminates the process directly",
        category: "correctness",
        severity: "high",
        confidence: "high",
        summary: "os.Exit is called below main.",
        evidence: [{ file: "cmd/root.go", line: 12 }],
        recommendation: "Return errors from command execution and map them in main.",
      });
    });

    const result = await app.run({
      input: {
        source: { path: "/repo" },
        change: {
          type: "diff",
          base_ref: "main",
          head_ref: "HEAD",
          scan_mode: "changed",
          changed_files: ["cmd/root.go"],
        },
      },
    });

    expect(result.opinion?.summary).toContain("before merging");
    expect(result.opinion?.summary).not.toContain("before shipping");
  });

  it("synthesizes worktree-posture opinion language for dirty reviews", async () => {
    const app = new Adversary({
      name: "worktree-opinion",
      review: { minimumConfidence: "low" },
    });
    app.rule("findings", (ctx) => {
      ctx.finding({
        title: "Command code terminates the process directly",
        category: "correctness",
        severity: "high",
        confidence: "high",
        summary: "os.Exit is called below main.",
        evidence: [{ file: "cmd/root.go", line: 12 }],
        recommendation: "Return errors from command execution and map them in main.",
      });
    });

    const result = await app.run({
      input: {
        source: { path: "/repo" },
        change: {
          type: "diff",
          base_ref: "HEAD",
          head_ref: "WORKTREE",
          scan_mode: "changed",
          changed_files: ["cmd/root.go"],
        },
      },
    });

    expect(result.opinion?.summary).toContain("before committing");
  });

  it("renders concise comment review text from final findings", async () => {
    const ruleId = "test.comments.complete-sentence.polished";
    defineRule({
      id: ruleId,
      category: "maintainability",
      defaultSeverity: "low",
      defaultConfidence: "high",
      groupBy: ["ruleId", "subject"],
      aggregate(observations) {
        return {
          title:
            observations.length === 1
              ? "Comment is a complete sentence"
              : "Comments are complete sentences",
          summary: "Three comments in src/index.ts are complete sentences.",
          whyItMatters:
            "Comments are most useful when they explain non-obvious intent instead of restating code.",
          impact: "Repeated prose can make otherwise straightforward code harder to scan.",
          evidence: observations.map((observation) => ({
            file: observation.location?.file,
            line: observation.location?.line,
            message: "complete sentence",
            snippet:
              typeof observation.evidence === "object" && observation.evidence !== null
                ? String(observation.evidence.snippet)
                : undefined,
            data:
              typeof observation.evidence === "object" && observation.evidence !== null
                ? observation.evidence
                : undefined,
          })),
          recommendation: "Remove complete-sentence comments that restate nearby code.",
          remediation: {
            complexity: "trivial",
          },
        };
      },
    });

    const app = new Adversary({
      name: "comment-review",
      review: { minimumConfidence: "low" },
    });

    app.rule("comments", (ctx) => {
      ctx.summary.files_scanned = 1;
      ctx.review.positive({
        key: "focused-comments",
        summary: "Comments are concentrated near the parsing flow.",
      });
      ctx.review.positive({
        key: "intent-comments",
        summary: "Intent-revealing comments are separated from implementation details.",
      });
      ctx.review.positive({
        key: "consistent-punctuation",
        summary: "Comment punctuation is consistent.",
      });
      ctx.review.observe({
        key: "focused-comments",
        summary: "The same comment layout was also observed during scanning.",
      });

      for (const [line, snippet] of [
        [3, "// This parses command line arguments."],
        [11, "// This handles missing input safely."],
        [20, "// This writes normalized review output."],
      ] as const) {
        ctx.observe({
          ruleId,
          subject: "src/index.ts",
          confidence: "medium",
          title: "Comment is a complete sentence",
          location: { file: "src/index.ts", line },
          evidence: {
            parser: "line-comment",
            snippet,
          },
        });
      }
    });

    const result = await app.run({ input: { source: { path: "/repo" } } });
    let terminal = "";
    new TerminalRenderer((text) => {
      terminal += text;
    }).render(result);

    expect(result.assessment?.risk).toBe("low");
    expect(result.assessment?.summary).toBe(
      "Comments are concentrated near the parsing flow. The only material concern identified is that the three comments in src/index.ts are complete sentences.",
    );
    expect(result.findings[0]?.confidence).toBe("high");
    expect(result.positives.map((item) => item.summary)).toEqual([
      "Comments are concentrated near the parsing flow.",
      "Intent-revealing comments are separated from implementation details.",
    ]);
    expect(result.observations).toHaveLength(0);
    expect(result.opinion?.summary).toBe(
      "I would ship this as-is. Removing complete-sentence comments that restate nearby code is the only improvement I would recommend before shipping.",
    );
    expect(terminal).not.toContain("Additional observations");
    expect(terminal).not.toContain("Primary opportunity");
    expect(terminal).not.toContain("Scan complete");
    expect(terminal).not.toMatch(/SDK|grouping|synthesis|rendering/i);
    expect(terminal).toMatchInlineSnapshot(`
      "Adversary: comment-review
      Repository: /repo
      Files scanned: 1

      Overall assessment

      Risk: Low

      Comments are concentrated near the parsing flow. The only material concern identified is that the three comments in src/index.ts are complete sentences.

      Findings (1)

      - [low] Comments are complete sentences (3 sites)

      [low] Comments are complete sentences
      src/index.ts:3

      Category: maintainability
      Confidence: high

      Summary

      Three comments in src/index.ts are complete sentences.

      Why it matters

      Comments are most useful when they explain non-obvious intent instead of restating code.

      Impact

      Repeated prose can make otherwise straightforward code harder to scan.

      Evidence

      - src/index.ts:3 — complete sentence
        // This parses command line arguments.
      - src/index.ts:11 — complete sentence
        // This handles missing input safely.
      - src/index.ts:20 — complete sentence
        // This writes normalized review output.

      Recommendation

      Remove complete-sentence comments that restate nearby code.

      Positive signals

      - Comments are concentrated near the parsing flow.
      - Intent-revealing comments are separated from implementation details.

      Overall opinion

      I would ship this as-is. Removing complete-sentence comments that restate nearby code is the only improvement I would recommend before shipping.

      Findings: 1
      "
    `);
  });

  it("demotes context observations and caps evidence in terminal output", async () => {
    const app = new Adversary({
      name: "go-cli",
      review: { minimumConfidence: "low" },
    });
    app.rule("lifecycle", (ctx) => {
      ctx.summary.files_scanned = 436;
      ctx.review.observe({
        key: "go-cli.analysis",
        summary: "Prepared 436 Go CLI files in repository review mode.",
      });
      ctx.review.observe({
        key: "prep",
        summary: "Internal prep note",
        metadata: { role: "context" },
      });
      ctx.review.observe({
        key: "stage-layout",
        summary: "Commands share a root error mapper.",
      });
      ctx.review.observe({
        key: "migration-lint",
        summary: "Prepared migration file has syntax errors.",
      });
      ctx.finding({
        title: "Command code terminates the process directly",
        category: "correctness",
        severity: "high",
        confidence: "high",
        summary: "Several paths call os.Exit.",
        evidence: Array.from({ length: 7 }, (_, index) => ({
          file: "cmd/root.go",
          line: index + 1,
          message: `site ${index + 1}`,
          snippet: "os.Exit(1)",
        })),
        recommendation: "Map errors in main.",
      });
    });

    const result = await app.run({
      input: { source: { path: "/Users/marc/go/src/github.com/replicatedhq/replicated" } },
    });
    let terminal = "";
    new TerminalRenderer((text) => {
      terminal += text;
    }).render(result);

    expect(terminal).toContain("Repository: replicatedhq/replicated");
    expect(terminal).toContain("Files scanned: 436");
    expect(terminal).toContain("- [high] Command code terminates the process directly (7 sites)");
    expect(terminal).toContain("- … and 2 more");
    expect(terminal).toContain("Commands share a root error mapper.");
    expect(terminal).toContain("Prepared migration file has syntax errors.");
    expect(terminal).not.toContain("Prepared 436 Go CLI files");
    expect(terminal).not.toContain("Internal prep note");
    expect(terminal).not.toContain("site 6");
    expect(terminal).not.toContain("Scan complete");
  });

  it("keeps suppressed finding details out of the active findings index and total", async () => {
    const app = new Adversary({
      name: "suppression-review",
      review: { minimumConfidence: "high", maximumFindings: 1 },
    });
    app.rule("findings", (ctx) => {
      ctx.finding({
        title: "Visible finding",
        category: "policy",
        severity: "high",
        confidence: "high",
        summary: "Active finding.",
        evidence: [{ file: "a.ts", line: 1 }],
      });
      ctx.finding({
        title: "Suppressed by maximum findings",
        category: "policy",
        severity: "medium",
        confidence: "high",
        summary: "Would be hidden without includeSuppressed.",
        evidence: [{ file: "b.ts", line: 2 }],
      });
    });

    const result = await app.run({
      input: { source: { path: "/repo" } },
      includeSuppressed: true,
    });
    let terminal = "";
    new TerminalRenderer((text) => {
      terminal += text;
    }).render(result);

    expect(result.findings).toHaveLength(1);
    expect(result.suppressedFindings?.length).toBeGreaterThan(0);
    expect(terminal).toContain("Findings (1)");
    expect(terminal).toContain("- [high] Visible finding");
    expect(terminal).toContain("Suppressed findings (1)");
    expect(terminal).toContain(
      "[medium; suppressed; reason unavailable] Suppressed by maximum findings",
    );
    expect(terminal).toContain("Findings: 1");
    expect(terminal).toContain("Suppressed findings: 1");

    const activeIndex = terminal.slice(
      terminal.indexOf("Findings (1)"),
      terminal.indexOf("Suppressed findings (1)"),
    );
    expect(activeIndex).toContain("- [high] Visible finding (1 site)");
    expect(activeIndex).not.toContain("Suppressed by maximum findings");
  });

  it("uses the rule aggregate through the built package process boundary", async () => {
    const ruleId = "test.comments.complete-sentence.process";
    const script = `
      import { Adversary } from ${JSON.stringify(
        new URL("../dist/index.js", import.meta.url).href,
      )};
      const ruleId = ${JSON.stringify(ruleId)};
      const app = new Adversary({ name: "comment-review", review: { minimumConfidence: "low" } });
      app.defineRule({
        id: ruleId,
        category: "maintainability",
        defaultSeverity: "low",
        aggregate(observations) {
          return {
            title: "Comments are complete sentences",
            confidence: "high",
            summary: "Three comments are complete sentences.",
            evidence: observations.map((observation) => ({
              file: observation.location?.file,
              line: observation.location?.line,
              message: "complete sentence",
              snippet: observation.evidence?.snippet,
              data: observation.evidence,
            })),
          };
        },
      });
      app.rule("comments", (ctx) => {
        for (const [line, snippet] of [[3, "// First complete sentence."], [11, "// Second complete sentence."], [20, "// Third complete sentence."]]) {
          ctx.observe({
            ruleId,
            subject: "src/index.ts",
            groupKey: \`\${ruleId}:src/index.ts\`,
            confidence: "medium",
            title: "Comment is a complete sentence",
            location: { file: "src/index.ts", line },
            evidence: { snippet },
          });
        }
      });
      const result = await app.run({ input: { source: { path: "/repo" } } });
      console.log(JSON.stringify({
        hasRule: app.hasRuleDefinition(ruleId),
        finding: result.findings[0],
      }));
    `;

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: join(import.meta.dirname, ".."),
      },
    );
    const parsed = JSON.parse(stdout);

    expect(parsed.hasRule).toBe(true);
    expect(parsed.finding.title).toBe("Comments are complete sentences");
    expect(parsed.finding.confidence).toBe("high");
    expect(parsed.finding.summary).toBe("Three comments are complete sentences.");
    expect(parsed.finding.evidence).toHaveLength(3);
  });

  it("ranks a high-confidence medium finding above a speculative high finding", () => {
    const ranked = rankFindings([
      {
        id: "speculative",
        title: "Speculative high",
        category: "security",
        severity: "high",
        confidence: "low",
        summary: "Maybe bad.",
        evidence: [{ file: "a.ts", line: 1 }],
      },
      {
        id: "useful",
        title: "Useful medium",
        category: "security",
        severity: "medium",
        confidence: "high",
        summary: "Clearly bad.",
        evidence: [{ file: "b.ts", line: 1 }],
      },
    ]);

    expect(ranked[0]?.id).toBe("useful");
  });

  it("preserves distinct direct findings when deduplication is disabled", async () => {
    const app = new Adversary({ name: "adversarylabs/test" });
    app.rule("direct-findings", (ctx) => {
      for (const [summary, recommendation, line] of [
        ["First explanation.", "Make the first change.", 1],
        ["Second explanation.", "Make the second change.", 2],
      ] as const) {
        ctx.finding({
          title: "Repeated title",
          category: "quality",
          severity: "low",
          confidence: "high",
          summary,
          recommendation,
          evidence: [{ file: "src/index.ts", line }],
          deduplicate: false,
        });
      }
    });

    const result = await app.run({ input: { source: { path: process.cwd() } } });

    expect(result.findings.map(({ summary }) => summary)).toEqual([
      "First explanation.",
      "Second explanation.",
    ]);
    expect(new Set(result.findings.map(({ id }) => id)).size).toBe(2);
  });

  it("normalizes legacy evidence into one canonical output shape", async () => {
    const app = new Adversary({ name: "adversarylabs/test" });
    app.rule("legacy-evidence", (ctx) => {
      ctx.finding({
        title: "Legacy evidence",
        category: "quality",
        severity: "low",
        confidence: "high",
        summary: "Legacy evidence is accepted at the collection boundary.",
        evidence: [{ file: "src/index.ts", line: 3, metadata: { parser: "comments" } }],
      });
    });

    const result = await app.run({ input: { source: { path: process.cwd() } } });

    expect(result.findings[0]?.evidence).toEqual([
      { location: { file: "src/index.ts", line: 3 }, data: { parser: "comments" } },
    ]);
  });
});

describe("logging", () => {
  it("suppresses debug and info logs unless verbose mode is enabled", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    process.env.ADVERSARY_VERBOSE = "";
    log.debug("hidden debug");
    log.info("hidden info");
    log.warn("visible warn");

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("[adversary] warn: visible warn\n");
  });

  it("prints debug and info logs when verbose mode is enabled", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    process.env.ADVERSARY_VERBOSE = "1";
    log.debug("visible debug");
    log.info("visible info");
    log.error("visible error");

    expect(write).toHaveBeenCalledWith("[adversary] debug: visible debug\n");
    expect(write).toHaveBeenCalledWith("[adversary] info: visible info\n");
    expect(write).toHaveBeenCalledWith("[adversary] error: visible error\n");
  });
});
