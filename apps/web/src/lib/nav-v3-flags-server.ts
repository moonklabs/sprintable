/**
 * story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:31Z) — TODAY_V3_ENABLED·
 * CHAT_V3_ENABLED·CONNECT_RULES_V3_ENABLED 세 env 이름을 여러 서버 파일(proxy.ts·
 * app/page.tsx·(authenticated)/layout.tsx·organization/connectors/page.tsx·
 * auth/native/route.ts·api/auth/callback/[provider]/route.ts)이 각자 process.env로
 * 다시 읽던 것을 여기 한 곳으로 — "여러 곳에서 목적지를 결정한다"는 4016·4017이 원래
 * 없애려던 문제 그 자체가 플래그 읽기 축에서 재발한 것이었다(지적 그대로).
 *
 * server-only(process.env 비-NEXT_PUBLIC_ 값은 client에서 원래도 안 보임, story #4003
 * layout.tsx 주석 참고) — client 컴포넌트는 이 함수 대신 DashboardContext.navV3Flags
 * (dashboard-shell.tsx)를 쓴다, 그쪽은 이 함수가 서버에서 읽어 내려보낸 값이다.
 */
import type { NavV3Flags } from '@/lib/nav-v3-destinations';

export function readNavV3FlagsFromEnv(): NavV3Flags {
  return {
    todayV3Enabled: process.env['TODAY_V3_ENABLED'] === 'true',
    chatV3Enabled: process.env['CHAT_V3_ENABLED'] === 'true',
    connectRulesV3Enabled: process.env['CONNECT_RULES_V3_ENABLED'] === 'true',
  };
}
