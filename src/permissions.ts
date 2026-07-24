/** The access granted to a permission scope. */
export type PermissionLevel = "read" | "write" | "none";

/** A `GITHUB_TOKEN` permission scope. */
export type PermissionScope =
  | "actions"
  | "artifact-metadata"
  | "attestations"
  | "checks"
  | "code-quality"
  | "contents"
  | "deployments"
  | "discussions"
  | "id-token"
  | "issues"
  | "models"
  | "packages"
  | "pages"
  | "pull-requests"
  | "repository-projects"
  | "security-events"
  | "statuses"
  | "vulnerability-alerts";

/**
 * Permissions granted to the `GITHUB_TOKEN`, either per scope or as a blanket
 * `read-all`/`write-all`. An empty object grants no permissions at all.
 */
export type Permissions =
  | Partial<Record<PermissionScope, PermissionLevel>>
  | "read-all"
  | "write-all";
