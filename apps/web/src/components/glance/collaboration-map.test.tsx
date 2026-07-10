import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CollaborationMap } from './collaboration-map';
import type { EpicCollaboration, RoadmapEpic } from '@/services/glance';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const ROADMAP: RoadmapEpic[] = [
  { id: 'e1', title: 'E-CANVAS', roadmapStatus: 'active', done: 5, total: 8, completionPct: 62 },
];

describe('CollaborationMap (§5 ⭐감시 최고 위험 지점 — presence만, 개수/처리량 절대 노출 0)', () => {
  it('renders participant initials without ever emitting a count or quantity string', () => {
    const collab: EpicCollaboration[] = [
      { epicId: 'e1', collaborators: [{ id: 'm1', name: '미르코 페트로비치' }, { id: 'm2', name: '유나 홀름' }] },
    ];
    const markup = renderToStaticMarkup(wrap(<CollaborationMap roadmap={ROADMAP} collaboration={collab} />));
    expect(markup).toContain('함께 구축 중');
    expect(markup).toContain('미르코 페트로비치');
    // 감시-게이트 리트머스: "2명"·"N개"류 수량화 문자열이 아예 나오면 안 된다.
    expect(markup).not.toMatch(/\d+\s*명/);
    expect(markup).not.toMatch(/\d+\s*개\s*완료/);
  });

  it('renders a calm "not yet assigned" state (not an error) when no epic has any collaborator', () => {
    const collab: EpicCollaboration[] = [{ epicId: 'e1', collaborators: [] }];
    const markup = renderToStaticMarkup(wrap(<CollaborationMap roadmap={ROADMAP} collaboration={collab} />));
    expect(markup).toContain('아직 배정 전');
  });

  it('keeps the row for a done/active epic with zero collaborators (§9 매트릭스 — 목업 예시대로 행 유지, 통째로 숨기지 않음) alongside a populated epic', () => {
    const roadmap: RoadmapEpic[] = [
      { id: 'e1', title: 'E-CANVAS', roadmapStatus: 'active', done: 5, total: 8, completionPct: 62 },
      { id: 'e2', title: 'E-GLANCE', roadmapStatus: 'done', done: 3, total: 3, completionPct: 100 },
    ];
    const collab: EpicCollaboration[] = [
      { epicId: 'e1', collaborators: [{ id: 'm1', name: '미르코 페트로비치' }] },
      { epicId: 'e2', collaborators: [] },
    ];
    const markup = renderToStaticMarkup(wrap(<CollaborationMap roadmap={roadmap} collaboration={collab} />));
    expect(markup).toContain('E-CANVAS');
    expect(markup).toContain('미르코 페트로비치');
    expect(markup).toContain('E-GLANCE');
    expect(markup).toContain('아직 배정 전');
  });

  it('excludes upcoming (never-started) epics from the list entirely, to avoid a long list of untouched rows', () => {
    const roadmap: RoadmapEpic[] = [
      { id: 'e1', title: 'E-CANVAS', roadmapStatus: 'active', done: 5, total: 8, completionPct: 62 },
      { id: 'e2', title: 'E-MOBILE', roadmapStatus: 'upcoming', done: 0, total: 0, completionPct: 0 },
    ];
    const collab: EpicCollaboration[] = [{ epicId: 'e1', collaborators: [{ id: 'm1', name: '미르코 페트로비치' }] }];
    const markup = renderToStaticMarkup(wrap(<CollaborationMap roadmap={roadmap} collaboration={collab} />));
    expect(markup).not.toContain('E-MOBILE');
  });

  it('falls back to the full empty state when every epic is still upcoming', () => {
    const roadmap: RoadmapEpic[] = [{ id: 'e1', title: 'E-MOBILE', roadmapStatus: 'upcoming', done: 0, total: 0, completionPct: 0 }];
    const markup = renderToStaticMarkup(wrap(<CollaborationMap roadmap={roadmap} collaboration={[]} />));
    expect(markup).toContain('아직 배정 전');
    expect(markup).not.toContain('E-MOBILE');
  });
});
