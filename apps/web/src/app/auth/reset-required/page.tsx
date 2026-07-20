'use client';

import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

/**
 * story TBD(E-AUTH-REBUILD Phase2-FE·doc firebase-auth-login-ux-blueprint §2 S2·§4 카피 SSOT):
 * 강제 비밀번호 재설정 유도 화면. Firebase 마이그레이션 cutover(Phase 4) 후 reset_required
 * 상태 사용자가 로그인 시도 시 안내되는 표면 — "만료/오류"가 아니라 "선제적 보안 강화"로
 * 프레이밍한다(doc §1 톤 원칙: 불안 아닌 신뢰).
 *
 * ⚠️스캐폴드 단계: 이 라우트는 아직 어디서도 링크/리다이렉트되지 않는 완전 신규 페이지다 —
 * Phase 4 cutover 전까지는 reset_required 상태 자체가 BE에 존재하지 않아 트리거할 신호가
 * 없다(디디 doc §17d). 화면만 먼저 짓고, 로그인 플로우에서의 실 라우팅 배선은 cutover 설계가
 * 확定된 후 별도 스토리로 진행한다(no-fiction — 없는 신호를 있는 것처럼 배선하지 않음).
 *
 * ⛔"문의하기" 보조 CTA(doc §2 S2)는 이번 스캐폴드에서 생략했다 — 실 지원 채널(이메일/폼)이
 * 코드베이스 어디에도 없어 지어내지 않음(no-fiction). 지원 채널이 확定되면 후속으로 추가.
 */
export default function AuthResetRequiredPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
        </div>

        <div className="space-y-4 text-center">
          <div className="flex justify-center text-info">
            <ShieldCheck className="size-10" aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">보안이 강화되었습니다</h1>
          <p className="text-sm text-muted-foreground">
            안전한 로그인을 위해 비밀번호를 한 번 재설정해 주세요. 계정과 데이터는 그대로 유지됩니다.
          </p>
        </div>

        <Link
          href="/forgot-password"
          className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90"
        >
          비밀번호 재설정하기
        </Link>
      </div>
    </div>
  );
}
