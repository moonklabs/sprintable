'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Paperclip, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
  onSend: (content: string, mentionedIds?: string[]) => Promise<void>;
  onUpload?: (file: File) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  projectId?: string;
  onMentionIdsChange?: (ids: string[]) => void;
}

export function ChatInput({ onSend, onUpload, disabled, placeholder, projectId, onMentionIdsChange }: ChatInputProps) {
  const [text, setText] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
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
    fetch(`/api/team-members?is_active=true${projectId ? `&project_id=${projectId}` : ''}`)
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
    if ((!trimmed && !pendingFile) || sending || disabled) return;

    setSending(true);
    try {
      if (pendingFile && onUpload) {
        await onUpload(pendingFile);
        setPendingFile(null);
      }
      if (trimmed) {
        await onSend(trimmed, mentionedIdsRef.current.length > 0 ? mentionedIdsRef.current : undefined);
        setText('');
        mentionedIdsRef.current = [];
        onMentionIdsChange?.([]);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
      }
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPendingFile(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) setPendingFile(file);
  };

  const canSend = (text.trim().length > 0 || pendingFile !== null) && !sending && !disabled;

  return (
    <div
      className="border-t border-border/80 bg-background px-3 py-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* Pending file preview */}
      {pendingFile && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5">
          <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-xs text-foreground">{pendingFile.name}</span>
          <button
            type="button"
            onClick={() => setPendingFile(null)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

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
          disabled={disabled}
          className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
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
