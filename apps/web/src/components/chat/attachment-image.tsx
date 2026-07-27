'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Lock, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * a54ddc16 — 첨부 이미지 auth-gated 렌더. public 직링크 대신 서명 라우트
 * (`/api/attachments/sign`)로 단기 서명 URL을 받아 표시한다. 비동기 fetch라 상태 UX가 필요:
 * - idle/fetching: skeleton(자리 확보·레이아웃 시프트 방지)
 * - ok: 이미지 렌더
 * - expired: 서명 URL 만료 → 자동 재fetch 1회(투명) → 재실패 시 새로고침 안내
 * - denied: authorize 거부(403) → Lock + 안내(중립톤·broken img 0)
 *
 * story #2050: 채팅 진입 시 스크롤이 튀는 근본원인 2가지를 고친다.
 * 1) AC1 — 목록에는 축소본만: next/image가 `sizes`에 맞춰 서버에서 리사이즈해 내려준다(원본
 *    전체 바이트를 매번 받지 않는다). 클릭(`<a href={signedUrl}>`)은 여전히 원본을 연다.
 * 2) AC2 — 모든 상태(idle/fetching/ok/denied/expired)가 동일한 고정 프레임(h-32 w-60)을 쓴다.
 *    기존 버그: skeleton은 h-32였는데 로딩된 이미지는 max-h-40(가변, object-contain)이라 로딩
 *    완료 순간 박스 높이가 바뀌면서 아래 내용이 밀렸다 — 썸네일로 바꿔도 이 불일치 자체는
 *    안 없어진다. `fill`+고정 크기 부모로 프레임을 상수화해 레이아웃 시프트를 원천 차단한다.
 *
 * 뷰포트 근접(400px 여유) 시에만 서명 fetch — 첨부 많은 대화에 진입할 때 이미지 수만큼
 * 동시다발 fetch가 몰리는 것을 막는다(대화 진입 체감 저하의 또 다른 축).
 */

type State = 'idle' | 'fetching' | 'ok' | 'expired' | 'denied';

interface AttachmentImageProps {
  storedUrl: string;
  // 첨부가 속한 리소스 — conversation(채팅) 또는 story(보드). 정확히 하나.
  conversationId?: string;
  storyId?: string;
  alt: string;
}

// AC2: 모든 상태가 공유하는 고정 프레임 — 여기 크기를 바꾸면 반드시 모든 분기에서 동일하게 유지할 것.
const FRAME_CLASS = 'relative flex h-32 w-60 max-w-full items-center justify-center overflow-hidden rounded bg-muted';

export function AttachmentImage({ storedUrl, conversationId, storyId, alt }: AttachmentImageProps) {
  const t = useTranslations('chats');
  const [state, setState] = useState<State>('idle');
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const retriedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const fetchSignedUrl = useCallback(async () => {
    setState('fetching');
    try {
      const params = new URLSearchParams({ path: storedUrl });
      if (conversationId) params.set('conversation_id', conversationId);
      else if (storyId) params.set('story_id', storyId);
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
  }, [storedUrl, conversationId, storyId]);

  useEffect(() => {
    retriedRef.current = false;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      // 환경에 IntersectionObserver가 없으면(구형 브라우저 등) 즉시 fetch로 폴백.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchSignedUrl();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          observer.disconnect();
          void fetchSignedUrl();
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
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
    void fetchSignedUrl();
  }, [fetchSignedUrl]);

  if (state === 'idle' || state === 'fetching') {
    return <div ref={rootRef} className={`${FRAME_CLASS} animate-pulse`} aria-busy="true" aria-label={alt} />;
  }
  if (state === 'denied') {
    return (
      <div className={`${FRAME_CLASS} flex-col gap-1.5 text-muted-foreground`}>
        <Lock className="h-4 w-4" aria-hidden />
        <span className="text-xs">{t('attachmentDenied')}</span>
      </div>
    );
  }
  if (state === 'expired' || !signedUrl) {
    return (
      <div className={`${FRAME_CLASS} flex-col gap-1.5 text-muted-foreground`}>
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
    <a href={signedUrl} target="_blank" rel="noopener noreferrer" className={FRAME_CLASS}>
      <Image src={signedUrl} alt={alt} fill sizes="240px" onError={handleImgError} className="object-contain" />
    </a>
  );
}
