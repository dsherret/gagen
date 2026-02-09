export type PermissionLevel = "read" | "write" | "none";

export type PermissionScope =
  | "actions"
  | "attestations"
  | "checks"
  | "contents"
  | "deployments"
  | "discussions"
  | "id-token"
  | "issues"
  | "packages"
  | "pages"
  | "pull-requests"
  | "repository-projects"
  | "security-events"
  | "statuses";

export type Permissions =
  | Partial<Record<PermissionScope, PermissionLevel>>
  | "read-all"
  | "write-all";
