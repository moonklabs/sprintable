'use client';

import { useLocale, useTranslations } from 'next-intl';
import { CircleDollarSign, Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { isLinkableRef } from '@/components/verify/evidence-section';
import { useWorkItemProductionEvidence } from '@/hooks/use-work-item-production-evidence';
import {
  filterProductionWorkbenchEvidence, groupProductionWorkbenchEvidenceByKind, orderedPresentKinds,
  partitionCurrentAndHistory,
} from '@/lib/production-workbench-evidence';
import {
  asMaterialCollectionSheet, asConceptBrief, asStoryboard, asAnimatic, asVerificationSheet,
  type ProductionWorkbenchKind, type EvidenceItem,
} from '@/services/verify';

// story #4057(E-RECIPE-1 ③, 유나 작업대 시안 v1·artifact 9b5d6512 위) — gates/[id]에서 사람이
// ⓐ컨셉·ⓑ구조 승인 前 크리에이터 에이전트 stage 산출물(#4041 계약)을 읽는 리치 렌더.
// #4059 데이터층(services/verify.ts asXxx·lib/production-workbench-evidence.ts·
// hooks/use-work-item-production-evidence.ts) 위에 얹는다.
//
// 시안 축약 3건(실 계약 shape에 없는 값은 지어내지 않는다 — no-fiction) — 유나에 플래그:
//  ① 감정비트 막대그래프(height:38% 등 intensity)는 #4041 §4 emotion_beats에 강도값이
//     없어(beat_no·shot_no·emotion만) 칩 목록으로 대체.
//  ② 애니매틱 타임라인 세그먼트(컷별 width)는 payload에 컷 분해 데이터가 없어(artifact_id·
//     cost_tier·duration_sec만) 뺐다 — duration_sec 값만 텍스트로.
//  ③ AI 귀속 뱃지의 에이전트 이름은 evidence.created_by가 id 문자열뿐이라(이름 미해결)
//     "에이전트 생성"까지만 — 이름 보간은 이름-해석 훅이 붙는 후속.
// 검증 시트 행의 우측 mono 값(vv)도 payload.items에 수치 필드가 없어 뺐다(verdict·name만).
//
// ⛔ gate-evidence.tsx의 「없으면 비운다」 규율 그대로 — 산출물 0건이면 이 패널 자체를 안
// 그린다(빈 카드·플레이스홀더 텍스트 없음). 게이트 카드(ProofCapsule·GateSignatureApproval)는
// 새로 안 짓는다 — 이 패널은 그 옆/위에 «근거» 층만 얹는다(유나 지시 그대로).
const KIND_TITLE_KEY: Record<ProductionWorkbenchKind, string> = {
  material_collection_sheet: 'productionWorkbenchKindMaterialCollection',
  concept_brief: 'productionWorkbenchKindConceptBrief',
  storyboard: 'productionWorkbenchKindStoryboard',
  animatic: 'productionWorkbenchKindAnimatic',
  verification_sheet: 'productionWorkbenchKindVerificationSheet',
};

// 시안 .ocard 공용 헤더 — okind(제목)+attr(AI 귀속, info만)+ver(mono)+when(우측).
function OutputCardHeader({ kindTitle, evidence, isCurrent }: { kindTitle: string; evidence: EvidenceItem; isCurrent?: boolean }) {
  const t = useTranslations('cage');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <span className="text-[12.5px] font-bold text-foreground">{kindTitle}</span>
      {/* story #4433 qa:changes 2차(카디르 ⓑ) — 같은 kind가 여러 건일 때만(재시도·재제출
          존재) "현재" 라벨을 얹는다. 유일한 버전이면 굳이 안 단다(잡음). */}
      {isCurrent ? <Badge variant="secondary" className="shrink-0">{t('productionWorkbenchCurrentBadge')}</Badge> : null}
      <Badge variant="info" className="shrink-0">{t('productionWorkbenchAiAttribution')}</Badge>
      {evidence.artifact_version_number !== null ? (
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {t('productionWorkbenchVersionRef', { v: evidence.artifact_version_number })}
        </span>
      ) : null}
      {/* story #3493 정본 — 게이트 evidence 카드는 "기록" 표기라 toLocaleString류가 아니라
          formatRelativeTime(gate-evidence.tsx GateActivityHistory와 동형 관례). */}
      <span className="ml-auto text-[10.5px] text-muted-foreground">
        {formatRelativeTime(evidence.created_at, locale, displayTimezone)}
      </span>
    </div>
  );
}

// story #3164/#3785 회귀가드 — rounded+border+카드표면 bg 조합은 손코딩 카드라 Card 프리미티브를
// 쓴다(surface='solid'가 border-border/80+bg-card를 이미 낸다).
function OutputCard({ children }: { children: React.ReactNode }) {
  return <Card className="overflow-hidden">{children}</Card>;
}

function MaterialCollectionSheetCard({ evidence, isCurrent }: { evidence: EvidenceItem; isCurrent?: boolean }) {
  const t = useTranslations('cage');
  const items = asMaterialCollectionSheet(evidence.payload);
  if (!items) return null;
  return (
    <OutputCard>
      <OutputCardHeader kindTitle={t(KIND_TITLE_KEY.material_collection_sheet)} evidence={evidence} isCurrent={isCurrent} />
      <ul className="space-y-1 p-3">
        {items.map((item, i) => (
          <li key={i} className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <Badge variant="outline" className="shrink-0">{item.tag}</Badge>
            <span className="text-foreground">{item.label}</span>
            {isLinkableRef(item.ref) ? (
              <a href={item.ref} target="_blank" rel="noopener noreferrer" className="text-muted-foreground underline underline-offset-2">
                {t('productionWorkbenchOpenRef')}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </OutputCard>
  );
}

function ConceptBriefCard({ evidence, isCurrent }: { evidence: EvidenceItem; isCurrent?: boolean }) {
  const t = useTranslations('cage');
  const brief = asConceptBrief(evidence.payload);
  if (!brief) return null;
  return (
    <OutputCard>
      <OutputCardHeader kindTitle={t(KIND_TITLE_KEY.concept_brief)} evidence={evidence} isCurrent={isCurrent} />
      <div className="space-y-1.5 p-3 text-[11.5px]">
        <p className="font-medium text-foreground">{brief.concept}</p>
        <p className="text-muted-foreground">{brief.rationale}</p>
        {brief.mood_refs?.length ? (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {brief.mood_refs.map((_ref, i) => (
              <Badge key={i} variant="outline">{t('productionWorkbenchMoodRef', { n: i + 1 })}</Badge>
            ))}
          </div>
        ) : null}
      </div>
    </OutputCard>
  );
}

// 시안 .sbgrid(4열) — 실 artifact_version 이미지 없이는 그라디언트 자리(장식 chrome, 데이터
// 아님)만 두고 샷 번호·설명만 실값으로 채운다.
function StoryboardCard({ evidence, isCurrent }: { evidence: EvidenceItem; isCurrent?: boolean }) {
  const t = useTranslations('cage');
  const storyboard = asStoryboard(evidence.payload);
  if (!storyboard) return null;
  return (
    <OutputCard>
      <OutputCardHeader kindTitle={t(KIND_TITLE_KEY.storyboard)} evidence={evidence} isCurrent={isCurrent} />
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {/* story #3164 가드 — rounded+border+카드표면 bg 트리오는 손코딩 카드로 잡힌다. 이미
              위 Card(OutputCard) 안의 2층 썸네일이라 개별 border는 안 필요(뺀다). */}
          {storyboard.shot_list.map((shot) => (
            <div key={shot.shot_no} className="overflow-hidden rounded-lg bg-muted">
              <div className="relative flex h-[74px] items-center justify-center bg-gradient-to-br from-info-tint to-muted text-muted-foreground">
                <span className="absolute left-1.5 top-1.5 rounded bg-card px-1 text-[9.5px] font-bold text-foreground">
                  {String(shot.shot_no).padStart(2, '0')}
                </span>
              </div>
              <p className="px-1.5 py-1 text-[10px] leading-tight text-foreground">{shot.desc}</p>
            </div>
          ))}
        </div>
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="bg-muted text-left text-[10.5px] font-bold text-muted-foreground">
              <th className="px-2 py-1">{t('productionWorkbenchShotNoLabel')}</th>
              <th className="px-2 py-1">{t('productionWorkbenchAngleLabel')}</th>
              <th className="px-2 py-1">{t('productionWorkbenchDurationLabel')}</th>
            </tr>
          </thead>
          <tbody>
            {storyboard.shot_list.map((shot) => (
              <tr key={shot.shot_no} className="border-t border-border">
                <td className="px-2 py-1.5 font-mono text-foreground">{shot.shot_no}</td>
                <td className="px-2 py-1.5 text-foreground">{shot.angle}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{t('productionWorkbenchDurationSeconds', { sec: shot.duration_sec })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {storyboard.emotion_beats.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {storyboard.emotion_beats.map((beat, i) => (
              <Badge key={i} variant="outline">
                {t('productionWorkbenchBeatShotRef', { shotNo: beat.shot_no })} · {beat.emotion}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </OutputCard>
  );
}

// 시안 .anim — 9:16 화면 chrome(장식)+play 아이콘. 컷별 타임라인 세그먼트는 계약에 세그먼트
// 데이터가 없어 생략(위 파일 상단 주석 ②).
function AnimaticCard({ evidence, isCurrent }: { evidence: EvidenceItem; isCurrent?: boolean }) {
  const t = useTranslations('cage');
  const animatic = asAnimatic(evidence.payload);
  if (!animatic) return null;
  return (
    <OutputCard>
      <OutputCardHeader kindTitle={t(KIND_TITLE_KEY.animatic)} evidence={evidence} isCurrent={isCurrent} />
      <div className="flex items-stretch gap-3 p-3">
        <div className="flex aspect-[9/16] w-[110px] shrink-0 items-center justify-center rounded-lg border border-border bg-gradient-to-b from-info-tint to-muted">
          <span className="flex size-8 items-center justify-center rounded-full bg-card/90 text-brand shadow">
            <Play className="size-4" fill="currentColor" />
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-1.5 text-[12px]">
          {/* story #4433 qa:changes(카디르, 2026-09-19) — cost_tier는 categorical
              값(no_charge/paid)이지 상태(성공/경고)가 아니다(§3 PR 설명이 "상태색은
              verification_sheet만"이라 해놓고 여기 warning을 쓴 자기모순). 둘 다
              secondary(neutral)로 걷고, salience는 색 대신 paid 전용 비용 아이콘으로. */}
          <Badge variant="secondary" className="w-fit gap-1">
            {animatic.cost_tier === 'paid' ? <CircleDollarSign className="size-3" /> : null}
            {animatic.cost_tier === 'no_charge' ? t('productionWorkbenchCostTierNoCharge') : t('productionWorkbenchCostTierPaid')}
          </Badge>
          <span className="text-muted-foreground">{t('productionWorkbenchDurationSeconds', { sec: animatic.duration_sec })}</span>
          <span className="font-mono text-[10.5px] text-muted-foreground">{t('productionWorkbenchArtifactRef', { id: animatic.artifact_id.slice(0, 8) })}</span>
        </div>
      </div>
    </OutputCard>
  );
}

// 시안 .vsheet/.vrow — 여기만 상태색 허용(진짜 pass/fail, 성공/경고 아니라 검증 판정).
function VerificationSheetCard({ evidence, isCurrent }: { evidence: EvidenceItem; isCurrent?: boolean }) {
  const t = useTranslations('cage');
  const items = asVerificationSheet(evidence.payload);
  if (!items) return null;
  return (
    <OutputCard>
      <OutputCardHeader kindTitle={t(KIND_TITLE_KEY.verification_sheet)} evidence={evidence} isCurrent={isCurrent} />
      <ul className="space-y-1.5 p-3">
        {items.map((item, i) => {
          // story #4057 CI 실측(2026-09-18, 페드루 지적) — verify-no-new-tint-color-text
          // 가드가 bg-{family}-tint + text-{family}(같은 리터럴)를 막는다(#2420/#4055와 동일
          // 안티패턴 — 소형 텍스트 vs tint 대비 마진이 얇다). 상태 신호는 배경 tint는 유지하되
          // 글자색은 text-foreground(고대비)로, 구분은 border-{family}가 짊어진다(유나 제안
          // "border/icon" 그대로 — 흐름 밴드 AA 하드닝과 같은 결).
          const dotClass = item.verdict === 'pass' ? 'bg-success-tint border border-success'
            : item.verdict === 'fail' ? 'bg-warning-tint border border-warning' : 'bg-muted border border-border';
          // bg-transparent — no-card-surfaceless-box(#3785)가 요구하는 명시적 surface 선언
          // (rounded+border엔 bg- 필요)이면서, no-handrolled-card(#3164)의 카드-표면 bg 목록
          // (card/background/muted/popover)엔 안 걸리게(이미 OutputCard 안 2층).
          return (
            <li key={i} className="flex items-center gap-2 rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-[12px]">
              <span className={`flex size-[15px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-foreground ${dotClass}`}>
                {item.verdict === 'pass' ? '✓' : item.verdict === 'fail' ? '!' : '·'}
              </span>
              <span className="flex-1 text-foreground">{item.name}</span>
              <span className="text-[11px] text-muted-foreground">
                {item.verdict === 'pass' ? t('productionWorkbenchVerdictPass')
                  : item.verdict === 'fail' ? t('productionWorkbenchVerdictFail') : t('productionWorkbenchVerdictNa')}
              </span>
            </li>
          );
        })}
      </ul>
    </OutputCard>
  );
}

const KIND_CARD: Record<ProductionWorkbenchKind, (props: { evidence: EvidenceItem; isCurrent?: boolean }) => React.ReactElement | null> = {
  material_collection_sheet: MaterialCollectionSheetCard,
  concept_brief: ConceptBriefCard,
  storyboard: StoryboardCard,
  animatic: AnimaticCard,
  verification_sheet: VerificationSheetCard,
};

export interface ProductionWorkbenchEvidencePanelProps {
  workItemId: string;
  workItemType: 'story' | 'task';
  /** story #4433 qa:changes round-3 — gate.neutral_facts.stage(호출부가 뽑아 넘김). null이면
   * (비-레시피 게이트 등) stage 매칭 자체를 못 해 이 패널은 아무것도 "현재"로 승격하지 않는다. */
  currentStage: string | null;
}

/** work_item_type이 story/task가 아니면(doc·loop·artifact 등) 호출부가 아예 마운트하지 않는다
 * — 이 컴포넌트는 그 분기를 스스로 하지 않는다(gates/[id]/page.tsx가 이미 gate_type별
 * 분기를 갖고 있어 그 근처에서 결정하는 게 자연스럽다, 중복 판별축 방지). */
export function ProductionWorkbenchEvidencePanel({ workItemId, workItemType, currentStage }: ProductionWorkbenchEvidencePanelProps) {
  const t = useTranslations('cage');
  const { items: rawItems, loading, loadFailed } = useWorkItemProductionEvidence(workItemId, workItemType);
  if (loading || loadFailed) return null; // 다른 보조 신호(GithubRependingReason 등)와 동형 — 실패/로딩 중엔 조용히.
  const items = filterProductionWorkbenchEvidence(rawItems.map((i) => i.evidence));
  if (items.length === 0) return null; // 없으면 비운다(omit, not placeholder) — gate-evidence.tsx 규율 그대로.
  const grouped = groupProductionWorkbenchEvidenceByKind(items);
  const kinds = orderedPresentKinds(grouped);

  return (
    <div className="space-y-2.5" data-testid="production-workbench-evidence">
      <p className="text-[11px] font-semibold text-muted-foreground">{t('productionWorkbenchSectionTitle')}</p>
      {kinds.map((kind) => {
        const Card = KIND_CARD[kind];
        const groupItems = grouped[kind] ?? [];
        // story #4433 qa:changes round-3(카디르+페드루, 2026-09-19) — round-2의 "최신
        // created_at=현재" 추정이 새 컨셉 등록 직후 구 컨셉 pass를 현재로 오도한다는 지적 —
        // gate.neutral_facts.stage ↔ evidence.payload.stage 매칭으로 교체(lib 함수 주석 참고).
        // 매칭 신호 자체가 없으면(currentStage null·payload.stage 미기재) 아무것도 승격하지
        // 않고 전부 중립(배지 없음·안 접힘)으로 나열한다 — "모르면 안다고 안 한다".
        const { current, history } = partitionCurrentAndHistory(groupItems, currentStage);
        if (!current) {
          if (history.length === 0) return null;
          return (
            <div key={kind} className="space-y-2">
              {history.map((item) => <Card key={item.evidence.id} evidence={item.evidence} />)}
            </div>
          );
        }
        return (
          <div key={kind} className="space-y-2">
            <Card key={current.evidence.id} evidence={current.evidence} isCurrent={history.length > 0} />
            {history.length > 0 ? (
              <details className="rounded-lg border border-dashed border-border bg-transparent">
                <summary className="cursor-pointer px-2.5 py-1.5 text-[10.5px] font-semibold text-muted-foreground">
                  {t('productionWorkbenchHistorySectionTitle', { n: history.length })}
                </summary>
                <div className="space-y-2 p-2 pt-0 opacity-70">
                  {history.map((item) => <Card key={item.evidence.id} evidence={item.evidence} />)}
                </div>
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
