'use client';

import { RouteErrorState } from '@/components/ui/route-error-state';

export default function MeetingsError({ error, reset }: { error: Error; reset: () => void }) {
  return <RouteErrorState error={error} reset={reset} compact secondaryHref="/meetings" />;
}
