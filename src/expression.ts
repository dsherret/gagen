// types that step/job/workflow will reference back to
export type ExpressionSource = { readonly id: string };

const EMPTY_SOURCES: ReadonlySet<ExpressionSource> = new Set();

/** Values that can appear in ternary `.then()` / `.else()` branches. */
export type TernaryValue = string | number | boolean | ExpressionValue;

/**
 * An expression that resolves to a value inside a GitHub Actions workflow.
 * Supports fluent comparison methods that produce Conditions.
 */
export class ExpressionValue {
  readonly #expression: string;
  readonly source: ExpressionSource | undefined;
  readonly #allSources: ReadonlySet<ExpressionSource>;

  constructor(
    expression: string,
    source?: ExpressionSource | ReadonlySet<ExpressionSource>,
  ) {
    this.#expression = expression;
    if (source instanceof Set) {
      this.source = undefined;
      this.#allSources = source as ReadonlySet<ExpressionSource>;
    } else {
      const s = source as ExpressionSource | undefined;
      this.source = s;
      this.#allSources = s ? new Set([s]) : EMPTY_SOURCES;
    }
  }

  /** all expression sources referenced by this value */
  get allSources(): ReadonlySet<ExpressionSource> {
    return this.#allSources;
  }

  /** raw expression text without `${{ }}` wrapping */
  get expression(): string {
    return this.#expression;
  }

  equals(value: string | number | boolean): Condition {
    return new ComparisonCondition(
      this.#expression,
      "==",
      value,
      sourcesFrom(this),
    );
  }

  notEquals(value: string | number | boolean): Condition {
    return new ComparisonCondition(
      this.#expression,
      "!=",
      value,
      sourcesFrom(this),
    );
  }

  startsWith(prefix: string): Condition {
    return new FunctionCallCondition(
      "startsWith",
      [this.#expression, formatLiteral(prefix)],
      sourcesFrom(this),
    );
  }

  contains(substring: string): Condition {
    return new FunctionCallCondition(
      "contains",
      [this.#expression, formatLiteral(substring)],
      sourcesFrom(this),
    );
  }

  not(): Condition {
    return new RawCondition(`!(${this.#expression})`, sourcesFrom(this));
  }

  /** wrap in `${{ }}` for use in YAML */
  toString(): string {
    return `\${{ ${this.#expression} }}`;
  }
}

/**
 * A boolean condition used in `if` fields. Supports fluent `.and()`, `.or()`,
 * `.not()` composition. Tracks all ExpressionSources referenced so that
 * dependencies can be inferred automatically.
 */
export abstract class Condition {
  readonly sources: ReadonlySet<ExpressionSource>;

  constructor(sources: ReadonlySet<ExpressionSource>) {
    this.sources = sources;
  }

  and(other: Condition | boolean): Condition {
    if (other === true) return this;
    if (other === false) return new RawCondition("false", this.sources);
    return new LogicalCondition("&&", this, other, unionSources(this, other));
  }

  or(other: Condition | boolean): Condition {
    if (other === false) return this;
    if (other === true) return new RawCondition("true", this.sources);
    return new LogicalCondition("||", this, other, unionSources(this, other));
  }

  not(): Condition {
    return new NotCondition(this, this.sources);
  }

  /**
   * Starts a ternary expression: `condition && trueValue || falseValue`.
   *
   * ```ts
   * const runner = os.equals("linux").then("ubuntu-latest").else("macos-latest");
   * // => matrix.os == 'linux' && 'ubuntu-latest' || 'macos-latest'
   * ```
   */
  then(value: TernaryValue): ThenBuilder {
    return new ThenBuilder([{ condition: this, value }], this.sources);
  }

  /**
   * Returns the flat AND terms of this condition. Used by condition
   * simplification to detect absorption (A || A && B → A).
   */
  getAndTerms(): string[] {
    return [this.toExpression()];
  }

  /** returns the flat AND children of this condition as Condition objects */
  flattenAnd(): Condition[] {
    return [this];
  }

  /** returns the flat OR children of this condition as Condition objects */
  flattenOr(): Condition[] {
    return [this];
  }

  /** render without `${{ }}` wrapping */
  abstract toExpression(): string;

  /** render wrapped in `${{ }}` for YAML `if` fields */
  toString(): string {
    return `\${{ ${this.toExpression()} }}`;
  }
}

// --- concrete condition types ---

/** `left == right` or `left != right` */
export class ComparisonCondition extends Condition {
  readonly #left: string;
  readonly #op: "==" | "!=";
  readonly #right: string | number | boolean;

  constructor(
    left: string,
    op: "==" | "!=",
    right: string | number | boolean,
    sources: ReadonlySet<ExpressionSource>,
  ) {
    super(sources);
    this.#left = left;
    this.#op = op;
    this.#right = right;
  }

  override not(): Condition {
    return new ComparisonCondition(
      this.#left,
      this.#op === "==" ? "!=" : "==",
      this.#right,
      this.sources,
    );
  }

  toExpression(): string {
    return `${this.#left} ${this.#op} ${formatLiteral(this.#right)}`;
  }
}

/** `fn(arg1, arg2, ...)` */
export class FunctionCallCondition extends Condition {
  readonly #fn: string;
  readonly #args: string[];

  constructor(
    fn: string,
    args: string[],
    sources: ReadonlySet<ExpressionSource>,
  ) {
    super(sources);
    this.#fn = fn;
    this.#args = args;
  }

  toExpression(): string {
    return `${this.#fn}(${this.#args.join(", ")})`;
  }
}

/** `left && right` or `left || right` */
class LogicalCondition extends Condition {
  // not private — accessible within this module for ternary parenthesization
  readonly op: "&&" | "||";
  readonly #left: Condition;
  readonly #right: Condition;

  constructor(
    op: "&&" | "||",
    left: Condition,
    right: Condition,
    sources: ReadonlySet<ExpressionSource>,
  ) {
    super(sources);
    this.op = op;
    this.#left = left;
    this.#right = right;
  }

  override getAndTerms(): string[] {
    if (this.op === "&&") {
      return [...this.#left.getAndTerms(), ...this.#right.getAndTerms()];
    }
    return [this.toExpression()];
  }

  override flattenAnd(): Condition[] {
    if (this.op === "&&") {
      return [...this.#left.flattenAnd(), ...this.#right.flattenAnd()];
    }
    return [this];
  }

  override flattenOr(): Condition[] {
    if (this.op === "||") {
      return [...this.#left.flattenOr(), ...this.#right.flattenOr()];
    }
    return [this];
  }

  toExpression(): string {
    // parenthesize children that use a different operator to avoid ambiguity
    const left = this.#needsParens(this.#left)
      ? `(${this.#left.toExpression()})`
      : this.#left.toExpression();
    const right = this.#needsParens(this.#right)
      ? `(${this.#right.toExpression()})`
      : this.#right.toExpression();
    return `${left} ${this.op} ${right}`;
  }

  #needsParens(child: Condition): boolean {
    if (child instanceof LogicalCondition && child.op !== this.op) return true;
    if (child instanceof RawCondition) {
      // only parenthesize raw expressions that contain logical operators
      // which could cause precedence ambiguity
      const expr = child.toExpression();
      return expr.includes("&&") || expr.includes("||");
    }
    return false;
  }
}

/** `!inner` */
class NotCondition extends Condition {
  readonly #inner: Condition;

  constructor(inner: Condition, sources: ReadonlySet<ExpressionSource>) {
    super(sources);
    this.#inner = inner;
  }

  toExpression(): string {
    const inner = this.#inner.toExpression();
    // parenthesize compound inner expressions (comparisons need parens
    // because `!` has higher precedence than `==`/`!=` in GitHub Actions)
    const needsParens = this.#inner instanceof LogicalCondition ||
      this.#inner instanceof ComparisonCondition;
    return needsParens ? `!(${inner})` : `!${inner}`;
  }
}

/** wraps a raw expression string as a Condition */
export class RawCondition extends Condition {
  readonly #expression: string;

  constructor(expression: string, sources: ReadonlySet<ExpressionSource>) {
    super(sources);
    this.#expression = expression;
  }

  toExpression(): string {
    return this.#expression;
  }
}

/** Creates an ExpressionValue from a raw expression string. */
export function expr(expression: string): ExpressionValue {
  return new ExpressionValue(expression);
}

const ref = expr("github.ref");
const eventName = expr("github.event_name");

/** Common condition helpers for GitHub Actions workflows. */
export const conditions = {
  /** Status check functions for use in step/job `if` fields. */
  status: {
    /** Run regardless of previous step outcome. */
    always: (): Condition =>
      new FunctionCallCondition("always", [], EMPTY_SOURCES),
    /** Run only when all previous steps succeeded (default behavior). */
    success: (): Condition =>
      new FunctionCallCondition("success", [], EMPTY_SOURCES),
    /** Run only when a previous step has failed. */
    failure: (): Condition =>
      new FunctionCallCondition("failure", [], EMPTY_SOURCES),
    /** Run only when the workflow was cancelled. */
    cancelled: (): Condition =>
      new FunctionCallCondition("cancelled", [], EMPTY_SOURCES),
  },
  /**
   * Check if the ref is a tag. Without arguments, matches any tag.
   * With a tag name, matches that specific tag.
   *
   * ```ts
   * conditions.isTag()          // startsWith(github.ref, 'refs/tags/')
   * conditions.isTag("v1.0.0")  // github.ref == 'refs/tags/v1.0.0'
   * ```
   */
  isTag: (tag?: string): Condition =>
    tag != null ? ref.equals(`refs/tags/${tag}`) : ref.startsWith("refs/tags/"),
  /**
   * Check if the ref is a specific branch.
   *
   * ```ts
   * conditions.isBranch("main")  // github.ref == 'refs/heads/main'
   * ```
   */
  isBranch: (branch: string): Condition => ref.equals(`refs/heads/${branch}`),
  /**
   * Check the event that triggered the workflow.
   *
   * ```ts
   * conditions.isEvent("pull_request")  // github.event_name == 'pull_request'
   * ```
   */
  isEvent: (event: string): Condition => eventName.equals(event),
  /**
   * Check if the event is a pull request.
   *
   * ```ts
   * conditions.isPr()  // github.event_name == 'pull_request'
   * ```
   */
  isPr: (): Condition => eventName.equals("pull_request"),
  /**
   * Check the repository (owner/name).
   *
   * ```ts
   * conditions.isRepository("denoland/deno")  // github.repository == 'denoland/deno'
   * ```
   */
  isRepository: (repo: string): Condition =>
    expr("github.repository").equals(repo),
  /**
   * Check if the pull request is a draft.
   *
   * ```ts
   * conditions.isDraftPr()  // github.event.pull_request.draft == true
   * ```
   */
  isDraftPr: (): Condition =>
    expr("github.event.pull_request.draft").equals(true),
  /**
   * Check if the pull request has a specific label.
   *
   * ```ts
   * conditions.hasLabel("ci-full")  // contains(github.event.pull_request.labels.*.name, 'ci-full')
   * ```
   */
  hasPrLabel: (label: string): Condition =>
    expr("github.event.pull_request.labels.*.name").contains(label),
  /**
   * Check the runner operating system.
   *
   * ```ts
   * conditions.isRunnerOs("Linux")    // runner.os == 'Linux'
   * conditions.isRunnerOs("macOS")    // runner.os == 'macOS'
   * conditions.isRunnerOs("Windows")  // runner.os == 'Windows'
   * ```
   */
  isRunnerOs: (os: "Linux" | "macOS" | "Windows"): Condition =>
    expr("runner.os").equals(os),
  /**
   * Check the runner architecture.
   *
   * ```ts
   * conditions.isRunnerArch("X86")    // runner.arch == 'X86'
   * conditions.isRunnerArch("X64")    // runner.arch == 'X64'
   * conditions.isRunnerArch("ARM")    // runner.arch == 'ARM'
   * conditions.isRunnerArch("ARM64")  // runner.arch == 'ARM64'
   * ```
   */
  isRunnerArch: (arch: "X86" | "X64" | "ARM" | "ARM64"): Condition =>
    expr("runner.arch").equals(arch),
} as const;

// --- helpers ---

export function formatLiteral(value: string | number | boolean): string {
  if (typeof value === "string") return `'${value}'`;
  return String(value);
}

export function sourcesFrom(
  ...sourceables: ({ source?: ExpressionSource } | Condition)[]
): ReadonlySet<ExpressionSource> {
  const set = new Set<ExpressionSource>();
  for (const v of sourceables) {
    if (v instanceof Condition) {
      for (const s of v.sources) set.add(s);
    } else if (v instanceof ExpressionValue) {
      for (const s of v.allSources) set.add(s);
    } else if (v.source) {
      set.add(v.source);
    }
  }
  return set;
}

function unionSources(
  ...conditions: Condition[]
): ReadonlySet<ExpressionSource> {
  const set = new Set<ExpressionSource>();
  for (const c of conditions) {
    for (const s of c.sources) set.add(s);
  }
  return set;
}

// --- ternary expression builders ---

interface TernaryBranch {
  condition: Condition;
  value: TernaryValue;
}

function collectTernarySources(
  branches: TernaryBranch[],
): Set<ExpressionSource> {
  const set = new Set<ExpressionSource>();
  for (const { condition, value } of branches) {
    for (const s of condition.sources) set.add(s);
    if (value instanceof ExpressionValue) {
      for (const s of value.allSources) set.add(s);
    }
  }
  return set;
}

// whether a condition needs parentheses when used as `cond && value`
function needsParensForTernary(condition: Condition): boolean {
  if (condition instanceof LogicalCondition && condition.op === "||") {
    return true;
  }
  if (condition instanceof RawCondition) {
    return condition.toExpression().includes("||");
  }
  return false;
}

function formatTernaryValue(value: TernaryValue): string {
  if (value instanceof ExpressionValue) return value.expression;
  return formatLiteral(value);
}

/**
 * Intermediate builder after `.then(value)`. Call `.else()` to produce the
 * final `ExpressionValue`, or `.elseIf()` to add another branch.
 */
export class ThenBuilder {
  readonly #branches: TernaryBranch[];
  readonly #sources: Set<ExpressionSource>;

  constructor(
    branches: TernaryBranch[],
    sources: ReadonlySet<ExpressionSource>,
  ) {
    this.#branches = branches;
    this.#sources = collectTernarySources(branches);
    for (const s of sources) this.#sources.add(s);
  }

  /** Add another conditional branch. */
  elseIf(condition: Condition): ElseIfBuilder {
    return new ElseIfBuilder(this.#branches, this.#sources, condition);
  }

  /**
   * Finalize the ternary with a default value.
   *
   * ```ts
   * os.equals("linux").then("ubuntu-latest").else("macos-latest")
   * // => matrix.os == 'linux' && 'ubuntu-latest' || 'macos-latest'
   * ```
   */
  else(value: TernaryValue): ExpressionValue {
    const sources = new Set(this.#sources);
    if (value instanceof ExpressionValue) {
      for (const s of value.allSources) sources.add(s);
    }

    const parts: string[] = [];
    for (const { condition, value: val } of this.#branches) {
      const condExpr = needsParensForTernary(condition)
        ? `(${condition.toExpression()})`
        : condition.toExpression();
      parts.push(`${condExpr} && ${formatTernaryValue(val)}`);
    }
    parts.push(formatTernaryValue(value));

    return new ExpressionValue(parts.join(" || "), sources);
  }
}

/**
 * Intermediate builder after `.elseIf(condition)`. Call `.then()` to provide
 * the value for this branch.
 */
export class ElseIfBuilder {
  readonly #branches: TernaryBranch[];
  readonly #sources: Set<ExpressionSource>;
  readonly #condition: Condition;

  constructor(
    branches: TernaryBranch[],
    sources: Set<ExpressionSource>,
    condition: Condition,
  ) {
    this.#branches = branches;
    this.#sources = sources;
    for (const s of condition.sources) this.#sources.add(s);
    this.#condition = condition;
  }

  /** Provide the value for this branch. */
  then(value: TernaryValue): ThenBuilder {
    return new ThenBuilder(
      [...this.#branches, { condition: this.#condition, value }],
      this.#sources,
    );
  }
}
