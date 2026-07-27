'use client';

import { useCallback, useState } from 'react';
import { Play, Loader2, Lock, RefreshCw, Music, Film, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * story #2051 — 채팅 오디오·비디오(mp3·mp4 등) 인라인 재생.
 *
 * AC2 원칙(#2050과 동일 축): 목록 진입 시 자동 로딩 금지. AttachmentImage는 뷰포트 근접 시
 * 자동 fetch하지만, 미디어는 바이트 자체가 훨씬 크므로 여기선 그보다 한 단계 더 보수적으로
 * 간다 — **사용자가 [재생]을 누르기 전엔 서명 URL조차 fetch하지 않는다**(네트워크 호출 0).
 *
 * AC3: idle→fetching→ready 전 상태가 같은 고정 프레임을 쓴다(오디오/비디오 각각 자기 프레임
 * 고정, 종류 간에는 다름 — 오디오는 가로 바, 비디오는 16:9 박스).
 *
 * AC4: 재생 시도 자체가 실패(코덱 미지원 등, <audio>/<video> onError)하면 "지원하지 않는
 * 형식" + 다운로드 링크로 폴백한다 — 조용히 깨진 플레이어를 보여주지 않는다. 서명 URL 발급
 * 자체가 실패(403/만료)하는 것과는 별개 상태로 구분한다(AttachmentImage의 denied/expired와
 * 동형).
 */

type State = 'idle' | 'fetching' | 'ready' | 'denied' | 'expired' | 'unsupported';

interface AttachmentMediaProps {
  storedUrl: string;
  conversationId?: string;
  storyId?: string;
  label: string;
  kind: 'audio' | 'video';
}

const AUDIO_FRAME_CLASS = 'flex h-12 w-72 max-w-full items-center gap-2 rounded-lg bg-muted px-3';
const VIDEO_FRAME_CLASS = 'relative flex aspect-video w-72 max-w-full items-center justify-center overflow-hidden rounded-lg bg-muted';

export function AttachmentMedia({ storedUrl, conversationId, storyId, label, kind }: AttachmentMediaProps) {
  const t = useTranslations('chats');
  const [state, setState] = useState<State>('idle');
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  const frameClass = kind === 'audio' ? AUDIO_FRAME_CLASS : VIDEO_FRAME_CLASS;
  const KindIcon = kind === 'audio' ? Music : Film;

  const play = useCallback(async () => {
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
      setState('ready');
    } catch {
      setState('expired');
    }
  }, [storedUrl, conversationId, storyId]);

  const handlePlaybackError = useCallback(() => setState('unsupported'), []);

  if (state === 'denied') {
    return (
      <div className={`${frameClass} ${kind === 'video' ? 'flex-col gap-1.5' : ''} text-muted-foreground`}>
        <Lock className="h-4 w-4 shrink-0" aria-hidden />
        <span className="text-xs">{t('attachmentDenied')}</span>
      </div>
    );
  }

  if (state === 'expired') {
    return (
      <div className={`${frameClass} ${kind === 'video' ? 'flex-col gap-1.5' : ''} text-muted-foreground`}>
        <button
          type="button"
          onClick={() => void play()}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t('attachmentReload')}
        </button>
      </div>
    );
  }

  if (state === 'unsupported') {
    return (
      <div className={`${frameClass} ${kind === 'video' ? 'flex-col gap-1.5' : ''} text-muted-foreground`}>
        <span className="text-xs">{t('mediaUnsupportedFormat')}</span>
        {signedUrl ? (
          <a
            href={signedUrl}
            download={label}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {t('mediaDownload')}
          </a>
        ) : null}
      </div>
    );
  }

  if (state === 'ready' && signedUrl) {
    if (kind === 'audio') {
      return (
        <div className={frameClass}>
          <audio
            controls
            autoPlay
            preload="none"
            src={signedUrl}
            onError={handlePlaybackError}
            className="h-8 w-full min-w-0"
          >
            <track kind="captions" />
          </audio>
        </div>
      );
    }
    return (
      <div className={frameClass}>
        <video controls autoPlay preload="none" src={signedUrl} onError={handlePlaybackError} className="h-full w-full object-contain">
          <track kind="captions" />
        </video>
      </div>
    );
  }

  // idle | fetching — AC2: [재생]을 누르기 전엔 fetch가 일어나지 않는다.
  return (
    <button
      type="button"
      onClick={() => void play()}
      disabled={state === 'fetching'}
      aria-label={`${t('mediaPlay')}: ${label}`}
      className={`${frameClass} ${kind === 'video' ? 'flex-col gap-1.5' : ''} text-foreground transition hover:bg-muted/70 disabled:opacity-70`}
    >
      {state === 'fetching' ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background/80">
          <Play className="h-3.5 w-3.5 fill-current" aria-hidden />
        </span>
      )}
      {kind === 'video' ? <KindIcon className="h-4 w-4 text-muted-foreground/60" aria-hidden /> : null}
      <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">{label}</span>
    </button>
  );
}
