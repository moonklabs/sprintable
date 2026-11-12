'use client';

import { Avatar } from '../avatar';
import { Banner } from '../banner';
import { Button, buttonVariants } from '../button';
import { Card, CardInset } from '../card';
import { Checkbox } from '../checkbox';
import { AgentTag, Chip, Tag } from '../chip';
import { CountBadge } from '../count-badge';
import { EmptyState } from '../empty-state';
import { Field } from '../field';
import { FilterBar } from '../filter-bar';
import { IconButton } from '../icon-button';
import { Input, Textarea } from '../input';
import { Kbd } from '../kbd';
import { ListRow } from '../list-row';
import { PageFrame } from '../page-frame';
import { PageHead } from '../page-head';
import { RowList, RowListItem } from '../row-list';
import { Menu, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../menu';
import { NativeSelect } from '../select';
import { Radio, RadioGroup } from '../radio';
import { SectionHeader } from '../section-header';
import { Skeleton, SkeletonGroup } from '../skeleton';
import { StatusLabel } from '../status-label';
import { TabNav, TabNavLink } from '../tab-nav';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs';
import { Toggle } from '../toggle';
import { ToastCard } from '../toast-card';
import { ToastContainer } from '../toast';
import { Block, Row } from './showcase-layout';

const noop = () => {};

const BUTTON_VARIANTS = ['primary', 'secondary', 'quiet', 'danger'] as const;

/** 변형 하나의 상태 줄 — 목록 `.map` 안에 단추를 직접 두지 않는다(같은 이름 단추가 줄마다 반복되는 꼴을 가드가 막는다). */
function ButtonVariantRow({ variant }: { variant: (typeof BUTTON_VARIANTS)[number] }) {
  return (
    <Row label={variant}>
      <Button variant={variant}>기본</Button>
      <Button variant={variant} disabled>끔</Button>
      <Button variant={variant} loading>불러오는 중</Button>
      <Button variant={variant} size="lg">큰 단추</Button>
      <Button variant={variant} iconStart={<span aria-hidden="true">+</span>}>글 앞 아이콘</Button>
    </Row>
  );
}

/** 부품 견본 ① — 단추 · 표시 · 면 · 입력 · 탐색. */
export function ShowcasePartsA() {
  return (
    <>
      <Block title="Button — 변형 × 상태">
        {BUTTON_VARIANTS.map((v) => <ButtonVariantRow key={v} variant={v} />)}
      </Block>
      <Block title="IconButton — 이름 필수 · 크기 · 주 행동">
        <Row label="quiet">
          <IconButton icon="close" label="닫기" />
          <IconButton icon="close" label="닫기" size="lg" />
          <IconButton icon="close" label="닫기" disabled />
        </Row>
        <Row label="primary">
          <IconButton icon="add" label="새 대화" variant="primary" size="lg" />
          <IconButton icon="add" label="새 대화" variant="primary" size="xl" />
        </Row>
      </Block>
      <Block title="Chip · CountBadge · StatusLabel — 뜻은 글이 싣는다">
        <Row label="Chip">
          {(['neutral', 'needs-hand', 'done', 'failed', 'info', 'action'] as const).map((t) => (
            <Chip key={t} tone={t} dot>{t}</Chip>
          ))}
        </Row>
        <Row label="Tag">
          <Tag>읽기 전용</Tag>
          <AgentTag />
        </Row>
        <Row label="CountBadge">
          <CountBadge count={3} />
          <CountBadge count={120} />
          <CountBadge kind="needs-hand" count={2} label="내 손이 필요" />
        </Row>
        <Row label="StatusLabel">
          {(['online', 'idle', 'offline', 'working', 'needs-hand', 'failed'] as const).map((s) => (
            <StatusLabel key={s} status={s} label={s} />
          ))}
        </Row>
      </Block>
      <Block title="Avatar — 사람은 동그라미 · 에이전트는 네모">
        <Row>
          <Avatar name="지우" actorType="human" size={32} />
          <Avatar name="개발" actorType="agent" size={32} />
          <Avatar name="개발" actorType="agent" size={32} isWorking presenceStatus="online" />
          <Avatar name={null} label="이름 없음" actorType="human" size={32} />
          <Avatar name="지우" actorType="human" size={18} decorative />
        </Row>
      </Block>
      <Block title="Card · CardInset · SectionHeader · EmptyState">
        <div className="mb-2 grid gap-2 sm:grid-cols-3">
          <Card className="p-3 text-ds-body">기본 카드</Card>
          <Card selected className="p-3 text-ds-body">고른 카드</Card>
          <Card tone="needs-hand" toneLabel="내 손이 필요" className="p-3 text-ds-body">내 손이 필요한 카드</Card>
        </div>
        <CardInset className="mb-2">abc123 · 카드 안 데이터 칸</CardInset>
        <SectionHeader title="일하는 중" count={<CountBadge count={4} />} />
        <SectionHeader title="끝남" collapsed onToggle={noop} />
        <SectionHeader title="내 손이 필요" tone="needs-hand" collapsed={false} onToggle={noop} count={<CountBadge kind="needs-hand" count={2} label="내 손이 필요" />} />
        <EmptyState icon="inbox" title="손댈 일이 없어요" description="에이전트들이 알아서 가고 있어요" action={<Button size="md">일감 보기</Button>} />
      </Block>
      <Block title="한 쪽 틀 — PageFrame · PageHead(제목 없음) · FilterBar · RowList(우클릭 = ⋯ 메뉴 · ↑↓ Enter Esc) · EmptyState inline (4913)">
        <PageFrame width="reading" className="p-0 sm:p-0">
          <PageHead description="이 화면이 무엇을 하는지 한 줄 — 제목은 앱 틀 위 막대에 있어요" actions={<Button variant="primary">주 행동 하나</Button>} />
          <FilterBar aria-label="견본 거르기" collapseLabel="필터" activeCount={1} leading={<Chip tone="action">전체</Chip>} trailing={<Chip>보관됨 보기</Chip>} />
          <RowList aria-label="견본 목록" header={{ title: '구획 제목', trailing: '2' }}>
            <RowListItem
              title="행 제목 — 우클릭해 보세요"
              subtitle="둘째 줄"
              statusMark={<Chip tone="done" dot>끝남</Chip>}
              actions={[{ key: 'open', label: '열기', onSelect: noop }, { key: 'del', label: '지우기', variant: 'danger', separatorBefore: true, onSelect: noop }]}
              actionsLabel="더보기"
              expanded
              onExpandedChange={noop}
              detail={<span className="text-ds-small text-ds-ink-2">행 안 펼침(한 단 올린 면)</span>}
            />
            <div role="listitem"><EmptyState size="inline" title="목록 사이 빈 칸" /></div>
          </RowList>
        </PageFrame>
      </Block>
      <Block title="ListRow — 기본 · 촘촘 · 고름 · 내 손이 필요">
        <div className="overflow-hidden rounded-ds-control border border-ds-line">
          <ListRow leading={<Avatar name="개발" actorType="agent" size={32} decorative />} title="결제 수단 두 개 추가" subtitle="PR-4821 · 14:02" trailing={<Chip tone="done" dot>끝남</Chip>} />
          <ListRow density="compact" title="촘촘한 줄" trailing={<Kbd>⌘K</Kbd>} />
          <ListRow selected title="고른 줄" subtitle="aria-current" />
          <ListRow needsHand needsHandLabel="내 손이 필요" title="승인이 필요해요" trailing={<Button variant="primary">보기</Button>} />
        </div>
      </Block>
      <Block title="Banner — 안내 · 사람이 지금 할 일 · 실패 · 그 밖">
        <div className="flex flex-col gap-1.5">
          <Banner tone="info">새 판이 준비됐어요.</Banner>
          <Banner tone="needs-hand" action={<Button size="md" variant="secondary">보기</Button>}>승인이 필요해요.</Banner>
          <Banner tone="failed" onDismiss={noop}>저장하지 못했어요.</Banner>
          <Banner tone="note">일부만 불러왔어요.</Banner>
        </div>
      </Block>
      <Block title="ToastCard — 오류 · 되돌리기 · 정보">
        <div className="flex flex-col gap-2">
          <ToastCard kind="error" title="저장하지 못했어요" body="잠시 뒤에 다시 해 주세요" onDismiss={noop} />
          <ToastCard kind="undo" title="첨부를 지웠어요" body="아주-긴-파일-이름.pdf" bodySingleLine actionLabel="되돌리기" onAction={noop} onDismiss={noop} />
          <ToastCard kind="info" title="복사했어요" onDismiss={noop} />
        </div>
        <p className="m-0 mb-1 mt-3 text-ds-small text-ds-ink-3">ToastContainer — 쌓기(최신이 맨 아래 · 오래된 것은 위로). 수명 5초(되돌리기 8초)는 제공자 몫이라 견본에서는 닫히지 않는다.</p>
        <ToastContainer
          onDismiss={noop}
          toasts={[
            { id: 'a', title: '저장했어요', type: 'success' },
            { id: 'b', title: '첨부를 지웠어요', body: '아주-긴-파일-이름.pdf', bodySingleLine: true, action: { label: '되돌리기', onClick: noop } },
            { id: 'c', title: '저장하지 못했어요', type: 'error' },
          ]}
        />
      </Block>
      <Block title="Checkbox · Radio · Toggle — 보이는 이름 필수">
        <Row label="Checkbox">
          <Checkbox label="기본" />
          <Checkbox label="고름" defaultChecked />
          <Checkbox label="끔" disabled />
          <Checkbox label="끔 + 고름" disabled defaultChecked />
        </Row>
        <Row label="Radio">
          <RadioGroup aria-label="범위" defaultValue="org" className="flex flex-wrap gap-3">
            <Radio value="org" label="조직 전체" />
            <Radio value="project" label="프로젝트" />
            <Radio value="off" label="끔" disabled />
          </RadioGroup>
        </Row>
        <Row label="Toggle">
          <Toggle label="원격 제어" onText="켬" offText="끔" />
          <Toggle label="원격 제어" onText="켬" offText="끔" defaultChecked />
          <Toggle label="원격 제어" onText="켬" offText="끔" disabled />
        </Row>
      </Block>
      <Block title="Input · Textarea · Field · NativeSelect — 기본 · 오류 · 끔">
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="이름" placeholder="기본" />
          <Input aria-label="이름 오류" aria-invalid defaultValue="형식이 틀려요" />
          <Input aria-label="이름 끔" disabled defaultValue="끔" />
          <NativeSelect aria-label="역할" defaultValue="b"><option value="a">관리자</option><option value="b">구성원</option></NativeSelect>
        </div>
        <Textarea aria-label="메모" className="mt-2" placeholder="여러 줄" />
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Field label="이메일" hint="회사 메일">{(c) => <Input {...c} />}</Field>
          <Field label="이메일" error="이메일 형식이 아니에요">{(c) => <Input {...c} />}</Field>
        </div>
      </Block>
      <Block title="Tabs · TabNav · Menu · Kbd">
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a">한 칸</TabsTrigger>
            <TabsTrigger value="b">두 칸</TabsTrigger>
            <TabsTrigger value="c" disabled>끔</TabsTrigger>
          </TabsList>
          <TabsContent value="a"><p className="m-0 py-2 text-ds-body text-ds-ink-2">같은 화면 안 칸 갈아 보이기</p></TabsContent>
          <TabsContent value="b"><p className="m-0 py-2 text-ds-body text-ds-ink-2">두 번째 칸</p></TabsContent>
        </Tabs>
        <TabNav aria-label="팀">
          <TabNavLink asChild active><a href="#members">구성원</a></TabNavLink>
          <TabNavLink asChild><a href="#agents">에이전트</a></TabNavLink>
          <TabNavLink asChild><a href="#runs">실행</a></TabNavLink>
        </TabNav>
        <Row>
          <Menu>
            <MenuTrigger className={buttonVariants()}>메뉴 열기</MenuTrigger>
            <MenuContent>
              <MenuGroup>
                <MenuLabel>작업</MenuLabel>
                <MenuItem icon="edit" shortcut={<Kbd>E</Kbd>}>이름 바꾸기</MenuItem>
                <MenuItem>위로</MenuItem>
              </MenuGroup>
              <MenuSeparator />
              <MenuItem variant="danger">삭제</MenuItem>
            </MenuContent>
          </Menu>
          <span className="text-ds-small text-ds-ink-3">단축키 표기:</span>
          <Kbd>⌘</Kbd><Kbd>K</Kbd>
        </Row>
      </Block>
      <Block title="Skeleton — 불러오는 중(장식 막대 + 읽히는 안내 하나)">
        <SkeletonGroup label="불러오는 중…" className="flex flex-col gap-2">
          <Skeleton variant="text" size="title" className="w-1/3" />
          <Skeleton variant="text" size="body" />
          <Skeleton variant="rect" className="h-ds-row" />
        </SkeletonGroup>
      </Block>
    </>
  );
}
