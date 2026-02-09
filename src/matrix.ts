import { ExpressionValue } from "./expression.ts";

type ExtractMatrixKeys<T> =
  | Exclude<keyof T & string, "include" | "exclude">
  | (T extends { include: readonly (infer I)[] } ? keyof I & string : never);

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
    return this.#def;
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
