'use client';

import { useParams } from 'next/navigation';
import { useLoopsRoute } from '../loops-context';
import { LoopDetailClient } from './loop-detail-client';

export default function LoopDetailPage() {
  const params = useParams<{ id: string }>();
  const loopId = params.id;
  const { wsSlug, projSlug } = useLoopsRoute();

  return <LoopDetailClient key={loopId} loopId={loopId} wsSlug={wsSlug} projSlug={projSlug} />;
}
