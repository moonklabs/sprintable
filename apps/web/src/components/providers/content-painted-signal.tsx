'use client';

import { useEffect } from 'react';
import { notifyContentPainted } from '@/lib/native-shell-bridge';

/**
 * story #4168 — 네이티브 셸 스플래시 해제 신호(content-painted)를 루트 레이아웃 한 곳에서
 * 보낸다. 예전엔 login/page.tsx 한 곳뿐이라 로그인 뒤 착지 화면((authenticated)·today·
 * (v3)·connect-rules·onboarding — 서로 다른 레이아웃)은 신호를 한 번도 안 보냈고, 셸이
 * 8초 안전망까지 스플래시를 붙잡았다. 루트 레이아웃은 모든 화면이 지나고 클라이언트 이동
 * 중엔 다시 마운트되지 않는다 — 여기 하나면 새 레이아웃이 생겨도 신호가 빠지지 않는다.
 */
export function ContentPaintedSignal() {
  useEffect(() => {
    notifyContentPainted();
  }, []);
  return null;
}
