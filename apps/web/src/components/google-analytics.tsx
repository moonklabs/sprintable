'use client';

import Script from 'next/script';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, Suspense } from 'react';

const GA_ID = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;

declare global {
  interface Window {
    gtag: (...args: unknown[]) => void;
    dataLayer: unknown[];
  }
}

function GoogleAnalyticsInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!GA_ID || typeof window === 'undefined' || !window.gtag) return;
    const url = pathname + (searchParams?.toString() ? `?${searchParams.toString()}` : '');
    window.gtag('config', GA_ID, { page_path: url });
  }, [pathname, searchParams]);

  // story #3204 — 전환 이벤트 발화 SSOT. 가입 경로 2개(email/pw는 register/page.tsx,
  // OAuth는 api/auth/callback/[provider]/route.ts 서버 리다이렉트라 클라 JS 컨텍스트가
  // 없음) 둘 다 목적지 URL에 같은 `?signup=1`을 붙이고, 여기 한 곳에서만 발화한다
  // (billing-tab.tsx의 Toss checkout 성공 쿼리파라미터 소비 패턴과 동형 — 처리 直後
  // router.replace로 파라미터를 제거해 새로고침 시 재발화되지 않게 한다).
  useEffect(() => {
    if (!GA_ID || typeof window === 'undefined' || !window.gtag) return;
    if (searchParams?.get('signup') !== '1') return;
    window.gtag('event', 'sign_up');
    const next = new URLSearchParams(searchParams);
    next.delete('signup');
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  if (!GA_ID) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_ID}', { send_page_view: false });
        `}
      </Script>
    </>
  );
}

export function GoogleAnalytics() {
  return (
    <Suspense fallback={null}>
      <GoogleAnalyticsInner />
    </Suspense>
  );
}
