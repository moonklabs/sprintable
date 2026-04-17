export type DocContentFormat = 'markdown' | 'html';

export interface RevisionSnapshot {
  content: string;
  content_format?: DocContentFormat | null;
}

export function getRevisionContentFormat(
  revision: RevisionSnapshot,
  fallbackFormat: DocContentFormat,
): DocContentFormat {
  return revision.content_format ?? fallbackFormat;
}

export function getRestoredRevisionDraft(
  revision: RevisionSnapshot,
  fallbackFormat: DocContentFormat,
) {
  return {
    content: revision.content,
    contentFormat: getRevisionContentFormat(revision, fallbackFormat),
  };
}
