'use client';

import { useLoopsRoute } from './loops-context';
import { LoopsClient } from './loops-client';

// story a539c649 S3a: projectId 는 이제 layout.tsx(headers() 경유 resolve 결과)가 context 로
// 내려준다 — layout.tsx가 이미 notFound()로 존재를 보장하므로 여기 "no project" 분기는 불요.
export default function LoopsPage() {
  const { projectId, wsSlug, projSlug } = useLoopsRoute();
  return <LoopsClient projectId={projectId} wsSlug={wsSlug} projSlug={projSlug} />;
}
