'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import {
  parseBlockTemplate, renderBlockTemplate,
  type BlockTemplateBlock, type EventDefinitionSummary,
} from '@/lib/block-template';

interface EventBlockCardProps {
  eventKey: string;
  payload: Record<string, unknown>;
  /** story #2637 — chat-view.tsx가 대화당 1회 배치조회한 카탈로그 캐시(entityStatusByKey와
   * 동일 패턴). `undefined`=아직 로딩 중(카탈로그 자체를 못 받음)·`null`=조회됐으나 이
   * event_key가 카탈로그에 없음(구 정의 삭제 등) — 두 경우 다 제네릭 폴백으로 graceful. */
  definition: EventDefinitionSummary | null | undefined;
  /** BE의 현행 제네릭 렌더(#2633 _render_event_message_content) — block_template이 없거나
   * 못 찾으면 이 content를 그대로 보여준다(AC2 비회귀 — 새로 지어내지 않는다). */
  fallbackContent: string;
}

/**
 * story #2637 — event_definitions.block_template v1 렌더러. msg_metadata.event가 있는 메시지의
 * 챗 카드. block_template 없음(정의 자체가 없거나 아직 미시딩)은 AC2 비회귀 — 현행 제네릭 텍스트
 * 그대로 보여준다(새 카드로 지어내지 않는다).
 *
 * ⚠️ action_auth(human_only/role) 집행 — **보안 경계는 BE(publish_registry_event, definition-
 * level 검사, PO 08-14 확定)에 있다.** 이 컴포넌트의 «권한 없어 보이면 숨김/문구» 표시는
 * UX 안내일 뿐이다 — REST를 직접 때리면 이 UI를 거치지 않고도 도달할 수 있어(2091과 동형
 * 클래스), 여기서 버튼을 숨겼다고 그게 실 차단이라고 오인하면 안 된다. FE 게이트가 BE
 * 게이트보다 먼저 서빙되지 않도록(디디 후속 PR이 이 PR 상륙 전 조건, PO 확定) 조율 상태.
 */
export function EventBlockCard({ eventKey, payload, definition, fallbackContent }: EventBlockCardProps) {
  const t = useTranslations('chats');
  const { currentMemberType, role } = useDashboardContext();

  const parsed = definition?.block_template ? parseBlockTemplate(definition.block_template) : null;

  if (!parsed) {
    return (
      <div className="min-w-0 max-w-full whitespace-pre-wrap rounded-xl rounded-tl-sm border border-border bg-card px-3.5 py-3 text-sm text-foreground">
        {fallbackContent}
      </div>
    );
  }

  const blocks = renderBlockTemplate(parsed, payload);

  return (
    <div className="min-w-0 max-w-full space-y-2 rounded-xl rounded-tl-sm border border-border bg-card px-3.5 py-3">
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
  if (block.type === 'header') {
    return <p className="text-sm font-semibold text-foreground">{block.text}</p>;
  }
  if (block.type === 'text') {
    return <p className="text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">{block.text}</p>;
  }
  if (block.type === 'fields') {
    return (
      <dl className="space-y-1">
        {block.fields.map((f, i) => (
          <div key={i} className="flex gap-1.5 text-xs">
            <dt className="shrink-0 text-muted-foreground">{f.label}</dt>
            <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{f.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  // actions
  return (
    <div className="flex flex-wrap gap-1.5">
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
    // UX 안내(위 컴포넌트 docstring 참조) — 실 보안경계 아님.
    return <p className="text-[11px] text-muted-foreground">{t('eventActionUnauthorized')}</p>;
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
