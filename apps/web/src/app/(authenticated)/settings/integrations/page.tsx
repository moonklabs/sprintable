'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import { IntegrationCard } from '@/components/settings/integration-card';
import { useFlatHref } from '@/hooks/use-flat-href';

/**
 * E-GHAPP 연동 설정 페이지(`/settings/integrations`) — GitHub App 발견성 + install-callback 복귀 타깃.
 * ⚠️ BE 콜백 실 param(Bot-S github_integration.py 실측): `?github=connected|invalid_state|
 *    replay_or_expired|not_owned|conflict`(doc 추정 `installed` 아님). connected=성공·그 외=실패(중립).
 * param 1회 소비(router.replace로 URL 정리·재방문 배너 재노출 방지·doc-slug 패턴 동형).
 */
export default function IntegrationsPage() {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('settings');
  const router = useRouter();
  const params = useSearchParams();
  // 마운트 시점 1회 캡처(소비 후 URL 정리해도 배너 유지).
  const [banner, setBanner] = useState<'success' | 'error' | null>(() => {
    const g = params.get('github');
    if (!g) return null;
    return g === 'connected' ? 'success' : 'error'; // 실패 사유는 중립(존재/원인 누설 X·anti-IDOR 정신)
  });

  // story #4231 3차 · 까디르 QA(ccef5258a [P2]) — 이동 이유는 github 파라미터이고 프로젝트는 싣는 값일 뿐 — flatHref를 deps에서 빼고
  // 발사 순간의 최신 값을 ref로 읽는다(프로젝트가 정해지는 동안 replace가 여러 번 나가 앞 이동을 버리던 경로).
  const flatHrefRef = useRef(flatHref);
  useEffect(() => { flatHrefRef.current = flatHref; }, [flatHref]);
  useEffect(() => {
    if (!params.get('github')) return;
    const flatHref = flatHrefRef.current;
    router.replace(flatHref('/settings/integrations')); // 1회 소비
  }, [params, router]);

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <Link href={flatHref('/settings')} replace className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
        <ArrowLeft className="size-3.5" />{t('title')}
      </Link>
      <h1 className="mt-3 text-sm font-semibold text-foreground">{t('tabIntegrations')}</h1>
      <p className="mt-1 text-xs text-muted-foreground">{t('integrationsDescription')}</p>

      {banner === 'success' ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 p-2.5 text-xs">
          <CheckCircle2 className="size-4 shrink-0 text-success" />
          <span className="flex-1 text-foreground">{t('ghBannerSuccess')}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label={t('dismiss')} className="text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
        </div>
      ) : banner === 'error' ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-2.5 text-xs">
          <AlertTriangle className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-foreground">{t('ghBannerError')}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label={t('dismiss')} className="text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
        </div>
      ) : null}

      <div className="mt-4">
        <IntegrationCard />
      </div>
    </div>
  );
}
