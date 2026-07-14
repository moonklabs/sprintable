'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface StoryPickerItem { id: string; title: string }

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T };
    return json.data ?? null;
  } catch {
    return null;
  }
}

interface StoryPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onSelect: (storyId: string) => void;
}

/**
 * story 70a06b22 — 갤러리 빈상태 CTA 진입점. 그라운딩 확定(BE story_id/epic_id/doc_id 재배선
 * 엔드포인트 부재, PO 승인 회신)대로 "생성 시 스토리 지정"만 해결한다 — 이미 존재하는 무소속
 * 산출물을 나중에 스토리에 붙이는 기능은 이 컴포넌트의 스코프가 아니다(별개 갭, 후속 스토리
 * 후보). 검색+선택만(과설계 금지) — 기존 `/api/stories` GET(q= 검색 이미 지원)을 그대로 재사용,
 * 신규 BE 0.
 */
export function StoryPickerDialog({ open, onOpenChange, projectId, onSelect }: StoryPickerDialogProps) {
  const t = useTranslations('canvas');
  const [query, setQuery] = useState('');
  const [stories, setStories] = useState<StoryPickerItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // setLoading(true)를 디바운스 콜백 안으로 넣어 effect 본문 동기 setState를 피한다(lint,
    // 기존 IntersectionObserver 가드류와 동형 패턴) — 250ms 지연은 타이핑 중 스피너 깜빡임도 줄여준다.
    const handle = setTimeout(() => {
      setLoading(true);
      void (async () => {
        const params = new URLSearchParams({ project_id: projectId, limit: '20' });
        if (query.trim()) params.set('q', query.trim());
        const result = await fetchJson<StoryPickerItem[]>(`/api/stories?${params.toString()}`);
        if (!cancelled) { setStories(result ?? []); setLoading(false); }
      })();
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [open, query, projectId]);

  // 닫힐 때 검색어 초기화는 effect가 아니라 onOpenChange 이벤트 핸들러에서 직접(동기 setState가
  // 이벤트 콜백 안이라 set-state-in-effect lint 대상이 아님 — 다음 오픈 시 새 검색으로 시작).
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setQuery(''); onOpenChange(next); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('storyPickerTitle')}</DialogTitle>
        </DialogHeader>

        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('storyPickerSearchPlaceholder')}
        />

        <div className="max-h-64 space-y-1 overflow-y-auto">
          {loading ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">{t('storyPickerLoading')}</p>
          ) : stories.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">{t('storyPickerEmpty')}</p>
          ) : (
            stories.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelect(s.id)}
                className="block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-muted/60"
              >
                {s.title}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
