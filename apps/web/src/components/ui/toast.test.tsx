// @vitest-environment jsdom
//
// story #2096 — 토스트가 role·aria-live 없이 렌더돼 스크린리더가 아예 안 읽었다(까심군이
// #2384 검수 때 토스트를 자동으로 못 잡아 스크린샷으로만 확認한 원인). 토스트는 조작 결과를
// 알리는 유일한 수단인 경우가 많아(담당자 지정 성공 등) 접근성 결함이 곧 기능 결함이다.
//
// AC4 — data-testid로 우회하지 않는다: 여기서 쓰는 셀렉터는 [role="alert"]/[role="status"]
// 자체다. 접근성 속성이 곧 셀렉터라는 것을 테스트 스스로 증명한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, Component } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ToastContainer, ToastProvider, useToast, type ToastItem } from './toast';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function toast(overrides: Partial<ToastItem>): ToastItem {
  return { id: 't1', title: '제목', ...overrides };
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

describe('Toast 접근성 (story #2096)', () => {
  // AC2 — success/info/warning은 흐름을 끊지 않는 polite, error만 즉시 끼어드는 assertive.
  it.each([
    ['success', 'status', 'polite'],
    ['info', 'status', 'polite'],
    ['warning', 'status', 'polite'],
    [undefined, 'status', 'polite'],
    ['error', 'alert', 'assertive'],
  ] as const)('type=%s → role=%s, aria-live=%s', async (type, expectedRole, expectedLive) => {
    await act(async () => {
      root.render(wrap(
        <ToastContainer toasts={[toast({ type })]} onDismiss={() => {}} />,
      ));
    });
    const el = container.querySelector(`[role="${expectedRole}"]`);
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-live')).toBe(expectedLive);
    expect(el?.getAttribute('aria-atomic')).toBe('true');
  });

  it('error 토스트는 status가 아니라 alert로만 잡힌다(둘 다 걸리면 이중 낭독)', async () => {
    await act(async () => {
      root.render(wrap(<ToastContainer toasts={[toast({ type: 'error' })]} onDismiss={() => {}} />));
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('닫기 버튼에 접근 가능한 이름(aria-label)이 있다 — "✕" 문자만으론 스크린리더가 못 읽는다', async () => {
    await act(async () => {
      root.render(wrap(<ToastContainer toasts={[toast({})]} onDismiss={() => {}} />));
    });
    const dismissBtn = container.querySelector('button[aria-label]');
    expect(dismissBtn).not.toBeNull();
    expect(dismissBtn?.getAttribute('aria-label')).toBe(koMessages.common.close);
  });

  it('여러 토스트가 섞여도 각자 올바른 role로 각각 잡힌다', async () => {
    await act(async () => {
      root.render(wrap(
        <ToastContainer
          toasts={[toast({ id: 't1', type: 'success' }), toast({ id: 't2', type: 'error' })]}
          onDismiss={() => {}}
        />,
      ));
    });
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
    expect(container.querySelectorAll('[role="alert"]').length).toBe(1);
  });

  // 유나 지적(error-display 폴리시) — 공백 없는 초장문(토큰·URL 등)이 토스트 폭을 넘어
  // 넘쳐흘렀다. 텍스트 wrapper에 min-w-0(flex 아이템 기본 min-width:auto 트랩 해제)+
  // 텍스트 자체에 anywhere(어디서나 끊음)가 함께 있어야 실제로 줄바꿈된다.
  it('제목/본문 텍스트가 overflow-wrap:anywhere를 갖고, wrapper가 min-w-0이다(초장문 overflow 회귀가드)', async () => {
    await act(async () => {
      root.render(wrap(<ToastContainer toasts={[toast({ body: '본문' })]} onDismiss={() => {}} />));
    });
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBe(2);
    paragraphs.forEach((p) => expect(p.className).toContain('[overflow-wrap:anywhere]'));
    expect(container.querySelector('.min-w-0')).not.toBeNull();
  });

  // story #2969 §2 PR-4(doc proofline-system-layer-2969) — shadow-lg→--elev-overlay·
  // 나머지 3면 hairline을 proof-line-strong으로.
  it('토스트 컨테이너가 --elev-overlay 그림자와 proof-line-strong hairline을 갖는다', async () => {
    await act(async () => {
      root.render(wrap(<ToastContainer toasts={[toast({})]} onDismiss={() => {}} />));
    });
    const el = container.querySelector('[role="status"]');
    expect(el?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(el?.className).toContain('border-proof-line-strong');
    expect(el?.className).not.toContain('shadow-lg');
  });

  // story #3759 CHANGES(페드루 PO 지적, #4106) — 컬럼이 min-h-0 예산을 갖게 되면서 토스트
  // 스택이 넘치는 몫을 진다(overflow-hidden). 잘려야 하는 건 «가장 오래된» 토스트다. jsdom엔
  // 레이아웃 엔진이 없어 실제 클리핑(픽셀)은 못 재지만(로컬 puppeteer 실측은
  // bottom-dock.tsx 코드 주석 참고 — 375×667·패널 열림·토스트 5장에서 최신은 항상 스택
  // 자기 박스 안에 남고 오래된 것부터 그 박스 밖으로 밀려남을 실측 확認), «DOM 순서가
  // 실제로 새것-먼저인가»는 jsdom이 그대로 잴 수 있는 실제 값이다 — flex-col-reverse가
  // 그 DOM 순서를 «오래된 게 위·새것이 아래»라는 정상 시각 순서로 되돌리고, overflow가
  // 나면 DOM 뒤쪽(오래된 것들)부터 컨테이너 박스 밖으로 밀려 잘린다.
  it('DOM 자식 순서가 새것-먼저다(newest-first) — 되돌리면(toasts 그대로 매핑) 이 assertion이 실패한다', async () => {
    const items = [
      toast({ id: 'oldest', title: '오래된' }),
      toast({ id: 'middle', title: '중간' }),
      toast({ id: 'newest', title: '새것' }),
    ];
    await act(async () => {
      root.render(wrap(<ToastContainer toasts={items} onDismiss={() => {}} />));
    });
    const rendered = [...container.querySelectorAll('[role]')].map((el) => el.textContent);
    expect(rendered).toEqual([expect.stringContaining('새것'), expect.stringContaining('중간'), expect.stringContaining('오래된')]);
  });

  it('컨테이너 wrapper가 flex-col-reverse + min-h-0 + overflow-hidden이다(정상 시각 순서 유지 + 넘치면 자름)', async () => {
    await act(async () => {
      root.render(wrap(<ToastContainer toasts={[toast({ id: 't1' }), toast({ id: 't2' })]} onDismiss={() => {}} />));
    });
    const wrapperEl = container.querySelector('[role]')?.parentElement;
    expect(wrapperEl?.className).toContain('flex-col-reverse');
    expect(wrapperEl?.className).toContain('min-h-0');
    expect(wrapperEl?.className).toContain('overflow-hidden');
  });
});

// story #3759(페드루 PO 지적, #4106 재검토) — useToast()가 <ToastProvider> 밖에서 불려도
// 예전 판은 로컬 useState로 «조용히 성공»했다(fail-silent — addToast가 허공에 쌓이고
// 아무도 안 그린다, 에러 0). 지금은 그 폴백이 테스트 환경(NODE_ENV==='test', vitest
// 기본값)에서만 살고, 그 외(=프로덕션)엔 즉시 throw한다. 이 describe는 그 계약 셋을
// 직접 고정한다 — «가드(양성대조): Provider 없이 마운트한 컴포넌트가 non-test 환경
// 흉내에서 throw」 요구를 정확히 충족.
class ToastErrorBoundary extends Component<
  { children: React.ReactNode; onError: (msg: string) => void },
  { caught: boolean }
> {
  state = { caught: false };
  static getDerivedStateFromError() {
    return { caught: true };
  }
  componentDidCatch(err: unknown) {
    this.props.onError(err instanceof Error ? err.message : String(err));
  }
  render() {
    return this.state.caught ? null : this.props.children;
  }
}

function ProbeUseToast() {
  useToast();
  return <div data-testid="probe-ok" />;
}

describe('useToast() Provider 계약(story #3759)', () => {
  it('<ToastProvider> 안에서는 공유 Context를 그대로 반환한다(에러 0)', async () => {
    let caughtMsg: string | null = null;
    await act(async () => {
      root.render(wrap(
        <ToastProvider>
          <ToastErrorBoundary onError={(m) => { caughtMsg = m; }}>
            <ProbeUseToast />
          </ToastErrorBoundary>
        </ToastProvider>,
      ));
    });
    expect(caughtMsg).toBeNull();
    expect(container.querySelector('[data-testid="probe-ok"]')).not.toBeNull();
  });

  it('Provider 밖 + 테스트 환경(NODE_ENV=test, vitest 기본값)에서는 로컬 폴백으로 조용히 통과한다(에러 0 — 39곳 격리 단위테스트 계약)', async () => {
    expect(process.env.NODE_ENV).toBe('test'); // 전제 확認 — vitest 기본값
    let caughtMsg: string | null = null;
    await act(async () => {
      root.render(wrap(
        <ToastErrorBoundary onError={(m) => { caughtMsg = m; }}>
          <ProbeUseToast />
        </ToastErrorBoundary>,
      ));
    });
    expect(caughtMsg).toBeNull();
    expect(container.querySelector('[data-testid="probe-ok"]')).not.toBeNull();
  });

  it('Provider 밖 + non-test 환경(프로덕션 흉내)에서는 즉시 throw한다(fail-closed — 양성대조)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    let caughtMsg: string | null = null;
    // 렌더 에러는 콘솔에도 찍힌다 — 이 테스트의 의도된 소음이므로 일시적으로 죽여 로그를 깔끔히.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => {
        root.render(wrap(
          <ToastErrorBoundary onError={(m) => { caughtMsg = m; }}>
            <ProbeUseToast />
          </ToastErrorBoundary>,
        ));
      });
    } finally {
      consoleErrorSpy.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(caughtMsg).toBe('useToast must be used within <ToastProvider> (dashboard-shell.tsx)');
    expect(container.querySelector('[data-testid="probe-ok"]')).toBeNull();
  });
});
