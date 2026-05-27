'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Paperclip, Send, X } from 'lucide-react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Button } from '@/components/ui/button';

interface ChannelMsg {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  ts: string;
  fileUrl?: string;
}

type WsStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

function fastapiWsBase(): string {
  return (process.env.NEXT_PUBLIC_FASTAPI_URL ?? 'http://localhost:8000')
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://');
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function ChannelPage() {
  const t = useTranslations('channel');
  const searchParams = useSearchParams();
  const agentId = searchParams.get('agent_id');
  const { currentTeamMemberId } = useDashboardContext();

  const [messages, setMessages] = useState<ChannelMsg[]>([]);
  const [input, setInput] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('idle');
  const [token, setToken] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const msgMapRef = useRef<Map<string, ChannelMsg>>(new Map());
  const seenIdsRef = useRef<Set<string>>(new Set());

  // JWT 가져오기
  useEffect(() => {
    fetch('/api/channel/token')
      .then((r) => r.json())
      .then((d: { token: string }) => setToken(d.token))
      .catch(() => {});
  }, []);

  // WebSocket 연결
  useEffect(() => {
    if (!token || !agentId) return;
    setWsStatus('connecting');

    const ws = new WebSocket(
      `${fastapiWsBase()}/ws/chat/${agentId}?token=${encodeURIComponent(token)}`,
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
        msgMapRef.current.set(msg.id, msg);
        setMessages((prev) => [...prev, msg]);
      } catch { /* ignore */ }
    };

    return () => { ws.close(); wsRef.current = null; };
  }, [token, agentId]);

  // 자동 스크롤
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text && !pendingFile) return;

    setInput('');
    setPendingFile(null);
    setReplyTo(null);

    if (pendingFile) {
      const fd = new FormData();
      fd.set('agent_id', agentId ?? '');
      fd.set('content', text);
      fd.set('file', pendingFile);
      await fetch('/api/channel/upload', { method: 'POST', body: fd });
    } else if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ content: text }));
    } else {
      await fetch('/api/channel/deliver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, content: text }),
      });
    }
  }, [input, pendingFile, agentId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage],
  );

  if (!agentId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('missingAgentId')}</p>
      </div>
    );
  }

  const statusDot =
    wsStatus === 'connected'
      ? 'bg-success'
      : wsStatus === 'connecting'
        ? 'bg-warning animate-pulse'
        : 'bg-muted-foreground';

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{t('title')}</span>
            <span className={`h-2 w-2 rounded-full ${statusDot}`} title={wsStatus} />
          </div>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {/* 메시지 목록 */}
        <section className="flex-1 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {wsStatus === 'connecting' ? t('connecting') : t('empty')}
            </p>
          )}
          {messages.map((msg) => {
            const isOwn = msg.senderId === currentTeamMemberId;

            return (
              <div
                key={msg.id}
                className={`group mb-3 flex ${isOwn ? 'justify-end' : 'justify-start'}`}
              >
                <div className="max-w-[70%]">
                  {!isOwn && (
                    <p className="mb-0.5 text-xs text-muted-foreground">{msg.senderName}</p>
                  )}
                  <div
                    className={`relative rounded-2xl px-3 py-2 ${isOwn ? 'bg-brand text-brand-foreground' : 'bg-muted text-foreground'}`}
                  >
                    {msg.content && (
                      <p className="whitespace-pre-wrap break-words text-sm">{msg.content}</p>
                    )}
                    {msg.fileUrl && (
                      <a
                        href={msg.fileUrl.replace(
                          '/api/v2/channel/files/',
                          '/api/channel/files/',
                        )}
                        download
                        className="mt-1 block text-xs underline opacity-80"
                      >
                        [{t('attachment')}]
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => setReplyTo(msg.id)}
                      className={`absolute ${isOwn ? '-left-6' : '-right-6'} top-1 hidden text-muted-foreground group-hover:block`}
                      title={t('reply')}
                    >
                      ↩
                    </button>
                  </div>
                  <p
                    className={`mt-0.5 text-xs text-muted-foreground ${isOwn ? 'text-right' : 'text-left'}`}
                  >
                    {fmtTime(msg.ts)}
                  </p>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </section>

        {/* 입력 영역 */}
        <div className="border-t border-border bg-background px-4 pb-safe-4 pb-4 pt-3">
          {replyTo && (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              <span>
                ↩{' '}
                {(msgMapRef.current.get(replyTo)?.content ?? '').slice(0, 40) || t('attachment')}
              </span>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                className="ml-auto"
                aria-label={t('cancelReply')}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          {pendingFile && (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              <Paperclip className="h-3 w-3 flex-shrink-0" />
              <span className="truncate">{pendingFile.name}</span>
              <button
                type="button"
                onClick={() => setPendingFile(null)}
                className="ml-auto flex-shrink-0"
                aria-label={t('removeFile')}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              placeholder={t('inputPlaceholder')}
              className="min-h-[44px] flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              title={t('attachFile')}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              onClick={() => void sendMessage()}
              disabled={!input.trim() && !pendingFile}
              title={t('send')}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
