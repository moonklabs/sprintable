import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { RoadmapFlow } from './roadmap-flow';
import type { RoadmapEpic } from '@/services/glance';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const EPICS: RoadmapEpic[] = [
  { id: 'e1', title: 'E-VERIFY', roadmapStatus: 'done', done: 5, total: 5, completionPct: 100 },
  { id: 'e2', title: 'E-CANVAS', roadmapStatus: 'active', done: 5, total: 8, completionPct: 62 },
  { id: 'e3', title: 'E-GLANCE', roadmapStatus: 'upcoming', done: 0, total: 0, completionPct: 0 },
];

describe('RoadmapFlow (§3 로드맵 흐름 — 주어=프로젝트, 개인/시간 지연 강조 0)', () => {
  it('renders nothing for an empty epic list', () => {
    expect(renderToStaticMarkup(wrap(<RoadmapFlow epics={[]} />))).toBe('');
  });

  it('marks the active epic with the current-position marker', () => {
    const markup = renderToStaticMarkup(wrap(<RoadmapFlow epics={EPICS} />));
    expect(markup).toContain('E-CANVAS');
    expect(markup).toContain('여기');
  });

  it('renders a project-subject summary line, never an individual-attribution phrase', () => {
    const markup = renderToStaticMarkup(wrap(<RoadmapFlow epics={EPICS} />));
    expect(markup).toContain('3개 마일스톤 중');
    expect(markup).toContain('2번째');
  });

  it('falls back to marking the last epic as current when no epic is active', () => {
    const allDone: RoadmapEpic[] = EPICS.map((e) => ({ ...e, roadmapStatus: 'done' as const }));
    const markup = renderToStaticMarkup(wrap(<RoadmapFlow epics={allDone} />));
    expect(markup).toContain('3개 마일스톤 중');
    expect(markup).toContain('3번째');
  });

  it('fills the connector between two completed epics with the success color, not the neutral border color', () => {
    const markup = renderToStaticMarkup(wrap(<RoadmapFlow epics={EPICS} />));
    expect(markup).toContain('bg-success');
  });

  it('links each milestone to its epic detail page (§3 "마일스톤 클릭 → 해당 에픽 상세" drill-down)', () => {
    const markup = renderToStaticMarkup(wrap(<RoadmapFlow epics={EPICS} />));
    expect(markup).toContain('href="/epics/e1"');
    expect(markup).toContain('href="/epics/e2"');
    expect(markup).toContain('href="/epics/e3"');
  });
});
