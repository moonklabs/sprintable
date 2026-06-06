'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * a54ddc16 — 첨부 이미지 auth-gated 렌더. public 직링크 대신 서명 라우트
 * (`/api/attachments/sign`)로 단기 서명 URL을 받아 표시한다. 비동기 fetch라 상태 UX가 필요:
 * - fetching: skeleton(자리 확보·레이아웃 시프트 방지)
 * - ok: 이미지 렌더
 * - expired: 서명 URL 만료 → 자동 재fetch 1회(투명) → 재실패 시 새로고침 안내
 * - denied: authorize 거부(403) → Lock + 안내(중립톤·broken img 0)
 */

type State = 'fetching' | 'ok' | 'expired' | 'denied';

interface AttachmentImageProps {
  storedUrl: string;
  conversationId: string;
  alt: string;
}

export function AttachmentImage({ storedUrl, conversationId, alt }: AttachmentImageProps) {
  const t = useTranslations('chats');
  const [state, setState] = useState<State>('fetching');
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const retriedRef = useRef(false);

  // 'fetching'은 mount 기본값 / reload 핸들러에서 설정한다(effect 내 동기 setState 회피).
  const fetchSignedUrl = useCallback(async () => {
    try {
      const params = new URLSearchParams({ path: storedUrl, conversation_id: conversationId });
      const res = await fetch(`/api/attachments/sign?${params.toString()}`);
      if (res.status === 403) {
        setState('denied');
        return;
      }
      if (!res.ok) {
        setState('expired');
        return;
      }
      const json = (await res.json()) as { data?: { url?: string } };
      const url = json.data?.url;
      if (!url) {
        setState('expired');
        return;
      }
      setSignedUrl(url);
      setState('ok');
    } catch {
      setState('expired');
    }
  }, [storedUrl, conversationId]);

  useEffect(() => {
    retriedRef.current = false;
    // 외부 시스템(서명 라우트) 비동기 fetch — setState는 모두 await 이후라 동기 cascading 아님.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchSignedUrl();
  }, [fetchSignedUrl]);

  // 만료된 서명 URL로 이미지 로드 실패 → 자동 재fetch 1회(투명). 재실패면 expired 안내.
  const handleImgError = useCallback(() => {
    if (!retriedRef.current) {
      retriedRef.current = true;
      void fetchSignedUrl();
    } else {
      setState('expired');
    }
  }, [fetchSignedUrl]);

  const reload = useCallback(() => {
    retriedRef.current = false;
    setState('fetching');
    void fetchSignedUrl();
  }, [fetchSignedUrl]);

  const frame = 'flex h-32 w-[240px] max-w-full items-center justify-center rounded bg-muted';

  if (state === 'fetching') {
    return <div className={`${frame} animate-pulse`} aria-busy="true" aria-label={alt} />;
  }
  if (state === 'denied') {
    return (
      <div className={`${frame} flex-col gap-1.5 text-muted-foreground`}>
        <Lock className="h-4 w-4" aria-hidden />
        <span className="text-xs">{t('attachmentDenied')}</span>
      </div>
    );
  }
  if (state === 'expired' || !signedUrl) {
    return (
      <div className={`${frame} flex-col gap-1.5 text-muted-foreground`}>
        <button
          type="button"
          onClick={reload}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t('attachmentReload')}
        </button>
      </div>
    );
  }
  return (
    <a href={signedUrl} target="_blank" rel="noopener noreferrer" className="block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={signedUrl}
        alt={alt}
        onError={handleImgError}
        className="max-h-40 max-w-[240px] rounded object-contain"
      />
    </a>
  );
}
