'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * story #4888(UI-5 보드 · 목록 화면, PO 11-10 20:20Z — 디디 셸 실측) — 목록 보기에도 «스토리 추가» 입구 한 자리.
 *
 * 폰 390은 일감 탭의 기본 보기가 «목록»인데 목록 보기에는 만들기 입구가 0이라 «일감 → 보드 보기로 바꾸기 → 스토리 추가»(3동작 + 입력)로만 일감을 만들 수 있었다.
 * 새 기능이 아니다 — 같은 동작(`handleCreateStory` → POST /api/stories, 상태 backlog)을 부르는 같은 모양의 입력칸(열 머리 «+»가 여는 것과 같은 글 · Enter 만들기 · Esc 닫기)을
 * 목록 맨 위에 한 줄로 둘 뿐이다. 만들어진 스토리는 보드와 같은 `stories` 상태에 붙어 «대기/백로그» 묶음에 바로 선다.
 */
export function ListStoryComposer({ onCreate }: { onCreate: (title: string) => Promise<void> | void }) {
  const t = useTranslations('board');
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const close = () => {
    setComposing(false);
    setDraft('');
  };
  const submit = async () => {
    const title = draft.trim();
    if (!title || submitting) return;
    setSubmitting(true);
    try {
      await onCreate(title);
      close();
    } finally {
      setSubmitting(false);
    }
  };

  if (!composing) {
    return (
      <div className="px-1 pb-1" data-testid="list-story-composer">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setComposing(true)}
          className="h-9 w-full justify-start gap-1.5 px-3 text-sm text-muted-foreground hover:text-foreground pointer-coarse:h-11"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t('addStory')}
        </Button>
      </div>
    );
  }
  return (
    <div className="mx-1 mb-2 rounded-md border border-primary/30 p-2" data-testid="list-story-composer">
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // 한글 조합 중 Enter는 글자 확정이지 «만들기»가 아니다.
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            close();
          }
        }}
        placeholder={t('addStoryPlaceholder')}
        className="h-8 text-base lg:text-sm"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="default" className="h-7 px-2 text-xs" onClick={() => void submit()} disabled={submitting || !draft.trim()}>
          {t('addStorySubmit')}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={close}>
          {t('addStoryCancel')}
        </Button>
      </div>
    </div>
  );
}
