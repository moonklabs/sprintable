'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { EmptyState } from '@/components/ds/empty-state';
import { FIELD_FOCUS_WITHIN } from '@/components/ds/field-focus';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { LAYER } from '@/components/ds/layers';
import { PageFrame } from '@/components/ds/page-frame';
import { PageHead } from '@/components/ds/page-head';
import { OrgScreenTitle } from '@/components/organization/org-screen-title';
import { fetchWithAuth } from '@/lib/db/client';
import { toPlainPreview } from '@/components/chat/entity-ref';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { isImeComposing } from '@/lib/ime-composition';
import { HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING } from '@/lib/hover-reveal';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

interface ChannelMsg {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  ts: string;
  fileUrl?: string;
}

type WsStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

/** story 4824: the backend's address comes from the server (/api/channel/token) at run time; the build-time value is only the fallback for an older answer */
function fastapiWsBase(origin: string | null): string {
  return (origin ?? process.env.NEXT_PUBLIC_FASTAPI_URL ?? 'http://localhost:8000')
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://');
}

// story #3493 — 메시지 시각(msg.ts)은 "기록"(3436 묶음 8 정본 formatRelativeTime).
function fmtTime(ts: string, locale: string, displayTimezone: string | null): string {
  try {
    return formatViewerRelativeTime(ts, locale, displayTimezone);
  } catch {
    return '';
  }
}

/** story 4913 (UI-R5 · 채널) — the connection state as a word, not a coloured dot with an English `title` (the dot said «connected» / «disconnected» to a screen reader in English). */
const STATUS_CHIP: Record<WsStatus, { tone: 'done' | 'info' | 'neutral'; key: 'statusConnected' | 'statusConnecting' | 'statusDisconnected' }> = {
  connected: { tone: 'done', key: 'statusConnected' },
  connecting: { tone: 'info', key: 'statusConnecting' },
  idle: { tone: 'info', key: 'statusConnecting' },
  disconnected: { tone: 'neutral', key: 'statusDisconnected' },
};

export default function ChannelPage() {
  const t = useTranslations('channel');
  const tc = useTranslations('common');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const searchParams = useSearchParams();
  const agentId = searchParams.get('agent_id');
  const { currentTeamMemberId } = useDashboardContext();

  const [messages, setMessages] = useState<ChannelMsg[]>([]);
  const [input, setInput] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('idle');
  const [token, setToken] = useState<string | null>(null);
  const [backendOrigin, setBackendOrigin] = useState<string | null>(null);
  // story 4913 — a failed token read / a refused send are said (they were swallowed: the screen sat on «연결 중…» or the text just vanished)
  const [tokenFailed, setTokenFailed] = useState(false);
  const [tokenRetry, setTokenRetry] = useState(0);
  const [sendFailed, setSendFailed] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // JWT 가져오기
  useEffect(() => {
    setTokenFailed(false);
    fetchWithAuth('/api/channel/token')
      .then((r) => {
        if (!r.ok) throw new Error('channel token read failed');
        return r.json();
      })
      .then((d: { token: string; backend_origin?: string }) => { setBackendOrigin(d.backend_origin ?? null); setToken(d.token); })
      .catch(() => { setTokenFailed(true); });
  }, [tokenRetry]);

  // WebSocket 연결
  useEffect(() => {
    if (!token || !agentId) return;
    setWsStatus('connecting');

    const ws = new WebSocket(
      `${fastapiWsBase(backendOrigin)}/ws/chat/${agentId}?token=${encodeURIComponent(token)}`,
    );
    wsRef.current = ws;

    ws.onopen = () => setWsStatus('connected');
    ws.onclose = () => { setWsStatus('disconnected'); wsRef.current = null; };
    ws.onerror = () => { setWsStatus('disconnected'); };

    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data as string) as {
          id?: string;
          sender_id?: string;
          sender_name?: string;
          content?: string;
          ts?: string;
          file_url?: string;
          error?: string;
        };
        if (d.error || !d.id) return;
        if (seenIdsRef.current.has(d.id)) return;
        seenIdsRef.current.add(d.id);

        const msg: ChannelMsg = {
          id: d.id,
          senderId: d.sender_id ?? '',
          senderName: d.sender_name ?? '',
          content: d.content ?? '',
          ts: d.ts ?? new Date().toISOString(),
          fileUrl: d.file_url,
        };
        setMessages((prev) => [...prev, msg]);
      } catch { /* ignore */ }
    };

    return () => { ws.close(); wsRef.current = null; };
  }, [token, agentId, backendOrigin]);

  // 자동 스크롤
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text && !pendingFile) return;
    const file = pendingFile;
    const reply = replyTo;

    setSendFailed(false);
    setInput('');
    setPendingFile(null);
    setReplyTo(null);

    // story 4913 — what the person wrote comes back into the field when the send is refused (it used to be cleared first and lost)
    const restore = () => { setInput(text); setPendingFile(file); setReplyTo(reply); setSendFailed(true); };
    try {
      if (file) {
        const fd = new FormData();
        fd.set('agent_id', agentId ?? '');
        fd.set('content', text);
        fd.set('file', file);
        const res = await fetch('/api/channel/upload', { method: 'POST', body: fd });
        if (!res.ok) restore();
      } else if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ content: text }));
      } else {
        const res = await fetch('/api/channel/deliver', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agentId, content: text }),
        });
        if (!res.ok) restore();
      }
    } catch {
      restore();
    }
  }, [input, pendingFile, replyTo, agentId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // 한글 등 입력기 조합 중의 Enter는 글자 확정이다 — 보내기로 읽지 않는다(채팅 입력창과 같은 규칙).
      if (isImeComposing(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage],
  );

  if (!agentId) {
    return (
      <>
        <OrgScreenTitle showContextChip>{t('title')}</OrgScreenTitle>
        <PageFrame width="stream">
          <EmptyState icon="forum" title={t('missingAgentId')} />
        </PageFrame>
      </>
    );
  }

  const status = STATUS_CHIP[wsStatus];
  const replyPreview = replyTo ? toPlainPreview(messages.find((m) => m.id === replyTo)?.content ?? '').slice(0, 40) || t('attachment') : null;

  return (
    <>
      <OrgScreenTitle showContextChip>{t('title')}</OrgScreenTitle>
      <PageFrame width="stream" className="flex-1 gap-3" data-testid="channel-page">
        <PageHead
          description={t('description')}
          actions={<Chip dot tone={status.tone} data-testid="channel-status">{t(status.key)}</Chip>}
        />
        {tokenFailed ? (
          <Banner tone="failed" action={<Button onClick={() => setTokenRetry((n) => n + 1)}>{tc('retry')}</Button>}>
            <span data-testid="channel-token-failed">{t('connectFailed')}</span>
          </Banner>
        ) : wsStatus === 'disconnected' ? (
          <Banner tone="note"><span data-testid="channel-disconnected">{t('disconnectedNote')}</span></Banner>
        ) : null}

        {/* story #4130 — 아래 입력 영역이 하단 고정 툴바 역할이라 로컬 min-h-0/flex-1/overflow-hidden 경계를 두지 않는다(셸의 단일 스크롤러가 메시지 목록을 스크롤) · 입력 영역은 sticky bottom-0.
            scrollIntoView() 기반 자동 스크롤은 실제 스크롤 컨테이너가 바뀌어도 DOM API가 스스로 찾아가므로 영향 없음. */}
        <section aria-label={t('title')} role="log" aria-live="polite" aria-relevant="additions" className="flex flex-1 flex-col gap-3" data-testid="channel-messages">
          {messages.length === 0 && (
            <p className="py-8 text-center text-ds-body text-ds-ink-3">
              {wsStatus === 'connecting' ? t('connecting') : t('empty')}
            </p>
          )}
          {messages.map((msg) => {
            const isOwn = msg.senderId === currentTeamMemberId;

            return (
              <div
                key={msg.id}
                data-testid="channel-message"
                data-own={isOwn ? 'true' : 'false'}
                className={`group flex items-start gap-1 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}
              >
                <div className={`flex min-w-0 max-w-prose flex-col gap-0.5 ${isOwn ? 'items-end' : 'items-start'}`}>
                  {!isOwn && <p className="m-0 text-ds-small text-ds-ink-2">{msg.senderName}</p>}
                  <div className={`min-w-0 max-w-full rounded-xl px-3.5 py-2 ${isOwn ? `rounded-tr-sm ${LAYER.rowMine}` : `rounded-tl-sm ${LAYER.rowOthers}`}`}>
                    {msg.content && (
                      <p className="m-0 whitespace-pre-wrap break-words text-ds-body text-ds-ink">{msg.content}</p>
                    )}
                    {msg.fileUrl && (
                      <a
                        href={msg.fileUrl.replace('/api/v2/channel/files/', '/api/channel/files/')}
                        download
                        className="mt-1 block text-ds-small text-ds-action-text underline"
                      >
                        {t('attachment')}
                      </a>
                    )}
                  </div>
                  <p className="m-0 text-ds-small text-ds-ink-3">{fmtTime(msg.ts, locale, displayTimezone)}</p>
                </div>
                {/* story #4345 — 호버 없는 기기에선 늘 · 마우스는 호버 · 초점에서(HOVER_REVEAL) */}
                <IconButton
                  icon="reply"
                  label={t('reply')}
                  onClick={() => setReplyTo(msg.id)}
                  className={`${HOVER_REVEAL} ${HOVER_REVEAL_FOCUS_RING}`}
                />
              </div>
            );
          })}
          <div ref={bottomRef} />
        </section>

        {/* 입력 영역 — 틀의 안쪽 여백을 음수 여백으로 걷어 전폭 · 하단 고정 */}
        <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-col gap-2 border-t border-ds-line bg-ds-background px-4 pb-4 pt-3 sm:-mx-6 sm:-mb-6 sm:px-6 sm:pb-6">
          {sendFailed && (
            <Banner tone="failed"><span data-testid="channel-send-failed">{t('sendFailed')}</span></Banner>
          )}
          {replyPreview !== null && (
            <div data-testid="channel-reply-strip" className={`flex items-center gap-2 rounded-ds-control px-3 py-1.5 text-ds-small text-ds-ink-2 ${LAYER.rowOthers}`}>
              <Icon name="reply" size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{replyPreview}</span>
              <IconButton icon="close" label={t('cancelReply')} onClick={() => setReplyTo(null)} />
            </div>
          )}
          {pendingFile && (
            <div data-testid="channel-file-strip" className={`flex items-center gap-2 rounded-ds-control px-3 py-1.5 text-ds-small text-ds-ink-2 ${LAYER.rowOthers}`}>
              <Icon name="attach_file" size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{pendingFile.name}</span>
              <IconButton icon="close" label={t('removeFile')} onClick={() => setPendingFile(null)} />
            </div>
          )}
          <div className={`flex items-end gap-1 rounded-ds-control border border-ds-line-control ${LAYER.field} px-1 py-1.5 ${FIELD_FOCUS_WITHIN}`} data-testid="channel-composer">
            <textarea
              data-testid="channel-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              aria-label={t('inputLabel')}
              placeholder={t('inputPlaceholder')}
              className="min-h-11 flex-1 resize-none bg-transparent px-2 py-1.5 text-base text-ds-ink outline-none placeholder:text-ds-ink-3 lg:text-ds-body"
            />
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)}
            />
            <IconButton icon="attach_file" label={t('attachFile')} onClick={() => fileInputRef.current?.click()} />
            <IconButton
              icon="send"
              label={t('send')}
              variant="primary"
              onClick={() => void sendMessage()}
              disabled={!input.trim() && !pendingFile}
              data-testid="channel-send"
            />
          </div>
        </div>
      </PageFrame>
    </>
  );
}
