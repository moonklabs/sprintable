'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { Paperclip, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ChatInputProps {
  onSend: (content: string) => Promise<void>;
  onUpload: (file: File) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInput({ onSend, onUpload, disabled, placeholder }: ChatInputProps) {
  const [text, setText] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if ((!trimmed && !pendingFile) || sending || disabled) return;

    setSending(true);
    try {
      if (pendingFile) {
        await onUpload(pendingFile);
        setPendingFile(null);
      }
      if (trimmed) {
        await onSend(trimmed);
        setText('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
      }
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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

      <div className="flex items-end gap-2">
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
          onChange={(e) => { setText(e.target.value); adjustHeight(); }}
          onKeyDown={handleKeyDown}
          disabled={disabled || sending}
          placeholder={placeholder ?? '메시지를 입력하세요…'}
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
