'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import Image from 'next/image';
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogPortal } from '@/components/ui/dialog';

/**
 * story #2037 — 채팅 이미지 첨부 확대 뷰(라이트박스).
 *
 * AC2(모바일 확대) 판단 근거: 두 경로를 함께 쓴다.
 * ①네이티브 핀치 — 이미지 래퍼에 `touch-action: pinch-zoom`을 걸어 브라우저 자체의 두손가락
 *   핀치 확대·팬을 그대로 쓴다(별도 JS 제스처 수학 없이 OS 표준 동작). ②더블탭 — 한 손 사용을
 *   위한 보조 경로로, 탭 지점 근방을 2배로 토글 확대하는 간단한 JS 토글을 얹는다. 스와이프
 *   좌우 넘기기(AC3)는 확대(scale>1) 상태에서는 비활성화해 팬 제스처와 충돌하지 않게 한다.
 *
 * AC4(닫기) — history.back()을 직접 부르지 않는다([[feedback-history-back-nextjs]] 하우스룰,
 * chat-view.tsx의 스레드 패널과 동일 패턴). 열 때 1회 pushState, 실제 브라우저 뒤로가기만
 * popstate로 가로채 재-push(페이지 이탈 방지+닫기) — ESC·바깥클릭·X버튼은 history를 안 건드리고
 * 상태만 닫는다(base-ui Dialog가 ESC/바깥클릭을 이미 처리 — 손수 오버레이 아님,
 * verify-no-handrolled-modal 대상 아님).
 *
 * 스크롤 보존 — 이 오버레이는 채팅 스크롤 컨테이너(overflow-y-auto)를 언마운트하지 않고 위에
 * fixed로 덮기만 한다. body 자체는 이 앱 셸에서 스크롤되지 않으므로(고정 높이 flex 레이아웃)
 * 별도 scroll-lock 로직이 필요 없다.
 */

export interface LightboxItem {
  storedUrl: string;
  alt: string;
}

interface ImageLightboxProps {
  items: LightboxItem[];
  startIndex: number;
  conversationId?: string;
  storyId?: string;
  onClose: () => void;
}

type SignState = 'fetching' | 'ok' | 'expired' | 'denied';

const SWIPE_THRESHOLD_PX = 60;
const ZOOM_SCALE = 2;

export function ImageLightbox({ items, startIndex, conversationId, storyId, onClose }: ImageLightboxProps) {
  const t = useTranslations('chats');
  const [index, setIndex] = useState(startIndex);
  const [signState, setSignState] = useState<SignState>('fetching');
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const current = items[index];
  const hasMultiple = items.length > 1;

  // AC4 — history: 열 때 1회 push, 실제 뒤로가기만 가로채 닫는다(위 상단 주석 근거).
  const pushedRef = useRef(false);
  useEffect(() => {
    if (!pushedRef.current) {
      pushedRef.current = true;
      const url = window.location.pathname + window.location.search;
      window.history.pushState({ _sprintableLightbox: true }, '', url);
    }
    const handlePopState = () => {
      onClose();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchSignedUrl = useCallback(async (storedUrl: string) => {
    setSignState('fetching');
    setSignedUrl(null);
    try {
      const params = new URLSearchParams({ path: storedUrl });
      if (conversationId) params.set('conversation_id', conversationId);
      else if (storyId) params.set('story_id', storyId);
      const res = await fetch(`/api/attachments/sign?${params.toString()}`);
      if (res.status === 403) {
        setSignState('denied');
        return;
      }
      if (!res.ok) {
        setSignState('expired');
        return;
      }
      const json = (await res.json()) as { data?: { url?: string } };
      const url = json.data?.url;
      if (!url) {
        setSignState('expired');
        return;
      }
      setSignedUrl(url);
      setSignState('ok');
    } catch {
      setSignState('expired');
    }
  }, [conversationId, storyId]);

  useEffect(() => {
    setZoomed(false);
    if (current) void fetchSignedUrl(current.storedUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const goPrev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => setIndex((i) => Math.min(items.length - 1, i + 1)), [items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext]);

  // AC3 — 스와이프 좌우 넘기기. 확대 중(zoomed)엔 팬 제스처와 충돌하므로 비활성화.
  const touchStartX = useRef<number | null>(null);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (zoomed) return;
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }, [zoomed]);
  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (zoomed || touchStartX.current === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
    touchStartX.current = null;
    if (dx > SWIPE_THRESHOLD_PX) goPrev();
    else if (dx < -SWIPE_THRESHOLD_PX) goNext();
  }, [zoomed, goPrev, goNext]);

  // AC2 — 더블탭 토글 확대(한 손 보조 경로. 핀치는 touch-action: pinch-zoom으로 네이티브 위임).
  const lastTapRef = useRef(0);
  const handleImageClick = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      setZoomed((z) => !z);
    }
    lastTapRef.current = now;
  }, []);

  if (!current) return null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/90 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          className="fixed inset-0 z-50 flex flex-col outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {/* Header — 카운터 + 원본 열기 + 닫기 */}
          <div className="flex flex-shrink-0 items-center justify-between px-4 py-3">
            <span className="text-xs font-medium text-white/70">
              {hasMultiple ? t('lightboxCounter', { current: index + 1, total: items.length }) : ''}
            </span>
            <div className="flex items-center gap-1">
              {signState === 'ok' && signedUrl && (
                <a
                  href={signedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('lightboxOpenOriginal')}
                  title={t('lightboxOpenOriginal')}
                  className="flex size-9 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white"
                >
                  <ExternalLink className="h-4.5 w-4.5" aria-hidden />
                </a>
              )}
              <DialogPrimitive.Close
                aria-label={t('lightboxClose')}
                className="flex size-9 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white"
              >
                <X className="h-5 w-5" aria-hidden />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* Image area */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4">
            {hasMultiple && index > 0 && (
              <button
                type="button"
                onClick={goPrev}
                aria-label={t('lightboxPrev')}
                className="absolute left-2 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/60 lg:left-4"
              >
                <ChevronLeft className="h-6 w-6" aria-hidden />
              </button>
            )}
            {hasMultiple && index < items.length - 1 && (
              <button
                type="button"
                onClick={goNext}
                aria-label={t('lightboxNext')}
                className="absolute right-2 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/60 lg:right-4"
              >
                <ChevronRight className="h-6 w-6" aria-hidden />
              </button>
            )}

            {signState === 'fetching' && (
              <Loader2 className="h-8 w-8 animate-spin text-white/60" aria-label={current.alt} />
            )}
            {signState === 'denied' && (
              <p className="text-sm text-white/70">{t('attachmentDenied')}</p>
            )}
            {signState === 'expired' && (
              <button
                type="button"
                onClick={() => void fetchSignedUrl(current.storedUrl)}
                className="rounded px-3 py-1.5 text-sm text-white/70 hover:text-white"
              >
                {t('attachmentReload')}
              </button>
            )}
            {signState === 'ok' && signedUrl && (
              // AC2: touch-action: pinch-zoom — 네이티브 두손가락 확대·팬을 브라우저에 위임.
              <div
                className="relative h-full w-full overflow-auto focus-inset [touch-action:pinch-zoom]"
                onClick={handleImageClick}
              >
                <div
                  className="relative mx-auto h-full min-h-full w-full max-w-full transition-transform duration-200"
                  style={{ transform: zoomed ? `scale(${ZOOM_SCALE})` : undefined }}
                >
                  <Image
                    src={signedUrl}
                    alt={current.alt}
                    fill
                    sizes="100vw"
                    className="object-contain"
                    priority
                  />
                </div>

                {/* 유나 design:changes(2026-08-11) — lightboxZoomHint가 고아 키였다(더블탭이
                    핵심 제스처인데 아무 데도 안 뜸). 확대 상태에 따라 힌트를 바꿔 스와이프가
                    확대 중 비활성화된다는 것도 같이 알린다. 이미지 클릭(더블탭 토글)을 막지
                    않도록 pointer-events-none. 대비: 텍스트라 AA 4.5 필요 — bg-black/70(밝은
                    스크린샷이 주 시나리오라는 유나 지적과 같은 이유로 nav보다 더 진하게). */}
                <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/70 px-3 py-1 text-[11px] text-white">
                  {zoomed ? t('lightboxZoomedHint') : t('lightboxZoomHint')}
                </div>
              </div>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
