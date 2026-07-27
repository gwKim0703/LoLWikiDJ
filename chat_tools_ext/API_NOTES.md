# lolwiki.kr 신 API (앱 v2.0.3, libapp.so에서 추출 + 라이브 검증)

기존 자유게시판 백엔드가 **2026-07-19 04:00:23**에 신 REST API로 이전됨.
구 엔드포인트(`get_post.php`, `get_reply_2020.php` 등)는 그 시점 데이터에 **동결**됨.
신 API 베이스: `https://lolwiki.kr/api/app/api/v1`

공통 헤더(권장): `X-App-Platform: android`, `X-App-Version: 2.0.3`, `Accept: application/json`
**읽기(read)는 인증 불필요** — 확인됨. 서버: FastAPI(uvicorn).

## 읽기 (무인증, 검증 완료)

### 글 목록
`GET /legacy-read-compat/posts?board=freeboard&limit=<n>&offset=<m>`
- 커서 페이징: `before=<post_seq>` 도 지원 (무한스크롤용)
- 응답: `{status, count, offset, limit, has_more, next_before_seq, results:[Post]}`
- Post: `post_seq, title, body, author, author_id, author_stack_count, author_motto,
  created_at(ISO), likes, vote, views, comments, avatar_url, attachment_image_id,
  image_url, image_urls[], image_thumb_urls[], original_image_urls[], youtube_url,
  has_image, has_video, has_poll, notice, report_count, blinded, has_my_comment`

### 글 상세
`GET /legacy-read-compat/post?post_seq=<seq>`  → `{status, post:{...Post 전체필드...}}`

### 댓글
`GET /legacy-read-compat/comments?post_seq=<seq>` → `{status, post_seq, count, results:[Comment]}`
- Comment: `comment_seq, parent_id, author, author_id, is_mine, author_stack_count,
  author_motto, body, created_at, likes, avatar_url, image_url, image_id,
  image_format, source, deleted`

### 이전/다음 글
`GET /legacy-read-compat/adjacent?post_seq=<seq>`

### 레거시 신원 조회 (구 android_id → 신 유저/글 매핑, 무인증 read)
`GET /users/legacy-identity?legacy_id=<old_android_id>`
→ `{status, found, supported, platform, legacy_id, user:{nickname, stack_count, avatar_url},
    posts:[{id, legacy_post_seq, title, like_count, comment_count, created_at}]}`
- `id`=신 내부 post id, `legacy_post_seq`=구 post_seq (매핑 존재)

## OpenAPI 스펙 (전체 규격의 1차 출처)
`GET https://lolwiki.kr/api/app/openapi.json` — 무인증으로 열림. Swagger UI 는 `/api/app/docs`.
아래 쓰기 규격은 이 스펙에서 확인한 값이다.

## 쓰기 (스키마는 확인, 실제 등록은 라이브 스팸 방지 위해 완전검증 안 함)
- `POST /board/legacy-write/posts` : body 필수 `request_id, title, body` (string).
  `board`,`legacy_id`는 **extra_forbidden**. 신원은 body 아닌 헤더/토큰 추정. 401은 아니었음(본문검증이 먼저).
- `POST /board/legacy-write/images/pending` : 글 첨부 이미지 업로드 추정

### 글 사진 여러 장 (LegacyPostCreate / LegacyPostUpdate)
- `attachments`: `LegacyPostImage[]`, **maxItems 10** — 앱의 '사진 최대 10장'과 같은 상한.
  `LegacyPostImage = {image_id(3~64, 필수), image_format(3~16, 필수), byte_size(0~30MB, 기본 0)}`
- ⚠ **`byte_size` 는 스키마상 기본값 0 이지만 실제로는 필수다.** 빠지거나 0 이면
  `422 {"msg":"Value error, IMAGE_SIZE_REQUIRED","loc":["body"]}` 로 거부된다.
  스키마만 믿고 생략하면 글은 등록되는데 사진만 안 붙는 형태로 조용히 실패한다(2026-07-27 실제로 겪음).
  → 업로드한 원본 바이트 수를 그대로 넣는다. `images/pending` 쪽은 있든 없든 상관없다.
- 미인증 POST 로 본문 규격만 확인할 수 있다(본문 검증이 인증보다 먼저).
  `401 AUTH_REQUIRED` = 본문 통과 / `422` = 본문 거부. 라이브에 글이 생기지 않아 안전.
  검증 결과: 2·5·10장 통과, 11장 거부, byte_size 30MB 초과 거부.
- 단일 `image_id`/`image_format` 필드도 그대로 남아 있다. 둘을 함께 보내도 본문 검증은 통과하지만
  어느 쪽이 우선인지는 알 수 없어, 확장은 **1장이면 단일 필드 / 2장 이상이면 attachments** 만 보낸다.
  (attachments 가 422 로 거부되면 같은 request_id 로 단일 필드 재시도 → 글은 살리고 사유를 팝업에 표시)
- 읽기는 `image_urls[]`가 10장을 그대로 내려준다(`mode=images` 목록에서 확인).
  `image_media_types[]`, `attachment_image_ids[]` 도 같은 순서로 대응된다.
- 댓글(`LegacyCommentCreate`)에는 attachments 가 없다 — 댓글은 사진 1장뿐.
- `POST /board/posts` (신규): 필수 `local_user_key, title, body` — 쓰기 신원은 **local_user_key**
- 댓글 전용 legacy-write 없음(`legacy-write/comments` → 404). 댓글/추천은 신 board API 경유 추정.
- 인증 관련: `Authorization: Bearer`, `X-Device-ID`, `X-App-Build`, `users/login`, `auth/me|refresh`,
  `auth.accessToken/refreshToken/deviceId`. → 쓰기는 신원(local_user_key/토큰) 확보 필요. 추후 확인.

## 이미지 URL
- 신 API는 전체 URL(`https://img.lolwiki.kr/i/<id>/resize|thumb`) 제공.
- 구 클라이언트는 파일명→`http://lolwiki.kr/freeboard/uploads/...` 조립. **매핑 시 전체 URL 사용**.
