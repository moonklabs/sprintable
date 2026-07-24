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
 *
 * story #2160 — 오르테가 리뷰(PR#2467): `resetSessionExpired()`는 프로덕션 호출처가 0건이라,
 * 이 모달을 ESC/바깥클릭/X로 닫으면 `signaled=true`인 채로 남는다. #2160이 fetchWithAuth에
 * "signaled면 네트워크 자체를 안 탄다"를 얹었기 때문에, 그 상태에서는 앱 전체가 **되살아날 길 없이**
 * 조용히 죽는다 — #2160이 고치려던 증상 그대로다. 그래서 출구를 재로그인 CTA(하드 내비게이션 —
 * 새 페이지 컨텍스트에서 signaled가 자연 초기화됨) 하나로 좁힌다: onOpenChange를 no-op으로 두어
 * ESC/바깥클릭/포커스아웃 등 어떤 이유로도 내부적으로 닫히지 않게 하고, 닫기 X 버튼도 없앤다.
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
    <Dialog open={open} onOpenChange={() => {}} disablePointerDismissal>
      <DialogContent showCloseButton={false}>
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
