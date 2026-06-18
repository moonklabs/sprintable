'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { subscribeSessionExpired } from '@/lib/auth/session-expired-signal';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';

/**
 * AC3(af8d3641): 세션 만료 모달. fetchWithAuth 의 refresh 최종 실패 신호(session-expired-signal)를 받아
 * hard redirect 대신 graceful 안내 — "다시 로그인" 시 현재 경로를 next 로 보존해 §A 계약 redirect.
 * (authenticated) 트리 전역(DashboardShell)에 1회 마운트. 신규 토큰 0(Dialog/Button 재사용).
 */
export function SessionExpiredDialog() {
  const t = useTranslations('session');
  const [open, setOpen] = useState(false);

  useEffect(() => subscribeSessionExpired(() => setOpen(true)), []);

  const relogin = () => {
    const path = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/inbox';
    window.location.href = buildLoginRedirect(path);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('expiredTitle')}</DialogTitle>
          <DialogDescription>{t('expiredBody')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={relogin}>{t('reloginCta')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
