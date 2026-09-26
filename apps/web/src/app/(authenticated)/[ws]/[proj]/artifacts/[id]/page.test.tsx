// story #4343(유나 · PO 11:22Z) — 산출물 상세가 작성자 이름표(프로젝트 범위)를 받게, 서버 경계에서 읽은 프로젝트 id를 상세 뷰에 넘긴다.
// (넘기지 않으면 상세 뷰가 구성원 GET을 안 해 판 줄 작성자가 전부 «알 수 없는 구성원» — 뷰 쪽은 artifact-detail-view.test.tsx가 본다.)
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const headerValues = new Map<string, string>([['x-resolved-project-id', 'p-1']]);
vi.mock('next/headers', () => ({ headers: async () => ({ get: (k: string) => headerValues.get(k) ?? null }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
vi.mock('@/components/canvas/artifact-detail-view', () => ({ ArtifactDetailView: () => null }));

import ArtifactDetailPage from './page';

describe('산출물 상세 페이지(story #4343)', () => {
  it('프로젝트 id(x-resolved-project-id)를 상세 뷰에 넘긴다', async () => {
    const el = (await ArtifactDetailPage({ params: Promise.resolve({ id: 'a-1' }) })) as ReactElement<{ artifactId: string; projectId?: string }>;
    expect(el.props).toEqual({ artifactId: 'a-1', projectId: 'p-1' });
  });
});
