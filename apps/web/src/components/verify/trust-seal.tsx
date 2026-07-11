import { Bot, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/storage/format';

export interface TrustSealClaimedProps {
  variant: 'claimed';
  /** 특정 에이전트를 식별할 수 있을 때만(예: story assignee) — self_reported 신호 자체엔 "who"가
   * 없어(BE 계약, human_verified만 _by를 동봉) 모르는 맥락(예: EvidenceSection Lv1)에선 생략하고
   * 범용 봇 아이콘으로 정직하게 대체한다(없는 신원을 지어내지 않음). */
  agentInitial?: string;
  className?: string;
}

export interface TrustSealVerifiedProps {
  variant: 'verified';
  humanName: string;
  when: string;
  className?: string;
}

export type TrustSealProps =
  | { variant?: undefined; className?: string }
  | TrustSealClaimedProps
  | TrustSealVerifiedProps;

/**
 * E-VERIFY V0-S3 Lv0(보드 done 카드) + P0-04 "Claimed vs Verified"(claimed-vs-verified-spec-handoff)
 * 겸용 컴포넌트.
 *
 * `variant` 미지정 = 기존 저강도 체크 글리프(하위호환 — `story-card.tsx`의 `status==='done' &&
 * has_evidence` 호출부는 무변경, 데이터 배선도 그대로. 이 호출부는 아직 self_reported/
 * human_verified로 마이그레이션되지 않았다는 뜻이지 신규 버그가 아니다).
 *
 * `variant='claimed'`/`'verified'` = 신뢰 단계 2주어 분화 스트립(claimed-vs-verified-mockup-render
 * §2 TrustSeal). **시각 스캐폴딩만** — 실 데이터 배선(self_reported/human_verified 소비)은 BE
 * 계약 확정 후 별도 착수([[feedback_be_contract_verification]], FE 단독 추정 금지).
 *
 * ⭐Green 무결성 SOUL-LOCK(스펙 §1.3): `claimed` 분기는 구조적으로 green 토큰을 절대 참조하지
 * 않는다 — agent 주장 단독은 Green이 될 수 없다(원칙05 "인간=책임 주체"의 시각적 강제).
 * `trust-seal.test.tsx`의 회귀가드가 이 불변식을 CI에서 잠근다.
 */
export function TrustSeal(props: TrustSealProps) {
  const t = useTranslations('verify');

  if (props.variant === 'claimed') {
    return (
      <div className={cn('flex items-center gap-2 rounded-[10px] bg-proof-amber-soft px-2.5 py-2 text-[11.5px]', props.className)}>
        <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full border border-proof-blue bg-proof-blue-soft text-[9px] font-bold text-proof-blue">
          {props.agentInitial ?? <Bot className="size-3" aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1 text-proof-ink-3">
          <b className="font-bold text-proof-ink">{t('trustSealClaimedBy')}</b> · {t('trustSealAwaitingVerificationLong')}
        </span>
        <span className="shrink-0 text-[10.5px] font-bold text-proof-amber">{t('trustSealAwaitingVerification')}</span>
      </div>
    );
  }

  if (props.variant === 'verified') {
    return (
      <div className={cn('flex items-center gap-2 rounded-[10px] bg-proof-green-soft px-2.5 py-2 text-[11.5px]', props.className)}>
        <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-proof-green text-[9px] font-bold text-white dark:text-[#0B0C0D]">
          {initials(props.humanName)}
        </span>
        <span className="min-w-0 flex-1 text-proof-ink-3">
          <b className="font-bold text-proof-ink">{t('trustSealVerifiedBy', { name: props.humanName })}</b> · {props.when} · {t('trustSealSignedOff')}
        </span>
        <Check className="size-3.5 shrink-0 text-proof-green" strokeWidth={3} aria-hidden="true" />
      </div>
    );
  }

  return (
    <span className={cn('inline-flex shrink-0 items-center text-success/85', props.className)} title={t('provenCompletion')}>
      <Check className="h-3 w-3" strokeWidth={2.6} aria-hidden />
    </span>
  );
}
