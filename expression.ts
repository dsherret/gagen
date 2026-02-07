// types that step/job/workflow will reference back to
export type ExpressionSource = { readonly _id: string };

/**
 * An expression that resolves to a value inside a GitHub Actions workflow.
 * Supports fluent comparison methods that produce Conditions.
 */
export class ExpressionValue {
  readonly #expression: string;
  readonly source: ExpressionSource | undefined;

  constructor(expression: string, source?: ExpressionSource) {
    this.#expression = expression;
    this.source = source;
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

  and(other: Condition): Condition {
    return new LogicalCondition("&&", this, other, unionSources(this, other));
  }

  or(other: Condition): Condition {
    return new LogicalCondition("||", this, other, unionSources(this, other));
  }

  not(): Condition {
    return new NotCondition(this, this.sources);
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
  readonly #op: "&&" | "||";
  readonly #left: Condition;
  readonly #right: Condition;

  constructor(
    op: "&&" | "||",
    left: Condition,
    right: Condition,
    sources: ReadonlySet<ExpressionSource>,
  ) {
    super(sources);
    this.#op = op;
    this.#left = left;
    this.#right = right;
  }

  toExpression(): string {
    // parenthesize children that use a different operator to avoid ambiguity
    const left = this.#needsParens(this.#left)
      ? `(${this.#left.toExpression()})`
      : this.#left.toExpression();
    const right = this.#needsParens(this.#right)
      ? `(${this.#right.toExpression()})`
      : this.#right.toExpression();
    return `${left} ${this.#op} ${right}`;
  }

  #needsParens(child: Condition): boolean {
    return (child instanceof LogicalCondition && child.#op !== this.#op) ||
      child instanceof RawCondition;
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
    // parenthesize compound inner expressions
    const needsParens = this.#inner instanceof LogicalCondition;
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
