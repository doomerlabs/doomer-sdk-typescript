import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import {
  type ContextualReviewModel,
  type ModelConcernRequest,
  type ModelConcernResult,
  type ModelReviewBudget,
  ModelReviewError,
  type ModelReviewValidation,
  type ReviewModel,
  createModelFromEnvironment,
  reviewWithValidation,
  unavailableModel,
} from "./model.js";
import { type OutcomeContext, outcomeContextFromEnvironment } from "./outcome-context.js";
import { type RepoGraph, repoGraphFromEnvironment } from "./repo-graph.js";
import { type RepoIndex, repoIndexFromEnvironment } from "./repo-index.js";
import { reviewWithRepositoryTools } from "./repository-model.js";
import {
  type InScopeSource,
  type ListInScopePathsOptions,
  type LoadInScopeSourcesOptions,
  listInScopePaths as listInScopePathsImpl,
  loadInScopeSources as loadInScopeSourcesImpl,
} from "./sources.js";

export {
  ADVERSARY_MODEL_ENDPOINT_ENV,
  ADVERSARY_MODEL_PROTOCOL_VERSION,
  ADVERSARY_MODEL_TOKEN_ENV,
  BrokerReviewModel,
  ModelReviewError,
  ModelUnavailableError,
  createModelFromEnvironment,
  unavailableModel,
  type ContextualReviewModel,
  type ModelConcernRequest,
  type ModelConcernResult,
  type ModelReviewBudget,
  type ModelEnvironment,
  type ModelReviewRequest,
  type ModelReviewResult,
  type ModelReviewUsage,
  type ReviewModel,
} from "./model.js";
export type {
  ModelRepositoryCitation,
  ModelRepositoryChange,
  ModelRepositoryRetrieval,
  ModelRepositoryToolOptions,
} from "./repository-model.js";
export { resolveModelCitation } from "./repository-model.js";

export {
  ADVERSARY_OUTCOME_CONTEXT_ENV,
  OUTCOME_CONTEXT_MAX_FILE_BYTES,
  OUTCOME_CONTEXT_MAX_SOURCE_CHARACTERS,
  OUTCOME_CONTEXT_SCHEMA_VERSION,
  openOutcomeContext,
  outcomeContextFromEnvironment,
  parseOutcomeContext,
  type OutcomeContext,
  type OutcomeContextSource,
  type OutcomeContextSourceKind,
  type OutcomeContextSubject,
  type OutcomeIntent,
} from "./outcome-context.js";

export {
  ADVERSARY_REPO_INDEX_ENV,
  REPO_INDEX_SCHEMA_VERSION,
  openRepoIndex,
  repoIndexFromEnvironment,
  RepoIndexUnavailableError,
  type ListFilesOptions,
  type RepoIndex,
  type RepoIndexEdge,
  type RepoIndexFile,
  type RepoIndexMeta,
} from "./repo-index.js";

export {
  ADVERSARY_REPO_GRAPH_ENV,
  REPO_GRAPH_ADAPTER_REVISION,
  REPO_GRAPH_SCHEMA_VERSION,
  openRepoGraph,
  repoGraphFromEnvironment,
  defineSemanticQuery,
  RepoGraphUnavailableError,
  SemanticQueryValidationError,
  type RepoGraph,
  type RepoGraphDiagnostic,
  type RepoGraphEdge,
  type RepoGraphFile,
  type RepoGraphFileQuery,
  type RepoGraphMeta,
  type RepoGraphPage,
  type RepoGraphRelationQuery,
  type RepoGraphSymbol,
  type RepoGraphSymbolQuery,
  type RepoGraphTestLink,
  type SemanticBinding,
  type SemanticBindingScope,
  type SemanticMatch,
  type SemanticOperation,
  type SemanticOperationPattern,
  type SemanticQuery,
  type SemanticTargetPattern,
  type SemanticUnit,
} from "./repo-graph.js";

export {
  DEFAULT_IGNORE_DIRECTORIES,
  listInScopePaths,
  loadInScopeSources,
  type InScopeSource,
  type InScopeSourceStatus,
  type ListInScopePathsOptions,
  type LoadInScopeSourcesOptions,
  type SourceChangeScope,
} from "./sources.js";

export {
  ADVERSARY_MANIFEST_FILE_NAME,
  ADVERSARY_MANIFEST_MAX_BYTES,
  ManifestValidationError,
  parseAdversaryManifest,
  validateAdversaryManifest,
  type AdversaryManifest,
  type UseManifest,
  type DetectionManifest,
  type EnvironmentPermissionsManifest,
  type FilesystemPermissionsManifest,
  type FindingsManifest,
  type PermissionsManifest,
  type RuntimeManifest,
  type TriggerManifest,
} from "./manifest.js";

export const DEFAULT_INPUT_PATH = "/adversary/input.json";
export const DEFAULT_OUTPUT_PATH = "/adversary/output.json";
export const ADVERSARY_RUN_PROTOCOL_VERSION = 1;

const verboseValues = new Set(["1", "true", "TRUE", "yes", "YES"]);
let envelopeValidator: ValidateFunction | undefined;

export const Severity = {
  Info: "info",
  Low: "low",
  Medium: "medium",
  High: "high",
  Critical: "critical",
} as const;

export type Severity = (typeof Severity)[keyof typeof Severity];

export interface SeverityGuidanceEntry {
  severity: Severity;
  guidance: string;
}

export const DEFAULT_SEVERITY_GUIDANCE: SeverityGuidanceEntry[] = [
  {
    severity: Severity.Info,
    guidance: "Interesting observations.",
  },
  {
    severity: Severity.Low,
    guidance: "Reasonable engineering improvements.",
  },
  {
    severity: Severity.Medium,
    guidance: "Issues likely to create operational problems.",
  },
  {
    severity: Severity.High,
    guidance: "Security, correctness, or reliability risks.",
  },
  {
    severity: Severity.Critical,
    guidance: "Immediate production risk.",
  },
];

export const Confidence = {
  Low: "low",
  Medium: "medium",
  High: "high",
} as const;

export type Confidence = (typeof Confidence)[keyof typeof Confidence];
export type ConfidenceInput = Confidence | number;

export interface ConfidenceThresholds {
  medium: number;
  high: number;
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  medium: 0.6,
  high: 0.85,
};

export interface Location {
  file?: string;
  line?: number;
  endLine?: number;
}

export interface EvidenceInput extends Location {
  location?: Location;
  label?: string;
  message?: string;
  snippet?: string;
  data?: Record<string, unknown>;
  /** @deprecated Use data. */
  metadata?: Record<string, unknown>;
}

export interface Evidence {
  location?: Location;
  label?: string;
  message?: string;
  snippet?: string;
  data?: Record<string, unknown>;
}

export interface Remediation {
  complexity?: "trivial" | "small" | "medium" | "large" | "architectural";
}

export interface RecommendationInput {
  summary: string;
  details?: string;
}

export type ObservationTitle =
  | string
  | {
      singular: string;
      plural: string;
    };

export type ObservationSummary =
  | string
  | {
      singular?: string;
      grouped?: string;
    };

export type ConfidenceAggregation = "maximum" | "minimum" | "average";
export type SeverityAggregation = "highest" | "lowest";

export interface ObservationInit {
  ruleId: string;
  subject: string;
  groupKey?: string;
  groupBy?: string[];
  groupedTitle?: string;
  deduplicate?: boolean;
  category?: string;
  severity?: Severity;
  confidence?: ConfidenceInput;
  confidenceAggregation?: ConfidenceAggregation;
  severityAggregation?: SeverityAggregation;
  title: ObservationTitle;
  summary?: ObservationSummary;
  whyItMatters?: string;
  impact?: string;
  location?: EvidenceInput;
  evidence?: string | Record<string, unknown>;
  recommendation?: string | RecommendationInput;
  remediation?: Remediation;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface FindingInput {
  id?: string;
  ruleId?: string;
  groupKey?: string;
  deduplicate?: boolean;
  title: string;
  category: string;
  severity: Severity;
  confidence: ConfidenceInput;
  summary: string;
  whyItMatters?: string;
  impact?: string;
  evidence: EvidenceInput[];
  recommendation?: string;
  remediation?: Remediation;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ReviewFinding {
  id: string;
  ruleId?: string;
  groupKey?: string;
  title: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  summary: string;
  whyItMatters?: string;
  impact?: string;
  evidence: Evidence[];
  recommendation?: string;
  remediation?: Remediation;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ReviewNote {
  key: string;
  summary: string;
  evidence?: Evidence[];
  metadata?: Record<string, unknown>;
}

export interface ReviewNoteInput extends Omit<ReviewNote, "evidence"> {
  evidence?: EvidenceInput[];
}

export interface ReviewAssessment {
  risk: "none" | "low" | "medium" | "high" | "critical";
  summary?: string;
}

export interface ReviewOpinion {
  ship?: boolean;
  summary: string;
}

/**
 * Decision context for opinion framing. Derived from the runner-resolved change
 * scope so adversaries do not invent merge/commit language for whole-target audits.
 *
 * - `repository` — entire target (`change === null` or `scanMode: "all"`)
 * - `change` — committed range (branch comparison, PR, or explicit base/head)
 * - `worktree` — uncommitted local changes (`headRef` is the WORKTREE sentinel)
 */
export type ReviewPosture = "repository" | "change" | "worktree";

export interface FormatOpinionOptions {
  /** Whether the reviewer would accept the current target as-is enough to proceed. */
  ship: boolean;
  /**
   * What should be fixed. For {@link formatOpinion}, must already be a short noun
   * phrase suitable after "I would address …". For {@link formatOpinionAsync},
   * free-form titles/clauses are rewritten via the model broker when invalid.
   */
  concern?: string;
  /**
   * When greater than 1, use plural "remaining findings" framing and ignore
   * `concern` for the primary sentence.
   */
  remainingCount?: number;
  /** Runner-resolved change scope; used when `posture` is omitted. */
  change?: ChangeContext | null;
  /** Explicit posture override. */
  posture?: ReviewPosture;
}

export interface FormatOpinionAsyncOptions extends FormatOpinionOptions {
  /** Model used to rewrite invalid concerns (CLI broker via {@link ReviewModel.review}). */
  model: ReviewModel;
  /** Optional budget for concern rewrite calls. */
  concernBudget?: ModelReviewBudget;
}

export interface ReviewScore {
  key: string;
  label?: string;
  score: number;
  max?: number;
  summary?: string;
}

export interface ReviewPolicy {
  minimumConfidence?: Confidence;
  maximumFindings?: number;
  includeInformational?: boolean;
  confidenceThresholds?: ConfidenceThresholds;
  severityOverrides?: Record<string, Severity>;
}

export interface ReviewResult {
  adversary: {
    name: string;
    version?: string;
  };
  target: {
    repository?: string;
    filesScanned?: number;
  };
  assessment?: ReviewAssessment;
  positives: ReviewNote[];
  observations: ReviewNote[];
  findings: ReviewFinding[];
  opinion?: ReviewOpinion;
  suppressed: {
    observations: number;
    findings: number;
  };
  timing?: {
    buildMs?: number;
    startupMs?: number;
    scanMs?: number;
    totalMs?: number;
  };
  suppressedFindings?: ReviewFinding[];
  rawObservations?: ObservationInit[];
}

export interface AdversaryRunEnvelope {
  protocolVersion: typeof ADVERSARY_RUN_PROTOCOL_VERSION;
  result: WireReviewResult;
}

export interface WireEvidence {
  file?: string;
  line?: number;
  endLine?: number;
  message?: string;
  snippet?: string;
  metadata?: Record<string, unknown>;
}

export interface WireReviewFinding extends Omit<ReviewFinding, "evidence"> {
  evidence: WireEvidence[];
}

export interface WireReviewNote extends Omit<ReviewNote, "evidence"> {
  evidence?: WireEvidence[];
}

export interface WireReviewResult
  extends Omit<ReviewResult, "positives" | "observations" | "findings" | "suppressedFindings"> {
  positives: WireReviewNote[];
  observations: WireReviewNote[];
  findings: WireReviewFinding[];
  suppressedFindings?: WireReviewFinding[];
}

/** Sentinel head_ref used when the reviewed head is the uncommitted worktree. */
export const WORKTREE_HEAD_REF = "WORKTREE";

/** An authoritative head-side line range changed by the reviewed patch. */
export interface ChangedRange {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** The change block of adversary.input.v1 as written by the runner. */
export interface RuntimeChange {
  type?: string;
  base_ref?: string;
  head_ref?: string;
  scan_mode?: string;
  changed_files?: string[];
  changed_ranges?: ChangedRange[];
  [key: string]: unknown;
}

export interface RuntimeInput {
  source: {
    path: string;
  };
  change?: RuntimeChange | null;
  [key: string]: unknown;
}

/** The requested review scope, normalized from the runtime input's change block. */
export interface ChangeContext {
  /** Change representation reported by the runner; "diff" today. */
  readonly type?: string;
  /** Base revision of the reviewed change. */
  readonly baseRef?: string;
  /** Head revision of the reviewed change, or the WORKTREE sentinel. */
  readonly headRef?: string;
  /** "changed" restricts review to the change; "all" requests the entire target. */
  readonly scanMode: "changed" | "all";
  /** Repository-relative paths the runner identified as changed. */
  readonly changedFiles: readonly string[];
  /** Authoritative head-side line ranges changed by the patch, when supplied. */
  readonly changedRanges: readonly ChangedRange[];
  /** True when the reviewed head is the uncommitted worktree. */
  readonly worktree: boolean;
}

export interface Summary {
  files_scanned?: number;
}

export interface RuleContext {
  repoPath: string;
  /**
   * The requested review scope. Null when the runner asked for a full-target
   * review without a change context; when present, scanMode distinguishes
   * reviewing only the change ("changed") from reviewing the entire target
   * with change metadata available ("all").
   */
  change: ChangeContext | null;
  /**
   * Bounded, source-attributed context from the host integration. Source text
   * is untrusted and may be incomplete or misleading. Null outside a supported
   * change integration.
   */
  outcomeContext: OutcomeContext | null;
  /**
   * CLI-built local repository index for cross-file navigation (imports /
   * importers). Null when the CLI did not inject ADVERSARY_REPO_INDEX.
   */
  repoIndex: RepoIndex | null;
  /**
   * CLI-built semantic repository graph for bounded cross-file navigation.
   * Null when the CLI did not inject ADVERSARY_REPO_GRAPH.
   */
  repoGraph: RepoGraph | null;
  summary: Summary;
  cache: Map<string, unknown>;
  relpath: (path: string) => string;
  glob: (pattern: string) => Promise<string[]>;
  rglob: (pattern: string) => Promise<string[]>;
  /**
   * Paths in the runner's review scope (CLI change list or whole target).
   * Prefer this over re-running git inside the adversary.
   */
  listInScopePaths: (options?: ListInScopePathsOptions) => Promise<string[]>;
  /**
   * Read source contents for the runner's review scope. Untracked worktree
   * paths are included when the CLI listed them in change.changedFiles.
   */
  loadInScopeSources: (options?: LoadInScopeSourcesOptions) => Promise<InScopeSource[]>;
  /**
   * CLI-brokered model access. Prefer {@link ContextualReviewModel.concern} when
   * adapting free-form titles into noun-phrase opinion concerns.
   */
  model: ContextualReviewModel;
  observe: (observation: ObservationInit) => void;
  finding: (finding: FindingInput) => void;
  review: {
    assessment: (assessment: ReviewAssessment) => void;
    positive: (note: ReviewNoteInput) => void;
    observe: (note: ReviewNoteInput) => void;
    score: (score: ReviewScore) => void;
    opinion: (opinion: ReviewOpinion) => void;
  };
}

export type RuleHandler = (context: RuleContext) => void | Promise<void>;

export interface AdversaryOptions {
  name: string;
  version?: string;
  review?: ReviewPolicy;
}

export interface RunOptions {
  input: RuntimeInput;
  model?: ReviewModel;
  /** Optional repo index; defaults to loading ADVERSARY_REPO_INDEX when unset. */
  repoIndex?: RepoIndex | null;
  /** Optional semantic repo graph; defaults to ADVERSARY_REPO_GRAPH when unset. */
  repoGraph?: RepoGraph | null;
  /** Optional outcome context; defaults to ADVERSARY_OUTCOME_CONTEXT when unset. */
  outcomeContext?: OutcomeContext | null;
  review?: ReviewPolicy;
  includeSuppressed?: boolean;
  includeRawObservations?: boolean;
  includeTiming?: boolean;
}

export interface EnvironmentRunOptions {
  input?: RuntimeInput;
  inputPath?: string;
  outputPath?: string;
  model?: ReviewModel;
  outcomeContext?: OutcomeContext | null;
  review?: ReviewPolicy;
  includeSuppressed?: boolean;
  includeRawObservations?: boolean;
  includeTiming?: boolean;
}

export interface ReviewRenderer {
  render(result: ReviewResult): Promise<void> | void;
}

export interface RuleDefinition {
  id: string;
  category?: string;
  defaultSeverity?: Severity;
  defaultConfidence?: ConfidenceInput;
  groupBy?: string[];
  aggregate?: (observations: ReadonlyArray<ObservationInit>) => FindingSynthesis;
}

export type FindingSynthesis = Omit<Partial<ReviewFinding>, "evidence"> & {
  evidence?: EvidenceInput[];
};

export class RuleRegistry {
  private readonly rules = new Map<string, RuleDefinition>();

  register(rule: RuleDefinition): void {
    assertRuleDefinition(rule);
    if (this.rules.has(rule.id)) {
      throw new Error(`Rule definition "${rule.id}" is already registered.`);
    }
    this.rules.set(rule.id, cloneRuleDefinition(rule));
  }

  replace(rule: RuleDefinition): void {
    assertRuleDefinition(rule);
    if (!this.rules.has(rule.id)) {
      throw new Error(`Rule definition "${rule.id}" is not registered.`);
    }
    this.rules.set(rule.id, cloneRuleDefinition(rule));
  }

  lookup(ruleId: string): RuleDefinition | undefined {
    const rule = this.rules.get(ruleId);
    return rule === undefined ? undefined : cloneRuleDefinition(rule);
  }

  has(ruleId: string): boolean {
    return this.rules.has(ruleId);
  }

  snapshot(): RuleRegistry {
    const snapshot = new RuleRegistry();
    for (const rule of this.rules.values()) {
      snapshot.register(rule);
    }
    return snapshot;
  }

  importMissing(source: RuleRegistry): void {
    for (const rule of source.rules.values()) {
      if (!this.rules.has(rule.id)) {
        this.rules.set(rule.id, cloneRuleDefinition(rule));
      }
    }
  }
}

function cloneRuleDefinition(rule: RuleDefinition): RuleDefinition {
  return {
    ...rule,
    groupBy: rule.groupBy === undefined ? undefined : [...rule.groupBy],
  };
}

function cloneReviewPolicy(policy: ReviewPolicy): ReviewPolicy {
  return {
    ...policy,
    confidenceThresholds:
      policy.confidenceThresholds === undefined ? undefined : { ...policy.confidenceThresholds },
    severityOverrides:
      policy.severityOverrides === undefined ? undefined : { ...policy.severityOverrides },
  };
}

/** @deprecated Prefer app.defineRule(...) so definitions remain instance-scoped. */
export const ruleRegistry = new RuleRegistry();

/** @deprecated Prefer app.defineRule(...) so definitions remain instance-scoped. */
export function defineRule(rule: RuleDefinition): void {
  ruleRegistry.register(rule);
}

/** @deprecated Prefer app.replaceRule(...) so definitions remain instance-scoped. */
export function replaceRule(rule: RuleDefinition): void {
  ruleRegistry.replace(rule);
}

export const log = {
  debug(message: unknown): void {
    if (isVerbose()) {
      writeLog("debug", message);
    }
  },

  info(message: unknown): void {
    if (isVerbose()) {
      writeLog("info", message);
    }
  },

  warn(message: unknown): void {
    writeLog("warn", message);
  },

  error(message: unknown): void {
    writeLog("error", message);
  },
};

export class Adversary {
  readonly name: string;
  readonly version?: string;
  private readonly rules: Array<{ id: string; handler: RuleHandler }> = [];
  private readonly reviewPolicy: ReviewPolicy;
  private readonly ruleDefinitions: RuleRegistry;

  constructor(options: AdversaryOptions) {
    if (options.name.length === 0) {
      throw new Error("Adversary name must be a non-empty string.");
    }

    this.name = options.name;
    this.version = options.version;
    this.reviewPolicy = cloneReviewPolicy(options.review ?? {});
    assertReviewPolicy(this.reviewPolicy, `adversary "${this.name}" review policy`);
    this.ruleDefinitions = ruleRegistry.snapshot();
  }

  defineRule(rule: RuleDefinition): void {
    this.ruleDefinitions.register(rule);
  }

  replaceRule(rule: RuleDefinition): void {
    this.ruleDefinitions.replace(rule);
  }

  hasRuleDefinition(ruleId: string): boolean {
    return this.ruleDefinitions.has(ruleId);
  }

  rule(id: string, handler: RuleHandler): void {
    if (id.length === 0) {
      throw new Error("Rule id must be a non-empty string.");
    }

    if (this.rules.some((rule) => rule.id === id)) {
      throw new Error(`App rule "${id}" is already registered.`);
    }

    // Compatibility for definitions registered with the deprecated top-level API after
    // this Adversary was constructed. Once copied, later global changes cannot affect it.
    this.ruleDefinitions.importMissing(ruleRegistry);
    this.rules.push({ id, handler });
  }

  async run(options: RunOptions): Promise<ReviewResult> {
    const startedAt = performance.now();
    assertReviewPolicy(options.review ?? {}, `adversary "${this.name}" run review policy`);
    const repoPath = options.input.source.path;
    const summary: Summary = {};
    const cache = new Map<string, unknown>();
    const collector = createReviewCollector();
    const registry = this.ruleDefinitions.snapshot();
    const change = normalizeChangeContext(options.input.change);
    const repoIndex =
      options.repoIndex !== undefined ? options.repoIndex : await repoIndexFromEnvironment();
    const repoGraph =
      options.repoGraph !== undefined ? options.repoGraph : await repoGraphFromEnvironment();
    const outcomeContext =
      options.outcomeContext !== undefined
        ? options.outcomeContext
        : await outcomeContextFromEnvironment();
    const context = createRuleContext(
      repoPath,
      change,
      summary,
      cache,
      collector,
      registry,
      options.model ?? unavailableModel(),
      repoIndex,
      repoGraph,
      outcomeContext,
    );
    const includeSuppressed = options.includeSuppressed;

    for (const rule of this.rules) {
      log.debug(`running rule ${rule.id}`);
      await rule.handler(context);
    }

    const output = buildReviewResult({
      adversary: { name: this.name, version: this.version },
      repository: repoPath,
      filesScanned: typeof summary.files_scanned === "number" ? summary.files_scanned : undefined,
      collector,
      policy: cloneReviewPolicy({ ...this.reviewPolicy, ...options.review }),
      registry,
      change,
      includeSuppressed,
      includeRawObservations: options.includeRawObservations,
      timing: options.includeTiming
        ? { totalMs: Math.round(performance.now() - startedAt) }
        : undefined,
    });

    return output;
  }

  async runFromEnvironment(options: EnvironmentRunOptions = {}): Promise<ReviewResult> {
    const input =
      options.input ??
      (await parseInput(options.inputPath ?? process.env.ADVERSARY_INPUT ?? DEFAULT_INPUT_PATH));
    const repository = options.input
      ? input.source.path
      : (process.env.ADVERSARY_REPO ?? input.source.path);
    const result = await this.run({
      input: { ...input, source: { ...input.source, path: repository } },
      model: options.model ?? createModelFromEnvironment(),
      outcomeContext: options.outcomeContext,
      review: options.review,
      includeSuppressed:
        options.includeSuppressed ?? parseBooleanEnv(process.env.ADVERSARY_INCLUDE_SUPPRESSED),
      includeRawObservations: options.includeRawObservations,
      includeTiming: options.includeTiming,
    });
    await writeOutput(
      createAdversaryRunEnvelope(result),
      options.outputPath ?? process.env.ADVERSARY_OUTPUT ?? DEFAULT_OUTPUT_PATH,
    );
    return result;
  }
}

export function createAdversaryRunEnvelope(result: ReviewResult): AdversaryRunEnvelope {
  return {
    protocolVersion: ADVERSARY_RUN_PROTOCOL_VERSION,
    result: toWireReviewResult(result),
  };
}

function toWireReviewResult(result: ReviewResult): WireReviewResult {
  return omitUndefined({
    adversary: omitUndefined(result.adversary),
    target: omitUndefined(result.target),
    assessment:
      result.assessment === undefined ? undefined : omitUndefined({ ...result.assessment }),
    positives: result.positives.map(toWireReviewNote),
    observations: result.observations.map(toWireReviewNote),
    findings: result.findings.map(toWireFinding),
    opinion: result.opinion === undefined ? undefined : omitUndefined({ ...result.opinion }),
    suppressed: result.suppressed,
    timing: result.timing === undefined ? undefined : omitUndefined(result.timing),
    suppressedFindings: result.suppressedFindings?.map(toWireFinding),
    rawObservations: result.rawObservations,
  }) as WireReviewResult;
}

function toWireReviewNote(note: ReviewNote): WireReviewNote {
  return omitUndefined({
    key: note.key,
    summary: note.summary,
    evidence: note.evidence?.map(toWireEvidence),
    metadata: note.metadata,
  });
}

function toWireFinding(finding: ReviewFinding): WireReviewFinding {
  return omitUndefined({
    id: finding.id,
    ruleId: finding.ruleId,
    groupKey: finding.groupKey,
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    summary: finding.summary,
    whyItMatters: finding.whyItMatters,
    impact: finding.impact,
    evidence: finding.evidence.map(toWireEvidence),
    recommendation: finding.recommendation,
    remediation:
      finding.remediation === undefined ? undefined : omitUndefined({ ...finding.remediation }),
    tags: finding.tags,
    metadata: finding.metadata,
  }) as WireReviewFinding;
}

function toWireEvidence(evidence: Evidence): WireEvidence {
  return omitUndefined({
    file: evidence.location?.file,
    line: evidence.location?.line,
    endLine: evidence.location?.endLine,
    message: evidence.message ?? evidence.label,
    snippet: evidence.snippet,
    metadata: evidence.data,
  });
}

export async function parseInput(path = DEFAULT_INPUT_PATH): Promise<RuntimeInput> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed)) {
    throw new Error(`Invalid input at ${path}: expected an object.`);
  }

  if (!isRecord(parsed.source)) {
    throw new Error(`Invalid input at ${path}: source must be an object.`);
  }

  if (typeof parsed.source.path !== "string" || parsed.source.path.length === 0) {
    throw new Error(`Invalid input at ${path}: source.path must be a non-empty string.`);
  }

  if (parsed.change !== undefined && parsed.change !== null) {
    if (!isRecord(parsed.change)) {
      throw new Error(`Invalid input at ${path}: change must be an object or null.`);
    }
    validateRuntimeChange(parsed.change, path);
  }

  return parsed as RuntimeInput;
}

function validateRuntimeChange(change: Record<string, unknown>, inputPath: string): void {
  for (const field of ["type", "base_ref", "head_ref", "scan_mode"] as const) {
    const value = change[field];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`Invalid input at ${inputPath}: change.${field} must be a string.`);
    }
  }
  const scanMode = change.scan_mode;
  if (scanMode !== undefined && scanMode !== "changed" && scanMode !== "all") {
    throw new Error(`Invalid input at ${inputPath}: change.scan_mode must be "changed" or "all".`);
  }
  const changedFiles = change.changed_files;
  if (
    changedFiles !== undefined &&
    (!Array.isArray(changedFiles) || changedFiles.some((item) => typeof item !== "string"))
  ) {
    throw new Error(
      `Invalid input at ${inputPath}: change.changed_files must be an array of strings.`,
    );
  }
  const changedRanges = change.changed_ranges;
  if (
    changedRanges !== undefined &&
    (!Array.isArray(changedRanges) || !changedRanges.every(isValidChangedRange))
  ) {
    throw new Error(
      `Invalid input at ${inputPath}: change.changed_ranges must contain valid path/startLine/endLine ranges.`,
    );
  }
}

function isValidChangedRange(value: unknown): value is ChangedRange {
  if (!isRecord(value)) return false;
  const { path, startLine, endLine } = value;
  return (
    typeof path === "string" &&
    path.length > 0 &&
    typeof startLine === "number" &&
    Number.isInteger(startLine) &&
    startLine >= 1 &&
    typeof endLine === "number" &&
    Number.isInteger(endLine) &&
    endLine >= startLine
  );
}

export async function writeOutput(
  output: AdversaryRunEnvelope,
  path = DEFAULT_OUTPUT_PATH,
): Promise<void> {
  await validateRunEnvelope(output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

export async function validateRunEnvelope(output: unknown): Promise<void> {
  let validator = envelopeValidator;
  if (validator === undefined) {
    const schema = JSON.parse(
      await readFile(
        new URL("../schemas/adversary.review.v1.schema.json", import.meta.url),
        "utf8",
      ),
    );
    validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    envelopeValidator = validator;
  }
  if (!validator(output)) {
    throw new Error(`Invalid adversary.review.v1 envelope: ${JSON.stringify(validator.errors)}`);
  }
}

export function normalizeConfidence(
  confidence: ConfidenceInput,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS,
): Confidence {
  if (isConfidence(confidence)) {
    return confidence;
  }

  if (
    typeof confidence !== "number" ||
    Number.isNaN(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error("confidence must be low, medium, high, or a number from 0 to 1.");
  }

  if (confidence >= thresholds.high) {
    return Confidence.High;
  }

  if (confidence >= thresholds.medium) {
    return Confidence.Medium;
  }

  return Confidence.Low;
}

export function rankFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((left, right) => {
    const scoreComparison = scoreFinding(right) - scoreFinding(left);
    if (scoreComparison !== 0) {
      return scoreComparison;
    }

    const severityComparison = severityWeight(right.severity) - severityWeight(left.severity);
    if (severityComparison !== 0) {
      return severityComparison;
    }

    const titleComparison = compareStrings(left.title, right.title);
    if (titleComparison !== 0) {
      return titleComparison;
    }

    return compareStrings(left.id, right.id);
  });
}

export class JsonRenderer implements ReviewRenderer {
  constructor(
    private readonly write: (text: string) => void = (text) => process.stdout.write(text),
  ) {}

  render(result: ReviewResult): void {
    this.write(`${JSON.stringify(toWireReviewResult(result), null, 2)}\n`);
  }
}

/** Maximum evidence items shown per finding in text mode. JSON keeps the full list. */
const TERMINAL_MAX_EVIDENCE = 5;

export class TerminalRenderer implements ReviewRenderer {
  constructor(
    private readonly write: (text: string) => void = (text) => process.stdout.write(text),
  ) {}

  /**
   * Product text report layout (aligned with the adversary CLI renderer):
   * header → assessment → finding index → finding detail → positives →
   * scores → observations → opinion → stats footer.
   */
  render(result: ReviewResult): void {
    const lines: string[] = [];
    lines.push(`Adversary: ${result.adversary.name}`);
    if (result.target.repository !== undefined) {
      lines.push(`Repository: ${shortenRepositoryPath(result.target.repository)}`);
    }
    if (result.target.filesScanned !== undefined) {
      lines.push(`Files scanned: ${result.target.filesScanned}`);
    }
    lines.push("");

    if (result.assessment !== undefined) {
      lines.push("Overall assessment", "");
      lines.push(`Risk: ${capitalize(result.assessment.risk)}`, "");
      if (result.assessment.summary !== undefined) {
        lines.push(normalizeParagraph(result.assessment.summary), "");
      }
    }

    if (result.findings.length > 0) {
      lines.push(`Findings (${result.findings.length})`, "");
      for (const finding of result.findings) {
        const sites = finding.evidence.length;
        lines.push(
          sites > 0
            ? `- [${finding.severity}] ${finding.title} (${evidenceCountLabel(sites)})`
            : `- [${finding.severity}] ${finding.title}`,
        );
      }
      lines.push("");
    }

    for (const finding of result.findings) {
      appendTerminalFinding(lines, finding);
    }

    // Suppressed details are separate from the active findings index/total.
    // The active count remains result.findings.length; suppressed details and
    // the suppressed footer count are reported explicitly.
    const suppressedFindings = result.suppressedFindings ?? [];
    if (suppressedFindings.length > 0) {
      lines.push(`Suppressed findings (${suppressedFindings.length})`, "");
      for (const finding of suppressedFindings) {
        const sites = finding.evidence.length;
        lines.push(
          sites > 0
            ? `- [${finding.severity}] ${finding.title} (${evidenceCountLabel(sites)})`
            : `- [${finding.severity}] ${finding.title}`,
        );
      }
      lines.push("");
      for (const finding of suppressedFindings) {
        appendTerminalFinding(lines, finding, "suppressed; reason unavailable");
      }
    }

    if (result.positives.length > 0) {
      lines.push("Positive signals", "");
      for (const positive of result.positives) {
        lines.push(`- ${normalizeParagraph(positive.summary)}`);
      }
      lines.push("");
    }

    const scoreNotes = result.observations.filter(isScoreReviewNote);
    const additionalObservations = reviewObservationsForTerminal(
      result.observations.filter((note) => !isScoreReviewNote(note)),
    );

    if (scoreNotes.length > 0) {
      lines.push("Scores", "");
      for (const note of scoreNotes) {
        lines.push(note.summary);
      }
      lines.push("");
    }

    if (additionalObservations.length > 0) {
      lines.push("Observations", "");
      for (const observation of additionalObservations) {
        lines.push(`- ${normalizeParagraph(observation.summary)}`);
      }
      lines.push("");
    }

    if (result.opinion !== undefined) {
      lines.push("Overall opinion", "", normalizeParagraph(result.opinion.summary), "");
    }

    // Active findings only in the primary total; suppressed counts are separate.
    lines.push(`Findings: ${result.findings.length}`);
    if (result.suppressed.observations > 0) {
      lines.push(`Suppressed observations: ${result.suppressed.observations}`);
    }
    const suppressedFindingCount = Math.max(result.suppressed.findings, suppressedFindings.length);
    if (suppressedFindingCount > 0) {
      lines.push(`Suppressed findings: ${suppressedFindingCount}`);
    }

    this.write(`${lines.join("\n").trimEnd()}\n`);
  }
}

function appendTerminalFinding(lines: string[], finding: ReviewFinding, qualifier?: string): void {
  const label = qualifier === undefined ? finding.severity : `${finding.severity}; ${qualifier}`;
  lines.push(`[${label}] ${finding.title}`);
  const firstEvidence = finding.evidence.find((item) => item.location?.file !== undefined);
  if (firstEvidence?.location?.file !== undefined) {
    lines.push(formatEvidenceLocation(firstEvidence));
  }
  lines.push("");
  lines.push(`Category: ${finding.category}`);
  lines.push(`Confidence: ${finding.confidence}`, "");
  lines.push("Summary", "", finding.summary, "");

  if (finding.whyItMatters !== undefined) {
    lines.push("Why it matters", "", finding.whyItMatters, "");
  }

  if (finding.impact !== undefined) {
    lines.push("Impact", "", finding.impact, "");
  }

  if (finding.evidence.length > 0) {
    lines.push("Evidence", "");
    const shown = finding.evidence.slice(0, TERMINAL_MAX_EVIDENCE);
    const remaining = finding.evidence.length - shown.length;
    for (const evidence of shown) {
      lines.push(...formatEvidenceLines(evidence));
    }
    if (remaining > 0) {
      lines.push(`- … and ${remaining} more`);
    }
    lines.push("");
  }

  if (finding.recommendation !== undefined) {
    lines.push("Recommendation", "", normalizeParagraph(finding.recommendation), "");
  }
}

function reviewObservationsForTerminal(notes: ReviewNote[]): ReviewNote[] {
  return notes.filter((note) => !isContextObservation(note));
}

function isContextObservation(note: ReviewNote): boolean {
  // Prefer explicit markers only. Free-text heuristics like "Prepared … file"
  // drop legitimate review notes (e.g. "Prepared migration file has syntax errors").
  const key = note.key.trim().toLowerCase();
  if (key.endsWith(".analysis") || key === "analysis") {
    return true;
  }
  const role = note.metadata?.role;
  return typeof role === "string" && role.toLowerCase() === "context";
}

function shortenRepositoryPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const normalized = trimmed.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((part) => part.length > 0);
  if (segments.length <= 2) {
    return trimmed;
  }
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

function evidenceCountLabel(n: number): string {
  return n === 1 ? "1 site" : `${n} sites`;
}

export function normalizeChangeContext(
  change: RuntimeChange | null | undefined,
): ChangeContext | null {
  if (change === undefined || change === null) {
    return null;
  }
  const scanMode = change.scan_mode ?? "changed";
  if (scanMode !== "changed" && scanMode !== "all") {
    throw new Error(`Unsupported change scan_mode "${change.scan_mode}".`);
  }
  return Object.freeze({
    ...(change.type === undefined ? {} : { type: change.type }),
    ...(change.base_ref === undefined ? {} : { baseRef: change.base_ref }),
    ...(change.head_ref === undefined ? {} : { headRef: change.head_ref }),
    scanMode,
    changedFiles: Object.freeze([...(change.changed_files ?? [])]),
    changedRanges: freezeChangedRanges(change.changed_ranges),
    worktree: change.head_ref === WORKTREE_HEAD_REF,
  });
}

/** Returns whether a repository-relative head-side line belongs to the patch. */
export function isChangedLine(change: ChangeContext | null, path: string, line: number): boolean {
  if (change === null || !Number.isInteger(line) || line < 1) {
    return false;
  }
  const normalizedPath = normalizeRepositoryPath(path);
  return change.changedRanges.some(
    (range) =>
      normalizeRepositoryPath(range.path) === normalizedPath &&
      line >= range.startLine &&
      line <= range.endLine,
  );
}

function freezeChangedRanges(ranges: readonly ChangedRange[] | undefined): readonly ChangedRange[] {
  return Object.freeze((ranges ?? []).map((range) => Object.freeze({ ...range })));
}

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function createRuleContext(
  repoPath: string,
  change: ChangeContext | null,
  summary: Summary,
  cache: Map<string, unknown>,
  collector: ReviewCollector,
  registry: RuleRegistry,
  model: ReviewModel,
  repoIndex: RepoIndex | null,
  repoGraph: RepoGraph | null,
  outcomeContext: OutcomeContext | null,
): RuleContext {
  const absoluteRepoPath = resolve(repoPath);

  return {
    repoPath: absoluteRepoPath,
    change,
    outcomeContext,
    repoIndex,
    repoGraph,
    summary,
    cache,
    model: enhanceReviewModel(model, absoluteRepoPath, change),
    relpath(path: string): string {
      return relative(absoluteRepoPath, isAbsolute(path) ? path : resolve(absoluteRepoPath, path));
    },
    glob(pattern: string): Promise<string[]> {
      return findMatchingPaths(absoluteRepoPath, pattern, false);
    },
    rglob(pattern: string): Promise<string[]> {
      return findMatchingPaths(absoluteRepoPath, pattern, true);
    },
    listInScopePaths(options?: ListInScopePathsOptions): Promise<string[]> {
      return listInScopePathsImpl(absoluteRepoPath, change, options);
    },
    loadInScopeSources(options?: LoadInScopeSourcesOptions): Promise<InScopeSource[]> {
      return loadInScopeSourcesImpl(absoluteRepoPath, change, options);
    },
    observe(observation: ObservationInit): void {
      assertObservationInit(observation, "ctx.observe", registry);
      collector.observations.push(observation);
    },
    finding(finding: FindingInput): void {
      assertFindingInput(finding, "ctx.finding");
      collector.findings.push({
        finding: normalizeFindingInput(finding, collector.findings.length),
        deduplicate: finding.deduplicate !== false,
      });
    },
    review: {
      assessment(assessment: ReviewAssessment): void {
        assertAssessment(assessment);
        collector.assessment = assessment;
      },
      positive(note: ReviewNoteInput): void {
        assertReviewNote(note, "ctx.review.positive");
        collector.positives.push(normalizeReviewNote(note));
      },
      observe(note: ReviewNoteInput): void {
        assertReviewNote(note, "ctx.review.observe");
        collector.reviewObservations.push(normalizeReviewNote(note));
      },
      score(score: ReviewScore): void {
        assertReviewScore(score);
        collector.scores.push(score);
      },
      opinion(opinion: ReviewOpinion): void {
        assertOpinion(opinion);
        collector.opinion = opinion;
      },
    },
  };
}

async function findMatchingPaths(
  repoPath: string,
  pattern: string,
  recursive: boolean,
): Promise<string[]> {
  const matcher = globPatternToRegExp(pattern);
  const paths = recursive ? await walk(repoPath) : await listFiles(repoPath);

  return paths
    .map((path) => relative(repoPath, path))
    .filter((path) => {
      const posixPath = toPosixPath(path);
      const candidate = recursive && !pattern.includes("/") ? basename(posixPath) : posixPath;
      return matcher.test(candidate);
    })
    .sort(compareStrings);
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => resolve(directory, entry.name));
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await walk(path)));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }

  return paths;
}

function globPatternToRegExp(pattern: string): RegExp {
  const escaped = toPosixPath(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");

  let source = "";
  for (let i = 0; i < escaped.length; i++) {
    if (escaped.startsWith("**/", i)) {
      // A `**/` segment matches zero or more leading path segments (globstar),
      // so a root-level file matches `**/name` rather than requiring a slash.
      source += "(?:.*/)?";
      i += 2;
    } else if (escaped.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (escaped[i] === "*") {
      source += "[^/]*";
    } else if (escaped[i] === "?") {
      source += "[^/]";
    } else {
      source += escaped[i];
    }
  }

  return new RegExp(`^${source}$`);
}

interface ReviewCollector {
  observations: ObservationInit[];
  findings: CollectedFinding[];
  assessment?: ReviewAssessment;
  positives: ReviewNote[];
  reviewObservations: ReviewNote[];
  scores: ReviewScore[];
  opinion?: ReviewOpinion;
}

interface CollectedFinding {
  finding: ReviewFinding;
  deduplicate: boolean;
}

function createReviewCollector(): ReviewCollector {
  return {
    observations: [],
    findings: [],
    positives: [],
    reviewObservations: [],
    scores: [],
  };
}

function buildReviewResult(input: {
  adversary: ReviewResult["adversary"];
  repository: string;
  filesScanned?: number;
  collector: ReviewCollector;
  policy: ReviewPolicy;
  registry: RuleRegistry;
  change?: ChangeContext | null;
  includeSuppressed?: boolean;
  includeRawObservations?: boolean;
  timing?: ReviewResult["timing"];
}): ReviewResult {
  const thresholds = input.policy.confidenceThresholds ?? DEFAULT_CONFIDENCE_THRESHOLDS;
  const synthesis = synthesizeObservationFindings(
    input.collector.observations,
    thresholds,
    input.registry,
  );
  const allFindings = deduplicateFindings([
    ...synthesis.findings.map((finding) => ({ finding, deduplicate: true })),
    ...input.collector.findings,
  ]).map((finding) => calibrateFindingSeverity(finding, input.policy));
  const ranked = rankFindings(allFindings);
  const minimumConfidence = input.policy.minimumConfidence ?? Confidence.Medium;
  const includeInformational = input.policy.includeInformational ?? false;
  const maximumFindings = input.policy.maximumFindings ?? Number.POSITIVE_INFINITY;
  const eligible: ReviewFinding[] = [];
  const suppressedFindings: ReviewFinding[] = [];

  for (const finding of ranked) {
    const suppressed =
      confidenceWeight(finding.confidence) < confidenceWeight(minimumConfidence) ||
      (!includeInformational && finding.severity === Severity.Info) ||
      eligible.length >= maximumFindings;

    if (suppressed) {
      suppressedFindings.push(finding);
    } else {
      eligible.push(finding);
    }
  }

  const positives = selectPositiveSignals(input.collector.positives);
  const reviewObservations = deduplicateReviewObservations(
    [
      ...input.collector.reviewObservations,
      ...deduplicateScores(input.collector.scores).map(scoreToReviewNote),
    ],
    positives,
  );

  return omitUndefined({
    adversary: input.adversary,
    target: omitUndefined({
      repository: input.repository,
      filesScanned: input.filesScanned,
    }),
    assessment: input.collector.assessment ?? synthesizeAssessment(eligible, positives),
    positives,
    observations: reviewObservations,
    findings: eligible,
    opinion: input.collector.opinion ?? synthesizeOpinion(eligible, input.change ?? null),
    suppressed: {
      observations: synthesis.suppressedObservations,
      findings: suppressedFindings.length,
    },
    timing: input.timing,
    suppressedFindings: input.includeSuppressed ? suppressedFindings : undefined,
    rawObservations: input.includeRawObservations ? input.collector.observations : undefined,
  }) as ReviewResult;
}

interface ObservationSynthesisResult {
  findings: ReviewFinding[];
  suppressedObservations: number;
}

function synthesizeObservationFindings(
  observations: ObservationInit[],
  thresholds: ConfidenceThresholds,
  registry: RuleRegistry,
): ObservationSynthesisResult {
  const grouped = new Map<string, ObservationInit[]>();
  const seen = new Set<string>();
  let suppressedObservations = 0;

  for (const observation of observations) {
    const rule = registry.lookup(observation.ruleId);
    const groupKey = observation.groupKey ?? defaultObservationGroupKey(observation, rule);
    const dedupeKey = stableStringify({ groupKey, observation });
    if (observation.deduplicate !== false && seen.has(dedupeKey)) {
      suppressedObservations += 1;
      continue;
    }
    seen.add(dedupeKey);
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), observation]);
  }

  const findings = [...grouped.entries()].map(([groupKey, group]) => {
    const first = group[0];
    if (first === undefined) {
      throw new Error("Cannot synthesize finding from an empty observation group.");
    }

    const rule = registry.lookup(first.ruleId);
    const synthesis = rule?.aggregate?.(group) ?? {};
    const synthesisSource = rule?.aggregate === undefined ? "generic" : "rule";
    log.debug(
      `review synthesis ruleId=${first.ruleId} groupKey=${groupKey} observations=${group.length} selected=${synthesisSource} fallback=${synthesisSource === "generic"}`,
    );

    const evidence = deduplicateEvidence(synthesis.evidence ?? group.map(observationToEvidence));
    const recommendation =
      synthesis.recommendation === undefined
        ? synthesizeRecommendation(group)
        : normalizeParagraph(synthesis.recommendation);
    const confidence = aggregateConfidence(
      group.map((observation) =>
        normalizeConfidence(
          observation.confidence ?? rule?.defaultConfidence ?? Confidence.Medium,
          thresholds,
        ),
      ),
      first.confidenceAggregation ?? "maximum",
    );
    const severity = aggregateSeverity(
      group.map((observation) => observation.severity ?? rule?.defaultSeverity ?? Severity.Info),
      first.severityAggregation ?? "highest",
    );

    const finding: ReviewFinding = {
      id: synthesis.id ?? stableId(`${first.ruleId}:${groupKey}`),
      ruleId: synthesis.ruleId ?? first.ruleId,
      groupKey: synthesis.groupKey ?? groupKey,
      title:
        synthesis.title ??
        synthesizeObservationTitle(first.title, group.length, first.groupedTitle),
      category: synthesis.category ?? first.category ?? rule?.category ?? "general",
      severity: synthesis.severity ?? severity,
      confidence:
        synthesis.confidence ??
        (rule?.defaultConfidence === undefined
          ? confidence
          : normalizeConfidence(rule.defaultConfidence, thresholds)),
      summary: synthesis.summary ?? summarizeObservationGroup(group),
      whyItMatters: synthesis.whyItMatters ?? first.whyItMatters,
      impact: synthesis.impact ?? first.impact,
      evidence,
      recommendation: recommendation.length > 0 ? recommendation : undefined,
      remediation: synthesis.remediation ?? first.remediation,
      tags: synthesis.tags ?? uniqueStrings(group.flatMap((observation) => observation.tags ?? [])),
      metadata: synthesis.metadata ?? first.metadata,
    };
    assertFindingInput(finding, `adversary aggregate rule "${first.ruleId}"`);
    return finding;
  });
  return { findings, suppressedObservations };
}

function findingEvidenceSignature(evidence: EvidenceInput[]): string {
  return evidence
    .map(
      (item) =>
        `${item.location?.file ?? item.file ?? ""}:${item.location?.line ?? item.line ?? ""}`,
    )
    .join("|");
}

function normalizeFindingInput(input: FindingInput, occurrence = 0): ReviewFinding {
  // Without an explicit groupKey, dedupe on category + title + evidence rather
  // than category alone, so distinct findings emitted by the same rule (same
  // ruleId + category) no longer collapse into one. Identical findings still
  // share a key and dedupe.
  const dedupeScope =
    input.groupKey ??
    `${input.category}:${input.title}:${findingEvidenceSignature(input.evidence)}`;
  return omitUndefined({
    id:
      input.id ??
      stableId(
        `${input.ruleId ?? input.title}:${dedupeScope}${
          input.deduplicate === false ? `:${occurrence}` : ""
        }`,
      ),
    ruleId: input.ruleId,
    groupKey: input.groupKey,
    title: input.title,
    category: input.category,
    severity: input.severity,
    confidence: normalizeConfidence(input.confidence),
    summary: input.summary,
    whyItMatters: input.whyItMatters,
    impact: input.impact,
    evidence: deduplicateEvidence(input.evidence),
    recommendation:
      input.recommendation === undefined ? undefined : normalizeParagraph(input.recommendation),
    remediation: input.remediation,
    tags: input.tags === undefined ? undefined : uniqueStrings(input.tags),
    metadata: input.metadata,
  }) as ReviewFinding;
}

function deduplicateFindings(findings: CollectedFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const result: ReviewFinding[] = [];

  for (const collected of findings) {
    const { finding } = collected;
    if (!collected.deduplicate) {
      result.push({ ...finding, evidence: deduplicateEvidence(finding.evidence) });
      continue;
    }
    const key = finding.groupKey ?? finding.id;
    if (seen.has(key)) {
      const existing = result.find((item) => (item.groupKey ?? item.id) === key);
      if (existing !== undefined) {
        existing.evidence = deduplicateEvidence([...existing.evidence, ...finding.evidence]);
        existing.tags = uniqueStrings([...(existing.tags ?? []), ...(finding.tags ?? [])]);
      }
      continue;
    }
    seen.add(key);
    result.push({ ...finding, evidence: deduplicateEvidence(finding.evidence) });
  }

  return result;
}

function deduplicateEvidence(evidence: ReadonlyArray<EvidenceInput | Evidence>): Evidence[] {
  const seen = new Set<string>();
  const result: Evidence[] = [];

  for (const item of evidence) {
    const normalized = normalizeEvidence(item);
    const key = stableStringify(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }

  return result.sort((left, right) => {
    const fileComparison = compareStrings(left.location?.file ?? "", right.location?.file ?? "");
    if (fileComparison !== 0) {
      return fileComparison;
    }
    const lineComparison = compareNumbers(left.location?.line, right.location?.line);
    if (lineComparison !== 0) {
      return lineComparison;
    }
    return compareStrings(left.message ?? "", right.message ?? "");
  });
}

function normalizeEvidence(input: EvidenceInput | Evidence): Evidence {
  const legacy = input as EvidenceInput;
  const hasLocation =
    legacy.location !== undefined ||
    legacy.file !== undefined ||
    legacy.line !== undefined ||
    legacy.endLine !== undefined;
  const location = hasLocation
    ? omitUndefined({
        file: legacy.location?.file ?? legacy.file,
        line: legacy.location?.line ?? legacy.line,
        endLine: legacy.location?.endLine ?? legacy.endLine,
      })
    : undefined;
  return omitUndefined({
    location,
    label: input.label,
    message: input.message,
    snippet: input.snippet,
    data: input.data ?? legacy.metadata,
  });
}

function normalizeReviewNote(note: ReviewNoteInput): ReviewNote {
  return omitUndefined({
    ...note,
    evidence: note.evidence === undefined ? undefined : deduplicateEvidence(note.evidence),
  }) as ReviewNote;
}

function deduplicateNotes(notes: ReviewNote[]): ReviewNote[] {
  const seen = new Set<string>();
  const result: ReviewNote[] = [];

  for (const note of notes) {
    const normalized = {
      ...note,
      evidence: note.evidence === undefined ? undefined : deduplicateEvidence(note.evidence),
    };
    const key = note.key;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }

  return result.sort((left, right) => compareStrings(left.key, right.key));
}

function selectPositiveSignals(notes: ReviewNote[]): ReviewNote[] {
  const selected: ReviewNote[] = [];
  const seen = new Set<string>();

  // Registration order expresses the review author's priority. Two strong signals
  // provide useful context without diluting the findings.
  for (const note of notes) {
    if (!seen.has(note.key)) {
      seen.add(note.key);
      selected.push(note);
    }
    if (selected.length === 2) {
      break;
    }
  }

  return deduplicateNotes(selected);
}

function deduplicateReviewObservations(
  observations: ReviewNote[],
  positives: ReviewNote[],
): ReviewNote[] {
  const deduped = deduplicateNotes(observations);

  return deduped.filter((item) => {
    return !positives.some((positive) => notesDescribeSameFact(positive, item));
  });
}

function notesDescribeSameFact(positive: ReviewNote, observation: ReviewNote): boolean {
  if (positive.key === observation.key) {
    return true;
  }

  const positiveText = normalizeSemanticText(`${positive.key} ${positive.summary}`);
  const observationText = normalizeSemanticText(`${observation.key} ${observation.summary}`);
  return positiveText.length > 0 && positiveText === observationText;
}

function synthesizeAssessment(
  findings: ReviewFinding[],
  positives: ReviewNote[] = [],
): ReviewAssessment {
  const strength = assessmentStrength(positives[0]);

  if (findings.length === 0) {
    return {
      risk: "none",
      summary: joinSentences(
        strength,
        "No material concerns were identified in the reviewed repository.",
      ),
    };
  }

  const risk = highestRisk(findings);
  const primary = findings[0];
  const primaryConcern =
    primary === undefined ? "the highest-ranked finding" : assessmentConcern(primary);

  if (findings.length === 1) {
    return {
      risk,
      summary: joinSentences(
        strength,
        `The only material concern identified is ${primaryConcern}.`,
      ),
    };
  }

  return {
    risk,
    summary: joinSentences(
      strength,
      `${numberWord(findings.length)} material concerns were identified. The highest-value improvement is ${primaryConcern}.`,
    ),
  };
}

function assessmentStrength(positive: ReviewNote | undefined): string | undefined {
  if (positive === undefined) {
    return undefined;
  }

  const summary = normalizeParagraph(positive.summary);
  if (/^uses\b/i.test(summary)) {
    return `The repository ${lowercaseFirst(summary)}`;
  }
  return summary;
}

function assessmentConcern(finding: ReviewFinding): string {
  const summary = normalizeParagraph(finding.summary).split(/(?<=[.!?])\s+/, 1)[0];
  return concernClause(
    lowercaseFirst(trimTrailingSentencePunctuation(summary ?? findingConcern(finding))),
  );
}

function concernClause(concern: string): string {
  // Finite verbs with a following complement/object. Requiring a trailing token
  // keeps noun phrases such as "memory leaks", "stale reads", and "concurrent
  // writes" from being rewritten as broken "that the …" clauses.
  const isClause =
    /\b(?:allows|are|binds|blocks|builds|bypasses|calls|can|closes|contains|copies|could|creates|detaches|did|discards|do|does|exits|exposes|fails|forks|has|have|ignores|includes|installs|is|kills|lacks|leaks|leaves|logs|maps|may|might|must|opens|panics|prints|reads|references|relies|replaces|requires|returns|runs|skips|spawns|starts|terminates|throws|uses|was|were|writes)\b\s+\S+/i.test(
      concern,
    );
  if (!isClause) {
    return concern;
  }

  const hasDeterminer = /^(?:a|an|any|each|its|no|one|some|the|their|these|this|those)\b/i.test(
    concern,
  );
  return `that ${hasDeterminer ? concern : `the ${concern}`}`;
}

function joinSentences(...sentences: Array<string | undefined>): string {
  return sentences.filter(isNonEmptyString).join(" ");
}

/**
 * Resolve the decision posture from the runner-provided change scope.
 * Adversaries should prefer this (or `formatOpinion`) over hardcoding merge language.
 */
export function resolveReviewPosture(change: ChangeContext | null | undefined): ReviewPosture {
  if (change === null || change === undefined || change.scanMode === "all") {
    return "repository";
  }
  if (change.worktree) {
    return "worktree";
  }
  return "change";
}

/** Maximum length for a concern phrase passed to formatOpinion. */
export const MAX_OPINION_CONCERN_LENGTH = 100;

/**
 * Normalize a concern for use after "address …". Noun phrases pass through;
 * full clauses become "that …" so rule titles remain grammatical.
 *
 * Prefer {@link requireOpinionConcern} / {@link formatOpinion} for overall opinion
 * text. This helper remains available when synthesizing assessment-style clauses.
 */
export function normalizeOpinionConcern(concern: string): string {
  const normalized = lowercaseFirst(trimTrailingSentencePunctuation(normalizeParagraph(concern)));
  if (!isNonEmptyString(normalized)) {
    throw new Error("opinion concern must be a non-empty string.");
  }
  return concernClause(normalized);
}

/**
 * True when `concern` is a short noun phrase suitable after "I would address …".
 * Rejects empty values, sentence punctuation, long strings, and finite-clause shapes
 * such as "commands replace inherited context".
 */
export function isOpinionConcernPhrase(concern: string): boolean {
  try {
    requireOpinionConcern(concern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and normalize a noun-phrase concern for {@link formatOpinion}.
 * Throws when the value is empty, too long, sentence-like, or a finite clause.
 *
 * @example
 * ```ts
 * requireOpinionConcern("direct process termination below the application boundary");
 * // throws: requireOpinionConcern("commands replace inherited context with context.Background");
 * ```
 */
export function requireOpinionConcern(concern: string, label = "opinion concern"): string {
  if (typeof concern !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const trimmed = concern.trim();
  if (trimmed === "") {
    throw new Error(
      `${label} must be a non-empty noun phrase suitable after "address …" (for example "direct process termination").`,
    );
  }
  // Reject sentence punctuation before any stripping so "foo." does not bypass
  // the noun-phrase contract by normalizing to "foo".
  if (/[.!?]/.test(trimmed)) {
    throw new Error(`${label} must be a noun phrase, not a sentence (remove ".!?").`);
  }
  const normalized = lowercaseFirst(normalizeParagraph(trimmed));
  if (!isNonEmptyString(normalized)) {
    throw new Error(
      `${label} must be a non-empty noun phrase suitable after "address …" (for example "direct process termination").`,
    );
  }
  if (normalized.length > MAX_OPINION_CONCERN_LENGTH) {
    throw new Error(
      `${label} must be at most ${MAX_OPINION_CONCERN_LENGTH} characters (got ${normalized.length}).`,
    );
  }
  if (looksLikeFiniteClause(normalized)) {
    throw new Error(
      `${label} must be a noun phrase (for example "direct process termination"), not a clause (for example "commands replace inherited context").`,
    );
  }
  if (looksLikeHeadlineNotNounPhrase(normalized)) {
    throw new Error(
      `${label} must be a short noun phrase, not a headline (for example use "silent no-op v1 paths", not "api get/post/patch/put silently no-op for v1 paths").`,
    );
  }
  return normalized;
}

/** Prompt used by {@link rewriteOpinionConcern} / {@link ContextualReviewModel.concern}. */
export const OPINION_CONCERN_REWRITE_PROMPT = `Rewrite the input text into a short noun phrase suitable after the words "I would address".

Rules:
- Return only a noun phrase (for example "direct process termination below the application boundary" or "forced exit code 124")
- Do not write a full sentence or finite clause (not "commands replace inherited context")
- No terminal punctuation (.!?)
- No dotted code identifiers (not "os.Exit" or "context.Background")
- No slash-separated method lists (not "get/post/patch/put")
- At most ${MAX_OPINION_CONCERN_LENGTH} characters
- Prefer the primary engineering concern over command inventories or headlines`;

/** JSON Schema for structured concern rewrite output. */
export const OPINION_CONCERN_REWRITE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["concern"],
  properties: {
    concern: {
      type: "string",
      minLength: 3,
      maxLength: MAX_OPINION_CONCERN_LENGTH,
    },
  },
};

const DEFAULT_CONCERN_REWRITE_BUDGET: Required<ModelReviewBudget> = {
  maximumOutputTokens: 128,
  timeoutMs: 30_000,
};

/**
 * Ensure `text` is a validated noun-phrase concern. Already-valid phrases pass
 * through with no model call; otherwise rewrite via the CLI model broker.
 */
export async function rewriteOpinionConcern(
  model: ReviewModel,
  request: ModelConcernRequest,
): Promise<ModelConcernResult> {
  if (typeof request !== "object" || request === null) {
    throw new ModelReviewError("Model concern request must be an object.", {
      code: "invalid_model_request",
    });
  }
  if (typeof request.text !== "string") {
    throw new ModelReviewError("Model concern text must be a string.", {
      code: "invalid_model_request",
    });
  }
  const text = request.text.trim();
  if (text === "") {
    throw new ModelReviewError("Model concern text must be a non-empty string.", {
      code: "invalid_model_request",
    });
  }
  if (isOpinionConcernPhrase(text)) {
    return {
      concern: requireOpinionConcern(text),
      rewritten: false,
      provider: "local",
      model: "passthrough",
    };
  }

  const maxAttempts =
    request.maxAttempts === undefined
      ? 2
      : requirePositiveInteger(request.maxAttempts, "maxAttempts", 4);
  const budget = {
    maximumOutputTokens:
      request.budget?.maximumOutputTokens ?? DEFAULT_CONCERN_REWRITE_BUDGET.maximumOutputTokens,
    timeoutMs: request.budget?.timeoutMs ?? DEFAULT_CONCERN_REWRITE_BUDGET.timeoutMs,
  };

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt =
      attempt === 1
        ? OPINION_CONCERN_REWRITE_PROMPT
        : `${OPINION_CONCERN_REWRITE_PROMPT}

Previous attempt was rejected: ${lastError ?? "invalid noun phrase"}.
Return only a pure noun phrase that passes validation.`;

    const result = await model.review<{ concern: string }>({
      prompt,
      input: {
        text,
        ...(lastError === undefined ? {} : { previousError: lastError }),
      },
      schema: OPINION_CONCERN_REWRITE_SCHEMA,
      budget,
    });

    try {
      const concern = requireOpinionConcern(result.output.concern, "model concern rewrite");
      return {
        concern,
        rewritten: true,
        provider: result.provider,
        model: result.model,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new ModelReviewError(
    `Model failed to produce a valid opinion concern after ${maxAttempts} attempts${
      lastError === undefined ? "" : `: ${lastError}`
    }.`,
    { code: "invalid_opinion_concern" },
  );
}

/**
 * Build a posture-aware opinion, rewriting free-form concerns via the model when needed.
 *
 * Prefer this over {@link formatOpinion} when the concern may be a model title or clause.
 * Already-valid noun phrases do not trigger a broker call.
 */
export async function formatOpinionAsync(
  options: FormatOpinionAsyncOptions,
): Promise<ReviewOpinion> {
  if (typeof options.ship !== "boolean") {
    throw new Error("formatOpinionAsync requires a boolean ship decision.");
  }
  if (options.model === undefined || options.model === null) {
    throw new Error("formatOpinionAsync requires a model.");
  }

  const remainingCount = options.remainingCount ?? 0;
  if (remainingCount > 1 || options.concern === undefined || options.concern.trim() === "") {
    return formatOpinion({
      ship: options.ship,
      ...(options.concern === undefined ? {} : { concern: options.concern }),
      remainingCount,
      change: options.change,
      posture: options.posture,
    });
  }

  if (isOpinionConcernPhrase(options.concern)) {
    return formatOpinion({
      ship: options.ship,
      concern: options.concern,
      remainingCount,
      change: options.change,
      posture: options.posture,
    });
  }

  const rewritten = await rewriteOpinionConcern(options.model, {
    text: options.concern,
    ...(options.concernBudget === undefined ? {} : { budget: options.concernBudget }),
  });
  return formatOpinion({
    ship: options.ship,
    concern: rewritten.concern,
    remainingCount,
    change: options.change,
    posture: options.posture,
  });
}

/** Attach {@link ContextualReviewModel.concern} on top of any injectable ReviewModel. */
export function enhanceReviewModel(
  model: ReviewModel,
  repositoryRoot?: string,
  change?: ChangeContext | null,
): ContextualReviewModel {
  return {
    review: (request) =>
      request.tools?.repository === undefined
        ? reviewWithValidation(model, request)
        : reviewWithRepositoryTools(model, repositoryRoot, request, change),
    concern: (request) => rewriteOpinionConcern(model, request),
  };
}

function requirePositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ModelReviewError(`${name} must be an integer from 1 through ${maximum}.`, {
      code: "invalid_model_request",
    });
  }
  return value;
}

/**
 * Build a posture-aware review opinion from a ship decision and optional concern.
 *
 * Domain adversaries should pass judgment (ship + **noun-phrase** concern) and let
 * the SDK choose merge/commit/shipping language from the runner-resolved change scope.
 * Concerns are validated with {@link requireOpinionConcern}.
 *
 * @example
 * ```ts
 * ctx.review.opinion(
 *   formatOpinion({
 *     ship: false,
 *     concern: "direct process termination below the application boundary",
 *     change: ctx.change,
 *   }),
 * );
 * ```
 */
export function formatOpinion(options: FormatOpinionOptions): ReviewOpinion {
  if (typeof options.ship !== "boolean") {
    throw new Error("formatOpinion requires a boolean ship decision.");
  }

  const posture =
    options.posture === undefined
      ? resolveReviewPosture(options.change ?? null)
      : parseReviewPosture(options.posture, "formatOpinion posture");
  const deadline = opinionDeadline(posture);
  const remainingCount = options.remainingCount ?? 0;

  if (remainingCount > 1) {
    return {
      ship: options.ship,
      summary: `I would address the remaining findings ${deadline}.`,
    };
  }

  const concern =
    options.concern === undefined || options.concern.trim() === ""
      ? undefined
      : requireOpinionConcern(options.concern, "formatOpinion concern");

  if (options.ship) {
    if (concern === undefined) {
      return { ship: true, summary: opinionApproveAsIs(posture) };
    }
    return {
      ship: true,
      summary: opinionApproveWithFollowUp(posture, concern),
    };
  }

  if (concern === undefined) {
    return {
      ship: false,
      summary: `I would address the remaining findings ${deadline}.`,
    };
  }

  return {
    ship: false,
    summary: `I would address ${concern} ${deadline}.`,
  };
}

/**
 * True when the phrase looks like a finite clause (subject + finite verb + complement),
 * not a noun phrase. Used to reject bad formatOpinion concerns.
 */
function looksLikeFiniteClause(concern: string): boolean {
  // Finite verb with a following token (shared with concernClause).
  if (
    /\b(?:allows|are|binds|blocks|builds|bypasses|calls|can|closes|contains|copies|could|creates|detaches|did|discards|do|does|exits|exposes|fails|forks|has|have|ignores|includes|installs|is|kills|lacks|leaks|leaves|logs|maps|may|might|must|opens|panics|prints|reads|references|relies|replaces|requires|returns|runs|skips|spawns|starts|terminates|throws|uses|was|were|writes)\b\s+\S+/i.test(
      concern,
    )
  ) {
    return true;
  }
  // Present-tense verbs that often appear mid-title ("commands replace inherited context").
  // Do not match past-participial adjectives at the start ("discarded command errors").
  if (
    /(?:^|\s)(?:replace|replaces|discard|discards|force|forces|override|overrides|cause|causes|prevent|prevents|block|blocks|break|breaks|succeed|succeeds|fail|fails|mix|mixes|omit|omits|ignore|ignores)\s+\S+/i.test(
      concern,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Headlines that are not finite clauses but still read poorly after "I would address …".
 * Example: "api get/post/patch/put silently no-op for v1 paths".
 */
function looksLikeHeadlineNotNounPhrase(concern: string): boolean {
  // Multi-segment slash lists (method inventories): get/post/patch
  if ((concern.match(/\//g) ?? []).length >= 2) {
    return true;
  }
  if (/(?:^|\s)(?:get|post|patch|put|delete)\/(?:get|post|patch|put|delete)/i.test(concern)) {
    return true;
  }
  // Adverb fragments that belong in titles, not noun phrases.
  if (/\bsilently\b/i.test(concern)) {
    return true;
  }
  // Trailing participial / relative residue after a comma (headline shape).
  // Allow list noun phrases such as "cancellation, exit codes, and stream issues".
  if (
    /,\s+(?:breaking|causing|preventing|leaving|blocking|forcing|overriding|so\b|which\b|and then\b)/i.test(
      concern,
    )
  ) {
    return true;
  }
  return false;
}

function parseReviewPosture(value: unknown, label: string): ReviewPosture {
  if (value === "repository" || value === "change" || value === "worktree") {
    return value;
  }
  throw new Error(`${label} must be one of repository, change, or worktree.`);
}

function opinionDeadline(posture: ReviewPosture): string {
  switch (posture) {
    case "worktree":
      return "before committing";
    case "change":
      return "before merging";
    case "repository":
      return "before shipping";
    default: {
      const _exhaustive: never = posture;
      throw new Error(`unsupported review posture: ${String(_exhaustive)}`);
    }
  }
}

function opinionApproveAsIs(posture: ReviewPosture): string {
  switch (posture) {
    case "worktree":
      return "I would land these local changes as-is.";
    case "change":
      return "I would merge this change as-is.";
    case "repository":
      return "I would ship this as-is.";
    default: {
      const _exhaustive: never = posture;
      throw new Error(`unsupported review posture: ${String(_exhaustive)}`);
    }
  }
}

function opinionApproveWithFollowUp(posture: ReviewPosture, concern: string): string {
  switch (posture) {
    case "worktree":
      return `I would land these local changes and address ${concern} as follow-up hardening.`;
    case "change":
      return `I would merge this change and address ${concern} as follow-up hardening.`;
    case "repository":
      return `I would ship this as-is. Addressing ${concern} is the only improvement I would recommend before shipping.`;
    default: {
      const _exhaustive: never = posture;
      throw new Error(`unsupported review posture: ${String(_exhaustive)}`);
    }
  }
}

function synthesizeOpinion(
  findings: ReviewFinding[],
  change: ChangeContext | null,
): ReviewOpinion | undefined {
  const posture = resolveReviewPosture(change);
  const deadline = opinionDeadline(posture);

  if (findings.length === 0) {
    return formatOpinion({ ship: true, posture });
  }

  const highestSeverity = highestFindingSeverity(findings);
  const ship = severityWeight(highestSeverity) < severityWeight(Severity.High);

  if (findings.length > 1) {
    return formatOpinion({ ship, remainingCount: findings.length, posture });
  }

  const finding = findings[0];
  const improvement = finding === undefined ? "Addressing the finding" : improvementPhrase(finding);
  return {
    ship,
    summary: ship
      ? `${opinionApproveAsIs(posture)} ${improvement} is the only improvement I would recommend ${deadline}.`
      : `${improvement} is the most important improvement to address ${deadline}.`,
  };
}

function deduplicateScores(scores: ReviewScore[]): ReviewScore[] {
  const seen = new Set<string>();
  const result: ReviewScore[] = [];

  for (const score of scores) {
    if (!seen.has(score.key)) {
      seen.add(score.key);
      result.push(score);
    }
  }

  return result.sort((left, right) => compareStrings(left.key, right.key));
}

function scoreToReviewNote(score: ReviewScore): ReviewNote {
  return {
    key: `score.${score.key}`,
    summary: formatScore(score),
    metadata: {
      kind: "score",
      score: omitUndefined({
        key: score.key,
        label: score.label,
        score: score.score,
        max: score.max,
        summary: score.summary,
      }),
    },
  };
}

function isScoreReviewNote(note: ReviewNote): boolean {
  return note.metadata?.kind === "score" && isRecord(note.metadata.score);
}

function observationToEvidence(observation: ObservationInit): Evidence {
  const data = isRecord(observation.evidence)
    ? observation.evidence
    : observation.evidence === undefined
      ? undefined
      : { evidence: observation.evidence };
  const message = isRecord(observation.evidence)
    ? structuredEvidenceMessage(observation.evidence)
    : stringFromUnknown(observation.evidence);
  const snippet = isRecord(observation.evidence)
    ? (stringFromUnknown(observation.evidence.snippet) ??
      stringFromUnknown(observation.evidence.instruction))
    : observation.location?.snippet;

  return omitUndefined({
    location: normalizeEvidence(observation.location ?? {}).location,
    label: observation.location?.label ?? message,
    message: observation.location?.message ?? message,
    snippet,
    data,
  });
}

function structuredEvidenceMessage(evidence: Record<string, unknown>): string | undefined {
  const explicitMessage = stringFromUnknown(evidence.message);
  if (explicitMessage !== undefined) {
    return explicitMessage;
  }

  const label = stringFromUnknown(evidence.label) ?? stringFromUnknown(evidence.name);
  if (label !== undefined) {
    return label;
  }

  return stringFromUnknown(evidence.summary) ?? stringFromUnknown(evidence.instruction);
}

function synthesizeObservationTitle(
  title: ObservationTitle,
  count: number,
  groupedTitle: string | undefined,
): string {
  if (typeof title === "string") {
    return count > 1 && groupedTitle !== undefined ? groupedTitle : title;
  }
  return count > 1 ? title.plural : title.singular;
}

function summarizeObservationGroup(group: ObservationInit[]): string {
  const first = group[0];
  if (first === undefined) {
    throw new Error("Cannot summarize an empty observation group.");
  }

  if (first.summary !== undefined) {
    if (typeof first.summary === "string") {
      return normalizeParagraph(renderObservationTemplate(first.summary, group));
    }
    const template = group.length > 1 ? first.summary.grouped : first.summary.singular;
    if (template !== undefined) {
      return normalizeParagraph(renderObservationTemplate(template, group));
    }
  }

  const recommendation =
    typeof first.recommendation === "string" ? undefined : first.recommendation?.summary;
  if (group.length === 1) {
    return recommendation ?? synthesizeObservationTitle(first.title, 1, first.groupedTitle);
  }
  return `${group.length} related observations were reported for ${first.subject}.`;
}

function synthesizeRecommendation(group: ObservationInit[]): string {
  const recommendations = uniqueStrings(
    group.flatMap((observation) => {
      if (typeof observation.recommendation === "string") {
        return [observation.recommendation];
      }
      if (observation.recommendation !== undefined) {
        return [
          joinRecommendation(
            observation.recommendation.summary,
            observation.recommendation.details,
          ),
        ];
      }
      return [];
    }),
  );

  return recommendations.map(normalizeParagraph).join("\n\n");
}

function joinRecommendation(summary: string, details: string | undefined): string {
  if (!isNonEmptyString(details)) {
    return summary;
  }

  const compactSummary = trimTrailingSentencePunctuation(summary);
  const compactDetails = trimTrailingSentencePunctuation(details);

  if (/^use\s+/i.test(compactDetails)) {
    return `${compactSummary} and ${lowercaseFirst(compactDetails)}.`;
  }

  return `${compactSummary}. ${compactDetails}.`;
}

function defaultObservationGroupKey(
  observation: ObservationInit,
  rule: RuleDefinition | undefined,
): string {
  const groupBy = observation.groupBy ?? rule?.groupBy;
  if (groupBy !== undefined && groupBy.length > 0) {
    return groupBy
      .map((field) => `${field}:${stringFromUnknown(observationValue(observation, field)) ?? ""}`)
      .join("|");
  }
  return `${observation.ruleId}:${observation.subject}:${observation.category ?? rule?.category ?? "general"}`;
}

function renderObservationTemplate(template: string, group: ObservationInit[]): string {
  const values = observationTemplateValues(group);
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key: string) => {
    return values[key] ?? match;
  });
}

function observationTemplateValues(group: ObservationInit[]): Record<string, string> {
  const first = group[0];
  const subjects = uniqueStrings(group.map((observation) => observation.subject));
  const locations = uniqueStrings(group.map(formatObservationLocation).filter(isNonEmptyString));

  return omitUndefined({
    count: numberWord(group.length),
    location: locations[0],
    locations: joinHumanList(locations),
    subject: first?.subject,
    subjects: joinHumanList(subjects),
  });
}

function observationValue(observation: ObservationInit, field: string): unknown {
  if (field.includes(".")) {
    return field.split(".").reduce<unknown>((value, part) => {
      return isRecord(value) ? value[part] : undefined;
    }, observation);
  }
  return (observation as unknown as Record<string, unknown>)[field];
}

function formatObservationLocation(observation: ObservationInit): string | undefined {
  if (observation.location?.file === undefined) {
    return undefined;
  }
  if (observation.location.line === undefined) {
    return observation.location.file;
  }
  return `${observation.location.file}:${observation.location.line}`;
}

function joinHumanList(values: string[]): string {
  if (values.length <= 2) {
    return values.join(" and ");
  }
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function highestRisk(findings: ReviewFinding[]): ReviewAssessment["risk"] {
  const severity = highestFindingSeverity(findings);
  if (severity === Severity.Info) {
    return "none";
  }
  return severity;
}

function highestFindingSeverity(findings: ReviewFinding[]): Severity {
  return aggregateSeverity(
    findings.map((finding) => finding.severity),
    "highest",
  );
}

function findingConcern(finding: ReviewFinding): string {
  return lowercaseFirst(trimTrailingSentencePunctuation(finding.title));
}

function improvementPhrase(finding: ReviewFinding): string {
  const recommendation = recommendationSubject(finding.recommendation);
  if (recommendation !== undefined) {
    return recommendation;
  }

  return `Addressing ${findingConcern(finding)}`;
}

function recommendationSubject(recommendation: string | undefined): string | undefined {
  if (recommendation === undefined) {
    return undefined;
  }

  const normalized = trimTrailingSentencePunctuation(normalizeParagraph(recommendation));
  const firstClause = normalized.split(/\s+(?:and|when|where|with)\s+/i)[0]?.trim();
  if (!isNonEmptyString(firstClause)) {
    return undefined;
  }

  return gerundPhrase(firstClause);
}

function gerundPhrase(phrase: string): string {
  const words = phrase.split(/\s+/);
  const first = words[0];
  if (first === undefined) {
    return phrase;
  }

  return capitalize([toGerund(first), ...words.slice(1)].join(" "));
}

function toGerund(verb: string): string {
  const lower = verb.toLowerCase();
  const irregular: Record<string, string> = {
    pin: "pinning",
    run: "running",
    use: "using",
  };
  const known = irregular[lower];
  if (known !== undefined) {
    return known;
  }
  if (lower.endsWith("e") && !lower.endsWith("ee")) {
    return `${lower.slice(0, -1)}ing`;
  }
  return `${lower}ing`;
}

function normalizeSemanticText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !semanticStopWords.has(word))
    .join(" ");
}

function trimTrailingWord(value: string | undefined, word: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const pattern = new RegExp(`\\s+${word}$`, "i");
  const trimmed = value.replace(pattern, "").trim();
  return trimmed.length > 0 ? trimmed : value;
}

function numberWord(value: number): string {
  return (
    {
      1: "One",
      2: "Two",
      3: "Three",
      4: "Four",
      5: "Five",
      6: "Six",
      7: "Seven",
      8: "Eight",
      9: "Nine",
      10: "Ten",
    }[value] ?? String(value)
  );
}

function calibrateFindingSeverity(finding: ReviewFinding, policy: ReviewPolicy): ReviewFinding {
  const override =
    policy.severityOverrides?.[finding.ruleId ?? ""] ??
    policy.severityOverrides?.[finding.groupKey ?? ""];

  return override === undefined ? finding : { ...finding, severity: override };
}

function scoreFinding(finding: ReviewFinding): number {
  const locationScore = Math.min(finding.evidence.length, 5) * 3;
  const remediationScore = finding.remediation?.complexity === "trivial" ? 3 : 0;
  return (
    severityWeight(finding.severity) * 10 +
    confidenceWeight(finding.confidence) * 12 +
    locationScore +
    remediationScore
  );
}

function severityWeight(severity: Severity): number {
  switch (severity) {
    case Severity.Critical:
      return 5;
    case Severity.High:
      return 4;
    case Severity.Medium:
      return 3;
    case Severity.Low:
      return 2;
    case Severity.Info:
      return 1;
  }
}

function confidenceWeight(confidence: Confidence): number {
  switch (confidence) {
    case Confidence.High:
      return 3;
    case Confidence.Medium:
      return 2;
    case Confidence.Low:
      return 1;
  }
}

function aggregateSeverity(values: Severity[], strategy: SeverityAggregation): Severity {
  const sorted = [...values].sort((left, right) => severityWeight(right) - severityWeight(left));
  if (strategy === "lowest") {
    return sorted.at(-1) ?? Severity.Info;
  }
  return sorted[0] ?? Severity.Info;
}

function aggregateConfidence(values: Confidence[], strategy: ConfidenceAggregation): Confidence {
  if (values.length === 0) {
    return Confidence.Low;
  }

  if (strategy === "minimum") {
    return (
      [...values].sort((left, right) => confidenceWeight(left) - confidenceWeight(right))[0] ??
      Confidence.Low
    );
  }

  if (strategy === "average") {
    const average =
      values.reduce((total, confidence) => total + confidenceNumericValue(confidence), 0) /
      values.length;
    return normalizeConfidence(average);
  }

  return (
    [...values].sort((left, right) => confidenceWeight(right) - confidenceWeight(left))[0] ??
    Confidence.Low
  );
}

function confidenceNumericValue(confidence: Confidence): number {
  switch (confidence) {
    case Confidence.High:
      return 0.95;
    case Confidence.Medium:
      return 0.72;
    case Confidence.Low:
      return 0.3;
  }
}

function stableId(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `finding-${hash.toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(isNonEmptyString))].sort(compareStrings);
}

function assertObservationInit(
  value: ObservationInit,
  source: string,
  registry: RuleRegistry,
): void {
  requireString(value.ruleId, `${source}.ruleId`);
  requireString(value.subject, `${source}.subject`);
  requireObservationTitle(value.title, `${source}.title`);
  const rule = registry.lookup(value.ruleId);
  if (value.category === undefined && rule?.category === undefined) {
    throw new Error(`${source}.category is required when rule.category is not defined.`);
  }
  optionalString(value.category, `${source}.category`);
  if (value.severity === undefined && rule?.defaultSeverity === undefined) {
    throw new Error(`${source}.severity is required when rule.defaultSeverity is not defined.`);
  }
  if (value.severity !== undefined && !isSeverity(value.severity)) {
    throw new Error(`${source}.severity must be one of info, low, medium, high, critical.`);
  }
  const ruleConfidence = rule?.defaultConfidence;
  if (value.confidence === undefined && ruleConfidence === undefined) {
    throw new Error(`${source}.confidence is required when rule.defaultConfidence is not defined.`);
  }
  if (value.confidence !== undefined) {
    normalizeConfidence(value.confidence);
  }
  optionalObservationSummary(value.summary, `${source}.summary`);
  optionalEvidence(value.location, `${source}.location`);
  optionalString(value.groupKey, `${source}.groupKey`);
  optionalStringArray(value.groupBy, `${source}.groupBy`);
  optionalStringArray(value.tags, `${source}.tags`);
}

function assertFindingInput(value: FindingInput, source: string): void {
  requireString(value.title, `${source}.title`);
  requireString(value.category, `${source}.category`);
  requireString(value.summary, `${source}.summary`);
  if (!isSeverity(value.severity)) {
    throw new Error(`${source}.severity must be one of info, low, medium, high, critical.`);
  }
  normalizeConfidence(value.confidence);
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    throw new Error(`${source}.evidence must contain at least one evidence item.`);
  }
  for (const [index, evidence] of value.evidence.entries()) {
    optionalEvidence(evidence, `${source}.evidence[${index}]`);
  }
  optionalString(value.id, `${source}.id`);
  optionalString(value.ruleId, `${source}.ruleId`);
  optionalString(value.groupKey, `${source}.groupKey`);
  optionalStringArray(value.tags, `${source}.tags`);
  optionalRemediation(value.remediation, `${source}.remediation`);
}

function assertReviewNote(value: ReviewNoteInput, source: string): void {
  requireString(value.key, `${source}.key`);
  requireString(value.summary, `${source}.summary`);
  if (value.evidence !== undefined) {
    for (const [index, evidence] of value.evidence.entries()) {
      optionalEvidence(evidence, `${source}.evidence[${index}]`);
    }
  }
}

function assertReviewScore(value: ReviewScore): void {
  requireString(value.key, "ctx.review.score.key");
  if (typeof value.score !== "number" || !Number.isFinite(value.score)) {
    throw new Error("ctx.review.score.score must be a finite number.");
  }
  if (value.max !== undefined && (typeof value.max !== "number" || !Number.isFinite(value.max))) {
    throw new Error("ctx.review.score.max must be a finite number.");
  }
  if (value.score < 0) {
    throw new Error("ctx.review.score.score must be greater than or equal to zero.");
  }
  if (value.max !== undefined && (value.max <= 0 || value.score > value.max)) {
    throw new Error("ctx.review.score.max must be positive and no smaller than score.");
  }
  optionalString(value.label, "ctx.review.score.label");
  optionalString(value.summary, "ctx.review.score.summary");
}

function assertAssessment(value: ReviewAssessment): void {
  if (!["none", "low", "medium", "high", "critical"].includes(value.risk)) {
    throw new Error("ctx.review.assessment.risk must be one of none, low, medium, high, critical.");
  }
  optionalString(value.summary, "ctx.review.assessment.summary");
}

function assertOpinion(value: ReviewOpinion): void {
  requireString(value.summary, "ctx.review.opinion.summary");
}

function assertRuleDefinition(rule: RuleDefinition): void {
  requireString(rule.id, "rule.id");
  optionalString(rule.category, "rule.category");
  if (rule.defaultSeverity !== undefined && !isSeverity(rule.defaultSeverity)) {
    throw new Error("rule.defaultSeverity must be one of info, low, medium, high, critical.");
  }
  if (rule.defaultConfidence !== undefined) {
    normalizeConfidence(rule.defaultConfidence);
  }
  optionalStringArray(rule.groupBy, "rule.groupBy");
  if (rule.aggregate !== undefined && typeof rule.aggregate !== "function") {
    throw new Error("rule.aggregate must be a function.");
  }
}

function assertReviewPolicy(policy: ReviewPolicy, source: string): void {
  if (policy.minimumConfidence !== undefined && !isConfidence(policy.minimumConfidence)) {
    throw new Error(`${source}.minimumConfidence must be one of low, medium, high.`);
  }
  if (
    policy.maximumFindings !== undefined &&
    (!Number.isInteger(policy.maximumFindings) || policy.maximumFindings < 0)
  ) {
    throw new Error(`${source}.maximumFindings must be a non-negative integer.`);
  }
  if (policy.confidenceThresholds !== undefined) {
    const { medium, high } = policy.confidenceThresholds;
    if (medium < 0 || high > 1 || medium > high) {
      throw new Error(`${source}.confidenceThresholds must satisfy 0 <= medium <= high <= 1.`);
    }
  }
  for (const [ruleId, severity] of Object.entries(policy.severityOverrides ?? {})) {
    if (!isSeverity(severity)) {
      throw new Error(`${source}.severityOverrides["${ruleId}"] is not a valid severity.`);
    }
  }
}

function optionalRemediation(value: Remediation | undefined, field: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  if (
    value.complexity !== undefined &&
    (typeof value.complexity !== "string" ||
      !["trivial", "small", "medium", "large", "architectural"].includes(value.complexity))
  ) {
    throw new Error(`${field}.complexity is invalid.`);
  }
}

function requireObservationTitle(value: ObservationTitle, field: string): void {
  if (typeof value === "string") {
    requireString(value, field);
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`${field} must be a string or { singular, plural }.`);
  }
  requireString(value.singular, `${field}.singular`);
  requireString(value.plural, `${field}.plural`);
}

function optionalObservationSummary(value: ObservationSummary | undefined, field: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    optionalString(value, field);
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`${field} must be a string or { singular, grouped }.`);
  }
  optionalString(value.singular, `${field}.singular`);
  optionalString(value.grouped, `${field}.grouped`);
}

function optionalEvidence(value: EvidenceInput | Evidence | undefined, field: string): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const input = value as EvidenceInput;
  optionalString(input.file, `${field}.file`);
  optionalPositiveInteger(input.line, `${field}.line`);
  optionalPositiveInteger(input.endLine, `${field}.endLine`);
  optionalString(value.message, `${field}.message`);
  optionalString(value.snippet, `${field}.snippet`);
  optionalString(value.label, `${field}.label`);
  if (value.location !== undefined) {
    if (!isRecord(value.location)) {
      throw new Error(`${field}.location must be an object.`);
    }
    optionalString(value.location.file, `${field}.location.file`);
    optionalPositiveInteger(value.location.line, `${field}.location.line`);
    optionalPositiveInteger(value.location.endLine, `${field}.location.endLine`);
  }
  const line = value.location?.line ?? input.line;
  const endLine = value.location?.endLine ?? input.endLine;
  if (endLine !== undefined && line === undefined) {
    throw new Error(`${field}.endLine requires line.`);
  }
  if (endLine !== undefined && line !== undefined && endLine < line) {
    throw new Error(`${field}.endLine must not precede line.`);
  }
  if (value.data !== undefined && !isRecord(value.data)) {
    throw new Error(`${field}.data must be an object.`);
  }
  if (input.metadata !== undefined && !isRecord(input.metadata)) {
    throw new Error(`${field}.metadata must be an object.`);
  }
}

function writeLog(level: "debug" | "info" | "warn" | "error", message: unknown): void {
  process.stderr.write(`[adversary] ${level}: ${String(message)}\n`);
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return ["1", "true", "TRUE", "yes", "YES"].includes(value);
}

function isVerbose(): boolean {
  return verboseValues.has(process.env.ADVERSARY_VERBOSE ?? "");
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
}

function optionalStringArray(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    throw new Error(`${field} must be an array of strings.`);
  }
}

function optionalPositiveInteger(value: unknown, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1)) {
    throw new Error(`${field} must be a positive integer.`);
  }
}

function isConfidence(value: unknown): value is Confidence {
  return value === Confidence.Low || value === Confidence.Medium || value === Confidence.High;
}

function isSeverity(value: unknown): value is Severity {
  return (
    value === Severity.Info ||
    value === Severity.Low ||
    value === Severity.Medium ||
    value === Severity.High ||
    value === Severity.Critical
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

const semanticStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "from",
  "in",
  "is",
  "of",
  "the",
  "to",
  "uses",
  "using",
]);

function formatEvidenceLocation(evidence: Evidence): string {
  const file = evidence.location?.file;
  const line = evidence.location?.line;
  const endLine = evidence.location?.endLine;

  if (file === undefined) {
    return "";
  }
  if (line !== undefined && endLine !== undefined) {
    return `${file}:${line}-${endLine}`;
  }
  if (line !== undefined) {
    return `${file}:${line}`;
  }
  return file;
}

function formatEvidenceLines(evidence: Evidence): string[] {
  const location = formatEvidenceLocation(evidence);
  const label = evidence.label ?? evidence.message;
  const firstLine =
    location.length > 0 && label !== undefined
      ? `- ${location} — ${label}`
      : `- ${location.length > 0 ? location : (label ?? "Evidence")}`;
  const lines = [firstLine];

  if (evidence.snippet !== undefined) {
    lines.push(`  ${evidence.snippet}`);
  }

  return lines;
}

function formatScore(score: ReviewScore): string {
  const label = score.label ?? score.key;
  const max = score.max ?? 10;
  const summary = score.summary === undefined ? "" : ` - ${normalizeParagraph(score.summary)}`;
  return `${label}: ${score.score} / ${max}${summary}`;
}

function normalizeParagraph(value: string): string {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
}

function trimTrailingSentencePunctuation(value: string): string {
  return value.trim().replace(/[.!?]+$/g, "");
}

function lowercaseFirst(value: string): string {
  return `${value.slice(0, 1).toLowerCase()}${value.slice(1)}`;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}
