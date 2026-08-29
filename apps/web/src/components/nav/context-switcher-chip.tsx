'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, ChevronRight, Loader2, LogOut, Plus, Search, Settings } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CreateOrganizationDialog } from '@/components/nav/create-organization-dialog';
import { useUnifiedSwitcher, type OrgSwitcherItem, type ProjectSwitcherItem } from '@/hooks/use-unified-switcher';
import { useAccountSwitcher } from '@/hooks/use-account-switcher';

interface ContextSwitcherChipProps {
  orgs: OrgSwitcherItem[];
  currentOrgId?: string;
  projects: ProjectSwitcherItem[];
  currentProjectId?: string;
  /** story #3146(계정층) — 데스크톱 AppSidebar와 동일하게 useDashboardContext().userName을
   * 호출부(TopBarSlot 계열)가 그대로 넘긴다. 없으면(컨텍스트 미준비) 계정층 자체를 생략
   * (no-fiction — 빈 이름으로 지어내지 않는다). */
  userName?: string;
}

function OrgInitial({ name, className }: { name: string; className?: string }) {
  return (
    <span className={className ?? 'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-brand text-[9px] font-semibold text-brand-foreground'}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * story #2076 → 재설계 #3147/#3146(doc mobile-switcher-redesign-spec-4758744a, 유나 확定
 * 규격) — top-bar 좌상단 컨텍스트 칩(<1024 전용, `lg:hidden`). 프로젝트/조직 전환 로직은
 * useUnifiedSwitcher(사이드바 UnifiedSwitcher와 동일 훅, 검색 state만 이번에 추가) 그대로
 * 재사용 — 새로 구현하지 않는다. 계정 전환(신규 §③)은 useAccountSwitcher(profile-menu.tsx와
 * 동일 훅) 재사용.
 *
 * 재설계 근본(⑥, 선생님 실사용 발견 #4758744a) — 시트 컨테이너는 이미 있었으나 본문 행이
 * «데스크톱 드롭다운 밀도»(작은 타깃·검색 없음·계정 경로 0)였다. 이 판이 본문만 재구성한다
 * (트리거 44px 2단화 포함) — 데스크톱 unified-switcher.tsx(lg:)는 무변경.
 *
 * ⚠️ PO 순서 지시(#2076 원 커밋 유지) — 이 칩은 기존 "More → Settings → 구 GNB" 경로와
 * 공존한다. 구 경로 제거는 이 칩이 배포·라이브 확認된 뒤 별도 후속으로 진행한다.
 */
export function ContextSwitcherChip({ orgs, currentOrgId, projects, currentProjectId, userName }: ContextSwitcherChipProps) {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  const s = useUnifiedSwitcher({ orgs, currentOrgId, projects, currentProjectId });
  const accountsEnabled = !!userName;
  // 훅은 항상 무조건 호출한다(userName 없어도) — 아래 accountsEnabled로 렌더만 게이팅.
  const acc = useAccountSwitcher(userName ?? '');

  // story #3146 — 트리거가 Radix Sheet 자신의 트리거가 아니라 외부에서 s.setOpen(true)를
  // 직접 호출하는 커스텀 버튼이라, Sheet의 onOpenChange는(Radix가 스스로 연 게 아니므로)
  // 이 흐름에서 안 불린다 — useUnifiedSwitcher가 프로젝트 목록을 `open` state 변화 자체를
  // 지켜보는 내부 useEffect로 재조회하는 것과 동형으로, 계정 목록도 `s.open` 변화를 직접
  // 지켜봐야 한다(테스트로 잡은 실사고 — onOpenChange 의존은 이 트리거 패턴에서 죽은 코드).
  useEffect(() => {
    if (accountsEnabled && s.open) void acc.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsEnabled, s.open]);

  const chipLabel = s.displayProject || '—';

  return (
    <>
      <Sheet open={s.open} onOpenChange={s.setOpen}>
        {/* story #3147 §② — 26px 단행 칩 → 44px 2단(조직 위·프로젝트 아래) 상시 트리거.
            폭 상한은 #2076 실측(120px 단행 기준)과 다른 레이아웃이라 재실측(190px 기준
            390px 뷰포트에서 우측 아이콘 클러스터와 안 겹침, 헤더 실렌더로 확認).
            story #3202(선생님 실기기 픽셀 붕괴) — `min-h-11`은 최솟값일 뿐이라, 2단 라벨의
            line-height가 (특히 안드로이드 폰트 부스트 하에서) 44px+padding 예산을 넘겨
            버튼 실높이가 부모 TopBar(h-12=48px)를 넘어서면 자기 border/bg가 헤더 행을
            뚫고 나온 것처럼 보였다(실측: 헤더 h-12(48px) 안에서 트리거 실제 렌더 높이
            48.5px·상단 -0.75px로 이미 초과 확認). `h-11`(고정 44px)+`overflow-hidden`+
            라벨 `leading-none`으로 실높이를 44px에 하드캡 — 터치 타겟(44px)은 그대로
            유지하면서(AC2) 어떤 폰트 렌더링 조건에서도 48px 행을 못 넘게 한다. */}
        <button
          type="button"
          onClick={() => s.setOpen(true)}
          disabled={s.pending}
          className="flex h-11 min-w-0 max-w-[190px] shrink-0 items-center gap-2 overflow-hidden rounded-xl border border-border bg-card px-2 py-1.5 text-left transition hover:bg-muted disabled:opacity-60 lg:hidden"
          aria-label={t('switcherMobileTriggerAria')}
        >
          <OrgInitial name={s.displayOrg} className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-brand text-xs font-semibold text-brand-foreground" />
          <span className="flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5">
            <span className="w-full truncate text-[10px] font-semibold leading-none text-muted-foreground">{s.displayOrg}</span>
            <span className="w-full truncate text-[13px] font-bold leading-none text-foreground">{chipLabel}</span>
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>

        <SheetContent side="bottom" className="max-h-[80vh] rounded-t-2xl p-0">
          <SheetHeader className="flex-row items-center justify-between border-b pb-3">
            <SheetTitle>{t('switcherMobileSheetTitle')}</SheetTitle>
            <button
              type="button"
              onClick={() => { window.location.href = '/settings?tab=organization'; }}
              className="flex size-11 items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t('switcherOrgSettingsAria')}
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </SheetHeader>

          <div className="focus-inset flex-1 overflow-y-auto px-2 pb-4">
            {/* story #3147 §③ 검색(신규) — 현 조직 프로젝트만 필터(9+ 대응). */}
            <div className="sticky top-0 z-10 bg-background px-1 pb-2 pt-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  type="search"
                  value={s.searchQuery}
                  onChange={(e) => s.setSearchQuery(e.target.value)}
                  placeholder={t('switcherProjectSearchPlaceholder')}
                  className="h-10 w-full rounded-[10px] border border-border bg-muted pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            {/* 현재 조직 프로젝트 */}
            <div className="flex items-center gap-1.5 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('switcherCurrentOrgProjectsLabel', { org: s.displayOrg })}
            </div>
            {s.currentOrgLoading && (
              <div className="flex items-center gap-2 px-4 py-2.5 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{tCommon('loading')}</span>
              </div>
            )}
            {!s.currentOrgLoading && s.filteredCurrentOrgProjects.length === 0 && s.searchQuery.trim() ? (
              <p className="px-4 py-2.5 text-sm text-muted-foreground">{t('switcherProjectSearchEmpty')}</p>
            ) : (
              s.filteredCurrentOrgProjects.map((project) => {
                const isCurrent = project.projectId === s.currentProjectId;
                return (
                  <button
                    key={project.projectId}
                    type="button"
                    disabled={s.pending}
                    onClick={() => void s.switchProject(project.projectId)}
                    className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-left transition hover:bg-accent disabled:opacity-60 ${isCurrent ? 'bg-brand/10' : ''}`}
                  >
                    <OrgInitial
                      name={project.projectName}
                      className={`flex size-[26px] shrink-0 items-center justify-center rounded-[6px] text-[11px] font-semibold ${isCurrent ? 'bg-brand text-brand-foreground' : 'bg-muted text-muted-foreground'}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">{project.projectName}</span>
                    {/* 유나 규격 — 색만 의존 금지(브랜드 배경+글리프 이중 표식). */}
                    {isCurrent && <Check className="h-4 w-4 shrink-0 text-brand" />}
                  </button>
                );
              })
            )}
            <button
              type="button"
              onClick={() => s.setCreateProjectOpen(true)}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3.5 py-2.5 text-left text-brand transition hover:bg-accent"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span className="text-sm">{t('switcherNewProject')}</span>
            </button>

            {/* 다른 조직들 — 섹션 라벨 신설(§③). */}
            {s.otherOrgs.length > 0 && (
              <div className="mt-2 flex items-center gap-1.5 border-t px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('switcherOtherOrgsLabel')}
              </div>
            )}
            {s.otherOrgs.map((org) => {
              const orgProjects = s.otherOrgProjects[org.orgId];
              const isLoading = s.loadingOrgIds.has(org.orgId);
              return (
                <div key={org.orgId}>
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                    <OrgInitial name={org.orgName} className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-muted text-[9px] font-semibold text-muted-foreground" />
                    {org.orgName}
                    {org.role && <span className="text-[9px] font-normal capitalize normal-case opacity-60">{org.role}</span>}
                  </div>
                  {isLoading ? (
                    <div className="flex items-center gap-2 px-4 py-2.5 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>{tCommon('loading')}</span>
                    </div>
                  ) : orgProjects && orgProjects.length > 0 ? (
                    orgProjects.map((project) => (
                      <button
                        key={project.projectId}
                        type="button"
                        disabled={s.pending}
                        onClick={() => void s.switchOrgAndProject(org.orgId, project.projectId)}
                        className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-left transition hover:bg-accent disabled:opacity-60"
                      >
                        <span className="min-w-0 flex-1 truncate text-[13.5px]">{project.projectName}</span>
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      </button>
                    ))
                  ) : (
                    <button
                      type="button"
                      disabled={s.pending}
                      onClick={() => void s.switchOrg(org.orgId)}
                      className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-left text-muted-foreground transition hover:bg-accent disabled:opacity-60"
                    >
                      <span className="flex-1 text-[13.5px]">{t('switcherSwitchToOrg')}</span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  )}
                </div>
              );
            })}

            <div className="mt-2 border-t pt-2">
              <button
                type="button"
                onClick={() => s.setCreateOrgOpen(true)}
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3.5 py-2.5 text-left transition hover:bg-accent"
              >
                <Plus className="h-4 w-4 shrink-0" />
                <span className="text-sm">{t('switcherNewOrganization')}</span>
              </button>
            </div>

            {/* story #3146 §③ 계정층(신규) — divider로 시각 분리(무거운 조작·우발 탭 방지,
                맨 아래). #73d5ff10 "로그아웃 외엔 계정을 바꿀 방법이 없다" 해소. */}
            {accountsEnabled && (
              <>
                <div className="mt-3 h-2 rounded-full border-y border-muted bg-muted" aria-hidden />
                <div className="mt-2 flex items-center gap-1.5 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {acc.t('title')}
                </div>
                {acc.error && (
                  <p role="alert" aria-live="assertive" aria-atomic="true" className="px-3.5 py-1 text-xs text-destructive">{acc.error}</p>
                )}
                {acc.ordered.map((account) => {
                  const isActive = account.status === 'active';
                  const isExpired = account.status === 'expired';
                  const label = account.name ?? account.email ?? acc.tc('unknown');
                  return (
                    <button
                      key={account.account_id}
                      type="button"
                      disabled={acc.busy !== null || isActive}
                      onClick={() => void acc.handleSwitch(account)}
                      className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-left transition hover:bg-accent disabled:opacity-60 ${isActive ? 'bg-brand/10' : ''}`}
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                        {label.charAt(0).toUpperCase()}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] text-foreground">{label}</span>
                        {isExpired ? (
                          <span className="truncate text-[10.5px] text-muted-foreground">{acc.t('reloginRequired')}</span>
                        ) : (
                          account.email && account.email !== label && (
                            <span className="truncate text-[10.5px] text-muted-foreground">{account.email}</span>
                          )
                        )}
                      </span>
                      {isActive && <Check className="h-4 w-4 shrink-0 text-brand" />}
                      {acc.busy === account.account_id && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
                    </button>
                  );
                })}
                <button
                  type="button"
                  disabled={acc.atCap || acc.busy !== null}
                  onClick={() => void acc.handleAdd()}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3.5 py-2.5 text-left text-brand transition hover:bg-accent disabled:opacity-60"
                >
                  {acc.busy === 'add' ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  <span className="flex-1 text-sm">{acc.t('addAccount')}</span>
                  {acc.atCap && <span className="text-xs text-muted-foreground">{acc.t('capReached')}</span>}
                </button>
                <button
                  type="button"
                  disabled={acc.busy !== null}
                  onClick={() => void acc.handleSignOut('this')}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3.5 py-2.5 text-left text-destructive transition hover:bg-muted"
                >
                  <LogOut className="size-4" />
                  <span className="text-sm">{acc.others.length > 0 ? acc.t('signOutThis') : acc.tc('logout')}</span>
                </button>
                {acc.others.length > 0 && (
                  <button
                    type="button"
                    disabled={acc.busy !== null}
                    onClick={() => void acc.handleSignOut('all')}
                    className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3.5 py-2.5 text-left text-destructive transition hover:bg-muted"
                  >
                    <LogOut className="size-4" />
                    <span className="text-sm">{acc.t('signOutAll')}</span>
                  </button>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <CreateOrganizationDialog
        open={s.createOrgOpen}
        onOpenChange={s.setCreateOrgOpen}
        onCreated={s.handleOrgCreated}
      />

      <Dialog open={s.createProjectOpen} onOpenChange={s.setCreateProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('switcherNewProjectDialogTitle')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); void s.createProject(s.newProjectName, s.newProjectDesc); }} className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="chip-proj-name">
                {t('switcherProjectNameLabel')} <span className="text-destructive">*</span>
              </label>
              <input
                id="chip-proj-name"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('switcherProjectNamePlaceholder')}
                value={s.newProjectName}
                onChange={(e) => s.setNewProjectName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="chip-proj-desc">
                {t('switcherDescriptionLabel')} <span className="text-muted-foreground text-xs">{t('switcherOptionalLabel')}</span>
              </label>
              <textarea
                id="chip-proj-desc"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('switcherProjectDescPlaceholder')}
                rows={3}
                value={s.newProjectDesc}
                onChange={(e) => s.setNewProjectDesc(e.target.value)}
              />
            </div>
            {/* story #2468(b) — 실패를 침묵하지 않는다("버튼 무반응"의 정체가 이 자리였다). */}
            {s.createProjectError && (
              <p role="alert" className="text-sm text-destructive">{s.createProjectError}</p>
            )}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" disabled={s.creating}>{tCommon('cancel')}</Button>} />
              <Button type="submit" disabled={!s.newProjectName.trim() || s.creating}>
                {s.creating ? t('switcherCreating') : t('switcherCreateButton')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
