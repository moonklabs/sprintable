'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import Image from 'next/image';
import { ChevronLeft, ChevronRight, Download, ExternalLink, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog';

import { fetchWithAuth } from '@/lib/db/client';

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
 * story #5002 — 영상 첨부도 같은 뷰로 크게 본다. 항목에 kind: 'video'를 주면 이미지 대신 <video controls
 * autoPlay playsInline>을 영역 가득 채워(object-contain) 보이고, 좌우 넘기기 · 닫기 · 원본 열기는 이미지와 같다.
 * 영상엔 핀치/더블탭 확대와 힌트를 두지 않는다(재생 조작이 그 자리에 있음). 스와이프는 영상 위에서 시작한
 * 터치를 무시한다(재생 막대를 끌 때 다음 항목으로 넘어가지 않게) — 영상 밖 여백 · 화살표 버튼으로는 넘어간다.
 * 재생 실패(코덱 미지원 · onError)는 AttachmentMedia와 같은 «지원하지 않는 형식» + 다운로드 링크.
 *
 * 스크롤 보존 — 이 오버레이는 채팅 스크롤 컨테이너(overflow-y-auto)를 언마운트하지 않고 위에
 * fixed로 덮기만 한다. body 자체는 이 앱 셸에서 스크롤되지 않으므로(고정 높이 flex 레이아웃)
 * 별도 scroll-lock 로직이 필요 없다.
 */

export interface LightboxItem {
  storedUrl: string;
  alt: string;
  /** story #5002 — 기본은 이미지. 'video'면 영상 재생 칸으로 연다. */
  kind?: 'image' | 'video';
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
  const [videoFailed, setVideoFailed] = useState(false);

  const current = items[index];
  const hasMultiple = items.length > 1;
  const isVideo = current?.kind === 'video';

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

  // story #5002 (codex QA) — 빠르게 넘기면 앞 항목의 서명 응답이 늦게 도착해 지금 항목 자리에 그려지거나(옛 영상 주소) 지금 항목의
  // 상태를 «만료»로 덮을 수 있다 → 요청마다 번호를 매기고, 최신 번호가 아닌 응답은 버린다.
  const signSeq = useRef(0);
  const fetchSignedUrl = useCallback(async (storedUrl: string) => {
    const mine = ++signSeq.current;
    setSignState('fetching');
    setSignedUrl(null);
    try {
      const params = new URLSearchParams({ path: storedUrl });
      if (conversationId) params.set('conversation_id', conversationId);
      else if (storyId) params.set('story_id', storyId);
      const res = await fetchWithAuth(`/api/attachments/sign?${params.toString()}`);
      if (mine !== signSeq.current) return;
      if (res.status === 403) {
        setSignState('denied');
        return;
      }
      if (!res.ok) {
        setSignState('expired');
        return;
      }
      const json = (await res.json()) as { data?: { url?: string } };
      if (mine !== signSeq.current) return;
      const url = json.data?.url;
      if (!url) {
        setSignState('expired');
        return;
      }
      setSignedUrl(url);
      setSignState('ok');
    } catch {
      if (mine === signSeq.current) setSignState('expired');
    }
  }, [conversationId, storyId]);

  useEffect(() => {
    setZoomed(false);
    setVideoFailed(false);
    if (current) void fetchSignedUrl(current.storedUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const goPrev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => setIndex((i) => Math.min(items.length - 1, i + 1)), [items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // story #5002 (codex QA) — 영상에 초점이 있으면 ←/→는 그 영상의 앞뒤 건너뛰기(기본 동작)다. 넘기기로 가로채지 않는다(단추 · 스와이프로 넘김).
      if ((e.target as HTMLElement | null)?.tagName === 'VIDEO') return;
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
    // story #5002 — 영상 위(재생 막대 · 볼륨)에서 시작한 터치는 넘기기 제스처가 아니다.
    if ((e.target as HTMLElement | null)?.closest?.('video')) return;
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
        {/* story 5010 — on a phone the back was 80% black, so the room (its title · the composer · the bottom tabs) showed through and the counter row sat on the room's title row.
            Below md the back is solid; from md up it is the same 80% as before (desktop unchanged). */}
        <DialogOverlay className="bg-scrim-3 max-md:bg-scrim-solid" />
        <DialogPrimitive.Popup data-modal-popup=""
          aria-label={current.alt}
          className="fixed inset-0 z-50 flex flex-col outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {/* Header — 카운터 + 원본 열기 + 닫기 */}
          <div className="flex flex-shrink-0 items-center justify-between px-4 py-3">
            <span className="text-xs font-medium text-on-scrim/70">
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
                  className="flex size-9 items-center justify-center rounded-full text-on-scrim/80 transition hover:bg-on-scrim-fill-1 hover:text-on-scrim"
                >
                  <ExternalLink className="size-ds-icon-sm" aria-hidden />
                </a>
              )}
              <DialogPrimitive.Close
                aria-label={t('lightboxClose')}
                className="flex size-9 touch:size-11 items-center justify-center rounded-full text-on-scrim/80 transition hover:bg-on-scrim-fill-1 hover:text-on-scrim"
              >
                <X className="size-ds-icon-md" aria-hidden />
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
                className="absolute left-2 top-1/2 z-10 flex size-10 touch:size-11 -translate-y-1/2 items-center justify-center rounded-full bg-scrim-2 text-on-scrim transition hover:bg-scrim-3 lg:left-4"
              >
                <ChevronLeft className="size-ds-icon-lg" aria-hidden />
              </button>
            )}
            {hasMultiple && index < items.length - 1 && (
              <button
                type="button"
                onClick={goNext}
                aria-label={t('lightboxNext')}
                className="absolute right-2 top-1/2 z-10 flex size-10 touch:size-11 -translate-y-1/2 items-center justify-center rounded-full bg-scrim-2 text-on-scrim transition hover:bg-scrim-3 lg:right-4"
              >
                <ChevronRight className="size-ds-icon-lg" aria-hidden />
              </button>
            )}

            {signState === 'fetching' && (
              <Loader2 className="size-ds-icon-lg animate-spin text-on-scrim/60" aria-label={current.alt} />
            )}
            {signState === 'denied' && (
              <p className="text-sm text-on-scrim/70">{t('attachmentDenied')}</p>
            )}
            {signState === 'expired' && (
              <button
                type="button"
                onClick={() => void fetchSignedUrl(current.storedUrl)}
                className="rounded px-3 py-1.5 text-sm text-on-scrim/70 hover:text-on-scrim"
              >
                {t('attachmentReload')}
              </button>
            )}
            {signState === 'ok' && signedUrl && isVideo && (
              // story #5002 — 영상: 영역 가득 · 네이티브 재생 조작 · 인라인 재생(iOS 웹뷰가 강제 전체 화면으로 빼지 않게 playsInline).
              videoFailed ? (
                <div className="flex flex-col items-center gap-2 text-sm text-on-scrim/70">
                  <span>{t('mediaUnsupportedFormat')}</span>
                  <a
                    href={signedUrl}
                    download={current.alt}
                    className="flex items-center gap-1.5 rounded px-3 py-1.5 hover:text-on-scrim"
                  >
                    <Download className="size-ds-icon-sm" aria-hidden />
                    {t('mediaDownload')}
                  </a>
                </div>
              ) : (
                <video
                  key={signedUrl}
                  controls
                  autoPlay
                  playsInline
                  src={signedUrl}
                  aria-label={current.alt}
                  onError={() => setVideoFailed(true)}
                  className="h-full w-full object-contain"
                >
                  <track kind="captions" />
                </video>
              )
            )}
            {signState === 'ok' && signedUrl && !isVideo && (
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
                    않도록 pointer-events-none. 대비: 텍스트라 AA 4.5 필요 — bg-scrim-3(밝은
                    스크린샷이 주 시나리오라는 유나 지적과 같은 이유로 nav보다 더 진하게). */}
                <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-scrim-3 px-3 py-1 text-editorial-meta text-on-scrim">
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
