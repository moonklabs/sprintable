// @vitest-environment jsdom
//
// story #3986(클래스 «거짓 성공 표시») — 웹 경로 설정 복사(.mcp.json, handleCopy)가
// 클립보드 실패를 삼키고도 「복사됨」을 띄우던 결함의 처방 pin. 새 sibling
// 파일로 분리(connect-step.test.tsx·connect-step.desktop-handoff.test.tsx 무수정
// 관례 그대로).
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  global.fetch = makeFetch() as unknown as typeof fetch;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <ConnectStep agentId="a1" apiKey="sk_live_1234" projectId="p1" onFinish={() => {}} />
      </NextIntlClientProvider>,
    );
    await vi.advanceTimersByTimeAsync(100);
  });
}

describe('ConnectStep — 웹 설정 복사(.mcp.json) 실패 처리(story #3986)', () => {
  it('⭐클립보드 성공이면 「복사됨」이 뜬다(스텁으로 성공 재현)', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await mount();
    const copyBtn = container.querySelector('[aria-label="복사"]') as HTMLButtonElement;
    await act(async () => { copyBtn.click(); });
    expect(copyBtn.textContent).toContain(ko.onboarding.copied);
    expect(container.querySelector('[data-testid="connect-step-copy-failed-raw-config"]')).toBeNull();
  });

  it('⭐클립보드 실패면(권한 거부) 「복사됨」이 안 뜨고, 실패 문구+선택 가능한 실 config가 뜬다', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) } });
    await mount();
    const copyBtn = container.querySelector('[aria-label="복사"]') as HTMLButtonElement;
    await act(async () => { copyBtn.click(); });
    expect(copyBtn.textContent).not.toContain(ko.onboarding.copied);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(ko.common.copyFailedSelectManually);
    const rawConfig = container.querySelector('[data-testid="connect-step-copy-failed-raw-config"]') as HTMLTextAreaElement;
    expect(rawConfig).not.toBeNull();
    expect(rawConfig.readOnly).toBe(true);
    // 실 config엔 마스킹 안 된 진짜 키가 실려야 데스크톱 앱에 붙여 넣을 수 있다.
    expect(rawConfig.value).toContain('sk_live_1234');
    expect(rawConfig.value).not.toContain('••••');
  });

  it('jsdom Clipboard API 부재(execCommand도 실패) — 스텁 없이도 「복사됨」이 안 뜬다(무조건 성공이던 옛 결함 회귀 방지)', async () => {
    await mount();
    const copyBtn = container.querySelector('[aria-label="복사"]') as HTMLButtonElement;
    await act(async () => { copyBtn.click(); });
    expect(copyBtn.textContent).not.toContain(ko.onboarding.copied);
  });

  // story #3986 CHANGES(페드루 PO C4) — copyFailed/copyFailedRawConfig가 transport
  // 바뀌어도 안 지워지면, 옛 transport의 raw config(실 키 포함)가 새 transport
  // 화면에 그대로 남아 엉뚱한 설정을 붙여넣게 된다.
  // story #3986 CHANGES(페드루 PO 2회차) — copyVerifyPromptFailed가 3초 뒤 자동으로
  // 꺼지면(원래 처방) 손으로 고를 시간이 있기도 전에 원문 칸까지 통째로 사라진다.
  it('⭐검증 예시 프롬프트 복사 실패 — 3초가 지나도 원문 칸이 남아 있다', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) } });
    await mount();

    // showVerifyExamplePrompt = transport==='http' && !verified — 기본 mock 콘텐츠는
    // stdio로 추론되므로 http 탭으로 전환해야 이 블록이 뜬다.
    const hostedTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(ko.onboarding.transportHosted)) as HTMLButtonElement;
    await act(async () => { hostedTab.click(); await vi.advanceTimersByTimeAsync(100); });

    const copyBtn = container.querySelector('[data-testid="connect-step-verify-prompt-copy"]') as HTMLButtonElement;
    expect(copyBtn).toBeTruthy();
    await act(async () => { copyBtn.click(); await vi.advanceTimersByTimeAsync(0); });

    expect(container.querySelector('[data-testid="connect-step-verify-prompt-raw"]')).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });

    const raw = container.querySelector('[data-testid="connect-step-verify-prompt-raw"]') as HTMLInputElement | null;
    expect(raw).not.toBeNull();
    expect(raw!.value).toBe(ko.onboarding.verifyExamplePrompt);
  });

  it('⭐복사 실패 뒤 transport를 바꾸면 이전 raw config 노출이 사라진다', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) } });
    await mount();
    const copyBtn = container.querySelector('[aria-label="복사"]') as HTMLButtonElement;
    await act(async () => { copyBtn.click(); });
    expect(container.querySelector('[data-testid="connect-step-copy-failed-raw-config"]')).not.toBeNull();

    const hostedTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(ko.onboarding.transportHosted)) as HTMLButtonElement;
    expect(hostedTab.disabled).toBe(false);
    await act(async () => { hostedTab.click(); });

    expect(container.querySelector('[data-testid="connect-step-copy-failed-raw-config"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
