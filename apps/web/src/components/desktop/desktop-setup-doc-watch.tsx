'use client';

import { useEffect } from 'react';
import { emitOnboardingEvent } from '@/app/onboarding/onboarding-telemetry';
import { activeSetupId, isGuideLink } from '@/lib/desktop-setup';

/**
 * story #4427 · AC2 «문서 0»(PO 08:44Z) — 데스크톱 첫 실행 설정이 진행 중인 탭에서 문서 · 가이드 링크를 열면
 * desktop_doc_opened(session_id = setup_id)를 보낸다. 설정 페이지뿐 아니라 같은 탭의 다른 화면(도움말 메뉴 등)에서 연
 * 경우도 잡으려고 로그인 뒤 레이아웃에 한 번 달린다. 설정이 없는 탭에서는 아무것도 보내지 않는다(링크 동작은 건드리지 않음).
 */
export function DesktopSetupDocWatch() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const setupId = activeSetupId();
      if (!setupId) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || !isGuideLink(a.getAttribute('href') ?? '', window.location.origin)) return;
      emitOnboardingEvent('desktop_doc_opened', { session_id: setupId, flow: 'onboarding' });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  return null;
}
