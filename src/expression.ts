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
    const sources = sourcesFrom(this);
    if (isLiteralExpression(this.#expression)) {
      const isEqual = this.#expression === formatLiteral(value);
      return new RawCondition(isEqual ? "true" : "false", sources);
    }
    return new ComparisonCondition(this.#expression, "==", value, sources);
  }

  notEquals(value: string | number | boolean): Condition {
    const sources = sourcesFrom(this);
    if (isLiteralExpression(this.#expression)) {
      const isEqual = this.#expression === formatLiteral(value);
      return new RawCondition(isEqual ? "false" : "true", sources);
    }
    return new ComparisonCondition(this.#expression, "!=", value, sources);
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
    const right = typeof other === "boolean"
      ? new RawCondition(String(other), EMPTY_SOURCES)
      : other;
    if (this.isAlwaysTrue()) return right;
    if (right.isAlwaysTrue()) return this;
    if (this.isAlwaysFalse() || right.isAlwaysFalse()) {
      return new RawCondition("false", unionSources(this, right));
    }
    return deduplicatedLogical("&&", this, right);
  }

  or(other: Condition | boolean): Condition {
    const right = typeof other === "boolean"
      ? new RawCondition(String(other), EMPTY_SOURCES)
      : other;
    if (this.isAlwaysFalse()) return right;
    if (right.isAlwaysFalse()) return this;
    if (this.isAlwaysTrue() || right.isAlwaysTrue()) {
      return new RawCondition("true", unionSources(this, right));
    }
    return deduplicatedLogical("||", this, right);
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

export function formatLiteral(value: string | number | boolean): string {
  if (typeof value === "string") return `'${value}'`;
  return String(value);
}

/** checks if an expression string is a literal (quoted string, number, or boolean) */
function isLiteralExpression(expr: string): boolean {
  if (expr.startsWith("'") && expr.endsWith("'")) return true;
  if (expr === "true" || expr === "false") return true;
  if (expr.length > 0 && String(Number(expr)) === expr) return true;
  return false;
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
  if (unique.length === 0) return left;
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
  const sources = unionSources(...allTerms);
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
    super(typeof value === "string" ? `'${value}'` : String(value));
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
