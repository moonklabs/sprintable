'use client';

import { useState } from 'react';
import { Sparkles, ChevronRight, ChevronLeft, ArrowRight } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { type ReleaseNote } from '@/lib/release-notes';

interface ReleaseNotesDialogProps {
  open: boolean;
  onClose: () => void;
  notes: ReleaseNote[];
}

export function ReleaseNotesDialog({ open, onClose, notes }: ReleaseNotesDialogProps) {
  const [view, setView] = useState<'latest' | 'list'>('latest');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const note: ReleaseNote | undefined = selectedId
    ? notes.find((n) => n.id === selectedId)
    : notes[0];

  const reset = () => {
    setView('latest');
    setSelectedId(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      onClose();
      reset();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md rounded-xl">
        {notes.length === 0 ? (
          <>
            <DialogHeader className="space-y-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-info">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                What&apos;s new
              </span>
              <DialogTitle className="text-base">릴리즈 노트</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                아직 새로운 소식이 없어요. 업데이트가 준비되면 여기에서 알려드릴게요.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="hero" size="sm" onClick={() => handleOpenChange(false)}>
                확인
              </Button>
            </DialogFooter>
          </>
        ) : view === 'latest' && note ? (
          <>
            <DialogHeader className="space-y-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-info">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                What&apos;s new
              </span>
              <DialogTitle className="flex flex-wrap items-center gap-2 text-lg">
                {note.title}
                <Badge variant="outline" className="text-xs">{note.version}</Badge>
              </DialogTitle>
              <p className="text-xs text-muted-foreground">{note.publishedAt}</p>
              <DialogDescription className="text-sm text-muted-foreground">
                {note.summary}
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-2">
              {note.items.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-info" aria-hidden />
                  <span className="min-w-0">
                    {item.text}
                    {item.href && (
                      <a
                        href={item.href}
                        className="ml-1.5 inline-flex items-center gap-0.5 text-info hover:underline"
                      >
                        자세히 보기
                        <ArrowRight className="h-3 w-3" aria-hidden />
                      </a>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <DialogFooter className="flex-row items-center justify-between border-t border-border pt-4 sm:justify-between">
              <Button variant="ghost" size="sm" onClick={() => setView('list')}>
                이전 노트
              </Button>
              <Button variant="hero" size="sm" onClick={() => handleOpenChange(false)}>
                확인
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="space-y-2">
              <button
                type="button"
                onClick={reset}
                className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                이전 노트
              </button>
              <DialogTitle className="text-base">릴리즈 노트</DialogTitle>
              <DialogDescription className="sr-only">이전 릴리즈 노트 목록</DialogDescription>
            </DialogHeader>
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {notes.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(n.id);
                      setView('latest');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:bg-accent"
                  >
                    <Badge variant="outline" className="shrink-0 text-xs">{n.version}</Badge>
                    <span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{n.publishedAt}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
