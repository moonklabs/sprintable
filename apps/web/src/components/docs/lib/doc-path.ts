import type { Doc } from '@/app/(authenticated)/docs/docs-context';

export function buildDocPath(docId: string, docs: Doc[]): Doc[] {
  const docMap = new Map(docs.map((d) => [d.id, d]));
  const path: Doc[] = [];
  let current = docMap.get(docId);
  while (current) {
    path.unshift(current);
    if (!current.parent_id) break;
    current = docMap.get(current.parent_id);
  }
  return path;
}
