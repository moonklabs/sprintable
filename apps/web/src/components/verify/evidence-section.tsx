'use client';

import { useCallback, useState } from 'react';
import {
  Check, ChevronDown, ChevronUp, ExternalLink, Link2, Paperclip, Plus,
  GitPullRequest, Rocket, TrendingUp, FileText, CheckCircle2, Frame,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { deriveTrustStage, asVerificationSheet, type EvidenceItem, type EvidenceType, type VerificationSheetItem } from '@/services/verify';
import {
  adaptArtifactDetail, getArtifactVersionDetail,
  type ArtifactFormat, type BeArtifactVersionSummary,
} from '@/services/canvas';
import { ArtifactExpandDialog } from '@/components/canvas/artifact-expand-dialog';
import { type GalleryTimelineVersion } from '@/components/canvas/artifact-gallery-timeline';
import { fetchWithAuth } from '@/lib/db/client';

const VISIBLE_LIMIT = 4;

// BE _CLIENT_CREATABLE_TYPES(evidence.py) 미러 — gate_approval은 시스템 전용(직접 생성 차단).
const CLIENT_CREATABLE_TYPES: EvidenceType[] = ['url', 'file', 'pr', 'deploy', 'metric', 'report'];

const TYPE_ICON: Record<EvidenceType, typeof Link2> = {
  url: Link2,
  file: Paperclip,
  pr: GitPullRequest,
  deploy: Rocket,
  metric: TrendingUp,
  report: FileText,
  gate_approval: CheckCircle2,
};

const TYPE_LABEL_KEY: Record<EvidenceType, string> = {
  url: 'evidenceTypeUrl',
  file: 'evidenceTypeFile',
  pr: 'evidenceTypePr',
  deploy: 'evidenceTypeDeploy',
  metric: 'evidenceTypeMetric',
  report: 'evidenceTypeReport',
  gate_approval: 'evidenceTypeGateApproval',
};

/** ref가 실제로 새 탭을 열 수 있는 URL인지 — 아닌 타입(예: metric 수치 설명)은 링크로 렌더하지 않는다. */
export function isLinkableRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

// story #3560(제작 작업대 검증 시트, 유나 §17-24 확定 2026-09-06) — 「A → B」류
// 화살표가 아니라 접힘+요약 한 줄부터. 실패 있으면 실패 수를 앞세우고(무엇이
// 급한지 먼저), 실패 0이면 「해당 없음」 섞임 여부로 「모두 통과」를 말할 수
// 있는지를 가른다(섞이면 "모두 통과"라고 말할 자격이 없다 — 일부는 안 쟀다).
function verificationSheetSummary(
  items: VerificationSheetItem[],
  t: (key: string, values?: Record<string, string | number>) => string,
  naLabel: string,
): string {
  const total = items.length;
  const fail = items.filter((i) => i.verdict === 'fail').length;
  const na = items.filter((i) => i.verdict === 'n_a').length;
  const pass = items.filter((i) => i.verdict === 'pass').length;
  // story #3581(유나 #3927 비차단 발견 → §17-24 낱말 확定 2026-09-06) — fail>0·na>0가
  // 동시에 참이면 예전엔 fail 갈래로 떨어져 na가 조용히 사라졌다(§3-2 "모른다≠0"과
  // 같은 결 — 해당 없음 항목이 있었다는 사실이 통째로 안 보였다). 4갈래로: 이 조합만
  // 새 갈래(「실패 N · 해당 없음 M · 전체 K」).
  if (fail > 0 && na > 0) return t('verificationSheetSummaryWithFailAndNa', { fail, na, total, naLabel });
  if (fail > 0) return t('verificationSheetSummaryWithFail', { fail, total });
  if (na > 0) return t('verificationSheetSummaryWithNa', { pass, na, naLabel });
  return t('verificationSheetSummaryAllPass', { total });
}

// story #3560 — 「해당 없음」은 새 낱말을 짓지 않고 insightsBoardCommentsNotApplicable을
// 그대로 재사용한다(PO 確定 2026-09-06) — 요약 줄과 표의 n_a 판정 낱말 둘 다.
const VERDICT_LABEL_KEY: Partial<Record<VerificationSheetItem['verdict'], string>> = {
  pass: 'verificationSheetVerdictPass',
  fail: 'verificationSheetVerdictFail',
};

// 유나 §17-24 대비 규율(2026-09-06) — 판정 낱말은 muted 금지(작은 글자×muted×
// bg-muted 조합 실측 최저 4.77 — 이 표는 muted 배경 위가 아니지만 규율은 표
// 전체에 건다), fail만 destructive(색은 낱말 뒤에 덧붙는 것 — 낱말이 먼저).
function VerificationSheetVerdict({
  verdict, t, naLabel,
}: { verdict: VerificationSheetItem['verdict']; t: (key: string) => string; naLabel: string }) {
  return (
    <span className={verdict === 'fail' ? 'text-destructive' : 'text-foreground'}>
      {verdict === 'n_a' ? naLabel : t(VERDICT_LABEL_KEY[verdict]!)}
    </span>
  );
}

function VerificationSheetRow({
  item, t, naLabel,
}: {
  item: EvidenceItem; t: (key: string, values?: Record<string, string | number>) => string; naLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = asVerificationSheet(item.payload) ?? [];
  const hasNoteColumn = items.some((i) => i.note);
  return (
    <li className="rounded-md px-1.5 py-1 hover:bg-muted/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        data-testid="evidence-verification-sheet-summary"
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {verificationSheetSummary(items, t, naLabel)}
        </span>
        <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">
          {t('verificationSheetTypeLabel')}
        </span>
        {expanded ? <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
      </button>
      {expanded ? (
        // 대비: 표 글자는 text-xs 아래로 내려가지 않는다(§17-24) — 이 파일 다른
        // evidence 행이 쓰는 text-[10px]/text-[11px]류를 여기선 안 쓴다.
        <table className="mt-1.5 w-full text-xs" data-testid="evidence-verification-sheet-table">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-1 pr-2 font-medium">{t('verificationSheetColumnName')}</th>
              <th className="pb-1 pr-2 font-medium">{t('verificationSheetColumnVerdict')}</th>
              {hasNoteColumn ? <th className="pb-1 font-medium">{t('verificationSheetColumnNote')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((row, i) => (
              <tr key={`${row.name}-${i}`} className="align-top">
                <td className="py-0.5 pr-2 text-foreground">{row.name}</td>
                <td className="py-0.5 pr-2"><VerificationSheetVerdict verdict={row.verdict} t={t} naLabel={naLabel} /></td>
                {hasNoteColumn ? <td className="py-0.5 text-foreground">{row.note ?? ''}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </li>
  );
}

interface EvidenceSectionProps {
  workItemId: string;
  workItemType: 'story' | 'task';
  /** E-VERIFY P0-04(claimed-vs-verified-spec-handoff §3) — has_evidence(1 boolean) 대체 2신호.
   * false는 절대 오지 않음(null=무증거) — undefined도 무증거로 취급. */
  selfReported: boolean | null | undefined;
  humanVerified: boolean | null | undefined;
  humanVerifiedBy: string | null | undefined;
  humanVerifiedAt: string | null | undefined;
  memberMap?: Record<string, { name: string }>;
  className?: string;
}

/**
 * E-VERIFY V0-S3 Lv1(접힘 신뢰 행) + Lv2(펼침 evidence 카드) + P0-04 Claimed-vs-Verified 데이터
 * 배선. 유나 S4 핸드오프 §3/§4 + claimed-vs-verified-spec-handoff §3 준수.
 * "근거 보기" 클릭 시에만 evidence 리스트를 호출한다(디디 BE 가이드 — 리스트 렌더 시 카드마다
 * 부르지 않는 게 정합, self_reported 하나로 Lv0 씰 표시는 충분). 그래서 fetch 전엔 건수를 모른다 —
 * Lv1 라벨은 펼치기 전엔 카운트 없이 "증명된 완결"만, 펼친 후 실 카운트로 채워진다.
 *
 * Lv0/Lv1 씰은 story/task 응답에 이미 동봉된 human_verified_by/at으로 즉시 정확하게 렌더된다
 * (evidence 리스트 fetch를 기다릴 필요 없음 — verified 여부/who/when은 집계 필드).
 */
export function EvidenceSection({
  workItemId, workItemType, selfReported, humanVerified, humanVerifiedBy, humanVerifiedAt, memberMap = {}, className,
}: EvidenceSectionProps) {
  const t = useTranslations('verify');
  const tCommon = useTranslations('common');
  // story #3560(PO 確定 2026-09-06) — 「해당 없음」 재사용(insightsBoard 네임스페이스,
  // 새 낱말 0).
  const tInsights = useTranslations('insightsBoard');
  const naLabel = tInsights('insightsBoardCommentsNotApplicable');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<EvidenceItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const fetchEvidence = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/evidence?work_item_id=${workItemId}&work_item_type=${workItemType}`);
      if (!res.ok) { setError(true); return; }
      const json = (await res.json()) as { data?: EvidenceItem[] };
      setItems(json.data ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [workItemId, workItemType]);

  const handleToggle = () => {
    if (!expanded && items === null) { void fetchEvidence(); }
    setExpanded((v) => !v);
  };

  // story #2722(아티팩트·evidence 버전 pin, AC2) — evidence가 아티팩트를 근거로 삼았으면
  // "그 시각 고정된 버전"으로 열린다(현행 최신이 아니라). artifact-gallery-view.tsx의
  // handleOpenArtifact/ArtifactExpandDialog 왕복을 그대로 재사용(새 발명 0).
  const [expandTarget, setExpandTarget] = useState<{
    artifactId: string; format: ArtifactFormat; content: string; title: string;
    canvasBounds?: { w: number; h: number } | null;
    versionNumber: number; versions: GalleryTimelineVersion[];
  } | null>(null);

  const handleOpenArtifact = useCallback(async (artifactId: string, versionNumber: number, title: string) => {
    const [detail, versionListRes] = await Promise.all([
      getArtifactVersionDetail(artifactId, versionNumber),
      fetchWithAuth(`/api/visual-artifacts/${artifactId}/versions`),
    ]);
    if (!detail) return;
    const { artifact, versions } = adaptArtifactDetail(detail);
    const content = versions[0]?.content;
    if (!content) return;
    const versionList: BeArtifactVersionSummary[] = versionListRes.ok
      ? ((await versionListRes.json()) as { data?: BeArtifactVersionSummary[] }).data ?? []
      : [];
    const mappedVersions: GalleryTimelineVersion[] = versionList
      .slice()
      .sort((a, b) => a.version_number - b.version_number)
      .map((v) => ({ versionNumber: v.version_number, summary: v.summary, isAnchor: v.version_number === artifact.anchor_version }));
    setExpandTarget({
      artifactId, format: artifact.format, content, title,
      canvasBounds: versions[0]?.canvasBounds, versionNumber, versions: mappedVersions,
    });
  }, []);

  // story #2258 — 증거연결: BE(create_evidence)는 이미 있었는데 화면이 부르지 않던 경로.
  const [showAddForm, setShowAddForm] = useState(false);
  const [addType, setAddType] = useState<EvidenceType>('url');
  const [addRef, setAddRef] = useState('');
  const [addNote, setAddNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(false);

  const handleAddEvidence = async () => {
    if (!addRef.trim() || adding) return;
    setAdding(true);
    setAddError(false);
    try {
      const res = await fetch('/api/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_item_id: workItemId, work_item_type: workItemType,
          type: addType, ref: addRef.trim(), note: addNote.trim() || null,
        }),
      });
      if (!res.ok) { setAddError(true); return; }
      // 긴급 정정(2026-07-28): `as EvidenceItem` 단언이 봉투 이중포장을 조용히 통과시켰다
      // (build/typecheck 둘 다 못 잡음) — 최소 형상 가드로 대체. 없으면 실패로 취급한다.
      const raw: unknown = await res.json();
      const created = (raw && typeof raw === 'object' && 'id' in raw && 'type' in raw && 'ref' in raw)
        ? (raw as EvidenceItem)
        : null;
      if (!created) { setAddError(true); return; }
      // AC1: 붙인 뒤 다시 읽어서 붙어 있는 것 — 서버 응답(실제로 저장된 값)을 그대로 리스트에 반영.
      setItems((prev) => [created, ...(prev ?? [])]);
      setAddRef('');
      setAddNote('');
      setShowAddForm(false);
    } catch {
      setAddError(true);
    } finally {
      setAdding(false);
    }
  };

  // 증거 0 = 신뢰 행 자체를 렌더하지 않는다(§7 상태 매트릭스 — 현행과 동일 무표시, "증명 안 됨" 금지).
  const trustStage = deriveTrustStage({ self_reported: selfReported, human_verified: humanVerified });
  if (!trustStage) return null;

  const visibleItems = items && !showAll ? items.slice(0, VISIBLE_LIMIT) : items;
  const hiddenCount = items ? items.length - VISIBLE_LIMIT : 0;
  const signerId = items?.[0]?.created_by ?? null;
  const signerName = signerId ? memberMap[signerId]?.name : null;
  // E-VERIFY P0-04 — Lv0/Lv1 씰은 이 자리에서 즉시 정확하게(evidence fetch 대기 없이): verified는
  // human_verified_by 실명(who), claimed는 "에이전트 주장"(self_reported엔 who가 없어 일반화,
  // §3 계약 그대로). 과거 무조건 초록 체크였던 자리 — human 미검증 건은 여기서 amber로 정정된다.
  const verifiedByName = humanVerifiedBy ? (memberMap[humanVerifiedBy]?.name ?? humanVerifiedBy.slice(0, 6)) : null;
  const verifiedWhen = humanVerifiedAt ? formatRelativeTime(humanVerifiedAt, locale, displayTimezone) : null;
  const sealLabel = trustStage === 'verified'
    ? (verifiedByName ? `${t('trustSealVerifiedBy', { name: verifiedByName })}${verifiedWhen ? ` · ${verifiedWhen}` : ''}` : t('provenCompletion'))
    : t('trustSealClaimedBy');

  return (
    <div className={className}>
      <div className="rounded-lg border border-border p-2.5">
        <button type="button" onClick={handleToggle} className="flex w-full items-center gap-2 text-left">
          <Check
            className={cn('h-3 w-3 shrink-0', trustStage === 'verified' ? 'text-success/85' : 'text-warning-strong')}
            strokeWidth={2.6}
            aria-hidden
          />
          <span className="text-xs font-semibold text-foreground">{sealLabel}</span>
          {/* story #2265(C-7) PO 지적, 2026-07-29: 이 수는 Evidence 테이블 건수뿐이다 — 바로
            아래 붙을 proof(채팅 인용) 섹션은 다른 모델이라 여기 안 잡힌다. "근거 N건"으로
            두면 그 옆의 proof가 안 세어진 것처럼 보여 총량을 거짓으로 만든다 — "첨부 근거"로
            좁혀 이 수가 «첨부형»만 센다는 것을 명시한다(두 섹션 통합은 별건으로 등재). */}
          {items ? (
            <span className="text-[11px] text-muted-foreground">· {t('evidenceCount', { count: items.length })}</span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            {expanded ? t('evidenceHide') : t('evidenceShow')}
            {expanded ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
          </span>
        </button>

        {expanded ? (
          <div className="mt-2 border-t border-border pt-2">
            {loading ? (
              <p className="text-[11px] text-muted-foreground">{tCommon('loading')}</p>
            ) : error ? (
              // 유나 디자인 가디언 리뷰: fetch 실패는 시스템 에러(에이전트 판단 아님) — "안심" 표면
              // 일관성을 위해 destructive(빨강) 대신 중립 톤.
              <p className="text-[11px] text-muted-foreground">{t('evidenceLoadError')}</p>
            ) : items && items.length > 0 ? (
              <>
                {signerName ? (
                  <p className="mb-1.5 text-[11px] text-muted-foreground">{t('evidenceSignedBy', { name: signerName })}</p>
                ) : null}
                <ul className="space-y-1">
                  {(visibleItems ?? []).map((item) => {
                    // story #3560(제작 작업대 검증 시트, PO 確定 2026-09-06) — 다른
                    // kind는 기존 그대로(§17-24 "이 kind만" 원칙), verification_sheet
                    // 만 접힘 요약+펼침 표 전용 행으로 갈린다.
                    if (item.type === 'report' && asVerificationSheet(item.payload)) {
                      return <VerificationSheetRow key={item.id} item={item} t={t} naLabel={naLabel} />;
                    }
                    const Icon = TYPE_ICON[item.type] ?? Link2;
                    const linkable = isLinkableRef(item.ref);
                    const primaryText = item.note || item.ref;
                    // story #2722(AC2) — 아티팩트 근거는 그 시각 고정된 버전으로 열린다(현행
                    // 최신 아님). artifact_version_id가 null이면 "버전 미상"인 구 데이터라
                    // 이 분기를 못 타고 기존 링크/텍스트 렌더로 폴백한다(정직 표기).
                    const pinnedArtifact = item.artifact_id != null && item.artifact_version_number != null
                      ? { id: item.artifact_id, versionNumber: item.artifact_version_number }
                      : null;
                    return (
                      <li key={item.id} className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/40">
                        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <div className="min-w-0 flex-1">
                          {pinnedArtifact ? (
                            <button
                              type="button"
                              onClick={() => void handleOpenArtifact(pinnedArtifact.id, pinnedArtifact.versionNumber, primaryText)}
                              className="flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
                            >
                              <span className="truncate">{primaryText}</span>
                              <Frame className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                            </button>
                          ) : linkable ? (
                            <a
                              href={item.ref}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
                            >
                              <span className="truncate">{primaryText}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                            </a>
                          ) : (
                            <span className="block truncate text-xs font-medium text-foreground">{primaryText}</span>
                          )}
                          {item.source ? <p className="truncate text-[11px] text-muted-foreground">{item.source}</p> : null}
                        </div>
                        <span className="mt-0.5 shrink-0 text-[10px] font-semibold text-muted-foreground">
                          {t(TYPE_LABEL_KEY[item.type] ?? 'evidenceTypeUrl')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {hiddenCount > 0 && !showAll ? (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="mt-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {t('evidenceMore', { count: hiddenCount })}
                  </button>
                ) : null}
              </>
            ) : null}

            {showAddForm ? (
              <div className="mt-2 space-y-1.5 rounded-md border border-border bg-muted/20 p-2">
                <div className="flex flex-wrap gap-1">
                  {CLIENT_CREATABLE_TYPES.map((ty) => (
                    <button
                      key={ty}
                      type="button"
                      onClick={() => setAddType(ty)}
                      className={cn(
                        'rounded px-2 py-0.5 text-[10px] font-medium transition',
                        addType === ty ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(TYPE_LABEL_KEY[ty])}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={addRef}
                  onChange={(e) => setAddRef(e.target.value)}
                  placeholder={t('evidenceRefPlaceholder')}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
                />
                <input
                  type="text"
                  value={addNote}
                  onChange={(e) => setAddNote(e.target.value)}
                  placeholder={t('evidenceNotePlaceholder')}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
                />
                {addError ? <p className="text-[11px] text-destructive">{t('evidenceAddFailed')}</p> : null}
                <div className="flex justify-end gap-1.5">
                  <button type="button" onClick={() => setShowAddForm(false)} className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
                    {tCommon('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleAddEvidence()}
                    disabled={!addRef.trim() || adding}
                    className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {adding ? tCommon('loading') : t('evidenceAdd')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowAddForm(true)}
                className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3 w-3" aria-hidden />
                {t('evidenceAdd')}
              </button>
            )}
          </div>
        ) : null}
      </div>
      {expandTarget ? (
        <ArtifactExpandDialog
          open={expandTarget !== null}
          onOpenChange={(next) => { if (!next) setExpandTarget(null); }}
          title={expandTarget.title}
          format={expandTarget.format}
          content={expandTarget.content}
          canvasBounds={expandTarget.canvasBounds}
          versions={expandTarget.versions}
          selectedVersion={expandTarget.versionNumber}
          onSelectVersion={(versionNumber) => void handleOpenArtifact(expandTarget.artifactId, versionNumber, expandTarget.title)}
        />
      ) : null}
    </div>
  );
}
