// @vitest-environment jsdom
// story #5c29454b(③ result 카드, doc result-card-final-spec-5c29454b) — 3존 규격(판정 dot·
// 근거 라벨·다음 행동 박스) 실렌더 검증. no-fiction 원칙(원문에 없으면 안 뜬다)이 핵심이라
// 정적 코드 리뷰보다 실 DOM 렌더로 확認한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ReportMessageSummary } from './report-message-summary';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

// isReportDense 임계값(8줄/400자) 이상을 확실히 넘기는 PASS 판정 report 본문.
const PASS_REPORT = [
  '**전체 판정 — PASS**',
  '오늘 배포한 3개 표면 전부 실측 완료.',
  '**① 3009 — PASS**',
  '- 인라인 카드 elev-card 토큰 확認',
  '**② 3010 — PASS**',
  '- inbox Bot칩 확認',
  '**③ 3011 — PASS**',
  '- Workcell 잘림 fix 확認',
].join('\n');

const FAIL_REPORT = [
  '**전체 판정 — FAIL**',
  '오늘 배포한 3개 표면 전부 반려.',
  '**① 3009 — FAIL**',
  '- 인라인 카드 elev-card 토큰 회귀',
  '**② 3010 — FAIL**',
  '- inbox Bot칩 회귀',
  '**③ 3011 — FAIL**',
  '- Workcell 잘림 fix 회귀',
].join('\n');

describe('ReportMessageSummary — story #5c29454b 판정 dot', () => {
  it('kind=result·PASS 어휘면 success dot(bg-success)이 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <ReportMessageSummary content={PASS_REPORT} messageKind="result" isMine={false} references={undefined} />,
      ));
    });
    expect(container.querySelector('.bg-success')).not.toBeNull();
    expect(container.querySelector('.bg-destructive')).toBeNull();
  });

  it('kind=result·FAIL 어휘면 destructive dot이 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <ReportMessageSummary content={FAIL_REPORT} messageKind="result" isMine={false} references={undefined} />,
      ));
    });
    expect(container.querySelector('.bg-destructive')).not.toBeNull();
    expect(container.querySelector('.bg-success')).toBeNull();
  });

  it('kicker가 «판정»이 아니면(kind=request) dot 자체가 안 뜬다', async () => {
    const raw = [
      '**요청 사항**',
      '이 부분 검토 부탁하는.',
      '- 항목 1',
      '- 항목 2',
      '- 항목 3',
      '- 항목 4',
      '- 항목 5',
      '- 항목 6',
    ].join('\n');
    await act(async () => {
      root.render(wrap(
        <ReportMessageSummary content={raw} messageKind="request" isMine={false} references={undefined} />,
      ));
    });
    expect(container.querySelector('.bg-success')).toBeNull();
    expect(container.querySelector('.bg-destructive')).toBeNull();
    expect(container.textContent).toContain('요청');
  });
});

describe('ReportMessageSummary — story #5c29454b 근거 라벨', () => {
  it('topLevelItems가 있으면 «근거» 라벨이 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <ReportMessageSummary content={PASS_REPORT} messageKind="result" isMine={false} references={undefined} />,
      ));
    });
    expect(container.textContent).toContain('근거');
  });

  it('topLevelItems가 0개면 «근거» 라벨이 안 뜬다', async () => {
    const raw = '그냥 아주 긴 산문 설명입니다. '.repeat(30);
    await act(async () => {
      root.render(wrap(
        <ReportMessageSummary content={raw} messageKind="result" isMine={false} references={undefined} />,
      ));
    });
    expect(container.textContent).not.toContain('근거');
  });
});

describe('ReportMessageSummary — story #5c29454b 다음 행동 박스(no-fiction)', () => {
  it('원문에 «다음: ...»이 있으면 다음 행동 박스가 뜬다', async () => {
    const raw = `${PASS_REPORT}\n다음: 카디르군 QA 요청`;
    await act(async () => {
      root.render(wrap(
        <ReportMessageSummary content={raw} messageKind="result" isMine={false} references={undefined} />,
      ));
    });
    expect(container.textContent).toContain('다음');
    expect(container.textContent).toContain('카디르군 QA 요청');
  });

  it('원문에 «다음» 구분자가 없으면 다음 행동 박스 자체가 안 뜬다(지어내지 않음)', async () => {
    await act(async () => {
      root.render(wrap(
        <ReportMessageSummary content={PASS_REPORT} messageKind="result" isMine={false} references={undefined} />,
      ));
    });
    // "다음 행동" 라벨/박스가 없어야 한다 — reportViewFull("전문 보기 →")과는 무관.
    expect(container.textContent).not.toContain('카디르군');
    const boxes = Array.from(container.querySelectorAll('div')).filter((d) =>
      d.className.includes('bg-brand/10'));
    expect(boxes.length).toBe(0);
  });
});

describe('ReportMessageSummary — 발동 조건 미충족(회귀 0)', () => {
  it('밀도 임계값 미달이면 3존 렌더 자체가 없고 기존 ChatMarkdown 경로로 폴백한다', async () => {
    await act(async () => {
      root.render(wrap(
        <ReportMessageSummary content="짧은 메시지" messageKind="result" isMine={false} references={undefined} />,
      ));
    });
    expect(container.querySelector('.bg-success')).toBeNull();
    expect(container.textContent).toContain('짧은 메시지');
  });
});
