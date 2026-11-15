'use client';

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { DocsIndex } from './docs-index';
import { useDocsLayout } from './docs-context';
import { fetchWithAuth } from '@/lib/db/client';
import { previewTarget, type Preview } from '@/components/docs/lib/doc-link-target';

// story 4892 (UI-9 §5 #2) — `/docs?id=<doc id>` is the link form that chat cards, the sprint report link and the intent-suggestion card carry
// (proxy.ts sends it on to `/{ws}/{proj}/docs?id=…`). Nothing in the docs area read `id`, so such a link landed on the index. The id is
// resolved the way the chat embed card resolves it (`/api/docs/preview?q=`, slug-or-uuid) and that document is opened. If it does not
// resolve (no access · deleted · network · a project that cannot be named safely) the index stays — the same page the link led to before.
// What the server names is checked before it becomes a path (components/docs/lib/doc-link-target.ts).
// story #2955 §6 — 미선택 상태=지식 인덱스 렌더(라우트 추가 불요). 옛 `DocsEmptyView`
// ("문서를 선택하세요" 죽은 화면)를 대체한다.
export default function DocsPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const { projectId } = useDocsLayout();
  const docId = searchParams.get('id')?.trim() || null;
  const wsSlug = typeof params.ws === 'string' ? params.ws : null;
  const projSlug = typeof params.proj === 'string' ? params.proj : null;

  useEffect(() => {
    if (!docId || !wsSlug || !projSlug) return;
    // the request is cancelled with the effect (React's development double run, a changed id, leaving the page)
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/docs/preview?q=${encodeURIComponent(docId)}`, { signal: controller.signal });
        if (!res.ok) return;
        const json = (await res.json()) as { data?: Preview };
        if (controller.signal.aborted || !json.data) return;
        const to = previewTarget(json.data, wsSlug, projSlug, projectId);
        if (to) router.replace(to);
      } catch {
        // stays on the index
      }
    })();
    return () => controller.abort();
  }, [docId, wsSlug, projSlug, projectId, router]);

  return <DocsIndex />;
}
