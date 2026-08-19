import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ArtifactDetailView } from '@/components/canvas/artifact-detail-view';

/**
 * story #2713 — standalone 아티팩트 상세(딥링크 가능). 갤러리(`../page.tsx`)와 동일하게
 * proxy.ts(S1)가 실어 보낸 x-resolved-project-id 를 서버 경계에서 읽어 인가를 상속한다 —
 * 이 라우트가 `[ws]/[proj]` 트리 아래 있는 것 자체가 갤러리와 같은 project-access 계열
 * 게이트를 통과했다는 뜻이라 신규 인가 로직 0. 하단 탭 소속은 mobile-tab-bar.tsx의 fallback
 * 규칙(flow/inbox/chats 외 전부 "more")이 이 하위 경로에도 그대로 적용돼 별도 배선 불요.
 */
export default async function ArtifactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();
  const { id } = await params;

  return <ArtifactDetailView artifactId={id} />;
}
