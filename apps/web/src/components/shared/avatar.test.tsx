// @vitest-environment jsdom
//
// story #2887(S2g) — Avatar 3단 폴백(이미지→이니셜→아이콘) + 에이전트 식별(링·AI 배지·dot)
// 회귀가드. 목업 s2g-avatar-mockup 규칙: 이미지가 있어도 agent는 링+배지 유지.
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

describe('Avatar — story #2887 S2g', () => {
  it('avatar_url 있으면 이미지를 그린다(휴먼)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/a.png" actorType="human" />));
    });
    const img = container.querySelector('img');
    expect(img?.src).toBe('https://example.com/a.png');
    expect(img?.alt).toBe('송윤재');
  });

  it('avatar_url 없으면 이니셜 폴백(휴먼)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl={null} actorType="human" />));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('송');
  });

  it('휴먼은 링·Agent배지·dot이 없다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl={null} actorType="human" presenceStatus="online" />));
    });
    expect(container.textContent).not.toContain('Agent');
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it('에이전트는 이미지가 있어도 Agent 배지가 유지된다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl="https://example.com/a.png" actorType="agent" presenceStatus="online" />));
    });
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.textContent).toContain('Agent');
    expect(container.querySelector('[role="img"]')).not.toBeNull(); // PresenceDot
  });

  // story #3049(2984-S1) — 정적 "Agent" 코너배지 border는 proof-blue 유지(정체성 마킹), 배경
  // soft-fill은 폐지(AGENT_MARK_FILL_CLASS=투명, 헤어라인만 남김).
  // story #3092(선생님 전달 제안 1단계) — 배지 텍스트 "AI"→"Agent"로 교체.
  it('Agent 코너배지가 border-proof-blue를 쓰고 soft-fill/citron은 안 쓴다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" />));
    });
    const badge = [...container.querySelectorAll('span')].find((s) => s.textContent === 'Agent');
    expect(badge).toBeTruthy();
    expect(badge?.className).toContain('border-proof-blue/40');
    expect(badge?.className).not.toContain('bg-proof-blue-soft');
    expect(badge?.className).not.toContain('accent-claim');
  });

  // story #2921(유나 합성 5규칙③, avatar-unification-design-memo-2921, 2026-08-22 확定) —
  // 옛 값(idle=citron 정적·working=info(=proof-blue 별칭) 펄스)이 규칙③과 정반대였다(3339
  // 그라운딩에서 실측 발견) — swap: idle=blue 정적·working=citron 펄스가 정본.
  it('working=true면 citron 펄스(AGENT_LIVE_RING_CLASS), false면 정적 proof-blue 링', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" isWorking />));
    });
    expect(container.querySelector('.ring-proof-citron')).not.toBeNull();
    expect(container.querySelector('.ring-proof-blue')).toBeNull();

    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" isWorking={false} />));
    });
    expect(container.querySelector('.ring-proof-blue')).not.toBeNull();
    expect(container.querySelector('.ring-proof-citron')).toBeNull();
  });

  // story #2921(유나 합성 5규칙②) — 형태는 actorType에서 자동 유도(호출부가 shape를 안 넘김).
  // 이미지가 있어도 같은 클립(overflow-hidden 래퍼의 반경)을 받는다.
  it('에이전트=circle(rounded-full)·human=square(rounded-md)+무채 테두리(색과 별개의 redundant 경계 신호)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" />));
    });
    const agentWrapper = container.querySelector('.rounded-full');
    expect(agentWrapper).toBeTruthy();
    expect(container.querySelector('.rounded-md')).toBeNull();
    expect(container.querySelector('.border-proof-line')).toBeNull(); // 에이전트는 링이 그 역할.

    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl={null} actorType="human" />));
    });
    const humanWrapper = container.querySelector('.rounded-md');
    expect(humanWrapper).toBeTruthy();
    expect(humanWrapper?.className).toContain('border-proof-line');
    expect(container.querySelector('.rounded-full')).toBeNull();
  });

  it('human도 이미지가 있으면 square로 클립된다(이미지 tier도 형태 예외 없음)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/a.png" actorType="human" />));
    });
    expect(container.querySelector('img')).toBeTruthy();
    const wrapper = container.querySelector('.rounded-md');
    expect(wrapper).toBeTruthy();
    expect(wrapper?.querySelector('img')).toBeTruthy();
  });

  it('presenceStatus 없으면(휴먼 기본) dot 미표시 — 에이전트라도 null이면 미표시', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" avatarUrl={null} actorType="agent" presenceStatus={null} />));
    });
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  // 카디르군 QA(#3304, HIGH) — avatar_url이 실제로는 깨진 이미지(삭제된 GCS object 등)일 때
  // native onError를 받아 이니셜 tier로 진짜 폴백하는지.
  it('이미지 로드 실패(onError) 시 이니셜로 폴백한다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/broken.png" actorType="human" />));
    });
    const img = container.querySelector('img')!;
    expect(img).not.toBeNull();
    await act(async () => { img.dispatchEvent(new Event('error')); });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('송');
  });

  it('avatar_url이 바뀌면(교체 업로드) 이전 에러 상태를 잊고 새 URL을 다시 시도한다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/broken.png" actorType="human" />));
    });
    await act(async () => { container.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(container.querySelector('img')).toBeNull();

    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" avatarUrl="https://example.com/new.png" actorType="human" />));
    });
    const img = container.querySelector('img');
    expect(img?.src).toBe('https://example.com/new.png');
  });
});

// story #3092(2단계, 표면2) — agent 아바타 hover/focus 툴팁: name + "Agent · {runtimeLabel}".
// tabIndex=0(agent 전용)이라 키보드 focus로 base-ui Tooltip이 열린다(hover 없이도 접근 가능
// — 이 tabIndex 자체가 이번에 발견·수정한 접근성 갭: 없으면 키보드로 절대 못 연다).
describe('Avatar — story #3092 2단계 커넥터 hover 툴팁', () => {
  it('human 아바타는 tabIndex도 tooltip-trigger도 없다(정체 모호성 자체가 없음)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="송윤재" actorType="human" />));
    });
    const el = container.querySelector('div')!;
    expect(el.getAttribute('tabindex')).toBeNull();
    expect(el.getAttribute('data-slot')).not.toBe('tooltip-trigger');
  });

  it('agent 아바타는 tabIndex=0 트리거를 갖고, focus 시 name+"Agent · {runtimeLabel}"이 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" runtimeType="claude-code" />));
    });
    const trigger = container.querySelector('[data-slot="tooltip-trigger"]') as HTMLElement;
    expect(trigger.getAttribute('tabindex')).toBe('0');
    await act(async () => {
      trigger.focus();
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe('유나Agent · Claude Code');
  });

  it('runtimeType이 null/미배선이면 2번째 줄이 "Agent" 단독으로 폴백한다(raw key 노출 없음)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" runtimeType={null} />));
    });
    const trigger = container.querySelector('[data-slot="tooltip-trigger"]') as HTMLElement;
    await act(async () => {
      trigger.focus();
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe('유나Agent');
  });

  // story #3103(DS·후속, 3505 design 판정 필수) — runtimeLabel() 미등록 폴백이
  // `?? key`(원값 보존)에서 `?? null`로 바뀌었다(raw key 노출 0 전역 규칙과 정합). 이 테스트는
  // 그 새 계약을 물려받아 "Agent" 단독 폴백으로 갱신한다(옛 원값 보존 기대치 폐기).
  it('runtimeType이 registry 미등록 원값이면 raw key를 노출하지 않고 "Agent" 단독으로 폴백한다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" runtimeType="unknown-runtime-x" />));
    });
    const trigger = container.querySelector('[data-slot="tooltip-trigger"]') as HTMLElement;
    await act(async () => {
      trigger.focus();
      await new Promise((r) => setTimeout(r, 900));
    });
    const content = document.body.querySelector('[data-slot="tooltip-content"]')?.textContent;
    expect(content).toBe('유나Agent');
    expect(content).not.toContain('unknown-runtime-x');
  });
});

// story #3092(3단계, 규격 v3 doc cd8983c4) — 코너 배지 3단 폴백 사다리(아이콘/이니셜/"Agent"
// 텍스트). "Agent" 텍스트 배지는 옛 사각 배지(border-proof-blue/40)로, 아이콘/이니셜은
// 신규 원형 디스크(rounded-full, ring-2 ring-background)로 서로 다른 마크업이라 구조로
// 판별한다.
describe('Avatar — story #3092 3단계 커넥터 아이콘 배지', () => {
  it('아바타≥28 + 아이콘 승인 커넥터(cursor)는 원형 아이콘 디스크를 그린다(모노=bg-white)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={32} runtimeType="cursor" />));
    });
    const disk = container.querySelector('.rounded-full.ring-2.ring-background') as HTMLElement;
    expect(disk).toBeTruthy();
    expect(disk.className).toContain('bg-white');
    const img = disk.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/connector-icons/cursor.jpg');
    // "Agent" 텍스트 배지(옛 사각 배지)는 안 뜬다 — 배타적 택일.
    expect(container.textContent).not.toContain('Agent');
  });

  it('아바타≥28 + 풀컬러 아이콘 커넥터(openclaw)는 디스크가 bg-card(테마 토큰)다', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={32} runtimeType="openclaw" />));
    });
    const disk = container.querySelector('.rounded-full.ring-2.ring-background') as HTMLElement;
    expect(disk.className).toContain('bg-card');
    expect(disk.className).not.toContain('bg-white');
  });

  it('아바타<28(마크<11px 존)이면 아이콘 승인 커넥터도 "Agent" 텍스트로 강등된다(구 사각 배지)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={24} runtimeType="cursor" />));
    });
    expect(container.textContent).toContain('Agent');
    expect(container.querySelector('img[src="/connector-icons/cursor.jpg"]')).toBeNull();
  });

  // story #3092(4단계, 선생님 확定 2026-08-26) — "연동표시 목적 무변형 사용=통상 범위,
  // 문의 불요" 판정으로 claude-code·gemini도 이니셜에서 아이콘으로 스왑(승인 대기 해제).
  // 다른 아이콘 승인 커넥터와 동형으로 크기 사다리(≥28 아이콘 / <28 Agent 텍스트)를 탄다.
  //
  // story #3119(tokscale 소스 갱신, 선생님 지정 2026-08-26) — claude-code 에셋이 jpg로
  // 바뀌며 배경이 solid 브랜드색(흰색 아님)이라 colorMode도 mono→color(bg-card)로
  // 전환됐다(가짜 흰 배경 디스크보다 원색 배경을 그대로 두는 쪽이 자연스러움).
  it('claude-code는 아이콘 승인 커넥터로 스왑됐다(아바타≥28→아이콘, <28→Agent 텍스트, tokscale jpg=colorMode color)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={32} runtimeType="claude-code" />));
    });
    const disk = container.querySelector('.rounded-full.ring-2.ring-background') as HTMLElement;
    expect(disk.className).toContain('bg-card');
    expect(disk.querySelector('img')?.getAttribute('src')).toBe('/connector-icons/claude-code.jpg');

    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={24} runtimeType="claude-code" />));
    });
    expect(container.querySelector('.rounded-full.ring-2.ring-background')).toBeNull();
    expect(container.textContent).toContain('Agent');
  });

  it('gemini도 아이콘 승인 커넥터로 스왑됐다(아바타≥28→아이콘, tokscale 멀티컬러 png=colorMode mono/bg-white)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={32} runtimeType="gemini" />));
    });
    const disk = container.querySelector('.rounded-full.ring-2.ring-background') as HTMLElement;
    expect(disk.className).toContain('bg-white');
    expect(disk.querySelector('img')?.getAttribute('src')).toBe('/connector-icons/gemini.png');
  });

  // story #3119 — codex는 라벨 «Codex» 유지·로고만 OpenAI 실제 마크로 교체(선생님 지시
  // 2026-08-26). 기존 codex.svg가 OpenAI 마크가 아니었던 오류를 겸해 정정.
  it('codex는 라벨을 유지한 채 OpenAI 로고로 교체됐다(tokscale jpg, colorMode mono/bg-white)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={32} runtimeType="codex" />));
    });
    const disk = container.querySelector('.rounded-full.ring-2.ring-background') as HTMLElement;
    expect(disk.className).toContain('bg-white');
    expect(disk.querySelector('img')?.getAttribute('src')).toBe('/connector-icons/codex.jpg');
  });

  // story #3092(5단계, 선생님 재지시 2026-08-26) — 3단계의 "벡터 자산 부재" 이니셜 강등은
  // hermes-agent repo만 조사한 결과였다. nousresearch.com 자체 favicon/앱아이콘 세트에서
  // 공식 래스터(PNG)를 발견해 아이콘으로 재승격 — 이니셜 폐기.
  //
  // story #3092(5단계 delta, 유나 실측 2026-08-26) — 상세 초상형이라 av48 미만은 blob으로
  // 뭉개짐 확認 → minIconSize=48 override + 28~47 구간 전용 이니셜 "He" 폴백. 3단 사다리:
  // av≥48 아이콘 / av 28~47 이니셜 "He" / av<28 "Agent" 텍스트(다른 8종엔 무영향).
  it('hermes 5단계 delta — av≥48 아이콘, av 28~47 이니셜 "He", av<28 "Agent" 텍스트(3단 사다리)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={48} runtimeType="hermes" />));
    });
    let disk = container.querySelector('.rounded-full.ring-2.ring-background') as HTMLElement;
    expect(disk.className).toContain('bg-white');
    expect(disk.querySelector('img')?.getAttribute('src')).toBe('/connector-icons/hermes.png');

    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={32} runtimeType="hermes" />));
    });
    disk = container.querySelector('.rounded-full.ring-2.ring-background') as HTMLElement;
    expect(disk.querySelector('img')).toBeNull();
    expect(disk.textContent).toBe('He');
    expect(disk.className).toContain('bg-card');

    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={24} runtimeType="hermes" />));
    });
    expect(container.querySelector('.rounded-full.ring-2.ring-background')).toBeNull();
    expect(container.textContent).toContain('Agent');
  });

  it('hermes 라벨층(hover 툴팁)은 크기 사다리와 무관하게 그대로 "Agent · Hermes"', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={32} runtimeType="hermes" />));
    });
    const trigger = container.querySelector('[data-slot="tooltip-trigger"]') as HTMLElement;
    await act(async () => {
      trigger.focus();
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe('유나Agent · Hermes');
  });

  it('다른 8종(예: cursor)은 minIconSize override가 없어 기존 임계(28) 그대로다(회귀 없음)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={28} runtimeType="cursor" />));
    });
    const disk = container.querySelector('.rounded-full.ring-2.ring-background') as HTMLElement;
    expect(disk.querySelector('img')?.getAttribute('src')).toBe('/connector-icons/cursor.jpg');
  });

  it('runtime_type null이면 아이콘/이니셜 디스크 자체가 안 뜨고 옛 "Agent" 텍스트 배지만 뜬다(회귀 없음)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="유나" actorType="agent" size={32} runtimeType={null} />));
    });
    expect(container.querySelector('.rounded-full.ring-2.ring-background')).toBeNull();
    expect(container.textContent).toContain('Agent');
  });

  // story #3107(#3092 후속, 선생님 지시 2026-08-26) — system-publisher(시스템 발행 주체,
  // dev 실물 team-members 레코드로 확認됨)는 이전엔 registry 밖이라 라벨 생략이었으나,
  // 이제 Sprintable 자사 심볼 무변형 재사용으로 표기한다. 다른 8종과 동형 사다리(av≥28
  // 아이콘·<28 Agent 텍스트, minIconSize 미지정).
  //
  // story #3107 delta(유나 design 판정) — 원본 /icon.svg(파비콘)은 흰 배경 rect가
  // baked-in이라 다크 테마에서 배경 패치가 비쳐, 그 rect만 뺀 투명 파생판
  // (connector-icons/sprintable-symbol.svg)으로 교체 + 디스크를 고정 밝은 배경(mono)으로.
  it('system-publisher는 Sprintable 심볼 배지를 쓴다(투명 파생판, 고정 밝은 디스크)', async () => {
    await act(async () => {
      root.render(wrap(<Avatar name="시스템 발행" actorType="agent" size={32} runtimeType="system-publisher" />));
    });
    const disk = container.querySelector('.rounded-full.ring-2.ring-background') as HTMLElement;
    expect(disk.className).toContain('bg-white');
    expect(disk.querySelector('img')?.getAttribute('src')).toBe('/connector-icons/sprintable-symbol.svg');

    const trigger = container.querySelector('[data-slot="tooltip-trigger"]') as HTMLElement;
    await act(async () => {
      trigger.focus();
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe('시스템 발행Agent · Sprintable');
  });
});
