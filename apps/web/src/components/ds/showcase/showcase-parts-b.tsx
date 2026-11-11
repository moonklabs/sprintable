'use client';

import { useState } from 'react';
import { ApprovalActions, ApprovalCard, ApprovalReason } from '../approval-card';
import { Button, buttonVariants } from '../button';
import { Calendar } from '../calendar';
import { Chip } from '../chip';
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../dialog';
import { DateNav } from '../date-nav';
import { DatePicker } from '../date-picker';
import { Metric } from '../metric';
import { PageSplit } from '../page-split';
import { Panel, PanelBody, PanelContent, PanelHeader, PanelTitle, PanelTrigger } from '../panel';
import { ProgressBar } from '../progress-bar';
import { Stepper } from '../stepper';
import { SummaryCard } from '../summary-card';
import { Timeline, TimelineItem } from '../timeline';
import { TreeRow } from '../tree-row';
import { Avatar } from '../avatar';
import { Block, Row } from './showcase-layout';

const noop = () => {};
const STEPS = [
  { id: 'role', label: '직무' },
  { id: 'scope', label: '범위' },
  { id: 'runtime', label: '실행환경' },
  { id: 'bundle', label: '번들' },
  { id: 'verify', label: '검증' },
] as const;
const STATE_LABELS = { done: '끝남', current: '진행 중', upcoming: '대기' };

/** 부품 견본 ② — 날짜 · 진척 · 단계 · 시간 · 트리 · 화면 틀 · 결재 · 대화창류. `today`는 서버가 정해 넘긴다. */
export function ShowcasePartsB({ today }: { today: string }) {
  const [date, setDate] = useState<string | null>(null);
  const [navDate, setNavDate] = useState(today);
  const [pickDate, setPickDate] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      <Block title="DateNav · Calendar · DatePicker">
        <Row label="DateNav">
          <DateNav value={navDate} onChange={setNavDate} onToday={() => setNavDate(today)} labels={{ date: '날짜', previousDay: '전날', nextDay: '다음날', today: '오늘' }} />
        </Row>
        <div className="mb-2 flex flex-wrap items-start gap-4">
          <Calendar value={date} onChange={setDate} today={today} locale="ko" labels={{ previousMonth: '이전 달', nextMonth: '다음 달' }} />
          <div className="w-56 max-w-full">
            <DatePicker value={pickDate} onChange={setPickDate} today={today} locale="ko" labels={{ date: '시작일', placeholder: '날짜 고르기', previousMonth: '이전 달', nextMonth: '다음 달' }} />
          </div>
        </div>
      </Block>
      <Block title="Metric · ProgressBar — 숫자 칸과 사용량">
        <div className="mb-2 grid gap-3 sm:grid-cols-3">
          <Metric label="오늘 끝낸 일" value={12} limit={40} delta={<Chip tone="done">+3</Chip>} />
          <Metric label="사용량" value="8" limit="10" />
          <Metric label="비용" unavailable unavailableLabel="아직 집계하지 못했어요" />
        </div>
        <div className="flex flex-col gap-2">
          <ProgressBar aria-label="작업 진척 시작 전" value={0} max={10} />
          <ProgressBar aria-label="작업 진척 중간" value={6} max={10} />
          <ProgressBar aria-label="작업 진척 끝" value={10} max={10} />
          <ProgressBar aria-label="사용량" tone="usage" value={10} max={10} />
          <ProgressBar aria-label="사용량 모름" value={null} max={10} unavailableLabel="아직 집계하지 못했어요" />
        </div>
      </Block>
      <Block title="Stepper — 끝 · 지금 · 아직">
        <div className="flex flex-col gap-3">
          <Stepper aria-label="채용 단계 처음" steps={STEPS} current={0} stateLabels={STATE_LABELS} />
          <Stepper aria-label="채용 단계 중간" steps={STEPS} current={2} stateLabels={STATE_LABELS} />
          <Stepper aria-label="채용 단계 끝" steps={STEPS} current={5} stateLabels={STATE_LABELS} />
        </div>
      </Block>
      <Block title="Timeline — 시각 · 행위자 · 문장 · 뜻 점">
        <Timeline aria-label="활동 이력">
          <TimelineItem time="14:02" dateTime="2026-11-11T14:02:00+09:00" actor={<Avatar name="개발" actorType="agent" size={18} decorative />}>PR을 올렸어요</TimelineItem>
          <TimelineItem time="14:10" tone="needs-hand" toneLabel="내 손이 필요" actor={<Avatar name="개발" actorType="agent" size={18} decorative />}>승인을 기다리고 있어요</TimelineItem>
          <TimelineItem time="14:31" tone="done" toneLabel="끝남" actor={<Avatar name="지우" actorType="human" size={18} decorative />}>승인해서 병합했어요</TimelineItem>
        </Timeline>
      </Block>
      <Block title="TreeRow — 깊이 · 폴더 · 고름 · 놓을 자리">
        <div className="flex flex-col">
          <TreeRow depth={0} title="문서" icon="folder" expanded={expanded} controlProps={{ onClick: () => setExpanded((v) => !v) }} />
          {expanded ? <TreeRow depth={1} title="고른 문서" icon="description" selected controlProps={{ onClick: noop }} /> : null}
          {expanded ? <TreeRow depth={1} title="이모지 문서" emoji="📌" controlProps={{ onClick: noop }} /> : null}
          <TreeRow depth={0} title="접힌 폴더" icon="folder" expanded={false} controlProps={{ onClick: noop }} />
          <TreeRow depth={2} title="안으로 놓을 자리" icon="folder" expanded dropZone="into" controlProps={{ onClick: noop }} />
        </div>
      </Block>
      <Block title="PageSplit · SummaryCard — 본문 + 옆 칸(폰은 칩 줄)">
        <PageSplit
          asideLabel="지금까지 고른 것"
          aside={<SummaryCard title="지금까지 고른 것" emptyLabel="아직 안 골랐어요" items={[{ id: 'role', label: '직무', value: '프런트엔드' }, { id: 'scope', label: '범위', value: '조직 전체' }, { id: 'runtime', label: '실행 환경', value: null }]} />}
        >
          <div className="rounded-ds-control border border-ds-line bg-ds-surface p-3 text-ds-body text-ds-ink-2">단계 패널 자리 — 본문 칸</div>
        </PageSplit>
      </Block>
      <Block title="ApprovalCard — 결재 요청 한 장">
        <div className="flex flex-col gap-2">
          <ApprovalCard
            label="결재 요청"
            title="결제 수단 두 개 추가"
            requester="요청: 개발"
            state={{
              kind: 'pending',
              view: 'act',
              needsHandLabel: '내 손이 필요',
              actions: (
                <div className="flex flex-col gap-2">
                  <ApprovalReason label="사유(선택)" value="" onChange={noop} />
                  <ApprovalActions approveLabel="허용" rejectLabel="거부" onApprove={noop} onReject={noop} />
                </div>
              ),
            }}
          >
            결제 수단 두 개를 더하고 기본값을 바꿔요.
          </ApprovalCard>
          <ApprovalCard label="결재 요청" title="작업 이름 바꾸기" state={{ kind: 'resolved', resolution: 'approved', statusLabel: '허용됨' }} />
          <ApprovalCard label="결재 요청" title="작업 이름 바꾸기" state={{ kind: 'loading', loadingLabel: '불러오는 중…' }} />
          <ApprovalCard label="결재 요청" title="작업 이름 바꾸기" state={{ kind: 'error', message: '불러오지 못했어요' }} />
        </div>
      </Block>
      <Block title="Dialog · ConfirmDialog · Panel — 눌러서 열기(팝업은 그 틀의 테마로 뜬다)">
        <Row>
          <Dialog>
            <DialogTrigger className={buttonVariants()}>대화창</DialogTrigger>
            <DialogContent aria-label="견본 대화창">
              <DialogHeader>
                <DialogTitle>견본 대화창</DialogTitle>
                <DialogDescription>제목 · 설명 · 아래 단추 줄.</DialogDescription>
              </DialogHeader>
              <DialogFooter><DialogClose render={<Button variant="primary" />}>확인</DialogClose></DialogFooter>
            </DialogContent>
          </Dialog>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>위험 확인 창</Button>
          <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title="지울까요?" description="되돌릴 수 없어요." confirmLabel="지우기" cancelLabel="취소" tone="danger" onConfirm={() => setConfirmOpen(false)} />
          <Panel>
            <PanelTrigger className={buttonVariants()}>패널</PanelTrigger>
            <PanelContent aria-label="견본 패널">
              <PanelHeader><PanelTitle>견본 패널</PanelTitle></PanelHeader>
              <PanelBody><p className="m-0 text-ds-body text-ds-ink-2">lg 이상은 오른쪽 400, 아래는 시트.</p></PanelBody>
            </PanelContent>
          </Panel>
        </Row>
      </Block>
    </>
  );
}
