'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Expand, File, FileCode, FileText, Film, Image as ImageIcon, Loader2, Music, X, type LucideIcon } from 'lucide-react';
import { fetchWithAuth } from '@/lib/db/client';
import { downloadAsset, openExternal } from '@/lib/native-shell-bridge';
import { MdBody } from '@/components/chat/embed-card';
import type { ReadingPanelTarget } from '@/components/chat/reading-panel';

type AttachmentTarget = Extract<ReadingPanelTarget, { kind: 'attachment' }>;

// 인계 doc 0ef7f8ab §A2 — 포맷 라우팅 표 그대로. docx는 story #2788(84ef0cb7 §4-1
// 판정)에서 docx-preview 클라 렌더로 분리됐고, pptx는 story #2803(84ef0cb7 §7)에서
// BE 변환 파이프(POST /api/v2/attachments/{asset_id}/convert)로 분리됐다. xlsx 등
// 나머지 office는 여전히 렌더러가 없다(가짜 렌더 금지).
type Format = 'image' | 'video' | 'audio' | 'text' | 'html' | 'pdf' | 'docx' | 'pptx' | 'office' | 'unknown';

// story #2803 QA(까디르군) — 클래스 전체를 table-driven 테스트로 못박기 위해 export.
export function resolveFormat(contentType: string | null | undefined, label: string): Format {
  const ct = (contentType ?? '').toLowerCase();
  const ext = label.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  // 까디르군 QA(#2803) 2라운드 — docx/pptx는 함수 «최상단»에서 확장자 단독으로 확정해야
  // 한다. wordprocessingml/presentationml보다만 앞서면 여전히 그 위의 image/pdf/html 등
  // content-type 판정에 먼저 걸려 .pptx+content-type=application/pdf류가 깨진 pdf iframe으로
  // 오라우팅된다(정직 폴백보다 나쁜 경로). BE office_conversion.is_convertible도 확장자만
  // 보고 판정하므로 이 두 확장자에선 ext가 최종 진실 — 오명명 파일은 convert 실패→정직
  // 폴백으로 귀결되니 안전하다.
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (ct === 'text/html' || ext === 'html' || ext === 'htm') return 'html';
  if (ct.startsWith('text/') || ct === 'text/markdown' || ['txt', 'md', 'markdown'].includes(ext)) return 'text';
  if (ct.includes('wordprocessingml')) return 'docx';
  if (ct.includes('presentationml')) return 'pptx';
  if (
    ['ppt', 'doc', 'xlsx', 'xls'].includes(ext) ||
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
  html: 'HTML', pdf: 'PDF', docx: 'Word 문서', pptx: 'PowerPoint 문서', office: '오피스 문서', unknown: '파일',
};

function iconFor(format: Format): LucideIcon {
  switch (format) {
    case 'image': return ImageIcon;
    case 'video': return Film;
    case 'audio': return Music;
    case 'text': return FileText;
    case 'html': return FileCode;
    case 'pdf': return FileText;
    case 'docx': return FileText;
    case 'pptx': return FileText;
    default: return File;
  }
}

type SignState =
  | { kind: 'fetching' }
  | { kind: 'denied' }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'ready'; url: string };

// story #2781 — /api/attachments/sign은 BE 계약상 정확히 하나의 리소스 식별자(conversation_id|
// story_id|asset_id)만 받는다(route.ts 실측). 채팅 첨부는 storedUrl+conversationId/storyId,
// 스토리지 asset은 assetId 하나로 충분(path 불요 — BE가 asset registry에서 {container,
// object_path}를 권위 derive한다).
async function signAttachment(target: AttachmentTarget, disposition: 'inline' | 'attachment'): Promise<SignState> {
  try {
    const params = new URLSearchParams({ disposition });
    if (target.assetId) {
      params.set('asset_id', target.assetId);
    } else if (target.storedUrl) {
      params.set('path', target.storedUrl);
      if (target.conversationId) params.set('conversation_id', target.conversationId);
      else if (target.storyId) params.set('story_id', target.storyId);
    }
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

  // story #2765(레인 B) — downloadAsset이 환경을 스스로 판별한다(RN 셸=postMessage 브리지
  // /브라우저=<a download>). 레인 A 시점의 "RN이면 비활성" 특례는 브리지가 실제로 붙었으니
  // 더 이상 없다 — 항상 실행 가능.
  const handleDownload = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const s = await signAttachment(target, 'attachment');
      if (s.kind === 'ready') downloadAsset(s.url, target.label);
    } finally {
      setDownloading(false);
    }
  }, [target, downloading]);

  const handleOpenFull = useCallback(() => {
    if (state.kind === 'ready') openExternal(state.url);
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
          disabled={downloading}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          aria-label="다운로드"
          title="다운로드"
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

        {state.kind === 'ready' && <FileViewerBody format={format} url={state.url} label={target.label} assetId={target.assetId} />}
      </div>
    </>
  );
}

function FileViewerBody({ format, url, label, assetId }: { format: Format; url: string; label: string; assetId?: string }) {
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
    case 'docx':
      // key={url} — 다른 첨부로 전환 시 컴포넌트를 통째로 새로 마운트(TextBody와 동형).
      return <DocxBody key={url} url={url} label={label} />;
    case 'pptx':
      // assetId 없으면(구 메시지 등 asset registry 역기입 이전) 변환 자체를 트리거할 축이
      // 없다 — 가짜 렌더 대신 office와 동일 톤의 정직 "준비 중"으로 축소.
      if (!assetId) {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <FileText className="size-8 text-muted-foreground" aria-hidden />
            <p className="text-sm text-foreground">미리보기 준비 중입니다.</p>
            <p className="text-xs text-muted-foreground">이 첨부는 인앱 변환 대상 식별자가 없습니다. 다운로드해 확인하세요.</p>
          </div>
        );
      }
      return <PptxBody key={assetId} assetId={assetId} label={label} />;
    case 'office':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <FileText className="size-8 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">미리보기 준비 중입니다.</p>
          <p className="text-xs text-muted-foreground">오피스 문서(pptx/xlsx)는 아직 인앱 렌더를 지원하지 않습니다. 다운로드해 확인하세요.</p>
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

/**
 * story #2788 — docx-preview 클라이언트 렌더(서버 변환 우회, 84ef0cb7 §4-1). 브라우저
 * 전용 라이브러리라 useEffect 안에서 동적 import(모듈 최상단 import 시 SSR에서
 * document 참조로 깨질 수 있음). 렌더 실패는 정직 폴백(빈 화면/무한 로딩 금지) —
 * office(pptx 등) 미지원 배지와 동일한 톤으로 다운로드 유도.
 */
function DocxBody({ url, label }: { url: string; label: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'rendering' | 'ready' | 'failed'>('rendering');

  useEffect(() => {
    // 인시던트(2026-08-19, 선생님 실클릭 재현) — Promise.race([run, timeout])+catch/finally
    // 조합이 실 배포 환경에서 «타임아웃이 만료됐는데도 상태 전이가 안 되는» 경로로 관측됐다
    // (라이브 디버깅: 130초를 몇 배 넘겨도 pptx가 converting에 고정, 원인은 이 패턴의 미묘한
    // 실패 모드로 추정 — Promise.race 자체를 걷어내고 단일 try/catch+독립 타이머로 재작성해
    // 재발 표면을 줄인다). settled 플래그로 "먼저 끝낸 쪽이 이긴다"만 보장 — 더 단순하고
    // 예측 가능하다.
    let settled = false;
    const controller = new AbortController();
    setStatus('rendering');

    const markFailed = (err: unknown) => {
      if (settled) return;
      settled = true;
      console.error('docx 인앱 렌더 실패', err);
      controller.abort();
      setStatus('failed');
    };
    const markReady = () => {
      if (settled) return;
      settled = true;
      setStatus('ready');
    };

    // AC2(무한 로딩 금지) — fetch든 renderAsync든 어느 단계가 멈추든 20초 뒤 강제로 정직
    // 실패로 떨어뜨린다. run과 독립적으로 도는 타이머라 run 쪽 로직과 무관하게 항상 발화한다.
    const timeoutId = setTimeout(() => markFailed(new Error('docx render timeout')), 20000);

    (async () => {
      try {
        // story #2788 QA(까디르군) 지적 — res.blob()은 undici Blob을 만드는데 JSZip이
        // 내부에서 FileReader(jsdom 전용 API)로 읽으려 하면 cross-realm 불일치로 조용히
        // 못 읽는다(CI headless 환경 재현). renderAsync는 ArrayBuffer도 그대로 받으므로
        // Blob 경유를 아예 없앤다.
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.arrayBuffer();
        const { renderAsync } = await import('docx-preview');
        if (settled) return;
        if (!containerRef.current) throw new Error('docx render target unmounted');
        containerRef.current.innerHTML = '';
        await renderAsync(buf, containerRef.current, undefined, {
          inWrapper: true,
          // 인시던트(2026-08-19) — A4 고정폭 페이지가 좁은 패널에서 가로 스크롤로만
          // 도달 가능해 실사용 판정이 "잘림"이었다(선생님 실클릭 스크린샷). ignoreWidth:true로
          // docx-preview가 페이지/표 폭을 강제하지 않게 해 컨테이너 폭에 자연히 맞춘다
          // (fit-width) — WYSIWYG 정확도보다 미리보기 가독성 우선.
          ignoreWidth: true,
          ignoreHeight: true,
          breakPages: true,
        });
        clearTimeout(timeoutId);
        markReady();
      } catch (err) {
        clearTimeout(timeoutId);
        markFailed(err);
      }
    })();

    return () => { settled = true; controller.abort(); clearTimeout(timeoutId); };
  }, [url]);

  if (status === 'failed') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <FileText className="size-8 text-muted-foreground" aria-hidden />
        <p className="text-sm text-foreground">미리보기를 표시하지 못했습니다.</p>
        <p className="text-xs text-muted-foreground">이 문서는 인앱 렌더에 실패했습니다. 다운로드해 확인하세요.</p>
      </div>
    );
  }

  // ignoreWidth:true라 docx-preview가 페이지/표 폭을 강제하지 않는다 — 컨테이너 폭(w-full)에
  // 자연히 맞춰지므로(fit-width, 인시던트#2788 재발수정) 가로 스크롤에 기대지 않는다.
  return (
    <div className="min-h-full bg-muted/30">
      {status === 'rendering' && (
        <div className="mx-auto flex max-w-2xl flex-col gap-2 p-6">
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-64 w-full animate-pulse rounded bg-muted" />
        </div>
      )}
      <div
        ref={containerRef}
        aria-label={label}
        className={status === 'ready' ? 'docx-preview-container w-full p-4' : 'hidden'}
      />
    </div>
  );
}

/**
 * story #2803 — pptx는 BE 변환 파이프(POST /api/attachments/convert → office_conversion.py,
 * 84ef0cb7 §7-3)로 PDF로 바꾼 뒤 기존 PDF iframe 렌더를 그대로 재사용한다. 콜드스타트가
 * 수십 초 걸릴 수 있어(LibreOffice 헤드리스, §7-4 timeout=120s) "변환 중" + 경과시간 정직
 * 표시 — 무한 스피너 금지.
 *
 * 인시던트(2026-08-19, 선생님 실클릭 재현·2788/2803 done→in-progress 되돌림) — 배포된
 * dev에서 직접 puppeteer로 실 pptx를 첨부·클릭해 재현: convert가 502로 실패한 뒤에도
 * "변환 중" 스피너가 400초+ 고정되는 것을 라이브로 확인(까디르군 QA가 잡았던 "timeout
 * 확定 뒤 늦은 resolve가 되돌리는" 레이스와는 다른 결— Promise.race([run, timeout])
 * +catch+finally 조합 자체가 실 배포 환경에서 상태 전이 없이 settle되는 경로를 탐).
 * Promise.race를 걷어내고 단일 try/catch+독립 타이머로 재작성 — DocxBody와 동일 패턴.
 */
function PptxBody({ assetId, label }: { assetId: string; label: string }) {
  const [status, setStatus] = useState<'converting' | 'ready' | 'failed'>('converting');
  const [failMessage, setFailMessage] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (status !== 'converting') return;
    const id = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  useEffect(() => {
    // key={assetId}가 다른 첨부 전환 시 이 컴포넌트를 통째로 새로 마운트하므로(DocxBody와
    // 동형) status/failMessage는 이미 useState 초기값으로 깨끗하다 — 여기서 재설정 불요.
    let settled = false;
    const controller = new AbortController();

    const markFailed = (msg: string | null) => {
      if (settled) return;
      settled = true;
      controller.abort();
      setFailMessage(msg);
      setStatus('failed');
    };
    const markReady = (url: string) => {
      if (settled) return;
      settled = true;
      setPdfUrl(url);
      setStatus('ready');
    };

    // 백엔드 하드 타임아웃(Gotenberg 왕복 120s, 84ef0cb7 §7-4)보다 여유를 둔 클라이언트
    // 상한 — run과 독립적으로 도는 타이머라 run 쪽에서 무슨 일이 있어도 항상 발화한다
    // (AC2·AC3, 무한 로딩 금지를 구조로 보장).
    const timeoutId = setTimeout(() => {
      console.error('pptx 변환 시간 초과(130s)');
      markFailed('변환 시간 초과');
    }, 130000);

    (async () => {
      try {
        const convertRes = await fetchWithAuth(`/api/attachments/convert?asset_id=${encodeURIComponent(assetId)}`, {
          method: 'POST',
          signal: controller.signal,
        });
        const convertJson = (await convertRes.json().catch(() => null)) as
          | { data?: { asset_id?: string }; error?: { message?: string } }
          | null;
        const convertedAssetId = convertJson?.data?.asset_id;
        if (!convertRes.ok || !convertedAssetId) {
          throw new Error(convertJson?.error?.message ?? String(convertRes.status));
        }
        if (settled) return;
        const signRes = await fetchWithAuth(
          `/api/attachments/sign?asset_id=${encodeURIComponent(convertedAssetId)}&disposition=inline`,
          { signal: controller.signal },
        );
        const signJson = (await signRes.json().catch(() => null)) as { data?: { url?: string }; error?: { message?: string } } | null;
        const url = signJson?.data?.url;
        if (!signRes.ok || !url) {
          throw new Error(signJson?.error?.message ?? String(signRes.status));
        }
        clearTimeout(timeoutId);
        markReady(url);
      } catch (e) {
        clearTimeout(timeoutId);
        // 에러를 삼키지 않는다 — 폴백 UI로 사용자에겐 정직 실패를 보여주되, 원인은 콘솔에 남긴다.
        console.error('pptx 변환 실패', e);
        markFailed(e instanceof Error ? e.message : null);
      }
    })();

    return () => { settled = true; controller.abort(); clearTimeout(timeoutId); };
  }, [assetId]);

  if (status === 'failed') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <FileText className="size-8 text-muted-foreground" aria-hidden />
        <p className="text-sm text-foreground">변환에 실패했습니다.</p>
        <p className="text-xs text-muted-foreground">이 문서를 PDF로 변환하지 못했습니다. 다운로드해 확인하세요.</p>
        {failMessage && (
          <p className="w-fit rounded-md bg-destructive-tint px-2 py-1.5 font-mono text-[10.5px] text-foreground">{failMessage}</p>
        )}
      </div>
    );
  }

  if (status === 'converting') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
        <p className="text-sm text-foreground">변환 중입니다…</p>
        <p className="text-xs text-muted-foreground">첫 열람은 최대 1~2분 걸릴 수 있습니다({elapsedSec}초 경과).</p>
      </div>
    );
  }

  return <iframe src={pdfUrl ?? undefined} title={label} className="h-full w-full border-0" />;
}
