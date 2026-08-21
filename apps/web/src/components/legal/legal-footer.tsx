'use client';

/**
 * 법적 고지 표면 — 사업자정보(6종) + 법적 문서 링크(이용약관·개인정보처리방침·환불정책).
 *
 * 관례(국내 서비스): 웹/랜딩은 페이지 하단 푸터에 사업자정보 + 약관 링크(전자상거래법
 * 제10조), 앱은 「설정 하단 약관 및 정책」. 전역 sticky 푸터로 모든 화면에 따라다니지
 * 않는다 — 비로그인 클러스터(로그인·가입·legal)와 설정 화면에만 「확인 경로」로 둔다
 * (story #2741).
 *
 * 값은 SSOT(lib/legal/business-info.ts)에서만 가져온다. 링크 목적지는 기존 legal 라우트.
 *
 * 구분자 점(·)은 aria-hidden 순수 장식이나, #2611 가드상 text-muted-foreground 알파 변형은
 * 금지라(모든 알파 레벨 AA 미달) 부모의 solid muted-foreground를 상속한다 — muted-alpha-ok
 * 밸브는 큰 워터마크류(인접 텍스트 없음) 전용이라 작은 인접 구분자엔 쓰지 않는다.
 */

import Link from 'next/link';
import { Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { BUSINESS_INFO, LEGAL_DOC_ROUTES } from '@/lib/legal/business-info';

/** 이용약관·개인정보처리방침·환불정책 링크 행. justify는 호출부에서 지정. */
export function LegalLinks({ className = '' }: { className?: string }) {
  const t = useTranslations('legal');
  return (
    <nav
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`}
      aria-label={t('policiesHeading')}
    >
      <Link href={LEGAL_DOC_ROUTES.terms} className="hover:text-foreground hover:underline">
        {t('termsOfService')}
      </Link>
      <span aria-hidden>·</span>
      <Link href={LEGAL_DOC_ROUTES.privacy} className="hover:text-foreground hover:underline">
        {t('privacyPolicy')}
      </Link>
      <span aria-hidden>·</span>
      <Link href={LEGAL_DOC_ROUTES.refundPolicy} className="hover:text-foreground hover:underline">
        {t('refundPolicy')}
      </Link>
    </nav>
  );
}

/** 사업자정보 6종 — 컴팩트 flow, 모바일에서 wrap. justify는 호출부에서 지정. */
export function BusinessInfoBlock({ className = '' }: { className?: string }) {
  const t = useTranslations('legal');
  const parts = [
    BUSINESS_INFO.companyName,
    `${t('ceoLabel')} ${BUSINESS_INFO.ceo}`,
    `${t('registrationLabel')} ${BUSINESS_INFO.registrationNumber}`,
    `${t('mailOrderLabel')} ${BUSINESS_INFO.mailOrderNumber}`,
    BUSINESS_INFO.address,
    BUSINESS_INFO.phone,
  ];
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 leading-relaxed ${className}`}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden>·</span>}
          <span>{part}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** 사업자정보 6종 — 세로 스택(라벨+값), 좁은 폭(GNB 등)용. justify는 호출부에서 지정. */
export function BusinessInfoList({ className = '' }: { className?: string }) {
  const t = useTranslations('legal');
  const rows = [
    { label: null, value: BUSINESS_INFO.companyName },
    { label: t('ceoLabel'), value: BUSINESS_INFO.ceo },
    { label: t('registrationLabel'), value: BUSINESS_INFO.registrationNumber },
    { label: t('mailOrderLabel'), value: BUSINESS_INFO.mailOrderNumber },
    { label: null, value: BUSINESS_INFO.address },
    { label: null, value: BUSINESS_INFO.phone },
  ];
  return (
    <div className={`space-y-0.5 ${className}`}>
      {rows.map((row, i) => (
        <div key={i} className="text-xs leading-relaxed">
          {row.label && <span className="text-sidebar-foreground/60">{row.label} </span>}
          <span className="text-sidebar-foreground">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 비로그인 클러스터(로그인·가입·legal 페이지) 하단 푸터.
 * 사업자정보 + 법적 문서 링크를 가운데 정렬로 묶는다.
 */
export function LegalFooter({ className = '' }: { className?: string }) {
  return (
    <footer
      className={`w-full max-w-xl px-4 text-center text-xs text-muted-foreground ${className}`}
    >
      <BusinessInfoBlock className="justify-center" />
      <LegalLinks className="mt-2 justify-center" />
    </footer>
  );
}
