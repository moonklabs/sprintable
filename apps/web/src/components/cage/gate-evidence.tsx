'use client';

import { Fragment, useEffect, useState } from 'react';
import { CheckCircle, XCircle, GitPullRequest, Check, Pause, Ban, Loader2, type LucideIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone, formatScheduledAt } from '@/components/content/schedule-format';
import type { GateItem } from '@/components/kanban/types';
import { parseEntityRef, unescapeReferenceLabel } from '@/components/chat/entity-ref';
import { EntityChip, getEntityHref } from '@/components/chat/embed-card';
import { isCommentReplyGate, isRecipePublishGate } from '@/components/cage/gate-risk';
import { AuthorKindBadge } from '@/components/content/author-kind-badge';
import { useChannelLabel } from '@/lib/channel-label';
import { formatMinorCurrency, formatCount, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';
import { adsBoostObjectiveLabel } from '@/lib/ads-boost-objective-label';
import { recipeStageLabel } from '@/lib/recipe-stage-label';
import { stageRoleLabel } from '@/lib/stage-role';
import { isProductionWorkbenchKind, type ProductionWorkbenchKind } from '@/services/verify';
import { useFlatHref } from '@/hooks/use-flat-href';
import { keepHref } from '@/lib/with-project-param';
import { actorRowLabels, memberDisplayLabel } from '@/lib/member-display';

/**
 * H1-S8 머지 verdict 게이트 evidence(read-only 표시). 3 surface(GateInbox row·story detail·
 * approve/reject facts) 공용. 신규 화면 0 — decision 배지 + facts(CI·신뢰도) + 사유.
 *
 * 🔑 핵심 가드(AC③): 신뢰도 None=`null`은 "데이터 없음"으로만 표시한다. 0%/빨강/낮음으로
 * 절대 환원하지 않는다(null≠0 — 미측정과 0은 다르다). CI 미상도 동형(미표시).
 * 플랫폼은 위험도 판단을 하지 않는다(neutral_facts = 관찰 사실).
 *
 * 🔑 S3 상태 위계(E-DG-REAL): "없으면 비운다(omit, not placeholder)". 데이터 없는 카드는
 * 2열 그리드·"없음" 라벨을 렌더하지 않고 한 줄로 가라앉힌다(recede). 세 시각 결과 —
 *   A 빈/증거-없음(`!gateHasEvidence`): decision 배지 + 한 줄 안내만.
 *   B 부분증거: present-fact만 flowing 1줄(없는 건 빠짐·dangling `·` 금지) + 사유.
 *   C 충실((ci||trust) && coldStartSeed): 납품|판단 2열 복귀(HO-S8 "통과≠옳음" 보존·S5 슬롯).
 *
 * decision 배지 3종(BE decision = auto_merge|ask_human|block). gate status=pending(미transition)은
 * ask_human "확인 필요"로 통합(정합 노트 — 별도 "대기" 배지 불필요). 리뷰 증거는 gate 응답에
 * 미노출이라 v1 제외(억지 "없음"=오정보·follow-up). evidence_status는 배지 X·맥락 보조만.
 */

type Decision = 'auto_merge' | 'ask_human' | 'block';

/** E-GHAPP Bot-L.2: gate 카드 read-only PR 칩(forward-compat — BE가 neutral_facts.pr_links 채우면 렌더). */
interface PrLinkFact {
  repo_full_name: string;
  pr_number: number;
  link_source?: string; // 'explicit' | 'auto' | 'sid'
}

const DECISION_META: Record<Decision, { variant: 'success' | 'warning' | 'destructive'; mark: LucideIcon; labelKey: string }> = {
  auto_merge: { variant: 'success', mark: Check, labelKey: 'decisionAutoMerge' },
  ask_human: { variant: 'warning', mark: Pause, labelKey: 'decisionAskHuman' },
  block: { variant: 'destructive', mark: Ban, labelKey: 'decisionBlock' },
};

const DECISIONS = new Set(['auto_merge', 'ask_human', 'block']);

/**
 * auto_decision_reason(raw decision) 우선. 미상이면서 pending인 경우에만 ask_human으로
 * 통합하되, 그 통합은 requires_human===true일 때만 — 즉 "판정 결과가 사람 확인을 요구한다"는
 * 신호가 실제로 있을 때만 ask_human을 말한다.
 *
 * ⚠️story #2043 근본원인 fix: 이전엔 `status==='pending'`이면 requires_human 값과 무관하게
 * 무조건 ask_human을 리턴했다 — `POST /api/v2/gates` 직접 생성처럼 판정 알고리즘 자체를
 * 안 거쳐 requires_human이 기본값 false로 남은 게이트에서도 이 배지가 "Review needed"를
 * 말했다. 같은 화면 아래쪽(gates/[id]/page.tsx)은 requires_human 기준으로 "Auto-passed"를
 * 말해 한 화면이 서로 반대되는 두 문장을 동시에 말하는 자기모순이 났다(#2043 실측).
 * requires_human을 조건에 넣으면 "판정을 안 거친 껍데기 게이트"는 ask_human도 auto도 아닌
 * null(=판정 정보 없음)이 되어, 배지가 침묵하고 소비부(gates/[id]/page.tsx)가 그 침묵을
 * "판정 미거침"이라는 정직한 한 문장으로 대신 말한다 — 모순 대신 단일 문장.
 */
export function gateDecision(gate: GateItem): Decision | null {
  const raw = gate.auto_decision_reason;
  if (raw && DECISIONS.has(raw)) return raw as Decision;
  if (gate.status === 'pending' && gate.requires_human === true) return 'ask_human';
  return null;
}

/** requires_human=true면 사람 액션 대상. 단 block은 읽기 전용(override=BE 정책 미정·열린항목④). */
export function gateNeedsAction(gate: GateItem): boolean {
  return gate.requires_human === true && gateDecision(gate) !== 'block';
}

function ciResult(gate: GateItem): 'pass' | 'fail' | null {
  const v = gate.neutral_facts?.['ci_result'];
  return v === 'pass' || v === 'fail' ? v : null;
}

function trustScore(gate: GateItem): number | null {
  const v = gate.neutral_facts?.['trust'];
  return typeof v === 'number' ? v : null; // null≠0 — 미측정 보존(AC③)
}

// story #2862(loop-closure P2-B FE, BE PR#3277) — hypothesis_outcome_confirm 게이트의
// neutral_facts.draft_target/draft_actual/draft_reason. 에이전트가 만든 «미확정 측정
// 초안» — 사람이 승인해야 실제 hypothesis 전이가 일어난다(backend/app/services/
// hypothesis_outcome_confirm.py와 정합, _DRAFTABLE_TARGETS 그대로 재사용).
type HypothesisDraftTarget = 'verified' | 'falsified' | 'killed';
const DRAFT_TARGETS: ReadonlySet<string> = new Set(['verified', 'falsified', 'killed']);

interface HypothesisOutcomeDraftFacts {
  target: HypothesisDraftTarget;
  actual: unknown;
  reason: string | null;
}

function hypothesisOutcomeDraft(gate: GateItem): HypothesisOutcomeDraftFacts | null {
  const target = gate.neutral_facts?.['draft_target'];
  if (typeof target !== 'string' || !DRAFT_TARGETS.has(target)) return null;
  const reason = gate.neutral_facts?.['draft_reason'];
  return {
    target: target as HypothesisDraftTarget,
    actual: gate.neutral_facts?.['draft_actual'] ?? null,
    reason: typeof reason === 'string' && reason.length > 0 ? reason : null,
  };
}

// story #3328(3바퀴 라이브 결함 · db967a77) — 레시피 approve 게이트(external_publish 등,
// backend/app/services/recipe_gate_hooks.py::_build_approval_neutral_facts)의 neutral_facts
// shape은 이 파일의 기존 신호(ci_result·trust·cold_start_seed 등, 전부 머지/가설 게이트
// 전용)와 완전히 다르다 — work_item_reference_token·draft_doc_reference_token·channel·
// draft_doc_summary·stage. `미확認`(BE sentinel, 값을 못 찾았다는 명시 표기)은 실 증거가
// 아니므로 걸러낸다(지어내지 않음 — realString).
// i18n-exempt: BE sentinel 계약값(recipe_gate_hooks.py 등과 그대로 비교) — 번역하면 매치가 깨진다. UI 렌더 문구 아님(story #3937).
const _UNCONFIRMED = '미확認';

function realString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v !== _UNCONFIRMED ? v : null;
}

interface ParsedReferenceToken {
  entityType: string;
  entityId: string;
  label: string;
  href: string | null;
}

// BE reference_token.py::build_reference_token의 `[제목](entity:타입:id)` 산출물을 다시
// 쪼갠다 — entity-ref.ts(SSOT)의 href 파서를 그대로 재사용, 제목만 이 자리에서 분리.
//
// ⚠️PO 변경요청①(2026-09-02, PR#3710 리뷰) — BE `_escape_title`이 라벨 안의 `\ [ ] ( )`를
// `\`-escape해 저장한다(reference_token.py). unescapeReferenceLabel(entity-ref.ts SSOT — 원래
// chat-report-density.ts에만 있던 규칙을 헬퍼로 승격)로 원복하지 않으면 실 제목(예: 이 팀
// 스토리 제목 관례 "[3바퀴·draft] ... v2(276/500자·반려 반영)")이 칩에 `\[...\] ... v2\(...\)`
// 문자 그대로 새어 나간다 — 초기 구현이 이스케이프 없는 픽스처로만 테스트해 못 잡았던 자리.
/** withProject — 문서 링크(flat)에 프로젝트를 싣는 함수(story #4231 3차 · 필수). 게이트 화면은 useFlatHref()(= 게이트의 프로젝트, 4241), 링크를
 * 쓰지 않는 판정은 keepHref. */
export function parseReferenceToken(v: unknown, withProject: (href: string) => string): ParsedReferenceToken | null {
  const s = realString(v);
  if (!s) return null;
  const m = s.match(/^\[(.*)\]\((.*)\)$/);
  if (!m) return null;
  const [, rawLabel, href] = m;
  const ref = parseEntityRef(href);
  if (!ref) return null;
  return { ...ref, label: unescapeReferenceLabel(rawLabel), href: getEntityHref(ref.entityType, ref.entityId, withProject) };
}

interface RecipeApprovalFacts {
  workItemRef: ParsedReferenceToken | null;
  draftDocRef: ParsedReferenceToken | null;
  draftDocSummary: string | null;
  channel: string | null;
  stage: string | null;
  // story #4091(#4082 팔로우업, PO 확定 2026-09-21 — «사실 블록에 역할까지 얹고, 사실
  // 블록이 뜨는 분기에서만 meta 줄을 뺀다») — gates/[id]/page.tsx footer meta 줄이
  // neutral_facts.stage_role까지 같이 보여주던 걸 이 블록으로 옮긴다(정보 소실 0).
  stageRole: string | null;
  // story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §4-3③·§6-3) —
  // 글 관리 화면의 승인 요청이 채우는 필드. draft_doc_summary(300자 截단, doc 기반 채널용)
  // 와 별개 — 이쪽은 "전문"이라 접힘 없이 항상 펼쳐 보인다(§6-3 "요약 → 전문" 확장 그대로).
  // ⚠️BE 계약 정정(S2 실물, PR#3733) — neutral_facts가 아니라 Gate 전용 컬럼
  // (sealed_content_sha256/version/body, GateItem top-level)이다. 최초 설계 당시(§4-3③)는
  // neutral_facts로 가정했으나 S2가 github_check_run_sha와 동형인 전용 컬럼으로 구현했다.
  contentBody: string | null;
  contentVersion: number | null;
  contentSha256: string | null;
  // story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04)/#4073(카디르 QA④ 실측,
  // 2026-09-19) — external_publish 예약 발행 봉인 축(contentBody 등과 동일 선례). #4073
  // 前엔 BE GateResponse에 이 필드가 없어 승인카드에서 예약시각이 항상 null이었다.
  scheduledAt: string | null;
  // §3-1-2(페드루 PO 정정 2026-09-03 06:42Z) — 승인 뒤 편집으로 pending 재오픈된 게이트인지.
  // true면 이 카드는 "승인 가능한 카드"가 아니라 "재상신 대기" 카드로 그린다(§3-1-2-1).
  reapprovalRequired: boolean;
  // story #3517(유나 §22-⑤, BE #3867 조각②, PO 確定 2026-09-05) — 댓글 답변 게이트
  // (neutral_facts.kind='comment_reply') 전용 봉인 축 둘. contentBody(위)가 이미
  // "답변 본문"(reply.text, Gate.sealed_content_body) 몫을 채운다 — 이 둘은 "대상
  // 댓글" 몫만 추가한다. targetText는 그라운딩 확認 갭이라 BE 후속(neutral_facts.
  // target_text additive) 착지 전까진 항상 null(지어내지 않는다 — RecipeApprovalFactsBlock
  // 이 null이면 "제공되지 않음"으로 정직하게 비운다).
  targetExternalCommentId: string | null;
  targetText: string | null;
  // story #3599(유나 §22-17 ⑥-1, 페드루 PO 追加 2026-09-07) — 게이트 생성 시점의
  // sent 카운트 스냅샷(neutral_facts.sent_replies_count, additive). null=구버전
  // 게이트(이 필드 자체가 없던 시절)·0=보낸 답변 없음 — 둘 다 줄을 안 그린다
  // (§content.commentsReplyAlreadySentCount와 같은 규율: 수만·0이면 미표시).
  alreadySentCount: number | null;
  // story #3599(유나 §22-17 ⑥-4 조건 갱신, 페드루 PO 정정 2026-09-07) — 버전-미상
  // 캡션은 «승인/반려 판단이 실제로 난» 행에서만. pending·held(일시정지)는
  // 아직 판단 자체가 없고, voided는 판단이 아니라 행정 무효화라 지어낼 것도
  // 없다 — approved/rejected/auto_passed만 이 조건을 만족한다.
  isResolved: boolean;
  // story #3560(concept_approval, 페드루 PO 確定 2026-09-06) — sealed_content_*와
  // 동형이나 대상이 doc(external_publish=본문 텍스트 봉인·concept_approval=doc
  // 봉인). BE additive(story #3569) — 그 전까진 항상 null. 「펼침」이 없다(본문
  // 전문을 안 보인다 — 링크로 doc을 직접 열어 보는 쪽이 doc 자체의 편집 이력·
  // 서식을 있는 그대로 보여준다, contentBody의 "요약→전문" 확장과 다른 결).
  sealedDocRef: ParsedReferenceToken | null;
  sealedDocBodySha256: string | null;
  // story #3367(3자기점검, 페드루 지적 2026-09-10) — AC7("마지막 수정 주체·목적지").
  // 봉인 축(contentBody 등)과 달리 이 둘은 "지금" 값이다(latestAuthorKind는 approved
  // 뒤 편집이면 봉인 작성자와 갈릴 수 있다 — 그게 이 필드의 존재 이유).
  latestAuthorKind: 'agent' | 'human' | null;
  // Gate ORM 실 컬럼이라 모든 gate_type 응답에 항상 present(null 포함, sealed_doc_id와
  // 동일 선례) — "hosted_site"와 "이 축이 없는 gate_type"을 이 필드 하나로는 못
  // 가른다. 렌더는 contentVersion/contentSha256(site_posts 식별 신호)과 같은 조건에
  // 묶는다(아래 RecipeApprovalFactsBlock — «모른다≠다르다» 규율은 그 조건 분기가 진다).
  destinationConnectionId: string | null;
  // story #3367(유나 CHANGES, 페드루 재검토 2026-09-10) — destinationConnectionId
  // 원문(uuid)을 승인자에게 그대로 보이면 확認 불가능한 값으로 서명을 요구하는
  // 결함이 된다. 그 연결의 channel(BE list_gates() 배치 enrich)을 channelLabel()
  // (lib/channel-label.ts, 집안 정본)로 표시명을 낸다.
  destinationChannel: string | null;
  // story #4143(2호 리허설 실측, 페드루 PO 確定 2026-09-22) — "호스팅 블로그"인지를
  // destinationConnectionId===null로 *추정*하던 결함(채널 초안 게이트도 이 컬럼을
  // 안 채우던 시절엔 연결 id가 null이라 우연히 같은 값이었지만, 그건 "site 게이트라서
  // null"이 아니라 "이 write-path가 아예 안 채워서 null"이었다 — 두 세계가 우연히
  // 같은 값을 내던 것뿐). neutral_facts.destination(BE site_posts.py/channel_posts.py
  // 둘 다 상신 시점에 채우는 원문 목적지 채널 코드, "hosted_site"|실 채널명)이 이제
  // «site 게이트인가»의 진짜 SSOT다 — 이 값과 직접 비교한다(추정 0).
  destinationIsHostedSite: boolean;
  // story #3806(Phase3·3-2 PR5, 유나 §절 §1 「결재 카드 봉인 5필드」) — sealed_content_*/
  // sealed_doc_*와 동일 선례(다른 gate_type은 전부 null). 통화·기간·목표는 §1 표
  // 그대로(총예산은 adsBudgetMinor+adsCurrency 조합으로 formatMinorCurrency 재사용).
  adsBudgetMinor: number | null;
  adsCurrency: string | null;
  adsStartsAt: string | null;
  adsEndsAt: string | null;
  adsObjective: string | null;
  // story #3813(Phase3·3-4 PR4, 페드루 PO 確定 2026-09-12) — newsletter_send 전용
  // sealing(adsBudgetMinor 등과 동일 선례, 다른 gate_type은 전부 null).
  // estimatedRecipientCount는 봉인값이 아니다(어댑터 조회, 위 GateItem 주석 참고) —
  // 그래도 승인 카드가 「이 세그먼트 N명에게 발송」을 보여줄 유일한 자리라 여기 싣는다.
  newsletterSegmentName: string | null;
  newsletterSendScheduledAt: string | null;
  newsletterEstimatedRecipientCount: number | null;
  // story #3813(Phase3·3-4 PR4, 페드루 PO CHANGES 2026-09-12, 라이브 캡처 실측) —
  // 「무엇을」 보내는지 없이 승인하던 결함. estimatedRecipientCount와 동형(봉인값
  // 아님, 어댑터/버전 조회).
  newsletterSubject: string | null;
  // story #4072(E-RECIPE-1, 페드루 PO 確定 2026-09-19·카디르 QA③ CHANGES) —
  // generation_budget(ⓒ 실탄 게이트) 전용 sealing. adsBudgetMinor와 동일 선례.
  // 통화는 sealed 컬럼이 아니라 neutral_facts.currency에서 온다(recipe_gate_hooks.py
  // 가 org content_rules.generation_budget.currency를 그대로 echo, KRW|USD만
  // 존재 — 그 필드가 없으면(구버전 gate 등) 지어내지 않고 null, formatMinorCurrency
  // 안 씀·최소단위 원값만).
  estimatedCostMinor: number | null;
  estimatedCostCurrency: 'KRW' | 'USD' | null;
  // story #4085 AC4-B(3호 라이브 실측 2026-09-22 · 페드루 PO 처방) — org 생성 예산 규칙이
  // 있을 때만 recipe_gate_hooks.py가 같은 if-블록 안에서 이 셋과 currency를 함께
  // neutral_facts에 싣는다(위 currency와 동일 존재 보증 — 규칙 없으면 셋 다 null이고
  // «통화 미확인» 표기만 그대로, 이 줄 자체를 안 그린다).
  budgetLimitMinor: number | null;
  budgetSpentMinor: number | null;
  budgetRemainingMinor: number | null;
  // story #4090([E-RECIPE-1] Publisher 슬롯) AC2·AC3(2026-09-21) — 레시피 자동발행
  // 훅의 기계 소유 결과(gate.publish_outcome, sealed 계열과 달리 승인 *후* 갱신될
  // 수 있는 값 — 그래도 이 카드가 승인자가 자동발행 여부를 보는 유일한 자리라
  // 여기 싣는다). external_publish(scope_key="") 게이트가 아니면 항상 null.
  publishOutcome: string | null;
  // story #4264(유나 조건 · PO 23:40Z) — needs_check 라벨은 «확인했어요 · 다시 시도»가 있는 글 화면으로 한 번에 가는 길이 있을 때만
  // 짧은 형. 레시피가 쥔 채널 초안(BE `linked_channel_draft`)이 있으면 그 글 화면 링크, 없으면 null(긴 형 문장).
  publishOutcomeDraftHref: string | null;
}

function recipeApprovalFacts(gate: GateItem, withProject: (href: string) => string): RecipeApprovalFacts | null {
  const f = gate.neutral_facts;
  const contentBody = realString(gate.sealed_content_body);
  const contentVersion = typeof gate.sealed_content_version === 'number' ? gate.sealed_content_version : null;
  const contentSha256 = realString(gate.sealed_content_sha256);
  // story #3521(카디르 QA #3873 발견) — isCommentReplyGate(gate-risk.ts)와 판정을
  // 한 벌로 통일(전엔 여기 인라인 kind==='comment_reply'가 별도 사본이었다).
  const isCommentReply = isCommentReplyGate(gate);
  const sealedDocId = realString(gate.sealed_doc_id);
  const sealedDocRef: ParsedReferenceToken | null = sealedDocId
    ? {
        entityType: 'doc', entityId: sealedDocId,
        label: realString(gate.sealed_doc_title) ?? sealedDocId.slice(0, 8),
        href: getEntityHref('doc', sealedDocId, withProject),
      }
    : null;
  const facts: RecipeApprovalFacts = {
    workItemRef: parseReferenceToken(f?.['work_item_reference_token'], withProject),
    draftDocRef: parseReferenceToken(f?.['draft_doc_reference_token'], withProject),
    draftDocSummary: realString(f?.['draft_doc_summary']),
    channel: realString(f?.['channel']),
    stage: realString(f?.['stage']),
    stageRole: realString(f?.['stage_role']),
    contentBody,
    contentVersion,
    contentSha256,
    scheduledAt: realString(gate.sealed_scheduled_at),
    reapprovalRequired: gate.reapproval_required === true,
    targetExternalCommentId: isCommentReply ? realString(f?.['target_external_comment_id']) : null,
    targetText: isCommentReply ? realString(f?.['target_text']) : null,
    alreadySentCount: isCommentReply && typeof f?.['sent_replies_count'] === 'number' ? f['sent_replies_count'] : null,
    // story #3599(페드루 PO 정정 2026-09-07, 그라운딩 2026-09-07) — gate.status!==
    // 'pending'은 held(일시정지·가역)·voided까지 "결정 남"으로 세어버린다. PO가
    // 제시한 대안(resolved_at!==null)도 실측해 보니 안 맞는다 — void_gate(gate_
    // service.py:1592)가 resolved_at을 채운다(voided도 포함돼 버림). "승인/반려
    // 판단이 실제로 난" 상태만 명시 열거한다(GATE_STATUSES 중 이 셋만 본문에
    // 대한 판단 — held는 판단 자체가 없고 voided는 판단이 아니라 행정 무효화).
    isResolved: gate.status === 'approved' || gate.status === 'rejected' || gate.status === 'auto_passed',
    sealedDocRef,
    sealedDocBodySha256: realString(gate.sealed_doc_body_sha256),
    latestAuthorKind: gate.latest_author_kind === 'agent' || gate.latest_author_kind === 'human'
      ? gate.latest_author_kind : null,
    destinationConnectionId: realString(gate.sealed_destination_connection_id) ?? null,
    destinationChannel: realString(gate.sealed_destination_channel) ?? null,
    destinationIsHostedSite: f?.['destination'] === 'hosted_site',
    adsBudgetMinor: typeof gate.sealed_ads_budget_minor === 'number' ? gate.sealed_ads_budget_minor : null,
    adsCurrency: realString(gate.sealed_ads_currency),
    adsStartsAt: realString(gate.sealed_ads_starts_at),
    adsEndsAt: realString(gate.sealed_ads_ends_at),
    adsObjective: realString(gate.sealed_ads_objective),
    newsletterSegmentName: realString(gate.sealed_newsletter_segment_name),
    newsletterSendScheduledAt: realString(gate.sealed_newsletter_scheduled_at),
    newsletterEstimatedRecipientCount:
      typeof gate.estimated_recipient_count === 'number' ? gate.estimated_recipient_count : null,
    newsletterSubject: realString(gate.newsletter_subject),
    estimatedCostMinor:
      typeof gate.sealed_estimated_cost_minor === 'number' ? gate.sealed_estimated_cost_minor : null,
    estimatedCostCurrency: f?.['currency'] === 'KRW' || f?.['currency'] === 'USD' ? f['currency'] : null,
    budgetLimitMinor: typeof f?.['budget_limit_minor'] === 'number' ? f['budget_limit_minor'] : null,
    budgetSpentMinor: typeof f?.['budget_spent_minor'] === 'number' ? f['budget_spent_minor'] : null,
    budgetRemainingMinor: typeof f?.['budget_remaining_minor'] === 'number' ? f['budget_remaining_minor'] : null,
    publishOutcome: realString(gate.publish_outcome),
    publishOutcomeDraftHref: gate.linked_channel_draft?.draft_id
      ? withProject(`/content/channel-posts/${gate.linked_channel_draft.draft_id}`)
      : null,
  };
  const hasAny = isCommentReply ||
    facts.workItemRef || facts.draftDocRef || facts.draftDocSummary || facts.channel || facts.stage ||
    facts.contentBody || facts.contentVersion !== null || facts.contentSha256 || facts.scheduledAt !== null ||
    facts.sealedDocRef || facts.sealedDocBodySha256 || facts.adsBudgetMinor !== null ||
    facts.newsletterSegmentName !== null || facts.newsletterSendScheduledAt !== null || facts.newsletterSubject !== null ||
    facts.estimatedCostMinor !== null || facts.publishOutcome;
  return hasAny ? facts : null;
}

/**
 * 카드에 사람이 평가할 '실 증거'가 있는가. 빈/cold-start 구분의 단일 소스.
 * self_report_only 단독은 증거 아님(trust 실값에 붙는 qualifier로만 — 빈카드 도배 원인 제거).
 */
export function gateHasEvidence(gate: GateItem): boolean {
  const f = gate.neutral_facts;
  const hasCi = f?.['ci_result'] === 'pass' || f?.['ci_result'] === 'fail';
  const hasTrust = typeof f?.['trust'] === 'number'; // null≠0 — number만
  const hasSeed = f?.['cold_start_seed'] === true;
  const hasReason = Boolean(gate.decision_basis); // 실 human reason만
  // story #2814 — GitHub check 발행 자체도 "실 증거"다. 이게 유일한 신호인 게이트가 State A
  // (빈 카드)로 가라앉으면 안 된다 — State B/C 흐름에 자연히 합류시킨다.
  const hasGithubCheck = githubCheckState(gate) !== null;
  // story #2862 — 측정 판정 초안도 실 증거다(같은 이유, 안 그러면 hypothesis_outcome_confirm
  // 게이트가 State A 빈 카드로 가라앉아 사람이 판정 초안을 아예 못 본다).
  const hasDraft = hypothesisOutcomeDraft(gate) !== null;
  // story #3328 — 레시피 approve 게이트의 승인 대상 실물(work item·draft doc·channel)도
  // 실 증거다(같은 이유 — 안 그러면 external_publish 게이트가 State A로 가라앉아 승인자가
  // 뭘 승인하는지 dialog 안에서 전혀 못 본다).
  const hasRecipeApproval = recipeApprovalFacts(gate, keepHref) !== null; // 있는지 판정만(링크 안 씀)
  return hasCi || hasTrust || hasSeed || hasReason || hasGithubCheck || hasDraft || hasRecipeApproval;
}

type GithubCheckState = 'not_published' | 'in_progress' | 'success' | 'failure';

/**
 * story #2814(2813 BE 조각 착지분) — BE `_github_state_for_gate_status`와 정합(gate_github_check.py):
 * approved/auto_passed→success, rejected/voided→failure, pending/held→in_progress. 그 외 gate
 * status(discussed 등)는 GitHub check 관점에선 미정의라 null.
 *
 * ⚠️페드루군 AC 노트(PR#3244, 비차단) — 이 값은 gate.status에서 파생한 "게이트가 의도한" check
 * 상태이지, GitHub의 실제 check 상태를 조회한 값이 아니다. publish_gate_check()가 GitHub API
 * 호출에 실패하면 실제 check는 오래된 pending에 머무는데 이 화면은 approved→success로 보일 수
 * 있다 — GitHub 쪽은 fail-closed라 required check 미충족 시 머지가 막히므로 안전 사고는 아니고
 * 표시 정직성 문제만 있다. 실제 원장(gate_github_check_event) 조회로 좁히는 건 재-pending 사유
 * 표시(GithubRependingReason)가 맡는다.
 *
 * story #2814 2단(§5-④ 그라운딩·BE story #2815/PR#3245) — 관측모드 판별을 1단의 "run_id null이면
 * 무조건 숨김" 휴리스틱에서 `github_check_enforced`(단건 조회에서만 enrich) 기반으로 승격:
 *   - enforced===false(관측모드 확定) → run_id 유무·값과 무관하게 항상 숨김(가장 신뢰도 높은 신호).
 *   - enforced===true인데 run_id가 아직 null → "관측모드"가 아니라 "아직 발행 전"임을 이제는 안다
 *     — 1단엔 없던 not_published 상태로 승격 표시(숨기지 않음).
 *   - enforced===undefined/null(list_gates·inbox 등 미enrich 표면) → 1단 휴리스틱 그대로 폴백
 *     (run_id null=숨김) — 이 필드가 없는 표면에서 오판하지 않기 위한 안전망.
 */
export function githubCheckState(gate: GateItem): GithubCheckState | null {
  if (gate.github_check_enforced === false) return null;
  if (gate.github_check_run_id == null) {
    return gate.github_check_enforced === true ? 'not_published' : null;
  }
  switch (gate.status) {
    case 'approved':
    case 'auto_passed':
      return 'success';
    case 'rejected':
    case 'voided':
      return 'failure';
    case 'pending':
    case 'held':
      return 'in_progress';
    default:
      return null;
  }
}

// CI 신호 — lucide CheckCircle/XCircle(gate-line-context 정합·boy-scout). null이면 호출 자체 안 함(omit).
function CiSignal({ ci }: { ci: 'pass' | 'fail' }) {
  const t = useTranslations('cage');
  return ci === 'pass' ? (
    <span className="inline-flex items-center gap-1 text-success">
      <CheckCircle className="size-3 shrink-0" />
      {t('ciLabel')} {t('ciPass')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-destructive">
      <XCircle className="size-3 shrink-0" />
      {t('ciLabel')} {t('ciFail')}
    </span>
  );
}

// 신뢰도 — 실값만. 자기보고 태그는 trust 실값에 '붙어서만'(단독 도배 금지).
function TrustValue({ trust, selfReportOnly }: { trust: number; selfReportOnly: boolean }) {
  const t = useTranslations('cage');
  return (
    <span className="inline-flex items-center gap-1">
      {t('trustLabel')}{' '}
      <span className="text-foreground">{t('trustScorePercent', { score: Math.round(trust * 100) })}</span>
      {selfReportOnly ? (
        <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">{t('selfReportTag')}</span>
      ) : null}
    </span>
  );
}

// GitHub check 상태 — story #2814. null(발행 안 됨/관측모드)이면 호출 자체 안 함(다른 signal들과
// 동형 omit 규율). SHA는 짧은 표기(git 관례 7자)로, gate.status가 아니라 github_check_run_sha를
// 보여줘 "그 check-run이 실제로 겨냥한 SHA"를 그대로 노출한다(approved_head_sha는 승인이 귀속된
// SHA라는 다른 의미 — 재-pending 이후엔 이 둘이 갈릴 수 있어 혼용 금지).
function GithubCheckSignal({ state, sha }: { state: GithubCheckState; sha: string | null }) {
  const t = useTranslations('cage');
  const META: Record<GithubCheckState, { className: string; icon: LucideIcon; labelKey: string; spin?: boolean }> = {
    // story #2814 2단 — enforced===true인데 아직 발행 전(1단엔 없던 상태, githubCheckState 참조).
    not_published: { className: 'text-muted-foreground', icon: Pause, labelKey: 'githubCheckNotPublished' },
    in_progress: { className: 'text-muted-foreground', icon: Loader2, labelKey: 'githubCheckPending', spin: true },
    success: { className: 'text-success', icon: CheckCircle, labelKey: 'githubCheckSuccess' },
    failure: { className: 'text-destructive', icon: XCircle, labelKey: 'githubCheckFailure' },
  };
  const { className, icon: Icon, labelKey, spin } = META[state];
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <Icon className={`size-3 shrink-0 ${spin ? 'animate-spin' : ''}`} aria-hidden />
      {t('githubCheckLabel')} {t(labelKey)}
      {sha ? <span className="font-mono text-muted-foreground">{t('githubCheckShaLabel', { sha: sha.slice(0, 7) })}</span> : null}
    </span>
  );
}

// story #2814 2단(§5-② 그라운딩) — backend/app/routers/gates.py GateGithubCheckEventResponse와 정합.
// story #2840(BE PR#3264 §2819) — prior_sha 추가. re_pending 행 전용(무효화된 승인이 귀속됐던
// SHA) — published/resolved 행이나 마이그레이션 이전 re_pending 행은 null(소급 불가).
interface GithubCheckLedgerEvent {
  id: string;
  repo_full_name: string;
  pr_number: number;
  head_sha: string;
  prior_sha: string | null;
  event_type: 'published' | 're_pending' | 'resolved';
  check_conclusion: string | null;
  created_at: string;
}

/**
 * 재-pending 사유 상세(story #2814 2단 AC②) — `GET /api/gates/{id}/github-check-events` 지연
 * 로드(최신순). 최신 이벤트가 `re_pending`이면 "새 커밋이 이전 승인을 무효화했다"는 문장을
 * 그 이벤트의 head_sha(무효화를 유발한 새 SHA)로 조립한다.
 *
 * story #2840(BE PR#3264 §2819 착지) — 원장에 `prior_sha`(무효화된 승인이 귀속됐던 SHA)가
 * 추가돼 "SHA {prior}에서 SHA {new}로 무효화" 완전 문구를 조립할 수 있다. `prior_sha`가
 * null인 행(published/resolved 행·마이그레이션 이전 re_pending 행)은 두 SHA를 지어내지
 * 않고 기존 단축 문구("새 커밋으로 이전 승인 무효화")로 정직하게 폴백한다(no-fiction).
 *
 * 트리거는 호출부(GateEvidence)가 결정 — ghState==='in_progress'일 때만 마운트한다(success/
 * failure/not_published/null인 게이트는 재-pending 여지 자체가 없어 호출 불요).
 *
 * ⚠️2026-08-20 라이브 AC2 재검 중 발견·즉시수정 — `events[0]`(최신 이벤트 그 자체)이 아니라
 * "가장 최근 re_pending 이벤트"를 찾아야 한다. 실왕복 확인 결과 새 커밋 감지 시 BE가 re_pending
 * 기록 직후(같은 웹훅 처리 안에서) 그 새 SHA로 새 check-run을 published — 즉 정상 케이스에서
 * `events[0]`은 거의 항상 `published`이고 `re_pending`은 events[1]. 이전 코드(`events[0]?.event_type
 * !== 're_pending'`)는 이 실측 순서에서 사실상 절대 참이 안 돼 사유 문구가 죽어있었다(AC2 미충족).
 * ghState==='in_progress' 마운트 가드가 이미 "아직 미해결"을 보장하므로, 원장에서 가장 최근
 * re_pending을 찾아 그 SHA로 표시하면 된다(뒤이은 published가 있어도 그 사유는 여전히 유효).
 *
 * 실패/빈 응답은 침묵(옵션 정보라 카드 붕괴 X) — 이 신호가 evidence 판정(gateHasEvidence)에
 * 관여하지 않는 이유이기도 하다(로드 전/실패 시에도 카드가 이미 유효한 GithubCheckSignal로
 * State B/C에 들어가 있어야 함).
 */
function GithubRependingReason({ gateId }: { gateId: string }) {
  const t = useTranslations('cage');
  const [repending, setRepending] = useState<GithubCheckLedgerEvent | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/gates/${gateId}/github-check-events`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((events: GithubCheckLedgerEvent[]) => {
        if (!cancelled) setRepending(events.find((e) => e.event_type === 're_pending') ?? null);
      })
      .catch(() => {
        if (!cancelled) setRepending(null);
      });
    return () => { cancelled = true; };
  }, [gateId]);

  if (!repending) return null;

  return (
    <p className="mt-1 text-[11px] text-muted-foreground">
      {repending.prior_sha
        ? t('githubCheckRependingReasonWithPrior', { priorSha: repending.prior_sha.slice(0, 7), newSha: repending.head_sha.slice(0, 7) })
        : t('githubCheckRependingReason', { newSha: repending.head_sha.slice(0, 7) })}
    </p>
  );
}

// story #2975 AC4(PO 확定 2026-08-24) — backend/app/routers/gates.py GateActivityItem과 정합.
interface GateActivityLogItem {
  id: string;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  context: Record<string, unknown>;
  created_at: string;
}

// action(BE ActivityLog.action 원문, gate_service.py) → i18n 키. 매핑에 없는 action은 원문 그대로
// 폴백 렌더(신규 action 추가 시 이 화면이 죽는 대신 정직하게 raw string을 보여줌 — no-fiction).
const GATE_ACTIVITY_LABEL_KEY: Record<string, string> = {
  gate_approved: 'gateActivityActionApproved',
  gate_rejected: 'gateActivityActionRejected',
  gate_resolution_undone: 'gateActivityActionUndone',
  gate_voided: 'gateActivityActionVoided',
  gate_overridden: 'gateActivityActionOverridden',
  // story #3806(Phase3·3-2 PR 12, 페드루 PO 실측 캡처 2026-09-11 18:16Z) —
  // refresh_ads_boost_spend_now(ads_spend_snapshots.py)가 남기는 액션. 매핑
  // 누락 시 raw 키가 그대로 노출되던 걸 실 캡처로 적발.
  ads_spend_refresh_requested: 'gateActivityActionAdsSpendRefreshRequested',
  // story #3806(Phase3·3-2 PR 14, 페드루 PO 確定 2026-09-11 19:52Z) —
  // process_one_ads_boost_command 실행 성공 지점 신설 액션(ads_boost_execution.py
  // ::_ACTIVITY_ACTION_BY_OP). ads_boost_paused는 scheduler+cap_reached 조합일
  // 때만 아래 adsBoostActivityLabel()이 별도 문구로 덮어쓴다(이 맵은 그 기본값).
  ads_boost_started: 'gateActivityActionAdsBoostStarted',
  ads_boost_paused: 'gateActivityActionAdsBoostPaused',
  ads_boost_resumed: 'gateActivityActionAdsBoostResumed',
  // story #4262(유나 표) — newsletter_send_execution.py `_ACTIVITY_ACTION_SEND_*`가 남기는 액션. 원시 문자열이 그대로 보였다.
  newsletter_send_succeeded: 'gateActivityActionNewsletterSendSucceeded',
  newsletter_send_failed: 'gateActivityActionNewsletterSendFailed',
};

// story #3806(Phase3·3-2 PR 14) — ads_boost_paused 한 action이 두 얼굴이다: 사람이
// 「중지」를 눌렀거나(일반 문구), 상한 도달로 scheduler가 자동 중지했거나(별도 문구
// — 사용자가 "왜 멈췄는지" 화면에서 바로 읽어야 한다는 게 이 PR의 존재 이유 그
// 자체). context는 BE가 이미 실어 보낸다(ads_boost_execution.py::activity_context
// — {initiated_by, reason?}), 여기서 새로 지어내지 않는다.
function adsBoostActivityLabel(item: GateActivityLogItem, t: ReturnType<typeof useTranslations>): string | null {
  if (item.action !== 'ads_boost_paused') return null;
  if (item.context['initiated_by'] === 'scheduler' && item.context['reason'] === 'cap_reached') {
    return t('gateActivityActionAdsBoostAutoPausedCapReached');
  }
  return null;
}

/**
 * story #2975 AC4(PO 확定 2026-08-24) — 「누가·언제·무엇을·어느 SHA에」 결재했는지. 2026-08-23
 * 두 실사고(PR#3402 취소 반영 여부 판별 불가·PR#3406 approved의 actor 판별 불가)의 근본원인이
 * 이 표면 부재였다 — `GET /api/gates/{id}/activity`(github-check-events와 대칭)를 최신순 지연
 * 로드. 실패/빈 응답은 GithubRependingReason과 동형으로 조용히(카드 붕괴 방지) — 단 성공+0건은
 * "이력 없음"을 정직하게 보여준다(신규 gate에서 당연한 상태와, 로드 실패를 구분).
 */
export function GateActivityHistory({ gateId, refreshKey }: { gateId: string; refreshKey?: number }) {
  const t = useTranslations('cage');
  const tc = useTranslations('common');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  const [items, setItems] = useState<GateActivityLogItem[] | null>(null);

  // story #3806(Phase3·3-2 PR 12, 페드루 PO 실측 캡처 2026-09-11 18:16Z) — 「눌렀는데
  // 아무 일도 없었다」 결함 처방. 이 컴포넌트는 마운트 시 1회만 불러(원래 §2975 AC4
  // 계약) 형제 컴포넌트(BoostExecutionControl)의 뮤테이션을 반영할 방법이 없었다.
  // `refreshKey`가 바뀌면(부모가 뮤테이션 성공 뒤 증가) 재조회 — 상세페이지
  // key-remount 표준(reference-detail-page-key-remount-standard)과 같은 사상,
  // 여기선 컴포넌트 전체를 remount하는 대신 이 훅 안에서 재요청만 한다(activity
  // 목록 자체 상태는 유지할 이유가 없어 remount와 결과는 동일).
  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/gates/${gateId}/activity`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((data: unknown) => {
        // BE는 bare array를 낸다(github-check-events와 대칭, {data} 봉투 아님) — 방어적으로
        // 배열이 아니면(테스트 mock의 범용 폴백 등) 빈 목록으로 조용히 폴백(카드 붕괴 방지).
        if (!cancelled) setItems(Array.isArray(data) ? (data as GateActivityLogItem[]) : []);
      })
      .catch(() => {
        if (!cancelled) setItems(null);
      });
    return () => { cancelled = true; };
  }, [gateId, refreshKey]);

  if (items === null) return null;
  // [SID:4311 PR 3] 활동 줄의 행위자 — 같은 이름 서로 다른 구성원 둘이면 «· ID 앞 8자»(행위자 id마다 한 번 · 불러온 줄 안에서만).
  // 이름 있으면 이름 · 행위자 있는데 이름 빔 = «이름 없는 구성원»(#4284) · 행위자 없음 = 기존 폴백 그대로.
  const actorLabel = (item: GateActivityLogItem) => item.actor_name || (item.actor_id ? memberDisplayLabel(null, tc) : t('gateActivityActorFallback'));
  const actorLabels = actorRowLabels(items.map((item) => ({ id: item.actor_id, label: item.actor_id ? actorLabel(item) : null })));

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{t('gateActivityHistoryTitle')}</p>
      {items.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">{t('gateActivityEmpty')}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => {
            const sha = typeof item.context['head_sha'] === 'string' ? (item.context['head_sha'] as string) : null;
            const labelKey = GATE_ACTIVITY_LABEL_KEY[item.action];
            const adsBoostLabel = adsBoostActivityLabel(item, t);
            return (
              <li key={item.id} className="text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{(item.actor_id ? actorLabels.get(item.actor_id) : undefined) ?? actorLabel(item)}</span>
                {' · '}
                {adsBoostLabel ?? (labelKey ? t(labelKey) : item.action)}
                {sha ? <span className="ml-1 font-mono">{t('githubCheckShaLabel', { sha: sha.slice(0, 7) })}</span> : null}
                {/* story #3493 — 게이트 활동 로그 항목은 "기록"(정본 formatRelativeTime). */}
                <span className="ml-1">· {formatRelativeTime(item.created_at, locale, displayTimezone)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// read-only PR 칩(gate State C 납품 컬럼). 관리는 story 상세 PrLinkSection — 여기선 표시·새탭 링크만.
function GatePrChip({ pr }: { pr: PrLinkFact }) {
  return (
    <a
      href={`https://github.com/${pr.repo_full_name}/pull/${pr.pr_number}`}
      target="_blank"
      rel="noopener noreferrer"
      title={pr.repo_full_name}
      className="inline-flex max-w-full items-center"
    >
      <Badge variant={pr.link_source === 'explicit' ? 'default' : 'outline'} className="shrink-0 gap-1 hover:underline">
        <GitPullRequest className="size-3 shrink-0" />#{pr.pr_number}
      </Badge>
    </a>
  );
}

const DRAFT_TARGET_LABEL_KEY: Record<HypothesisDraftTarget, string> = {
  verified: 'hypothesisDraftTargetVerified',
  falsified: 'hypothesisDraftTargetFalsified',
  killed: 'hypothesisDraftTargetKilled',
};

/**
 * story #2862(2857 FE 조각) — «측정 판정 초안» 렌더. AC1: 초안 attribution=info 톤(제안≠확定
 * — 확정처럼 보이면 도장 찍는 손이 빨라진다) — verified/falsified라도 success/destructive를
 * 쓰지 않고 전부 info 하나로 통일한다. AC2: 승인 전엔 «검증됨» 같은 확정 어휘를 안 쓰고
 * "맞음(초안)"류 잠정 어휘만 쓴다. AC3: draft_reason을 항상 병기 — 근거 없이 판정만 보이면
 * §4가 경계하는 위조 채널의 UI판이 된다(그래서 없으면 "없음"을 정직하게 말한다, 지어내지
 * 않음).
 */
function HypothesisOutcomeDraft({ draft }: { draft: HypothesisOutcomeDraftFacts }) {
  const t = useTranslations('cage');
  return (
    <div className="mt-1.5 rounded-lg bg-info/10 px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="info" className="shrink-0">{t('hypothesisDraftBadge')}</Badge>
        {/* story #2420 규칙 — tint 배경 위 글자는 계열색이 아니라 text-foreground. */}
        <span className="text-[11.5px] font-medium text-foreground">{t(DRAFT_TARGET_LABEL_KEY[draft.target])}</span>
        {draft.actual !== null ? (
          <span className="text-[11px] text-foreground">{t('hypothesisDraftActual', { value: String(draft.actual) })}</span>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] text-foreground">
        {draft.reason ? t('hypothesisDraftReason', { reason: draft.reason }) : t('hypothesisDraftReasonMissing')}
      </p>
    </div>
  );
}

/**
 * story #3328 — 레시피 approve 게이트의 승인 대상 실물. work item·draft doc 참조 토큰은
 * EntityChip(entity-ref.ts SSOT 파서 재사용, 채팅과 같은 렌더러)로 클릭 가능하게. 요약은
 * 기본 접힘(카드 공간 절약, AC1 "접기 가능") — 없는 필드는 그냥 생략(지어내지 않음).
 *
 * ⚠️PO 변경요청②(2026-09-02, PR#3710 리뷰) — story #2420 규칙(HypothesisOutcomeDraft와
 * 동일 근거, 위 참조): tint 배경(bg-muted/40) 위에서는 실 값(stage·channel)을 라벨과
 * 같은 muted 톤으로 두지 않고 text-foreground로 — 두 톤이 겹치면 값이 라벨에 묻힌다.
 * 라벨(필드명)만 muted 유지. WCAG 대비비 실측(globals.css --proof-ink/-ink-3/-sunk 기반,
 * bg-muted/40을 카드/페이지 배경에 블렌드): text-foreground 16.2~17.4:1(라이트·다크 공통)
 * vs 기존 text-muted-foreground 5.1~5.9:1(AA 4.5:1은 이미 통과하던 값이라 접근성 위반은
 * 아니었으나, 값과 라벨의 시각적 위계가 안 갈렸다 — #2420과 동형 근거로 값을 승격).
 */
// story #4090 AC3 정정(story #3779 BE 한글 사용자 문장 가드, 2026-09-21) — BE
// gate.publish_outcome은 닫힌 어휘 코드(no_channel_binding|no_submitted_draft|
// no_resolver|published|scheduled|publish_failed:*)를 저장한다(한글 완성 문장 아님,
// channel_posts.py 주석과 동일 규율) — 이 함수가 코드→locale 문구로 번역한다.
function publishOutcomeLabel(code: string, t: ReturnType<typeof useTranslations>): string {
  if (code === 'published') return t('publishOutcomePublished');
  // story #4142(페드루 PO 처방, 2026-09-22) — 비동기 컨테이너(REELS 등)가 아직 완결
  // 안 됐을 때의 비최종 상태. "발행됨"과 명확히 갈라야 한다(이 카드가 «발행됨»을
  // 거짓으로 보여주던 실사고의 직접 처방).
  if (code === 'publishing') return t('publishOutcomePublishing');
  if (code === 'scheduled') return t('publishOutcomeScheduled');
  if (code === 'no_channel_binding') return t('publishOutcomeNoChannel');
  if (code === 'no_submitted_draft') return t('publishOutcomeNoDraft');
  if (code === 'no_resolver') return t('publishOutcomeNoResolver');
  if (code.startsWith('publish_failed:')) {
    // story #4090/#4093 정정(페드루 PO 지적 2026-09-21) — 꼬리(연결 원인)도 닫힌
    // 어휘(connector_error|rate_limited|auth_expired, channel_posts.py::classify_
    // publish_failure_outcome)라 그 코드도 각자 번역한다(커넥터 원문 미노출).
    const failureCode = code.slice('publish_failed:'.length);
    if (failureCode === 'auth_expired') return t('publishOutcomeFailedAuthExpired');
    if (failureCode === 'rate_limited') return t('publishOutcomeFailedRateLimited');
    // story #4264 — 앞 시도가 «나갔는지 모름»으로 멈춰 자동 발행이 다시 쏘지 않았다(generic «연결 확인»은 틀린 안내).
    if (failureCode === 'needs_check') return t('publishOutcomeFailedNeedsCheck');
    return t('publishOutcomeFailedGeneric');
  }
  // 미지 코드(구버전 응답 등) — 지어내지 않고 원문 코드 그대로(사람이 읽기엔 어색해도
  // 침묵보다 낫다, «모른다≠다르다» 규율).
  return code;
}

/**
 * story #4098([E-RECIPE-1], 페드루 PO 確定 2026-09-21) — 레시피 unscoped external_
 * publish 게이트(scope_key="") 상세에 "이 승인으로 발행될 채널 초안" 실물 카드.
 * #4090 AC2로 이 게이트 승인=자동발행인데, 승인자가 실물(본문·이미지·영상·목적지·
 * 예약)을 안 보고 딸깍하던 자리를 해소한다. BE `linked_channel_draft`(null이면
 * `linked_channel_draft_pending`으로 이유를 가른다)만 읽는다 — FE가 값을 계산하지
 * 않는다(선택 규칙은 BE 한 곳, channel_posts.py::find_ready_recipe_channel_drafts).
 *
 * ⛔페드루 PO 지적(PR #4475 리뷰, 2026-09-21) — 그 시점엔 `draft.scoped_gate_status`가
 * `linked_channel_draft` non-null인 이상 항상 "approved"뿐이라 "pending" 분기가 죽은
 * 코드였다(제거, linkedChannelDraftScopedPending 키도 같이).
 *
 * story #4143(2호 리허설 실측, 페드루 PO 確定 2026-09-22) — 채널 초안의 scoped
 * external_publish 게이트(이 카드가 쥔 그 초안 자신) 상세·인박스에서 영상 0건·
 * 이미지 0건으로 보이던 결함. BE가 이제 scoped 게이트 응답에도 같은 `linked_
 * channel_draft`(BE `_enrich_scoped_channel_draft_media`, #4098과 동일 직렬화
 * 재사용)를 싣는다 — 이 컴포넌트를 scoped 게이트에도 그대로 재사용한다(두 번째
 * 렌더러 0). 「제출 없음/초안 승인 대기」 두 문구(아래)는 **레시피 게이트 전용**
 * (이 승인이 다른 게이트의 승계를 기다린다는 뜻)이라 scoped 게이트엔 의미가 안
 * 맞는다 — scoped 게이트는 `isRecipeGate=false`로 그 분기를 건너뛴다(그 문구를
 * 고치는 게 아니라 애초에 그 게이트 종류에 안 나오게 — 안 나오는 문장을 고치면
 * 헛손질이라는 페드루 PO 지적 그대로).
 *
 * ⚠️정정(story #4139, 페드루 PO 確定 2026-09-22) — find_ready_recipe_channel_drafts가
 * 이제 단일-목적지 pending scoped 게이트도 ready에 넣는다(레시피 게이트 승인 즉시
 * #4069/#4139 캐스케이드로 자동 승계-승인될 대상이라 승인자가 미리 실물을 볼 자격이
 * 있다 — 「승인해도 발행되지 않아요」거짓 경고 제거). 그래서 `scoped_gate_status`가
 * "pending"인 채로도 이 카드가 뜰 수 있다 — 이 컴포넌트는 그 값 자체를 안 읽으므로
 * (draft가 non-null이면 무조건 미리보기 렌더) 새 분기가 불필요하다, 위 문단만 사실
 * 정정용으로 남긴다.
 */
function LinkedChannelDraftCard({ gate, isRecipeGate }: { gate: GateItem; isRecipeGate: boolean }) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('cage');
  const draft = gate.linked_channel_draft;

  if (!draft) {
    if (!isRecipeGate) {
      // scoped 게이트: 드물게 draft_id가 유실됐거나(구버전 데이터) 초안이 지워진
      // 경우 — 지어낼 실물이 없다. 위 목적지 줄(RecipeApprovalFactsBlock)이 이미
      // 텍스트 메타는 보여주므로 이 카드는 조용히 생략한다(«모른다≠다르다» — 없는
      // 걸 있다고 안 하되, 레시피 전용 "승인해도 발행 안 됨" 문구를 억지로 빌리지도
      // 않는다).
      return null;
    }
    // story #4105(#4098 잔여, 페드루 PO 실측 2026-09-21) — find_ready_recipe_channel_
    // drafts는 «scoped 승인 済·미발행» 초안만 ready에 담는다(#4090 자동발행 대상
    // 정의) — 이미 승인돼 발행이 끝난 게이트에서도 항상 빈 목록이라 linked_channel_
    // draft가 null이 된다. status를 안 보면 "승인해도 발행되지 않아요"가 이미 발행된
    // 게이트에도 뜨는(다른 세계의 문장) 그 결함. pending일 때만 이 두 문구(제출 없음/
    // scoped 게이트 대기)가 유효하다.
    //
    // ⛔페드루 PO CHANGES(PR #4481 리뷰) — 비-pending 게이트에서 publish_outcome
    // 라벨을 여기서 또 그리면 같은 화면의 RecipeApprovalFactsBlock(facts.publishOutcome,
    // 아래 913행)이 이미 «발행 결과 · {라벨}»로 그린 것과 완전히 같은 값이 한 줄 더
    // 뜬다(같은 원천, gate.publish_outcome을 두 컴포넌트가 각자 렌더) — facts 블록이
    // 정본이라 이 카드는 비-pending이면 아무것도 안 그린다(중복 제거, 지어내지 않는다
    // 원칙의 반대급부 — "같은 사실을 두 번 말하지 않는다"도 같은 원칙).
    if (gate.status !== 'pending') {
      return null;
    }
    // story #4190(유나 빈 상태 절 · PO 12:17Z) — 대기 문구는 채널·블로그 공용(기존 키 재사용). «없음» 문구는 BE
    // `linked_draft_kind`(레시피 정의 capability 판별)로만 고른다 — 모르는 레시피(null)는 중립 문구.
    const pending = gate.linked_channel_draft_pending || gate.linked_site_draft_pending;
    return (
      <p className="mt-1.5 text-[11.5px] text-muted-foreground">
        {pending ? t('linkedChannelDraftPending')
          : gate.linked_draft_kind === 'channel_post' ? t('linkedChannelDraftNone')
          : gate.linked_draft_kind === 'site_post' ? t('linkedSiteDraftNone')
          : t('linkedDraftNone')}
      </p>
    );
  }

  const destinationLabel = draft.account_label || `${draft.channel}(${draft.account_id})`;

  return (
    <div className="mt-1.5 space-y-1.5 rounded border border-border/60 p-2 text-[11.5px]">
      <p className="text-muted-foreground">
        {t('linkedChannelDraftDestinationLabel')} · <span className="text-foreground">{destinationLabel}</span>
      </p>
      {draft.sealed_scheduled_at ? (
        <p className="text-muted-foreground">
          {t('linkedChannelDraftScheduledLabel')} ·{' '}
          <span className="text-foreground">{formatScheduledAt(draft.sealed_scheduled_at, resolveDisplayTimezone().tz).display}</span>
        </p>
      ) : null}
      <LinkedDraftVersionLine version={draft.version} />
      {draft.video_url ? (
        // 유나 design:CHANGES(PR #4475 리뷰, PO 確定) — object-cover가 9:16 릴스의 상·하
        // ~22%(훅·CTA)를 잘라 이 카드의 목적(실물 보고 승인)과 어긋났다. 채널 영상 aspect가
        // 혼재(릴스 9:16·피드 1:1/4:5/16:9)라 세로 고정 대신 object-contain(레터박스 면은
        // bg-muted)으로 크롭 0.
        <video
          controls preload="metadata" src={draft.video_url}
          className="max-h-64 w-auto max-w-full rounded bg-muted object-contain" data-testid="linked-channel-draft-video"
        />
      ) : draft.image_urls.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {draft.image_urls.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- content/[draftId] 동형 관례(외부 GCS URL).
            <img key={i} src={url} alt={t('linkedChannelDraftImageAlt')} className="h-20 w-20 rounded object-cover" />
          ))}
        </div>
      ) : null}
      {draft.text ? (
        <p className="whitespace-pre-wrap text-foreground">{draft.text}</p>
      ) : null}
      <a
        href={flatHref(`/content/channel-posts/${draft.draft_id}`)}
        className="inline-block text-[11px] text-primary underline underline-offset-2"
      >
        {t('linkedChannelDraftOpenLink')}
      </a>
    </div>
  );
}

/** story #4190(유나 site 초안 카드) — «버전 · v{n}». 채널·블로그 카드가 같이 그린다 — 이 카드가 그린 버전이 «본 버전»이고
 * 승인 요청이 그대로 돌려보낸다(gate-risk.ts reviewedDraftOf). 409 뒤 재조회하면 번호가 바뀌는 걸 눈으로 확인한다. */
function LinkedDraftVersionLine({ version }: { version: number }) {
  const t = useTranslations('cage');
  return (
    <p className="text-muted-foreground" data-testid="linked-draft-version">
      {t('linkedDraftVersionLabel')} · <span className="text-foreground">{t('productionWorkbenchVersionRef', { v: version })}</span>
    </p>
  );
}

/**
 * story #4190(PO 판정 2026-09-23 12:03Z · 유나 site 초안 카드) — `LinkedChannelDraftCard`의 블로그(site) 형제. 같은 틀·
 * 크기·링크, 레시피 게이트에만. BE `linked_site_draft`만 읽는다(어느 카드인지 BE가 가른다 — FE는 목적지 문자열로 추정하지
 * 않는다). 목적지 줄은 외부 블로그일 때만(자사 블로그는 위 레시피 사실 블록이 이미 말한다). 본문은 BE가 마크다운 기호를
 * 걷은 평문 앞부분 — FE는 파싱하지 않는다. 요약·태그·언어는 넣지 않는다(«초안 열기»에서 본다).
 * 초안이 없을 때의 빈 상태는 채널 카드가 그린다(레시피 게이트엔 두 카드 중 하나만 그려진다).
 */
function LinkedSiteDraftCard({ gate }: { gate: GateItem }) {
  const t = useTranslations('cage');
  const flatHref = useFlatHref(); // story #4226 — flat 링크 `?p=`
  const draft = gate.linked_site_draft;
  if (!draft) return null;
  const destinationLabel = draft.channel
    ? draft.account_label || `${draft.channel}(${draft.account_id ?? ''})`
    : null;
  return (
    <div className="mt-1.5 space-y-1.5 rounded border border-border/60 p-2 text-[11.5px]" data-testid="linked-site-draft">
      {destinationLabel ? (
        <p className="text-muted-foreground">
          {t('linkedChannelDraftDestinationLabel')} · <span className="text-foreground">{destinationLabel}</span>
        </p>
      ) : null}
      {draft.sealed_scheduled_at ? (
        <p className="text-muted-foreground">
          {t('linkedChannelDraftScheduledLabel')} ·{' '}
          <span className="text-foreground">{formatScheduledAt(draft.sealed_scheduled_at, resolveDisplayTimezone().tz).display}</span>
        </p>
      ) : null}
      <LinkedDraftVersionLine version={draft.version} />
      <p className="break-keep text-xs font-semibold text-foreground">{draft.title}</p>
      {draft.body_preview ? (
        <p className="line-clamp-4 min-w-0 break-words text-foreground">{draft.body_preview}</p>
      ) : null}
      <a
        href={flatHref(`/content/${draft.draft_id}`)}
        className="inline-block text-[11px] text-primary underline underline-offset-2"
      >
        {t('linkedChannelDraftOpenLink')}
      </a>
    </div>
  );
}

function RecipeApprovalFactsBlock({ facts }: { facts: RecipeApprovalFacts }) {
  const t = useTranslations('cage');
  const tContent = useTranslations('content');
  // story #4082(유나 design CHANGES 2026-09-21) — approvals-queue.tsx·gates/[id]/page.tsx와
  // 동일 SSOT(organization 네임스페이스)로 stage 낱말을 통일(raw slug 노출 0).
  const tOrg = useTranslations('organization');
  // story #3742(디디, 근본 처방) — channelLabel()의 표시명 키는 channelConnect
  // 네임스페이스 하나가 정본(useChannelLabel 훅이 내부에서 고정) — 예전엔 content ns에
  // 복제해 두고 cage가 tContent를 넘겨 그 복제분을 썼다(#3367 주석 정정).
  const channelLabel = useChannelLabel();
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-1.5 space-y-1 rounded-lg bg-muted/40 px-2.5 py-1.5 text-[11.5px]">
      {/* story #3806(Phase3·3-2 PR5, 유나 §절 §1 「결재 카드 봉인 5필드」) — 총예산·기간·
          목표 순서 그대로(통화는 총예산 표시에 붙는다, §절 표 그대로). ads_boost가
          아닌 gate_type은 adsBudgetMinor가 항상 null이라 이 블록 자체가 안 그려진다. */}
      {facts.adsBudgetMinor !== null ? (
        <div className="space-y-0.5">
          <p>
            <span className="text-muted-foreground">{t('adsBoostBudgetLabel')} · </span>
            <span className="text-foreground font-medium">
              {facts.adsCurrency
                ? formatMinorCurrency(facts.adsBudgetMinor, facts.adsCurrency as GenerationBudgetCurrency, locale, tContent)
                : facts.adsBudgetMinor}
            </span>
          </p>
          {facts.adsStartsAt && facts.adsEndsAt ? (
            <p>
              <span className="text-muted-foreground">{t('adsBoostScheduleLabel')} · </span>
              <span className="text-foreground">
                {formatScheduledAt(facts.adsStartsAt, displayTimezone).display}
                {' ~ '}
                {formatScheduledAt(facts.adsEndsAt, displayTimezone).display}
                {' '}
                ({t('adsBoostScheduleDays', {
                  days: Math.round(
                    (new Date(facts.adsEndsAt).getTime() - new Date(facts.adsStartsAt).getTime()) / 86_400_000,
                  ),
                })})
              </span>
            </p>
          ) : null}
          {facts.adsObjective ? (
            <p>
              <span className="text-muted-foreground">{t('adsBoostObjectiveLabel')} · </span>
              <span className="text-foreground">{adsBoostObjectiveLabel(facts.adsObjective, tContent)}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {/* story #4072(E-RECIPE-1, 페드루 PO 確定 2026-09-19·카디르 QA③ CHANGES) —
          generation_budget 전용 sealing. ads_boost 블록과 동일 선례(이 gate_type이
          아니면 estimatedCostMinor는 항상 null). 통화는 neutral_facts.currency가
          실 있을 때만 formatMinorCurrency로 라벨(위 facts 타입 주석).
          story #4138(페드루 PO, 2026-09-22 01:14Z 실측 — 2호 게이트 3에 currency 키
          자체가 없어(댄의 structure_passed 발행 페이로드 미포함) 「4000」이 통화·천 단위
          구분·소수 표기 0으로 그대로 찍혔다) — currency가 없으면 원값(minor 그대로, 손
          구현 콤마 금지, formatMinorCurrency의 자매 함수 formatCount로 천 단위 구분만)
          + «통화 미확인» 보조 표기(거짓 단위 0 — KRW/USD로 지어내지 않는다). */}
      {facts.estimatedCostMinor !== null ? (
        <div className="space-y-0.5">
          <p>
            <span className="text-muted-foreground">{t('generationBudgetSealedCostLabel')} · </span>
            <span className="text-foreground font-medium">
              {facts.estimatedCostCurrency
                ? formatMinorCurrency(facts.estimatedCostMinor, facts.estimatedCostCurrency, locale, tContent)
                : formatCount(facts.estimatedCostMinor, locale)}
            </span>
            {!facts.estimatedCostCurrency && (
              <span className="text-muted-foreground"> · {t('generationBudgetSealedCostCurrencyUnknown')}</span>
            )}
          </p>
          {/* story #4085 AC4-B(3호 라이브 실측 2026-09-22, 페드루 PO 처방) — 스모크
              #4167에서 «예상 비용»까지는 통화가 뜨는데 org 예산 한도/사용/잔여가
              FE 어디에도 안 그려짐(grep 0)이 실측됨. 셋이 다 있을 때만 한 줄
              추가(currency도 같은 if-블록에서 함께 실려 항상 같이 있음 — 위
              estimatedCostCurrency 재사용, 새 null 처리 축 0). 셋 중 하나라도
              없으면(구버전 게이트·org 예산 규칙 미등록) 이 줄 자체를 안 그려
              기존 «통화 미확인» 표기만 무변으로 남긴다. */}
          {facts.budgetLimitMinor !== null && facts.budgetSpentMinor !== null && facts.budgetRemainingMinor !== null
            && facts.estimatedCostCurrency ? (
            <p className="text-muted-foreground">
              {t('generationBudgetStatusLine', {
                limit: formatMinorCurrency(facts.budgetLimitMinor, facts.estimatedCostCurrency, locale, tContent),
                spent: formatMinorCurrency(facts.budgetSpentMinor, facts.estimatedCostCurrency, locale, tContent),
                remaining: formatMinorCurrency(facts.budgetRemainingMinor, facts.estimatedCostCurrency, locale, tContent),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
      {/* story #3813(Phase3·3-4 PR4, 페드루 PO 確定 2026-09-12) — newsletter_send 전용
          sealing. ads_boost 블록과 동일 선례 — 이 gate_type이 아니면 두 필드 다 null이라
          블록 자체가 안 그려진다. 「예상 수신」은 봉인값이 아니라 어댑터 조회(위 facts
          타입 주석) — null이면 지어내지 않고 「미확인」. */}
      {facts.newsletterSegmentName !== null || facts.newsletterSendScheduledAt !== null || facts.newsletterSubject !== null ? (
        <div className="space-y-0.5">
          {/* 페드루 PO CHANGES(2026-09-12, 라이브 캡처 실측) — 「무엇을」 보내는지가
              세그먼트·시각·수신수보다 먼저 서야 사람이 승인 전에 그것부터 본다. */}
          <p>
            <span className="text-muted-foreground">{t('newsletterSubjectLabel')} · </span>
            <span className="text-foreground font-medium">
              {facts.newsletterSubject ?? t('newsletterSubjectUnknown')}
            </span>
          </p>
          {facts.newsletterSegmentName ? (
            <p>
              <span className="text-muted-foreground">{t('newsletterSegmentLabel')} · </span>
              <span className="text-foreground font-medium">{facts.newsletterSegmentName}</span>
            </p>
          ) : null}
          {facts.newsletterSendScheduledAt ? (
            <p>
              <span className="text-muted-foreground">{t('newsletterSendScheduleLabel')} · </span>
              <span className="text-foreground">{formatScheduledAt(facts.newsletterSendScheduledAt, displayTimezone).display}</span>
            </p>
          ) : null}
          <p>
            <span className="text-muted-foreground">{t('newsletterEstimatedRecipientLabel')} · </span>
            <span className="text-foreground font-medium">
              {facts.newsletterEstimatedRecipientCount !== null
                ? t('newsletterEstimatedRecipientCount', {
                    // 페드루 PO CHANGES(2026-09-12, CI 실측) — 숫자에 붙는 로케일
                    // 메서드는 메서드명만으로 날짜 호출과 구분이 안 돼 verify-no-date-
                    // tolocalestring 가드(story #3493)에 걸린다(가드는 주석 문자열도
                    // 그대로 grep한다, 이 주석 자체가 그 예시였다 — 재발 방지로 그
                    // 메서드명을 여기 다시 안 적는다). formatMinorCurrency와 동일
                    // 정본(Intl.NumberFormat 직접)으로 정정.
                    // story #4223 — en 복수형(ICU plural)은 숫자 값이어야 한다(문자열이면 형식 오류). 자리 구분은 ICU `#`가 로케일로 한다.
                    count: facts.newsletterEstimatedRecipientCount,
                  })
                : t('newsletterRecipientUnknown')}
            </span>
          </p>
        </div>
      ) : null}
      {facts.stage ? (
        <p>
          <span className="text-muted-foreground">{t('recipeApprovalStageLabel')} · </span>
          <span className="text-foreground">
            {recipeStageLabel(facts.stage, tOrg)}
            {facts.stageRole ? ` (${stageRoleLabel(facts.stageRole, tOrg)})` : ''}
          </span>
        </p>
      ) : null}
      {facts.publishOutcome ? (
        <p>
          <span className="text-muted-foreground">{t('recipeApprovalPublishOutcomeLabel')} · </span>
          {facts.publishOutcome === 'publish_failed:needs_check' && !facts.publishOutcomeDraftHref ? (
            <span className="text-foreground">{t('publishOutcomeFailedNeedsCheckNoLink')}</span>
          ) : (
            <span className="text-foreground">{publishOutcomeLabel(facts.publishOutcome, t)}</span>
          )}
          {facts.publishOutcome === 'publish_failed:needs_check' && facts.publishOutcomeDraftHref ? (
            <>
              {' · '}
              <a
                href={facts.publishOutcomeDraftHref}
                className="text-primary underline underline-offset-2"
                data-testid="recipe-publish-outcome-needs-check-draft-link"
              >
                {t('linkedChannelDraftOpenLink')}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {facts.workItemRef ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">{t('recipeApprovalWorkItemLabel')}</span>
          <EntityChip
            entityType={facts.workItemRef.entityType}
            entityId={facts.workItemRef.entityId}
            label={facts.workItemRef.label}
            href={facts.workItemRef.href}
          />
        </div>
      ) : null}
      {facts.draftDocRef ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">{t('recipeApprovalDraftLabel')}</span>
          <EntityChip
            entityType={facts.draftDocRef.entityType}
            entityId={facts.draftDocRef.entityId}
            label={facts.draftDocRef.label}
            href={facts.draftDocRef.href}
          />
        </div>
      ) : null}
      {facts.channel ? (
        <p>
          <span className="text-muted-foreground">{t('recipeApprovalChannelLabel')} · </span>
          <span className="text-foreground">{facts.channel}</span>
        </p>
      ) : null}
      {facts.draftDocSummary ? (
        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground underline underline-offset-2"
          >
            {expanded ? t('recipeApprovalSummaryCollapse') : t('recipeApprovalSummaryExpand')}
          </button>
          {expanded ? (
            <p className="mt-1 whitespace-pre-wrap text-foreground">{facts.draftDocSummary}</p>
          ) : null}
        </div>
      ) : null}
      {/* story #3599(유나 §22-17 ⑥-4, PO 決 2026-09-07·조건 갱신 2026-09-07) —
          sealed_content_version이 null인데 봉인 본문은 있는 행(scope_key가
          comment_id 단위였던 옛 comment_reply 게이트 — 마이그레이션 0, 그대로
          둔다는 §5 판정)은 「쌍」이 안 서 대조 불가하다. 「덮였습니다」로 단정
          하지 않는다(못 대조하는 게이트 중엔 한 번 승인되고 끝난 정상 옛 행도
          있다) — 아는 것만 말한다: 「확인할 수 없다」. isResolved = status가
          approved|rejected|auto_passed 중 하나(명시 열거) 한정 — resolved_at은
          판별 키가 아니다(void_gate도 resolved_at을 채운다, gate_service.py:1592
          그라운딩 確認). held(판단 자체 없음)·voided(판단이 아니라 행정
          무효화)는 이 열거에 없어 자동 제외. 이 자리
          (버전·해시 줄)를 대신할 뿐 줄을 새로 만들지 않는다. */}
      {facts.contentVersion === null && facts.contentBody && facts.isResolved ? (
        <p className="text-muted-foreground">{t('recipeApprovalSealedVersionMissing')}</p>
      ) : facts.contentVersion !== null || facts.contentSha256 ? (
        <p className="font-mono text-muted-foreground">
          {facts.contentVersion !== null ? `${t('recipeApprovalVersionLabel')} v${facts.contentVersion}` : null}
          {facts.contentVersion !== null && facts.contentSha256 ? ' · ' : null}
          {facts.contentSha256 ? `${t('recipeApprovalSealedHashLabel')} ${facts.contentSha256.slice(0, 12)}…` : null}
        </p>
      ) : null}
      {/* story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04)/#4073(카디르 #4450
          QA④ 실측, 페드루 PO 確定 2026-09-19) — external_publish 예약 발행 봉인 축
          (contentVersion/contentSha256과 같은 선례 — 예약 없는 다른 gate_type은
          항상 null이라 이 줄 자체가 안 그려진다). newsletter_send의 동형 필드
          (newsletterSendScheduleLabel)는 이미 승인카드에 떴는데 external_publish만
          #4073 前엔 BE 응답스키마에 이 필드가 없어 항상 null이었다. */}
      {facts.scheduledAt ? (
        <p>
          <span className="text-muted-foreground">{t('recipeApprovalScheduledAtLabel')} · </span>
          <span className="text-foreground">{formatScheduledAt(facts.scheduledAt, displayTimezone).display}</span>
        </p>
      ) : null}
      {/* story #3367(3자기점검, 페드루 지적 2026-09-10·유나 CHANGES 정정) — AC7
          ("마지막 수정 주체·목적지를 확認할 수 있고"). 위 버전/해시 줄과 같은
          봉인 조건(contentVersion/contentSha256, site_posts·channel_posts 둘 다
          이 축을 채운다 — story #4143 재확認)에 묶는다 — 다른 gate_type엔 이 축
          자체가 없다(«모른다≠다르다»). 목적지가 커넥션(WordPress/webhook/채널
          연결)이면 uuid 원문을 승인자에게 보이지 않고 channelLabel()(집안 정본)로
          표시명을 낸다 — 표시명을 지어내지 않는다는 원칙은 이 헬퍼 자신이 이미
          지킨다(모르는 채널은 원문 그대로 폴백, uuid는 노출 안 함).
          ⛔story #4143(2호 리허설 실측, 페드루 PO 確定 2026-09-22) — destination
          ConnectionId===null을 "호스팅 블로그"로 *추정*하던 결함(채널 초안 게이트도
          이 컬럼이 안 채워지던 시절엔 우연히 같은 값이었다). destinationIsHostedSite
          (neutral_facts.destination==="hosted_site", BE SSOT 직접 대조)로 정정. */}
      {facts.contentVersion !== null || facts.contentSha256 ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
          <span>
            <span>{t('recipeApprovalLatestAuthorLabel')} · </span>
            <AuthorKindBadge kind={facts.latestAuthorKind} />
          </span>
          <span>
            {t('recipeApprovalDestinationLabel')} ·{' '}
            {facts.destinationIsHostedSite
              ? t('recipeApprovalDestinationHostedSite')
              : facts.destinationChannel
                ? channelLabel(facts.destinationChannel)
                // 연결이 삭제됐거나(드묾) enrich가 못 채운 예외 — uuid를 보이지
                // 않는다(유나 CHANGES 원칙), 표시명도 지어내지 않는다. "—"는 순수
                // 구두점(글자·숫자 0개, content.originAuthorUnknown과 동형 관례)이라
                // 새 낱말이 아니다.
                : '—'}
          </span>
        </p>
      ) : null}
      {/* story #3560(concept_approval, 페드루 PO 確定 2026-09-06) — 봉인 doc은
          contentBody(전문 펼침)와 달리 링크로만(doc 자체를 열어 편집 이력·서식을
          있는 그대로 본다) — 글자=doc 제목, 위 mono 배지와 같은 관례로 해시를 잇는다. */}
      {facts.sealedDocRef || facts.sealedDocBodySha256 ? (
        <div className="flex flex-wrap items-center gap-1 font-mono text-muted-foreground">
          {facts.sealedDocRef ? (
            <EntityChip
              entityType={facts.sealedDocRef.entityType}
              entityId={facts.sealedDocRef.entityId}
              label={facts.sealedDocRef.label}
              href={facts.sealedDocRef.href}
            />
          ) : null}
          {facts.sealedDocRef && facts.sealedDocBodySha256 ? <span>· </span> : null}
          {facts.sealedDocBodySha256 ? <span>{t('recipeApprovalSealedHashLabel')} {facts.sealedDocBodySha256.slice(0, 12)}…</span> : null}
        </div>
      ) : null}
      {facts.contentBody ? (
        // §6-3 "요약 → 전문" — draftDocSummary와 달리 접힘 없이 항상 전문을 보인다(승인자가
        // 무엇을 승인하는지 클릭 한 번 없이 바로 보여야 한다는 processing #3328 원칙의 연장).
        // story #3517(§22-⑤) — comment_reply 게이트에선 contentBody가 "답변 본문"이다
        // (Gate.sealed_content_body=reply.text, submit이 그대로 봉인).
        <p className="mt-1 whitespace-pre-wrap text-foreground">{facts.contentBody}</p>
      ) : null}
      {/* story #3517(유나 §22-⑤, BE #3867 조각②, PO 確定 2026-09-05) — 봉인 축 나머지
          둘: 대상 댓글 식별(target_external_comment_id, comment_reply 게이트에만
          존재)·「대상 댓글 본문」은 그라운딩 확認 갭이라 BE 후속(neutral_facts.
          target_text additive) 착지 전까지 "제공되지 않음"으로 정직하게 비운다(지어
          내지 않는다 — §22-2 결. 착지 뒤 이 자리가 자연히 채워진다, 호출부 변경 0). */}
      {facts.targetExternalCommentId ? (
        <div className="mt-1.5 space-y-1 border-t border-border pt-1.5">
          <p>
            <span className="text-muted-foreground">{t('commentReplyTargetLabel')} · </span>
            <span className="font-mono text-foreground">{facts.targetExternalCommentId}</span>
          </p>
          <div>
            <p className="text-[10px] font-medium text-muted-foreground">{t('commentReplyTargetTextLabel')}</p>
            <p className="whitespace-pre-wrap text-foreground">
              {facts.targetText ?? <span className="italic text-muted-foreground">{t('commentReplyTargetTextNotSealed')}</span>}
            </p>
          </div>
          {/* story #3599(유나 §22-17 ⑥-1, 페드루 PO 追加 2026-09-07·정정 2026-09-07) —
              답변 다이얼로그(content.commentsReplyAlreadySentCount)와 같은 사실·같은
              규율(수만·0이면 미표시)의 승인자 짝, 순서도 다이얼로그와 같게(본문 →
              이미 보낸 답변 N건). 이 사실은 이 답변이 아니라 그 댓글에 대한 것이라
              대상 댓글 블록 안에 선다(행이 아니라 이 카드가 지는 이유와 동형). */}
          {facts.alreadySentCount != null && facts.alreadySentCount > 0 ? (
            <p className="text-muted-foreground">{t('commentReplyAlreadySentCount', { count: facts.alreadySentCount })}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function GateEvidence({ gate, className }: { gate: GateItem; className?: string }) {
  const flatHref = useFlatHref(); // story #4231 3차 — 문서 근거 링크는 게이트의 프로젝트(현재 p)를 싣는다
  const t = useTranslations('cage');
  const decision = gateDecision(gate);
  const ci = ciResult(gate);
  const trust = trustScore(gate);
  const ghState = githubCheckState(gate);
  const ghSha = gate.github_check_run_sha ?? null;
  // story #2814 2단 AC② — 재-pending 이력이 있을 수 있는 상태(in_progress)에서만 원장을 지연 조회.
  const showRepending = ghState === 'in_progress';
  const selfReportOnly = gate.neutral_facts?.['self_report_only'] === true;
  const reason = gate.decision_basis ?? null; // 실 human reason만(auto_decision_reason echo 폴백 제거 — 배지가 이미 표시)
  // HO-S8 cold-start: 미확정 outcome은 "임시 예측"(keep/kill)으로만 — 판정/% 환원 절대 X.
  const coldStartSeed = gate.neutral_facts?.['cold_start_seed'] === true;
  const seedPrediction = gate.neutral_facts?.['seed_prediction'];
  const seedKey = seedPrediction === 'keep' ? 'seedKeep' : seedPrediction === 'kill' ? 'seedKill' : null;
  // E-GHAPP Bot-L.2: 연결 PR(read-only). BE가 neutral_facts.pr_links 채우면 렌더·없으면 omit(S3 원칙).
  const prLinks = Array.isArray(gate.neutral_facts?.['pr_links'])
    ? (gate.neutral_facts!['pr_links'] as PrLinkFact[]).filter((p) => p?.repo_full_name && typeof p?.pr_number === 'number')
    : [];
  // story #2862 — hypothesis_outcome_confirm 게이트는 ci/trust/cold_start_seed가 없어 항상
  // State B(부분증거)로 떨어진다 — rich(State C) 분기엔 안 걸리므로 거기는 안 건드린다.
  const draft = hypothesisOutcomeDraft(gate);
  // story #3328 — 레시피 approve 게이트도 동형(ci/trust/cold_start_seed 없음) — State B로.
  const recipeFacts = recipeApprovalFacts(gate, flatHref);

  const DecisionMark = decision ? DECISION_META[decision].mark : null;
  const decisionBadge = decision ? (
    <Badge variant={DECISION_META[decision].variant} className="shrink-0 gap-0.5">
      {DecisionMark ? <DecisionMark aria-hidden className="size-3" /> : null}
      {t(DECISION_META[decision].labelKey)}
    </Badge>
  ) : null;

  // ── State A · 빈 / 증거-없음: 배지 + 한 줄만(2열·CI·신뢰도·outcome·자기보고 전부 미표시·recede)
  if (!gateHasEvidence(gate)) {
    return (
      <div className={className}>
        {decisionBadge}
        <p className="mt-1.5 text-[11.5px] italic text-muted-foreground">{t('evidenceNonePrompt')}</p>
      </div>
    );
  }

  // ── State C · 실증거 충실: 납품 신호 AND 판단 신호 둘 다 → 납품|판단 2열 복귀(forward-compat·S5 슬롯)
  const rich = (ci !== null || trust !== null) && coldStartSeed;
  if (rich) {
    return (
      <div className={className}>
        {decisionBadge}
        {/* HO-S8 AC①: CI(납품·"통과했다") ↔ Outcome(판단·"옳았다") 2열 분리 — "통과≠옳음" 명시. */}
        <div className="mt-1.5 grid grid-cols-1 gap-2 text-[11.5px] sm:grid-cols-2 sm:gap-3">
          {/* 좌: 납품(delivery 신호 — 기계 검증). S5(GitHub앱) PR·AC·위험 슬롯 자리. */}
          <div className="space-y-0.5">
            <p className="text-[10px] font-medium text-muted-foreground">{t('deliveryColLabel')}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
              {ci !== null ? <CiSignal ci={ci} /> : null}
              {trust !== null ? <TrustValue trust={trust} selfReportOnly={selfReportOnly} /> : null}
              {ghState !== null ? <GithubCheckSignal state={ghState} sha={ghSha} /> : null}
              {/* Bot-L.2: 연결 PR(read-only·관리는 story 상세). 없으면 omit. AC·위험 슬롯은 후속. */}
              {prLinks.map((p, i) => <GatePrChip key={`${p.repo_full_name}#${p.pr_number}-${i}`} pr={p} />)}
            </div>
          </div>
          {/* 우: 판단("옳았다 판정"). gate엔 정밀 hit_rate 없음 → 임시 예측만(억지 % X). */}
          <div className="space-y-0.5">
            <p className="text-[10px] font-medium text-muted-foreground">{t('outcomeColLabel')}</p>
            <div className="text-muted-foreground">
              {seedKey ? (
                <Badge variant="chip" className="shrink-0">{t(seedKey)}</Badge>
              ) : (
                <span className="italic text-muted-foreground">{t('coldStartProvisional')}</span>
              )}
            </div>
          </div>
        </div>
        {showRepending ? <GithubRependingReason gateId={gate.id} /> : null}
        {reason ? (
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">{t('reasonLabel')} · {reason}</p>
        ) : null}
      </div>
    );
  }

  // ── State B · 부분증거: present-fact만 flowing 1줄(없는 건 빠짐·구분자 `·`는 양옆 항목 있을 때만)
  const facts: React.ReactNode[] = [];
  if (ci !== null) facts.push(<CiSignal ci={ci} />);
  if (trust !== null) facts.push(<TrustValue trust={trust} selfReportOnly={selfReportOnly} />);
  if (ghState !== null) facts.push(<GithubCheckSignal state={ghState} sha={ghSha} />);
  if (coldStartSeed && seedKey) facts.push(<Badge variant="chip" className="shrink-0">{t(seedKey)}</Badge>);

  return (
    <div className={className}>
      {decisionBadge}
      {facts.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
          {facts.map((node, i) => (
            <Fragment key={i}>
              {i > 0 ? <span aria-hidden className="text-muted-foreground">·</span> : null}
              {node}
            </Fragment>
          ))}
        </div>
      ) : null}
      {showRepending ? <GithubRependingReason gateId={gate.id} /> : null}
      {draft ? <HypothesisOutcomeDraft draft={draft} /> : null}
      {recipeFacts ? <RecipeApprovalFactsBlock facts={recipeFacts} /> : null}
      {/* 페드루 PO REQUIRED(PR #4475 리뷰) — BE와 같은 전제(레시피 게이트, neutral_
          facts.stage 실림 — BE 가드는 stage·triggered_by_event 둘 다 보지만 FE엔
          stage만 노출돼 있고 둘은 _build_approval_neutral_facts에서 항상 같이
          찍힌다)로 좁힌다. recipeFacts !== null만으로는 부족(sealed_content_* 등
          다른 축으로도 non-null이 될 수 있다 — 뮤테이션 실측으로 확認) — 비레시피
          unscoped external_publish 게이트에도 "승인해도 발행되지 않아요" 카드가
          새 다른 세계의 문장이 붙는다. BE가 두 필드를 기본값(null/false)으로 둘
          때 FE도 렌더 자체를 0으로.
          story #4143(2호 리허설 실측, 페드루 PO 確定 2026-09-22) — scoped 채널 초안
          게이트(scope_key≠"")도 이 카드를 탄다(BE가 이제 그쪽에도 linked_channel_
          draft를 싣는다, AC2 "편입 영상은 <video controls>") — isRecipeGate로
          레시피 전용 빈-상태 문구 분기만 가른다. */}
      {/* story #4190 — 레시피 게이트 판정은 gate-risk.ts isRecipePublishGate 하나(작업 목록·오늘 v3·원탭과 공유). 두 카드 중
          BE가 채운 하나만 그린다 — 블로그 카드가 있으면 채널 카드(빈 상태 문구 포함)는 그리지 않는다. */}
      {isRecipePublishGate(gate) ? (
        gate.linked_site_draft ? <LinkedSiteDraftCard gate={gate} /> : <LinkedChannelDraftCard gate={gate} isRecipeGate />
      ) : gate.gate_type === 'external_publish' && (gate.scope_key ?? '') !== '' ? (
        <LinkedChannelDraftCard gate={gate} isRecipeGate={false} />
      ) : null}
      {reason ? (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">{t('reasonLabel')} · {reason}</p>
      ) : null}
    </div>
  );
}

/**
 * story #4136(FE)·#4135(BE, 미르코) — 게이트 상세 «제작 산출물» 칸. 라이브 실측(2호 게이트
 * 1(concept_approval)·PO 세션, 2026-09-22 00:40Z)에서 지정 결재자가 아니면 이 칸에
 * gateReadonlyDesignatedElsewhere 한 줄뿐이었다 — 컨셉 브리프 doc·컨셉 보드 artifact·게이트
 * evidence 전부 카드 어디에도 안 보였다. 원인: 기존 productionWorkbenchSectionTitle 패널
 * (production-workbench-evidence.tsx)은 work-item 범위 훅(useWorkItemProductionEvidence)이
 * 0건이면 **조용히 null**을 반환한다(「없으면 비운다」 규율 — #4057 자체 설계 의도, 이 카드가
 * 건드리지 않는다). 이 컴포넌트는 그와 별개로 **게이트 자신의** neutral_facts.draft_doc_
 * reference_token + gate.linked_evidence[](#4135 신설, gate-scoped라 work-item 범위 오매칭
 * 문제가 구조적으로 없다)를 직접 렌더한다 — canAct/needsAction과 무관하게 항상 그려진다
 * (모든 열람자, 이 카드 AC1). 0건이면 명시적으로 «이 게이트에 등록된 산출물이 없어요»(거짓
 * 참조 0 — #3937 규율 그대로, 조용한 null 금지).
 *
 * ⚠️CHANGES-1(페드루 PO 지적, 2026-09-22 01:41Z) — "없음"과 "모름"을 가른다. BE가
 * linked_evidence 필드 자체를 아직 안 보내면(#4135 미배포·구버전 응답) "이 게이트에
 * 산출물이 없다"를 말할 근거가 없다 — 라이브 2호 게이트 1처럼 evidence·doc·artifact가
 * 실재하는데도 그 문장을 쓰면 거짓이 된다(#4055류와 같은 급의 "모르면 안다고 안 한다"
 * 규율). `Array.isArray(gate.linked_evidence)`가 참일 때만(BE가 `[]`든 항목이든 "답을
 * 한" 때만) 0건 claim 자격이 생긴다 — 배열 자체가 없고 draft_doc도 없으면 이 섹션은
 * **아예 안 그려진다**(과거 이 칸이 없던 것과 동형, #4135 배포 순서와 무관하게 안전).
 *
 * shape는 미르코군과 1:1 합의(2026-09-22 01:14Z) — kanban/types.ts GateItem.linked_evidence
 * 주석 참고. 핵심: linked_evidence[].kind는 doc/artifact 판별자가 아니라 evidence.payload.kind
 * (예: "concept_brief") — doc/artifact 판별은 reference_token을 parseReferenceToken()으로
 * 파싱한 entityType에서 나온다. reference_token은 nullable — null이면 "이 evidence는 확定
 * 대상이지만 실물 참조를 아직 못 찾음"이라는 정직한 신호라 항목 자체는 유지하되(조용히 빼면
 * "산출물이 아예 없다"로 오독) 클릭 불가한 kind 배지로만 표시한다(EntityChip이 아니라
 * Badge — 진짜로 갈 곳이 없다).
 *
 * ⚠️CHANGES-2(유나 design-pass, 2026-09-22 01:56Z, PR#4511 issuecomment-5770100618) — kind는
 * evidence.payload.kind **원문 snake_case enum**이지("concept_brief"가 사람이 읽는 한글 라벨
 * 이라는 위 문단의 원래 설명은 유나군 정정으로 틀렸다 확認 — 그건 enum이지 라벨이 아니다),
 * 그대로 배지에 찍으면 고객 대면 화면에 내부어가 샌다(더구나 resolved 칩은 토큰 라벨이
 * 한글인데 unresolved 배지만 영어 enum — 같은 종류가 표기가 갈림). KIND_LABEL_KEY(아래)로
 * t() 라벨화 — production-workbench-evidence.tsx의 KIND_TITLE_KEY와 다른 어휘(유나군이 이
 * 화면 전용으로 명시한 5개 문구, "컨셉 브리프" 등 — 그 파일의 "컨셉" 같은 축약형이 아니다)라
 * 새 map을 둔다. 미지 kind(#4042 서버 방어선 밖의 5종 이외)는 raw를 그대로 안 내고 중립
 * «산출물»로 폴백(enum이 UI에 안 닿는다). 배지 형태·클릭불가·honest 의미는 그대로.
 */
const KIND_LABEL_KEY: Record<ProductionWorkbenchKind, string> = {
  material_collection_sheet: 'gateLinkedEvidenceKindMaterialCollectionSheet',
  concept_brief: 'gateLinkedEvidenceKindConceptBrief',
  storyboard: 'gateLinkedEvidenceKindStoryboard',
  animatic: 'gateLinkedEvidenceKindAnimatic',
  verification_sheet: 'gateLinkedEvidenceKindVerificationSheet',
};
export function GateLinkedEvidenceSection({ gate }: { gate: GateItem }) {
  const flatHref = useFlatHref(); // story #4231 3차 — 문서 근거 링크는 게이트의 프로젝트(현재 p)를 싣는다
  const t = useTranslations('cage');
  const seen = new Set<string>();
  const resolved: (ParsedReferenceToken & { key: string })[] = [];
  const unresolvedKinds: { key: string; kind: string }[] = [];

  // story #4136 CHANGES-1(페드루 PO 지적, 2026-09-22 01:41Z) — "없음"과 "모름"을 가른다.
  // BE가 linked_evidence 필드 자체를 아직 안 보내면(#4135 미배포·구버전 응답) 이 게이트에
  // 정말 산출물이 없는지 우리는 **모른다** — 라이브 2호 게이트 1처럼 evidence·doc·artifact가
  // 실재하는데도 «없어요»라고 말하면 거짓이 된다. `Array.isArray`가 참일 때만(BE가 `[]`든
  // 항목이든 "답을 한" 때만) "없어요"를 말할 자격이 생긴다 — 배열 자체가 없으면 그 claim을
  // 아예 안 한다("모르면 안다고 안 한다" 규율, story #4055류와 동형).
  const beAnswered = Array.isArray(gate.linked_evidence);
  if (beAnswered) {
    for (const ev of gate.linked_evidence!) {
      const parsed = parseReferenceToken(ev.reference_token, flatHref);
      if (parsed) {
        const key = `${parsed.entityType}:${parsed.entityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({ ...parsed, key });
      } else {
        // reference_token이 null(또는 파싱 실패) — evidence.id로 유일화(같은 kind가 여러
        // 건일 수 있다).
        unresolvedKinds.push({ key: `unresolved:${ev.id}`, kind: ev.kind });
      }
    }
  }
  // draft_doc_reference_token이 linked_evidence[]와 같은 doc을 가리키면(#4135 착지 前엔
  // 흔함 — 두 필드가 아직 같은 doc을 독립적으로 채우는 과도기) 중복 칩을 안 낸다. 이 필드는
  // linked_evidence와 무관하게 이미 있어 왔으므로(#3569) beAnswered와 상관없이 항상 본다.
  const draftDocRef = parseReferenceToken(gate.neutral_facts?.['draft_doc_reference_token'], flatHref);
  if (draftDocRef) {
    const key = `${draftDocRef.entityType}:${draftDocRef.entityId}`;
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push({ ...draftDocRef, key });
    }
  }

  const totalCount = resolved.length + unresolvedKinds.length;
  // beAnswered=false + 산출물 0(draft_doc도 없음) — "없다"고 말할 근거가 없으니 섹션 자체를
  // 생략한다(과거 이 칸이 아예 없던 것과 동형 — #4135 미배포 구간엔 이 카드가 아무 것도
  // 지어내지 않는다). beAnswered=true(BE가 [] 포함 명시 답)거나 draft_doc이라도 있으면
  // 렌더한다.
  if (!beAnswered && totalCount === 0) return null;

  return (
    <div className="space-y-1.5" data-testid="gate-linked-evidence">
      <p className="text-[11px] font-semibold text-muted-foreground">{t('gateLinkedEvidenceSectionTitle')}</p>
      {totalCount === 0 ? (
        <p className="text-[11.5px] italic text-muted-foreground">{t('gateLinkedEvidenceEmpty')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {resolved.map((item) => (
            <EntityChip
              key={item.key}
              entityType={item.entityType}
              entityId={item.entityId}
              label={item.label}
              href={item.href}
            />
          ))}
          {unresolvedKinds.map((u) => (
            <Badge key={u.key} variant="outline" className="shrink-0">
              {isProductionWorkbenchKind(u.kind) ? t(KIND_LABEL_KEY[u.kind]) : t('gateLinkedEvidenceKindUnknown')}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
