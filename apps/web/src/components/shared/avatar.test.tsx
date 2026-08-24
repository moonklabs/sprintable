// @vitest-environment jsdom
//
// story #2887(S2g) — Avatar 3단 폴백(이미지→이니셜→아이콘) + 에이전트 식별(링·AI 배지·dot)
// 회귀가드. 목업 s2g-avatar-mockup 규칙: 이미지가 있어도 agent는 링+배지 유지.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { Avatar } from './avatar';
import koMessages from '../../../messages/ko.json';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

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
});

describe('Avatar — story #2887 S2g', () => {
  it('avatar_url 있으면 이미지를 그린다(휴먼)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/a.png" actorType="human" />));
    });
    const img = container.querySelector('img');
    expect(img?.src).toBe('https://example.com/a.png');
    expect(img?.alt).toBe('송윤재');
  });

  it('avatar_url 없으면 이니셜 폴백(휴먼)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl={null} actorType="human" />));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('송');
  });

  it('휴먼은 링·AI배지·dot이 없다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl={null} actorType="human" presenceStatus="online" />));
    });
    expect(container.textContent).not.toContain('AI');
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it('에이전트는 이미지가 있어도 AI 배지가 유지된다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl="https://example.com/a.png" actorType="agent" presenceStatus="online" />));
    });
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.textContent).toContain('AI');
    expect(container.querySelector('[role="img"]')).not.toBeNull(); // PresenceDot
  });

  // story #3000 로드맵 PR-B(L5, 페드루군 동승 판정) — 정적 "AI" 코너배지는 citron이 아니라
  // proof-blue 틴트여야 한다(정체성 마킹 — citron은 live pulse 전용).
  it('AI 코너배지가 border-proof-blue/bg-proof-blue-soft를 쓰고 citron은 안 쓴다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" />));
    });
    const badge = [...container.querySelectorAll('span')].find((s) => s.textContent === 'AI');
    expect(badge).toBeTruthy();
    expect(badge?.className).toContain('border-proof-blue/40');
    expect(badge?.className).toContain('bg-proof-blue-soft');
    expect(badge?.className).not.toContain('accent-claim');
  });

  // story #2921(유나 합성 5규칙③, avatar-unification-design-memo-2921, 2026-08-22 확定) —
  // 옛 값(idle=citron 정적·working=info(=proof-blue 별칭) 펄스)이 규칙③과 정반대였다(3339
  // 그라운딩에서 실측 발견) — swap: idle=blue 정적·working=citron 펄스가 정본.
  it('working=true면 citron 펄스(AGENT_LIVE_RING_CLASS), false면 정적 proof-blue 링', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" isWorking />));
    });
    expect(container.querySelector('.ring-proof-citron')).not.toBeNull();
    expect(container.querySelector('.ring-proof-blue')).toBeNull();

    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" isWorking={false} />));
    });
    expect(container.querySelector('.ring-proof-blue')).not.toBeNull();
    expect(container.querySelector('.ring-proof-citron')).toBeNull();
  });

  // story #2921(유나 합성 5규칙②) — 형태는 actorType에서 자동 유도(호출부가 shape를 안 넘김).
  // 이미지가 있어도 같은 클립(overflow-hidden 래퍼의 반경)을 받는다.
  it('에이전트=circle(rounded-full)·human=square(rounded-md)+무채 테두리(색과 별개의 redundant 경계 신호)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" />));
    });
    const agentWrapper = container.querySelector('.rounded-full');
    expect(agentWrapper).toBeTruthy();
    expect(container.querySelector('.rounded-md')).toBeNull();
    expect(container.querySelector('.border-proof-line')).toBeNull(); // 에이전트는 링이 그 역할.

    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl={null} actorType="human" />));
    });
    const humanWrapper = container.querySelector('.rounded-md');
    expect(humanWrapper).toBeTruthy();
    expect(humanWrapper?.className).toContain('border-proof-line');
    expect(container.querySelector('.rounded-full')).toBeNull();
  });

  it('human도 이미지가 있으면 square로 클립된다(이미지 tier도 형태 예외 없음)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/a.png" actorType="human" />));
    });
    expect(container.querySelector('img')).toBeTruthy();
    const wrapper = container.querySelector('.rounded-md');
    expect(wrapper).toBeTruthy();
    expect(wrapper?.querySelector('img')).toBeTruthy();
  });

  it('presenceStatus 없으면(휴먼 기본) dot 미표시 — 에이전트라도 null이면 미표시', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" presenceStatus={null} />));
    });
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  // 카디르군 QA(#3304, HIGH) — avatar_url이 실제로는 깨진 이미지(삭제된 GCS object 등)일 때
  // native onError를 받아 이니셜 tier로 진짜 폴백하는지.
  it('이미지 로드 실패(onError) 시 이니셜로 폴백한다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/broken.png" actorType="human" />));
    });
    const img = container.querySelector('img')!;
    expect(img).not.toBeNull();
    await act(async () => { img.dispatchEvent(new Event('error')); });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('송');
  });

  it('avatar_url이 바뀌면(교체 업로드) 이전 에러 상태를 잊고 새 URL을 다시 시도한다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/broken.png" actorType="human" />));
    });
    await act(async () => { container.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(container.querySelector('img')).toBeNull();

    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/new.png" actorType="human" />));
    });
    const img = container.querySelector('img');
    expect(img?.src).toBe('https://example.com/new.png');
  });
});
