"""story #3373(Phase1·마케팅운영) — 채널별 OAuth/갱신 성질 선언. `app/routers/auth.py::
_OAUTH_CONFIGS`(provider별 authorize_url/scope dict)와 동형 관례 — 새 설정 패턴을 발명하지
않는다.

페드루 PO 확定(2026-09-03 07:09Z, 유나 화면설계 v2 대조) — "자동 갱신 가능 여부"는
`encrypted_refresh_token` 컬럼의 NULL 여부로 **파생하면 틀린다**(Threads는 refresh_token
없이 기존 access_token으로 재발급하는데도 자동 갱신 가능·WordPress 앱 비밀번호는 애초에
만료가 없다) — 채널의 성질이라 여기 선언하고 목록 API가 그대로 노출한다(`can_auto_refresh`).

Phase1은 Threads 1개만 구현한다(범위 밖: Instagram/Facebook/X/WordPress 등 — 그라운딩
§5·story 본문 명시). 다른 채널을 여는 스토리는 이 dict에 항목만 추가하면 된다(라우터·cron·
암호화 로직은 채널 무관 공용)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class ChannelAdapterConfig:
    authorize_url: str
    token_url: str
    scope: str
    # "refresh_token"(표준 grant) | "reissue_from_access_token"(Threads류 — 현재 유효한
    # access_token으로 재발급, refresh_token 불요) | "manual"(자동 갱신 불가 — 재인증 유도).
    refresh_mode: str
    # story f30da19a(Phase1·FE, PO 확定 2026-09-04) — 「연결 만들기」 버튼 라벨(FE는
    # 하드코딩 X, `GET .../channel-connections/available-channels`가 이 값을 그대로
    # 노출). 채널의 성질이라 여기 한 곳에 선언(max_text_length·can_auto_refresh와 동형
    # 관례). 페드루 리뷰 N1(2026-09-04) — 기본값 ""를 제거해 필수 인자로: 라벨 없는
    # 어댑터를 등재하면 그 즉시(import 시점) TypeError로 죽는다 — 화면에 빈 버튼이
    # 뜨는 대신 배포 자체가 안 되게(fail-closed, 다른 필수 필드 authorize_url/token_url/
    # scope/refresh_mode와 동열).
    display_name: str
    # story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 이 채널이 짧은 글
    # (channel_post·Threads류)인지 블로그(site_post·hosted_site/wordpress/webhook류)
    # 인지. available-channels가 이 값을 그대로 노출해 FE가 "채널 연결"과 "블로그 목적지"
    # 화면을 분기한다(kind 자체가 SSOT — 문자열 목록을 어디서도 하드코딩하지 않는다).
    kind: Literal["social", "blog"] = "social"
    # story e4fc29fa(페드루 PO 리뷰 B1, 2026-09-04) — available-channels는 "연결 만들기"
    # 버튼 목록이다(그 엔드포인트 자체 목적). credential_kind="none"을 FE(#3435 AC2)가
    # 곧바로 "샌드박스 연결 만들기 버튼"으로 읽는다 — hosted_site도 credential_kind="none"
    # 이라 그 목록에 그냥 나열되면 FE가 hosted_site에 대해 **샌드박스 연결을 만드는**
    # 잘못된 액션을 탄다. "연결할 게 있는가"와 "credential이 필요한가"는 다른 축이라
    # 별도 필드로 분리한다 — hosted_site만 False, 나머지(sandbox 포함)는 기본 True.
    requires_connection: bool = True
    credential_kind: str = "oauth"  # "oauth" | "pasted_secret" | "none"
    # story #3374(Phase1·마케팅운영, PO 결정) — 채널 포스트 초안 text 상한. 상수를 서비스/
    # 라우터에 하드코딩하지 않고 여기 한 곳에 선언(담롱 요구 — "상수 하드코딩 X·선언·표시",
    # 초안 저장 422 응답에 이 값을 그대로 실어 보낸다).
    max_text_length: int = 0
    # story #f8f7cb0f(Phase1·마케팅운영, PO 결정) — UTM 자동 부착 source/medium(campaign은
    # 대상 글마다 달라 여기 선언 대상이 아니다, app/services/utm.py::resolve_utm_campaign).
    utm_source: str = ""
    utm_medium: str = ""
    # story #3419(Phase1·마케팅운영, PO 결정 2026-09-04) — 발행된 글을 채널에서 회수(삭제
    # API 호출) 가능한지. max_text_length·can_auto_refresh와 동형 관례(채널의 성질을 여기
    # 선언하고 목록 API가 그대로 노출 → FE가 버튼 렌더 여부를 판단, 신규 판정 로직 불요).
    supports_unpublish: bool = False
    # 회수를 실제로 실행하려면 연결이 이 스코프를 갖고 있어야 한다(None=이 어댑터는 스코프
    # 요구 없음 — supports_unpublish=False면 애초에 의미 없는 값). `ChannelConnection.scopes`
    # 는 연결 시점에 이 어댑터의 `scope` 문자열을 그대로 저장한 값이다(그라운딩 확認 —
    # Threads 토큰 교환 응답에 별도 "실제 부여된 스코프" 필드가 없어, 이 코드베이스 기존
    # 관례(`channel_connections.py::channel_connection_callback`)가 이미 "요청한 스코프"를
    # "이 연결의 스코프"로 기록해 왔다 — 새 컬럼·새 메커니즘 불요, 이 필드를 `scope`에 포함시
    # 키기만 하면 기존 저장 경로가 그대로 반영한다. 기존 연결은 이 값 없이 저장돼 있어
    # 자동으로 "부족"으로 판정된다 — 재인증해야 새 scope가 반영).
    unpublish_required_scope: str | None = None
    # story 620beefc(Phase1·마케팅운영, PO 決定 2026-09-04) — 이미지 규격 선언(§13 규격
    # 문구 3요소: 무엇이·얼마까지·지금 얼마 — "무엇이·얼마까지" 축, 값은 실측·출처 주석).
    # image_max_count=0(기본)=이 채널은 이미지 미지원(threads_delete처럼 채널의 성질을
    # 여기 한 곳에 선언 — 상수 하드코딩 X, 화면·서비스가 이 값을 그대로 노출/검증에 쓴다).
    image_formats: tuple[str, ...] = ()
    image_max_bytes: int = 0
    image_aspect_max: float = 0.0
    # story #3320(Phase2·마케팅운영) — Threads류(상한만, 0.0 기본값=하한 없음)와 달리
    # Instagram은 세로 방향에도 하한이 있다(4:5=0.8~1.91:1, 정규화(long/short)로는
    # 한쪽만 못 잡는다 — width/height 원시 비율로 별도 판정, channel_post_images.py
    # 검증 함수 참고). 0.0이면 이 하한 검사 자체를 건너뛴다(기존 Threads/hosted_site
    # 회귀 0 — 새 필드가 없던 것처럼 그대로 동작).
    image_aspect_min: float = 0.0
    image_width_min: int = 0
    image_width_max: int = 0
    image_color_space: str = ""
    image_max_count: int = 0
    # story #3497(Phase2·마케팅운영, 페드루 決定 2026-09-05) — 이 채널이 실제로 채울 수
    # 있는 정규화 지표(§2(d) 7키 중 부분집합). image_max_count=0과 동형 관례 — "선언 안
    # 함"이 곧 "이 채널에선 이 지표가 항상 null"이라는 뜻(0으로 지어내지 않는다, 이
    # 스토리의 척추). 빈 튜플(기본값)=fetch_insights 자체가 없는 채널(어댑터 미선언
    # → insight_snapshots.status="unsupported" 즉시, adapter 호출 0).
    insight_metrics: tuple[str, ...] = ()
    # story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — supports_unpublish·
    # unpublish_required_scope와 동형 관례(채널의 성질을 여기 한 곳에 선언). 미선언
    # (기본 False)=댓글 수집 잡이 즉시 "unsupported"로 끝난다(adapter 호출 0, insight_
    # snapshot의 "빈 튜플=fetch_insights 없음"과 동형 사상).
    supports_fetch_replies: bool = False
    supports_reply: bool = False
    # 답변(reply)을 실제로 실행하려면 연결이 이 스코프를 갖고 있어야 한다(None=이
    # 어댑터는 스코프 요구 없음). fetch_replies 쪽은 별도 요구 스코프를 안 둔다(PO
    # 明示 — 읽기는 기존 연결 스코프로 충분하다는 전제, 조각①은 sandbox까지가 라이브
    # 범위라 실제 부족 여부는 Threads 실계정 왕복 시점에 재확認).
    reply_required_scope: str | None = None
    # story #3536(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — image_max_count>0
    # (이미지를 지원함)과는 다른 축: "지원"이 아니라 "필수"(이미지 0장이면 발행 자체가
    # provider에서 거부됨, 예: Instagram 피드 게시물). 기본 False=기존 채널(Threads
    # 등, TEXT-only 허용) 회귀 0. True면 submit(상신) 단계에서 이미지 0장을 즉시 422로
    # 막는다 — 승인 게이트를 낭비하고 발행 시점에야 죽는 것을 방지.
    image_required: bool = False
    # story #3554(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — 릴스(영상) 규격
    # 선언(image_*와 동형 관례: 0/빈값=이 채널은 영상 미지원). video_max_bytes<=0이면
    # 영상 업로드 자체가 422 CHANNEL_VIDEO_UNSUPPORTED(image_max_count<=0과 동형
    # 판단). video_codecs는 MP4 `stsd` 박스 fourcc(avc1=H.264·hvc1/hev1=HEVC) —
    # 오디오 코덱은 순수 파이썬 파서로 미검증(PO 明示, 문구에 그대로 노출).
    video_max_bytes: int = 0
    video_max_seconds: float = 0.0
    video_min_seconds: float = 0.0
    # 9:16(세로) 목표비에서 허용 오차(±) — width/height 원시 비율로 판정(image_aspect_
    # min/max와 다른 표현 형태인 이유: 릴스는 목표비 1개+오차뿐이라 상하한 2값보다
    # "목표±오차"가 그라운딩·Meta 문서 그대로를 코드에 옮기기 쉬움).
    video_aspect_target: float = 0.0
    video_aspect_tolerance: float = 0.0
    video_codecs: tuple[str, ...] = ()


CHANNEL_ADAPTERS: dict[str, ChannelAdapterConfig] = {
    "threads": ChannelAdapterConfig(
        authorize_url="https://threads.net/oauth/authorize",
        token_url="https://graph.threads.net/oauth/access_token",
        # story #3419 — threads_delete 추가(회수 API 스코프, Meta 공식 문서 실측
        # developers.facebook.com/docs/threads/posts/delete-posts/ 2026-09-04). 기존
        # 연결은 이 스코프 없이 이미 저장돼 있어 재인증 전까지 회수가 막힌다(의도, PO
        # 확定 — 새 연결부터 자동 해소).
        # story #3516 — threads_manage_replies 추가(답변 API 스코프 후보 — 그라운딩
        # ①에서 fetch로 명시 확認 못 함, "미확인 딱지"·Threads 실계정 왕복 시점에
        # 재확認 필요, 조각①은 sandbox까지가 라이브 범위라 이 스코프 자체는 지금
        # 실사용 안 됨). threads_delete와 동일 이유로 기존 연결은 재인증 전까지
        # 답변이 막힌다(의도).
        scope="threads_basic,threads_content_publish,threads_delete,threads_manage_replies",
        refresh_mode="reissue_from_access_token",
        credential_kind="oauth",
        display_name="Threads",
        # sprintable-agent-plugins/plugins/sprintable/connectors/threads.ts:27의
        # MAX_TEXT_LENGTH=500 그대로(story #3311, Meta 공식 문서 페이지 직접 실측 — 추정값
        # 아님).
        max_text_length=500,
        utm_source="threads",
        utm_medium="social",
        supports_unpublish=True,
        unpublish_required_scope="threads_delete",
        # story #3516 — 미확인 딱지(그라운딩①): pending_replies 조회 엔드포인트는 실
        # fetch로 확認했으나(developers.facebook.com/docs/threads/reply-management,
        # 2026-09-05) 답변 생성 파라미터·정확한 요구 스코프명은 문서에서 못 찾았다.
        # sandbox까지가 이 스토리 라이브 범위(PO 明示) — 선언만 해 두고 실 HTTP 왕복은
        # Threads 실계정 시점에 재검증.
        supports_fetch_replies=True,
        supports_reply=True,
        reply_required_scope="threads_manage_replies",
        # story 620beefc — Threads IMAGE 미디어 컨테이너 공식 규격(Meta 공식 문서 실측,
        # developers.facebook.com/docs/threads/posts + developers.facebook.com/docs/
        # threads/troubleshooting, 조회일 2026-09-04). 형식 JPEG/PNG만·최대 8MB·종횡비
        # 최대 10:1·너비 320~1440px(범위 밖은 Threads가 스케일하나 이 서버가 선제
        # 변환)·색공간 sRGB. Phase1은 초안당 이미지 1건(캐러셀 범위 밖, story 본문 명시).
        image_formats=("image/jpeg", "image/png"),
        image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0,
        image_width_min=320,
        image_width_max=1440,
        image_color_space="sRGB",
        image_max_count=1,
        # story #3497 — 페드루 決定③, Meta 문서(developers.facebook.com/docs/threads/
        # insights, 조회일 2026-09-05) 실측: `GET /{media_id}/insights?metric=views,
        # likes,replies,reposts,quotes,shares`. views→views 그대로, likes+replies+
        # reposts+quotes+shares 합산→engagements(§2(d) 7키엔 개별 반응 종류가 없어
        # 뭉친다). impressions/reach/clicks/spend/conversions는 Threads가 선언 안 함
        # (광고 계정 지표라 유기 게시물 API엔 없음).
        insight_metrics=("views", "engagements"),
    ),
    # story #3320(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — M4 두 번째 A(API 자동
    # 발행) 채널. OAuth 엔드포인트·스코프는 페드루 PO가 2026-09-06 Meta 공식 문서로
    # 직접 재확認한 값(threads_oauth.py 최초 작성 시의 지식-컷오프 추정과 다름 —
    # instagram_oauth.py 참고). Facebook Page 연결은 Instagram Login 방식 자체가
    # 불요(그라운딩+PO 재확認 일치).
    "instagram": ChannelAdapterConfig(
        authorize_url="https://www.instagram.com/oauth/authorize",
        token_url="https://api.instagram.com/oauth/access_token",
        # manage_comments는 조각③(댓글) 대상이라 지금은 미사용이어도 스코프는 미리
        # 선언한다(threads_delete·threads_manage_replies 선례와 동형 — 새 연결부터
        # 적용, 기존 연결은 재인증 전까지 그 능력이 막힌다, 의도).
        scope="instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments",
        refresh_mode="reissue_from_access_token",
        credential_kind="oauth",
        display_name="Instagram",
        max_text_length=2200,  # 캡션 상한(스토리 본문 규격 표 IG 행, 그라운딩 실확認).
        utm_source="instagram",
        utm_medium="social",
        # story #3320 조각③ — supports_fetch_replies/reply를 켠다(페드루 PO 明示,
        # `instagram_publish.py::fetch_replies`/`reply`+`channel_post_comments.py`
        # dispatch가 이제 있다). supports_unpublish는 여전히 미선언(instagram_
        # publish.py::delete_media 참고 — 삭제 API 자체가 미확認, 조각①과 무변경).
        # 규격(JPEG·4:5~1.91:1·8MB·피드 이미지 1장) — 스토리 본문 규격 표 IG 행
        # 그대로(그라운딩 실확認 대상), 캐러셀/릴스는 조각① 스코프 밖. ⚠️width_min/
        # width_max는 그라운딩이 명시 확認하지 않아 Threads 값(320~1440)을 잠정
        # 재사용 — IG 최소 권장폭(320px)만 문서상 확실하고 상한은 미확認, 조각②
        # (실발행 경로) 착수 전 재확認 필요.
        image_formats=("image/jpeg",),
        image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=1.91,
        image_aspect_min=0.8,
        image_width_min=320,
        image_width_max=1440,
        image_color_space="sRGB",
        # story #3550(Phase2, 페드루 PO 確定 2026-09-06) — 캐러셀 2~10장(Meta 문서
        # 지식·⚠️미확認, 재확認 전 라이브 금지). 1→10 상향이 유일한 변경 — 규격(비율·
        # 용량·해상도)은 장별로 그대로 각각 적용된다(channel_post_images.py의 검증이
        # 이미지 1건 처리라 여러 번 호출되는 구조, 새 루프 불요).
        image_max_count=10,
        # story #3554(Phase2, 페드루 PO 確定 2026-09-06①) — Meta 문서 지식(⚠️미확認,
        # 재확認 전 라이브 금지) — 릴스 3~90초·9:16(±5% 허용 오차)·MP4/MOV 컨테이너
        # (H.264/HEVC만 파서로 검증, 오디오 코덱은 미검증 선언). 100MB는 Graph API
        # 업로드 한도 문서값 그대로.
        video_max_bytes=100 * 1024 * 1024,
        video_max_seconds=90.0,
        video_min_seconds=3.0,
        video_aspect_target=9 / 16,
        video_aspect_tolerance=0.05,
        video_codecs=("avc1", "hvc1", "hev1"),
        supports_fetch_replies=True,
        supports_reply=True,
        reply_required_scope="instagram_business_manage_comments",
        # story #3320 조각③ — 페드루 PO 決定⑤=(b): likes+comments+saved(+shares)를
        # engagements로 합산(insight_snapshots.py::_fetch_instagram 참고). reach는
        # §2(d) 7키 이름 그대로 개별 유지. clicks/spend/conversions는 IG 유기 미디어
        # API가 안 줌(Threads와 동일 사유). 페드루 PO REQUIRED(2026-09-06, #3874
        # 리뷰) — impressions는 2024-07-02 이후 미디어에 폐기돼 선언 안 함(항상
        # None), 대신 views를 threads와 같은 이름으로 선언.
        insight_metrics=("views", "reach", "engagements"),
        # story #3536(PO 確定 2026-09-06) — IG 피드 발행은 이미지 1장이 구조적으로
        # 필수(캡션만으론 컨테이너 생성 자체가 provider에서 거부됨, instagram_
        # publish.py::create_media_container의 image_url=None 즉시 거부와 동형 사실).
        image_required=True,
    ),
    # story #3547(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Facebook Page 피드
    # 발행. 연결은 「Facebook Login」(그라운딩 확認 — Instagram Login과 별개 제품)
    # 이라 authorize/callback이 threads·instagram과 다른 흐름(장기 유저 토큰 →
    # /me/accounts로 페이지 선택, channel_connections.py 참고). ⚠️미확認 딱지
    # (facebook_oauth.py·facebook_publish.py 상단 참고) — scope/max_text_length/
    # 이미지 규격은 Meta 공식 문서 지식, 재확認 전 라이브 왕복 금지.
    "facebook": ChannelAdapterConfig(
        authorize_url="https://www.facebook.com/v21.0/dialog/oauth",
        token_url="https://graph.facebook.com/v21.0/oauth/access_token",
        # pages_show_list=/me/accounts 목록 조회 · pages_manage_posts=피드 발행/삭제
        # · pages_read_engagement=페이지 permalink류·인사이트 읽기(⚠️미확認, 그라운딩
        # 대상) · pages_manage_engagement=댓글 답변(story #3571, 페드루 PO 確定
        # 2026-09-06 — threads_manage_replies 선례와 동형: 기존 연결은 재인증 전까지
        # 답변이 막힌다, 의도).
        scope="pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement",
        # story #3598(BE·중형, PO 確定 2026-09-06) — FB 사전 갱신 필요성 판정. Meta 문서
        # 인용: 「장기 사용자 토큰으로 얻은 페이지 액세스 토큰은 만료되지 않는다」(developers.
        # facebook.com/docs/facebook-login/guides/access-tokens#pagetokens) — 비밀번호
        # 변경·권한 회수·앱 비활성 등 사용자/보안 행동으로만 "무효화"된다(시간 경과로는
        # 무효화 0). 결론: FB에 필요한 건 «갱신»이 아니라 «무효화 감지»(이 스토리의
        # classify_graph_oauth_error·샌드박스 마커 3종이 그 감지를 담당) — 이전에
        # "reissue_from_access_token"(threads류 자동 갱신 가능)로 잘못 선언돼 있었다:
        # can_auto_refresh()가 True를 내 list_connections_due_for_refresh()가 facebook
        # 연결을 "갱신 대상"으로 매 tick 집어 왔지만 cron._REFRESH_FN_BY_CHANNEL에
        # facebook이 없어 조용히 continue만 반복하던 죽은 경로(무해하나 FE
        # can_auto_refresh 플래그도 거짓 — "자동 갱신됨"이라 오해하게 함)였다. "manual"
        # (자동 갱신 불가 — 재인증 유도, 필드 docstring 그대로)이 사실과 맞는 선언.
        refresh_mode="manual",
        credential_kind="oauth",
        display_name="Facebook Page",
        max_text_length=63206,  # ⚠️미확認 — Meta 문서 지식(Facebook 피드 게시물 상한).
        utm_source="facebook",
        utm_medium="social",
        supports_unpublish=True,
        unpublish_required_scope="pages_manage_posts",
        # story #3571(Phase2·BE, 페드루 PO 確定 2026-09-06) — 댓글 조회/답변(Threads/
        # Instagram 동형 축, facebook_publish.py::fetch_replies/reply). ⚠️미확認
        # (그라운딩① — GET /{post-id}/comments·POST /{comment-id}/comments {message},
        # Instagram의 전용 /replies 엔드포인트와 다른 형).
        supports_fetch_replies=True,
        supports_reply=True,
        reply_required_scope="pages_manage_engagement",
        image_formats=("image/jpeg", "image/png"),
        image_max_bytes=10 * 1024 * 1024,
        image_width_min=320,
        image_width_max=1440,
        image_color_space="sRGB",
        # story #3567 발견 즉시 수정(페드루 PO 리뷰 정정 2026-09-06) — 3547이 이 필드를
        # 아예 선언 안 해 기본값 0.0으로 남아 있었다. channel_post_images.py의 Threads류
        # 정규화 검사는 `aspect_ratio = max(w,h)/min(w,h)`(항상 ≥1.0)를 `> image_aspect_
        # max`와 비교한다 — 0.0이면 이 비교가 **정사각형(1.0:1)을 포함해 모든 이미지**에서
        # 참이 된다(정사각형만 예외로 통과한다는 것은 부정확한 서술이었다 — 실측으로
        # 정정: `python3`로 800×800/1000×1000 케이스까지 직접 대입해 확認, 둘 다 거부).
        # 즉 3547의 단일-이미지 경로는 애초에 **어떤 이미지도** 못 올렸을 잠복 결함(이
        # 스토리의 다중 사진 테스트가 처음 실제로 노출·재현). Threads(image_aspect_
        # max=10.0)와 동형으로 관대하게 선언 — ⚠️미확認(Meta 문서 지식, 다른 image_*
        # 필드들과 동일 라벨).
        image_aspect_max=10.0,
        # story #3567(Phase2·BE, 페드루 PO 確定 2026-09-06③) — 다중 사진(캐러셀 동형)
        # 지원. 10은 Meta 문서상 실측 상한이 아니라 **제품 상한**(Instagram 캐러셀
        # image_max_count=10과 UX 일관성을 맞추기 위한 이 제품의 선택 — «미확認»
        # 이미지가 아니라 자체 정책값이라는 점이 image_formats/max_bytes 등 다른
        # ⚠️미확認 필드들과 다르다).
        image_max_count=10,
        image_required=False,  # Instagram과 달리 텍스트만으로도 피드 발행 가능.
        # story #3567(④) — Page 릴스. Meta 공식 규격을 그라운딩에서 확認 못 해
        # Instagram 값 그대로 동형 사용(⚠️미확認 — App Review로 실 Page 권한을
        # 받은 뒤 Meta 문서/실측으로 교체 필요, facebook.py 상단 딱지와 동일 원칙).
        video_max_bytes=100 * 1024 * 1024,
        video_max_seconds=90.0,
        video_min_seconds=3.0,
        video_aspect_target=9 / 16,
        video_aspect_tolerance=0.05,
        video_codecs=("avc1", "hvc1", "hev1"),
        # story #3571(Phase2·BE, 페드루 PO 確定 2026-09-06②) — Page 게시물 insights
        # → 정규화 7키 매핑(그라운딩②). impressions←post_impressions·reach←post_
        # impressions_unique(Page 게시물의 «도달» 표준 메트릭·⚠️미확認)·engagements←
        # post_engaged_users·clicks←post_clicks·views←post_video_views(영상
        # 게시물만 — insight_snapshots.py::_fetch_facebook이 응답에 그 메트릭이
        # 실제로 왔을 때만 채운다, 텍스트/이미지 게시물은 요청 metric 목록에 있어도
        # 응답에 없어 자동으로 null="미제공"이 된다, _normalize의 «선언은 했지만
        # 이번 fetch가 값을 못 줌» 경로 그대로 재사용 — 새 메커니즘 0). spend·
        # conversions=광고 축(Phase 3) — 대응 후보 자체가 없어 아예 미선언.
        insight_metrics=("impressions", "reach", "engagements", "clicks", "views"),
    ),
    "facebook_sandbox": ChannelAdapterConfig(
        authorize_url="https://www.facebook.com/v21.0/dialog/oauth",
        token_url="https://graph.facebook.com/v21.0/oauth/access_token",
        scope="pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement",
        refresh_mode="reissue_from_access_token",
        # 페드루 PO 確定(2026-09-06) — instagram_sandbox와 달리 credential_kind=
        # "oauth"(=none이 아님). 페이지 수 마커(:pages-0/:pages-1)를 sandbox 앱
        # 자격의 app_id 접미로 나르므로, org가 실제로 channel_app_credentials PUT을
        # 거쳐 그 마커를 등록해야 한다 — 그래서 이 채널은 범용 「/sandbox」 엔드포인트
        # (credential_kind=="none"만 받음)가 아니라 진짜 authorize→callback 라우터를
        # 탄다(facebook_sandbox_oauth.py가 Meta 호출부만 페이크로 스왑).
        credential_kind="oauth",
        display_name="Facebook Page Sandbox",
        max_text_length=63206,
        utm_source="facebook_sandbox",
        utm_medium="test",
        supports_unpublish=True,
        unpublish_required_scope="pages_manage_posts",
        # story #3571 — 실 facebook과 동형(댓글/답변, facebook_sandbox_publish.py::
        # fetch_replies/reply).
        supports_fetch_replies=True,
        supports_reply=True,
        reply_required_scope="pages_manage_engagement",
        image_formats=("image/jpeg", "image/png"),
        image_max_bytes=10 * 1024 * 1024,
        image_width_min=320,
        image_width_max=1440,
        image_color_space="sRGB",
        # story #3567 발견 즉시 수정(페드루 PO 리뷰 정정 2026-09-06) — 실 facebook과
        # 동일 이유(위 주석 참고 — 미선언 시 기본값 0.0은 정사각형 포함 모든 이미지를
        # 거부, "정사각형만 통과"는 부정확한 서술이었다).
        image_aspect_max=10.0,
        # story #3567 — 실 facebook과 동일 제품 상한(10). sandbox가 실계정보다
        # 관대하면 「sandbox는 됐는데 실계정은 막힘」류 격차가 생긴다(instagram_
        # sandbox_publish.py 상단 원칙과 동형).
        image_max_count=10,
        image_required=False,
        video_max_bytes=100 * 1024 * 1024,
        video_max_seconds=90.0,
        video_min_seconds=3.0,
        video_aspect_target=9 / 16,
        video_aspect_tolerance=0.05,
        video_codecs=("avc1", "hvc1", "hev1"),
        # story #3571 — 실 facebook과 동일 5키 선언(sandbox가 실계정보다 관대하면
        # 안 된다는 기존 관례 그대로, instagram_sandbox가 instagram과 동형 선언하는
        # 것과 같은 원칙 — 일반 "sandbox"의 7키 전부와는 다르다).
        insight_metrics=("impressions", "reach", "engagements", "clicks", "views"),
    ),
    # story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각①) — Sprintable
    # 호스팅 블로그를 blog kind 어댑터 1호로 등재한다. **동작 무변경** — site_posts.py의
    # 발행 흐름(`publish_site_post_from_draft` 등)은 지금처럼 내부 `site_posts` 테이블에
    # 직접 쓴다(어댑터 dispatch·publication_command 경로를 안 탄다, PO 確定 ③). 이 항목은
    # 순수 선언(레지스트리 등재)일 뿐 — available-channels·kind 필드로 존재를 노출하는
    # 것 외에 아무 기존 코드 경로도 건드리지 않는다. credential_kind="none"(연결 불요,
    # 항상 사용 가능) — OAuth 필드는 sandbox와 동형으로 빈 문자열.
    "hosted_site": ChannelAdapterConfig(
        authorize_url="",
        token_url="",
        scope="",
        refresh_mode="manual",
        credential_kind="none",
        display_name="Sprintable 호스팅 블로그",
        kind="blog",
        # story e4fc29fa(페드루 PO 리뷰 B1) — 연결할 게 없다(항상 사용 가능) — available-
        # channels 목록(연결 만들기 버튼 대상)에서 이 항목이 빠지는 유일한 근거.
        requires_connection=False,
        # site_posts.py::unpublish_site_post가 이미 존재(story #3381) — 선언은 그
        # 사실을 정확히 반영할 뿐(신규 동작 아님). 외부 스코프 개념이 없어(credential
        # 자체가 없다) unpublish_required_scope는 비운다.
        supports_unpublish=True,
        # story #3497 — beacon 집계(org_pageview_daily) 기반 views. story #3506(e) —
        # clicks 추가(beacon UTM 집계 org_pageview_utm_daily 기반, "이 글로 온 UTM
        # 유입 전체"). 나머지 5키는 항상 null(hosted_site는 impressions/reach/
        # engagements/spend/conversions 개념 자체가 없다 — 자체 방문자 카운터일 뿐
        # 광고·소셜 API가 아님).
        insight_metrics=("views", "clicks"),
    ),
    # story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③b) — WordPress
    # self-hosted(Application Password) blog kind 어댑터 2호. WordPress.com OAuth2는
    # 스토리 경계 明示로 이 조각 범위 밖(사람 의존 앱 등록 필요) — credential_kind만
    # 여기 pasted_secret로 선언, authorize_url/token_url/scope는 threads류 OAuth 흐름을
    # 안 타 sandbox/hosted_site와 동형으로 빈 문자열.
    "wordpress": ChannelAdapterConfig(
        authorize_url="",
        token_url="",
        scope="",
        # Application Password는 만료가 없고 refresh 개념 자체가 없다(재발급=휴먼이
        # WordPress 관리자 화면에서 새 비밀번호를 새로 붙여넣는 것뿐 — connected_by가
        # 재연결하는 수동 경로).
        refresh_mode="manual",
        credential_kind="pasted_secret",
        display_name="WordPress(self-hosted)",
        kind="blog",
        # unpublish=wordpress_publish.unpublish()(status=draft 전환) — Application
        # Password는 스코프 개념이 없어(전권 아니면 credential 자체가 없다) 여기도
        # hosted_site와 동형으로 비운다.
        supports_unpublish=True,
    ),
    # story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각④) — 고객 자체
    # 사이트 signed webhook blog kind 어댑터 3호. credential_kind=pasted_secret(공유
    # 비밀 — wordpress Application Password와 같은 컬럼 재사용, 유나 §8③ 정본).
    "webhook": ChannelAdapterConfig(
        authorize_url="",
        token_url="",
        scope="",
        refresh_mode="manual",
        credential_kind="pasted_secret",
        display_name="고객 웹훅(signed)",
        kind="blog",
        # unpublish=webhook_publish.unpublish()(event:"unpublish" 신호 POST) — webhook
        # 도 스코프 개념이 없다(공유 비밀 하나가 전권).
        supports_unpublish=True,
    ),
}

# story 5b27b32f(Phase1·BE·테스트 인프라, 페드루 PO 확定 2026-09-04) — dev 전용 샌드박스
# 채널. dev org에 실 Meta 자격이 없어(채널 연결 0건) publication_command·cron tick·
# cancel-scheduled·unpublish·429·컨테이너 폴링 경로를 라이브로 한 번도 못 밟던 문제
# (카디르 배포17 관측) — Threads 어댑터 코드(threads_publish.py)는 그대로 두고, 별도
# 결정적 가짜 provider(sandbox_publish.py)로 같은 오케스트레이션 경로를 태운다.
#
# **fail-closed 이중 방어**(AC1·AC5): ①이 아래 블록 자체가 `SANDBOX_CHANNEL_ENABLED=true`
# 일 때만 등재한다(cloudbuild.yaml이 dev에만 이 값을 싣고 prod엔 키 자체가 없다 —
# GCS_CHANNEL_MEDIA_BUCKET 이전의 ADMIN_OPERATOR_* 관례 그대로) ②그래도 잘못 켜졌을 경우
# (수동 오조작 등)를 대비해 `assert_sandbox_channel_not_registered_in_prod()`가 기동
# 시점에 `settings.is_prod_deploy`와 대조해 있으면 안 되는데 있으면 즉시 RuntimeError로
# 기동 자체를 죽인다(app/main.py lifespan에서 호출).
if os.environ.get("SANDBOX_CHANNEL_ENABLED", "").strip().lower() == "true":
    CHANNEL_ADAPTERS["sandbox"] = ChannelAdapterConfig(
        authorize_url="",  # OAuth 없음(AC2) — 연결은 POST .../channel-connections/sandbox 전용.
        token_url="",
        scope="sandbox_publish,sandbox_delete,sandbox_manage_replies",
        refresh_mode="manual",  # 더미 토큰이라 자동 갱신 개념 자체가 없음.
        credential_kind="none",
        display_name="Sandbox",
        max_text_length=500,  # Threads와 동형(그라운딩 §1 실측 재사용, 새 한도를 지어내지 않는다).
        utm_source="sandbox",
        utm_medium="test",
        supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        # story #3516 — sandbox가 결정적 가짜 댓글(기본 2건)을 낸다(sandbox_publish.py::
        # fetch_replies). 「하나 지워진 상태」 재현은 publication_id 해시 시드의 패리티로
        # 결정적으로 만든다(라이브 테스트가 재현 가능하게, 새 파라미터 없이).
        supports_fetch_replies=True,
        supports_reply=True,
        reply_required_scope="sandbox_manage_replies",
        # Threads와 동일 이미지 규격(AC1 "Threads와 같은 모양") — sandbox_publish.py가
        # 실제로 Pillow 변환 파이프라인을 거치므로(channel_post_images.py는 채널 무관 공용)
        # 같은 한도가 그대로 의미를 가진다.
        image_formats=("image/jpeg", "image/png"),
        image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0,
        image_width_min=320,
        image_width_max=1440,
        image_color_space="sRGB",
        image_max_count=1,
        # story #3497 — 테스트 인프라 채널이라 7키 전부 결정적 합성값(실 provider 없이
        # 정규화·evidence 파이프라인 전체를 라이브로 실측하기 위함, 5b27b32f와 동일 취지).
        insight_metrics=(
            "impressions", "reach", "views", "engagements", "clicks", "spend", "conversions",
        ),
    )
    # story #3320 조각① — Instagram 전용 sandbox. 기존 "sandbox"(Threads류 TEXT-
    # optional)와 같은 값을 재사용하지 않는 이유는 위 instagram_sandbox_publish.py
    # docstring 참고(이미지 필수라는 성질 차이) — `get_publish_client_module`의
    # 채널→모듈 dict가 이 구분을 그대로 반영한다.
    CHANNEL_ADAPTERS["instagram_sandbox"] = ChannelAdapterConfig(
        authorize_url="",
        token_url="",
        scope="sandbox_publish,sandbox_delete,sandbox_manage_replies",
        refresh_mode="manual",
        credential_kind="none",
        display_name="Instagram Sandbox",
        max_text_length=2200,  # instagram과 동형(캡션 상한).
        utm_source="instagram_sandbox",
        utm_medium="test",
        # story #3320 조각③ — "sandbox"(위)와 동형으로 켠다(instagram_sandbox_publish.py
        # ::fetch_replies/reply가 이제 있다).
        supports_fetch_replies=True,
        supports_reply=True,
        reply_required_scope="sandbox_manage_replies",
        image_formats=("image/jpeg",),
        image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=1.91,
        image_aspect_min=0.8,
        image_width_min=320,
        image_width_max=1440,
        image_color_space="sRGB",
        # story #3550 — 위 instagram과 동형 정정(1→10, sandbox가 실 provider보다
        # 관대하면 안 된다는 기존 관례 그대로 같은 값 유지).
        image_max_count=10,
        # story #3554 — 위 instagram과 동형(sandbox가 실 provider보다 관대하면 안
        # 된다는 기존 관례 그대로 같은 값).
        video_max_bytes=100 * 1024 * 1024,
        video_max_seconds=90.0,
        video_min_seconds=3.0,
        video_aspect_target=9 / 16,
        video_aspect_tolerance=0.05,
        video_codecs=("avc1", "hvc1", "hev1"),
        # 페드루 PO REQUIRED(2026-09-06, #3874 리뷰) — 위 instagram과 동형 정정
        # (impressions 폐기, views로 대체).
        insight_metrics=("views", "reach", "engagements"),
        # story #3536(PO 確定 2026-09-06) — 위 "instagram"과 동형(이미지 필수).
        image_required=True,
    )


def get_channel_adapter(channel: str) -> ChannelAdapterConfig | None:
    return CHANNEL_ADAPTERS.get(channel)


def can_auto_refresh(refresh_mode: str) -> bool:
    return refresh_mode in ("refresh_token", "reissue_from_access_token")


class BlogChannelDispatchNotImplementedError(NotImplementedError):
    """story e4fc29fa(페드루 PO 리뷰 B2, 2026-09-04) — kind="blog" 채널은 이 함수의
    디스패치 대상이 아니다(hosted_site는 site_posts.py가 직접 처리·publication_command
    경로를 안 탄다; wordpress/webhook은 조각②에서 별도 배선). 이 함수가 아무 분기도
    못 찾으면 조용히 threads_publish로 떨어지던 것(수정 前 결함 — hosted_site가 Threads
    API 호출 코드를 잘못 타는 사고)을 fail-closed로 막는다."""

    def __init__(self, *, channel: str):
        self.channel = channel
        super().__init__(
            f"channel={channel!r}는 kind='blog'라 get_publish_client_module 디스패치 대상이 "
            "아닙니다(hosted_site=site_posts.py 직접 처리, wordpress/webhook=조각② 배선 예정)."
        )


class ChannelPublishDispatchNotImplementedError(Exception):
    """story #3320(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — dispatch fall-
    through 근본 처방. `get_publish_client_module`이 이전엔 미등록 채널을 조용히
    `threads_publish`로 떨어뜨렸다(e4fc29fa의 blog 오분기와 같은 사고 클래스 —
    "모르는 채널=기본값"이 실제로는 "모르는 채널이 Threads API를 잘못 탄다"는 뜻
    이었다, 이미 한 번 겪음). 이제 아래 dict에 없는 채널은 즉시 이 예외로 fail-
    closed(뮤테이션 대상 — dict에서 항목을 빼면 그 채널이 곧바로 이 예외를 내야
    한다)."""

    def __init__(self, *, channel: str):
        self.channel = channel
        super().__init__(f"발행 클라이언트 디스패치가 없는 채널입니다: {channel}")


# story #3320 — 채널→발행 클라이언트 모듈의 명시 등록표(모듈 경로 문자열, importlib로
# 지연 import — 순환 import 회피는 기존 로컬 import 관례와 동형). 새 채널을 추가할
# 때마다 이 한 줄만 늘리면 되고, 안 늘리면 `get_publish_client_module`이 즉시 예외를
# 낸다(위 사고 클래스의 근본 처방 — "그 외 전부 threads로" 폴백 자체를 없앤다).
_PUBLISH_CLIENT_MODULE_PATHS: dict[str, str] = {
    "sandbox": "app.services.sandbox_publish",
    "instagram_sandbox": "app.services.instagram_sandbox_publish",
    "threads": "app.services.threads_publish",
    "instagram": "app.services.instagram_publish",
    "facebook": "app.services.facebook_publish",
    "facebook_sandbox": "app.services.facebook_sandbox_publish",
}


def get_publish_client_module(channel: str):
    """story 5b27b32f — 발행 클라이언트 모듈 디스패치. `sandbox`/`instagram_sandbox`
    는 각각 `sandbox_publish`/`instagram_sandbox_publish`로 우회한다(같은 함수
    시그니처·같은 `ThreadsPublishError` 클래스를 그대로 재사용 — 신규 판정 로직 0).
    실 배포 채널(threads·instagram)은 각자의 실 클라이언트 모듈.

    story e4fc29fa(페드루 PO 리뷰 B2) — kind="blog" 채널(hosted_site 등)은 여기서
    명시적으로 거부한다(이 함수 자체가 site_posts.py 도메인과 무관 — blog는 그쪽의
    자체 어댑터 dispatch를 쓴다).

    story #3320(페드루 PO 確定) — 그 외(위 dict에 없는 채널)는 `ChannelPublishDispatch
    NotImplementedError`로 fail-closed(위 클래스 docstring 참고 — 예전엔 조용히
    threads_publish로 떨어지던 자리)."""
    adapter = get_channel_adapter(channel)
    if adapter is not None and adapter.kind == "blog":
        raise BlogChannelDispatchNotImplementedError(channel=channel)
    module_path = _PUBLISH_CLIENT_MODULE_PATHS.get(channel)
    if module_path is None:
        raise ChannelPublishDispatchNotImplementedError(channel=channel)
    import importlib
    return importlib.import_module(module_path)


def assert_sandbox_channel_not_registered_in_prod() -> None:
    """story 5b27b32f(AC5) — 기동 시점 fail-closed 방어. env 플래그 게이트(위)가 이미
    prod cloudbuild.yaml에 `SANDBOX_CHANNEL_ENABLED` 키 자체를 안 실어 정상 배포에서는
    이 함수가 항상 no-op이다 — 그래도 수동 오조작(예: gcloud run services update로 누가
    직접 env를 붙임)까지 방어하는 두 번째 층. `app/main.py` lifespan이 기동마다 호출."""
    from app.core.config import settings

    if settings.is_prod_deploy and "sandbox" in CHANNEL_ADAPTERS:
        raise RuntimeError(
            "fail-closed: prod 배포에 sandbox 채널 어댑터가 등재돼 있습니다"
            "(SANDBOX_CHANNEL_ENABLED가 prod에 잘못 설정됐을 가능성 — story 5b27b32f AC5)."
        )
