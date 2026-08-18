'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Expand, File, FileCode, FileText, Film, Image as ImageIcon, Music, X, type LucideIcon } from 'lucide-react';
import { fetchWithAuth } from '@/lib/db/client';
import { isNativeShell } from '@/lib/native-shell-bridge';
import { MdBody } from '@/components/chat/embed-card';
import type { ReadingPanelTarget } from '@/components/chat/reading-panel';

type AttachmentTarget = Extract<ReadingPanelTarget, { kind: 'attachment' }>;

// 인계 doc 0ef7f8ab §A2 — 포맷 라우팅 표 그대로. office는 렌더러가 없다(가짜 렌더 금지).
type Format = 'image' | 'video' | 'audio' | 'text' | 'html' | 'pdf' | 'office' | 'unknown';

function resolveFormat(contentType: string | null | undefined, label: string): Format {
  const ct = (contentType ?? '').toLowerCase();
  const ext = label.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (ct === 'text/html' || ext === 'html' || ext === 'htm') return 'html';
  if (ct.startsWith('text/') || ct === 'text/markdown' || ['txt', 'md', 'markdown'].includes(ext)) return 'text';
  if (
    ['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls'].includes(ext) ||
    ct.includes('officedocument') ||
    ct.includes('msword') ||
    ct.includes('ms-excel') ||
    ct.includes('ms-powerpoint')
  ) {
    return 'office';
  }
  return 'unknown';
}

const FORMAT_LABEL: Record<Format, string> = {
  image: '이미지', video: '동영상', audio: '오디오', text: '텍스트',
  html: 'HTML', pdf: 'PDF', office: '오피스 문서', unknown: '파일',
};

function iconFor(format: Format): LucideIcon {
  switch (format) {
    case 'image': return ImageIcon;
    case 'video': return Film;
    case 'audio': return Music;
    case 'text': return FileText;
    case 'html': return FileCode;
    case 'pdf': return FileText;
    default: return File;
  }
}

type SignState =
  | { kind: 'fetching' }
  | { kind: 'denied' }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'ready'; url: string };

async function signAttachment(target: AttachmentTarget, disposition: 'inline' | 'attachment'): Promise<SignState> {
  try {
    const params = new URLSearchParams({ path: target.storedUrl, disposition });
    if (target.conversationId) params.set('conversation_id', target.conversationId);
    else if (target.storyId) params.set('story_id', target.storyId);
    const res = await fetchWithAuth(`/api/attachments/sign?${params.toString()}`);
    if (res.status === 403) return { kind: 'denied' };
    const json = (await res.json().catch(() => null)) as { data?: { url?: string }; error?: { message?: string } } | null;
    const url = json?.data?.url;
    if (!res.ok || !url) return { kind: 'error', status: res.status, message: json?.error?.message ?? '알 수 없는 오류' };
    return { kind: 'ready', url };
  } catch {
    return { kind: 'error', status: 0, message: '네트워크 오류' };
  }
}

/**
 * 인계 doc 0ef7f8ab §A1/§A2/§A3 — 헤더(글리프+이름+포맷배지+[⤢ 전체][⬇ 다운로드][✕]) +
 * 포맷별 인앱 렌더 + 상태 4종. signed URL은 이 컴포넌트가 직접 뜬다(disposition=inline로
 * 뷰용, attachment로 다운로드용 — 별도 요청, 캐시 없음 — 서명 URL은 단기 만료라 매번 새로
 * 받는 편이 만료 이슈보다 낫다).
 */
export function FileViewer({ target, onClose }: { target: AttachmentTarget; onClose: () => void }) {
  const format = resolveFormat(target.contentType, target.label);
  const [state, setState] = useState<SignState>({ kind: 'fetching' });
  const [downloading, setDownloading] = useState(false);
  const nativeShell = isNativeShell();

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'fetching' });
    void signAttachment(target, 'inline').then((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; };
  }, [target]);

  const retry = useCallback(() => {
    setState({ kind: 'fetching' });
    void signAttachment(target, 'inline').then(setState);
  }, [target]);

  const handleDownload = useCallback(async () => {
    if (nativeShell) return; // §A5 — RN 브리지(레인 B/#2765) 도착 전까지 웹 경로만 실행
    if (downloading) return;
    setDownloading(true);
    try {
      const s = await signAttachment(target, 'attachment');
      if (s.kind === 'ready') {
        const a = document.createElement('a');
        a.href = s.url;
        a.download = target.label;
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } finally {
      setDownloading(false);
    }
  }, [target, downloading, nativeShell]);

  const handleOpenFull = useCallback(() => {
    if (state.kind === 'ready') window.open(state.url, '_blank', 'noopener,noreferrer');
  }, [state]);

  const Icon = iconFor(format);

  return (
    <>
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{target.label}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{FORMAT_LABEL[format]}</span>
        <button
          type="button"
          onClick={handleOpenFull}
          disabled={state.kind !== 'ready'}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          aria-label="전체 화면으로 열기"
          title="전체 화면"
        >
          <Expand className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={downloading || nativeShell}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          aria-label="다운로드"
          title={nativeShell ? '앱 다운로드는 준비 중입니다' : '다운로드'}
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="패널 닫기"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="focus-inset min-h-0 flex-1 overflow-auto">
        {state.kind === 'fetching' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6">
            <div className="h-24 w-full max-w-md animate-pulse rounded-lg bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        )}

        {state.kind === 'denied' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-foreground">이 첨부를 열람할 권한이 없습니다.</p>
            <p className="text-xs text-muted-foreground">사유: 대화/스토리 참여자만 열람할 수 있습니다.</p>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-foreground">불러오지 못했습니다.</p>
            <p className="w-fit rounded-md bg-destructive-tint px-2 py-1.5 font-mono text-[10.5px] text-foreground">
              {state.status} {state.message}
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              다시 시도
            </button>
          </div>
        )}

        {state.kind === 'ready' && <FileViewerBody format={format} url={state.url} label={target.label} />}
      </div>
    </>
  );
}

function FileViewerBody({ format, url, label }: { format: Format; url: string; label: string }) {
  switch (format) {
    case 'image':
      // eslint-disable-next-line @next/next/no-img-element -- 서명 URL은 원격 도메인이라 next/image 정적 도메인 화이트리스트 밖(기존 lightbox와 동일 제약)
      return <img src={url} alt={label} className="mx-auto max-h-full max-w-full object-contain p-4" />;
    case 'video':
      return (
        <video controls className="mx-auto max-h-full w-full p-4">
          <source src={url} />
        </video>
      );
    case 'audio':
      return (
        <div className="p-4">
          <audio controls className="w-full" src={url} />
        </div>
      );
    case 'pdf':
      return <iframe src={url} title={label} className="h-full w-full border-0" />;
    case 'html':
      // 미신뢰 업로드 컨텐츠 미리보기 — allow-scripts 없음(격리, CSP 준하는 최소 권한).
      return <iframe src={url} title={label} sandbox="allow-popups" className="h-full w-full border-0 bg-white" />;
    case 'text':
      // key={url} — url이 바뀌면(다른 첨부로 전환) 컴포넌트를 통째로 새로 마운트해 이전
      // 내용을 자연히 초기화한다(effect 안에서 수동 setState 리셋 없이 — react-hooks/
      // set-state-in-effect 규율, [[feedback-detail-page-key-remount-standard]]와 동형).
      return <TextBody key={url} url={url} />;
    case 'office':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <FileText className="size-8 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">미리보기 준비 중입니다.</p>
          <p className="text-xs text-muted-foreground">오피스 문서(pptx/docx/xlsx)는 아직 인앱 렌더를 지원하지 않습니다. 다운로드해 확인하세요.</p>
        </div>
      );
    default:
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <File className="size-8 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">이 포맷은 인앱 미리보기가 아직 없습니다.</p>
          <p className="text-xs text-muted-foreground">다운로드해 확인하세요.</p>
        </div>
      );
  }
}

/** txt/md 둘 다 MdBody(react-markdown)로 — §A2 표 그대로. */
function TextBody({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => { if (!cancelled) setContent(text); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [url]);

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-foreground">불러오지 못했습니다.</p>
        <p className="text-xs text-muted-foreground">텍스트 내용을 가져오는 데 실패했습니다.</p>
      </div>
    );
  }
  if (content === null) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      </div>
    );
  }
  return (
    <div className="p-4">
      <MdBody content={content} />
    </div>
  );
}
