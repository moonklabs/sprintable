// @vitest-environment jsdom
//
// story #3900(UX-v3·§⑤ 어조 가드 사각 3) — 컴포넌트가 pickIGaJosa·pickEulReulJosa로 계산한
// josa가 실 ko.json 문자열의 {josa} 자리에 next-intl로 실제 보간돼 올바른 조사가 DOM에
// 나오는지 실 렌더로 고정한다(소스매칭이 아니라 실 DOM — 받침 有/無 양쪽 표본). 결정적·무네트워크.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import koMessages from '../../messages/ko.json';
import { pickEulReulJosa, pickIGaJosa } from './korean-particle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// canvas.resolvedByNote = "{name}{josa} 해결함" — 이/가 축(pickIGaJosa).
function ResolvedByProbe({ name }: { name: string }) {
  const t = useTranslations('canvas');
  return <p>{t('resolvedByNote', { name, josa: pickIGaJosa(name) })}</p>;
}

// commandPalette.actionDelegateStoryImpact = "{title}{josa} 담당자에게 …" — 을/를 축(pickEulReulJosa).
function DelegateImpactProbe({ title }: { title: string }) {
  const t = useTranslations('commandPalette');
  return <p>{t('actionDelegateStoryImpact', { title, josa: pickEulReulJosa(title) })}</p>;
}

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

describe('korean-particle 실 렌더 — 이/가(canvas.resolvedByNote)', () => {
  it('받침 有(담롱) → 이 ("담롱이 해결함")', async () => {
    await act(async () => { root.render(wrap(<ResolvedByProbe name="담롱" />)); });
    expect(container.textContent).toContain('담롱이 해결함');
    expect(container.textContent).not.toContain('담롱가');
  });

  it('받침 無(미르코) → 가 ("미르코가 해결함")', async () => {
    await act(async () => { root.render(wrap(<ResolvedByProbe name="미르코" />)); });
    expect(container.textContent).toContain('미르코가 해결함');
    expect(container.textContent).not.toContain('미르코이');
  });
});

describe('korean-particle 실 렌더 — 을/를(commandPalette.actionDelegateStoryImpact)', () => {
  it('받침 有(런타임) → 을 ("런타임을 담당자에게")', async () => {
    await act(async () => { root.render(wrap(<DelegateImpactProbe title="런타임" />)); });
    expect(container.textContent).toContain('런타임을 담당자에게');
    expect(container.textContent).not.toContain('런타임를');
  });

  it('받침 無(스토리) → 를 ("스토리를 담당자에게")', async () => {
    await act(async () => { root.render(wrap(<DelegateImpactProbe title="스토리" />)); });
    expect(container.textContent).toContain('스토리를 담당자에게');
    expect(container.textContent).not.toContain('스토리을');
  });
});
