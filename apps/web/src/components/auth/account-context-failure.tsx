'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RouteErrorState } from '@/components/ui/route-error-state';

/**
 * story 4915 — what the authenticated layout shows when it could NOT read the person's account (the `/api/v2/me` request was rejected — connection reset · refused · timed out — or answered 5xx).
 * That is «the server could not be reached», not «the session ended»: the cookies are left alone and the person stays signed in. The retry button asks the server again (`router.refresh()`);
 * the secondary link is the sign-in, for the person who really wants it. It is the same screen `error.tsx` draws — a throw from a LAYOUT is not caught by the same segment's `error.tsx` (Next's
 * boundary wraps the segment's children, not its own layout), so the layout hands this screen back itself instead of throwing.
 */
export function AccountContextFailure() {
  const router = useRouter();
  const t = useTranslations('common');
  return <RouteErrorState reset={() => router.refresh()} secondaryHref="/login" secondaryLabel={t('login')} />;
}
