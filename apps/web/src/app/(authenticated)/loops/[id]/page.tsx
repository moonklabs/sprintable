'use client';

import { useParams } from 'next/navigation';
import { LoopDetailClient } from './loop-detail-client';

export default function LoopDetailPage() {
  const params = useParams<{ id: string }>();
  const loopId = params.id;

  return <LoopDetailClient key={loopId} loopId={loopId} />;
}
