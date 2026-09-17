'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import type { TodayNeedsMeItem } from '@/components/org-briefing/derive-today';

interface ArtifactDetail {
  title: string | null;
  latestVersionNumber: number | null;
}

/**
 * story #3972 AC5 — 맥락 패널 4절. 페드루 PO 판정(부재 8): 열린 산출물=메시지
 * `references[]` 최근 artifact를 FE가 파생(부모가 넘겨준 artifactId, BE 0) ·
 * 관련=오늘 스냅샷 캐시로 `conversation_id` 역조회(BE 0, #3971 그라운딩이 찾은
 * 그 역방향 링크) · 근거·이력=자리만(집계 API 자체가 없다, #3971 부재 4·5 —
 * 「곧 돼요」류 문구는 짓지 않는다).
 */
function useArtifactDetail(artifactId: string | null): ArtifactDetail | null {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);

  useEffect(() => {
    setDetail(null);
    if (!artifactId) return;
    let cancelled = false;
    void (async () => {
      try {
        const previewRes = await fetchWithAuth(`/api/visual-artifacts/preview?id=${encodeURIComponent(artifactId)}`);
        if (!previewRes.ok) throw new Error('preview failed');
        const previewJson = (await previewRes.json()) as { data?: { projectId?: string } };
        const projectId = previewJson.data?.projectId;
        if (!projectId) throw new Error('no projectId');
        const detailRes = await fetchWithAuth(`/api/visual-artifacts/${artifactId}`, {
          headers: { 'X-Project-Id': projectId },
        });
        if (!detailRes.ok) throw new Error('detail failed');
        const detailJson = (await detailRes.json()) as { data?: { title?: string | null; latest_version_number?: number } };
        if (cancelled) return;
        setDetail({
          title: detailJson.data?.title ?? null,
          latestVersionNumber: detailJson.data?.latest_version_number ?? null,
        });
      } catch {
        if (!cancelled) setDetail(null);
      }
    })();
    return () => { cancelled = true; };
  }, [artifactId]);

  return detail;
}

export function ChatV3ContextPanel({ conversationId, openArtifactId, needsMe }: {
  conversationId: string;
  openArtifactId: string | null;
  // 페드루 PO 지시(2026-09-17 00:08Z, PR #4370 CHANGES) — 오늘 스냅샷은 화면 최상위
  // (`ChatV3Screen`)에서 1콜만 하고 이 패널·이벤트 카드(서명 버튼 막다른 길 방지)가
  // 같이 나눠 쓴다(중복 콜 0).
  needsMe: TodayNeedsMeItem[];
}) {
  const t = useTranslations('chatV3');
  const artifact = useArtifactDetail(openArtifactId);
  const relatedNeedsMe = needsMe.find((item) => item.conversationId === conversationId) ?? null;

  return (
    <section className="flex w-[340px] shrink-0 flex-col bg-card" data-testid="chat-v3-context-panel">
      <div className="flex h-[52px] shrink-0 items-center border-b border-border px-4">
        <h2 className="text-[13px] font-bold text-muted-foreground">{t('contextPanelTitle')}</h2>
      </div>
      <div className="flex-1 space-y-4 overflow-auto p-4">
        <div>
          <p className="mb-1.5 text-[11px] text-muted-foreground">{t('contextOpenArtifactLabel')}</p>
          {openArtifactId ? (
            artifact ? (
              <Card className="p-3" data-testid="chat-v3-open-artifact-card">
                <p className="truncate text-[13px] font-medium text-foreground">{artifact.title ?? t('untitledArtifact')}</p>
                {artifact.latestVersionNumber !== null ? (
                  <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t('artifactVersion', { version: artifact.latestVersionNumber })}</p>
                ) : null}
              </Card>
            ) : (
              <div className="h-16 animate-pulse rounded-md bg-muted/40" aria-hidden="true" />
            )
          ) : (
            <p className="text-xs text-muted-foreground">{t('contextEmptySection')}</p>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-[11px] text-muted-foreground">{t('contextEvidenceLabel')}</p>
          <p className="text-xs text-muted-foreground">{t('contextEmptySection')}</p>
        </div>

        <div>
          <p className="mb-1.5 text-[11px] text-muted-foreground">{t('contextHistoryLabel')}</p>
          <p className="text-xs text-muted-foreground">{t('contextEmptySection')}</p>
        </div>

        <div>
          <p className="mb-1.5 text-[11px] text-muted-foreground">{t('contextRelatedLabel')}</p>
          {relatedNeedsMe ? (
            <Link href="/today" className="block rounded-md bg-primary/10 px-3 py-2.5 text-[12.5px] text-primary" data-testid="chat-v3-related-today-link">
              {t('contextRelatedTodayLink')}
            </Link>
          ) : (
            <p className="text-xs text-muted-foreground">{t('contextEmptySection')}</p>
          )}
        </div>
      </div>
    </section>
  );
}
