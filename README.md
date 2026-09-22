# adversary-sdk-typescript

Small TypeScript SDK for building file-based Adversaries.

The SDK owns the runtime boilerplate: read runtime input, discover the source repository path,
execute registered rules, collect observations, synthesize findings, normalize and rank the review,
and write runtime output.

## Install

```bash
npm install @adversarylabs/sdk@latest
```

Requires Node 22 or newer and ESM.

## Migrating from 0.1.4

SDK 0.1.4 output is incompatible with the current strict Doomer CLI schema. Version 0.1.5 is
the canonical protocol release. Existing adversaries should:

1. Upgrade the package to `@adversarylabs/sdk@^0.1.5`.
2. Set `findings.format` to `adversary.review.v1` in `adversary.yaml`.
3. Stop reading `result.schemaVersion`; protocol selection is expressed by `protocolVersion: 1`
   and the manifest format.
4. If consuming serialized evidence, read `file`, `line`, `endLine`, `message`, `snippet`, and
   `metadata` instead of `location`, `label`, and `data`.
5. If consuming review scores, read the canonical review observation with key `score.<score-key>`;
   the complete authored score is preserved in that note's metadata.

There is no compatibility adapter or dual wire format. Output is validated against the strict
`adversary.review.v1` schema before it is written.

## Author an adversary

```ts
import { Adversary, Severity, log } from "@adversarylabs/sdk";

const app = new Adversary({
  name: "adversarylabs/comment-sentences"
});

app.defineRule({
  id: "comments.complete-sentence",
  category: "code-style",
  defaultSeverity: Severity.Info,
  groupBy: ["ruleId", "subject"],
  aggregate(observations) {
    return {
      title:
        observations.length === 1
          ? "Comment is a complete sentence"
          : "Comments contain complete sentences",
      confidence: "high",
      summary: `${observations.length} comments are written as complete sentences.`,
      recommendation:
        "Keep complete-sentence comments only when they explain non-obvious intent."
    };
  }
});

app.rule("comments.complete-sentence", async (ctx) => {
  log.debug(`scanning ${ctx.repoPath}`);

  ctx.observe({
    ruleId: "comments.complete-sentence",
    subject: "src/index.ts",
    confidence: "high",
    title: "Comment is a complete sentence",
    location: {
      file: "src/index.ts",
      line: 2
    },
    evidence: "This comment is a complete sentence.",
    recommendation: "Use complete-sentence comments intentionally where they clarify non-obvious code."
  });
});

await app.runFromEnvironment();
```

## API

### `new Adversary(options)`

Creates an adversary app.

```ts
const app = new Adversary({
  name: "adversarylabs/example"
});
```

### `app.rule(ruleId, handler)`

Registers a rule. Rules report through `ctx.observe(...)`, `ctx.finding(...)`, and `ctx.review.*`.

Rule context exposes:

- `ctx.repoPath`
- `ctx.change`
- `ctx.summary`
- `ctx.cache`
- `ctx.relpath(path)`
- `ctx.glob(pattern)`
- `ctx.rglob(pattern)`
- `ctx.model.review(request)`
- `ctx.observe(observation)`
- `ctx.finding(finding)`
- `ctx.review.assessment(assessment)`
- `ctx.review.positive(note)`
- `ctx.review.observe(note)`
- `ctx.review.opinion(opinion)`

### `ctx.model.review(request)`

Model-backed adversaries provide their review prompt, bounded structured input, response schema,
and output budget. The SDK sends that request to the execution-scoped broker created by the
Doomer CLI and validates the structured answer before returning it:

```ts
const review = await ctx.model.review<{
  decision: "approve" | "request_changes";
  observations: Array<{ summary: string; evidenceIds: string[] }>;
}>({
  prompt: "Review the engineering quality of this change.",
  input: {
    change: ctx.change,
    evidence: preparedEvidence,
  },
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["decision", "observations"],
    properties: {
      decision: { enum: ["approve", "request_changes"] },
      observations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["summary", "evidenceIds"],
          properties: {
            summary: { type: "string" },
            evidenceIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
  budget: {
    maximumOutputTokens: 8_000,
    timeoutMs: 120_000,
  },
});
```

Adversaries may add semantic validation that cannot be expressed by JSON Schema. The adversary
owns the domain rule; the SDK owns bounded regeneration, feedback, timeout accounting, and usage
aggregation:

```ts
const review = await ctx.model.review<EngineeringReview>({
  prompt: ENGINEERING_REVIEW_PROMPT,
  input: preparedInput,
  schema: engineeringReviewSchema,
  validation: {
    maximumAttempts: 3,
    validate: ({ output, citations }) => {
      validateEngineeringReview(output, citations);
    },
  },
});
```

Throw from `validate` to reject an answer. The SDK sends that error back as trusted validation
feedback and retries only the final generation call. With repository tools, it reuses the already
retrieved evidence and citations. Exhaustion raises a non-retryable `ModelReviewError` with code
`model_validation_failed` so hosts do not restart the entire adversary review.

For repository-scale reviews, add bounded repository tools instead of placing source bodies in
`input`. The SDK asks the model which directories and line ranges it needs, performs those reads
inside the rule context's repository boundary, and then makes the final structured review call:

```ts
const review = await ctx.model.review<EngineeringReview>({
  prompt: ENGINEERING_REVIEW_PROMPT,
  input: {
    change: ctx.change,
    repositoryPurpose: "Go command-line adversary",
  },
  schema: engineeringReviewSchema,
  tools: {
    repository: {
      include: ["*.ts", "**/*.ts", "*.json"],
      exclude: ["fixtures/**", "generated/**"],
      maxRounds: 6,
      maxToolCalls: 24,
      maxTotalBytes: 256_000,
      maxBytesPerRead: 32_000,
      maxLinesPerRead: 400,
    },
  },
  budget: {
    maximumOutputTokens: 6_000,
    timeoutMs: 300_000,
  },
});
```

Repository retrieval provides paginated `list_directory` and line-range `read_file` operations.
Reads are repository-relative, read-only, symlink-safe, glob-constrained, and bounded by call,
round, line, and byte budgets. Each successful read creates an immutable citation:

```ts
review.citations?.[0];
// {
//   citationId: "repo:read:1",
//   path: "src/index.ts",
//   startLine: 20,
//   endLine: 80,
//   content: "..."
// }
```

The final model input contains the original value under `reviewInput` and the prepared tool
results under `repository.toolResults`. Final output schemas should cite the supplied
`citationId` and a line inside its inclusive range. The SDK never exposes arbitrary shell tools,
follows repository symlinks, or sends provider credentials into the adversary process.

Declare `permissions.model: true` in `adversary.yaml`. The adversary process receives only a
short-lived authenticated loopback broker endpoint. Provider credentials, provider selection,
network transport, retries, and provider-specific response handling remain owned by the CLI.

`app.run({ model })` accepts an injected `ReviewModel` for deterministic unit tests. Calling
`ctx.model.review(...)` without an injected model or CLI broker throws `ModelUnavailableError`;
the SDK never silently substitutes deterministic heuristics for model judgment.

### `ctx.change`

The requested review scope, normalized from the runtime input's `change` block. Honor it instead
of inferring scope from Git state: the runner has already resolved what should be reviewed.

- `null` — review the entire target; the runner provided no change context (for example
  `--all-files` with no refs, or a non-Git target).
- `scanMode: "all"` — review the entire target; change metadata is still available.
- `scanMode: "changed"` — review only the change from `baseRef` to `headRef`.

`changedFiles` lists the repository-relative paths the runner identified as changed. `worktree` is
true when the reviewed head is the uncommitted worktree (`headRef` is the `WORKTREE` sentinel,
exported as `WORKTREE_HEAD_REF`).

```ts
app.rule("scoped", async (ctx) => {
  if (ctx.change === null || ctx.change.scanMode === "all") {
    // Review every file in ctx.repoPath.
  } else {
    // Review only ctx.change.changedFiles against ctx.change.baseRef.
  }
});
```

### `ctx.repoGraph.semanticMatches(query)`

Use semantic matches for deterministic language rules that need type, scope, containment, or
operation-order information. The CLI parses and resolves code once; adversaries provide a
declarative sequence instead of implementing a source scanner.

```ts
const query = defineSemanticQuery({
  language: "go",
  within: "function",
  steps: [
    { kind: "call", capture: "guard", method: "Do", receiverType: "sync.Once" },
    { kind: "call", capture: "constructor", name: "connect", within: "guard" },
    { kind: "assignment", within: "guard", source: "constructor", operator: "=", sourceKind: "call", targets: [
      { capture: "value", scope: "package" },
      { capture: "failure", scope: "package", trait: "error" },
    ] },
    { kind: "return", after: "guard", outside: "guard", references: ["value", "failure"] },
  ],
});
const matches = ctx.repoGraph?.semanticMatches(query) ?? [];
```

Each result contains a stable `key`, source location, enclosing semantic unit, and captured
operations or bindings. `defineSemanticQuery` rejects unknown, duplicate, or type-incompatible
capture references when the adversary loads, so malformed query contracts cannot silently match
nothing. An assignment linked with `source` must not also be `after` that source: the direct RHS
call is nested inside the assignment and therefore starts later in source order. Rules remain
responsible for policy, severity, and finding language. `references` accepts one capture name or
an array when the same operation must reference every captured binding.
Use `outside` with an earlier captured call to require that an operation is not lexically nested
inside that call. Combined with `after`, this distinguishes an enclosing-function return after a
callback-bearing guard from a return inside the callback itself.
Binding `trait` constraints are adapter-neutral semantic categories. For example, a language
adapter may mark both an interface-typed failure and a concrete failure implementation with the
`error` trait, avoiding brittle exact type-name checks in adversaries.

### Opinion framing (`formatOpinion` / `formatOpinionAsync`)

Do not hardcode "before merging" (or similar decision language) in domain adversaries.
The runner already resolved the review posture; the SDK turns a ship decision and domain
concern into posture-aware prose:

| Posture | When | Deadline language |
| --- | --- | --- |
| `repository` | `change === null` or `scanMode: "all"` (for example `--all-files`) | before shipping |
| `change` | committed range (`scanMode: "changed"`, not worktree) | before merging |
| `worktree` | uncommitted local changes (`headRef` is `WORKTREE`) | before committing |

```ts
import { formatOpinion, formatOpinionAsync, requireOpinionConcern } from "@adversarylabs/sdk";

// Synchronous: concern must already be a noun phrase.
ctx.review.opinion(
  formatOpinion({
    ship: false,
    concern: "direct process termination below the application boundary",
    change: ctx.change,
  }),
);

// Async: free-form model titles/clauses are rewritten via the CLI model broker.
ctx.review.opinion(
  await formatOpinionAsync({
    ship: false,
    concern: "api get/post/patch/put silently no-op for v1 paths",
    change: ctx.change,
    model: ctx.model,
  }),
);

// Or rewrite only the concern, then format:
const { concern } = await ctx.model.concern({
  text: "Commands discard inherited context, breaking Ctrl+C",
});
// concern === "inherited context in command handlers" (example)

// Validate early when adapting model titles or free-form text:
requireOpinionConcern("forced exit code 124");
// throws: requireOpinionConcern("commands replace inherited context");
```

Helpers:

- `resolveReviewPosture(change)` — map `ctx.change` to `repository` | `change` | `worktree`
- `isOpinionConcernPhrase(concern)` — true when the string is a short noun phrase
- `requireOpinionConcern(concern)` — validate/normalize a noun phrase or throw
- `normalizeOpinionConcern(concern)` — lenient helper (may wrap clauses as `that …`); prefer
  `requireOpinionConcern` for overall opinions
- `formatOpinion({ ship, concern?, remainingCount?, change?, posture? })` — build `{ ship, summary }`;
  **rejects clause-shaped / headline concerns**
- `formatOpinionAsync({ ship, concern?, model, … })` — same framing; rewrites invalid concerns
  through the model broker (no call when the phrase is already valid)
- `rewriteOpinionConcern(model, { text })` / `ctx.model.concern({ text })` — pass-through rewrite
  only (structured schema + `requireOpinionConcern` validation, one retry by default)

When an adversary omits `ctx.review.opinion(...)`, the SDK synthesizes an opinion from residual
findings using the same posture rules.

**Ownership:** adversaries supply judgment (ship + concern draft); the SDK validates noun-phrase
shape, optionally rewrites invalid concerns via the CLI-owned model broker, and frames posture
language. The CLI prints `opinion.summary` and does not rewrite prose at render time.
Provider credentials remain in the CLI broker (`permissions.model: true`).

### `app.defineRule(definition)`

Registers domain-specific aggregation for a stable rule id. The SDK still owns grouping,
deduplication, ranking, suppression, and rendering; the rule definition supplies engineering
language for a grouped set of observations.

```ts
app.defineRule({
  id: "comments.complete-sentence",
  category: "code-style",
  defaultSeverity: "info",
  defaultConfidence: "high",
  groupBy: ["ruleId", "subject"],
  aggregate(observations) {
    return {
      title:
        observations.length === 1
          ? "Comment is a complete sentence"
          : "Comments contain complete sentences",
      confidence: "high",
      summary: `${observations.length} comments are written as complete sentences.`,
      whyItMatters:
        "Comments are most useful when they explain non-obvious intent rather than restating code.",
      recommendation:
        "Keep complete-sentence comments only when they explain non-obvious intent."
    };
  }
});
```

`category`, `defaultSeverity`, `defaultConfidence`, and `groupBy` act as defaults for observations
with the same `ruleId`. If a rule has no `aggregate(...)`, the SDK uses generic synthesis.

Definitions are scoped to one `Adversary`. Duplicate IDs throw; use `app.replaceRule(...)` when an
intentional replacement is required. The top-level `defineRule(...)` API remains temporarily
available for compatibility but is deprecated.

### `ctx.observe(input)`

Use observations for raw detector output and evidence. Observations are normalized, deduplicated,
grouped, synthesized, ranked, and rendered by the SDK. Prefer this path for new adversaries.

Default grouping uses:

```text
ruleId + subject + category
```

Rule definitions can override this with `groupBy`. Individual observations can still override the
issue boundary with `groupKey`:

```ts
ctx.observe({
  ruleId: "comments.complete-sentence",
  subject: "src/index.ts",
  groupKey: "complete-sentence-comments",
  category: "code-style",
  severity: "info",
  confidence: 0.95,
  title: "Comments contain complete sentences",
  location: { file: "src/index.ts", line: 3 },
  evidence: { comment: "This comment is a complete sentence." },
  recommendation: {
    summary: "Use complete-sentence comments intentionally where they clarify non-obvious code."
  }
});
```

Set `deduplicate: false` on a completed finding when separate findings intentionally share an
identity. The SDK otherwise merges findings with the same group key or generated ID.

### `ctx.finding(input)`

Use completed findings when the adversary has already synthesized the issue:

```ts
ctx.finding({
  title: "Comments contain complete sentences",
  category: "code-style",
  severity: "info",
  confidence: "high",
  summary: "Three comments are written as complete sentences.",
  whyItMatters: "Complete-sentence comments can be useful for intent, but noisy when they restate code.",
  impact: "Reviewers may spend time reading comments that do not add much context.",
  evidence: [
    { location: { file: "src/index.ts", line: 3 }, message: "Explains parser intent." },
    { location: { file: "src/index.ts", line: 11 }, message: "Explains fallback behavior." },
    { location: { file: "src/index.ts", line: 20 }, message: "Explains output formatting." }
  ],
  recommendation: "Keep complete-sentence comments only when they explain non-obvious intent.",
  remediation: { complexity: "trivial" }
});
```

Completed findings still pass through validation, deduplication, ranking, suppression, and
rendering.

`remediation.complexity` accepts `"trivial"`, `"small"`, `"medium"`, `"large"`, or
`"architectural"`. It remains available in structured output but is not rendered in the default
terminal review.

### Confidence

Confidence accepts `"low"`, `"medium"`, `"high"`, or a number from `0` to `1`.

Default numeric thresholds:

- `low`: less than `0.60`
- `medium`: `0.60` through `0.84`
- `high`: `0.85` and above

Customize thresholds with `new Adversary({ review: { confidenceThresholds } })`.

### Severity

The SDK uses severity as a review calibration signal, not just a detector label.

- `info`: interesting observations.
- `low`: reasonable engineering improvements.
- `medium`: issues likely to create operational problems.
- `high`: security, correctness, or reliability risks.
- `critical`: immediate production risk.

Override calibration when needed:

```ts
new Adversary({
  name: "adversarylabs/example",
  review: {
    severityOverrides: {
      "rule.id": "medium"
    }
  }
});
```

### Suppression and Ranking

Review policy controls human-readable output:

```ts
new Adversary({
  name: "adversarylabs/comment-sentences",
  review: {
    minimumConfidence: "medium",
    maximumFindings: 5,
    includeInformational: false
  }
});
```

By default, low-confidence and informational findings are suppressed from the primary review.
Suppressed findings are counted and can be included with `run({ includeSuppressed: true })`.
Raw observations can be included with `run({ includeRawObservations: true })`.

Ranking is deterministic and considers severity, confidence, affected evidence count, runtime or
production tags, and qualitative remediation complexity. It is not severity-only; a high-confidence
medium issue can rank above a speculative high-severity issue.

### Review Notes

Use review-level APIs for concise summaries that are not findings:

```ts
ctx.review.assessment({
  risk: "none",
  summary: "This review only reports complete-sentence comments."
});

ctx.review.positive({
  key: "intentional-comments",
  summary: "Several comments explain intent rather than restating implementation.",
  evidence: [{ location: { file: "src/index.ts", line: 3 } }]
});

ctx.review.observe({
  key: "sentence-style",
  summary: "Some comments are written as complete sentences."
});

ctx.review.opinion(
  formatOpinion({
    ship: true,
    concern: "comment sentence style cleanup",
    change: ctx.change,
  }),
);
// Or set a fully custom summary when domain voice must differ:
// ctx.review.opinion({ ship: true, summary: "Comment sentence style does not block shipping." });

ctx.review.score({
  key: "production-readiness",
  label: "Production readiness",
  score: 8.8,
  max: 10,
  summary: "Ready"
});
```

Scores are optional and remain available as an authoring API and terminal section. Because the CLI
schema has no top-level score collection, the SDK serializes each score as a review
observation. The note key is `score.<score-key>`, its summary is the rendered score, and its metadata
preserves the authored `key`, `label`, `score`, `max`, and `summary`. No score data is discarded.

### Observation-First Authoring

Prefer `ctx.observe(...)` for new adversaries. The intended flow is:

```text
observe -> group -> synthesize -> rank -> review
```

Adversaries should describe what they observed, where it happened, and why it matters. The SDK
should decide how observations group, which findings survive suppression, how they are ranked, and
how they are presented.

Use `ctx.finding(...)` when the adversary has already done issue synthesis itself.

### `log`

`log.debug()` and `log.info()` print only when `ADVERSARY_VERBOSE` is enabled with `1`, `true`,
`TRUE`, `yes`, or `YES`. `log.warn()` and `log.error()` always print. Logs go to stderr as:

```text
[adversary] level: message
```

## Review Result

`app.run({ input })` is the side-effect-free library API and returns one normalized review object.
Container and CLI entry points should call `app.runFromEnvironment()`, which reads the runtime
environment and writes the run envelope to the configured output path.

```ts
type ReviewResult = {
  adversary: { name: string; version?: string };
  target: { repository?: string; filesScanned?: number };
  assessment?: { risk: "none" | "low" | "medium" | "high" | "critical"; summary?: string };
  positives: ReviewNote[];
  observations: ReviewNote[];
  findings: ReviewFinding[];
  opinion?: { ship?: boolean; summary: string };
  suppressed: { observations: number; findings: number };
  timing?: { totalMs?: number };
};
```

Renderers consume this result. The SDK includes `TerminalRenderer` and `JsonRenderer`:

```ts
const result = await app.run({ input: { source: { path: "/repo" } } });
new TerminalRenderer().render(result);
new JsonRenderer().render(result);
```

`TerminalRenderer` uses the same product layout as the adversary CLI text
report: header (adversary, shortened repository, files scanned) → overall
assessment → finding index → finding detail (evidence capped) → suppressed
findings (when requested) → positives → scores → observations → overall
opinion → findings footer. Active `Findings: N` counts only non-suppressed
findings; suppressed details use a separate section and footer count.
Prep/context notes (keys ending in `.analysis` or `metadata.role: "context"`)
are omitted from the Observations section. JSON output remains the full
structured result.

Adversary implementations should not manually format review output.

### Canonical wire evidence

The authoring API continues to accept nested `location`, structured `data`, and `label`. Envelope
serialization translates those fields without losing their meaning:

| Authoring field | Canonical wire field |
| --- | --- |
| `location.file` | `file` |
| `location.line` | `line` |
| `location.endLine` | `endLine` |
| `data` | `metadata` |
| `label` when `message` is absent | `message` |

Wire evidence never contains `location`, `data`, or `label`. Findings likewise never contain SDK
diagnostic fields such as `synthesisSource`.

## Comment Sentence Example

`adversary.yaml`:

```yaml
name: comment-sentences
version: 0.1.0
description: Reports TypeScript comments that are written as complete sentences.

triggers:
  manual: true
  files_changed:
    - "*.ts"
    - "**/*.ts"

detection:
  files:
    - "*.ts"
    - "**/*.ts"

runtime:
  name: node
  version: "22"
  command:
    - dist/index.js

permissions:
  filesystem:
    read:
      - .
    write:
      - .adversary/results
  network: false
  environment:
    allow: []

findings:
  format: adversary.review.v1
```

### Composition (`uses`)

Persona packs and language packs can **compose** other adversaries. Declare
`uses` so a single CLI entrypoint expands to specialists:

```yaml
name: lang/go
version: 0.0.7
description: Go language pack — specialists under one entrypoint.

uses:
  - name: go/concurrency
  - name: go/security
    version: "0.0.13"   # optional exact tag only (no ^/~ ranges yet)
  - path: ../local-specialist   # package-relative; mutually exclusive with name

runtime:
  name: node
  version: "22"
  command: [dist/index.js]

findings:
  format: adversary.review.v1
```

```yaml
# Persona: voice + depth
name: local/torvalds-adversary
uses:
  - name: lang/go                 # may expand further (transitive)
  - name: review/engineering
  - name: review/complexity
  - name: security/secrets
# … runtime, agent/voice.md for GitHub rewrite voice …
```

| Concern | Owner |
|---------|--------|
| Detection depth | Each package in `uses` (and the root if it has rules) |
| GitHub comment **voice** | The **CLI entry** package (`agent/voice.md` + section banks), not members |
| Expansion | CLI (`doomer run <entry>`); transitive, deduped, depth-capped |
| Skip expansion | `doomer run <entry> --no-compose` |

Rules for each `uses` item:

- Exactly one of `name` or `path`
- `version` only with `name`, and only an **exact** tag
- Relative `path` is resolved from the declaring package root

The SDK **models and validates** `uses` (schema + `AdversaryManifest.uses`). The
CLI **expands** composition at run time. See the CLI doc
[`docs/composition.md`](https://github.com/doomerlabs/doomer/blob/main/docs/composition.md)
when that lands on main.

### Comment voice (`agent/voice.md`)

GitHub PR comment wording is **not** owned by the TypeScript rule runtime. The
CLI loads package voice markdown when you pass `--github-review` and rewrites
finding bodies with a model (or keeps a template body without credentials).

Typical package files:

```text
agent/voice.md                 # core persona + example few-shot bank
agent/scope.md                 # mission / train scope (separate from voice)
```

`agent/voice.md` should include:

1. **Core voice** — cadence, structure, bans, length
2. **`## Example maintainer comments (style only)`** — real human quotes under
   Ship / Design / Defects / Nits subsections (style few-shots only; never
   hard-code those strings as finding titles in `src/`)
3. **Output** — return only the PR comment body

Rewrite rules (CLI preamble): match spirit, re-ground in current evidence, never
copy a banked quote unchanged. Technical depth still comes from finding
title/summary/evidence produced by rules (or composed specialists).

With composition, put persona voice on the **entry** package you run; members
detect, the entry package sounds. Full CLI guide:
[`docs/voice.md`](https://github.com/doomerlabs/doomer/blob/main/docs/voice.md).

### Train (home-built packages)

Improve **your** local packages from your team’s PR review history with the CLI
(not an SDK API):

```sh
cd my-adversary
doomer train init --single-package
# edit adversary.train.yaml — sources (org/repos or authors_only), official jury
doomer train run
doomer train results ls
doomer train results apply <id>
```

- Only **local** packages receive drafts; optional **official** packages are a
  read-only jury (so you do not re-implement the catalog).
- Apply writes `docs/train-drafts/` and can open an agent-ready GitHub issue.
- Human gold: implement detection for the *class*, and bank short excerpts in
  `agent/voice.md` (style only)—never hard-code quotes in `src/`.
- Keep `agent/scope.md` / `docs/scope.md` accurate so train knows what is a fair miss.

Guide: [`docs/train.md`](https://github.com/doomerlabs/doomer/blob/main/docs/train.md).

### Automatic detection

The SDK owns the canonical `adversary.yaml` model, parser, validation, and published JSON schema.
The CLI uses the parsed optional `detection` section when deciding which installed adversaries are
relevant to `adversary auto`. Composition (`uses`) is not expanded during automatic selection yet.

Use declarative file detection when changed repository-relative paths are sufficient:

```yaml
detection:
  files:
    - Dockerfile
    - "**/Dockerfile"
    - .dockerignore
```

Use a detector entrypoint when applicability requires lightweight repository or change inspection:

```yaml
detection:
  entrypoint: dist/detect.js
```

Both forms may be declared together. The entrypoint is validated as a portable project-relative
path, but its build output does not need to exist while the manifest is parsed. Detector execution
and matching behavior belong to the CLI/runtime and are not implemented by this SDK feature.

Use `parseAdversaryManifest(...)` to parse YAML or `validateAdversaryManifest(...)` to validate an
already-decoded value. The resulting `AdversaryManifest` exposes `detection` directly, so consumers
never need to re-read raw YAML. The schema is published as
`@adversarylabs/sdk/schemas/adversary.manifest.v1`.

`src/index.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Adversary } from "@adversarylabs/sdk";

const app = new Adversary({
  name: "adversarylabs/comment-sentences",
  review: {
    minimumConfidence: "medium"
  }
});

app.defineRule({
  id: "comments.complete-sentence",
  category: "code-style",
  defaultSeverity: "info",
  defaultConfidence: "high",
  groupBy: ["ruleId", "subject"],
  aggregate(observations) {
    return {
      title:
        observations.length === 1
          ? "Comment is a complete sentence"
          : "Comments contain complete sentences",
      confidence: "high",
      summary: `${observations.length} comments in ${observations[0]?.subject ?? "the file"} are written as complete sentences.`,
      whyItMatters:
        "Comments are most useful when they explain non-obvious intent rather than restating code.",
      impact: "Repeated prose can make routine code harder to scan during review.",
      evidence: observations.map((observation) => ({
        location: {
          file: observation.location?.file,
          line: observation.location?.line
        },
        message: "complete sentence",
        snippet:
          typeof observation.evidence === "object" && observation.evidence !== null
            ? String(observation.evidence.comment)
            : undefined,
        data:
          typeof observation.evidence === "object" && observation.evidence !== null
            ? observation.evidence
            : undefined
      })),
      recommendation:
        "Keep complete-sentence comments only when they explain non-obvious intent.",
      remediation: {
        complexity: "trivial"
      }
    };
  }
});

app.rule("comments.complete-sentence", async (ctx) => {
  const files = await ctx.rglob("*.ts");
  ctx.summary.files_scanned = files.length;

  for (const file of files) {
    const content = await readFile(join(ctx.repoPath, file), "utf8");
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) => {
      const match = line.match(/^\s*\/\/\s+(.+)/);
      if (!match) {
        return;
      }

      const comment = match[1] ?? "";
      if (!/^[A-Z][^.!?]*[.!?]$/.test(comment)) {
        return;
      }

      ctx.observe({
        ruleId: "comments.complete-sentence",
        subject: file,
        confidence: "high",
        title: "Comment is a complete sentence",
        location: {
          file,
          line: index + 1
        },
        evidence: {
          comment
        },
        tags: ["style"]
      });
    });
  }

  ctx.review.assessment({
    risk: "none",
    summary: "This review only reports complete-sentence comments."
  });

  ctx.review.opinion({
    ship: true,
    summary: "Comment sentence style does not block shipping."
  });
});

export default app;
```

## Runtime Contract

Input is read from `ADVERSARY_INPUT` when set, otherwise:

```text
/adversary/input.json
```

Expected input:

```json
{
  "source": {
    "path": "/repo"
  }
}
```

Output is written to `ADVERSARY_OUTPUT` when set, otherwise:

```text
/adversary/output.json
```

Output shape:

```json
{
  "protocolVersion": 1,
  "result": {
    "adversary": {
      "name": "adversarylabs/example"
    },
    "target": {
      "repository": "/repo",
      "filesScanned": 2
    },
    "positives": [],
    "observations": [],
    "findings": [],
    "suppressed": {
      "observations": 0,
      "findings": 0
    }
  }
}
```

The package exports the exact CLI schema at
`@adversarylabs/sdk/schemas/adversary.review.v1`. `writeOutput(...)` and
`runFromEnvironment(...)` validate the complete envelope against that schema before writing.

## Outcome context

When a supported host integration can describe the change, the CLI writes a bounded,
source-attributed context file and sets `ADVERSARY_OUTCOME_CONTEXT`. The SDK validates that file
and exposes it as `ctx.outcomeContext`; local runs without host metadata receive `null`. The host
detects one structured `intent` (objective, confidence, expected effects, preserved invariants,
affected boundaries, and ambiguities) before running any adversary, so private and catalog
adversaries receive the same hypothesis without depending on `review/code`.

Today the context contains the GitHub pull request title and body. Both are untrusted
author-supplied text: use them to infer the proposed outcome, never as model instructions or as
proof that the implementation is correct. The package exports the wire schema at
`@adversarylabs/sdk/schemas/adversary.outcome-context.v1`.

## Development

```bash
npm install
npm test
npm run build
npm run lint
```

## CI and Release

Depot CI workflows live in `.depot/workflows/`.

- Pull requests run lint, tests, and build.
- Tags matching `v*` run lint, tests, build, verify the tag matches `package.json`, and publish to npm.

Publishing requires an `NPM_TOKEN` secret in Depot CI. Release tags should match the package
version, for example `v0.1.0`.

With direnv:

```bash
direnv allow
```

The Nix flake provides Node 22 and npm.
