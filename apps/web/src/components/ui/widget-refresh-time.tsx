'use client';

import { useEffect, useState } from 'react';

function getRelativeLabel(fetchedAtMs: number): string {
  const diffSec = Math.floor((Date.now() - fetchedAtMs) / 1000);
  if (diffSec < 60) return '방금 갱신';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `갱신 ${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  return `갱신 ${diffHr}시간 전`;
}

interface WidgetRefreshTimeProps {
  fetchedAt: string;
}

export function WidgetRefreshTime({ fetchedAt }: WidgetRefreshTimeProps) {
  const fetchedAtMs = new Date(fetchedAt).getTime();
  const [label, setLabel] = useState(() => getRelativeLabel(fetchedAtMs));

  useEffect(() => {
    const timer = setInterval(() => setLabel(getRelativeLabel(fetchedAtMs)), 30_000);
    return () => clearInterval(timer);
  }, [fetchedAtMs]);

  return <span className="text-xs text-[color:var(--operator-muted)]">{label}</span>;
}
