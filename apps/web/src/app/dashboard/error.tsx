'use client';

import { RouteErrorState } from '@/components/ui/route-error-state';

export default function DashboardError({ error, reset }: { error: Error; reset: () => void }) {
  return <RouteErrorState error={error} reset={reset} />;
}
