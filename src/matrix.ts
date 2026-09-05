import * as internal from "./internal.ts";
import { Condition, ExpressionValue } from "./expression.ts";

type ExtractMatrixKeys<T> =
  | Exclude<keyof T & string, "include" | "exclude">
  | (T extends { include: readonly (infer I)[] } ? keyof I & string : never);

/** Recursively serializes Condition/ExpressionValue objects to ${{ }} strings. */
function serializeValue(value: unknown): unknown {
  if (value instanceof Condition || value instanceof ExpressionValue) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = serializeValue(v);
    }
    return result;
  }
  return value;
}

// declared ahead of Matrix because its constructor populates it
const matrixDefs = new WeakMap<Matrix<string>, Record<string, unknown>>();

/**
 * A build matrix. Each matrix key is exposed as a property holding the
 * `matrix.<key>` expression, so keys can be referenced directly in step
 * configuration and conditions.
 */
export class Matrix<_K extends string> {
  constructor(def: Record<string, unknown>, keys: string[]) {
    // held outside the class so that neither the definition nor an accessor for
    // it becomes public API — a `def`/`sources` member would also collide with
    // the shadow check below, and both are plausible matrix dimension names
    matrixDefs.set(this as Matrix<string>, def);
    for (const key of keys) {
      if (key in this) {
        // silently overwriting would break the shadowed member
        throw new Error(
          `Matrix key "${key}" conflicts with a Matrix member — rename the key.`,
        );
      }
      (this as Record<string, unknown>)[key] = new ExpressionValue(
        `matrix.${key}`,
      );
    }
  }

  /** Serializes the matrix definition to its YAML form. */
  [internal.toYaml](): Record<string, unknown> {
    return serializeValue(matrixDefOf(this as Matrix<string>)) as Record<
      string,
      unknown
    >;
  }
}

/**
 * Returns the raw definition a matrix was built from, with any Condition and
 * ExpressionValue entries left intact.
 *
 * Needed to infer job `needs` from expressions embedded in a matrix — the
 * definition is otherwise only reachable through its serialized form, which
 * has already flattened those entries to strings.
 */
export function matrixDefOf(matrix: Matrix<string>): Record<string, unknown> {
  return matrixDefs.get(matrix) ?? {};
}

type MatrixWithExprs<K extends string> =
  & Matrix<K>
  & {
    readonly [P in K]: ExpressionValue;
  };

/**
 * Defines a build matrix, returning it with a typed property per matrix key
 * (including keys introduced by `include` entries) holding that key's
 * `matrix.<key>` expression.
 */
export function defineMatrix<const T extends Record<string, unknown>>(
  def: T,
): MatrixWithExprs<ExtractMatrixKeys<T>> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(def)) {
    if (key !== "include" && key !== "exclude") {
      keys.add(key);
    }
    if (key === "include" && Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          for (const k of Object.keys(item)) {
            keys.add(k);
          }
        }
      }
    }
  }

  return new Matrix(def, [...keys]) as MatrixWithExprs<ExtractMatrixKeys<T>>;
}
