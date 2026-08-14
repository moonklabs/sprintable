// @vitest-environment jsdom
//
// story #2434 — 유나 홀름 design:changes(2026-08-03, PR#2823): kitOrientingWakeBody_* 메시지가
// `<path>{path}</path>`(태그명 = ICU 인자명)이면 next-intl이 인자 값을 조용히 삼킨다 — 콘솔
// 에러도 없고 type-check도 안 잡는다. 소스 텍스트 매칭 가드(recruiter-client.test.tsx)는 이
// 문자열이 "존재하는지"만 보지 실제로 렌더됐을 때 값이 들어가는지는 안 본다 — 그래서 그 결함이
// 초록인 채로 통과했다. invite/page.test.tsx(#2084)와 같은 클래스의 위험: 실 DOM으로 고정한다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { WakeMethodBody } from './recruiter-client';
import koMessages from '../../../../../../messages/ko.json';
import enMessages from '../../../../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

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

describe('WakeMethodBody (story #2434) — path가 실제로 DOM에 렌더되는지', () => {
  // story #2648(PO 08-14 확定 (b)) — channel-plugin은 예외로 뒤집혔다: packages/fakechat
  // 내부 경로가 «비-actionable»(같은 문장이 "받는 경로는 아직 제공하지 않습니다"라고
  // 이미 말한다)인데도 사용자 표면에 그대로 샜던 것 — 이제 path를 안 보여준다(빈 괄호
  // 대신 자연스러운 문장으로). 형제 3종(connector-host 등)은 무변경 — 아래 별도 테스트.
  it('ko channel-plugin: packages/fakechat 내부 경로가 더는 안 보인다(story #2648)', async () => {
    await act(async () => {
      root.render(wrap('ko', <WakeMethodBody method="channel-plugin" path="packages/fakechat" />));
    });
    expect(container.textContent).not.toContain('fakechat');
    expect(container.textContent).not.toContain('()');
    expect(container.textContent).toContain('채널 플러그인');
  });

  // story #2652(유나 design 게이트 소견, 2026-08-14) — #2648 Part1에서 channel-plugin만
  // 빠졌던 통일을 형제 3종까지 마저 적용: connectors/codex-sprintable/ 같은 모노레포
  // 내부 경로가 "받는 경로는 아직 제공하지 않습니다" 옆에 자기모순으로 노출되던 것을 제거.
  it('ko connector-host: 내부 경로가 더는 안 보인다(story #2652)', async () => {
    await act(async () => {
      root.render(wrap('ko', <WakeMethodBody method="connector-host" path="connectors/codex-sprintable/" />));
    });
    expect(container.textContent).not.toContain('connectors/codex-sprintable/');
    expect(container.textContent).not.toContain('()');
    expect(container.textContent).toContain('커넥터 호스트');
    expect(container.querySelector('span.font-mono')).toBeNull();
  });

  it('en channel-plugin: packages/fakechat 내부 경로가 더는 안 보인다(story #2648)', async () => {
    await act(async () => {
      root.render(wrap('en', <WakeMethodBody method="channel-plugin" path="packages/fakechat" />));
    });
    expect(container.textContent).not.toContain('fakechat');
    expect(container.textContent).not.toContain('()');
    expect(container.textContent).toContain('channel plugin');
  });

  it('en connector-host: 내부 경로가 더는 안 보인다(story #2652)', async () => {
    await act(async () => {
      root.render(wrap('en', <WakeMethodBody method="connector-host" path="connectors/codex-sprintable/" />));
    });
    expect(container.textContent).not.toContain('connectors/codex-sprintable/');
    expect(container.textContent).not.toContain('()');
    expect(container.querySelector('span.font-mono')).toBeNull();
  });

  it('ko connector-sidecar: 내부 경로가 더는 안 보인다(story #2652)', async () => {
    await act(async () => {
      root.render(wrap('ko', <WakeMethodBody method="connector-sidecar" path="connectors/cloud-agent-sidecar/" />));
    });
    expect(container.textContent).not.toContain('connectors/cloud-agent-sidecar/');
    expect(container.textContent).not.toContain('()');
    expect(container.textContent).toContain('사이드카');
    expect(container.querySelector('span.font-mono')).toBeNull();
  });

  it('ko connector-sdk: 내부 경로가 더는 안 보인다(story #2652)', async () => {
    await act(async () => {
      root.render(wrap('ko', <WakeMethodBody method="connector-sdk" path="packages/reference-sdk/" />));
    });
    expect(container.textContent).not.toContain('packages/reference-sdk/');
    expect(container.textContent).not.toContain('()');
    expect(container.textContent).toContain('참조 SDK');
    expect(container.querySelector('span.font-mono')).toBeNull();
  });

  it('unknown은 t.rich를 안 쓰고 plain 문구를 보여준다(path 태그 없음)', async () => {
    await act(async () => {
      root.render(wrap('ko', <WakeMethodBody method="unknown" path="" />));
    });
    expect(container.textContent?.length).toBeGreaterThan(0);
    expect(container.querySelector('span.font-mono')).toBeNull();
  });
});
