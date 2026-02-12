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

export class Matrix<_K extends string> {
  readonly #def: Record<string, unknown>;

  constructor(def: Record<string, unknown>, keys: string[]) {
    this.#def = def;
    for (const key of keys) {
      (this as Record<string, unknown>)[key] = new ExpressionValue(
        `matrix.${key}`,
      );
    }
  }

  toYaml(): Record<string, unknown> {
    return serializeValue(this.#def) as Record<string, unknown>;
  }
}

type MatrixWithExprs<K extends string> =
  & Matrix<K>
  & {
    readonly [P in K]: ExpressionValue;
  };

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
