'use client';

import { useEffect, useMemo, useState } from 'react';
import { ImageOff, Loader2, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import type { Asset, AssetDeeplink } from '@/lib/storage/types';

/**
 * 39724bef — Storage 상세 패널 미리보기 썸네일.
 * 글리프만 그리던 preview header를 이미지 자산에 한해 실 썸네일(signed read)로 렌더한다.
 *
 * 프라이버시 crux: source_links 별로 sign 파라미터를 정확히 골라(=메시지뷰서 못 보면 썸네일도
 * 못 본다) 대화(DM) 첨부가 프로젝트-스코프 asset_id 경로로 노출되지 않게 한다.
 * - 단일 sign 시도만. 403/실패 시 다른 sign 파라미터로 fallback 금지(누출 0).
 * - sign 403 = no-access placeholder · sign ok + img onError = phantom(GCS 객체 부재).
 *
 * 상태:
 * - loading: skeleton shimmer + spinner
 * - ok: <img> object-cover 채움
 * - no-access: Lock placeholder (403 / network / non-ok — 콘텐츠 누출 0)
 * - phantom: ImageOff placeholder (usable source 없음 / sign ok 했지만 원본 부재)
 *
 * 마운트는 부모가 key={asset.id} 로 강제 → 인스턴스 내 asset 은 불변(effect 단순화).
 */

type State = 'loading' | 'ok' | 'no-access' | 'phantom';

/**
 * 단일 source-appropriate sign 계획.
 * - path: path={object_path} + (story_id|conversation_id) (리소스 authorize)
 * - asset: asset_id (project-scoped: doc·manual)
 * - null: 사용 가능한 source 없음 → phantom (sign 시도 자체 안 함)
 */
type SignPlan =
  | { kind: 'path'; param: 'story_id' | 'conversation_id'; id: string }
  | { kind: 'asset' }
  | null;

/** deeplink 객체에서 키 추출(string 값일 때만). 형상이 string|object|null 다양 → 보수적. */
function deeplinkValue(deeplink: AssetDeeplink, key: string): string | null {
  if (deeplink && typeof deeplink === 'object' && key in deeplink) {
    const v = (deeplink as Record<string, unknown>)[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
  return null;
}

/**
 * source 선택 — privacy-invariant 우선 우선순위(정확히 하나):
 *   1. conversation_message → path + conversation_id (참여자 authorize) · 못 만들면 phantom ← 최우선
 *   2. story  → path + story_id        (project authorize)
 *   3. doc    → asset_id               (project-scoped)
 *   4. manual → asset_id               (project-scoped)
 *   5. 없음   → null (phantom)
 *
 * 🔒 INVARIANT: conv-sourced 자산은 절대 project-scoped asset_id 로 서명되지 않는다(DM 누출 차단).
 * conv 를 **최우선** 검사 — doc/story/manual 이 함께 있어도 conv 가 있으면 conv sign(참여자 authorize).
 * doc asset_id 는 path 체크가 없어(project-scoped) doc+conv mixed 자산이 doc 먼저 매칭되면 우회됨
 * → conv 를 step1 로 둬 차단(#1769 codex crux). conv 인데 path 인자를 못 만들면 phantom 반환
 * (asset_id fallback 절대 금지).
 */
export function selectSignPlan(asset: Asset): SignPlan {
  const links = asset.source_links;
  const hasPath = typeof asset.object_path === 'string' && asset.object_path.length > 0;

  // 1. conversation_message (path-based) — 최우선. conv 있으면 무조건 conv sign 또는 phantom.
  const conv = links.find((l) => l.type === 'conversation_message');
  if (conv) {
    const conversationId = deeplinkValue(conv.deeplink, 'conversation_id');
    if (hasPath && conversationId) return { kind: 'path', param: 'conversation_id', id: conversationId };
    // conv source 지만 path 인자 못 만듦 → asset_id 로 절대 내려가지 않는다(누출 차단). phantom.
    return null;
  }

  // 2. story (path-based)
  const story = links.find((l) => l.type === 'story');
  if (story) {
    const storyId = deeplinkValue(story.deeplink, 'story_id');
    if (hasPath && storyId) return { kind: 'path', param: 'story_id', id: storyId };
  }

  // 3. doc (project-scoped asset_id)
  if (links.some((l) => l.type === 'doc')) return { kind: 'asset' };

  // 4. manual (project-scoped asset_id)
  if (links.some((l) => l.type === 'manual')) return { kind: 'asset' };

  // 5. 사용 가능한 source 없음
  return null;
}

interface StorageThumbnailProps {
  asset: Asset;
}

export function StorageThumbnail({ asset }: StorageThumbnailProps) {
  const t = useTranslations('storage');
  const plan = useMemo(() => selectSignPlan(asset), [asset]);
  const [state, setState] = useState<State>(() => (plan ? 'loading' : 'phantom'));
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!plan) return; // phantom — sign 시도 없음(초기 state 가 이미 phantom).
    let cancelled = false;

    // 외부 시스템(서명 라우트) 단일 fetch. 모든 setState 는 await 이후 → 동기 cascade 아님.
    void (async () => {
      try {
        const params = new URLSearchParams();
        if (plan.kind === 'asset') {
          params.set('asset_id', asset.id);
        } else {
          // URLSearchParams.toString() 이 path 를 인코딩(=encodeURIComponent 등가).
          params.set('path', asset.object_path);
          params.set(plan.param, plan.id);
        }
        const res = await fetch(`/api/attachments/sign?${params.toString()}`);
        if (cancelled) return;
        // 403 = 권한 거부 → no-access. 다른 sign 인자로 fallback 절대 금지(단일 시도).
        if (res.status === 403) {
          setState('no-access');
          return;
        }
        // network/other non-ok = graceful no-access(콘텐츠 누출 0).
        if (!res.ok) {
          setState('no-access');
          return;
        }
        const json = (await res.json()) as { data?: { url?: string } };
        if (cancelled) return;
        const url = json.data?.url;
        if (!url) {
          setState('no-access');
          return;
        }
        setSignedUrl(url);
        setState('ok');
      } catch {
        if (!cancelled) setState('no-access');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [plan, asset.id, asset.object_path]);

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
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted px-4 text-center text-muted-foreground">
        <Lock className="size-6" aria-hidden />
        <span className="text-[11px] font-medium">{t('previewNoAccessTitle')}</span>
        <span className="text-[10px]">{t('previewNoAccessDesc')}</span>
      </div>
    );
  }

  if (state === 'phantom' || !signedUrl) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted px-4 text-center text-muted-foreground">
        <ImageOff className="size-6" aria-hidden />
        <span className="text-[11px] font-medium">{t('previewPhantomTitle')}</span>
        <span className="text-[10px]">{t('previewPhantomDesc')}</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={signedUrl}
      alt={asset.name}
      // sign ok 했지만 GCS 객체 부재 → onError = phantom(403 no-access 와 구분).
      onError={() => setState('phantom')}
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}
