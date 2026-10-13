# Week 3 수업 — Playwright MCP 브라우저 자동화

작업일: 2026-10-13

Claude Code에 Playwright MCP를 설치하고, 브라우저를 직접 조작해 검색·캡처·폼 제출·쇼핑·리서치까지 해 본 기록입니다.

## 폴더 구성

```
week3/class/
├── README.md                  ← 이 문서 (세션 작업 요약)
├── docs/                      문서
│   └── dance-challenge-research.md   인스타그램 댄스 챌린지 리서치
├── web/                       웹사이트
│   └── index.html                    댄스 챌린지 트렌드 사이트 (React + Tailwind 단일 파일)
├── images/                    이미지
│   ├── thumbs/                       챌린지 썸네일 13장
│   └── screenshots/                  작업 결과 캡처 4장
└── logs/
    └── playwright/                   Playwright 작업 기록 (페이지 구조·콘솔 로그)
```

## 한 일

| # | 작업 | 결과 | 관련 파일 |
|---|---|---|---|
| 1 | Playwright MCP 설치 | Node.js 24.20.0 LTS 설치, Chromium 다운로드, `claude mcp add -s user playwright` 등록 후 연결 확인 | — |
| 2 | 네이버 환율 검색 | 하나은행 매매기준율 확인 (USD 1,341.10원, JPY100 848.26원, EUR 1,500.42원 등) | — |
| 3 | 네이버 오늘날씨 캡처 | 화면 전체 캡처 + 날씨 카드만 잘라서 저장 | [naver-weather](images/screenshots/naver-weather-2026-10-13.png), [날씨 카드](images/screenshots/naver-weather-card-2026-10-13.png) |
| 4 | 구글폼 자동 작성·제출 | "AI 공장장 4기" 실습 폼에 이름·목표·만족도 입력 후 제출 | [제출 완료](images/screenshots/google-form-submitted-2026-10-13.png) |
| 5 | 네이버 카페 (테슬라 TKC) 장터 검색 | 차량용 폰 거치대 매물 11개 목록 확인. 본문이 멤버 전용이라 가격은 확인 못 함 | — |
| 6 | 쿠팡 장바구니 담기 | 내일 아침거리 3개 담음: 곰곰 반숙란 15구, 파스퇴르 모닝롤, 돌 바나나. 합계 17,300원 (예산 2만 원) | — |
| 7 | 인스타그램 댄스 챌린지 리서치 | `#댄스챌린지` 검색 상위 30개 수집 → 2026년 챌린지 13개 정리 | [리서치 문서](docs/dance-challenge-research.md) |
| 8 | 리서치 웹사이트 제작 | 기간 필터·검색·정렬·상세 창이 있는 트렌드 사이트 | [web/index.html](web/index.html), [미리보기](images/screenshots/dance-challenge-site-preview.jpg) |

## 웹사이트 실행 방법

사이트가 `../images/thumbs/`의 썸네일을 불러오기 때문에 **`week3/class` 폴더를 기준으로** 서버를 띄워야 합니다.

```bash
cd week3/class
npx serve .
# 브라우저에서 http://localhost:3000/web/ 접속
```

VS Code Live Server를 쓸 때도 `web/index.html`을 연 상태에서 실행하면 됩니다.

## 주의

- `logs/playwright/`에는 로그인된 상태의 네이버 카페·쿠팡·인스타그램 페이지 내용이 기록되어 있어서 `.gitignore`로 git에서 제외해 두었습니다.
- 썸네일과 게시물 콘텐츠의 저작권은 각 인스타그램 원작자에게 있습니다.
