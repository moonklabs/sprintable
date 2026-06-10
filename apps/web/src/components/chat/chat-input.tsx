'use client';

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, Loader2, Paperclip, Send, Terminal, Type, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { getFileIcon } from '@/lib/file-icon';
import { commandName, dequoteLiteral, isCommand } from '@/lib/command-classifier';
import { resolveRuntimeStatus, runtimeLabel } from '@/lib/runtime-capabilities';
import type { SendAttachment } from '@/hooks/use-chat-sse';
import { imageFilesFromClipboard } from '@/lib/clipboard-image';

/** S8 #2: pre-send capability 경고 대상 — 대화의 에이전트 participant(본인 제외) runtime. */
export interface CommandTarget {
  agentId: string;
  agentName: string;
  runtimeType: string | null;
}

const MAX_ATTACHMENTS = 10; // BE _MAX_ATTACHMENTS 정합

function getMentionQuery(value: string, cursorPos: number): string | null {
  const before = value.slice(0, cursorPos);
  const m = before.match(/@([\w가-힣]*)$/);
  return m ? m[1] : null;
}

function applyMention(value: string, cursorPos: number, name: string): { text: string; caretPos: number } {
  const before = value.slice(0, cursorPos);
  const m = before.match(/@([\w가-힣]*)$/);
  if (!m) return { text: value, caretPos: cursorPos };
  const start = cursorPos - m[0].length;
  const replacement = `@${name} `;
  return { text: value.slice(0, start) + replacement + value.slice(cursorPos), caretPos: start + replacement.length };
}

function getEntityQuery(value: string, cursorPos: number): string | null {
  const before = value.slice(0, cursorPos);
  const m = before.match(/#([\w가-힣]*)$/);
  return m ? m[1] : null;
}

function applyEntity(
  value: string,
  cursorPos: number,
  title: string,
  entityType: string,
  entityId: string,
): { text: string; caretPos: number } {
  const before = value.slice(0, cursorPos);
  const m = before.match(/#([\w가-힣]*)$/);
  if (!m) return { text: value, caretPos: cursorPos };
  const start = cursorPos - m[0].length;
  const replacement = `[${title}](entity:${entityType}:${entityId}) `;
  return { text: value.slice(0, start) + replacement + value.slice(cursorPos), caretPos: start + replacement.length };
}

const ENTITY_ICONS: Record<string, string> = {
  story: '📋',
  doc: '📄',
  epic: '🎯',
  task: '✅',
};

interface MentionMember {
  id: string;
  name: string;
  role?: string | null;
}

interface EntityResult {
  entity_type: string;
  entity_id: string;
  title: string;
  status: string | null;
}

interface ChatInputProps {
  onSend: (content: string, mentionedIds?: string[], attachments?: SendAttachment[]) => Promise<void>;
  onUploadFile?: (file: File) => Promise<SendAttachment>;
  disabled?: boolean;
  placeholder?: string;
  projectId?: string;
  onMentionIdsChange?: (ids: string[]) => void;
  commandTargets?: CommandTarget[];
}

export function ChatInput({ onSend, onUploadFile, disabled, placeholder, projectId, onMentionIdsChange, commandTargets }: ChatInputProps) {
  const t = useTranslations('chats');
  const [text, setText] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionedIdsRef = useRef<string[]>([]);

  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionMembers, setMentionMembers] = useState<MentionMember[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  const [entityQuery, setEntityQuery] = useState<string | null>(null);
  const [entityResults, setEntityResults] = useState<EntityResult[]>([]);
  const [entityIndex, setEntityIndex] = useState(0);

  useEffect(() => {
    if (mentionQuery === null) { setMentionMembers([]); return; }
    let cancelled = false;
    fetch(`/api/members?is_active=true${projectId ? `&project_id=${projectId}` : ''}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        const all: MentionMember[] = (json.data ?? []).map((m: { id: string; name: string; role?: string | null }) => ({ id: m.id, name: m.name, role: m.role }));
        const q = mentionQuery.toLowerCase();
        setMentionMembers(q ? all.filter((m) => m.name.toLowerCase().includes(q)) : all);
        setMentionIndex(0);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mentionQuery, projectId]);

  useEffect(() => {
    let cancelled = false;
    if (entityQuery === null || !projectId) { setEntityResults([]); return; }
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ project_id: projectId });
      if (entityQuery) params.set('q', entityQuery);
      fetch(`/api/entities/search?${params}`)
        .then((r) => r.json())
        .then((json: EntityResult[] | { data?: EntityResult[] }) => {
          if (cancelled) return;
          const arr = Array.isArray(json) ? json : (json.data ?? []);
          setEntityResults(Array.isArray(arr) ? arr : []);
          setEntityIndex(0);
        })
        .catch(() => {});
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [entityQuery, projectId]);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const handleTextChange = (nextValue: string, cursorPos: number) => {
    setText(nextValue);
    adjustHeight();
    const mq = getMentionQuery(nextValue, cursorPos);
    const eq = getEntityQuery(nextValue, cursorPos);
    if (mq !== null) {
      setMentionQuery(mq);
      setEntityQuery(null);
      setEntityResults([]);
    } else if (eq !== null) {
      setEntityQuery(eq);
      setMentionQuery(null);
      setMentionMembers([]);
    } else {
      setMentionQuery(null);
      setMentionMembers([]);
      setEntityQuery(null);
      setEntityResults([]);
    }
  };

  const selectMention = (member: MentionMember) => {
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? text.length;
    const { text: nextText, caretPos } = applyMention(text, cursorPos, member.name);
    setText(nextText);
    setMentionQuery(null);
    setMentionMembers([]);
    if (!mentionedIdsRef.current.includes(member.id)) {
      mentionedIdsRef.current = [...mentionedIdsRef.current, member.id];
      onMentionIdsChange?.(mentionedIdsRef.current);
    }
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(caretPos, caretPos);
    });
  };

  const selectEntity = (entity: EntityResult) => {
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? text.length;
    const { text: nextText, caretPos } = applyEntity(text, cursorPos, entity.title, entity.entity_type, entity.entity_id);
    setText(nextText);
    setEntityQuery(null);
    setEntityResults([]);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(caretPos, caretPos);
    });
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if ((!trimmed && pendingFiles.length === 0) || sending || disabled) return;

    setSending(true);
    setUploadFailed(false);
    setSendFailed(false);
    try {
      // 1) 첨부 업로드 단계 — 실패는 "첨부 업로드 실패"로 표시(pending 유지·재시도 가능).
      let attachments: SendAttachment[] | undefined;
      if (pendingFiles.length > 0 && onUploadFile) {
        try {
          attachments = await Promise.all(pendingFiles.map((f) => onUploadFile(f)));
        } catch {
          setUploadFailed(true);
          return; // finally에서 setSending(false)
        }
      }
      // 2) 메시지 전송 단계 — 실패(403·네트워크 등)는 첨부 실패로 오표시하지 않고 전송 실패로 분기.
      try {
        await onSend(
          trimmed,
          mentionedIdsRef.current.length > 0 ? mentionedIdsRef.current : undefined,
          attachments && attachments.length > 0 ? attachments : undefined,
        );
      } catch {
        setSendFailed(true);
        return;
      }
      setText('');
      setPendingFiles([]);
      mentionedIdsRef.current = [];
      onMentionIdsChange?.([]);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (entityResults.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setEntityIndex((i) => (i + 1) % entityResults.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setEntityIndex((i) => (i - 1 + entityResults.length) % entityResults.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectEntity(entityResults[entityIndex]!); return; }
      if (e.key === 'Escape') { setEntityQuery(null); setEntityResults([]); return; }
    }
    if (mentionMembers.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionMembers.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionMembers.length) % mentionMembers.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectMention(mentionMembers[mentionIndex]!); return; }
      if (e.key === 'Escape') { setMentionQuery(null); setMentionMembers([]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    setUploadFailed(false);
    setPendingFiles((prev) => [...prev, ...files].slice(0, MAX_ATTACHMENTS));
  };

  // S3: paste an image from the clipboard → queue it as an attachment (same path as
  // file-select/drop). Non-image pastes fall through to the normal textarea paste.
  const handlePaste = (e: ClipboardEvent) => {
    const images = imageFilesFromClipboard(e);
    if (images.length > 0) {
      e.preventDefault();
      addFiles(images);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    setUploadFailed(false);
  };

  const atMaxAttachments = pendingFiles.length >= MAX_ATTACHMENTS;
  const canSend = (text.trim().length > 0 || pendingFiles.length > 0) && !sending && !disabled;

  return (
    <div
      className="border-t border-border/80 bg-background px-3 py-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* Pending file chips (전송 전) */}
      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pendingFiles.map((file, i) => {
            const Icon = getFileIcon(file.type);
            return (
              <div
                key={`${file.name}-${file.size}-${i}`}
                className={`flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 ${uploadFailed ? 'border-destructive' : 'border-border'}`}
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                )}
                <span className="max-w-[160px] truncate text-xs text-foreground">{file.name}</span>
                <button
                  type="button"
                  onClick={() => removePendingFile(i)}
                  disabled={sending}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                  aria-label="첨부 제거"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {uploadFailed && (
        <p className="mb-1 text-xs text-destructive">첨부 업로드에 실패했습니다. 다시 시도해 주세요.</p>
      )}
      {sendFailed && (
        <p className="mb-1 text-xs text-destructive">{t('sendFailed')}</p>
      )}
      {atMaxAttachments && (
        <p className="mb-1 text-xs text-muted-foreground">첨부는 최대 {MAX_ATTACHMENTS}개까지 가능합니다.</p>
      )}

      {/* S8: command-candidate / 리터럴 escape 입력 affordance (시각 보조 — 전송 차단 아님) */}
      {(() => {
        const cmd = isCommand(text);
        const literal = !cmd && text.startsWith('//');
        if (!cmd && !literal) return null;
        // #2: command 입력 시 미지원 런타임 대상 감지(graceful — commandTargets 없으면 빈 배열 → 경고 미표시).
        const unsupported = cmd
          ? (commandTargets ?? []).filter((tg) => resolveRuntimeStatus(tg.runtimeType) !== 'supported')
          : [];
        if (cmd && unsupported.length > 0) {
          // warning 톤(amber) — 보내기 전 미지원 안내 + 런타임 설정 링크(대상 에이전트별 1행).
          return (
            <div className="mb-2 space-y-1">
              {unsupported.map((tg) => (
                <div
                  key={tg.agentId}
                  className="flex items-center gap-2 rounded-lg border border-warning-border bg-warning-tint px-2.5 py-1.5 text-xs text-warning"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 text-foreground">
                    {t('commandUnsupportedWarn', {
                      agentName: tg.agentName,
                      runtime: runtimeLabel(tg.runtimeType) ?? t('runtimeUnsetLabel'),
                    })}
                  </span>
                  <Link
                    href={`/settings/members/agents/${tg.agentId}`}
                    className="shrink-0 rounded font-medium text-warning underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t('commandViewSettings')}
                  </Link>
                </div>
              ))}
            </div>
          );
        }
        const chip = cmd ? `/${commandName(text)}` : (dequoteLiteral(text).trimStart().split(/\s+/)[0] ?? '');
        return (
          <div className={`mb-2 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${cmd ? 'border-brand/30 bg-brand/10 text-brand' : 'border-border bg-muted/50 text-muted-foreground'}`}>
            {cmd ? <Terminal className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Type className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-foreground">{chip}</code>
            <span>{cmd ? t('commandPreviewSendAsCommand') : t('commandPreviewSendAsLiteral')}</span>
          </div>
        );
      })()}

      <div className="relative flex items-end gap-2">
        {/* Mention dropdown */}
        {mentionMembers.length > 0 && (
          <ul className="absolute bottom-full left-8 z-50 mb-1 max-h-48 w-56 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
            {mentionMembers.map((member, idx) => (
              <li key={member.id}>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); selectMention(member); }}
                  className={`w-full px-3 py-2 text-left text-sm transition ${idx === mentionIndex ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  <span className="font-medium text-primary">@</span>{member.name}
                  {member.role ? <span className="ml-2 text-xs opacity-60">{member.role}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Entity dropdown */}
        {entityResults.length > 0 && (
          <ul className="absolute bottom-full left-8 z-50 mb-1 max-h-48 w-72 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
            {entityResults.map((entity, idx) => (
              <li key={`${entity.entity_type}:${entity.entity_id}`}>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); selectEntity(entity); }}
                  className={`w-full px-3 py-2 text-left text-sm transition ${idx === entityIndex ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  <span className="mr-1.5">{ENTITY_ICONS[entity.entity_type] ?? '#'}</span>
                  <span className="font-medium">{entity.title}</span>
                  {entity.status ? (
                    <span className="ml-2 rounded px-1.5 py-0.5 text-xs bg-muted text-muted-foreground">{entity.status}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Attach */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || atMaxAttachments}
          className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
          aria-label="파일 첨부"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
          accept="image/*,.pdf,.txt,.md,.csv"
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => handleTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => {
            window.setTimeout(() => {
              setMentionQuery(null);
              setMentionMembers([]);
              setEntityQuery(null);
              setEntityResults([]);
            }, 150);
          }}
          disabled={disabled || sending}
          placeholder={placeholder ?? '메시지를 입력하세요… (@ 멘션 / # 엔티티)'}
          className="flex-1 resize-none rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-40"
          style={{ minHeight: '36px', maxHeight: '160px' }}
        />

        {/* Send */}
        <Button
          size="icon"
          className="h-9 w-9 flex-shrink-0 rounded-xl"
          onClick={() => void handleSend()}
          disabled={!canSend}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
