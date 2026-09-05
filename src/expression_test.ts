import * as internal from "./internal.ts";
import { assertEquals, assertThrows } from "@std/assert";
import {
  ComparisonCondition,
  concat,
  Condition,
  conditions,
  defineExprObj,
  expr,
  type ExpressionSource,
  ExpressionValue,
  formatLiteral,
  fromJSON,
  FunctionCallCondition,
  hashFiles,
  isAlwaysFalse,
  isAlwaysTrue,
  join,
  literal,
  RawCondition,
  sourcesFrom,
  toJSON,
} from "./expression.ts";

// --- helpers for constructing conditions directly ---

function cmp(
  expr: string,
  value: string,
  sources: ExpressionSource[] = [],
) {
  return new ComparisonCondition(
    expr,
    "==",
    value,
    new Set(sources),
  );
}

function neq(
  expr: string,
  value: string,
  sources: ExpressionSource[] = [],
) {
  return new ComparisonCondition(
    expr,
    "!=",
    value,
    new Set(sources),
  );
}

function fn(
  name: string,
  args: string[],
  sources: ExpressionSource[] = [],
) {
  return new FunctionCallCondition(name, args, new Set(sources));
}

// --- ExpressionValue ---

Deno.test("ExpressionValue toString wraps in ${{ }}", () => {
  const v = new ExpressionValue("github.ref");
  assertEquals(v.toString(), "${{ github.ref }}");
});

Deno.test("ExpressionValue expression getter returns raw text", () => {
  const v = new ExpressionValue("matrix.os");
  assertEquals(v.expression, "matrix.os");
});

Deno.test("ExpressionValue equals with string", () => {
  const v = new ExpressionValue("matrix.os");
  const c = v.equals("linux");
  assertEquals(c.toExpression(), "matrix.os == 'linux'");
  assertEquals(c.toString(), "${{ matrix.os == 'linux' }}");
});

Deno.test("ExpressionValue notEquals with string", () => {
  const v = new ExpressionValue("matrix.profile");
  assertEquals(
    v.notEquals("debug").toExpression(),
    "matrix.profile != 'debug'",
  );
});

Deno.test("ExpressionValue equals with number", () => {
  const v = new ExpressionValue("matrix.count");
  assertEquals(v.equals(3).toExpression(), "matrix.count == 3");
});

Deno.test("ExpressionValue equals with boolean", () => {
  const v = new ExpressionValue("matrix.use_sysroot");
  assertEquals(v.equals(true).toExpression(), "matrix.use_sysroot == true");
});

Deno.test("ExpressionValue startsWith produces function call", () => {
  const v = new ExpressionValue("github.ref");
  assertEquals(
    v.startsWith("refs/tags/").toExpression(),
    "startsWith(github.ref, 'refs/tags/')",
  );
});

Deno.test("ExpressionValue contains produces function call", () => {
  const v = new ExpressionValue("github.event.pull_request.labels");
  assertEquals(
    v.contains("ci-full").toExpression(),
    "contains(github.event.pull_request.labels, 'ci-full')",
  );
});

Deno.test("ExpressionValue chaining startsWith().not()", () => {
  const v = new ExpressionValue("github.ref");
  assertEquals(
    v.startsWith("refs/tags/").not().toExpression(),
    "!startsWith(github.ref, 'refs/tags/')",
  );
});

Deno.test("ExpressionValue chaining or().and() from values", () => {
  const os = new ExpressionValue("matrix.os");
  const profile = new ExpressionValue("matrix.profile");
  const c = os.equals("linux").or(os.equals("macos")).and(
    profile.equals("release"),
  );
  assertEquals(
    c.toExpression(),
    "(matrix.os == 'linux' || matrix.os == 'macos') && matrix.profile == 'release'",
  );
});

// --- ExpressionValue source tracking ---

Deno.test("ExpressionValue no source by default", () => {
  const v = new ExpressionValue("github.ref");
  assertEquals(v.equals("main").sources.size, 0);
});

Deno.test("ExpressionValue source flows into equals", () => {
  const src = { id: "step_1" };
  const v = new ExpressionValue("steps.check.outputs.result", src);
  assertEquals([...v[internal.allSources]], [src]);
  const c = v.equals("success");
  assertEquals(c.sources.size, 1);
  assertEquals(c.sources.has(src), true);
});

Deno.test("ExpressionValue source flows into notEquals", () => {
  const src = { id: "step_1" };
  const v = new ExpressionValue("steps.check.outputs.result", src);
  assertEquals(v.notEquals("fail").sources.has(src), true);
});

Deno.test("ExpressionValue source flows into startsWith", () => {
  const src = { id: "step_1" };
  const v = new ExpressionValue("steps.check.outputs.ref", src);
  assertEquals(v.startsWith("refs/").sources.has(src), true);
});

Deno.test("ExpressionValue source flows into contains", () => {
  const src = { id: "step_1" };
  const v = new ExpressionValue("steps.check.outputs.labels", src);
  assertEquals(v.contains("ci").sources.has(src), true);
});

Deno.test("ExpressionValue sources from two values unioned in and", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const v1 = new ExpressionValue("steps.a.outputs.x", s1);
  const v2 = new ExpressionValue("steps.b.outputs.y", s2);
  const c = v1.equals("ok").and(v2.notEquals("fail"));
  assertEquals(c.sources.size, 2);
  assertEquals(c.sources.has(s1), true);
  assertEquals(c.sources.has(s2), true);
});

Deno.test("ExpressionValue sourced and ambient mixed", () => {
  const src = { id: "job_1" };
  const sourced = new ExpressionValue("needs.pre_build.outputs.skip", src);
  const ambient = new ExpressionValue("github.ref");
  const c = sourced.notEquals("true").and(ambient.startsWith("refs/tags/"));
  assertEquals(c.sources.size, 1);
  assertEquals(c.sources.has(src), true);
});

// --- Condition: toExpression ---

Deno.test("ComparisonCondition == with string", () => {
  assertEquals(
    cmp("matrix.os", "linux").toExpression(),
    "matrix.os == 'linux'",
  );
});

Deno.test("ComparisonCondition != with string", () => {
  assertEquals(
    neq("matrix.os", "linux").toExpression(),
    "matrix.os != 'linux'",
  );
});

Deno.test("ComparisonCondition == with number", () => {
  const c = new ComparisonCondition("matrix.count", "==", 3, new Set());
  assertEquals(c.toExpression(), "matrix.count == 3");
});

Deno.test("ComparisonCondition == with boolean", () => {
  const c = new ComparisonCondition("matrix.flag", "==", true, new Set());
  assertEquals(c.toExpression(), "matrix.flag == true");
});

Deno.test("FunctionCallCondition renders correctly", () => {
  const c = fn("startsWith", ["github.ref", "'refs/tags/'"]);
  assertEquals(c.toExpression(), "startsWith(github.ref, 'refs/tags/')");
});

// --- Condition: toString ---

Deno.test("Condition toString wraps in ${{ }}", () => {
  assertEquals(cmp("a", "b").toString(), "${{ a == 'b' }}");
});

// --- Condition: and ---

Deno.test("and combines two conditions", () => {
  const c = cmp("a", "1").and(cmp("b", "2"));
  assertEquals(c.toExpression(), "a == '1' && b == '2'");
});

Deno.test("chained and is flat (left-associative)", () => {
  const c = cmp("a", "1").and(cmp("b", "2")).and(cmp("c", "3"));
  assertEquals(c.toExpression(), "a == '1' && b == '2' && c == '3'");
});

Deno.test("and(true) returns the condition unchanged", () => {
  const c = cmp("a", "1");
  assertEquals(c.and(true).toExpression(), "a == '1'");
});

Deno.test("and(false) produces false", () => {
  const c = cmp("a", "1");
  assertEquals(c.and(false).toExpression(), "false");
});

// --- Condition: or ---

Deno.test("or(false) returns the condition unchanged", () => {
  const c = cmp("a", "1");
  assertEquals(c.or(false).toExpression(), "a == '1'");
});

Deno.test("or(true) produces true", () => {
  const c = cmp("a", "1");
  assertEquals(c.or(true).toExpression(), "true");
});

Deno.test("or combines two conditions", () => {
  const c = cmp("a", "1").or(cmp("b", "2"));
  assertEquals(c.toExpression(), "a == '1' || b == '2'");
});

Deno.test("chained or is flat (left-associative)", () => {
  const c = cmp("a", "1").or(cmp("b", "2")).or(cmp("c", "3"));
  assertEquals(c.toExpression(), "a == '1' || b == '2' || c == '3'");
});

// --- Condition: mixed and/or parenthesization ---

Deno.test("or inside and gets parenthesized", () => {
  const c = cmp("a", "1").or(cmp("b", "2")).and(cmp("c", "3"));
  assertEquals(c.toExpression(), "(a == '1' || b == '2') && c == '3'");
});

Deno.test("and inside or gets parenthesized", () => {
  const c = cmp("a", "1").and(cmp("b", "2")).or(cmp("c", "3"));
  assertEquals(c.toExpression(), "(a == '1' && b == '2') || c == '3'");
});

Deno.test("or on right side of and gets parenthesized", () => {
  const c = cmp("a", "1").and(cmp("b", "2").or(cmp("c", "3")));
  assertEquals(c.toExpression(), "a == '1' && (b == '2' || c == '3')");
});

// --- Condition: not ---

Deno.test("not negates a comparison", () => {
  assertEquals(cmp("a", "1").not().toExpression(), "a != '1'");
});

Deno.test("not negates a function call", () => {
  assertEquals(
    fn("startsWith", ["github.ref", "'refs/tags/'"]).not().toExpression(),
    "!startsWith(github.ref, 'refs/tags/')",
  );
});

Deno.test("not parenthesizes logical conditions", () => {
  const c = cmp("a", "1").and(cmp("b", "2")).not();
  assertEquals(c.toExpression(), "!(a == '1' && b == '2')");
});

Deno.test("not parenthesizes or conditions", () => {
  const c = cmp("a", "1").or(cmp("b", "2")).not();
  assertEquals(c.toExpression(), "!(a == '1' || b == '2')");
});

Deno.test("double not", () => {
  const c = cmp("a", "1").not().not();
  assertEquals(c.toExpression(), "a == '1'");
});

// --- Condition: source tracking ---

Deno.test("Condition no sources by default", () => {
  assertEquals(cmp("a", "1").sources.size, 0);
});

Deno.test("Condition sources passed to constructor are preserved", () => {
  const src = { id: "s1" };
  const c = cmp("a", "1", [src]);
  assertEquals(c.sources.size, 1);
  assertEquals(c.sources.has(src), true);
});

Deno.test("Condition and unions sources", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const c = cmp("a", "1", [s1]).and(cmp("b", "2", [s2]));
  assertEquals(c.sources.size, 2);
  assertEquals(c.sources.has(s1), true);
  assertEquals(c.sources.has(s2), true);
});

Deno.test("Condition or unions sources", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const c = cmp("a", "1", [s1]).or(cmp("b", "2", [s2]));
  assertEquals(c.sources.size, 2);
  assertEquals(c.sources.has(s1), true);
  assertEquals(c.sources.has(s2), true);
});

Deno.test("Condition not preserves sources", () => {
  const s1 = { id: "s1" };
  const c = cmp("a", "1", [s1]).not();
  assertEquals(c.sources.size, 1);
  assertEquals(c.sources.has(s1), true);
});

Deno.test("Condition complex chain unions all sources", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const s3 = { id: "s3" };
  const c = cmp("a", "1", [s1])
    .and(cmp("b", "2", [s2]))
    .or(cmp("c", "3", [s3]).not());
  assertEquals(c.sources.size, 3);
});

Deno.test("Condition duplicate sources are deduplicated", () => {
  const s1 = { id: "s1" };
  const c = cmp("a", "1", [s1]).and(cmp("b", "2", [s1]));
  assertEquals(c.sources.size, 1);
});

// --- RawCondition parenthesization ---

function raw(expr: string, sources: ExpressionSource[] = []) {
  return new RawCondition(expr, new Set(sources));
}

Deno.test("raw condition without operators is not parenthesized in and", () => {
  const c = cmp("a", "1").and(raw("matrix.skip"));
  assertEquals(c.toExpression(), "a == '1' && matrix.skip");
});

Deno.test("raw condition without operators is not parenthesized in or", () => {
  const c = cmp("a", "1").or(raw("!(matrix.skip)"));
  assertEquals(c.toExpression(), "a == '1' || !(matrix.skip)");
});

Deno.test("raw condition with || is parenthesized in and", () => {
  const c = cmp("a", "1").and(raw("b || c"));
  assertEquals(c.toExpression(), "a == '1' && (b || c)");
});

Deno.test("raw condition with && is parenthesized in or", () => {
  const c = cmp("a", "1").or(raw("b && c"));
  assertEquals(c.toExpression(), "a == '1' || (b && c)");
});

// --- construction-time simplification ---

Deno.test("RawCondition('true').not() simplifies to false", () => {
  assertEquals(raw("true").not().toExpression(), "false");
});

Deno.test("RawCondition('false').not() simplifies to true", () => {
  assertEquals(raw("false").not().toExpression(), "true");
});

Deno.test("true.and(condition) simplifies to condition", () => {
  const c = raw("true").and(cmp("a", "1"));
  assertEquals(c.toExpression(), "a == '1'");
});

Deno.test("condition.and(true) simplifies to condition", () => {
  const c = cmp("a", "1").and(raw("true"));
  assertEquals(c.toExpression(), "a == '1'");
});

Deno.test("false.and(condition) simplifies to false", () => {
  const c = raw("false").and(cmp("a", "1"));
  assertEquals(c.toExpression(), "false");
});

Deno.test("condition.and(false condition) simplifies to false", () => {
  const c = cmp("a", "1").and(raw("false"));
  assertEquals(c.toExpression(), "false");
});

Deno.test("false.or(condition) simplifies to condition", () => {
  const c = raw("false").or(cmp("a", "1"));
  assertEquals(c.toExpression(), "a == '1'");
});

Deno.test("condition.or(false) simplifies to condition", () => {
  const c = cmp("a", "1").or(raw("false"));
  assertEquals(c.toExpression(), "a == '1'");
});

Deno.test("true.or(condition) simplifies to true", () => {
  const c = raw("true").or(cmp("a", "1"));
  assertEquals(c.toExpression(), "true");
});

Deno.test("condition.or(true condition) simplifies to true", () => {
  const c = cmp("a", "1").or(raw("true"));
  assertEquals(c.toExpression(), "true");
});

Deno.test("!false && condition simplifies to condition", () => {
  const c = raw("false").not().and(cmp("a", "1"));
  assertEquals(c.toExpression(), "a == '1'");
});

Deno.test("true && true simplifies to true", () => {
  assertEquals(raw("true").and(raw("true")).toExpression(), "true");
});

// --- literal comparison simplification ---

Deno.test("literal equals same value simplifies to true", () => {
  const v = new ExpressionValue("'linux'");
  assertEquals(v.equals("linux").toExpression(), "true");
});

Deno.test("literal equals different value simplifies to false", () => {
  const v = new ExpressionValue("'linux'");
  assertEquals(v.equals("windows").toExpression(), "false");
});

Deno.test("literal notEquals same value simplifies to false", () => {
  const v = new ExpressionValue("'linux'");
  assertEquals(v.notEquals("linux").toExpression(), "false");
});

Deno.test("literal notEquals different value simplifies to true", () => {
  const v = new ExpressionValue("'linux'");
  assertEquals(v.notEquals("windows").toExpression(), "true");
});

Deno.test("number literal equals simplifies", () => {
  const v = new ExpressionValue("42");
  assertEquals(v.equals(42).toExpression(), "true");
  assertEquals(v.equals(99).toExpression(), "false");
});

Deno.test("non-literal equals does not simplify", () => {
  const v = new ExpressionValue("matrix.os");
  assertEquals(v.equals("linux").toExpression(), "matrix.os == 'linux'");
});

// --- conditions.isTrue() / conditions.isFalse() ---

Deno.test("conditions.isTrue() produces true condition", () => {
  const c = conditions.isTrue();
  assertEquals(c.toExpression(), "true");
  assertEquals(isAlwaysTrue(c), true);
  assertEquals(isAlwaysFalse(c), false);
});

Deno.test("conditions.isFalse() produces false condition", () => {
  const c = conditions.isFalse();
  assertEquals(c.toExpression(), "false");
  assertEquals(isAlwaysFalse(c), true);
  assertEquals(isAlwaysTrue(c), false);
});

Deno.test("conditions.isTrue().and(condition) simplifies to condition", () => {
  const c = conditions.isTrue().and(cmp("a", "1"));
  assertEquals(c.toExpression(), "a == '1'");
});

Deno.test("conditions.isFalse().or(condition) simplifies to condition", () => {
  const c = conditions.isFalse().or(cmp("a", "1"));
  assertEquals(c.toExpression(), "a == '1'");
});

Deno.test("conditions.isTrue().not() simplifies to false", () => {
  assertEquals(conditions.isTrue().not().toExpression(), "false");
});

Deno.test("conditions.isFalse().not() simplifies to true", () => {
  assertEquals(conditions.isFalse().not().toExpression(), "true");
});

// --- literal() ---

Deno.test("literal string supports .equals()", () => {
  assertEquals(literal("linux").equals("linux").toExpression(), "true");
  assertEquals(literal("linux").equals("windows").toExpression(), "false");
});

Deno.test("literal string supports .notEquals()", () => {
  assertEquals(literal("linux").notEquals("linux").toExpression(), "false");
  assertEquals(literal("linux").notEquals("windows").toExpression(), "true");
});

Deno.test("literal number supports .equals()", () => {
  assertEquals(literal(42).equals(42).toExpression(), "true");
  assertEquals(literal(42).equals(0).toExpression(), "false");
});

Deno.test("literal boolean true returns always-true condition", () => {
  const c = literal(true);
  assertEquals(c instanceof Condition, true);
  assertEquals(c.toExpression(), "true");
  assertEquals(c.isAlwaysTrue(), true);
  assertEquals(c.isAlwaysFalse(), false);
});

Deno.test("literal boolean false returns always-false condition", () => {
  const c = literal(false);
  assertEquals(c instanceof Condition, true);
  assertEquals(c.toExpression(), "false");
  assertEquals(c.isAlwaysTrue(), false);
  assertEquals(c.isAlwaysFalse(), true);
});

Deno.test("literal string serializes as plain value", () => {
  assertEquals(literal("ubuntu-latest").toString(), "ubuntu-latest");
});

Deno.test("literal number serializes as plain value", () => {
  assertEquals(literal(42).toString(), "42");
});

// --- and/or deduplication ---

Deno.test("and deduplicates identical terms", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  // (a && b).and(b) should not repeat b
  assertEquals(a.and(b).and(b).toExpression(), "a == '1' && b == '2'");
});

Deno.test("and deduplicates when both sides share a term", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  const c = cmp("c", "3");
  // (a && b).and(b && c) → a && b && c
  assertEquals(
    a.and(b).and(b.and(c)).toExpression(),
    "a == '1' && b == '2' && c == '3'",
  );
});

Deno.test("or deduplicates identical terms", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  // (a || b).or(b) should not repeat b
  assertEquals(a.or(b).or(b).toExpression(), "a == '1' || b == '2'");
});

Deno.test("or deduplicates when both sides share a term", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  const c = cmp("c", "3");
  // (a || b).or(b || c) → a || b || c
  assertEquals(
    a.or(b).or(b.or(c)).toExpression(),
    "a == '1' || b == '2' || c == '3'",
  );
});

Deno.test("and returns left when right is fully duplicate", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  const combined = a.and(b);
  // combining with a subset should return the existing condition
  assertEquals(combined.and(a).toExpression(), "a == '1' && b == '2'");
});

Deno.test("deduplication works with function call conditions", () => {
  const isTag = fn("startsWith", ["github.ref", "'refs/tags/'"]);
  const isMain = cmp("github.ref", "refs/heads/main");
  // isTag.not().and(isMain.not()).and(isTag.not()) should not repeat isTag.not()
  assertEquals(
    isTag.not().and(isMain.not()).and(isTag.not()).toExpression(),
    "!startsWith(github.ref, 'refs/tags/') && github.ref != 'refs/heads/main'",
  );
});

// --- and/or absorption ---

Deno.test("and absorbs or containing a sibling term: (A || B) && B → B", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  assertEquals(a.or(b).and(b).toExpression(), "b == '2'");
});

Deno.test("and absorbs or on right: B && (A || B) → B", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  assertEquals(b.and(a.or(b)).toExpression(), "b == '2'");
});

Deno.test("and absorbs or with extra terms: (A || B) && B && C → B && C", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  const c = cmp("c", "3");
  assertEquals(a.or(b).and(b).and(c).toExpression(), "b == '2' && c == '3'");
});

Deno.test("and absorbs multiple or terms: (A || B) && (C || B) && B → B", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  const c = cmp("c", "3");
  assertEquals(
    a.or(b).and(c.or(b)).and(b).toExpression(),
    "b == '2'",
  );
});

Deno.test("or absorbs and containing a sibling term: (A && B) || B → B", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  assertEquals(a.and(b).or(b).toExpression(), "b == '2'");
});

Deno.test("or absorbs and on right: B || (A && B) → B", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  assertEquals(b.or(a.and(b)).toExpression(), "b == '2'");
});

Deno.test("and does not absorb when no overlap", () => {
  const a = cmp("a", "1");
  const b = cmp("b", "2");
  const c = cmp("c", "3");
  assertEquals(
    a.or(b).and(c).toExpression(),
    "(a == '1' || b == '2') && c == '3'",
  );
});

// --- defineExprObj ---

Deno.test("defineExprObj: string values become ExpressionValue", () => {
  const m = defineExprObj({ os: "linux" });
  assertEquals(m.os instanceof ExpressionValue, true);
  // serializes inline, not as ${{ }}
  assertEquals(m.os.toString(), "linux");
});

Deno.test("defineExprObj: boolean true becomes Condition", () => {
  const m = defineExprObj({ skip: true });
  assertEquals(m.skip instanceof Condition, true);
  assertEquals(m.skip.toExpression(), "true");
});

Deno.test("defineExprObj: boolean false becomes Condition", () => {
  const m = defineExprObj({ skip: false });
  assertEquals(m.skip instanceof Condition, true);
  assertEquals(m.skip.toExpression(), "false");
});

Deno.test("defineExprObj: Condition values pass through", () => {
  const cond = conditions.isBranch("main");
  const m = defineExprObj({ skip: cond });
  assertEquals(m.skip, cond);
});

Deno.test("defineExprObj: ExpressionValue values pass through", () => {
  const e = expr("matrix.os");
  const m = defineExprObj({ os: e });
  assertEquals(m.os, e);
});

Deno.test("defineExprObj: number values become ExpressionValue", () => {
  const m = defineExprObj({ count: 42 });
  assertEquals(m.count instanceof ExpressionValue, true);
  assertEquals(m.count.toString(), "42");
});

Deno.test("defineExprObj: .equals() simplifies literal comparisons", () => {
  const m = defineExprObj({ os: "linux" });
  // same literal → simplifies to true
  assertEquals(m.os.equals("linux").toExpression(), "true");
  // different literal → simplifies to false
  assertEquals(m.os.equals("windows").toExpression(), "false");
  // notEquals: same → false, different → true
  assertEquals(m.os.notEquals("linux").toExpression(), "false");
  assertEquals(m.os.notEquals("windows").toExpression(), "true");
});

// --- concat ---

Deno.test("concat string + expression", () => {
  const v = concat("build-", expr("matrix.os"));
  assertEquals(v.toString(), "build-${{ matrix.os }}");
  assertEquals(v.expression, "format('build-{0}', matrix.os)");
});

Deno.test("concat expression + string", () => {
  const v = concat(expr("matrix.os"), "-latest");
  assertEquals(v.toString(), "${{ matrix.os }}-latest");
  assertEquals(v.expression, "format('{0}-latest', matrix.os)");
});

Deno.test("concat multiple expressions with strings", () => {
  const v = concat("build-", expr("matrix.os"), "-", expr("matrix.arch"));
  assertEquals(v.toString(), "build-${{ matrix.os }}-${{ matrix.arch }}");
  assertEquals(
    v.expression,
    "format('build-{0}-{1}', matrix.os, matrix.arch)",
  );
});

Deno.test("concat with no args returns empty inline value", () => {
  const v = concat();
  assertEquals(v.toString(), "");
});

Deno.test("concat with single string returns inline value", () => {
  const v = concat("hello");
  assertEquals(v.toString(), "hello");
});

Deno.test("concat with single expression returns it as-is", () => {
  const e = expr("matrix.os");
  const v = concat(e);
  assertEquals(v, e);
});

Deno.test("concat merges adjacent strings", () => {
  const v = concat("hello", " ", "world", expr("x"));
  assertEquals(v.toString(), "hello world${{ x }}");
  assertEquals(v.expression, "format('hello world{0}', x)");
});

Deno.test("concat all strings returns inline value", () => {
  const v = concat("hello", " ", "world");
  assertEquals(v.toString(), "hello world");
});

Deno.test("concat with numbers", () => {
  const v = concat("port-", 8080);
  assertEquals(v.toString(), "port-8080");
});

Deno.test("concat with number and expression", () => {
  const v = concat("v", 1, "-", expr("matrix.os"));
  assertEquals(v.toString(), "v1-${{ matrix.os }}");
  assertEquals(v.expression, "format('v1-{0}', matrix.os)");
});

Deno.test("concat escapes single quotes in format template", () => {
  const v = concat("it's-", expr("matrix.os"));
  assertEquals(v.expression, "format('it''s-{0}', matrix.os)");
  assertEquals(v.toString(), "it's-${{ matrix.os }}");
});

Deno.test("concat escapes braces in format template", () => {
  const v = concat("{prefix}-", expr("matrix.os"));
  assertEquals(v.expression, "format('{{prefix}}-{0}', matrix.os)");
  assertEquals(v.toString(), "{prefix}-${{ matrix.os }}");
});

Deno.test("concat tracks sources from all expressions", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const v1 = new ExpressionValue("steps.a.outputs.x", s1);
  const v2 = new ExpressionValue("steps.b.outputs.y", s2);
  const v = concat("prefix-", v1, "-", v2);
  assertEquals(v[internal.allSources].size, 2);
  assertEquals(v[internal.allSources].has(s1), true);
  assertEquals(v[internal.allSources].has(s2), true);
});

Deno.test("concat result works with .equals()", () => {
  const v = concat("refs/heads/", expr("matrix.branch"));
  assertEquals(
    v.equals("refs/heads/main").toExpression(),
    "format('refs/heads/{0}', matrix.branch) == 'refs/heads/main'",
  );
});

Deno.test("concat result works with .startsWith()", () => {
  const v = concat("prefix-", expr("matrix.os"));
  assertEquals(
    v.startsWith("prefix-linux").toExpression(),
    "startsWith(format('prefix-{0}', matrix.os), 'prefix-linux')",
  );
});

Deno.test("concat flattens nested concats", () => {
  const inner = concat("a-", expr("x"));
  const outer = concat(inner, "-b-", expr("y"));
  assertEquals(outer.toString(), "a-${{ x }}-b-${{ y }}");
  assertEquals(outer.expression, "format('a-{0}-b-{1}', x, y)");
});

Deno.test("concat flattens and merges adjacent strings across nesting", () => {
  const inner = concat(expr("x"), "-suffix");
  const outer = concat("prefix-", inner);
  assertEquals(outer.toString(), "prefix-${{ x }}-suffix");
  assertEquals(outer.expression, "format('prefix-{0}-suffix', x)");
});

Deno.test("concat with literal() expression", () => {
  const v = concat("prefix-", literal("foo"), "-suffix");
  assertEquals(v.toString(), "prefix-foo-suffix");
});

Deno.test("ExpressionValue.concat() method", () => {
  const v = expr("matrix.os").concat("-latest");
  assertEquals(v.toString(), "${{ matrix.os }}-latest");
  assertEquals(v.expression, "format('{0}-latest', matrix.os)");
});

Deno.test("ExpressionValue.concat() with multiple parts", () => {
  const v = literal("a-").concat(expr("matrix.os"), "-b");
  assertEquals(v.toString(), "a-${{ matrix.os }}-b");
  assertEquals(v.expression, "format('a-{0}-b', matrix.os)");
});

// --- endsWith ---

Deno.test("endsWith produces function call", () => {
  const c = expr("github.ref").endsWith("/main");
  assertEquals(c.toExpression(), "endsWith(github.ref, '/main')");
});

Deno.test("endsWith source tracking", () => {
  const s = { id: "s1" };
  const v = new ExpressionValue("steps.a.outputs.x", s);
  const c = v.endsWith("test");
  assertEquals(c.sources.size, 1);
  assertEquals(c.sources.has(s), true);
});

// --- numeric comparisons ---

Deno.test("greaterThan produces comparison", () => {
  const c = expr("matrix.count").greaterThan(5);
  assertEquals(c.toExpression(), "matrix.count > 5");
});

Deno.test("greaterThanOrEqual produces comparison", () => {
  const c = expr("matrix.count").greaterThanOrEqual(5);
  assertEquals(c.toExpression(), "matrix.count >= 5");
});

Deno.test("lessThan produces comparison", () => {
  const c = expr("matrix.count").lessThan(10);
  assertEquals(c.toExpression(), "matrix.count < 10");
});

Deno.test("lessThanOrEqual produces comparison", () => {
  const c = expr("matrix.count").lessThanOrEqual(10);
  assertEquals(c.toExpression(), "matrix.count <= 10");
});

Deno.test("greaterThan.not() produces lessThanOrEqual", () => {
  const c = expr("x").greaterThan(5).not();
  assertEquals(c.toExpression(), "x <= 5");
});

Deno.test("lessThan.not() produces greaterThanOrEqual", () => {
  const c = expr("x").lessThan(5).not();
  assertEquals(c.toExpression(), "x >= 5");
});

Deno.test("greaterThanOrEqual.not() produces lessThan", () => {
  const c = expr("x").greaterThanOrEqual(5).not();
  assertEquals(c.toExpression(), "x < 5");
});

Deno.test("lessThanOrEqual.not() produces greaterThan", () => {
  const c = expr("x").lessThanOrEqual(5).not();
  assertEquals(c.toExpression(), "x > 5");
});

Deno.test("numeric comparison source tracking", () => {
  const s = { id: "s1" };
  const v = new ExpressionValue("steps.a.outputs.count", s);
  const c = v.greaterThan(0);
  assertEquals(c.sources.size, 1);
  assertEquals(c.sources.has(s), true);
});

Deno.test("numeric comparison in and/or chain", () => {
  const c = expr("x").greaterThan(0).and(expr("x").lessThan(100));
  assertEquals(c.toExpression(), "x > 0 && x < 100");
});

// --- fromJSON ---

Deno.test("fromJSON with expression", () => {
  const v = fromJSON(expr("needs.setup.outputs.matrix"));
  assertEquals(v.toString(), "${{ fromJSON(needs.setup.outputs.matrix) }}");
  assertEquals(v.expression, "fromJSON(needs.setup.outputs.matrix)");
});

Deno.test("fromJSON with string", () => {
  const v = fromJSON('{"key": "value"}');
  assertEquals(v.toString(), '${{ fromJSON(\'{"key": "value"}\') }}');
  assertEquals(v.expression, 'fromJSON(\'{"key": "value"}\')');
});

Deno.test("fromJSON tracks sources", () => {
  const s = { id: "s1" };
  const v = new ExpressionValue("needs.setup.outputs.matrix", s);
  const result = fromJSON(v);
  assertEquals(result[internal.allSources].size, 1);
  assertEquals(result[internal.allSources].has(s), true);
});

// --- toJSON ---

Deno.test("toJSON with expression", () => {
  const v = toJSON(expr("github.event"));
  assertEquals(v.toString(), "${{ toJSON(github.event) }}");
  assertEquals(v.expression, "toJSON(github.event)");
});

Deno.test("toJSON tracks sources", () => {
  const s = { id: "s1" };
  const v = new ExpressionValue("steps.a.outputs.data", s);
  const result = toJSON(v);
  assertEquals(result[internal.allSources].size, 1);
  assertEquals(result[internal.allSources].has(s), true);
});

Deno.test("ExpressionValue.toJSON() method", () => {
  const v = expr("github.event").toJSON();
  assertEquals(v.toString(), "${{ toJSON(github.event) }}");
});

// --- hashFiles ---

Deno.test("hashFiles with single pattern", () => {
  const v = hashFiles("**/package-lock.json");
  assertEquals(v.toString(), "${{ hashFiles('**/package-lock.json') }}");
  assertEquals(v.expression, "hashFiles('**/package-lock.json')");
});

Deno.test("hashFiles with multiple patterns", () => {
  const v = hashFiles("**/package-lock.json", "**/yarn.lock");
  assertEquals(
    v.toString(),
    "${{ hashFiles('**/package-lock.json', '**/yarn.lock') }}",
  );
});

Deno.test("hashFiles with expression pattern", () => {
  const v = hashFiles(expr("matrix.lockfile"));
  assertEquals(v.toString(), "${{ hashFiles(matrix.lockfile) }}");
  assertEquals(v.expression, "hashFiles(matrix.lockfile)");
});

Deno.test("hashFiles tracks sources from expression patterns", () => {
  const s = { id: "s1" };
  const v = new ExpressionValue("steps.a.outputs.pattern", s);
  const result = hashFiles(v);
  assertEquals(result[internal.allSources].size, 1);
  assertEquals(result[internal.allSources].has(s), true);
});

Deno.test("hashFiles result works with concat for cache keys", () => {
  const hash = hashFiles("**/package-lock.json");
  const key = concat("node-", expr("runner.os"), "-", hash);
  assertEquals(
    key.toString(),
    "node-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}",
  );
});

// --- join ---

Deno.test("join with separator", () => {
  const v = join(expr("github.event.pull_request.labels.*.name"), ", ");
  assertEquals(
    v.toString(),
    "${{ join(github.event.pull_request.labels.*.name, ', ') }}",
  );
  assertEquals(
    v.expression,
    "join(github.event.pull_request.labels.*.name, ', ')",
  );
});

Deno.test("join without separator", () => {
  const v = join(expr("matrix.os"));
  assertEquals(v.toString(), "${{ join(matrix.os) }}");
  assertEquals(v.expression, "join(matrix.os)");
});

Deno.test("join tracks sources", () => {
  const s = { id: "s1" };
  const v = new ExpressionValue("steps.a.outputs.list", s);
  const result = join(v, ",");
  assertEquals(result[internal.allSources].size, 1);
  assertEquals(result[internal.allSources].has(s), true);
});

Deno.test("join with an empty separator", () => {
  assertEquals(join(expr("x"), "").expression, "join(x, '')");
});

// --- single quote escaping ---

Deno.test("formatLiteral quotes strings and doubles inner quotes", () => {
  assertEquals(formatLiteral("linux"), "'linux'");
  assertEquals(formatLiteral("it's"), "'it''s'");
  assertEquals(formatLiteral("''"), "''''''");
  assertEquals(formatLiteral(42), "42");
  assertEquals(formatLiteral(true), "true");
});

Deno.test("equals escapes single quotes in the compared value", () => {
  assertEquals(
    expr("matrix.name").equals("it's").toExpression(),
    "matrix.name == 'it''s'",
  );
});

Deno.test("notEquals escapes single quotes in the compared value", () => {
  assertEquals(
    expr("matrix.name").notEquals("it's").toExpression(),
    "matrix.name != 'it''s'",
  );
});

Deno.test("startsWith/endsWith/contains escape single quotes", () => {
  assertEquals(
    expr("x").startsWith("a'b").toExpression(),
    "startsWith(x, 'a''b')",
  );
  assertEquals(expr("x").endsWith("a'b").toExpression(), "endsWith(x, 'a''b')");
  assertEquals(expr("x").contains("a'b").toExpression(), "contains(x, 'a''b')");
});

Deno.test("literal escapes single quotes in its expression", () => {
  const v = literal("it's");
  assertEquals(v.expression, "'it''s'");
  // the plain form is unescaped since it is not inside an expression
  assertEquals(v.toString(), "it's");
});

Deno.test("literal with quotes still simplifies comparisons", () => {
  assertEquals(literal("it's").equals("it's").toExpression(), "true");
  assertEquals(literal("it's").notEquals("it's").toExpression(), "false");
  assertEquals(literal("it's").equals("its").toExpression(), "false");
});

Deno.test("join escapes single quotes in the separator", () => {
  assertEquals(join(expr("x"), "', '").expression, "join(x, ''', ''')");
});

Deno.test("fromJSON escapes single quotes in a string argument", () => {
  assertEquals(fromJSON("{'a': 1}").expression, "fromJSON('{''a'': 1}')");
});

Deno.test("hashFiles escapes single quotes in a pattern", () => {
  assertEquals(hashFiles("a'b/*.txt").expression, "hashFiles('a''b/*.txt')");
});

Deno.test("ternary values escape single quotes", () => {
  const v = cmp("a", "1").then("it's").else("its");
  assertEquals(v.expression, "a == '1' && 'it''s' || 'its'");
});

// --- literal detection ---

Deno.test("comparison of literals with different types is not simplified", () => {
  // GitHub coerces mismatched types at runtime, so this can't be decided here
  assertEquals(literal("42").equals(42).toExpression(), "'42' == 42");
  assertEquals(literal(42).equals("42").toExpression(), "42 == '42'");
  assertEquals(
    literal("true").notEquals(true).toExpression(),
    "'true' != true",
  );
});

Deno.test("string literals compare ignoring case, like GitHub does", () => {
  // "GitHub ignores case when comparing strings"
  assertEquals(literal("Linux").equals("linux").toExpression(), "true");
  assertEquals(literal("Linux").notEquals("linux").toExpression(), "false");
  assertEquals(literal("macOS").equals("MACOS").toExpression(), "true");
  assertEquals(literal("X64").equals("x64").toExpression(), "true");
  assertEquals(literal("Linux").equals("windows").toExpression(), "false");
  assertEquals(literal("Linux").notEquals("windows").toExpression(), "true");
});

Deno.test("defineExprObj comparisons ignore case", () => {
  const m = defineExprObj({ os: "Linux" });
  assertEquals(m.os.equals("linux").toExpression(), "true");
  assertEquals(m.os.notEquals("linux").toExpression(), "false");
});

Deno.test("case-insensitive comparison also applies to escaped quotes", () => {
  assertEquals(literal("It's").equals("IT'S").toExpression(), "true");
});

Deno.test("strings differing only by non-ASCII case are left to GitHub", () => {
  // JavaScript and GitHub don't necessarily fold non-ASCII the same way
  assertEquals(literal("Ä").equals("ä").toExpression(), "'Ä' == 'ä'");
});

Deno.test("NaN and Infinity are not treated as number literals", () => {
  // neither is valid GitHub literal syntax, and NaN never equals itself
  assertEquals(
    new ExpressionValue("NaN").equals(NaN).toExpression(),
    "NaN == NaN",
  );
  assertEquals(
    new ExpressionValue("Infinity").equals(1).toExpression(),
    "Infinity == 1",
  );
});

Deno.test("boolean literal expression simplifies against a boolean", () => {
  assertEquals(new ExpressionValue("true").equals(true).toExpression(), "true");
  assertEquals(
    new ExpressionValue("true").equals(false).toExpression(),
    "false",
  );
});

Deno.test("expression that only starts and ends with a quote is not a literal", () => {
  const v = new ExpressionValue("'a' == 'b'");
  assertEquals(v.equals("c").toExpression(), "'a' == 'b' == 'c'");
});

Deno.test("empty string literal is detected as a literal", () => {
  assertEquals(literal("").equals("").toExpression(), "true");
  assertEquals(literal("").equals("x").toExpression(), "false");
});

Deno.test("a lone quote is not treated as a literal", () => {
  const v = new ExpressionValue("'");
  assertEquals(v.equals("x").toExpression(), "' == 'x'");
});

// --- not: precedence and double negation ---

Deno.test("not parenthesizes raw conditions containing logical operators", () => {
  assertEquals(raw("a && b").not().toExpression(), "!(a && b)");
  assertEquals(raw("a || b").not().toExpression(), "!(a || b)");
});

Deno.test("not parenthesizes raw conditions containing comparisons", () => {
  assertEquals(raw("a == 'b'").not().toExpression(), "!(a == 'b')");
  assertEquals(raw("a > 1").not().toExpression(), "!(a > 1)");
});

Deno.test("not does not parenthesize simple raw conditions", () => {
  assertEquals(raw("matrix.skip").not().toExpression(), "!matrix.skip");
});

Deno.test("double not on a function call cancels out", () => {
  const c = fn("always", []);
  assertEquals(c.not().not().toExpression(), "always()");
  assertEquals(c.not().not().not().toExpression(), "!always()");
});

Deno.test("double not on a raw condition cancels out", () => {
  assertEquals(raw("matrix.skip").not().not().toExpression(), "matrix.skip");
});

Deno.test("double not preserves sources", () => {
  const s = { id: "s1" };
  const c = fn("always", [], [s]);
  assertEquals(c.not().not().sources.has(s), true);
});

Deno.test("ExpressionValue.not() parenthesizes its expression", () => {
  assertEquals(expr("matrix.skip").not().toExpression(), "!(matrix.skip)");
});

// --- comparison precedence ---

Deno.test("comparison parenthesizes a left side with logical operators", () => {
  const ternary = cmp("a", "1").then("x").else("y");
  assertEquals(
    ternary.equals("x").toExpression(),
    "(a == '1' && 'x' || 'y') == 'x'",
  );
  assertEquals(
    ternary.notEquals("x").toExpression(),
    "(a == '1' && 'x' || 'y') != 'x'",
  );
});

Deno.test("comparison leaves a simple left side alone", () => {
  assertEquals(
    concat("a-", expr("x")).equals("a-b").toExpression(),
    "format('a-{0}', x) == 'a-b'",
  );
});

// --- ternary: then / elseIf / else ---

Deno.test("ternary then/else renders as cond && value || fallback", () => {
  const v = expr("matrix.os").equals("linux").then("ubuntu-latest").else(
    "macos-latest",
  );
  assertEquals(
    v.expression,
    "matrix.os == 'linux' && 'ubuntu-latest' || 'macos-latest'",
  );
  assertEquals(
    v.toString(),
    "${{ matrix.os == 'linux' && 'ubuntu-latest' || 'macos-latest' }}",
  );
});

Deno.test("ternary with truthy number and boolean values", () => {
  // only truthy `then` values work; the falsy direction throws, see below
  assertEquals(cmp("a", "1").then(1).else(0).expression, "a == '1' && 1 || 0");
  assertEquals(
    cmp("a", "1").then(true).else(false).expression,
    "a == '1' && true || false",
  );
});

Deno.test("ternary rejects falsy then values", () => {
  // `cond && '' || 'x'` would always produce 'x'
  for (const value of [false, 0, ""] as const) {
    assertThrows(
      () => cmp("a", "1").then(value),
      Error,
      "A ternary value must not be falsy",
    );
  }
});

Deno.test("ternary rejects falsy literal expression values", () => {
  assertThrows(() => cmp("a", "1").then(literal("")), Error, "must not be");
  assertThrows(() => cmp("a", "1").then(literal(0)), Error, "must not be");
  assertThrows(() => cmp("a", "1").then(expr("false")), Error, "must not be");
});

Deno.test("ternary rejects falsy values in elseIf branches", () => {
  assertThrows(
    () => cmp("a", "1").then("x").elseIf(cmp("b", "2")).then(""),
    Error,
    "A ternary value must not be falsy",
  );
});

Deno.test("ternary allows falsy else values and dynamic then values", () => {
  // the fallback is the last operand, so a falsy value there is fine
  assertEquals(
    cmp("a", "1").then("x").else("").expression,
    "a == '1' && 'x' || ''",
  );
  assertEquals(
    cmp("a", "1").then(true).else(false).expression.endsWith("false"),
    true,
  );
  // a dynamic value can't be checked, so it is allowed through
  assertEquals(
    cmp("a", "1").then(expr("matrix.value")).else("x").expression,
    "a == '1' && matrix.value || 'x'",
  );
});

Deno.test("ternary with an expression value", () => {
  const v = cmp("a", "1").then(expr("matrix.runner")).else("ubuntu-latest");
  assertEquals(v.expression, "a == '1' && matrix.runner || 'ubuntu-latest'");
});

Deno.test("ternary elseIf adds a branch", () => {
  const v = cmp("a", "1")
    .then("x")
    .elseIf(cmp("b", "2"))
    .then("y")
    .else("z");
  assertEquals(v.expression, "a == '1' && 'x' || b == '2' && 'y' || 'z'");
});

Deno.test("ternary elseIf chains multiple branches", () => {
  const v = cmp("a", "1")
    .then("x")
    .elseIf(cmp("b", "2"))
    .then("y")
    .elseIf(cmp("c", "3"))
    .then("w")
    .else("z");
  assertEquals(
    v.expression,
    "a == '1' && 'x' || b == '2' && 'y' || c == '3' && 'w' || 'z'",
  );
});

Deno.test("ternary parenthesizes an or condition", () => {
  const v = cmp("a", "1").or(cmp("b", "2")).then("x").else("y");
  assertEquals(v.expression, "(a == '1' || b == '2') && 'x' || 'y'");
});

Deno.test("ternary parenthesizes a raw or condition", () => {
  const v = raw("a || b").then("x").else("y");
  assertEquals(v.expression, "(a || b) && 'x' || 'y'");
});

Deno.test("ternary does not parenthesize an and condition", () => {
  const v = cmp("a", "1").and(cmp("b", "2")).then("x").else("y");
  assertEquals(v.expression, "a == '1' && b == '2' && 'x' || 'y'");
});

Deno.test("ternary parenthesizes a nested ternary value", () => {
  const inner = cmp("a", "1").then("x").else("y");
  const outer = cmp("b", "2").then(inner).else("z");
  assertEquals(outer.expression, "b == '2' && (a == '1' && 'x' || 'y') || 'z'");
});

Deno.test("ternary parenthesizes a nested ternary in the else branch", () => {
  const inner = cmp("a", "1").then("x").else("y");
  const outer = cmp("b", "2").then("q").else(inner);
  assertEquals(outer.expression, "b == '2' && 'q' || (a == '1' && 'x' || 'y')");
});

Deno.test("ternary does not parenthesize a concat value", () => {
  const v = cmp("a", "1").then(concat("build-", expr("matrix.os"))).else(
    "none",
  );
  assertEquals(
    v.expression,
    "a == '1' && format('build-{0}', matrix.os) || 'none'",
  );
});

Deno.test("ternary collects sources from conditions and values", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const s3 = { id: "s3" };
  const v = cmp("a", "1", [s1])
    .then(new ExpressionValue("steps.b.outputs.x", s2))
    .else(new ExpressionValue("steps.c.outputs.y", s3));
  assertEquals(v[internal.allSources].size, 3);
  assertEquals(v[internal.allSources].has(s1), true);
  assertEquals(v[internal.allSources].has(s2), true);
  assertEquals(v[internal.allSources].has(s3), true);
});

Deno.test("ternary collects sources from elseIf branches", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const v = cmp("a", "1", [s1])
    .then("x")
    .elseIf(cmp("b", "2", [s2]))
    .then("y")
    .else("z");
  assertEquals(v[internal.allSources].size, 2);
});

Deno.test("elseIf does not leak sources into the builder it came from", () => {
  const s2 = { id: "s2" };
  const builder = cmp("a", "1").then("x");
  builder.elseIf(cmp("b", "2", [s2]));
  assertEquals(builder.else("z")[internal.allSources].size, 0);
});

Deno.test("ternary can be used as a concat part", () => {
  const v = concat("os-", cmp("a", "1").then("linux").else("macos"));
  assertEquals(
    v.expression,
    "format('os-{0}', a == '1' && 'linux' || 'macos')",
  );
});

// --- conditions helpers ---

Deno.test("conditions.status functions", () => {
  assertEquals(conditions.status.always().toExpression(), "always()");
  assertEquals(conditions.status.success().toExpression(), "success()");
  assertEquals(conditions.status.failure().toExpression(), "failure()");
  assertEquals(conditions.status.cancelled().toExpression(), "cancelled()");
});

Deno.test("conditions.status.always() is not treated as always-true", () => {
  // it is a runtime function call, so it must survive simplification
  assertEquals(conditions.status.always().isAlwaysTrue(), false);
  assertEquals(
    conditions.status.always().and(cmp("a", "1")).toExpression(),
    "always() && a == '1'",
  );
});

Deno.test("conditions.isTag without a tag matches any tag", () => {
  assertEquals(
    conditions.isTag().toExpression(),
    "startsWith(github.ref, 'refs/tags/')",
  );
});

Deno.test("conditions.isTag with a tag matches that tag", () => {
  assertEquals(
    conditions.isTag("v1.0.0").toExpression(),
    "github.ref == 'refs/tags/v1.0.0'",
  );
});

Deno.test("conditions.isBranch", () => {
  assertEquals(
    conditions.isBranch("main").toExpression(),
    "github.ref == 'refs/heads/main'",
  );
});

Deno.test("conditions.isEvent and isPr", () => {
  assertEquals(
    conditions.isEvent("workflow_dispatch").toExpression(),
    "github.event_name == 'workflow_dispatch'",
  );
  assertEquals(
    conditions.isPr().toExpression(),
    "github.event_name == 'pull_request'",
  );
});

Deno.test("conditions.isRepository", () => {
  assertEquals(
    conditions.isRepository("denoland/deno").toExpression(),
    "github.repository == 'denoland/deno'",
  );
});

Deno.test("conditions.isDraftPr", () => {
  assertEquals(
    conditions.isDraftPr().toExpression(),
    "github.event.pull_request.draft == true",
  );
});

Deno.test("conditions.hasPrLabel", () => {
  assertEquals(
    conditions.hasPrLabel("ci-full").toExpression(),
    "contains(github.event.pull_request.labels.*.name, 'ci-full')",
  );
});

Deno.test("conditions.isRunnerOs and isRunnerArch", () => {
  assertEquals(
    conditions.isRunnerOs("Linux").toExpression(),
    "runner.os == 'Linux'",
  );
  assertEquals(
    conditions.isRunnerArch("ARM64").toExpression(),
    "runner.arch == 'ARM64'",
  );
});

Deno.test("conditions helpers carry no sources", () => {
  assertEquals(conditions.isTag().sources.size, 0);
  assertEquals(conditions.isPr().sources.size, 0);
});

Deno.test("conditions compose into a release condition", () => {
  const c = conditions.isTag()
    .and(conditions.isRepository("denoland/deno"))
    .and(conditions.isPr().not());
  assertEquals(
    c.toExpression(),
    "startsWith(github.ref, 'refs/tags/') && " +
      "github.repository == 'denoland/deno' && " +
      "github.event_name != 'pull_request'",
  );
});

// --- isAlwaysTrue / isAlwaysFalse helpers ---

Deno.test("isAlwaysTrue/isAlwaysFalse with strings", () => {
  assertEquals(isAlwaysTrue("true"), true);
  assertEquals(isAlwaysTrue("false"), false);
  assertEquals(isAlwaysTrue("github.ref == 'main'"), false);
  assertEquals(isAlwaysFalse("false"), true);
  assertEquals(isAlwaysFalse("true"), false);
});

Deno.test("isAlwaysTrue/isAlwaysFalse with an ExpressionValue", () => {
  assertEquals(isAlwaysTrue(expr("github.ref")), false);
  assertEquals(isAlwaysFalse(expr("github.ref")), false);
});

Deno.test("isAlwaysTrue with a negated always-false condition", () => {
  assertEquals(isAlwaysTrue(conditions.isFalse().not()), true);
});

Deno.test("isPossiblyTrue reflects always-false", () => {
  assertEquals(conditions.isFalse().isPossiblyTrue(), false);
  assertEquals(conditions.isTrue().isPossiblyTrue(), true);
  assertEquals(cmp("a", "1").isPossiblyTrue(), true);
});

// --- sourcesFrom ---

Deno.test("sourcesFrom collects from values and conditions", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const set = sourcesFrom(
    new ExpressionValue("a", s1),
    cmp("b", "2", [s2]),
  );
  assertEquals(set.size, 2);
  assertEquals(set.has(s1), true);
  assertEquals(set.has(s2), true);
});

Deno.test("sourcesFrom deduplicates and tolerates missing sources", () => {
  const s1 = { id: "s1" };
  const set = sourcesFrom(
    new ExpressionValue("a", s1),
    new ExpressionValue("b", s1),
    new ExpressionValue("c"),
  );
  assertEquals(set.size, 1);
});

Deno.test("ExpressionValue built from a source set tracks every source", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const v = new ExpressionValue("a", new Set([s1, s2]));
  assertEquals(v[internal.allSources].size, 2);
  assertEquals(v.equals("x").sources.size, 2);
});

// --- flattening ---

Deno.test("flattenAnd flattens nested ands only", () => {
  const c = cmp("a", "1").and(cmp("b", "2")).and(cmp("c", "3"));
  assertEquals(c[internal.flattenAnd]().map((t) => t.toExpression()), [
    "a == '1'",
    "b == '2'",
    "c == '3'",
  ]);
  assertEquals(c[internal.flattenOr]().length, 1);
});

Deno.test("flattenOr flattens nested ors only", () => {
  const c = cmp("a", "1").or(cmp("b", "2")).or(cmp("c", "3"));
  assertEquals(c[internal.flattenOr]().map((t) => t.toExpression()), [
    "a == '1'",
    "b == '2'",
    "c == '3'",
  ]);
  assertEquals(c[internal.flattenAnd]().length, 1);
});

Deno.test("getAndTerms returns and terms but not or terms", () => {
  assertEquals(cmp("a", "1").and(cmp("b", "2"))[internal.getAndTerms](), [
    "a == '1'",
    "b == '2'",
  ]);
  assertEquals(cmp("a", "1").or(cmp("b", "2"))[internal.getAndTerms](), [
    "a == '1' || b == '2'",
  ]);
});

// --- and/or source propagation ---

Deno.test("and(false) keeps the sources of both sides", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const c = cmp("a", "1", [s1]).and(new RawCondition("false", new Set([s2])));
  assertEquals(c.toExpression(), "false");
  assertEquals(c.sources.size, 2);
});

Deno.test("or(true) keeps the sources of both sides", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const c = cmp("a", "1", [s1]).or(new RawCondition("true", new Set([s2])));
  assertEquals(c.toExpression(), "true");
  assertEquals(c.sources.size, 2);
});

Deno.test("and/or with boolean arguments contribute no sources", () => {
  const s1 = { id: "s1" };
  assertEquals(cmp("a", "1", [s1]).and(true).sources.size, 1);
  assertEquals(cmp("a", "1", [s1]).and(false).sources.size, 1);
  assertEquals(cmp("a", "1", [s1]).or(true).sources.size, 1);
  assertEquals(cmp("a", "1", [s1]).or(false).sources.size, 1);
});

Deno.test("and keeps sources when every right term is already present", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const s3 = { id: "s3" };
  const c = raw("a", [s1]).and(raw("b", [s2])).and(raw("a", [s3]));
  assertEquals(c.toExpression(), "a && b");
  assertEquals(c.sources.size, 3);
  assertEquals(c.sources.has(s3), true);
});

Deno.test("or keeps sources when every right term is already present", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const c = cmp("a", "1", [s1]).or(cmp("a", "1", [s2]));
  assertEquals(c.toExpression(), "a == '1'");
  assertEquals(c.sources.size, 2);
});

Deno.test("withSources returns the same condition when nothing is added", () => {
  const s1 = { id: "s1" };
  const c = cmp("a", "1", [s1]);
  assertEquals(c[internal.withSources](new Set([s1])), c);
  assertEquals(c[internal.withSources](new Set()), c);
});

Deno.test("withSources preserves rendering for every condition kind", () => {
  const s = { id: "s1" };
  const extra = new Set([s]);
  const kinds = [
    cmp("a", "1"),
    fn("always", []),
    raw("matrix.skip"),
    cmp("a", "1").not(),
    cmp("a", "1").and(cmp("b", "2")),
  ];
  for (const c of kinds) {
    const withExtra = c[internal.withSources](extra);
    assertEquals(withExtra.toExpression(), c.toExpression());
    assertEquals(withExtra.sources.has(s), true);
  }
});

Deno.test("deduplicated and keeps sources from the dropped term", () => {
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };
  const s3 = { id: "s3" };
  // b is duplicated across both sides but carries a different source
  const c = cmp("a", "1", [s1]).and(cmp("b", "2", [s2]))
    .and(cmp("b", "2", [s3]).and(cmp("c", "3")));
  assertEquals(c.toExpression(), "a == '1' && b == '2' && c == '3'");
  assertEquals(c.sources.size, 3);
});

// --- concat edge cases ---

Deno.test("concat ignores empty string parts", () => {
  const v = concat("", expr("x"), "");
  assertEquals(v.expression, "format('{0}', x)");
  assertEquals(v.toString(), "${{ x }}");
});

Deno.test("concat of two expressions with nothing between them", () => {
  const v = concat(expr("x"), expr("y"));
  assertEquals(v.expression, "format('{0}{1}', x, y)");
  assertEquals(v.toString(), "${{ x }}${{ y }}");
});

Deno.test("concat with a single number returns an inline value", () => {
  assertEquals(concat(8080).toString(), "8080");
  // concatenation produces a string, so the number renders as a quoted one
  assertEquals(concat(8080).expression, "'8080'");
});

Deno.test("every concat path renders a lone number the same way", () => {
  const expected = concat(8080).expression;
  assertEquals(concat(8080, "").expression, expected);
  assertEquals(concat("", 8080).expression, expected);
  assertEquals(concat(concat(8080)).expression, expected);
  assertEquals(concat(80, 80).expression, expected);
});

Deno.test("concat escapes quotes coming from a literal part", () => {
  const v = concat(literal("it's-"), expr("matrix.os"));
  assertEquals(v.expression, "format('it''s-{0}', matrix.os)");
  assertEquals(v.toString(), "it's-${{ matrix.os }}");
});

Deno.test("concat repeats an expression that appears twice", () => {
  const v = concat(expr("x"), "-", expr("x"));
  assertEquals(v.expression, "format('{0}-{1}', x, x)");
});

Deno.test("concat of a concat result is stable", () => {
  const inner = concat("a-", expr("x"));
  assertEquals(concat(inner).expression, inner.expression);
  assertEquals(concat(inner, "").expression, inner.expression);
});

Deno.test("concat preserves sources through nesting", () => {
  const s1 = { id: "s1" };
  const inner = concat("a-", new ExpressionValue("steps.a.outputs.x", s1));
  const outer = concat(inner, "-b");
  assertEquals(outer[internal.allSources].size, 1);
  assertEquals(outer[internal.allSources].has(s1), true);
});

Deno.test("concat result can be negated", () => {
  const v = concat("a-", expr("x"));
  assertEquals(v.not().toExpression(), "!(format('a-{0}', x))");
});

// --- fromJSON / toJSON round trips ---

Deno.test("toJSON of fromJSON round trips the expression text", () => {
  const v = toJSON(fromJSON(expr("needs.setup.outputs.matrix")));
  assertEquals(v.expression, "toJSON(fromJSON(needs.setup.outputs.matrix))");
});

Deno.test("fromJSON of toJSON round trips the expression text", () => {
  const v = fromJSON(toJSON(expr("github.event")));
  assertEquals(v.expression, "fromJSON(toJSON(github.event))");
});

Deno.test("fromJSON of a string carries no sources", () => {
  assertEquals(fromJSON("[1, 2]")[internal.allSources].size, 0);
});

Deno.test("fromJSON result supports comparisons", () => {
  const v = fromJSON(expr("needs.setup.outputs.flag"));
  assertEquals(
    v.equals(true).toExpression(),
    "fromJSON(needs.setup.outputs.flag) == true",
  );
});

// --- hashFiles edge cases ---

Deno.test("hashFiles without patterns throws", () => {
  assertThrows(
    () => hashFiles(),
    Error,
    "hashFiles requires at least one pattern.",
  );
});

Deno.test("hashFiles mixes string and expression patterns", () => {
  const s = { id: "s1" };
  const v = hashFiles("deno.lock", new ExpressionValue("matrix.extra", s));
  assertEquals(v.expression, "hashFiles('deno.lock', matrix.extra)");
  assertEquals(v[internal.allSources].has(s), true);
});

// --- defineExprObj error path ---

Deno.test("defineExprObj throws for unsupported value types", () => {
  assertThrows(
    () => defineExprObj({ bad: null }),
    Error,
    'Unsupported value type for key "bad"',
  );
  assertThrows(
    () => defineExprObj({ bad: { nested: true } }),
    Error,
    'Unsupported value type for key "bad"',
  );
});

Deno.test("defineExprObj keeps keys and is usable in conditions", () => {
  const m = defineExprObj({ os: "linux", count: 2, skip: false });
  assertEquals(Object.keys(m), ["os", "count", "skip"]);
  assertEquals(m.skip.or(m.os.equals("linux")).toExpression(), "true");
});
