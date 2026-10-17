import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { Adversary, createAdversaryRunEnvelope, validateRunEnvelope } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("published run protocol", () => {
  it("validates a runtime envelope with the schema shipped in the npm tarball", async () => {
    const repositoryRoot = join(import.meta.dirname, "..");
    const packageDirectory = await mkdtemp(join(tmpdir(), "adversary-sdk-package-"));
    const consumerDirectory = await mkdtemp(join(tmpdir(), "adversary-sdk-consumer-"));
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", packageDirectory, "--json"],
      { cwd: repositoryRoot },
    );
    const packed = JSON.parse(stdout) as Array<{ filename: string }>;
    const tarball = join(packageDirectory, packed[0]?.filename ?? "missing.tgz");

    await execFileAsync(
      "npm",
      [
        "install",
        "--prefix",
        consumerDirectory,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { cwd: repositoryRoot },
    );

    const schemaPath = join(
      consumerDirectory,
      "node_modules",
      "@adversarylabs",
      "sdk",
      "schemas",
      "adversary.review.v1.schema.json",
    );
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const app = new Adversary({
      name: "adversarylabs/protocol-contract",
      version: "1.0.0",
      review: {
        includeInformational: true,
        minimumConfidence: "low",
        maximumFindings: 1,
      },
    });
    app.defineRule({
      id: "contract.observation",
      category: "contract",
      defaultSeverity: "medium",
      defaultConfidence: "high",
      aggregate(observations) {
        return {
          title: "Rich observations use canonical evidence",
          summary: `${observations.length} rich observations were aggregated.`,
          evidence: [
            {
              location: { file: "src/index.ts", line: 4 },
              endLine: 5,
              label: "parser evidence",
              data: { parser: "typescript", direct: true },
              snippet: "const app = new Adversary();",
            },
          ],
          recommendation: "Keep the wire contract canonical.",
        };
      },
    });
    app.rule("contract", (ctx) => {
      const observation = {
        ruleId: "contract.observation",
        subject: "src/index.ts",
        title: "Rich observation",
        location: { file: "src/index.ts", line: 4 },
        evidence: { parser: "typescript" },
      } as const;
      ctx.observe(observation);
      ctx.observe(observation);
      ctx.finding({
        ruleId: "contract.finding",
        title: "Protocol contract finding",
        category: "contract",
        severity: "low",
        confidence: "high",
        summary: "The packed schema validates this finding.",
        evidence: [{ file: "src/index.ts", line: 1, message: "contract evidence" }],
        recommendation: "Keep the runtime envelope and published schema aligned.",
      });
      ctx.review.score({
        key: "contract-readiness",
        label: "Contract readiness",
        score: 9,
        max: 10,
        summary: "Ready",
      });
    });

    const result = await app.run({
      input: { source: { path: repositoryRoot } },
      includeSuppressed: true,
    });
    const envelope = createAdversaryRunEnvelope(result);
    const validate = new Ajv2020({ allErrors: true }).compile(schema);

    expect(validate(envelope), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(envelope.protocolVersion).toBe(1);
    expect(envelope.result).not.toHaveProperty("schemaVersion");
    expect(envelope.result.suppressed).toEqual({ observations: 1, findings: 1 });
    expect(envelope.result.suppressedFindings).toHaveLength(1);
    expect(envelope.result.suppressed.findings).toBe(envelope.result.suppressedFindings?.length);
    expect(envelope.result.observations).toContainEqual({
      key: "score.contract-readiness",
      summary: "Contract readiness: 9 / 10 - Ready",
      metadata: {
        kind: "score",
        score: {
          key: "contract-readiness",
          label: "Contract readiness",
          score: 9,
          max: 10,
          summary: "Ready",
        },
      },
    });

    const evidence = envelope.result.findings[0]?.evidence[0];
    expect(evidence).toEqual({
      file: "src/index.ts",
      line: 4,
      endLine: 5,
      message: "parser evidence",
      snippet: "const app = new Adversary();",
      metadata: { parser: "typescript", direct: true },
    });
    expect(evidence).not.toHaveProperty("location");
    expect(evidence).not.toHaveProperty("data");
    expect(evidence).not.toHaveProperty("label");
    for (const finding of [
      ...envelope.result.findings,
      ...(envelope.result.suppressedFindings ?? []),
    ]) {
      expect(finding).not.toHaveProperty("synthesisSource");
      for (const item of finding.evidence) {
        expect(item).not.toHaveProperty("location");
        expect(item).not.toHaveProperty("data");
        expect(item).not.toHaveProperty("label");
      }
    }

    await expect(validateRunEnvelope(envelope)).resolves.toBeUndefined();
    const invalid = structuredClone(envelope) as unknown as Record<string, unknown>;
    (invalid.result as Record<string, unknown>).unknown = true;
    expect(validate(invalid)).toBe(false);
    await expect(validateRunEnvelope(invalid)).rejects.toThrow(
      "must NOT have additional properties",
    );
  }, 30_000);
});
