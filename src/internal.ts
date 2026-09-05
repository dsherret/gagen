/**
 * Keys for members that the package's modules share but that are not part of
 * its public API: serialization, dependency-graph plumbing and condition
 * simplification.
 *
 * They are symbols rather than names so that code outside the package cannot
 * reach them. `mod.ts` does not export this module, and a member keyed by a
 * symbol that is not in scope cannot be spelled. Inside the package they are
 * used like any other member: `step[toYaml]()`.
 */

/** Serializes a step, job, matrix or set of action inputs to its YAML object. */
export const toYaml: unique symbol = Symbol("gagen.toYaml");

/** Serializes a job's resolved steps and the outputs declared against them. */
export const toStepsYaml: unique symbol = Symbol("gagen.toStepsYaml");

/** Resolves a job's steps into their final order. */
export const resolveSteps: unique symbol = Symbol("gagen.resolveSteps");

/** Infers the jobs a job depends on. */
export const inferNeeds: unique symbol = Symbol("gagen.inferNeeds");

/** Every source an expression value references. */
export const allSources: unique symbol = Symbol("gagen.allSources");

/** The parts of a concatenation, for flattening nested concatenations. */
export const concatParts: unique symbol = Symbol("gagen.concatParts");

/** The flat AND terms of a condition, as rendered expressions. */
export const getAndTerms: unique symbol = Symbol("gagen.getAndTerms");

/** The flat AND children of a condition. */
export const flattenAnd: unique symbol = Symbol("gagen.flattenAnd");

/** The flat OR children of a condition. */
export const flattenOr: unique symbol = Symbol("gagen.flattenOr");

/** Copies a condition with additional tracked sources. */
export const withSources: unique symbol = Symbol("gagen.withSources");
