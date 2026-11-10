// @vitest-environment jsdom
// UI-3(a9d56577) — ds Avatar 회귀가드: 모양(에이전트 = 원 · 사람 = 사각) · 3단 폴백 · 로드 실패 폴백 · 일하는 중 링(활동 축) · 연결 점(연결 축) · 툴팁.
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

const shape = () => container.querySelector('[data-shape]') as HTMLElement;

describe('ds Avatar — 모양은 지금 약속 그대로', () => {
  it('에이전트 = 원', async () => {
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" />)); });
    expect(shape().getAttribute('data-shape')).toBe('circle');
    expect(shape().className).toContain('rounded-full');
  });

  it('사람 = 사각(둥근 모서리 + 테두리)', async () => {
    await act(async () => { root.render(wrap(<Avatar name="지우" actorType="human" />)); });
    expect(shape().getAttribute('data-shape')).toBe('square');
    expect(shape().className).toContain('rounded-ds-control');
    expect(shape().className).toContain('border');
    expect(shape().className).not.toContain('rounded-full');
  });

  it('사진이 있어도 모양은 같다(이미지도 그 모양으로 잘린다)', async () => {
    await act(async () => { root.render(wrap(<Avatar name="지우" avatarUrl="https://example.com/a.png" actorType="human" />)); });
    expect(shape().getAttribute('data-shape')).toBe('square');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
  });
});

describe('ds Avatar — 사진 → 이니셜 → 아이콘 폴백', () => {
  it('사진이 기본이다(alt = 접근성 이름)', async () => {
    await act(async () => { root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/a.png" actorType="human" />)); });
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('송윤재');
  });

  it('사진이 없으면 이니셜', async () => {
    await act(async () => { root.render(wrap(<Avatar name="송윤재" avatarUrl={null} actorType="human" />)); });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('송');
  });

  it('⭐사진 로드 실패(onError)가 이니셜로 폴백한다', async () => {
    await act(async () => { root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/broken.png" actorType="human" />)); });
    const img = container.querySelector('img')!;
    await act(async () => { img.dispatchEvent(new Event('error')); });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('송');
  });

  it('사진 주소가 바뀌면 다시 시도한다', async () => {
    await act(async () => { root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/broken.png" actorType="human" />)); });
    await act(async () => { container.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(container.querySelector('img')).toBeNull();
    await act(async () => { root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/new.png" actorType="human" />)); });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/new.png');
  });

  it('이름이 없으면 아이콘 단계 — 에이전트 smart_toy · 사람 person(없는 글자를 지어내지 않는다)', async () => {
    await act(async () => { root.render(wrap(<Avatar name={null} label="이름 없는 에이전트" actorType="agent" />)); });
    expect(container.querySelector('[data-icon="smart_toy"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="이름 없는 에이전트"]')).not.toBeNull();
    await act(async () => { root.render(wrap(<Avatar name="  " actorType="human" />)); });
    expect(container.querySelector('[data-icon="person"]')).not.toBeNull();
  });
});

describe('ds Avatar — 일하는 중 링(활동 축) · 연결 점(연결 축)', () => {
  it('평소에는 링이 없다(상시 정적 링 폐지 — 모양이 구분한다)', async () => {
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" />)); });
    expect(shape().className).not.toContain('ring-');
  });

  it('⭐에이전트가 일하는 중이면 action 펄스 링', async () => {
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" isWorking />)); });
    expect(shape().className).toContain('ring-ds-action');
    expect(shape().className).toContain('motion-safe:animate-pulse');
  });

  it('사람에게는 일하는 중 링이 없다', async () => {
    await act(async () => { root.render(wrap(<Avatar name="지우" actorType="human" isWorking />)); });
    expect(shape().className).not.toContain('ring-ds-action');
  });

  it('에이전트에게만 연결 점(축을 합치지 않는다 — 일하는 중이어도 점은 연결 상태 그대로)', async () => {
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" presenceStatus="online" isWorking />)); });
    const dot = container.querySelector('[role="img"][data-presence]')!;
    expect(dot.getAttribute('data-presence')).toBe('online');
    expect(dot.className).toContain('bg-ds-done');
    expect(shape().className).toContain('ring-ds-action');
  });

  it('연결 점 3단계가 서로 다른 모양(색만으로 구분하지 않는다: offline은 속 빈 점)', async () => {
    const cls: Record<string, string> = {};
    for (const s of ['online', 'idle', 'offline'] as const) {
      await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" presenceStatus={s} />)); });
      cls[s] = container.querySelector('[data-presence]')!.className;
    }
    expect(new Set(Object.values(cls)).size).toBe(3);
    expect(cls.offline).toContain('ring-inset');
  });

  it('사람은 연결 점이 없다', async () => {
    await act(async () => { root.render(wrap(<Avatar name="지우" actorType="human" presenceStatus="online" />)); });
    expect(container.querySelector('[data-presence]')).toBeNull();
  });
});

describe('ds Avatar — 접근성 · 테두리 · 점 크기 · 커넥터 배지', () => {
  it('⭐이름만 있는 이니셜 · 아이콘 단계는 role=img + 이름(role 없는 span에 aria-label을 달지 않는다)', async () => {
    await act(async () => { root.render(wrap(<Avatar name="송윤재" actorType="human" />)); });
    const el = container.querySelector('[aria-label="송윤재"]')!;
    expect(el.getAttribute('role')).toBe('img');
    await act(async () => { root.render(wrap(<Avatar name={null} label="이름 없는 사람" actorType="human" />)); });
    expect(container.querySelector('[aria-label="이름 없는 사람"]')!.getAttribute('role')).toBe('img');
    await act(async () => { root.render(wrap(<Avatar name={null} actorType="human" />)); });
    expect(container.querySelector('[aria-label]')).toBeNull();
  });

  it('⭐사람 테두리는 3:1 이상인 line-control(장식선 line-strong이 아니다)', async () => {
    await act(async () => { root.render(wrap(<Avatar name="지우" actorType="human" />)); });
    expect(shape().className).toContain('border-ds-line-control');
    expect(shape().className).not.toContain('border-ds-line-strong');
  });

  it('연결 점은 40px 미만 10px · 이상 12px(shared/avatar와 같은 눈금)', async () => {
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" size={32} presenceStatus="online" />)); });
    expect((container.querySelector('[data-presence]') as HTMLElement).style.width).toBe('10px');
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" size={48} presenceStatus="online" />)); });
    expect((container.querySelector('[data-presence]') as HTMLElement).style.width).toBe('12px');
  });

  it('커넥터 배지: 아이콘형은 ≥28px에서만 · 그 아래에서는 안 그린다 · mono는 흰 디스크', async () => {
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" size={32} runtimeType="claude-code" />)); });
    const badge = container.querySelector('img[src="/connector-icons/claude-code.jpg"]');
    expect(badge).not.toBeNull();
    expect(badge!.parentElement!.className).toContain('ring-ds-background');
    expect(badge!.parentElement!.className).not.toContain('bg-white');
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" size={24} runtimeType="claude-code" />)); });
    expect(container.querySelector('img[src^="/connector-icons/"]')).toBeNull();
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" size={32} runtimeType="gemini" />)); });
    expect(container.querySelector('img[src="/connector-icons/gemini.png"]')!.parentElement!.className).toContain('bg-white');
  });

  it('사람에게는 커넥터 배지가 없다', async () => {
    await act(async () => { root.render(wrap(<Avatar name="지우" actorType="human" size={32} runtimeType="claude-code" />)); });
    expect(container.querySelector('img[src^="/connector-icons/"]')).toBeNull();
  });
});

describe('ds Avatar — 코너 글자 배지 · 툴팁', () => {
  it('>40px 에이전트만 «에이전트» 글자 배지(≤40px는 없음)', async () => {
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" size={64} />)); });
    expect(container.textContent).toContain('에이전트');
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" size={32} />)); });
    expect(container.textContent).not.toContain('에이전트');
  });

  it('에이전트 래퍼는 키보드로 포커스가 간다(툴팁이 hover 전용이 되지 않게)', async () => {
    await act(async () => { root.render(wrap(<Avatar name="개발" actorType="agent" />)); });
    expect(container.querySelector('[data-actor="agent"]')!.getAttribute('tabindex')).toBe('0');
    await act(async () => { root.render(wrap(<Avatar name="지우" actorType="human" />)); });
    expect(container.querySelector('[data-actor="human"]')!.getAttribute('tabindex')).toBeNull();
  });
});
