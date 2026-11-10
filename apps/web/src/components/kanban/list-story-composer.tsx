'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { Input } from '@/components/ds/input';

/**
 * story #4888(UI-5 보드 · 목록 화면, PO 11-10 20:20Z — 디디 셸 실측) — 목록 보기에도 «스토리 추가» 입구 한 자리.
 *
 * 폰 390은 일감 탭의 기본 보기가 «목록»인데 목록 보기에는 만들기 입구가 0이라 «일감 → 보드 보기로 바꾸기 → 스토리 추가»(3동작 + 입력)로만 일감을 만들 수 있었다.
 * 새 기능이 아니다 — 같은 동작(`handleCreateStory` → POST /api/stories, 상태 backlog)을 부르는 같은 모양의 입력칸(열 머리 «+»가 여는 것과 같은 글 · Enter 만들기 · Esc 닫기)을
 * 목록 맨 위에 한 줄로 둘 뿐이다. 만들어진 스토리는 보드와 같은 `stories` 상태에 붙어 «대기/백로그» 묶음에 바로 선다.
 *
 * 새로 짓는 부품이라 옛 `ui/button` · `ui/input`이 아니라 ds Button · Input을 쓴다(PO 5553 지적): ds Button은 폰(coarse)에서 누름 영역 44를 이미 쥐고 있다 —
 * 이 입구는 폰에서 일감을 만들라고 둔 것인데 폰에서 누르는 단추가 44 미만이면 안 된다. 입력칸도 폰에서는 44 이상.
 */
export function ListStoryComposer({ onCreate }: { onCreate: (title: string) => Promise<boolean | void> | boolean | void }) {
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
      // false = 만들기 실패(오류는 보드가 이미 띄웠다) — 입력칸과 제목을 그대로 남겨 다시 누르게 한다. 지우면 쓴 글이 사라진다.
      const result = await onCreate(title);
      if (result !== false) close();
    } finally {
      setSubmitting(false);
    }
  };

  if (!composing) {
    return (
      <div className="px-1 pb-1" data-testid="list-story-composer">
        <Button
          type="button"
          variant="quiet"
          size="lg"
          iconStart={<Icon name="add" size={16} />}
          onClick={() => setComposing(true)}
          className="w-full justify-start"
        >
          {t('addStory')}
        </Button>
      </div>
    );
  }
  return (
    <div className="mx-1 mb-2 rounded-ds-control border border-ds-action p-2" data-testid="list-story-composer">
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
        className="pointer-coarse:min-h-11"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button type="button" variant="primary" loading={submitting} disabled={!draft.trim()} onClick={() => void submit()}>
          {t('addStorySubmit')}
        </Button>
        <Button type="button" variant="quiet" onClick={close}>
          {t('addStoryCancel')}
        </Button>
      </div>
    </div>
  );
}
