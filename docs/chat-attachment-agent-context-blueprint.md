# 채팅 첨부 → 에이전트 AI 컨텍스트 — 블루프린트 (짧은 버전)

Status: Draft for review. R2 prod 회수(story `9d130c01` · `af66acee`). Scope: backend(+connector). high-value 혼합팀 협업 갭.

## 1. 가설 + 메트릭 (dogfood 선행)

**가설:** 에이전트가 채팅 첨부(이미지·문서)의 *내용*을 답변에 반영하면, 휴먼이 첨부 내용을 텍스트로 재설명하는 왕복이 사라져 혼합팀 협업 효율이 오른다.

**측정(2주 dogfood 판정):**
- `attachment_message_rate` — 첨부 포함 대화 메시지 비율(baseline).
- `attachment_reflection_rate` — 첨부 포함 메시지에 대한 에이전트 답변이 첨부 내용을 *참조*한 비율(↑ 목표).
- `reexplain_roundtrips` — 휴먼이 첨부를 텍스트로 다시 설명한 왕복 수(↓ 목표).
- 판정: reflection_rate ≥ 임계 + reexplain 감소면 유지, 아니면 조정/kill.

## 2. 현행 흐름 (감사)

| 단계 | 현실 | 위치 |
|---|---|---|
| 첨부 저장 | `ConversationMessage.attachments` JSONB(url/name/content_type/size). 파일=GCS. 백엔드는 메타만. | `conversation.py`·`conversations.py:548` |
| SSE 이벤트 페이로드 | **attachments 포함**(`_msg_payload`) | `conversations.py:239` |
| **webhook relay**(CC 주입=다수 에이전트 수신 경로) | **content(텍스트)만**·attachments **드롭** | `conversation_webhook.py:158` |
| **hermes 커넥터** | `content`만 추출·`message_type=TEXT` 고정·`raw_message`엔 attachments 있으나 **미사용** | `connectors/hermes-sprintable/adapter.py:215` |
| 텍스트 추출/이미지 분석 | **전무**(net-new) | — |
| LLM 호출 | **이 레포 밖**(에이전트 런타임). 커넥터는 thin marshaller. | — |

**핵심 갭:** 첨부 메타가 SSE까진 가지만 ① webhook relay·커넥터에서 떨어지고 ② 설령 가도 *내용 추출*이 없어 에이전트가 못 읽는다.

## 3. 설계 결정 — 백엔드 텍스트 주입(균일) 우선

**결정: 백엔드가 첨부 *내용*을 추출/요약해 에이전트-facing `content`(또는 인접 컨텍스트 필드)에 주입한다.** 런타임/커넥터별 멀티모달 개조에 의존하지 않는다.

근거:
- 에이전트 런타임이 **이질적**(openclaw·hermes·claude-code)이고 전달이 **텍스트 content 중심**(webhook). 백엔드 1점 주입이면 **모든 런타임이 균일하게** 첨부를 본다(런타임 변경 0).
- 멀티모달(이미지 픽셀)을 각 런타임에 태우는 건 per-runtime 작업 + out-of-repo. 가치 대비 무겁다 → 뒤로.
- 문서는 텍스트가 본질이라 추출-주입으로 **100% 가치**. 이미지는 v1에서 캡션/메타로 시작.

대안(기각/후속): 페이로드에 image base64/URL 실어 런타임이 vision 호출 — 멀티모달 런타임 한정·커넥터+런타임 개조 필요 → v2 옵션으로 보류.

## 4. 주입 지점 (in-repo)

1. **신규 서비스 `attachment_context`**: 메시지 attachments → 주입용 텍스트 블록 생성.
   - 문서(pdf/docx/pptx/txt/csv/md): GCS fetch → 텍스트 추출(truncate, 길이 cap) → `[첨부: name]\n<text>`.
   - 이미지(jpeg/png/gif/webp): v1 = `[이미지 첨부: name (content_type)]` + (옵션) 백엔드 Vision 캡션. v2 = 멀티모달 ref.
   - 미지원/실패: `[첨부(미지원 형식): name]` 안내(증상의 "미지원 형식 안내" 충족).
2. **webhook relay 페이로드에 첨부 컨텍스트 주입**: `deliver_conversation_message_webhook`(+`deliver_injected_event_webhook`)의 `content`에 §4.1 블록 append. (메시지 attachments DB 조회 추가.)
3. **SSE content에도 동일 주입**(agent_gateway top-level `content`)로 SSE 수신 런타임도 균일.
4. **(커넥터, 별 PR)** hermes adapter가 `raw_message.payload.attachments`를 런타임에 전달 — v2 멀티모달용. v1은 백엔드 텍스트 주입이라 불요.

## 5. net-new vs 재사용

재사용: 첨부 JSONB 저장·authorize 게이트·GCS·SSE 페이로드·메시지 linkage·다중첨부(≤10).
net-new: GCS 인증 fetch(서비스계정)·텍스트 추출 라이브러리(pypdf/python-docx 등)·길이 cap/truncate·미지원 안내·(옵션) Vision 캡션.

## 6. 단계 (제안)

- **S1 — 문서 텍스트 추출 + content 주입(균일·in-repo)**: `attachment_context` 서비스(문서 추출·미지원 안내) + webhook/SSE content 주입. 텍스트 첨부 100% 가치·런타임 무변경. **dogfood 메트릭 계측 동반.**
- **S2 — 이미지 처리**: (A) 백엔드 Vision 캡션 주입(균일) **또는** (B) 멀티모달 ref + 커넥터/런타임 전달. §7 결정 필요.
- **S3 — 메트릭 대시/판정** + 추출 형식 확장·성능(대용량 truncate·async fetch).

## 7. PO 결정 필요

1. **이미지 전략**: v1 = 캡션/메타 안내로 시작 OK? 본격 이미지 분석은 (A)백엔드 Vision 캡션(균일·LLM 비용/지연 백엔드) vs (B)멀티모달 런타임 전달(커넥터+런타임 개조·out-of-repo) — 어느 쪽?
2. **추출 범위 v1**: pdf/docx/txt/csv/md 우선? pptx/xlsx 포함?
3. **길이 cap**: 첨부 텍스트 주입 최대 길이(컨텍스트 폭발 방지·예: 첨부당 8k자·truncate 표시)?
4. **GCS fetch 인증**: 서비스계정 직접 read(권장) vs signed URL 재발급?
5. **보안**: 첨부 authorize 게이트는 발신 시 이미 통과 — 주입 시 추가 검증 불요 확認?

§7만 정해지면 S1(문서 추출·균일 주입·메트릭)부터 일반 dev 파이프라인으로 진행하는.
