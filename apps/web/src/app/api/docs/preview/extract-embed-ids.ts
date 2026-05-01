export function extractEmbedIds(html: string | null | undefined): string[] {
  if (!html) return [];
  const ids: string[] = [];
  const regex = /data-doc-id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}
