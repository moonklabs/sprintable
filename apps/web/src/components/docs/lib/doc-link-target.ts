import { docUrl } from './doc-project-url';

// story 4892 — what the server names (`/api/docs/preview`) is not trusted into a path blindly: org / project slugs must look like slugs,
// a document slug is escaped (only the characters that change the meaning of a path — `/`, backslash (URL parsing reads it as `/`), `?`, `#`, `%` — Korean slugs go as the tree and the editor pass them)
// and `.` / `..` are refused. The project is the current one only when the answer's project id IS the current project's id; otherwise its
// own slug is needed (no guessing: a guess for a project without a slug would open another project's document of the same name, or a 404).
const pathSafe = (slug: string) => slug.replace(/[/\\?#%]/g, (c) => encodeURIComponent(c));
const SLUG_SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;
const isSlugSegment = (v: unknown): v is string => typeof v === 'string' && SLUG_SEGMENT.test(v);

export interface Preview {
  slug?: string | null;
  projectId?: string | null;
  orgSlug?: string | null;
  projectSlug?: string | null;
}

/** where the document lives, or null when it cannot be named safely */
export function previewTarget(d: Preview, wsSlug: string, projSlug: string, currentProjectId: string | undefined): string | null {
  const slug = d.slug?.trim();
  if (!slug || slug === '.' || slug === '..') return null;
  const sameProject = !!(d.projectId && currentProjectId && d.projectId === currentProjectId);
  // the current workspace / project (route parameters) are used only for the project the answer confirms IS the current one — and even then they must look like slugs
  const org: string | null = d.orgSlug ? d.orgSlug : sameProject ? wsSlug : null;
  const proj: string | null = sameProject ? projSlug : (d.projectSlug ?? null);
  if (!isSlugSegment(org) || !isSlugSegment(proj)) return null;
  // story 4892 (D1) — a link to a document (chat cards, reports) opens it to read, like choosing it from the list
  return `${docUrl(org, proj, pathSafe(slug))}/view`;
}
