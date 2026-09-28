// @vitest-environment jsdom
//
// story #3983(PO 확定 2026-09-17 01:41Z) — connect 단계 끝을 두 길로: 주 =
// 「데스크톱 앱에서 이어서」(기존 DesktopDownloadCard 그대로) · 보조 = 현행
// 웹 connect(키·config·첫 지시) 삭제 0. 새 sibling 파일로 분리해 기존
// connect-step.test.tsx는 무수정(onboarding-form.*.test.ts 관례 그대로).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ConnectStep } from './connect-step';
import ko from '../../../messages/ko.json';

const createFirstInstructionConversationMock = vi.fn();
vi.mock('@/lib/onboarding/first-instruction', () => ({
  createFirstInstructionConversation: (...args: unknown[]) => createFirstInstructionConversationMock(...args),
}));

function makeFetch() {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes('connection-artifact')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            files: [{
              filename: '.mcp.json',
              content: JSON.stringify({ mcpServers: { 'sprintable-mcp': { type: 'stdio', command: 'uvx', args: ['sprintable-mcp'], env: { AGENT_API_KEY: '<YOUR_AGENT_API_KEY>' } } } }),
            }],
            mcp_config: null,
            api_key: null,
          },
        }),
      };
    }
    if (url.includes('verification-status')) {
      return { ok: true, json: async () => ({ data: { verified: false, rail: [{ state: 'config_copied', status: 'active' }] } }) };
    }
    // DesktopDownloadCard의 /desktop/updates/macos.json 포함 — 그 컴포넌트 자체가
    // 이 404를 "지금은 받을 수 없어요"로 정직하게 처리한다(카드 자체 회귀는
    // desktop-download-card.test.tsx 전담, 여기선 마운트만 무사히 되는지만 본다).
    return { ok: false, json: async () => ({}) };
  });
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // story #3986 — jsdom엔 Clipboard API가 없어(copyTextSafely가 execCommand
  // 폴백으로 떨어지고, jsdom의 execCommand는 항상 false라 "실패"가 정직하게
  // 재현된다) 성공 경로를 재려면 명시 스텁이 필요하다.
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(onFinish = vi.fn(), todayV3Enabled = false) {
  const fetchMock = makeFetch();
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <ConnectStep agentId="a1" apiKey="sk_live_1234" projectId="p1" onFinish={onFinish} todayV3Enabled={todayV3Enabled} />
      </NextIntlClientProvider>,
    );
    await vi.advanceTimersByTimeAsync(100);
  });
  return { onFinish, fetchMock };
}

describe('ConnectStep — 주 경로(story #3983 AC1·AC2)', () => {
  it('⭐데스크톱 카드가 첫 화면에 뜬다(기존 DesktopDownloadCard 그대로)', async () => {
    await mount();
    expect(container.querySelector('[data-testid="connect-step-desktop-primary"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="desktop-download-card"]')).not.toBeNull();
  });

  it('⭐주 경로 완료 버튼을 누르면 onFinish가 불린다', async () => {
    const { onFinish } = await mount();
    const btn = container.querySelector('[data-testid="connect-step-desktop-finish"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  // 페드루 PO CHANGES(2026-09-17 02:11Z) ③ — 카드 자체 제목("데스크톱 앱")과
  // 부딪히는 절 제목을 없앴다(부제만 남는다).
  it('⭐절 제목이 카드 자체 제목과 중복되지 않는다(절 전용 제목 자체가 없다)', async () => {
    await mount();
    const primary = container.querySelector('[data-testid="connect-step-desktop-primary"]');
    expect(primary?.textContent).toContain(ko.onboarding.desktopHandoffSubtitle);
  });

  // CHANGES ② — 낱말은 실제 착지와 같아야 한다.
  it('⭐todayV3Enabled=true면 완료 버튼이 「오늘」 낱말(도착지 착지)', async () => {
    await mount(vi.fn(), true);
    const btn = container.querySelector('[data-testid="connect-step-desktop-finish"]');
    expect(btn?.textContent).toBe(ko.onboarding.desktopFinishToToday);
  });

  it('todayV3Enabled=false(기본)면 완료 버튼이 현행 dashboardCta 낱말', async () => {
    await mount(vi.fn(), false);
    const btn = container.querySelector('[data-testid="connect-step-desktop-finish"]');
    expect(btn?.textContent).toBe(ko.onboarding.dashboardCta);
  });

  // CHANGES ④ — 데스크톱 경로 선택 자체가 측정돼야 웹/데스크톱 활성화 퍼널을
  // 가를 수 있다.
  it('⭐완료 버튼을 누르면 desktop_handoff_selected 이벤트가 emit된다(emitOnboardingEvent → POST /api/onboarding/events)', async () => {
    const { fetchMock } = await mount();
    const btn = container.querySelector('[data-testid="connect-step-desktop-finish"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/onboarding/events');
    const body = String(call?.[1]?.body ?? '');
    expect(body).toContain('desktop_handoff_selected');
    expect(call).toBeDefined();
  });
});

describe('ConnectStep — 데스크톱 절 키 복사 칸(story #3983 CHANGES①)', () => {
  it('⭐키가 마스킹돼 보이고, 복사 버튼을 누르면 「복사됨」으로 바뀐다', async () => {
    await mount();
    const keyBox = container.querySelector('[data-testid="connect-step-desktop-key-handoff"]')!.parentElement!;
    expect(keyBox.textContent).toContain('sk_live_••••1234');
    const copyBtn = container.querySelector('[data-testid="connect-step-desktop-key-copy"]') as HTMLButtonElement;
    await act(async () => { copyBtn.click(); });
    expect(copyBtn.textContent).toContain(ko.onboarding.copied);
  });

  // 페드루 PO CHANGES r2(2026-09-17 02:23Z, 1차 ④와 같은 목적) — config_copied는
  // 웹 경로 이벤트(verify rail 첫 상태)라 데스크톱 복사가 그걸 재사용하면
  // 데스크톱/웹 활성화 퍼널이 다시 섞인다 — 별도 이름으로 가른다.
  it('⭐데스크톱 키 복사는 desktop_key_copied만 emit하고 config_copied는 안 낸다', async () => {
    const { fetchMock } = await mount();
    const copyBtn = container.querySelector('[data-testid="connect-step-desktop-key-copy"]') as HTMLButtonElement;
    await act(async () => { copyBtn.click(); });
    const bodies = fetchMock.mock.calls
      .filter((c) => c[0] === '/api/onboarding/events')
      .map((c) => String(c[1]?.body ?? ''));
    expect(bodies.some((b) => b.includes('desktop_key_copied'))).toBe(true);
    expect(bodies.some((b) => b.includes('"event":"config_copied"'))).toBe(false);
  });

  // story #3986(클래스 «거짓 성공 표시») — 클립보드 실패를 삼키고도 「복사됨」을
  // 띄우던 결함의 처방 pin. 실패하면 「복사됨」이 안 뜨고, 마스킹판 대신 실 키가
  // 선택 가능한 입력으로 바뀐다(유나 지시 — 별도 "선택 가능" 안내 줄은 안 만든다,
  // 실패 문구 자체가 지시).
  it('⭐클립보드 복사가 실패하면(권한 거부 등) 「복사됨」이 안 뜨고, 실패 문구+선택 가능한 실 키가 뜬다', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) } });
    await mount();
    const copyBtn = container.querySelector('[data-testid="connect-step-desktop-key-copy"]') as HTMLButtonElement;
    await act(async () => { copyBtn.click(); });
    expect(copyBtn.textContent).not.toContain(ko.onboarding.copied);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(ko.common.copyFailedSelectManually);
    const rawKeyInput = container.querySelector('[data-testid="connect-step-desktop-key-raw"]') as HTMLInputElement;
    expect(rawKeyInput).not.toBeNull();
    expect(rawKeyInput.value).toBe('sk_live_1234');
    expect(rawKeyInput.readOnly).toBe(true);
  });
});

describe('ConnectStep — 보조 경로 삭제 0(story #3983 AC1)', () => {
  it('⭐기존 웹 connect 흐름(transport 토글·아티팩트 카드·검증 레일·첫 지시 CTA)이 그대로 다 있다', async () => {
    await mount();
    expect(container.querySelector('[data-testid="connect-step-web-secondary-label"]')).not.toBeNull();
    // 기존 흐름 요소들 — 자리(무삭제)만 확認, 각자 행동은 기존 connect-step.test.tsx가 전담.
    expect(container.textContent).toContain(ko.onboarding.transportHosted);
    expect(container.textContent).toContain(ko.onboarding.firstInstructionCta);
    expect(container.textContent).toContain(ko.onboarding.verifyTitle);
  });
});

describe('ConnectStep — 키 핸드오프 문구 한 쌍(story #3983 AC4)', () => {
  it('⭐키 화면에 「이 키를 데스크톱 앱에 붙여 넣어요」+정본 캐논 문구가 같이 뜬다', async () => {
    await mount();
    const note = container.querySelector('[data-testid="connect-step-desktop-key-handoff"]');
    expect(note?.textContent).toContain('이 키를 데스크톱 앱에 붙여 넣어요');
    expect(note?.textContent).toContain('새 키는 웹에서 발급해요. 저장한 키는 다시 볼 수 없어요.');
  });
});
