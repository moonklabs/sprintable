// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { FailureActionBadge } from './failure-action-badge';
import { deriveFailureAction, type FailureAction } from './failure-action';
import { formatScheduledAt } from './schedule-format';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useParams: () => ({}) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

async function render(action: FailureAction, displayTimezone = 'UTC') {
  await act(async () => {
    root.render(wrap(<FailureActionBadge action={action} displayTimezone={displayTimezone} />));
  });
}

describe('FailureActionBadge — story #3422 ②-c 2/N(doc §17-13 버튼 유무표)', () => {
  it('⭐blocked — 버튼 없음(§17-13)', async () => {
    await render({ kind: 'blocked' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureBlocked);
  });

  it('⭐needs_check — 버튼 있음(2단계)', async () => {
    await render({ kind: 'needs_check' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureCheckedRetryCta);
  });

  // B3(페드루 PO, 2026-09-04 13:14Z) — 재시도 클릭 배선은 story f061c1a3 후속(BE
  // command_id 노출 뒤). 그 前까지 onRetryClick 미배선 상태로는 disabled로 두고 사유는
  // 버튼 밖 <p>로 보인다(유나 재판정 — title은 호버 전용·disabled 버튼은 탭 순서 밖).
  it('⭐B3 — needs_check 재시도 버튼은 onRetryClick 미배선이면 disabled+사유가 버튼 밖 <p>', async () => {
    await render({ kind: 'needs_check' });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('');
    expect(container.querySelector('[data-testid="channel-post-failure-retry-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureRetryUnavailable);
  });

  // N3(페드루 PO, 2026-09-04 13:26Z) — ChannelPostCard(`<Link>`)가 쓰는 모드. 버튼 자체를
  // 안 그린다(disabled로도 인터랙티브 요소 중첩은 남는다 — a>button 자체를 없앤다).
  it('⭐N3 — compact=true면 needs_check 재시도 버튼을 아예 안 그린다(라벨만)', async () => {
    await act(async () => {
      root.render(wrap(<FailureActionBadge action={{ kind: 'needs_check' }} displayTimezone="UTC" compact />));
    });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureNeedsCheck);
  });

  it('⭐auto_retry — 버튼 없음(§17-13 "자동 재시도가 예정되면 수동 버튼 없음"), next_retry_at 보간', async () => {
    await render({ kind: 'auto_retry', nextRetryAt: '2026-09-05T00:00:00Z' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    // story #4280 — 시간대 표기가 보는 사람(실행 기계 TZ)에 따라 붙거나 생략되므로 기대값도 같은 포맷터로 만든다(표기 규칙은 schedule-format.test.ts 진리표).
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureAutoRetryAt.replace('{time}', formatScheduledAt('2026-09-05T00:00:00Z', 'UTC').display));
    expect(container.textContent).toContain('09-05 00:00');
  });

  // B2(페드루 PO 지적, 2026-09-04) — scheduled_at(ChannelPostCard)과 같은 카드 안에서
  // next_retry_at만 ISO 원문으로 뜨던 결함. formatScheduledAt을 거쳐 같은 형식(MM-DD
  // HH:mm TZ)이어야 하고, ISO 원문(끊긴 T·Z 포함 문자열)이 DOM에 남으면 안 된다.
  it('⭐B2 — next_retry_at은 ISO 원문이 아니라 displayTimezone 기준 formatScheduledAt 형식으로 뜬다', async () => {
    await render({ kind: 'auto_retry', nextRetryAt: '2026-09-05T21:30:00Z' }, 'Asia/Seoul');
    expect(container.textContent).not.toContain('2026-09-05T21:30:00Z');
    expect(container.textContent).toContain('09-06 06:30');
  });

  it('⭐dead_letter — 버튼 있음(수동 재시도, 휴먼 전용은 소비부 게이팅 몫)', async () => {
    await render({ kind: 'dead_letter', needsRecheck: false, reasonCode: null, reasonResetAt: null });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureRetryCta);
  });

  it('⭐B3 — dead_letter 재시도 버튼은 onRetryClick 미배선이면 disabled+사유가 버튼 밖 <p>', async () => {
    await render({ kind: 'dead_letter', needsRecheck: false, reasonCode: null, reasonResetAt: null });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('');
    expect(container.querySelector('[data-testid="channel-post-failure-retry-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureRetryUnavailable);
  });

  it('⭐N3 — compact=true면 dead_letter 재시도 버튼을 아예 안 그린다(라벨만)', async () => {
    await act(async () => {
      root.render(wrap(<FailureActionBadge action={{ kind: 'dead_letter', needsRecheck: false, reasonCode: null, reasonResetAt: null }} displayTimezone="UTC" compact />));
    });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureDeadLetter);
  });

  // story #3402 갭(유나 실측·PO 채택 ㉡, 2026-09-10) — dead_letter ∧ needsRecheck는
  // BE가 needs_check를 즉시 dead_letter로 접는(publication_command.py:695-698) 실
  // 라이브 형이다. 문면·CTA 라벨은 needs_check 것을 쓴다(버튼 자체의 존재·활성은
  // command_status=dead_letter라 그대로 有·활성 — 2단계 게이트는 이 버튼이 여는
  // ConfirmDialog 안, page.test.tsx 몫). 이 문면은 recheckGate=true인 소비처(실제
  // 관문이 있는 channel_posts 상세)에서만 뜬다 — recheckGate=false(기본)면 needs_
  // check 문면을 안 낸다(바로 아래 별도 테스트, 페드루 PO 지적 2026-09-10 ②: "없는
  // 관문을 약속" 금지). 뮤테이션: needsRecheck 분기를 걷으면(action.needsRecheck &&
  // recheckGate ? ... : ...) → 이 두 테스트가 RED여야 한다.
  it('⭐dead_letter ∧ needsRecheck ∧ recheckGate=true — 배지 문면이 needs_check 것(채널 확認 필요)으로 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <FailureActionBadge action={{ kind: 'dead_letter', needsRecheck: true, reasonCode: null, reasonResetAt: null }} recheckGate displayTimezone="UTC" />,
      ));
    });
    expect(container.textContent).toContain(koMessages.content.channelPostsFailureNeedsCheck);
    expect(container.textContent).not.toContain(koMessages.content.channelPostsFailureDeadLetter);
  });

  it('⭐dead_letter ∧ needsRecheck ∧ recheckGate=true — CTA 라벨이 needs_check 것(「확인했습니다 · 다시 시도」)으로 뜨고 버튼은 有·활성', async () => {
    await act(async () => {
      root.render(wrap(
        <FailureActionBadge action={{ kind: 'dead_letter', needsRecheck: true, reasonCode: null, reasonResetAt: null }} recheckGate onRetryClick={() => {}} displayTimezone="UTC" />,
      ));
    });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement | null;
    expect(btn?.textContent).toBe(koMessages.content.channelPostsFailureCheckedRetryCta);
    expect(btn?.disabled).toBe(false);
  });

  // story #3402 갭 후속(페드루 PO 지적, 2026-09-10 ②) — needs_check는 unmapped
  // error_code의 fail-closed 기본값이라 site_post 외부 발행 명령에도 실제로
  // 도달한다. 그 화면엔 확認 다이얼로그·체크리스트 관문 자체가 없어, recheckGate를
  // 안 넘기면(기본 false) needsRecheck가 true여도 일반 dead_letter 문면·CTA
  // 그대로여야 한다 — 없는 관문을 약속하지 않는다. 뮤테이션: showRecheckWording
  // 계산에서 recheckGate를 빼고 needsRecheck만 보면 이 테스트가 RED여야 한다.
  it('⭐dead_letter ∧ needsRecheck인데 recheckGate 미지정(기본 false) — 일반 dead_letter 문면·CTA 그대로(없는 관문을 약속하지 않는다)', async () => {
    await render({ kind: 'dead_letter', needsRecheck: true, reasonCode: null, reasonResetAt: null });
    expect(container.textContent).toContain(koMessages.content.channelPostsFailureDeadLetter);
    expect(container.textContent).not.toContain(koMessages.content.channelPostsFailureNeedsCheck);
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement | null;
    expect(btn?.textContent).toBe(koMessages.content.channelPostsFailureRetryCta);
  });

  // story #4264(유나 권고 · PO 17:26Z) — 목록 · 캘린더 카드 · 인사이트(compact)도 «나갔을 수 있음»(needs_check dead_letter)을
  // 상세와 같은 사실 문장으로 낸다(버튼 없이). 예전엔 목록이 «자동 재시도를 멈췄어요», 상세가 «밖에 나갔는지 알 수 없어요»로
  // 갈렸다. 뮤테이션: showRecheckWording에서 `|| compact`를 빼면 첫 테스트 RED.
  it('⭐dead_letter ∧ needsRecheck ∧ compact — 목록도 상세와 같은 «채널에서 확인» 문장 · 버튼 없음', async () => {
    const action = deriveFailureAction({ commandStatus: 'dead_letter', failureKind: 'needs_check', reasonCode: 'X_POST_TWEET_MISSING_ID' });
    await act(async () => {
      root.render(wrap(<FailureActionBadge action={action as FailureAction} displayTimezone="UTC" compact />));
    });
    const listText = container.textContent;
    expect(listText).toBe(koMessages.content.channelPostsFailureNeedsCheck);
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();

    await act(async () => {
      root.render(wrap(<FailureActionBadge action={action as FailureAction} displayTimezone="UTC" recheckGate onRetryClick={() => {}} />));
    });
    expect(container.querySelector('p')?.textContent).toBe(listText);
  });

  it('⭐dead_letter ∧ not_sent ∧ compact — «멈췄어요» 그대로(확인 문장은 나갔을 수 있는 부류만)', async () => {
    const action = deriveFailureAction({ commandStatus: 'dead_letter', failureKind: 'not_sent', reasonCode: 'CHANNEL_TEXT_TOO_LONG' });
    await act(async () => {
      root.render(wrap(<FailureActionBadge action={action as FailureAction} displayTimezone="UTC" compact />));
    });
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureDeadLetter);
  });

  // story #4264 ④(까디르 codex P2 · PO 17:45Z) — 승인 필요 · 예산 초과로 발행 직전 막힘(blocked_unapproved). 워커 · 즉시 발행 두 경로가
  // 같은 모양으로 오고, 화면은 사유 문장만 · 버튼 0(compact든 아니든). 사유가 비면(4264 전 워커 행) 승인 필요. 뮤테이션:
  // deriveFailureAction의 blocked_unapproved 갈래를 빼면 배지가 없어 RED.
  it.each([
    ['EXTERNAL_PUBLISH_APPROVAL_REQUIRED', 'channelPostsBlockedReasonApprovalRequired'],
    ['GENERATION_BUDGET_EXCEEDED', 'channelPostsVoidReasonGenerationBudgetExceeded'],
    ['API_USAGE_BUDGET_EXCEEDED', 'channelPostsVoidReasonApiUsageBudgetExceeded'],
    [null, 'channelPostsBlockedReasonApprovalRequired'],
  ] as const)('⭐blocked_unapproved(%s) — 사유 문장만 · 버튼 0', async (reasonCode, key) => {
    const action = deriveFailureAction({ commandStatus: 'blocked_unapproved', reasonCode });
    for (const compact of [false, true]) {
      await act(async () => {
        root.render(wrap(<FailureActionBadge action={action as FailureAction} displayTimezone="UTC" compact={compact} onRetryClick={() => {}} />));
      });
      expect(container.querySelector('[data-testid="channel-post-failure-reason"]')?.textContent)
        .toBe((koMessages.content as Record<string, string>)[key]);
      expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    }
  });

  // story #4264 ④(PO 18:07Z · 유나 문장) — 승인 필요 멈춤의 뒷문장은 화면이 실제로 받은 게이트 상태 · 승인된 예약 시각으로만 고른다.
  // 근거: 결재함은 pending 게이트만(approvals-queue `/api/gates/inbox?status=pending`) · 승인 훅은 채널 게시 중 예약 글만 새 발행
  // 명령을 만든다(gate_service `if gate.sealed_scheduled_at is None: return`). 모르면(undefined) 앞문장만 · 약속 0.
  // 뮤테이션: 갈래 함수가 항상 A를 내게 하면 즉시 · 반려 경우가 RED.
  it.each([
    [{ gateStatus: 'pending', sealedScheduledAt: new Date(Date.now() + 86_400_000).toISOString() }, 'channelPostsBlockedNextApprovalScheduled'],
    [{ gateStatus: 'pending', sealedScheduledAt: null }, 'channelPostsBlockedNextApprovalImmediate'],
    // 봉인된 예약 시각이 이미 지났다 — 승인하면 곧바로 워커가 집는다 → 사실 경고(D).
    [{ gateStatus: 'pending', sealedScheduledAt: new Date(Date.now() - 86_400_000).toISOString() }, 'channelPostsBlockedNextApprovalScheduledPassed'],
    [{ gateStatus: 'rejected', sealedScheduledAt: null }, 'channelPostsBlockedNextResubmit'],
    [{ gateStatus: null, sealedScheduledAt: null }, 'channelPostsBlockedNextResubmit'],
    [{ gateStatus: 'approved', sealedScheduledAt: null }, null],
    [{ gateStatus: 'pending', sealedScheduledAt: undefined }, null],
    [undefined, null],
  ] as const)('⭐blocked_unapproved 승인 필요 뒷문장 — %o → %s', async (approvalContext, nextKey) => {
    const action = deriveFailureAction({ commandStatus: 'blocked_unapproved', reasonCode: 'EXTERNAL_PUBLISH_APPROVAL_REQUIRED' });
    await act(async () => {
      root.render(wrap(<FailureActionBadge action={action as FailureAction} displayTimezone="UTC" compact approvalContext={approvalContext} />));
    });
    const content = koMessages.content as Record<string, string>;
    expect(container.querySelector('[data-testid="channel-post-failure-reason"]')?.textContent)
      .toBe(content.channelPostsBlockedReasonApprovalRequired);
    expect(container.querySelector('[data-testid="channel-post-failure-next"]')?.textContent ?? null)
      .toBe(nextKey ? content[nextKey] : null);
  });

  it('⭐blocked_unapproved 예산 사유엔 승인 뒷문장이 안 붙는다(결재가 아니라 한도 문제)', async () => {
    const action = deriveFailureAction({ commandStatus: 'blocked_unapproved', reasonCode: 'GENERATION_BUDGET_EXCEEDED' });
    await act(async () => {
      root.render(wrap(<FailureActionBadge action={action as FailureAction} displayTimezone="UTC" approvalContext={{ gateStatus: 'pending', sealedScheduledAt: null }} />));
    });
    expect(container.querySelector('[data-testid="channel-post-failure-next"]')).toBeNull();
  });

  // story #3815(페드루 PO steer②, 2026-09-12 17:34Z) — dead_letter ∧ reasonCode가
  // CHANNEL_POST_DEAD_LETTER_REASON_MESSAGE_KEYS 표에 있으면(YOUTUBE_QUOTA_
  // EXCEEDED) needsRecheck/recheckGate보다 먼저 갈라 정적 문구를 낸다(일반
  // dead_letter/needs_check 문구가 아니다 — BE가 아는 사유를 화면이 못 읽던
  // 결함 처방). 뮤테이션 대상: 이 표 조회 분기를 걷으면 아래 세 테스트가
  // RED여야 한다.
  it('⭐dead_letter ∧ reasonCode=YOUTUBE_QUOTA_EXCEEDED — 일반 dead_letter/needs_check 문구 대신 정적 사용량-초과 문구', async () => {
    await render({
      kind: 'dead_letter', needsRecheck: true,
      reasonCode: 'YOUTUBE_QUOTA_EXCEEDED', reasonResetAt: null,
    });
    expect(container.querySelector('[data-testid="channel-post-failure-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureYoutubeQuotaExceeded);
    expect(container.textContent).not.toContain(koMessages.content.channelPostsFailureDeadLetter);
    expect(container.textContent).not.toContain(koMessages.content.channelPostsFailureNeedsCheck);
  });

  // story #4264(PO 15:18Z) — 사용량 초과가 `not_sent`(확실히 안 나감)로 옮겨도 사용량 문장 · 리셋 전 재시도 비활성은 그대로다
  // (not_sent 갈래가 일반 «자동 재시도를 멈췄어요»로 덮지 않는다). 판정을 실제 입력(failure_kind)에서 끌어낸다.
  it('⭐dead_letter ∧ failure_kind=not_sent ∧ YOUTUBE_QUOTA_EXCEEDED — 사용량 문장 · 리셋 전 재시도 비활성 그대로', async () => {
    const action = deriveFailureAction({
      commandStatus: 'dead_letter', failureKind: 'not_sent',
      reasonCode: 'YOUTUBE_QUOTA_EXCEEDED', reasonResetAt: new Date(Date.now() + 9 * 3600_000).toISOString(),
    });
    expect(action).toMatchObject({ kind: 'dead_letter', needsRecheck: false, reasonCode: 'YOUTUBE_QUOTA_EXCEEDED' });
    await render(action as FailureAction);
    expect(container.querySelector('[data-testid="channel-post-failure-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureYoutubeQuotaExceeded);
    expect(container.textContent).not.toContain(koMessages.content.channelPostsFailureDeadLetter);
    expect(container.querySelector('[data-testid="channel-post-failure-retry-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureRetryAfterReset);
  });

  // story #3815(페드루 PO steer②) — "지정 코드만 막으면 클래스가 남는다": 표에
  // 없는(모르는) reason_code는 원시값을 그대로 노출하지 않고 기존 제네릭
  // dead_letter 문구로 폴백한다(voided의 "맵에 없으면 사유 없이" 규율과 동형).
  it('⭐dead_letter ∧ 표에 없는 reason_code — 원시값 노출 대신 기존 제네릭 dead_letter 문구로 폴백', async () => {
    await render({
      kind: 'dead_letter', needsRecheck: false,
      reasonCode: 'SOME_FUTURE_ERROR_CODE', reasonResetAt: null,
    });
    expect(container.textContent).toContain(koMessages.content.channelPostsFailureDeadLetter);
    expect(container.textContent).not.toContain('SOME_FUTURE_ERROR_CODE');
    expect(container.querySelector('[data-testid="channel-post-failure-reason"]')).toBeNull();
  });

  // story #3815(페드루 PO steer②) — reset_at 기반 재시도 비활성은 reason_code
  // 무관(코드-agnostic) — YOUTUBE_QUOTA_EXCEEDED가 아닌 다른(가상의) reason_code
  // 라도 reason_reset_at이 미래면 똑같이 비활성돼야 한다.
  it('⭐dead_letter ∧ 표에 없는 reason_code라도 reasonResetAt이 미래면 재시도 버튼 비활성(코드-무관 gating)', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await act(async () => {
      root.render(wrap(
        <FailureActionBadge
          action={{ kind: 'dead_letter', needsRecheck: false, reasonCode: 'SOME_FUTURE_ERROR_CODE', reasonResetAt: future }}
          onRetryClick={() => {}} displayTimezone="UTC"
        />,
      ));
    });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="channel-post-failure-retry-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureRetryAfterReset);
  });

  it('⭐dead_letter ∧ YOUTUBE_QUOTA_EXCEEDED ∧ reasonResetAt이 미래 — 재시도 버튼 비활성+리셋-후 안내(헛수고를 약속하지 않는다)', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await act(async () => {
      root.render(wrap(
        <FailureActionBadge
          action={{ kind: 'dead_letter', needsRecheck: true, reasonCode: 'YOUTUBE_QUOTA_EXCEEDED', reasonResetAt: future }}
          onRetryClick={() => {}} displayTimezone="UTC"
        />,
      ));
    });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="channel-post-failure-retry-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureRetryAfterReset);
  });

  it('⭐dead_letter ∧ YOUTUBE_QUOTA_EXCEEDED ∧ reasonResetAt이 이미 지남 — 재시도 버튼 정상 활성(회귀 0)', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await act(async () => {
      root.render(wrap(
        <FailureActionBadge
          action={{ kind: 'dead_letter', needsRecheck: true, reasonCode: 'YOUTUBE_QUOTA_EXCEEDED', reasonResetAt: past }}
          onRetryClick={() => {}} displayTimezone="UTC"
        />,
      ));
    });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(koMessages.content.channelPostsFailureRetryCta);
  });

  // N2(페드루 PO 지적, 2026-09-04) — CONTENT_CHANGED는 실측 BE reason_code(channel_posts.py
  // 재승인 트리거) 중 하나 — 맵에 있으니 라벨로 보인다(원시 코드 노출 금지).
  it('⭐voided — 버튼 없음, 맵에 있는 사유는 라벨로 보인다(원시 코드 아님)', async () => {
    await render({ kind: 'voided', reasonCode: 'CONTENT_CHANGED' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureVoidedWithReason.replace('{reason}', '본문이 바뀜'));
    expect(container.textContent).not.toContain('CONTENT_CHANGED');
  });

  it('voided인데 사유가 없으면 사유 없는 폴백 문구', async () => {
    await render({ kind: 'voided', reasonCode: null });
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureVoided);
  });

  // N2 — 맵에 없는(미지) reason_code는 원시값을 그대로 노출하지 않고 사유 없는 폴백으로
  // 떨어진다(entity-status-labels.ts::translateEntityStatus와 동형 규율).
  it('⭐N2 — 맵에 없는 reason_code는 원시값 노출 대신 사유 없는 「무효가 됨」으로 떨어진다', async () => {
    await render({ kind: 'voided', reasonCode: 'SOME_FUTURE_REASON_CODE' });
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureVoided);
    expect(container.textContent).not.toContain('SOME_FUTURE_REASON_CODE');
  });

  it('⭐processing(§17-15) — 버튼 없음, transient와 다른 문구', async () => {
    await render({ kind: 'processing' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureProcessing);
    expect(container.textContent).not.toBe(koMessages.content.channelPostsFailureAutoRetryUnknown);
  });

  it('onRetryClick이 dead_letter 재시도 버튼 클릭 시 호출된다', async () => {
    let clicked = false;
    await act(async () => {
      root.render(wrap(<FailureActionBadge action={{ kind: 'dead_letter', needsRecheck: false, reasonCode: null, reasonResetAt: null }} onRetryClick={() => { clicked = true; }} displayTimezone="UTC" />));
    });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(clicked).toBe(true);
  });
});
