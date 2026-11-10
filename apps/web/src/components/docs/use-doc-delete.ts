'use client';

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/db/client';
import { docsListUrl } from './lib/doc-project-url';

// story 4892 (UI-9 §5 #4) — deleting the open document: the editor page asked with the browser's confirm, called DELETE, and on ANY failure
// (`!res.ok`, a network error) swallowed it in an empty catch — the person clicked «삭제», nothing happened and nothing said why. The confirm
// stays as it is (the Dialog component is not built yet); a failure is an error toast («삭제에 실패했어요») and the document stays where it was.
interface Args<T extends { id: string }> {
  docId: string | undefined;
  projectId: string | undefined;
  wsSlug: string;
  projSlug: string;
  router: { replace: (href: string) => void };
  setTree: Dispatch<SetStateAction<T[]>>;
}

export function useDocDelete<T extends { id: string }>({ docId, projectId, wsSlug, projSlug, router, setTree }: Args<T>): () => Promise<void> {
  const t = useTranslations('docs');
  const { addToast } = useToast();
  return useCallback(async () => {
    if (!docId || !projectId) return;
    if (!confirm(t('confirmDelete'))) return;
    try {
      const res = await fetchWithAuth(`/api/docs/${docId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete doc');
    } catch {
      addToast({ title: t('deleteFailed'), type: 'error' });
      return;
    }
    setTree((prev) => prev.filter((d) => d.id !== docId));
    router.replace(docsListUrl(wsSlug, projSlug));
  }, [docId, projectId, router, setTree, t, wsSlug, projSlug, addToast]);
}
