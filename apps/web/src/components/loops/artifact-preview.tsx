'use client';

import { useEffect, useState } from 'react';
import { ImageOff, Loader2, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

type State = 'loading' | 'ok' | 'no-access' | 'phantom';

interface AssetMeta {
  id: string;
  name: string;
  content_type: string;
}

/**
 * Loop variant 후보 asset 프리뷰. StorageThumbnail(components/storage)과 달리 source_links 기반
 * sign-plan을 거치지 않는다 — 방금 생성된 loop artifact asset은 story/doc/conversation/manual
 * 어디에도 안 걸려있는 게 정상이라(handoff §4-2 갭) selectSignPlan이 항상 phantom을 반환한다.
 * 대신 asset_id 직접 sign을 시도한다 — BE attachments/authorize가 project-scope로 권위 판정하고
 * source_links는 표시용 메타일 뿐 sign 게이트가 아니기 때문에 안전하다.
 * 이미지 아닌 content_type(텍스트 카피 등)은 이름 라벨 폴백 — 본문 텍스트 프리뷰는 §4-2 미확정.
 */
export function ArtifactPreview({ assetId, fallbackLabel }: { assetId: string; fallbackLabel: string }) {
  const t = useTranslations('storage');
  const [state, setState] = useState<State>('loading');
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<AssetMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const assetRes = await fetch(`/api/assets/${assetId}`);
        if (cancelled) return;
        if (!assetRes.ok) { setState('no-access'); return; }
        const { data } = (await assetRes.json()) as { data: AssetMeta };
        if (cancelled) return;
        setMeta(data);
        if (!data.content_type.startsWith('image/')) { setState('phantom'); return; }

        const signRes = await fetch(`/api/attachments/sign?asset_id=${assetId}`);
        if (cancelled) return;
        if (signRes.status === 403) { setState('no-access'); return; }
        if (!signRes.ok) { setState('no-access'); return; }
        const json = (await signRes.json()) as { data?: { url?: string } };
        const url = json.data?.url;
        if (!url) { setState('no-access'); return; }
        setSignedUrl(url);
        setState('ok');
      } catch {
        if (!cancelled) setState('no-access');
      }
    })();
    return () => { cancelled = true; };
  }, [assetId]);

  if (state === 'loading') {
    return (
      <div className="absolute inset-0">
        <Skeleton className="absolute inset-0 rounded-none" />
        <div className="absolute inset-0 grid place-items-center">
          <Loader2 className="size-5 animate-spin text-info" aria-label={t('previewLoading')} />
        </div>
      </div>
    );
  }
  if (state === 'no-access') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted px-3 text-center text-muted-foreground">
        <Lock className="size-5" aria-hidden />
        <span className="text-[10px] font-medium">{t('previewNoAccessTitle')}</span>
      </div>
    );
  }
  if (state === 'ok' && signedUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={signedUrl}
        alt={meta?.name ?? fallbackLabel}
        onError={() => setState('phantom')}
        className="absolute inset-0 h-full w-full object-cover"
      />
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-muted px-3 text-center text-muted-foreground">
      <ImageOff className="size-5" aria-hidden />
      <span className="line-clamp-2 text-[10px] font-medium">{meta?.name ?? fallbackLabel}</span>
    </div>
  );
}
