'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { renderBlockTemplate, type BlockTemplate, type BlockTemplateBlock } from '@/lib/block-template';

interface EventBlockCardProps {
  /** story #2637 AC2/PO 리뷰(head 80319636c ①) — 파싱은 chat-bubble.tsx가 미리 끝낸다. 이
   * 컴포넌트는 "파싱된 템플릿이 있을 때만" 렌더되고, 파싱 실패/부재는 chat-bubble.tsx가 이
   * 컴포넌트를 아예 안 부르고 기존 ChatMarkdown(제네릭 content) 경로로 보낸다 — 폴백
   * 렌더 경로까지 일반 메시지와 완전히 동일해야 AC2 비회귀가 성립한다(자체 폴백 div를
   * 갖지 않는 이유). */
  template: BlockTemplate;
  payload: Record<string, unknown>;
}

// story #2637 — 유나 design 스티어 2차(08-14, 재작업 방식까지 PR 前 확定).
// ⟨missing: payload.x⟩는 콘텐츠와 구분되는 「에러 상태」로 보인다 — solid text-warning-strong
// (#2594 패턴, 알파 금지) + 이탤릭. 빨강(destructive) 금지 — 치환 실패는 저자(템플릿) 실수지
// 사용자 위험이 아니다. 마커를 **먼저** 이 정규식으로 갈라내고, 인라인 마크다운(굵게/코드)은
// 마커가 아닌 조각에만 적용한다 — 순서를 바꾸면 마커 안 `payload.x`의 `_`가 이탤릭으로
// 오파싱될 위험이 있다(마커는 항상 리터럴 텍스트로 유지). renderBlockTemplate은 완성된
// 문자열을 주므로 여기서 정규식으로 다시 갈라 부분 스타일만 입힌다(block-template.ts 파서
// 자체는 순수 문자열 계약 그대로 유지 — 세그먼트 구조로 바꾸지 않는다).
const MISSING_MARKER_RE = /(⟨missing: payload\.[a-zA-Z0-9_]+⟩)/g;
// AC0-b 스펙 의도(굵게 `**…**`·코드 `` `…` ``)만 지원하는 최소 인라인 마크다운 — 그 밖의
// 마크다운 문법(링크·이탤릭 등)은 AC0-b 예시에 없어 v1 범위 밖으로 다루지 않는다.
const INLINE_MD_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function renderInlineMarkdown(text: string): React.ReactNode {
  const parts = text.split(INLINE_MD_RE).filter((p) => p !== '');
  if (parts.length === 1 && !INLINE_MD_RE.test(parts[0]!)) return text;
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground">{part.slice(1, -1)}</code>;
    }
    return <span key={i}>{part}</span>;
  });
}

function renderTextWithMissingMarkers(text: string): React.ReactNode {
  const parts = text.split(MISSING_MARKER_RE);
  if (parts.length === 1) return renderInlineMarkdown(text);
  return parts.map((part, i) =>
    MISSING_MARKER_RE.test(part)
      ? <em key={i} className="italic text-warning-strong">{part}</em>
      : <span key={i}>{renderInlineMarkdown(part)}</span>,
  );
}

/**
 * story #2637 — event_definitions.block_template v1 렌더러. 호출부(chat-bubble.tsx)가 이미
 * parseBlockTemplate로 파싱을 끝낸 template만 받는다 — 파싱 실패/정의 없음일 땐 이 컴포넌트가
 * 아예 안 불린다(AC2 비회귀는 호출부의 분기 책임).
 *
 * ⚠️ action_auth(human_only/role) 집행 — **보안 경계는 BE(publish_registry_event, definition-
 * level 검사 — story #2637 §범위3/#3037, PO 08-14 확定)에 있다.** 이 컴포넌트의 «권한 없어
 * 보이면 숨김/문구» 표시는 UX 안내일 뿐이다 — REST를 직접 때리면 이 UI를 거치지 않고도
 * 도달할 수 있어(2091과 동형 클래스), 여기서 버튼을 숨겼다고 그게 실 차단이라고 오인하면
 * 안 된다. 실 거부는 BE가 403 `{code:"action_auth_denied", message}`로 내려준다(아래
 * EventPublishActionButton의 catch가 그 message를 그대로 보여준다 — FE가 재구성 안 함).
 *
 * role 축 의미(#3037 리뷰 기록, 2026-08-14): `action_auth.role`은 **조직 role**(member/
 * admin/owner — team_members.role, `/api/me`가 내려주는 그 값)이다. 직무 템플릿 slug(예:
 * "backend-engineer")가 아니다 — 이름이 비슷해 헷갈리기 쉬운 축이라 명시한다.
 */
export function EventBlockCard({ template, payload }: EventBlockCardProps) {
  const t = useTranslations('chats');
  const { currentMemberType, role } = useDashboardContext();

  const blocks = renderBlockTemplate(template, payload);

  return (
    <div className="min-w-0 max-w-full space-y-3 rounded-xl rounded-tl-sm border border-border bg-card px-3.5 py-3">
      {blocks.map((block, i) => (
        <EventBlockRow
          key={i}
          block={block}
          payload={payload}
          currentMemberType={currentMemberType}
          currentRole={role}
          t={t}
        />
      ))}
    </div>
  );
}

function isActionAuthorized(
  auth: { human_only?: boolean; role?: string[] } | undefined,
  currentMemberType: 'human' | 'agent' | undefined,
  currentRole: string | undefined,
): boolean {
  if (!auth) return true;
  if (auth.human_only && currentMemberType !== 'human') return false;
  if (auth.role && auth.role.length > 0 && (!currentRole || !auth.role.includes(currentRole))) return false;
  return true;
}

function EventBlockRow({
  block, payload, currentMemberType, currentRole, t,
}: {
  block: BlockTemplateBlock;
  payload: Record<string, unknown>;
  currentMemberType: 'human' | 'agent' | undefined;
  currentRole: string | undefined;
  t: ReturnType<typeof useTranslations>;
}) {
  // story #2637 — 유나 design 스티어: 4블록 시각 위계(header 최상위 > fields 구조데이터 >
  // text 본문 > actions 하단 액션열) — 렌더 «순서»는 템플릿 저자가 선언한 그대로 따르되
  // (임의 재배열 안 함), 각 블록 타입의 폰트 크기/굵기로 위계만 표현한다.
  if (block.type === 'header') {
    return <p className="text-base font-semibold text-foreground">{renderTextWithMissingMarkers(block.text)}</p>;
  }
  if (block.type === 'text') {
    return <p className="text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">{renderTextWithMissingMarkers(block.text)}</p>;
  }
  if (block.type === 'fields') {
    return (
      <dl className="space-y-1.5 rounded-lg bg-muted/40 px-2.5 py-2">
        {block.fields.map((f, i) => (
          <div key={i} className="flex gap-2 text-xs">
            <dt className="shrink-0 font-medium text-muted-foreground">{f.label}</dt>
            <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{renderTextWithMissingMarkers(f.value)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  // actions
  return (
    <div className="flex flex-wrap items-center gap-2 pt-0.5">
      {block.actions.map((a, i) => {
        const authorized = isActionAuthorized(a.auth, currentMemberType, currentRole);
        return (
          <EventPublishActionButton
            key={i}
            label={a.label}
            definitionKey={a.definition_key}
            payload={payload}
            authorized={authorized}
            t={t}
          />
        );
      })}
    </div>
  );
}

function EventPublishActionButton({
  label, definitionKey, payload, authorized, t,
}: {
  label: string;
  definitionKey: string;
  payload: Record<string, unknown>;
  authorized: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authorized) {
    // story #2637 유나 design 스티어 — "무음 회색 버튼만 두지 말 것": 비활성 상태를 실제
    // disabled 버튼으로 보여주고(어떤 액션이 막혔는지 시각적으로 남김) 바로 옆에 왜 막혔는지
    // 보조문구를 둔다(호버 전제인 툴팁 단독 대신 — 터치 기기에서도 항상 보임).
    return (
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled title={t('eventActionUnauthorized')}>
          <Send className="h-3.5 w-3.5" aria-hidden />
          {label}
        </Button>
        <p className="text-[11px] text-muted-foreground">{t('eventActionUnauthorized')}</p>
      </div>
    );
  }
  if (published) {
    return (
      <p className="flex items-center gap-1 text-[11px] font-medium text-foreground">
        <Send className="h-3 w-3" aria-hidden />
        {t('eventActionPublished')}
      </p>
    );
  }

  const handleClick = async () => {
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch('/api/events/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition_key: definitionKey, payload }),
      });
      if (!res.ok) {
        // story #2637 §범위3/#3037 — 403 action_auth_denied는 BE가 이유를 완성 문장으로
        // 주므로(예: "이 이벤트(...)는 human 발행자만 허용합니다") FE가 재구성하지 않고
        // 그대로 보여준다(BE가 실 권위이자 유일한 메시지 출처).
        const body = await res.json().catch(() => null) as { error?: { message?: string }; detail?: { message?: string } | string } | null;
        const msg = body?.error?.message ?? (typeof body?.detail === 'string' ? body.detail : body?.detail?.message) ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      setPublished(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('eventActionPublishFailed'));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <Button type="button" size="sm" onClick={() => void handleClick()} disabled={publishing}>
        <Send className="h-3.5 w-3.5" aria-hidden />
        {label}
      </Button>
      {error && (
        <p role="alert" aria-live="assertive" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
