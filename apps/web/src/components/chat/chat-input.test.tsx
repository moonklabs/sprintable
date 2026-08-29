// @vitest-environment jsdom
//
// story #2032 — 채팅 입력 연속성(자동 포커스·대화별 임시저장·ESC 뒤로가기) 회귀가드.
// 순수 헬퍼(멘션/엔티티 파싱)는 기존 chat-input.test.ts가 이미 덮는다 — 이 파일은 그 위에
// 새로 얹은 상호작용(effect·localStorage·keydown 우선순위)을 실 렌더로 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function stubMatchMedia(coarse: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: coarse } as MediaQueryList));
}

// story #2059(kanban-board.test.tsx)와 동일 패턴 — jsdom/Node의 네이티브 localStorage가
// 이 실행 환경에서 온전치 않아(--localstorage-file 미설정 시 .clear() 등이 없는 스텁으로
// 대체됨) Map 기반 페이크로 통째로 교체한다.
let store: Map<string, string>;
function stubLocalStorage() {
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubLocalStorage();
  stubMatchMedia(false); // 기본은 데스크톱(포인터 정밀) — AC1 대상
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function textarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

describe('ChatInput — 진입 시 자동 포커스(story #2032 AC1)', () => {
  it('데스크톱(pointer:fine)이면 마운트 직후 textarea에 포커스가 잡힌다', async () => {
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    expect(document.activeElement).toBe(textarea());
  });

  it('터치 기기(pointer:coarse)면 자동 포커스하지 않는다(소프트 키보드가 화면을 덮는 것 방지)', async () => {
    stubMatchMedia(true);
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    expect(document.activeElement).not.toBe(textarea());
  });
});

describe('ChatInput — 대화별 임시저장(story #2032 AC2/AC3/AC6)', () => {
  it('마운트 시 그 대화의 저장된 초안을 복원한다(AC2)', async () => {
    window.localStorage.setItem('sprintable:chat-draft:c1', '쓰던 내용');
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    expect(textarea().value).toBe('쓰던 내용');
  });

  it('타이핑하면 그 대화 슬롯에 자동저장된다(AC2)', async () => {
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    await act(async () => {
      const el = textarea();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(el, '작성 중');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(window.localStorage.getItem('sprintable:chat-draft:c1')).toBe('작성 중');
  });

  it('대화별로 분리된다 — A 대화 초안이 B 대화에 나타나지 않는다(AC3)', async () => {
    window.localStorage.setItem('sprintable:chat-draft:conv-A', 'A 대화 초안');
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="conv-B" onSend={vi.fn()} />));
    });
    expect(textarea().value).toBe(''); // B에는 A의 초안이 안 보임
    expect(window.localStorage.getItem('sprintable:chat-draft:conv-A')).toBe('A 대화 초안'); // A 것은 그대로 보존
  });

  it('메시지를 전송하면 그 대화의 임시저장이 비워진다(AC6)', async () => {
    window.localStorage.setItem('sprintable:chat-draft:c1', '보낼 내용');
    const onSend = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={onSend} />));
    });
    const sendButton = Array.from(container.querySelectorAll('button')).find((b) => b.querySelector('svg') && !b.hasAttribute('aria-haspopup'));
    await act(async () => {
      sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith('보낼 내용', undefined, undefined);
    expect(window.localStorage.getItem('sprintable:chat-draft:c1')).toBeNull();
  });
});

describe('ChatInput — ESC 우선순위(story #2032 AC4/AC5)', () => {
  it('아무 오버레이도 안 열려 있으면 ESC가 onEscape를 부른다(AC4)', async () => {
    const onEscape = vi.fn();
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} onEscape={onEscape} />));
    });
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('멘션 후보가 열려 있으면 ESC는 그 후보를 먼저 닫고 onEscape는 안 부른다(AC5)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'm1', name: '오르테가' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const onEscape = vi.fn();
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} onEscape={onEscape} />));
    });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, '@오');
      el.selectionStart = 2;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 멘션 fetch가 resolve될 시간을 준다.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[role="listbox"]')).not.toBeNull(); // 후보가 실제로 떠 있음(전제 확認)

    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onEscape).not.toHaveBeenCalled(); // 후보 우선 — 대화 밖으로 안 나감
  });
});

describe('ChatInput — `#` 엔티티 피커 종류별 그룹화(story #2263 ㉠㉡㉢)', () => {
  it('뒤섞인 종류 응답이 실 렌더에서 종류별 머리글로 묶여 나온다(모르는 종류도 정상 렌더)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/entities/search')) {
        return new Response(JSON.stringify({
          // 일부러 인터리빙(doc·story·doc·sprint) — 그룹핑이 실제로 재배열해야만
          // "문서 둘"이 "스토리 하나"보다 앞으로 옮겨진다(그룹핑 없으면 원본 순서 그대로라
          // "스토리 하나"가 "문서 둘"보다 앞에 남아 이 assertion이 그 결여를 잡아낸다).
          data: [
            { entity_type: 'doc', entity_id: 'd1', title: '문서 하나', status: null },
            { entity_type: 'story', entity_id: 's1', title: '스토리 하나', status: 'in-progress' },
            { entity_type: 'doc', entity_id: 'd2', title: '문서 둘', status: null },
            { entity_type: 'sprint', entity_id: 'sp1', title: '스프린트 하나', status: null },
          ],
        }));
      }
      return new Response(JSON.stringify({ data: [] }));
    }));

    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" projectId="p1" onSend={vi.fn()} />));
    });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, '#');
      el.selectionStart = 1;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 엔티티 검색은 200ms 디바운스 뒤 fetch — 실 타이머로 흘려보낸다.
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });

    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const text = listbox!.textContent ?? '';
    // ㉡: 인터리빙된 응답이 doc 그룹으로 다시 묶인다 — 그룹핑이 없다면 "문서 둘"은
    // 원본 순서상 "스토리 하나" 뒤에 그대로 남아 이 assertion이 실패한다(mutation-verified).
    expect(text.indexOf('문서 둘')).toBeLessThan(text.indexOf('스토리 하나'));
    expect(text.indexOf('문서 하나')).toBeLessThan(text.indexOf('문서 둘'));
    // ㉠: 종류 라벨이 글자로 보인다.
    expect(text).toContain('문서');
    expect(text).toContain('스토리');
    // ㉢: 모르는 종류(sprint)도 빈 값·물음표 없이 원문 그대로 정상 렌더된다.
    expect(text).toContain('sprint');
    expect(text).toContain('스프린트 하나');
  });

  // story #2522 — EmbedCard와 같은 클래스의 같은 gap(close-the-class, PO 지시 2026-08-08):
  // `#` 피커도 entity.status 원시값을 그대로 노출하고 있었다.
  it('후보 status가 번역된 말로 뜬다(원시값 in-review 노출 금지)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/entities/search')) {
        return new Response(JSON.stringify({
          data: [{ entity_type: 'story', entity_id: 's1', title: '스토리 하나', status: 'in-review' }],
        }));
      }
      return new Response(JSON.stringify({ data: [] }));
    }));

    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" projectId="p1" onSend={vi.fn()} />));
    });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, '#');
      el.selectionStart = 1;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });

    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox!.textContent).toContain('검토 중');
    expect(listbox!.textContent).not.toContain('in-review');
  });
});

// story #2942(2921-S5, doc steer-event-axis-design-2927 §2/§4) — composer STEER 모드.
// 본문(@/#) in-text 트리거와 완전히 분리된 별도 send path라 그쪽 기존 44개 테스트는
// 무회귀(위 describe 블록들 그대로) — 이 블록은 STEER 전용 표면만 잰다.
describe('ChatInput — STEER 모드(story #2942)', () => {
  const PARTICIPANTS = [
    { member_id: 'me', name: '나' },
    { member_id: 'u1', name: '동료1' },
  ];

  function toggleBtn(): HTMLButtonElement | null {
    return [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '방향 전환(STEER)') as HTMLButtonElement | undefined ?? null;
  }

  function setValue(el: HTMLTextAreaElement | HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  }

  it('참가자가 본인 1명뿐이면(대상 0명) STEER 토글 자체가 안 보인다', async () => {
    await act(async () => {
      root.render(withIntl(
        <ChatInput threadId="c1" onSend={vi.fn()} currentTeamMemberId="me" participants={[{ member_id: 'me', name: '나' }]} />,
      ));
    });
    expect(toggleBtn()).toBeNull();
  });

  it('대상이 있으면 토글이 보이고, 클릭하면 STEER 패널이 열려 textarea placeholder가 바뀐다', async () => {
    await act(async () => {
      root.render(withIntl(
        <ChatInput threadId="c1" onSend={vi.fn()} currentTeamMemberId="me" participants={PARTICIPANTS} />,
      ));
    });
    expect(toggleBtn()).not.toBeNull();
    await act(async () => { toggleBtn()!.click(); });
    expect(container.textContent).toContain('방향 전환 지시');
    expect(textarea().placeholder).toBe('지시 내용을 입력하세요');
    // 본인(me)은 대상 select에 없다 — 본인에게 STEER를 보내는 건 무의미.
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.textContent).not.toContain('나');
    expect(select.textContent).toContain('동료1');
  });

  it('대상·작업·지시 셋 다 없으면 전송 버튼이 비활성 — 셋 다 채워야 활성화된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/entities/search')) {
        return new Response(JSON.stringify({ data: [{ entity_type: 'story', entity_id: 's1', title: '대상 스토리', status: 'in-progress' }] }));
      }
      return new Response(JSON.stringify({ data: [] }));
    }));
    await act(async () => {
      root.render(withIntl(
        <ChatInput threadId="c1" onSend={vi.fn()} currentTeamMemberId="me" participants={PARTICIPANTS} projectId="p1" />,
      ));
    });
    await act(async () => { toggleBtn()!.click(); });
    const sendBtn = [...container.querySelectorAll('button')].find((b) => b.querySelector('svg.lucide-send')) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);

    // 지시 텍스트만 채움 — 여전히 비활성(대상·작업 미선택).
    await act(async () => { setValue(textarea(), '이제 A로 가자'); });
    expect(sendBtn.disabled).toBe(true);

    // 대상 선택.
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => { setValue(select, 'u1'); });
    expect(sendBtn.disabled).toBe(true); // 작업 아직 미선택.

    // 작업 검색 → 후보 클릭.
    const workItemInput = container.querySelectorAll('input[type="text"]')[0] as HTMLInputElement;
    await act(async () => { setValue(workItemInput, '대상'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
    const candidate = [...container.querySelectorAll('[role="listbox"] button')].find((b) => b.textContent?.includes('대상 스토리')) as HTMLButtonElement;
    expect(candidate, '작업 후보를 못 찾음').toBeDefined();
    await act(async () => { candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });

    expect(sendBtn.disabled).toBe(false); // 셋 다 채워짐.
  });

  it('전송 성공 — POST /api/events/publish를 정확한 body로 호출하고, 성공 後 STEER 패널이 닫힌다', async () => {
    let publishBody: unknown = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('/api/entities/search')) {
        return new Response(JSON.stringify({ data: [{ entity_type: 'story', entity_id: 's1', title: '대상 스토리', status: 'in-progress' }] }));
      }
      if (url === '/api/events/publish' && init?.method === 'POST') {
        publishBody = JSON.parse(init.body ?? '{}');
        return new Response(JSON.stringify({ data: { conversation_id: 'c1', message_id: 'm1' } }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: [] }));
    }));
    await act(async () => {
      root.render(withIntl(
        <ChatInput threadId="c1" onSend={vi.fn()} currentTeamMemberId="me" participants={PARTICIPANTS} projectId="p1" />,
      ));
    });
    await act(async () => { toggleBtn()!.click(); });
    await act(async () => { setValue(textarea(), '이제 A로 가자'); });
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => { setValue(select, 'u1'); });
    const workItemInput = container.querySelectorAll('input[type="text"]')[0] as HTMLInputElement;
    await act(async () => { setValue(workItemInput, '대상'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
    const candidate = [...container.querySelectorAll('[role="listbox"] button')][0] as HTMLButtonElement;
    await act(async () => { candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });

    const sendBtn = [...container.querySelectorAll('button')].find((b) => b.querySelector('svg.lucide-send')) as HTMLButtonElement;
    await act(async () => { sendBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(publishBody).toEqual({
      definition_key: 'preset.steer.instruct',
      conversation_id: 'c1',
      payload: {
        work_item_type: 'story', work_item_id: 's1',
        target_member_id: 'u1', instruction: '이제 A로 가자',
      },
    });
    // 성공 後 패널이 닫힌다(steerMode=false) — placeholder가 원래대로 돌아온다.
    expect(container.textContent).not.toContain('방향 전환 지시');
  });

  it('422 conversation_target_mismatch — 명시 한국어 에러 카피가 뜨고 패널은 열린 채 유지된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.includes('/api/entities/search')) {
        return new Response(JSON.stringify({ data: [{ entity_type: 'story', entity_id: 's1', title: '대상 스토리', status: 'in-progress' }] }));
      }
      if (url === '/api/events/publish' && init?.method === 'POST') {
        return new Response(JSON.stringify({ detail: { code: 'conversation_target_mismatch', message: 'internal BE msg', errors: ['u1'] } }), { status: 422 });
      }
      return new Response(JSON.stringify({ data: [] }));
    }));
    await act(async () => {
      root.render(withIntl(
        <ChatInput threadId="c1" onSend={vi.fn()} currentTeamMemberId="me" participants={PARTICIPANTS} projectId="p1" />,
      ));
    });
    await act(async () => { toggleBtn()!.click(); });
    await act(async () => { setValue(textarea(), '이제 A로 가자'); });
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => { setValue(select, 'u1'); });
    const workItemInput = container.querySelectorAll('input[type="text"]')[0] as HTMLInputElement;
    await act(async () => { setValue(workItemInput, '대상'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
    const candidate = [...container.querySelectorAll('[role="listbox"] button')][0] as HTMLButtonElement;
    await act(async () => { candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });

    const sendBtn = [...container.querySelectorAll('button')].find((b) => b.querySelector('svg.lucide-send')) as HTMLButtonElement;
    await act(async () => { sendBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // BE 원문 메시지가 아니라 doc §4가 요구하는 명시 카피로 교체돼야 한다.
    expect(container.textContent).not.toContain('internal BE msg');
    expect(container.textContent).toContain('이 스레드에 없는 사람에게는 여기서 방향 전환 지시를 보낼 수 없습니다');
    // 패널은 열린 채 유지(재시도 가능 — 대상 재선택 등).
    expect(container.textContent).toContain('방향 전환 지시');
  });

  // story #3203(카디르 QA 블로킹·2026-08-29) — BE가 orphan participant.name을 이제 null로
  // 실어보낸다(예전엔 uuid 앞 8자였으나 그마저 없어짐). 대상 select가 `p.name ?? p.member_id`
  // 폴백을 쓰고 있어 36자 uuid 전체가 옵션 텍스트로 그대로 새는 회귀였다 — 이 PR의 BE 변경이
  // 처음 깨운 것이라 pin 필수.
  it('대상 참가자의 name이 null이면(BE orphan 폴백) "알 수 없는 멤버"로 뜬다 — uuid 전체 노출 금지', async () => {
    const orphanId = '767988e5-df5b-48e8-9964-7062fe84d691';
    await act(async () => {
      root.render(withIntl(
        <ChatInput
          threadId="c1"
          onSend={vi.fn()}
          currentTeamMemberId="me"
          participants={[{ member_id: 'me', name: '나' }, { member_id: orphanId, name: null }]}
        />,
      ));
    });
    await act(async () => { toggleBtn()!.click(); });
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.textContent).toContain('알 수 없는 멤버');
    expect(select.textContent).not.toContain(orphanId);
  });
});

// story #3000 로드맵 PR-B(L1) — floating 드롭다운(멘션 등)은 --elev-overlay 토큰이어야 한다
// (shadow-md 리터럴 회귀가드).
describe('ChatInput — 로드맵 PR-B L1(floating elev-overlay)', () => {
  it('멘션 후보 드롭다운이 shadow-[var(--elev-overlay)]를 쓰고 shadow-md는 안 쓴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'm1', name: '오르테가' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, '@오');
      el.selectionStart = 2;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(listbox?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(listbox?.className).not.toContain('shadow-md');
  });
});

// story #92f00dc4(Chat ②층 FE, doc exec-command-final-spec-92f00dc4 §①) — 서버 집행
// 카탈로그(done/assign/priority) 자동완성 회귀가드.
describe('ChatInput — 서버 집행 커맨드 자동완성(story #92f00dc4 §①)', () => {
  it('"/" 입력 시 done/assign/priority가 인자 힌트와 함께 뜬다', async () => {
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, '/');
      el.selectionStart = 1;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const listbox = container.querySelector('[role="listbox"][aria-label="커맨드 후보"]');
    expect(listbox).not.toBeNull();
    const text = listbox!.textContent ?? '';
    expect(text).toContain('/done');
    expect(text).toContain('/assign');
    expect(text).toContain('/priority');
    expect(text).toContain('‹스토리#›'); // done 인자 힌트
    expect(text).toContain('‹스토리#› ‹멤버명›'); // assign 인자 힌트
    // 회귀가드 — commandArgHintPriority는 `<critical|high|medium|low>`처럼 `<...>`를 쓰면
    // next-intl이 rich-text 태그 문법으로 오인해 파싱 실패, 화면에 "chats.commandArgHintPriority"
    // 원시 키가 그대로 새는 실사고가 있었다(스크린샷 검증으로 발견). guillemet(‹›)로 우회.
    expect(text).not.toContain('chats.commandArgHintPriority');
    expect(text).toContain('critical|high|medium|low');
  });

  it('/do 접두로 좁히면 done만 남는다(prefix 필터 회귀 없음)', async () => {
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, '/do');
      el.selectionStart = 3;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const listbox = container.querySelector('[role="listbox"][aria-label="커맨드 후보"]');
    const text = listbox!.textContent ?? '';
    expect(text).toContain('/done');
    expect(text).not.toContain('/assign');
    expect(text).not.toContain('/priority');
  });

  it('done 후보 클릭 시 입력창이 "/done "으로 채워진다(기존 selectCommand 경로 재사용 확認)', async () => {
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, '/');
      el.selectionStart = 1;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = [...container.querySelectorAll('[role="listbox"][aria-label="커맨드 후보"] button')]
      .find((b) => b.textContent?.includes('/done')) as HTMLButtonElement;
    expect(button).toBeTruthy();
    await act(async () => { button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(el.value).toBe('/done ');
  });
});

// story #92f00dc4(doc §🎯 모호 후보 클릭) — 결과 카드의 후보 클릭이 입력창을 채우는 배선
// (chat-view.tsx handleFillComposer → ChatInput의 prefillCommand prop).
describe('ChatInput — prefillCommand(story #92f00dc4 §🎯 모호 후보 클릭 배선)', () => {
  it('prefillCommand가 오면 입력창이 그 텍스트로 교체+포커스된다(즉시 전송 아님)', async () => {
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} prefillCommand={{ text: '/assign #2947 채영1', nonce: 1 }} />));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); // requestAnimationFrame 흘려보냄
    expect(textarea().value).toBe('/assign #2947 채영1');
    expect(document.activeElement).toBe(textarea());
  });

  it('같은 nonce가 재전달되면(리렌더) 중복 적용하지 않는다 — 사용자가 그 사이 지운 텍스트를 되살리지 않음', async () => {
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} prefillCommand={{ text: '/done #1', nonce: 1 }} />));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, ''); // 사용자가 지움
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 같은 nonce=1로 리렌더(부모가 다른 이유로 재렌더된 상황 재현) — effect가 재적용하면 안 됨.
    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} prefillCommand={{ text: '/done #1', nonce: 1 }} />));
    });
    expect(textarea().value).toBe('');
  });
});
