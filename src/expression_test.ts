import { assertEquals } from "@std/assert";
import {
  ComparisonCondition,
  type ExpressionSource,
  ExpressionValue,
  FunctionCallCondition,
  RawCondition,
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
  assertEquals(v.source, undefined);
  assertEquals(v.equals("main").sources.size, 0);
});

Deno.test("ExpressionValue source flows into equals", () => {
  const src = { id: "step_1" };
  const v = new ExpressionValue("steps.check.outputs.result", src);
  assertEquals(v.source, src);
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

function raw(expr: string) {
  return new RawCondition(expr, new Set());
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
