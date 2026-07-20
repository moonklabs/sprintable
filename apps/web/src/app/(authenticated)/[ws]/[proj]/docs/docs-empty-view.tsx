'use client';

import { Plus, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useTranslations } from 'next-intl';
import { useDocsLayout } from './docs-context';

// story e38d634f(doc resource-view-firsttouch-identity-pattern §4 "문서" 행 — visual=선택
// 없음): `/docs` 인덱스는 특정 문서 미선택 시 항상 뜨는 뷰라(문서 50개 있어도 동일) — 정체성
// explainer는 tree.length===0(진짜 빈 프로젝트)에만. tree.length>0(문서 있음·미선택)은 기존
// "문서를 선택하세요" 완전 무변화(에픽 PR#2209·보드 PR#2211에서 확립한 필터빈/미선택 vs
// 진짜빈 구분 재사용 — 이 뷰는 그 구분이 없으면 가장 흔하게 거짓 메시지가 뜰 뻔한 케이스).
export function DocsEmptyView() {
  const t = useTranslations('docs');
  const { handleNewDoc, tree } = useDocsLayout();

  if (tree.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 lg:p-6">
        <EmptyState
          icon={<BookOpen className="size-8" />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          className="w-full max-w-lg bg-background/70"
          action={
            <Button size="sm" onClick={handleNewDoc}>
              <Plus className="mr-1 h-4 w-4" />
              {t('newDoc')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-4 lg:p-6">
      <EmptyState
        title={t('title')}
        description={t('selectDoc')}
        className="w-full max-w-lg bg-background/70"
        action={
          <Button size="sm" onClick={handleNewDoc}>
            <Plus className="mr-1 h-4 w-4" />
            {t('newDoc')}
          </Button>
        }
      />
    </div>
  );
}
