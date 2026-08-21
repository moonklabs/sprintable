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

  it('working=true면 pulsing WORKING_RING 클래스, false면 정적 accent-claim 링', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" isWorking />));
    });
    const ringEl = container.querySelector('.ring-info');
    expect(ringEl).not.toBeNull();

    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" isWorking={false} />));
    });
    expect(container.querySelector('.ring-accent-claim')).not.toBeNull();
    expect(container.querySelector('.ring-info')).toBeNull();
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
