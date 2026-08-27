// @vitest-environment jsdom
// story #92f00dc4(Chat ②층 FE, doc exec-command-final-spec-92f00dc4) — 서버 집행 커맨드
// 결과 카드 실렌더 검증. #5c29454b 회귀가드와 동일 이유(정적 리뷰로는 못 잡는 렌더 결함 —
// t.rich 태그 충돌류)로 jsdom 실마운트를 쓴다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ServerCommandResultCard } from './server-command-result-card';
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('ServerCommandResultCard — story #92f00dc4 상태별 dot·배지', () => {
  it('⚡ 서버 집행 배지가 항상 뜬다(런타임 커맨드 버블과 구분)', async () => {
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/done' 완료 — 스토리가 done으로 전이됐습니다.\n다음: 결과를 확인하세요."
          serverCommand={{ command: 'done', outcome: 'executed' }}
        />
      ));
    });
    expect(container.textContent).toContain('서버 집행');
  });

  it('outcome=executed → success dot(bg-success)', async () => {
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/priority' 완료 — 우선순위가 P2에서 P1로 변경됐습니다.\n다음: 결과를 확인하세요."
          serverCommand={{ command: 'priority', outcome: 'executed' }}
        />
      ));
    });
    expect(container.querySelector('.bg-success')).not.toBeNull();
  });

  it('outcome=denied → destructive dot(bg-destructive)', async () => {
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/done' 실패 — 이 작업을 실행할 권한이 없습니다."
          serverCommand={{ command: 'done', outcome: 'denied' }}
        />
      ));
    });
    expect(container.querySelector('.bg-destructive')).not.toBeNull();
  });

  it('outcome=not_found → muted dot(bg-muted-foreground)', async () => {
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/done' 실패 — 스토리 참조를 해석할 수 없습니다: `9999`"
          serverCommand={{ command: 'done', outcome: 'not_found' }}
        />
      ));
    });
    expect(container.querySelector('.bg-muted-foreground')).not.toBeNull();
  });

  it('outcome=ambiguous → amber dot(bg-warning)', async () => {
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/assign' 실패 — 「채영」에 일치하는 멤버가 여럿입니다."
          serverCommand={{ command: 'assign', outcome: 'ambiguous', candidates: ['채영1', '채영2'] }}
        />
      ));
    });
    expect(container.querySelector('.bg-warning')).not.toBeNull();
  });

  it('lead 텍스트는 원문 verbatim(no-fiction) — 지어낸 문구 없음', async () => {
    const content = "'/priority' 완료 — 우선순위가 P2에서 P1로 변경됐습니다.\n다음: 결과를 확인하세요.";
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard content={content} serverCommand={{ command: 'priority', outcome: 'executed' }} />
      ));
    });
    expect(container.textContent).toContain("'/priority' 완료 — 우선순위가 P2에서 P1로 변경됐습니다.");
  });

  it('executed면 「다음: ...」이 있을 때만 다음 행동 박스가 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/done' 완료 — 스토리가 done으로 전이됐습니다.\n다음: 결과를 확인하세요."
          serverCommand={{ command: 'done', outcome: 'executed' }}
        />
      ));
    });
    expect(container.textContent).toContain('결과를 확인하세요');
  });

  it('denied엔 다음 행동 박스가 안 뜬다(원문에 「다음:」이 없어도 executed가 아니므로 시도조차 안 함)', async () => {
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/done' 실패 — 이 작업을 실행할 권한이 없습니다.\n다음: 이건 절대 안 떠야 함"
          serverCommand={{ command: 'done', outcome: 'denied' }}
        />
      ));
    });
    // reportNextActionLabel 라벨 자체(「다음 행동」)가 안 뜸 — 원문 "다음:" 텍스트는 lead
    // 추출 대상이 아니라 이 검증에서 안 쓴다.
    expect(container.textContent).not.toContain('다음 행동');
  });

  it('ambiguous+candidates 있으면 후보 존과 각 이름이 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/assign' 실패 — 「채영」에 일치하는 멤버가 여럿입니다."
          serverCommand={{ command: 'assign', outcome: 'ambiguous', candidates: ['채영1', '채영2'] }}
        />
      ));
    });
    expect(container.textContent).toContain('후보');
    expect(container.textContent).toContain('채영1');
    expect(container.textContent).toContain('채영2');
  });

  it('ambiguous인데 candidates 필드가 없으면(구서버) 후보 존 자체가 생략된다 — 파싱으로 지어내지 않음', async () => {
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/assign' 실패 — 「채영」에 일치하는 멤버가 여럿입니다: 채영1, 채영2 (정확한 이름을 입력하세요)"
          serverCommand={{ command: 'assign', outcome: 'ambiguous' }}
        />
      ));
    });
    expect(container.textContent).not.toContain('후보');
  });

  it('후보 클릭 시 onFillComposer가 "/{command} #{target_story_number} {name}"으로 호출된다(스토리 참조 유실 방지, PR #3552 페드루 리뷰 후속 — 즉시 집행 아님·채움만)', async () => {
    const onFillComposer = vi.fn();
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/assign' 실패 — 「채영」에 일치하는 멤버가 여럿입니다."
          serverCommand={{ command: 'assign', outcome: 'ambiguous', candidates: ['채영1', '채영2'], target_story_number: 2947 }}
          onFillComposer={onFillComposer}
        />
      ));
    });
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '채영1');
    expect(button).toBeTruthy();
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onFillComposer).toHaveBeenCalledWith('/assign #2947 채영1');
  });

  it('onFillComposer 미제공이면 후보 버튼이 비활성(disabled)이다', async () => {
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/assign' 실패 — 「채영」에 일치하는 멤버가 여럿입니다."
          serverCommand={{ command: 'assign', outcome: 'ambiguous', candidates: ['채영1'], target_story_number: 2947 }}
        />
      ));
    });
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '채영1') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('target_story_number 필드 부재(구서버·BE 델타 미착지)면 onFillComposer가 있어도 후보 버튼이 비활성이다 — 스토리 참조 없이 채우면 BE가 invalid_args로 떨어지므로 깨진 커맨드보다 기능 저하를 택한다(페드루 판정)', async () => {
    const onFillComposer = vi.fn();
    await act(async () => {
      root.render(wrap(
        <ServerCommandResultCard
          content="'/assign' 실패 — 「채영」에 일치하는 멤버가 여럿입니다."
          serverCommand={{ command: 'assign', outcome: 'ambiguous', candidates: ['채영1'] }}
          onFillComposer={onFillComposer}
        />
      ));
    });
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '채영1') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onFillComposer).not.toHaveBeenCalled();
  });
});
