import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ProgressTrajectory } from './progress-trajectory';
import type { RoadmapEpic } from '@/services/glance';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('ProgressTrajectory (§4 정성 언어 우선 — %는 보조, 0/0=결핍 아닌 "시작 전")', () => {
  it('shows a qualitative phrase (not a bald percentage) for an in-progress epic', () => {
    const epic: RoadmapEpic = { id: 'e1', title: 'E-CANVAS', roadmapStatus: 'active', done: 5, total: 8, completionPct: 62 };
    const markup = renderToStaticMarkup(wrap(<ProgressTrajectory epic={epic} />));
    expect(markup).toContain('거의 다 왔는');
    expect(markup).toContain('5/8');
  });

  it('renders a calm "no stories yet" line (not a deficiency framing) for a zero-story epic', () => {
    const epic: RoadmapEpic = { id: 'e2', title: 'E-GLANCE', roadmapStatus: 'upcoming', done: 0, total: 0, completionPct: 0 };
    const markup = renderToStaticMarkup(wrap(<ProgressTrajectory epic={epic} />));
    expect(markup).toContain('시작 전');
    expect(markup).toContain('아직 스토리가 없습니다');
  });
});
