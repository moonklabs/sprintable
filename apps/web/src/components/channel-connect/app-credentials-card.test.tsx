// @vitest-environment jsdom
//
// story #3733(페드루 PO 確定 2026-09-09, 유나 定) — owner=false는 코드 결함이 아니라
// dev DB org_members.role 실측이었다(그라운딩). 실 결함은 둘: ① non-owner 카드가
// «owner만 가능» 한 마디만 서고 누구에게 요청할지 정보 0(막다른 화면) ② 제목이
// raw 코드값(threads·facebook_sandbox)을 그대로 보간 — 같은 화면 다른 6곳은 이미
// channelLabel(channel, t)을 쓰는데 이 카드만 빠졌다. 회귀 2 + 뮤테이션.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));

import { AppCredentialsCard } from './app-credentials-card';
import type { AppCredentialsStatusResponse } from './types';

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const NONE_CREDENTIALS: AppCredentialsStatusResponse = {
  configured: false, app_id_suffix: null, updated_by: null, updated_at: null, effective_source: 'none',
};

describe('AppCredentialsCard(story #3733)', () => {
  it('owner에게는 등록 액션(버튼)이 실제로 그려진다', async () => {
    await act(async () => {
      root.render(wrap(
        <AppCredentialsCard channel="threads" orgId="org-1" isOwner credentials={NONE_CREDENTIALS} onSaved={vi.fn()} />,
      ));
    });
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(container.textContent).not.toContain('조직 소유자');
  });

  // story #3743 CHANGES Ⓐ+②(페드루 PO, #4090 리뷰 2026-09-09) — effectiveSource==='none'
  // 이면(이 카드가 열리는 유일한 진입점 — 이미 등록된 경우는 다른 값으로만 온다) 처음
  // 부터 입력 폼으로 열린다(같은 라벨 두 번 클릭 금지) — 그 대신 「설정 미완」 배너는
  // 걷는다(칩·부제와 세 번째 반복이라).
  it('⭐effectiveSource===none이면 처음부터 App ID·App Secret 입력란이 서고, 「등록」 버튼도 배너도 없다', async () => {
    await act(async () => {
      root.render(wrap(
        <AppCredentialsCard channel="threads" orgId="org-1" isOwner credentials={NONE_CREDENTIALS} onSaved={vi.fn()} />,
      ));
    });
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.textContent).not.toContain(koMessages.channelConnect.appCredentialsRegisterAction);
    expect(container.textContent).not.toContain(koMessages.channelConnect.appCredentialsNone);
  });

  it('effectiveSource===org(이미 등록)면 배너가 서고 폼은 안 열린 채(「다시 입력」 버튼만)', async () => {
    await act(async () => {
      root.render(wrap(
        <AppCredentialsCard
          channel="threads" orgId="org-1" isOwner
          credentials={{ configured: true, app_id_suffix: 'ab12', updated_by: null, updated_at: null, effective_source: 'org' }}
          onSaved={vi.fn()}
        />,
      ));
    });
    expect(container.textContent).toContain(koMessages.channelConnect.appCredentialsOrgActive.replace('{suffix}', 'ab12'));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.channelConnect.appCredentialsReenterAction);
  });

  it('non-owner에게는 등록 액션 대신 소유자 이름을 실은 요청 안내가 선다', async () => {
    await act(async () => {
      root.render(wrap(
        <AppCredentialsCard
          channel="threads" orgId="org-1" isOwner={false} ownerName="이윤재"
          credentials={NONE_CREDENTIALS} onSaved={vi.fn()}
        />,
      ));
    });
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('조직 소유자 이윤재님에게 앱 자격 등록을 요청해 주세요.');
  });

  it('소유자 이름을 못 얻으면(plain member, 403) 이름 없는 문장으로 폴백한다 — 지어내지 않는다', async () => {
    await act(async () => {
      root.render(wrap(
        <AppCredentialsCard channel="threads" orgId="org-1" isOwner={false} credentials={NONE_CREDENTIALS} onSaved={vi.fn()} />,
      ));
    });
    expect(container.textContent).toContain('조직 소유자에게 앱 자격 등록을 요청해 주세요.');
    expect(container.textContent).not.toMatch(/조직 소유자\s+\S+에게/);
  });

  it('제목이 raw 코드값이 아니라 channelLabel 표시명을 쓴다(threads·facebook_sandbox)', async () => {
    await act(async () => {
      root.render(wrap(
        <AppCredentialsCard channel="facebook_sandbox" orgId="org-1" isOwner credentials={NONE_CREDENTIALS} onSaved={vi.fn()} />,
      ));
    });
    const heading = container.querySelector('h2');
    expect(heading?.textContent).toBe('Facebook 테스트용 앱 자격');
    expect(heading?.textContent).not.toContain('facebook_sandbox');
  });

  // story #3808(Phase3·3-3 PR5a, 페드루 PO 確定 2026-09-12) — PR5a 그라운딩⑤ 확認
  // 테스트: 이 컴포넌트는 채널 하드코딩 분기가 0건(channel prop+channelLabel
  // 레지스트리만으로 동작) — x/x_sandbox도 새 코드 없이 자동 커버된다는 것을
  // facebook_sandbox 선례와 동형으로 고정.
  it('x/x_sandbox도 새 코드 없이 자동 커버된다(채널 하드코딩 0건 확認)', async () => {
    await act(async () => {
      root.render(wrap(
        <AppCredentialsCard channel="x" orgId="org-1" isOwner credentials={NONE_CREDENTIALS} onSaved={vi.fn()} />,
      ));
    });
    expect(container.querySelector('h2')?.textContent).toBe('X 앱 자격');

    await act(async () => {
      root.render(wrap(
        <AppCredentialsCard channel="x_sandbox" orgId="org-1" isOwner credentials={NONE_CREDENTIALS} onSaved={vi.fn()} />,
      ));
    });
    expect(container.querySelector('h2')?.textContent).toBe('X 테스트용 앱 자격');
  });
});
