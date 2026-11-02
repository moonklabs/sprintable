// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { SenderProfilePopover, pointAnchor } from './sender-profile-popover';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// story #3776(1층A) — SenderProfilePopover가 chats ns의 useTranslations('사용자 차단' 라벨)
// 를 부르게 되며 next-intl 컨텍스트가 필요해졌다(blocked-users-section.test.tsx 선례 동형).
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
  document.querySelectorAll('[data-slot="popover-content"]').forEach((n) => n.remove());
});

const NOOP = () => {};

describe('SenderProfilePopover — story #2349 "상대 프로필" 진입점', () => {
  it('이름을 그린다', async () => {
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="오르테가" isAgent onClose={NOOP} />));
    });
    expect(document.body.textContent).toContain('오르테가');
  });

  it('onBlock을 안 주면 「사용자 차단」 버튼이 안 그려진다', async () => {
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="오르테가" isAgent onClose={NOOP} />));
    });
    expect(document.body.textContent).not.toContain('사용자 차단');
  });

  it('onBlock을 주면 「사용자 차단」이 뜨고 클릭 시 onBlock+onClose가 불린다', async () => {
    const onBlock = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="민" isAgent={false} onClose={onClose} onBlock={onBlock} />));
    });
    const btn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('사용자 차단'));
    expect(btn).not.toBeUndefined();
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape를 누르면 onClose가 불린다', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="민" isAgent={false} onClose={onClose} />));
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('바깥을 클릭하면 onClose가 불린다(눌렀다 뗀 한 번의 클릭)', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="민" isAgent={false} onClose={onClose} />));
    });
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // story 4831 — 손으로 지은 팝업은 마우스를 «누르는 순간(pointerdown)» 닫았다. 바탕 Popover(Base UI)는 마우스는 «뗄 때(click)» 닫고 터치는 누르는 순간 닫는다.
  // 실제 Chromium에서도 같다(누르고만 있으면 열려 있고 뗀 뒤 닫힘). «눈에 보이는 변화»로 PR 본문에 적었고, 여기서 잠근다.
  it('마우스는 누르고만 있으면 닫히지 않고 뗀 뒤(click)에 닫힌다', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="민" isAgent={false} onClose={onClose} />));
    });
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('팝업 안을 누르면 닫히지 않는다', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="민" isAgent={false} onClose={onClose} />));
    });
    const popup = document.body.querySelector('[role="dialog"]')!;
    await act(async () => {
      popup.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      popup.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  // story #2968(카디르 QA #3397 MEDIUM) — chat-bubble.tsx가 이미 들고 있던 sender_avatar_url을
  // 이 팝업에 안 넘겨 Bot/User 하드코딩 아이콘에 머물러 있었다. avatar.tsx 정본 배선.
  it('avatarUrl을 주면 Bot/User 아이콘 대신 avatar.tsx 정본이 실사진(<img>)을 렌더한다', async () => {
    await act(async () => {
      root.render(wrap(
        <SenderProfilePopover x={0} y={0} name="유나" isAgent={false} avatarUrl="https://storage.googleapis.com/bucket/avatar/a.png" onClose={NOOP} />,
      ));
    });
    const img = document.body.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://storage.googleapis.com/bucket/avatar/a.png');
  });

  it('avatarUrl을 안 주면(레거시) avatar.tsx 정본의 이니셜 폴백으로 떨어진다(img 없음)', async () => {
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="유나" isAgent={false} onClose={NOOP} />));
    });
    expect(document.body.querySelector('img')).toBeNull();
  });
});

// story #3106(#3092 후속) — chat-bubble.tsx가 message.sender_runtime_type을 그대로 넘겨줘야
// 이 팝업의 아바타도 Presence 패널과 동일하게 커넥터 마크를 그린다.
describe('SenderProfilePopover — story #3106 runtimeType 배선', () => {
  it('runtimeType을 주면 아바타에 커넥터 공식 아이콘이 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="오르테가" isAgent runtimeType="claude-code" onClose={NOOP} />));
    });
    const disk = document.body.querySelector('.rounded-full.ring-2.ring-background');
    expect(disk?.querySelector('img')?.getAttribute('src')).toBe('/connector-icons/claude-code.jpg');
  });

  it('runtimeType을 안 주면(레거시) "Agent" 텍스트 폴백 그대로다(회귀 없음)', async () => {
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="오르테가" isAgent onClose={NOOP} />));
    });
    expect(document.body.querySelector('.rounded-full.ring-2.ring-background')).toBeNull();
  });
});

// story #3791(페드루 재검토 12:23Z) — chat-bubble.tsx가 표시-폴백 문구(displayName=
// "당신"/"팀" 등)를 name으로, 원시 sender_name을 rawName으로 갈라 넘긴다. rawName이
// 빈 문자열(이름 없는 발신자)이면 Avatar가 그 표시 문구의 첫 글자를 가짜 이니셜로
// 짓지 않고 아이콘 tier로 떨어져야 한다 — 되돌리면(Avatar에 rawName 대신 name을 그대로
// 넘기면) RED.
describe('SenderProfilePopover — story #3791(rawName/name 분리)', () => {
  it('rawName=""(이름 없는 발신자)이면 아이콘 tier로 떨어지고 표시 문구(name) 첫 글자를 지어내지 않는다', async () => {
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="팀" rawName="" isAgent={false} onClose={NOOP} />));
    });
    expect(document.body.querySelector('img')).toBeNull();
    // 이니셜 tier였다면 initials('팀')="팀"이 렌더됐을 것 — 아이콘 tier이므로 그 텍스트가 없다.
    const initialsSpan = document.body.querySelector('span[aria-label="팀"]');
    expect(initialsSpan?.textContent).toBe('');
  });
});

// story #3000 로드맵 PR-B(L1) — floating 팝업은 --elev-overlay 토큰이어야 한다(shadow-md
// 리터럴 회귀가드).
describe('SenderProfilePopover — 로드맵 PR-B L1(floating elev-overlay)', () => {
  it('팝오버 컨테이너가 shadow-[var(--elev-overlay)]를 쓰고 shadow-md는 안 쓴다', async () => {
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="오르테가" isAgent onClose={NOOP} />));
    });
    const popover = document.body.querySelector('[role="dialog"]');
    expect(popover?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(popover?.className).not.toContain('shadow-md');
  });
});

// story 4831 — 클릭한 점 위치: 팝오버 부품(PopoverContent)에 가상 기준(anchor)을 통과시켜 점에 붙인다.
describe('SenderProfilePopover — story 4831(바탕 Popover 위로 · 클릭한 점 기준)', () => {
  it('pointAnchor는 클릭한 점의 크기 0 사각형을 낸다', () => {
    expect(pointAnchor(12, 34).getBoundingClientRect()).toEqual({ x: 12, y: 34, width: 0, height: 0, top: 34, left: 12, right: 12, bottom: 34 });
  });

  it('위치 요소가 클릭한 점(x, y)으로 놓인다(기준이 부품을 통과한다)', async () => {
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={123} y={45} name="민" isAgent={false} onClose={NOOP} onBlock={NOOP} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const positioner = document.body.querySelector('[data-slot="popover-content"]')!.parentElement!;
    expect(positioner.getAttribute('style') ?? '').toContain('translate(123px, 45px)');
  });

  it('x만 · y만 바뀌어도 새 점으로 옮겨 놓인다', async () => {
    const render = (x: number, y: number) => root.render(wrap(<SenderProfilePopover x={x} y={y} name="민" isAgent={false} onClose={NOOP} />));
    const styleNow = async () => {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      return document.body.querySelector('[data-slot="popover-content"]')!.parentElement!.getAttribute('style') ?? '';
    };
    await act(async () => { render(10, 20); });
    expect(await styleNow()).toContain('translate(10px, 20px)');
    await act(async () => { render(300, 20); }); // x만
    expect(await styleNow()).toContain('translate(300px, 20px)');
    await act(async () => { render(300, 200); }); // y만
    expect(await styleNow()).toContain('translate(300px, 200px)');
  });

  it('팝업은 role=dialog이고 접근 이름이 이름(name)이다', async () => {
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="오르테가" isAgent onClose={NOOP} />));
    });
    const popup = document.body.querySelector('[data-slot="popover-content"]')!;
    expect(popup.getAttribute('role')).toBe('dialog');
    expect(popup.getAttribute('aria-label')).toBe('오르테가');
  });

  // 눈에 보이는 변화: 손으로 지은 팝업은 열 때 초점을 옮기지 않았다. Base UI는 열면 초점을 팝업 안으로 옮긴다(키보드로 «사용자 차단»에 닿는다).
  it('열면 초점이 팝업 안으로 들어온다', async () => {
    await act(async () => {
      root.render(wrap(<SenderProfilePopover x={0} y={0} name="민" isAgent={false} onClose={NOOP} onBlock={NOOP} />));
    });
    const popup = document.body.querySelector('[data-slot="popover-content"]')!;
    // 초점 이동은 열린 뒤 비동기로 일어난다 — 조건이 참이 될 때까지 기다린다(고정 횟수의 microtask는 부하에 따라 모자라 흔들렸다)
    for (let i = 0; i < 40 && !popup.contains(document.activeElement); i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    }
    expect(popup.contains(document.activeElement)).toBe(true);
  });
});
