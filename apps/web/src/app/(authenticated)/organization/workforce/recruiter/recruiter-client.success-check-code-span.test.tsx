// @vitest-environment jsdom
//
// story #2648 — settings.agentFakechatSuccessCheck의 성공 확認 리터럴이 두 자리(recruiter-
// client.tsx STEP3·workforce/[id]/page.tsx)에서 t.rich(..., {code: ...})로 렌더된다. 소스텍스트
// 매칭만으론 t.rich 태그명 충돌(WakeMethodBody 주석 참고 — 콘솔 에러 없이 값이 조용히
// 삼켜지는 클래스, feedback-render-test-over-source-grep 교훈)을 못 잡는다 — 실제 next-intl
// 파싱으로 <code> 엘리먼트가 실제로 생기고 정정된 리터럴([sprintable], 원래 [fakechat]로
// 오기됐던 것 — PO 08-14 실측 정정)이 그 안에 들어가는지 실 렌더로 고정한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import enMessages from '../../../../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// recruiter-client.tsx STEP3·workforce/[id]/page.tsx 두 소비처가 실제로 쓰는 것과 동일한
// t.rich 호출 패턴(§본문 참고) — 사본이 아니라 그 계약(메시지 키+code 렌더prop 모양)을
// 그대로 재현해 next-intl 실 파싱을 태운다.
function SuccessCheck() {
  const t = useTranslations('settings');
  return (
    <p>
      {t.rich('agentFakechatSuccessCheck', {
        code: (chunks) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{chunks}</code>,
      })}
    </p>
  );
}

function wrap(locale: 'ko' | 'en', node: React.ReactNode) {
  const messages = locale === 'ko' ? koMessages : enMessages;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
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

describe('agentFakechatSuccessCheck — story #2648 코드스팬+리터럴 정정 실 렌더', () => {
  it('ko — 정정된 리터럴 "[sprintable] SSE stream open"이 실제 <code> 엘리먼트 안에 렌더된다(옛 [fakechat] 아님)', async () => {
    await act(async () => { root.render(wrap('ko', <SuccessCheck />)); });
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('[sprintable] SSE stream open');
    expect(container.textContent).not.toContain('fakechat');
  });

  it('en — 동일하게 정정된 리터럴이 <code> 엘리먼트로 렌더된다', async () => {
    await act(async () => { root.render(wrap('en', <SuccessCheck />)); });
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('[sprintable] SSE stream open');
    expect(container.textContent).not.toContain('fakechat');
  });

  it('빈 괄호/삼켜짐 회귀가드 — 태그명(code)이 인자명과 안 겹쳐 값이 조용히 사라지지 않는다', async () => {
    await act(async () => { root.render(wrap('ko', <SuccessCheck />)); });
    expect(container.textContent).not.toContain('()');
    expect(container.textContent).toContain('성공 확인');
  });
});
