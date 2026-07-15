'use client';

import { useEpicsRoute } from './epics-context';
import { EpicsClient } from './epics-client';

// story a539c649 S3c: projectId/orgId 는 이제 layout.tsx(headers() 경유 resolve 결과)가
// context 로 내려준다 — layout.tsx가 이미 notFound()로 존재를 보장하므로 "no project" 분기 불요.
export default function EpicsPage() {
  const { projectId, orgId } = useEpicsRoute();
  return <EpicsClient projectId={projectId} orgId={orgId} />;
}
