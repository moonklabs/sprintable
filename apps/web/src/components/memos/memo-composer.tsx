'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useMemoPresence } from '@/components/memos/use-memo-presence';

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

export interface EmbedItem {
  entity_type: string;
  entity_id: string;
  position: number;
}

interface MemoComposerProps {
  collaboration?: ReturnType<typeof useMemoPresence>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
  placeholder: string;
  submitLabel: string;
  helperText?: string;
  rows?: number;
  submitting?: boolean;
  disabled?: boolean;
  showSubmitButton?: boolean;
  memoId?: string;
  currentTeamMemberId?: string;
  currentTeamMemberName?: string;
  projectId?: string;
  onEmbedsChange?: (embeds: EmbedItem[]) => void;
}

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

function isImageFile(file: File) {
  return IMAGE_MIME_TYPES.has(file.type) || /^image\//.test(file.type);
}

export function MemoComposer({
  collaboration: providedCollaboration,
  value,
  onChange,
  onSubmit,
  placeholder,
  submitLabel,
  helperText,
  rows = 6,
  submitting = false,
  disabled = false,
  showSubmitButton = true,
  memoId,
  currentTeamMemberId,
  currentTeamMemberName,
  projectId,
  onEmbedsChange,
}: MemoComposerProps) {
  const t = useTranslations('memos');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const valueRef = useRef(value);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionMembers, setMentionMembers] = useState<MentionMember[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  const [entityQuery, setEntityQuery] = useState<string | null>(null);
  const [entityResults, setEntityResults] = useState<EntityResult[]>([]);
  const [entityIndex, setEntityIndex] = useState(0);
  const [embeds, setEmbeds] = useState<EmbedItem[]>([]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (mentionQuery === null) {
      setMentionMembers([]);
      return;
    }
    let cancelled = false;
    fetch('/api/team-members')
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
  }, [mentionQuery]);

  // Entity search with 200ms debounce
  useEffect(() => {
    let cancelled = false;
    if (entityQuery === null || !projectId) {
      setEntityResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ project_id: projectId });
      if (entityQuery) params.set('q', entityQuery);
      fetch(`/api/v2/entities/search?${params}`)
        .then((r) => r.json())
        .then((json: EntityResult[]) => {
          if (cancelled) return;
          setEntityResults(Array.isArray(json) ? json : []);
          setEntityIndex(0);
        })
        .catch(() => {});
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [entityQuery, projectId]);

  const localCollaboration = useMemoPresence({
    memoId,
    currentTeamMemberId,
    currentTeamMemberName,
    enabled: !providedCollaboration && Boolean(memoId && currentTeamMemberId),
  });
  const collaboration = providedCollaboration ?? localCollaboration;

  const insertText = useCallback((text: string) => {
    const textarea = textareaRef.current;
    const currentValue = valueRef.current;
    if (!textarea) {
      onChange(`${currentValue}${text}`);
      return;
    }

    const start = textarea.selectionStart ?? currentValue.length;
    const end = textarea.selectionEnd ?? currentValue.length;
    const nextValue = `${currentValue.slice(0, start)}${text}${currentValue.slice(end)}`;
    onChange(nextValue);

    requestAnimationFrame(() => {
      textarea.focus();
      const nextCaret = start + text.length;
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  }, [onChange]);

  const uploadFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => isImageFile(file));
    if (imageFiles.length === 0) return;

    setUploading(true);
    setUploadError(null);

    try {
      for (const file of imageFiles) {
        const formData = new FormData();
        formData.set('file', file);
        formData.set('scope', memoId ? 'reply' : 'memo');
        if (memoId) formData.set('memo_id', memoId);

        const res = await fetch('/api/memos/attachments', { method: 'POST', body: formData });
        if (!res.ok) {
          const json = await res.json().catch(() => null);
          throw new Error(json?.error?.message ?? t('uploadFailed'));
        }

        const json = await res.json();
        insertText(`\n${json.data.markdown}\n`);
      }
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : t('uploadFailed'));
    } finally {
      setUploading(false);
    }
  }, [insertText, memoId, t]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [
      ...Array.from(event.clipboardData.files ?? []),
      ...Array.from(event.clipboardData.items ?? [])
        .map((item) => (item.kind === 'file' ? item.getAsFile() : null))
        .filter((file): file is File => Boolean(file)),
    ];
    if (!files.some(isImageFile)) return;
    event.preventDefault();
    void uploadFiles(files);
  }, [uploadFiles]);

  const handleDrop = useCallback((event: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer.files ?? []);
    if (!files.some(isImageFile)) return;
    event.preventDefault();
    void uploadFiles(files);
  }, [uploadFiles]);

  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    void uploadFiles(files);
    event.target.value = '';
  }, [uploadFiles]);

  const selectMention = useCallback((member: MentionMember) => {
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? value.length;
    const { text, caretPos } = applyMention(value, cursorPos, member.name);
    onChange(text);
    setMentionQuery(null);
    setMentionMembers([]);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(caretPos, caretPos);
    });
  }, [onChange, value]);

  const selectEntity = useCallback((entity: EntityResult) => {
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? value.length;
    const { text, caretPos } = applyEntity(value, cursorPos, entity.title, entity.entity_type, entity.entity_id);
    onChange(text);
    setEntityQuery(null);
    setEntityResults([]);

    const nextEmbeds: EmbedItem[] = [
      ...embeds,
      { entity_type: entity.entity_type, entity_id: entity.entity_id, position: embeds.length },
    ];
    setEmbeds(nextEmbeds);
    onEmbedsChange?.(nextEmbeds);

    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(caretPos, caretPos);
    });
  }, [embeds, onChange, onEmbedsChange, value]);

  const handleChange = useCallback((nextValue: string, cursorPos: number) => {
    onChange(nextValue);
    collaboration.setTyping(Boolean(nextValue.trim()));

    const mq = getMentionQuery(nextValue, cursorPos);
    const eq = getEntityQuery(nextValue, cursorPos);

    // @ and # are mutually exclusive
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
  }, [collaboration, onChange]);

  const handleSubmit = useCallback(async () => {
    if (disabled || submitting || uploading || !value.trim()) return;
    collaboration.setTyping(false);
    await onSubmit();
  }, [collaboration, disabled, onSubmit, submitting, uploading, value]);

  useEffect(() => {
    if (!value.trim()) {
      collaboration.setTyping(false);
    }
  }, [collaboration, value]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (entityResults.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setEntityIndex((i) => (i + 1) % entityResults.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setEntityIndex((i) => (i - 1 + entityResults.length) % entityResults.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        selectEntity(entityResults[entityIndex]);
        return;
      }
      if (event.key === 'Escape') {
        setEntityQuery(null);
        setEntityResults([]);
        return;
      }
    }
    if (mentionMembers.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMembers.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionMembers.length) % mentionMembers.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        selectMention(mentionMembers[mentionIndex]);
        return;
      }
      if (event.key === 'Escape') {
        setMentionQuery(null);
        setMentionMembers([]);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleSubmit();
    }
  }, [entityIndex, entityResults, handleSubmit, mentionMembers, mentionIndex, selectEntity, selectMention]);

  const presenceSummary = useMemo(() => {
    const viewers = collaboration.viewers.map((entry) => entry.name);
    const typingUsers = collaboration.typingUsers.map((entry) => entry.name);
    return { viewers, typingUsers };
  }, [collaboration.typingUsers, collaboration.viewers]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {collaboration.connected ? <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-700">● {t('realtimeConnected')}</span> : null}
        {presenceSummary.viewers.length > 0 ? <span>{t('currentViewers')}: {presenceSummary.viewers.join(', ')}</span> : null}
        {presenceSummary.typingUsers.length > 0 ? <span>{t('typingNow')}: {presenceSummary.typingUsers.join(', ')}</span> : null}
        {uploading ? <span>{t('uploadingImage')}</span> : null}
        {helperText ? <span>{helperText}</span> : null}
      </div>

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => handleChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            collaboration.setTyping(false);
            // Delay close so click on dropdown item fires first
            window.setTimeout(() => {
              setMentionQuery(null);
              setMentionMembers([]);
              setEntityQuery(null);
              setEntityResults([]);
            }, 150);
          }}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
          className="w-full rounded-md border border-input px-3 py-2 text-sm focus:border-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        {mentionMembers.length > 0 && (
          <ul className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-[min(16rem,100%)] overflow-y-auto rounded-md border border-border bg-popover shadow-md">
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
        {entityResults.length > 0 && (
          <ul className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-[min(20rem,100%)] overflow-y-auto rounded-md border border-border bg-popover shadow-md">
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
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || submitting || uploading}
            className="rounded-md border border-input px-3 py-2 text-sm text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('imageUpload')}
          </button>
          {showSubmitButton ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={disabled || submitting || uploading || !value.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? t('submitting') : submitLabel}
            </button>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">{t('composerShortcut')}</div>
      </div>

      {uploadError ? <p className="text-xs text-red-600">{uploadError}</p> : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
}
