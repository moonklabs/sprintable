'use client';

import { useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { Input } from '@/components/ui/input';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { RecipeDetailView } from '@/components/organization/recipe-detail-view';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { EventDefinerForm } from '@/components/organization/event-definer-form';
import { type DefinerFormState, deriveDefinition, emptyFormState, tryReverseParse, validateKeySuffix, withHeaderName } from '@/components/organization/event-definer-logic';
import { useSampleText } from '@/components/organization/use-sample-text';

import { type EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { fetchWithAuth } from '@/lib/db/client';

import { useJsonFieldDraft } from '@/hooks/use-json-field-draft';

// 4913 C2 — 레시피 화면 쪽 틀 옮기기: 이 파일은 화면(page.tsx) 안에 있던 «정의 만들기/고치기» 대화상자와 «시험 발행» 대화상자를 그대로 옮긴 것이다(동작 · 낱말 · 요청 그대로 — 화면 틀 가드가 화면 파일에서 옛 부품 import를 금지하므로 대화상자는 자기 파일로).

// story #2664 — 목록(GET) 응답 모델(events.py EventDefinitionResponse)엔 아직 id가 없다
// (BE #2663, PR#3069 재QA 중). id가 없는 항목은 수정/비활성 버튼을 아예 안 그린다 — #2663가
// 머지되는 순간 이 화면은 코드 변경 없이 그 즉시 전 항목에서 수정/비활성이 열린다(forward-compat).
// story #3316 — name/description/stage_metadata를 loops/loop-create-dialog.tsx의
// EventDefinitionResponse(SSOT)에서 그대로 얹는다(중복 선언 대신 재사용) — 카탈로그 상세 뷰가
// 사이클형 정의의 stage_metadata(role/action/gate/capability)를 렌더링하고, "프로젝트에 적용"
// 진입점(ApplyRecipeDialog)이 cyclicStages()/isCyclicDefinition() 판별을 그대로 재사용한다.
export interface EventDefinition extends Pick<EventDefinitionResponse, 'name' | 'description' | 'stage_metadata'> {
  id?: string;
  key: string;
  org_id: string | null;
  // cyclicStages()/isCyclicDefinition()(loop-create-dialog.tsx SSOT)이 요구하는
  // properties.stage.enum 형태와 EventDefinitionSummary가 요구하는 Record<string, unknown>을
  // 교집합으로 동시에 만족 — 이 화면이 두 소비처(요약 렌더러+사이클 판별)에 같은 필드를 넘긴다.
  payload_schema: EventDefinitionResponse['payload_schema'] & Record<string, unknown>;
  routing: Record<string, unknown>;
  block_template: Record<string, unknown> | null;
  action_auth?: Record<string, unknown> | null;
  enabled: boolean;
  version: number;
}

const DEFAULT_PAYLOAD_SCHEMA = '{\n  "type": "object",\n  "properties": {},\n  "required": [],\n  "additionalProperties": false\n}';
const DEFAULT_ROUTING = '{\n  "escalation": { "kind": "server_derived", "target": "none" },\n  "broadcast": { "kind": "server_derived", "target": "none" }\n}';

// PO 리뷰(PR#3070) 기록사항① — raw SyntaxError 영문을 그대로 보여주지 않는다(#2552 사람말
// 에러 카피 원칙). 어느 필드가 깨졌는지(field) 호출부가 t('eventJsonParseError', {field})로
// 로컬라이즈해 보여줄 수 있게 field만 실어 던진다.
class JsonFieldParseError extends Error {
  constructor(public field: string) { super(`invalid_json:${field}`); }
}

function parseJsonField(raw: string, field: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new JsonFieldParseError(field);
  }
}

interface EventFormDraft {
  name: string; keySuffix: string; payloadSchema: string; routing: string; blockTemplate: string;
  humanOnly: boolean; rolesCsv: string; definerState: DefinerFormState; tab: 'basic' | 'advanced'; advancedOnly: boolean;
}

export function EventFormDialog({
  mode, target, open, onOpenChange, orgSlug, onSaved, t, tc, addToast,
}: {
  mode: 'create' | 'edit';
  target?: EventDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  onSaved: () => Promise<void>;
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
  addToast: ReturnType<typeof useToast>['addToast'];
}) {
  const sampleText = useSampleText(); // story #4257 — 테스트 발행 예시 payload도 미리보기와 같은 로케일 예시값
  const { currentTeamMemberId } = useDashboardContext();
  const prefix = `org.${orgSlug || '{org}'}.`;
  // story #3745(페드루 PO 決) — 정의 편집 폼에 이름 필드(옛 화면엔 자리 자체가 없었다).
  // story #2670(A층) — 「기본」(3서식 폼) / 「고급」(JSON, #3070 원안) 탭. create=항상 기본
  // 시작. edit=기존 JSON을 tryReverseParse로 되돌려 성공하면 기본, 실패(폼이 못 만드는
  // 모양)하면 고급 전용(배지+기본 탭 비활성) — AC3 그대로.
  // story #4370(유나 판정 (가)) — 여러 줄 칸(고급 JSON)이 든 폼이라 폼 전체가 초안 하나: 만들기 = 조직 키 · 고치기 = 정의 키
  // (저장된 정의가 처음 값 · 같으면 초안 없음). 창이 ✕ · 바깥 · Esc로 닫혀도 남고 «취소» · 고치기 저장 성공 · 만들기 뒤 닫기에서 지운다.
  const initialForm = useMemo<EventFormDraft>(() => {
    if (mode === 'edit' && target) {
      const auth = target.action_auth as { human_only?: boolean; role?: string[] } | null | undefined;
      const parsed = orgSlug ? tryReverseParse(target.key, target.payload_schema, target.routing, target.action_auth ?? null, orgSlug, target.block_template) : null;
      return {
        name: target.name ?? '',
        keySuffix: target.key.startsWith(`org.${orgSlug}.`) ? target.key.slice(`org.${orgSlug}.`.length) : target.key,
        payloadSchema: JSON.stringify(target.payload_schema, null, 2),
        routing: JSON.stringify(target.routing, null, 2),
        blockTemplate: target.block_template ? JSON.stringify(target.block_template, null, 2) : '',
        humanOnly: auth?.human_only ?? false,
        rolesCsv: (auth?.role ?? []).join(', '),
        definerState: parsed ?? emptyFormState(),
        tab: parsed ? 'basic' : 'advanced',
        advancedOnly: !parsed,
      };
    }
    return {
      name: '', keySuffix: '', payloadSchema: DEFAULT_PAYLOAD_SCHEMA, routing: DEFAULT_ROUTING, blockTemplate: '',
      humanOnly: false, rolesCsv: '', definerState: emptyFormState(), tab: 'basic', advancedOnly: false,
    };
  }, [mode, target, orgSlug]);
  const [form, setForm, clearFormDraft] = useJsonFieldDraft<EventFormDraft>(
    mode === 'edit' && target
      ? { surface: 'event-definition-edit', targetId: target.id, field: 'form' }
      : { surface: 'event-definition-create', targetId: orgSlug || null, field: 'form' },
    initialForm,
  );
  const { name, keySuffix, payloadSchema, routing, blockTemplate, humanOnly, rolesCsv, definerState, tab, advancedOnly } = form;
  const setName = (v: string) => setForm((f) => ({ ...f, name: v }));
  const setKeySuffix = (v: string) => setForm((f) => ({ ...f, keySuffix: v }));
  const setPayloadSchema = (v: string) => setForm((f) => ({ ...f, payloadSchema: v }));
  const setRouting = (v: string) => setForm((f) => ({ ...f, routing: v }));
  const setBlockTemplate = (v: string) => setForm((f) => ({ ...f, blockTemplate: v }));
  const setHumanOnly = (v: boolean) => setForm((f) => ({ ...f, humanOnly: v }));
  const setRolesCsv = (v: string) => setForm((f) => ({ ...f, rolesCsv: v }));
  const setDefinerState = (v: DefinerFormState) => setForm((f) => ({ ...f, definerState: v }));
  const setTab = (v: 'basic' | 'advanced') => setForm((f) => ({ ...f, tab: v }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 새로 저장한 정의의 실 key(발행 테스트가 필요로 하는 서버측 실체) — create 저장 성공
  // 직후에도 다이얼로그를 닫지 않고 이 값을 채워 그 자리에서 바로 테스트 발행까지 잇는다
  // (스펙 §4 "정의→미리보기→테스트 발행"이 한 세션 안에서 끊기지 않아야 함).
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [testPublishing, setTestPublishing] = useState(false);
  const [testPublishResult, setTestPublishResult] = useState<{ ok: boolean; message?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    // 폼 글은 초안 훅이 채운다(남은 초안 · 없으면 저장된 정의/기본값) — 여기선 화면 상태만.
    setSavedKey(mode === 'edit' && target ? target.key : null);
    setTestPublishResult(null);
    setError(null);
  }, [open, mode, target]);

  const definerKeyError = tab === 'basic' && mode === 'create' ? validateKeySuffix(definerState.keySuffix) : null;
  // story #2666 — 「고급」탭도 「기본」탭과 같은 key 규격(_ORG_KEY_RE 접미 [a-z0-9_]+)이라
  // 같은 클라 선검증을 재사용한다. 서버 메시지("...로 시작해야 합니다")가 문자셋 위반을
  // 접두 문제로 오진시키던 것 — 클라에서 먼저 정확한 원인(문자셋)을 지목해 그 오진 문구에
  // 도달할 일 자체를 줄인다(서버 검증은 그대로 유지 — 이건 안내일 뿐, 우회 아님).
  const advancedKeyError = tab === 'advanced' && mode === 'create' ? validateKeySuffix(keySuffix) : null;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      // story #3745 — BE가 이미 422로 막지만(공백뿐인 값도) 왕복 없이 그 자리에서 먼저
      // 말해준다(정의 폼의 다른 필드들과 같은 클라측 선검증 관례, definerKeyError와 동형).
      if (!name.trim()) throw new Error(t('eventNameRequiredError'));
      let body: Record<string, unknown>;
      if (tab === 'basic') {
        if (definerKeyError) throw new Error(definerKeyError === 'empty' ? t('definerKeyErrorEmpty') : t('definerKeyErrorCharset'));
        // story #4257(PO 11:27Z) — 머리말(#definer-name)이 비면 이벤트 이름(필수값)을 저장한다 · 자리 표시 문구를 저장하지 않는다.
        const derived = deriveDefinition(withHeaderName(definerState, name), orgSlug, sampleText);
        body = {
          name: name.trim(),
          payload_schema: derived.payload_schema,
          routing: derived.routing,
          block_template: derived.block_template,
          action_auth: derived.action_auth,
        };
        if (mode === 'create') body.key = derived.key;
      } else {
        if (advancedKeyError) throw new Error(advancedKeyError === 'empty' ? t('definerKeyErrorEmpty') : t('definerKeyErrorCharset'));
        const roles = rolesCsv.split(',').map((r) => r.trim()).filter(Boolean);
        const actionAuth = humanOnly || roles.length > 0 ? { human_only: humanOnly, role: roles } : null;
        body = {
          name: name.trim(),
          payload_schema: parseJsonField(payloadSchema, t('eventPayloadSchemaLabel')),
          routing: parseJsonField(routing, t('eventRoutingLabel')),
          block_template: blockTemplate.trim() ? parseJsonField(blockTemplate, t('eventBlockTemplateLabel')) : null,
          action_auth: actionAuth,
        };
        if (mode === 'create') body.key = `${prefix}${keySuffix.trim()}`;
      }
      let res: Response;
      if (mode === 'create') {
        res = await fetchWithAuth('/api/events/definitions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        if (!target?.id) throw new Error(t('eventErrorGeneric'));
        res = await fetchWithAuth(`/api/events/definitions/${target.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const resBody = await res.json().catch(() => null) as { error?: { message?: string }; detail?: { message?: string } } | null;
        throw new Error(resBody?.error?.message ?? `HTTP ${res.status}`);
      }
      // POST /api/events/definitions는 raw passthrough(proxyToFastapi, apiSuccess로 안 감쌈)라
      // BE(EventDefinitionDetailResponse)를 그대로 준다 — {data:...}가 아니다. 다만 이 계층
      // (fastapi-proxy)이 훗날 wrapped로 바뀌어도 조용히 깨지지 않게 두 형태 다 받는다
      // (오늘 세션 gate undo/discuss와 같은 방어 패턴).
      const savedRaw = await res.json().catch(() => null) as { data?: { key?: string }; key?: string } | null;
      const savedKeyValue = savedRaw?.data?.key ?? savedRaw?.key;
      addToast({ type: 'success', title: mode === 'create' ? t('eventCreateSuccessToast') : t('eventEditSuccessToast') });
      await onSaved();
      if (mode === 'create' && savedKeyValue) {
        // 다이얼로그를 안 닫는다 — 저장 즉시 테스트 발행이 가능해야 §4의 "정의→미리보기→
        // 테스트 발행" 한 흐름이 끊기지 않는다(재오픈 왕복 없음).
        setSavedKey(savedKeyValue);
      } else {
        clearFormDraft();
        onOpenChange(false);
      }
    } catch (e) {
      setError(e instanceof JsonFieldParseError ? t('eventJsonParseError', { field: e.field }) : e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const testPublish = async () => {
    if (!savedKey) return;
    setTestPublishing(true);
    setTestPublishResult(null);
    try {
      const derived = deriveDefinition(withHeaderName(definerState, name), orgSlug, sampleText);
      // PO 라이브 실측(review_changes) — 「발행할 때 지정」routing(payload_field)은 BE가
      // payload[member_id_field]에 실 멤버 id를 요구한다. 순수 파생 샘플엔 그 필드가 없어
      // 테스트 발행이 "나에게만 보내는 실 발행"(§4 약속)을 어기고 항상 실패했다 — 지금
      // 로그인한 나(currentTeamMemberId)를 여기서 채워 보낸다(파생 로직 자체는 순수 유지).
      const broadcast = derived.routing.broadcast as { kind?: string; member_id_field?: string } | undefined;
      const publishPayload = broadcast?.kind === 'payload_field' && broadcast.member_id_field && currentTeamMemberId
        ? { ...derived.samplePayload, [broadcast.member_id_field]: currentTeamMemberId }
        : derived.samplePayload;
      const res = await fetch('/api/events/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition_key: savedKey, payload: publishPayload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        setTestPublishResult({ ok: false, message: body?.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setTestPublishResult({ ok: true });
    } catch {
      setTestPublishResult({ ok: false, message: t('eventErrorGeneric') });
    } finally {
      setTestPublishing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (saving) return;
      // 만들기가 이미 저장된 뒤(테스트 발행용으로 열어 둔 창) 닫힘은 초안을 남길 까닭이 없다.
      if (!next && mode === 'create' && savedKey) clearFormDraft();
      onOpenChange(next);
    }}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        {/* [SID:4388] shared tabs: arrow keys · Home/End move and select (activateOnFocus), aria-selected comes with it. The root
            wraps the header and the body so the two bodies are real tab panels (role=tabpanel · named by their tab · a focus stop);
            `contents` keeps the dialog's layout as before. */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'basic' | 'advanced')} className="contents">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>{mode === 'create' ? t('eventCreateDialogTitle') : t('eventEditDialogTitle')}</DialogTitle>
              <TabsList activateOnFocus className="shrink-0">
                <TabsTrigger value="basic" disabled={advancedOnly}>
                  {t('definerTabBasic')}
                </TabsTrigger>
                <TabsTrigger value="advanced">
                  {t('definerTabAdvanced')}
                  {advancedOnly ? <Badge variant="warning" className="ml-1 text-[9px]">{t('definerAdvancedOnlyBadge')}</Badge> : null}
                </TabsTrigger>
              </TabsList>
          </div>
          {/* story #2666(발견) — 원래 문구가 "org.{조직 slug}."처럼 한글 자리표시자를 ICU
              변수 자리에 그대로 박아 놔 next-intl이 MALFORMED_ARGUMENT로 파싱 실패하던
              것(콘솔 에러+깨진 렌더 — 이 다이얼로그를 열 때마다 항상 재현). ICU 유효 이름
              (slug)으로 고치고 실제 org slug를 인자로 넘긴다. */}
          {tab === 'advanced' ? <DialogDescription>{t('eventKeyPrefixHint', { slug: orgSlug || '{org}' })}</DialogDescription> : null}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-1">
          {/* story #3745(페드루 PO 決·유나 定 2026-09-09) — 이 필드가 화면 제목 자리에
              쓰이는 유일한 소스다(둘 다 config가 아니라 그 위 표시명이라 basic/advanced
              탭 구분과 무관 — 탭 전환에도 값이 안 사라지게 탭 조건 밖에 둔다). PATCH는
              생략을 허용하지만 이 폼은 항상 실어 보낸다(수정 폼을 열면 현재 값이 이미
              채워져 있어 "생략"할 이유가 없다 — 사람이 지우고 빈 채로 저장하면 서버가
              422로 막는다, BE 계약 그대로 클라도 재확인). */}
          <div className="mb-3">
            <label className="mb-1 block text-[11px] font-semibold text-muted-foreground" htmlFor="event-name">
              {t('eventNameLabel')}
            </label>
            <Input
              id="event-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('eventNamePlaceholder')}
              className="text-base lg:text-sm"
            />
            {!name.trim() ? <p className="mt-1 text-[11px] text-muted-foreground">{t('eventNameHint')}</p> : null}
          </div>
          <TabsContent value="basic" className="rounded-sm text-[length:inherit] leading-[inherit] focus-visible:ring-2 focus-visible:ring-ring">
            <EventDefinerForm
              state={definerState}
              onChange={setDefinerState}
              orgSlug={orgSlug}
              eventName={name}
              testPublish={() => void testPublish()}
              testPublishing={testPublishing}
              testPublishResult={savedKey ? testPublishResult : { ok: false, message: t('definerTestPublishSaveFirst') }}
            />
          </TabsContent>
          <TabsContent value="advanced" className="rounded-sm text-[length:inherit] leading-[inherit] focus-visible:ring-2 focus-visible:ring-ring">
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-muted-foreground" htmlFor="event-key">
                  {t('eventKeyLabel')}
                </label>
                {mode === 'create' ? (
                  <>
                    <div className="flex items-center gap-1">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{prefix}</span>
                      <Input id="event-key" value={keySuffix} onChange={(e) => setKeySuffix(e.target.value)} className="font-mono text-base lg:text-sm" />
                    </div>
                    {advancedKeyError ? (
                      <p className="mt-1 text-[11px] text-destructive">
                        {advancedKeyError === 'empty' ? t('definerKeyErrorEmpty') : t('definerKeyErrorCharset')}
                      </p>
                    ) : (
                      <p className="mt-1 text-[11px] text-muted-foreground">{t('definerKeyHint')}</p>
                    )}
                  </>
                ) : (
                  <Input id="event-key" value={target?.key ?? ''} readOnly disabled className="font-mono text-base lg:text-sm" />
                )}
              </div>
              <JsonField id="event-payload-schema" label={t('eventPayloadSchemaLabel')} value={payloadSchema} onChange={setPayloadSchema} />
              <JsonField id="event-routing" label={t('eventRoutingLabel')} value={routing} onChange={setRouting} />
              <JsonField id="event-block-template" label={`${t('eventBlockTemplateLabel')} (${tc('optional')})`} value={blockTemplate} onChange={setBlockTemplate} />
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked={humanOnly} onChange={(e) => setHumanOnly(e.target.checked)} className="size-4" />
                  {t('eventActionAuthHumanOnlyLabel')}
                </label>
                <Input
                  value={rolesCsv}
                  onChange={(e) => setRolesCsv(e.target.value)}
                  placeholder={t('eventActionAuthRolePlaceholder')}
                  className="text-base lg:text-sm"
                />
              </div>
            </div>
          </TabsContent>
          {error ? (
            <p role="alert" aria-live="assertive" className="mt-3 rounded-md border border-destructive/30 bg-destructive-tint px-3 py-2 text-xs text-foreground">
              {error}
            </p>
          ) : null}
        </div>
        </Tabs>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => { clearFormDraft(); onOpenChange(false); }} disabled={saving}>
            {mode === 'create' && savedKey ? tc('close') /* 저장 후엔 닫기만 남는다(재저장=중복 POST·409 방지) */ : tc('cancel')}
          </Button>
          {mode === 'create' && savedKey ? null : (
            <Button
              onClick={() => void submit()}
              // story #3745 — key 검증(definerKeyError/advancedKeyError)과 같은 fail-closed
              // 관례(비활성, 클릭 뒤 에러 아님) — 이름도 같은 급의 필수 필드다.
              disabled={saving || !name.trim() || (tab === 'advanced' ? mode === 'create' && !!advancedKeyError : !!definerKeyError)}
            >
              {saving ? '...' : mode === 'create' ? t('eventCreateSubmit') : t('eventEditSubmit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JsonField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-muted-foreground" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 font-mono text-base lg:text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </div>
  );
}

export function TestPublishDialog({
  target, open, onOpenChange, t, tc, addToast,
}: {
  target: EventDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
  addToast: ReturnType<typeof useToast>['addToast'];
}) {
  // story #4370(PO 처분) — 시험 발행 payload는 초안에서 뺀다: 임의 JSON이라 토큰류가 들 수 있어 sessionStorage에 남기지 않는다.
  // 열 때마다 '{}'로 새로 시작(예전 그대로).
  const [payload, setPayload] = useState('{}');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setPayload('{}'); setError(null); }
  }, [open]);

  const submit = async () => {
    if (!target) return;
    setSending(true);
    setError(null);
    try {
      const parsedPayload = parseJsonField(payload, t('eventTestPublishPayloadLabel'));
      const res = await fetch('/api/events/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition_key: target.key, payload: parsedPayload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string }; detail?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      addToast({ type: 'success', title: t('eventTestPublishSuccessToast') });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof JsonFieldParseError ? t('eventJsonParseError', { field: e.field }) : e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!sending) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('eventTestPublishDialogTitle')}</DialogTitle>
          <DialogDescription>{target?.key ?? ''}</DialogDescription>
        </DialogHeader>
        <JsonField id="event-test-publish-payload" label={t('eventTestPublishPayloadLabel')} value={payload} onChange={setPayload} />
        {error ? (
          <p role="alert" aria-live="assertive" className="rounded-md border border-destructive/30 bg-destructive-tint px-3 py-2 text-xs text-foreground">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>{tc('cancel')}</Button>
          <Button onClick={() => void submit()} disabled={sending}>{sending ? '...' : t('eventTestPublishSubmit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 4913 C2 — 화면 파일에서 `components/ui/*`를 걷기 위해 «비활성화 확인»과 «레시피 상세 창»을 여기로(동작 · 낱말 그대로). */
export function DeactivateEventDialog({
  target, onOpenChange, onConfirm, t, tc,
}: {
  target: EventDefinition | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (def: EventDefinition) => void;
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
}) {
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('eventDeactivateDialogTitle')}
      description={t('eventDeactivateDialogBody', { key: target?.key ?? '' })}
      cancelLabel={tc('cancel')}
      confirmLabel={t('eventDeactivateConfirmCta')}
      onConfirm={() => { if (target) onConfirm(target); }}
    />
  );
}

export function RecipeDetailDialog({
  recipe, onOpenChange, onApply, t,
}: {
  recipe: EventDefinitionResponse | null;
  onOpenChange: (open: boolean) => void;
  onApply: (recipe: EventDefinitionResponse) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Dialog open={recipe !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        {recipe ? (
          <RecipeDetailView recipe={recipe} titleAs="dialog-title" onApply={() => onApply(recipe)} />
        ) : (
          // story #4386 — 닫히는 동안(대상이 비는 순간)에도 창 이름이 남게. 보이는 글 없음.
          <DialogTitle className="sr-only">{t('recipeGalleryTabMarketing')}</DialogTitle>
        )}
      </DialogContent>
    </Dialog>
  );
}
