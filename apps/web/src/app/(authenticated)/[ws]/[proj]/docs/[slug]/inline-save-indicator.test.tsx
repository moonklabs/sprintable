// @vitest-environment jsdom
//
// story #3677(FE·대비·確定, 2026-09-07) — InlineSaveIndicator의 status='error' 칩이
// hover:text-destructive/80(resting state보다 대비를 낮추는 방향)을 썼다 — hover는
// underline으로 피드백을 표현하고 색은 그대로(text-destructive, 알파 없음) 두도록
// 교체. page.tsx 전체를 마운트하지 않고 이 하위 컴포넌트만 직접 렌더(카디르 CI
// 지적: app-router page.tsx는 named export가 있으면 build type check가 깨져
// 형제 모듈 inline-save-indicator.tsx로 분리 — page.test.tsx 부재라 이 파일이
// 유일한 회귀가드).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InlineSaveIndicator } from './inline-save-indicator';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

const t = ((key: string) => key) as unknown as Parameters<typeof InlineSaveIndicator>[0]['t'];
// story #3787(페드루 재검토 11:51Z) — tc는 common ns(「저장 중…」 등)용 프롭. 실 값을
// 흉내내 아래 saving 테스트가 실제 낱말을 assert할 수 있게 한다(키 그대로 echo하는 t와
// 다르게 — 원 결함이 정확히 「화면에 키 문자열 statusSaving이 그대로」였기 때문).
const tc = ((key: string) => (key === 'saving' ? '저장 중…' : key)) as unknown as Parameters<typeof InlineSaveIndicator>[0]['tc'];

describe('InlineSaveIndicator — status=error (story #3677 대비 뮤테이션가드)', () => {
  it('hover 클래스가 text-destructive/80이 아니라 underline이다(resting 대비를 낮추지 않음)', async () => {
    await act(async () => {
      root.render(<InlineSaveIndicator status="error" onAction={() => {}} t={t} tc={tc} />);
    });
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    const className = button?.getAttribute('class') ?? '';
    expect(className).toContain('text-destructive');
    expect(className).toContain('hover:underline');
    expect(className).not.toContain('text-destructive/80');
  });
});

// story #3787(페드루 재검토 11:51Z) — inline-save-indicator.tsx가 t를 프롭으로 받는
// 형제 모듈이라(#3677 App Router 제약) i18n-key-coverage가 파일 경계를 넘는 호출을
// 못 본다 — docs.statusSaving을 걷었는데 이 자리만 그 키를 계속 부르던 회귀(PO 코드
// 확認, 화면에 키 문자열 그대로 노출). tc를 프롭으로 받는 형태로 정정 — 되돌리면
// (tc→t) 이 테스트가 정확히 RED가 되는지 뮤테이션 킬 확認 완료.
describe('InlineSaveIndicator — status=saving (story #3787 회귀 pin)', () => {
  it('aria-label·title이 common.saving 값(「저장 중…」)을 쓴다 — 키 문자열이 그대로 새지 않는다', async () => {
    await act(async () => {
      root.render(<InlineSaveIndicator status="saving" onAction={() => {}} t={t} tc={tc} />);
    });
    const span = container.querySelector('span[aria-label]');
    expect(span).not.toBeNull();
    expect(span?.getAttribute('aria-label')).toBe('저장 중…');
    expect(span?.getAttribute('title')).toBe('저장 중…');
    expect(span?.getAttribute('aria-label')).not.toBe('statusSaving');
  });
});
