// @vitest-environment jsdom
//
// story #3287([도메인탈고정·축1 Phase1] AC4 FE 소비) — useOrgDomainLabels가 GET
// /api/organizations/{orgId}/domain-labels(BFF, story #3705 P0 핫픽스로 전환) 응답을
// domain:canonical_slug 키로 인덱싱해 statusLabel()/entityTypeLabel()로 조회 가능케 하는지,
// 로케일 선택(ko 우선, 없으면 en 폴백)과 "오버라이드 미설정 slug는 undefined"(호출부가
// canonical 문구로 폴백)를 실 렌더로 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  invalidateOrgDomainLabels, ORG_DOMAIN_LABELS_FAILED_TTL_MS, ORG_DOMAIN_LABELS_TTL_MS, useOrgDomainLabels,
} from './use-org-domain-labels';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  invalidateOrgDomainLabels(); // story #4748 — 같은 파일 안 시험끼리 받아 둔 값을 물려주지 않는다
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function Harness({ orgId, locale }: { orgId: string | undefined; locale: string }) {
  const labels = useOrgDomainLabels(orgId, locale);
  return (
    <div
      data-testid="dump"
      data-loading={String(labels.loading)}
      data-status-backlog={labels.statusLabel('backlog') ?? ''}
      data-status-done={labels.statusLabel('done') ?? ''}
      data-entity-story={labels.entityTypeLabel('story') ?? ''}
    />
  );
}

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe('useOrgDomainLabels — 라벨 API 인덱싱+로케일 선택(#3287 AC4)', () => {
  it('설정된 slug는 오버라이드 라벨을, 미설정 slug는 undefined를 반환한다', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { domain: 'status', canonical_slug: 'backlog', label_ko: '아이디어', label_en: 'Idea' },
        { domain: 'entity_type', canonical_slug: 'story', label_ko: '캠페인', label_en: 'Campaign' },
      ],
    });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="ko" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/api/organizations/org-1/domain-labels');
    expect(el.dataset.statusBacklog).toBe('아이디어');
    expect(el.dataset.statusDone).toBe(''); // 오버라이드 미설정 — undefined(호출부가 canonical 문구로 폴백)
    expect(el.dataset.entityStory).toBe('캠페인');
  });

  it('locale=en이면 label_en을 우선하고, label_en이 비어있으면 label_ko로 폴백한다', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { domain: 'status', canonical_slug: 'backlog', label_ko: '아이디어', label_en: 'Idea' },
        { domain: 'status', canonical_slug: 'done', label_ko: '완료', label_en: null },
      ],
    });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="en" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el.dataset.statusBacklog).toBe('Idea');
    expect(el.dataset.statusDone).toBe('완료'); // en 없음 → ko 폴백
  });

  // 유나 design:changes(PR#3687, 2026-09-01) — 빈 문자열("")은 null이 아니라서 예전
  // `preferred ?? entry.label_ko ?? entry.label_en`이 그대로 반환해 소비처의
  // `statusLabel(...) ?? t(...)` 폴백도 안 타 헤더/배지가 빈칸으로 렌더될 뻔했다.
  it('빈 문자열 라벨("")은 값이 아니라 undefined로 취급된다(canonical 폴백 트리거)', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { domain: 'status', canonical_slug: 'backlog', label_ko: '', label_en: 'Idea' },
        { domain: 'status', canonical_slug: 'done', label_ko: '   ', label_en: null },
      ],
    });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="ko" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    // ko 우선인데 label_ko=""(빈 값) — label_en('Idea')로 폴백해야 한다(빈 문자열을
    // "설정된 라벨"로 오인해 그대로 반환하면 안 됨).
    expect(el.dataset.statusBacklog).toBe('Idea');
    // label_ko가 공백뿐이고 label_en도 없음 — 둘 다 무효라 완전히 undefined(canonical 폴백).
    expect(el.dataset.statusDone).toBe('');
  });

  it('orgId가 없으면 fetch 자체를 호출하지 않고(불필요 네트워크 0) 전부 undefined다', async () => {
    await act(async () => {
      root.render(<Harness orgId={undefined} locale="ko" />);
    });
    await flush();

    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el.dataset.statusBacklog).toBe('');
    expect(el.dataset.loading).toBe('false');
  });

  it('응답 !ok면 조용히 빈 목록으로 처리한다(캔버스 렌더 자체는 안 깨짐)', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: false, json: async () => { throw new Error('unused'); } });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="ko" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el.dataset.statusBacklog).toBe('');
  });

  // story #4071 마이그 재QA(카디르, 2026-09-19) — !res.ok 응답 바디가 우연히 배열 모양이면
  // (예: 프록시 중간 오류 페이지가 []를 반환) Array.isArray 방어만으론 못 잡는다 — !res.ok
  // 체크 자체가 별도로 필요함을 이 케이스로 pin(체크를 지우면 실제로 그 배열을 그대로
  // 라벨로 써버려 FAIL해야 한다).
  it('응답이 !ok인데 바디가 우연히 배열 모양이어도(프록시 오류 페이지 등) 그 값을 라벨로 쓰지 않는다(핵심 회귀)', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: false,
      json: async () => [{ domain: 'status', canonical_slug: 'done', label_ko: '해킹된라벨', label_en: null }],
    });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="ko" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el.dataset.statusDone).toBe('');
  });

  // story #4071 마이그 재QA(카디르, 2026-09-19) — 원본 skip 조건 `if (!orgId)`는 falsy
  // 전부(빈 문자열 포함)를 스킵으로 봤다. useAsyncResource의 skip 판정은 null/undefined만
  // 인식하므로, orgId=''를 정규화 없이 그대로 넘기면 `/api/organizations//domain-labels`
  // 로 실제 fetch가 나가 "기존동작 무변" 계약이 깨진다 — 핵심 회귀.
  it('orgId가 빈 문자열이어도(falsy) fetch 자체를 호출하지 않는다(#4071 재QA 핵심 회귀)', async () => {
    await act(async () => {
      root.render(<Harness orgId="" locale="ko" />);
    });
    await flush();

    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el.dataset.loading).toBe('false');
  });

  // story #3881(customer-zero) 실측 — ok:true인데 body가 배열이 아닌 모양이면(다른 엔드포인트용
  // mock에 우연히 걸리는 등, organization/events/page.test.tsx에서 EventBlockCard가 이 훅을
  // 새로 쓰기 시작하며 실제로 재현) 예전 코드는 `as DomainLabelEntry[]` 단언만 믿고 그 값을
  // 그대로 setEntries에 실어, 다음 렌더의 `for (const e of entries)`가 TypeError로 터졌다.
  // 네트워크 실패·!ok와 동일하게 빈 배열로 방어해야 한다(양성대조 — 이 테스트가 수정 前엔
  // 컴포넌트 자체가 throw로 죽어 RED였다).
  it('응답이 ok인데 배열이 아닌 모양(BE 계약 드리프트·엉뚱한 mock)이면 던지지 않고 빈 목록으로 방어한다', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ unexpected: 'shape' }) });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="ko" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el.dataset.statusBacklog).toBe('');
  });

  it('응답이 ok인데 body가 null이면(빈 JSON body 등) 던지지 않고 빈 목록으로 방어한다', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => null });

    await act(async () => {
      root.render(<Harness orgId="org-1" locale="ko" />);
    });
    await flush();

    const el = container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el.dataset.statusBacklog).toBe('');
  });

  it('조회 中 orgId가 undefined로 바뀌면 loading이 고착되지 않는다(카디르 QA #4431 클래스 sweep 재현)', async () => {
    let resolveFetch: (() => void) | null = null;
    fetchWithAuthMock.mockImplementation(() => new Promise((resolve) => {
      resolveFetch = () => resolve({ ok: true, json: async () => [] });
    }));

    function Switcher() {
      const [orgId, setOrgId] = useState<string | undefined>('org-1');
      return (
        <>
          <button data-testid="clear" onClick={() => setOrgId(undefined)}>clear</button>
          <Harness orgId={orgId} locale="ko" />
        </>
      );
    }

    await act(async () => { root.render(<Switcher />); });
    await flush();
    const el = () => container.querySelector('[data-testid="dump"]') as HTMLElement;
    expect(el().dataset.loading).toBe('true'); // 응답 도착 前 — 조회 中.

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="clear"]')!.click(); });
    await flush();
    expect(el().dataset.loading).toBe('false'); // 고착 안 됨(수정 前엔 true로 남아 FAIL).

    await act(async () => { resolveFetch?.(); });
    await flush();
    expect(el().dataset.loading).toBe('false');
  });
});

// story #4748 — 대화방은 이벤트 블록 카드 · 입력창이 저마다 이 훅을 불러 같은 조직 라벨 요청이 5초에 30번 남짓 나갔다(prod android-webview 기록).
// 같은 조직 값은 진행 중 요청을 같이 기다리고(한 번), 받은 뒤엔 TTL 동안 그대로 쓰고, 바꾼 쪽이 무효화하면 새로 받는다. 되돌리면 아래가 RED.
function Crowd({ n, orgId }: { n: number; orgId: string }) {
  return <>{Array.from({ length: n }, (_, i) => <Harness key={i} orgId={orgId} locale="ko" />)}</>;
}

const LABELS = [{ domain: 'status', canonical_slug: 'backlog', label_ko: '아이디어', label_en: 'Idea' }];
const okLabels = (entries: unknown[] = LABELS) => ({ ok: true, json: async () => entries });
const dumps = () => [...container.querySelectorAll<HTMLElement>('[data-testid="dump"]')];

describe('useOrgDomainLabels — 한 조직 값은 한 번만 받는다(#4748)', () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('같은 조직 라벨을 30개 소비처가 한꺼번에 불러도 요청은 한 번이고 모두 같은 값을 본다(대화방 · 핵심 회귀)', async () => {
    fetchWithAuthMock.mockResolvedValue(okLabels());
    await act(async () => { root.render(<Crowd n={30} orgId="org-1" />); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(dumps()).toHaveLength(30);
    expect(dumps().every((d) => d.dataset.statusBacklog === '아이디어' && d.dataset.loading === 'false')).toBe(true);
  });

  it('응답이 오기 前에 새로 붙은 소비처도 새 요청을 내지 않고 같은 응답을 기다린다', async () => {
    let resolveFetch: (() => void) | null = null;
    fetchWithAuthMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = () => resolve(okLabels()); }));
    await act(async () => { root.render(<Crowd n={5} orgId="org-1" />); });
    await flush();
    await act(async () => { root.render(<Crowd n={12} orgId="org-1" />); }); // 응답 前에 일곱이 더 붙는다
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    await act(async () => { resolveFetch?.(); });
    await flush();
    expect(dumps()).toHaveLength(12);
    expect(dumps().every((d) => d.dataset.statusBacklog === '아이디어')).toBe(true);
  });

  it('받아 둔 값은 TTL 안에서 다시 마운트해도 요청 0이고 첫 렌더부터 값이 있다(깜빡임 없음)', async () => {
    fetchWithAuthMock.mockResolvedValue(okLabels());
    await act(async () => { root.render(<Harness orgId="org-1" locale="ko" />); });
    await flush();
    await act(async () => { root.render(<div />); });
    now += ORG_DOMAIN_LABELS_TTL_MS - 1_000;
    await act(async () => { root.render(<Harness orgId="org-1" locale="ko" />); });
    expect(dumps()[0]!.dataset.statusBacklog).toBe('아이디어'); // flush 前 — 첫 렌더 값
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('TTL이 지나면 다시 받는다(바뀐 값이 결국 보인다)', async () => {
    fetchWithAuthMock.mockResolvedValue(okLabels());
    await act(async () => { root.render(<Harness orgId="org-1" locale="ko" />); });
    await flush();
    await act(async () => { root.render(<div />); });
    now += ORG_DOMAIN_LABELS_TTL_MS + 1;
    fetchWithAuthMock.mockResolvedValue(okLabels([{ ...LABELS[0], label_ko: '캠페인' }]));
    await act(async () => { root.render(<Harness orgId="org-1" locale="ko" />); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    expect(dumps()[0]!.dataset.statusBacklog).toBe('캠페인');
  });

  it('라벨을 바꾼 쪽이 invalidateOrgDomainLabels를 부르면 다음 읽기는 새 값이다(PUT · DELETE 뒤)', async () => {
    fetchWithAuthMock.mockResolvedValue(okLabels());
    await act(async () => { root.render(<Harness orgId="org-1" locale="ko" />); });
    await flush();
    expect(dumps()[0]!.dataset.statusBacklog).toBe('아이디어');
    await act(async () => { root.render(<div />); });
    fetchWithAuthMock.mockResolvedValue(okLabels([{ ...LABELS[0], label_ko: '캠페인' }]));
    invalidateOrgDomainLabels('org-1');
    await act(async () => { root.render(<Harness orgId="org-1" locale="ko" />); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    expect(dumps()[0]!.dataset.statusBacklog).toBe('캠페인');
  });

  it('무효화 前에 출발한 응답(옛 값)은 기억되지 않는다 — 무효화 뒤 첫 읽기는 새로 받는다', async () => {
    let resolveOld: (() => void) | null = null;
    fetchWithAuthMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = () => resolve(okLabels()); }));
    await act(async () => { root.render(<Harness orgId="org-1" locale="ko" />); });
    await flush();
    invalidateOrgDomainLabels('org-1'); // 옛 요청이 날아가 있는 동안 라벨이 바뀌었다
    await act(async () => { resolveOld?.(); });
    await flush();
    await act(async () => { root.render(<div />); });
    fetchWithAuthMock.mockResolvedValue(okLabels([{ ...LABELS[0], label_ko: '캠페인' }]));
    await act(async () => { root.render(<Harness orgId="org-1" locale="ko" />); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    expect(dumps()[0]!.dataset.statusBacklog).toBe('캠페인'); // 옛 값('아이디어')이 캐시에 남아 있으면 FAIL
  });

  it('조직이 다르면 따로 받는다(다른 조직 값을 물려주지 않는다)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) =>
      okLabels([{ ...LABELS[0], label_ko: url.includes('org-2') ? '둘째' : '첫째' }]));
    await act(async () => { root.render(<><Harness orgId="org-1" locale="ko" /><Harness orgId="org-2" locale="ko" /></>); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    expect(dumps().map((d) => d.dataset.statusBacklog)).toEqual(['첫째', '둘째']);
  });

  it('실패하면 FAILED_TTL 동안은 소비처마다 다시 두드리지 않고, 지나면 한 번 다시 시도한다', async () => {
    fetchWithAuthMock.mockRejectedValue(new Error('network'));
    await act(async () => { root.render(<Crowd n={10} orgId="org-1" />); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(<div />); });
    now += ORG_DOMAIN_LABELS_FAILED_TTL_MS - 1_000;
    await act(async () => { root.render(<Crowd n={10} orgId="org-1" />); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1); // 실패를 기억하는 동안 폭풍 없음
    await act(async () => { root.render(<div />); });
    now += 2_000;
    fetchWithAuthMock.mockResolvedValue(okLabels());
    await act(async () => { root.render(<Crowd n={10} orgId="org-1" />); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    expect(dumps().every((d) => d.dataset.statusBacklog === '아이디어')).toBe(true);
  });
});
