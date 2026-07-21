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

## 쓰기 (미검증 — 라이브 스팸 방지 위해 완전검증 안 함)
- `POST /board/legacy-write/posts` : body 필수 `request_id, title, body` (string).
  `board`,`legacy_id`는 **extra_forbidden**. 신원은 body 아닌 헤더/토큰 추정. 401은 아니었음(본문검증이 먼저).
- `POST /board/legacy-write/images/pending` : 글 첨부 이미지 업로드 추정
- `POST /board/posts` (신규): 필수 `local_user_key, title, body` — 쓰기 신원은 **local_user_key**
- 댓글 전용 legacy-write 없음(`legacy-write/comments` → 404). 댓글/추천은 신 board API 경유 추정.
- 인증 관련: `Authorization: Bearer`, `X-Device-ID`, `X-App-Build`, `users/login`, `auth/me|refresh`,
  `auth.accessToken/refreshToken/deviceId`. → 쓰기는 신원(local_user_key/토큰) 확보 필요. 추후 확인.

## 이미지 URL
- 신 API는 전체 URL(`https://img.lolwiki.kr/i/<id>/resize|thumb`) 제공.
- 구 클라이언트는 파일명→`http://lolwiki.kr/freeboard/uploads/...` 조립. **매핑 시 전체 URL 사용**.
