// types that step/job/workflow will reference back to

/** Something an expression can depend on, such as a step or a job. */
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

  /** `this == value`, simplified when this value is a known literal */
  equals(value: string | number | boolean): Condition {
    const sources = sourcesFrom(this);
    const isEqual = literalEquality(this.#expression, value);
    if (isEqual != null) {
      return new RawCondition(isEqual ? "true" : "false", sources);
    }
    return new ComparisonCondition(this.#expression, "==", value, sources);
  }

  /** `this != value`, simplified when this value is a known literal */
  notEquals(value: string | number | boolean): Condition {
    const sources = sourcesFrom(this);
    const isEqual = literalEquality(this.#expression, value);
    if (isEqual != null) {
      return new RawCondition(isEqual ? "false" : "true", sources);
    }
    return new ComparisonCondition(this.#expression, "!=", value, sources);
  }

  /** `startsWith(this, prefix)` */
  startsWith(prefix: string): Condition {
    return new FunctionCallCondition(
      "startsWith",
      [this.#expression, formatLiteral(prefix)],
      sourcesFrom(this),
    );
  }

  /** `endsWith(this, suffix)` */
  endsWith(suffix: string): Condition {
    return new FunctionCallCondition(
      "endsWith",
      [this.#expression, formatLiteral(suffix)],
      sourcesFrom(this),
    );
  }

  /** `contains(this, substring)` */
  contains(substring: string): Condition {
    return new FunctionCallCondition(
      "contains",
      [this.#expression, formatLiteral(substring)],
      sourcesFrom(this),
    );
  }

  /** `!(this)`, treating this value as a boolean */
  not(): Condition {
    return new RawCondition(`!(${this.#expression})`, sourcesFrom(this));
  }

  /** concatenate this value with additional strings, numbers, or expressions */
  concat(...parts: ConcatPart[]): ExpressionValue {
    return concat(this, ...parts);
  }

  /** `this > value` */
  greaterThan(value: number): Condition {
    return new ComparisonCondition(
      this.#expression,
      ">",
      value,
      sourcesFrom(this),
    );
  }

  /** `this >= value` */
  greaterThanOrEqual(value: number): Condition {
    return new ComparisonCondition(
      this.#expression,
      ">=",
      value,
      sourcesFrom(this),
    );
  }

  /** `this < value` */
  lessThan(value: number): Condition {
    return new ComparisonCondition(
      this.#expression,
      "<",
      value,
      sourcesFrom(this),
    );
  }

  /** `this <= value` */
  lessThanOrEqual(value: number): Condition {
    return new ComparisonCondition(
      this.#expression,
      "<=",
      value,
      sourcesFrom(this),
    );
  }

  /** wrap this value in GitHub's `toJSON()` function */
  toJSON(): ExpressionValue {
    return toJSON(this);
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

  /** `this && other`, simplifying always-true/always-false operands */
  and(other: Condition | boolean): Condition {
    const right = typeof other === "boolean"
      ? new RawCondition(String(other), EMPTY_SOURCES)
      : other;
    if (this.isAlwaysTrue()) return right;
    if (right.isAlwaysTrue()) return this;
    if (this.isAlwaysFalse() || right.isAlwaysFalse()) {
      return new RawCondition("false", sourcesFrom(this, right));
    }
    return deduplicatedLogical("&&", this, right);
  }

  /** `this || other`, simplifying always-true/always-false operands */
  or(other: Condition | boolean): Condition {
    const right = typeof other === "boolean"
      ? new RawCondition(String(other), EMPTY_SOURCES)
      : other;
    if (this.isAlwaysFalse()) return right;
    if (right.isAlwaysFalse()) return this;
    if (this.isAlwaysTrue() || right.isAlwaysTrue()) {
      return new RawCondition("true", sourcesFrom(this, right));
    }
    return deduplicatedLogical("||", this, right);
  }

  /** `!this`, simplifying where the negation can be expressed directly */
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
   *
   * Throws when the value is a falsy literal, which the encoding can't
   * represent.
   */
  then(value: TernaryValue): ThenBuilder {
    assertTruthyTernaryValue(value);
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

  /** returns true if this condition always evaluates to true */
  isAlwaysTrue(): boolean {
    return false;
  }

  /** returns true if this condition always evaluates to false */
  isAlwaysFalse(): boolean {
    return false;
  }

  /** returns true if this condition could possibly evaluate to true */
  isPossiblyTrue(): boolean {
    return !this.isAlwaysFalse();
  }

  /**
   * Returns a condition that renders identically but additionally tracks the
   * given sources. Simplification uses this when it drops a duplicate term
   * whose sources the surviving term doesn't already have.
   */
  abstract withSources(sources: ReadonlySet<ExpressionSource>): Condition;

  /** render without `${{ }}` wrapping */
  abstract toExpression(): string;

  /** render wrapped in `${{ }}` for YAML `if` fields */
  toString(): string {
    return `\${{ ${this.toExpression()} }}`;
  }
}

// --- concrete condition types ---

/** comparison operators supported in GitHub Actions expressions */
export type ComparisonOp = "==" | "!=" | ">" | ">=" | "<" | "<=";

const NEGATED_OP: Record<ComparisonOp, ComparisonOp> = {
  "==": "!=",
  "!=": "==",
  ">": "<=",
  ">=": "<",
  "<": ">=",
  "<=": ">",
};

/** `left op right` where op is ==, !=, >, >=, <, or <= */
export class ComparisonCondition extends Condition {
  readonly #left: string;
  readonly #op: ComparisonOp;
  readonly #right: string | number | boolean;

  constructor(
    left: string,
    op: ComparisonOp,
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
      NEGATED_OP[this.#op],
      this.#right,
      this.sources,
    );
  }

  override withSources(
    sources: ReadonlySet<ExpressionSource>,
  ): ComparisonCondition {
    return new ComparisonCondition(
      this.#left,
      this.#op,
      this.#right,
      mergeSources(this.sources, sources),
    );
  }

  toExpression(): string {
    // comparison binds tighter than && and ||, so a left side built from a
    // ternary or another logical expression has to be parenthesized
    const left = containsLogicalOperator(this.#left)
      ? `(${this.#left})`
      : this.#left;
    return `${left} ${this.#op} ${formatLiteral(this.#right)}`;
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

  override withSources(
    sources: ReadonlySet<ExpressionSource>,
  ): FunctionCallCondition {
    return new FunctionCallCondition(
      this.#fn,
      this.#args,
      mergeSources(this.sources, sources),
    );
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

  override withSources(
    sources: ReadonlySet<ExpressionSource>,
  ): LogicalCondition {
    return new LogicalCondition(
      this.op,
      this.#left,
      this.#right,
      mergeSources(this.sources, sources),
    );
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
      return containsLogicalOperator(child.toExpression());
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

  override not(): Condition {
    // `!!x` is the same as `x`
    return this.#inner;
  }

  override withSources(sources: ReadonlySet<ExpressionSource>): NotCondition {
    return new NotCondition(this.#inner, mergeSources(this.sources, sources));
  }

  toExpression(): string {
    const inner = this.#inner.toExpression();
    // parenthesize compound inner expressions (comparisons need parens
    // because `!` has higher precedence than `==`/`!=` in GitHub Actions)
    const needsParens = this.#inner instanceof LogicalCondition ||
      this.#inner instanceof ComparisonCondition ||
      (this.#inner instanceof RawCondition && containsBinaryOperator(inner));
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

  override isAlwaysTrue(): boolean {
    return this.#expression === "true";
  }

  override isAlwaysFalse(): boolean {
    return this.#expression === "false";
  }

  override not(): Condition {
    if (this.#expression === "true") {
      return new RawCondition("false", this.sources);
    }
    if (this.#expression === "false") {
      return new RawCondition("true", this.sources);
    }
    return super.not();
  }

  override withSources(sources: ReadonlySet<ExpressionSource>): RawCondition {
    return new RawCondition(
      this.#expression,
      mergeSources(this.sources, sources),
    );
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
  /** A condition that is always true. Simplifies away in `.and()` / `.or()`. */
  isTrue: (): Condition => new RawCondition("true", EMPTY_SOURCES),
  /** A condition that is always false. Simplifies away in `.and()` / `.or()`. */
  isFalse: (): Condition => new RawCondition("false", EMPTY_SOURCES),
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

/** Checks if a condition-like value always evaluates to true. */
export function isAlwaysTrue(
  c: Condition | ExpressionValue | string,
): boolean {
  if (c instanceof Condition) return c.isAlwaysTrue();
  if (typeof c === "string") return c === "true";
  return false;
}

/** Checks if a condition-like value always evaluates to false. */
export function isAlwaysFalse(
  c: Condition | ExpressionValue | string,
): boolean {
  if (c instanceof Condition) return c.isAlwaysFalse();
  if (typeof c === "string") return c === "false";
  return false;
}

/**
 * Renders a value as a GitHub Actions literal. Strings are single quoted with
 * any embedded single quotes doubled, which is how they are escaped.
 */
export function formatLiteral(value: string | number | boolean): string {
  if (typeof value === "string") return `'${escapeSingleQuotes(value)}'`;
  return String(value);
}

/** Collects the sources of any number of expression values or conditions. */
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

function mergeSources(
  existing: ReadonlySet<ExpressionSource>,
  additional: ReadonlySet<ExpressionSource>,
): ReadonlySet<ExpressionSource> {
  for (const s of additional) {
    if (!existing.has(s)) return new Set([...existing, ...additional]);
  }
  return existing;
}

function escapeSingleQuotes(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Statically compares a literal expression against a literal value. Returns
 * `undefined` when the result can't be known at generation time, either
 * because the expression isn't a literal or because the two sides have
 * different types (GitHub coerces those at runtime).
 */
function literalEquality(
  expression: string,
  value: string | number | boolean,
): boolean | undefined {
  const valueType = typeof value;
  if (literalTypeOf(expression) !== valueType) return undefined;
  if (typeof value === "string") {
    return literalStringEquality(unquoteStringLiteral(expression), value);
  }
  return expression === formatLiteral(value);
}

/**
 * Compares two plain strings the way GitHub does, which ignores case. Returns
 * `undefined` when the two differ only in the case of non-ASCII characters,
 * because JavaScript doesn't necessarily fold those the same way GitHub does
 * and letting GitHub decide at runtime is always correct.
 */
function literalStringEquality(a: string, b: string): boolean | undefined {
  if (toAsciiLowerCase(a) === toAsciiLowerCase(b)) return true;
  if (a.toLowerCase() === b.toLowerCase()) return undefined;
  return false;
}

function toAsciiLowerCase(value: string): string {
  let result = "";
  for (const char of value) {
    result += char >= "A" && char <= "Z" ? char.toLowerCase() : char;
  }
  return result;
}

/**
 * Returns the type of an expression that is a literal (quoted string, number,
 * or boolean), or `undefined` when it isn't one.
 */
function literalTypeOf(
  expression: string,
): "string" | "number" | "boolean" | undefined {
  if (expression === "true" || expression === "false") return "boolean";
  if (isQuotedStringLiteral(expression)) return "string";
  // `NaN` and `Infinity` round trip through Number() but aren't literals that
  // GitHub understands, so Number.isFinite excludes them here
  const parsed = Number(expression);
  if (expression.length > 0 && Number.isFinite(parsed)) {
    if (String(parsed) === expression) return "number";
  }
  return undefined;
}

/** unescapes a quoted string literal back to the plain text it represents */
function unquoteStringLiteral(expression: string): string {
  return expression.slice(1, -1).replaceAll("''", "'");
}

/** checks that an expression is a single quoted string and nothing more */
function isQuotedStringLiteral(expression: string): boolean {
  if (expression.length < 2) return false;
  if (!expression.startsWith("'") || !expression.endsWith("'")) return false;
  // every quote between the outer quotes must be part of a doubled escape,
  // otherwise the string ends early and more expression follows it
  for (let i = 1; i < expression.length - 1; i++) {
    if (expression[i] !== "'") continue;
    if (expression[i + 1] !== "'") return false;
    i++;
  }
  return true;
}

/** checks if a rendered expression contains `&&` or `||` */
function containsLogicalOperator(expression: string): boolean {
  return expression.includes("&&") || expression.includes("||");
}

/**
 * Checks if a rendered expression contains any binary operator, all of which
 * bind less tightly than a unary `!`.
 */
function containsBinaryOperator(expression: string): boolean {
  if (containsLogicalOperator(expression)) return true;
  return expression.includes("==") || expression.includes("!=") ||
    expression.includes("<") || expression.includes(">");
}

/**
 * Builds a logical condition (&&/||), deduplicating terms that appear on both
 * sides. For example, `(A && B).and(B && C)` produces `A && B && C` instead
 * of `A && B && B && C`.
 */
function deduplicatedLogical(
  op: "&&" | "||",
  left: Condition,
  right: Condition,
): Condition {
  const leftTerms = op === "&&" ? left.flattenAnd() : left.flattenOr();
  const rightTerms = op === "&&" ? right.flattenAnd() : right.flattenOr();
  const seen = new Set(leftTerms.map((t) => t.toExpression()));
  const unique = rightTerms.filter((t) => !seen.has(t.toExpression()));
  // every right term already appears on the left, so the left side is the
  // whole result, but it still has to pick up the right side's sources
  if (unique.length === 0) return left.withSources(right.sources);
  const allTerms = [...leftTerms, ...unique];
  // absorption: for &&, drop any OR compound whose child appears as a sibling
  // term (e.g. (A || B) && B → B). Symmetrically for ||.
  const termExprs = new Set(allTerms.map((t) => t.toExpression()));
  const absorbed = allTerms.filter((term) => {
    const children = op === "&&" ? term.flattenOr() : term.flattenAnd();
    if (children.length <= 1) return true;
    return !children.some((c) => termExprs.has(c.toExpression()));
  });
  const terms = absorbed.length > 0 ? absorbed : allTerms;
  const sources = sourcesFrom(left, right);
  // when absorption leaves a single term it is returned with only its own
  // sources, which is correct: the absorbed terms are gone from the expression
  return terms.reduce((acc, term) =>
    new LogicalCondition(op, acc, term, sources)
  );
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

/**
 * A ternary renders as `cond && value || fallback`, which only works when the
 * value is truthy: GitHub's `&&` yields its falsy operand, so a falsy value
 * makes the whole expression fall through to the fallback no matter what the
 * condition says. Dynamic values can't be checked, but literals can.
 */
function assertTruthyTernaryValue(value: TernaryValue): void {
  if (!isStaticallyFalsy(value)) return;
  throw new Error(
    `A ternary value must not be falsy, but got ${
      formatTernaryValue(value)
    }. ` +
      "GitHub evaluates `condition && value || fallback`, so a falsy value " +
      "always falls through to the fallback.",
  );
}

function isStaticallyFalsy(value: TernaryValue): boolean {
  if (value instanceof ExpressionValue) {
    const expression = value.expression;
    if (literalTypeOf(expression) === "string") {
      return unquoteStringLiteral(expression) === "";
    }
    return expression === "false" || expression === "0";
  }
  return value === false || value === 0 || value === "";
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
  if (!(value instanceof ExpressionValue)) return formatLiteral(value);
  // a value that is itself a ternary (or any other logical expression) has to
  // be parenthesized so it doesn't merge into the surrounding `&&`/`||` chain
  return containsLogicalOperator(value.expression)
    ? `(${value.expression})`
    : value.expression;
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
    sources: ReadonlySet<ExpressionSource>,
    condition: Condition,
  ) {
    this.#branches = branches;
    // copy so that adding this branch's sources doesn't leak back into the
    // builder this was created from
    this.#sources = new Set(sources);
    for (const s of condition.sources) this.#sources.add(s);
    this.#condition = condition;
  }

  /**
   * Provide the value for this branch. Throws when the value is a falsy
   * literal, which the encoding can't represent.
   */
  then(value: TernaryValue): ThenBuilder {
    assertTruthyTernaryValue(value);
    return new ThenBuilder(
      [...this.#branches, { condition: this.#condition, value }],
      this.#sources,
    );
  }
}

// --- string concatenation ---

/** a part of a concatenation: plain string, number, or expression */
export type ConcatPart = string | number | ExpressionValue;

/**
 * Concatenates strings, numbers, and expressions into a single value.
 * Expression parts are wrapped in `${{ }}` when serialized for YAML,
 * and use the `format()` function when used inside expression contexts.
 *
 * ```ts
 * const name = concat("build-", expr("matrix.os"));
 * name.toString()  // => "build-${{ matrix.os }}"
 * name.expression  // => "format('build-{0}', matrix.os)"
 *
 * const full = concat("build-", expr("matrix.os"), "-", expr("matrix.arch"));
 * full.toString()  // => "build-${{ matrix.os }}-${{ matrix.arch }}"
 * ```
 */
export function concat(...parts: ConcatPart[]): ExpressionValue {
  if (parts.length === 0) {
    return new InlineValue("");
  }
  if (parts.length === 1) {
    const p = parts[0];
    if (p instanceof ExpressionValue) return p;
    // concatenation produces a string, so a lone number renders as one too,
    // matching what the multi-part path below does
    return new InlineValue(String(p));
  }

  // flatten nested ConcatValues, inline literals, and convert numbers to strings
  const flat: (string | ExpressionValue)[] = [];
  for (const part of parts) {
    if (part instanceof ConcatValue) {
      flat.push(...part.concatParts);
    } else if (part instanceof InlineValue) {
      flat.push(part.toString());
    } else if (typeof part === "number") {
      flat.push(String(part));
    } else {
      flat.push(part);
    }
  }

  // merge adjacent string parts
  const merged: (string | ExpressionValue)[] = [];
  for (const part of flat) {
    const last = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (typeof part === "string" && typeof last === "string") {
      merged[merged.length - 1] = last + part;
    } else {
      merged.push(part);
    }
  }

  // degenerate cases after merging
  if (merged.length === 1) {
    const p = merged[0];
    if (typeof p === "string") return new InlineValue(p);
    return p;
  }

  // collect sources from all expression parts
  const sources = new Set<ExpressionSource>();
  for (const part of merged) {
    if (part instanceof ExpressionValue) {
      for (const s of part.allSources) sources.add(s);
    }
  }

  // build format() expression for use inside ${{ }} contexts
  const templateParts: string[] = [];
  const args: string[] = [];
  let argIndex = 0;
  for (const part of merged) {
    if (part instanceof ExpressionValue) {
      templateParts.push(`{${argIndex++}}`);
      args.push(part.expression);
    } else {
      // escape single quotes and braces for GitHub Actions format()
      templateParts.push(
        escapeSingleQuotes(part).replaceAll("{", "{{").replaceAll("}", "}}"),
      );
    }
  }
  const formatExpr = `format('${templateParts.join("")}', ${args.join(", ")})`;

  return new ConcatValue(formatExpr, merged, sources);
}

class ConcatValue extends ExpressionValue {
  readonly #parts: readonly (string | ExpressionValue)[];

  constructor(
    formatExpr: string,
    parts: (string | ExpressionValue)[],
    sources: ReadonlySet<ExpressionSource>,
  ) {
    super(formatExpr, sources);
    this.#parts = Object.freeze([...parts]);
  }

  /** the individual parts of this concatenation (for flattening nested concats) */
  get concatParts(): readonly (string | ExpressionValue)[] {
    return this.#parts;
  }

  override toString(): string {
    return this.#parts
      .map((p) => (p instanceof ExpressionValue ? p.toString() : p))
      .join("");
  }
}

// --- JSON functions ---

/**
 * Parses a JSON string into an object/value. Wraps in `fromJSON()` in GitHub
 * Actions expression contexts.
 *
 * ```ts
 * const matrix = fromJSON(expr("needs.setup.outputs.matrix"));
 * matrix.toString()  // => "${{ fromJSON(needs.setup.outputs.matrix) }}"
 * ```
 */
export function fromJSON(value: string | ExpressionValue): ExpressionValue {
  if (typeof value === "string") {
    return new ExpressionValue(`fromJSON(${formatLiteral(value)})`);
  }
  const sources = new Set<ExpressionSource>();
  for (const s of value.allSources) sources.add(s);
  return new ExpressionValue(`fromJSON(${value.expression})`, sources);
}

/**
 * Serializes a value to JSON. Wraps in `toJSON()` in GitHub Actions expression
 * contexts.
 *
 * ```ts
 * const json = toJSON(expr("github.event"));
 * json.toString()  // => "${{ toJSON(github.event) }}"
 * ```
 */
export function toJSON(value: ExpressionValue): ExpressionValue {
  const sources = new Set<ExpressionSource>();
  for (const s of value.allSources) sources.add(s);
  return new ExpressionValue(`toJSON(${value.expression})`, sources);
}

// --- hashFiles ---

/** Computes a hash of files matching the given glob patterns. */
export function hashFiles(
  ...patterns: (string | ExpressionValue)[]
): ExpressionValue {
  if (patterns.length === 0) {
    throw new Error("hashFiles requires at least one pattern.");
  }
  const sources = new Set<ExpressionSource>();
  const args: string[] = [];
  for (const p of patterns) {
    if (p instanceof ExpressionValue) {
      for (const s of p.allSources) sources.add(s);
      args.push(p.expression);
    } else {
      args.push(formatLiteral(p));
    }
  }
  return new ExpressionValue(
    `hashFiles(${args.join(", ")})`,
    sources.size > 0 ? sources : undefined,
  );
}

// --- join ---

/**
 * Joins an array expression with an optional separator. Wraps in `join()` in
 * GitHub Actions expression contexts.
 *
 * ```ts
 * const labels = join(expr("github.event.pull_request.labels.*.name"), ", ");
 * labels.toString()  // => "${{ join(github.event.pull_request.labels.*.name, ', ') }}"
 * ```
 */
export function join(
  value: ExpressionValue,
  separator?: string,
): ExpressionValue {
  const sources = new Set<ExpressionSource>();
  for (const s of value.allSources) sources.add(s);
  const args = separator != null
    ? `${value.expression}, ${formatLiteral(separator)}`
    : value.expression;
  return new ExpressionValue(
    `join(${args})`,
    sources.size > 0 ? sources : undefined,
  );
}

// --- inline value (serializes as plain value, not ${{ }}) ---

/** Creates an ExpressionValue or Condition from a literal value. */
export function literal(value: boolean): Condition;
export function literal(value: string | number): ExpressionValue;
export function literal(
  value: string | number | boolean,
): ExpressionValue | Condition {
  if (typeof value === "boolean") {
    return new RawCondition(String(value), EMPTY_SOURCES);
  }
  return new InlineValue(value);
}

class InlineValue extends ExpressionValue {
  readonly #plainValue: string;

  constructor(value: string | number) {
    super(formatLiteral(value));
    this.#plainValue = String(value);
  }

  override toString(): string {
    return this.#plainValue;
  }
}

// --- defineExprObj: lift plain values into expression/condition types ---

/** Maps a property type to Condition (for booleans/conditions) or ExpressionValue (for values). */
export type ExprOf<T> = [T] extends [boolean | Condition] ? Condition
  : ExpressionValue;

/** Maps all properties of an object to their expression/condition form. */
export type ExprMap<T extends Record<string, unknown>> = {
  readonly [K in keyof T & string]: ExprOf<T[K]>;
};

/**
 * Converts an object with plain values into an object with typed
 * Condition/ExpressionValue properties. Booleans become Conditions,
 * strings/numbers become ExpressionValues that serialize inline.
 */
export function defineExprObj<const T extends Record<string, unknown>>(
  obj: T,
): ExprMap<T> {
  const result: Record<string, Condition | ExpressionValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Condition) {
      result[key] = value;
    } else if (value instanceof ExpressionValue) {
      result[key] = value;
    } else if (typeof value === "boolean") {
      result[key] = new RawCondition(String(value), EMPTY_SOURCES);
    } else if (typeof value === "string") {
      result[key] = new InlineValue(value);
    } else if (typeof value === "number") {
      result[key] = new InlineValue(value);
    } else {
      throw new Error(`Unsupported value type for key "${key}"`);
    }
  }
  return result as ExprMap<T>;
}
