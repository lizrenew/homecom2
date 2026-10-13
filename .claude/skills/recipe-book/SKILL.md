---
name: recipe-book
description: 레시피북에 새 레시피를 마크다운으로 추가하고, 나노바나나(Gemini 이미지 모델)로 애니메이션 영화 장면 썸네일을 그려 상단에 넣는다. "레시피 만들어줘", "15분 레시피", "저녁 레시피", "레시피북에 추가", "레시피 썸네일" 등의 요청 시 사용한다.
---

# 레시피북 스킬

레시피 마크다운 파일 하나와 썸네일 이미지 하나를 만들어 레시피북 폴더에 저장한다.

## 저장 위치

- 레시피: `week1/quests/레시피북/<요리이름>.md` (파일명은 한글 요리 이름, 띄어쓰기 없이. 예: `참치김치볶음밥.md`)
- 썸네일: `week1/quests/레시피북/images/<영문-슬러그>.png` (예: `tuna-kimchi-fried-rice.png`)
- 같은 이름의 파일이 이미 있으면 덮어쓰지 말고 사용자에게 먼저 물어본다.

## 절차

1. **요청 파악**: 끼니(아침/점심/저녁), 조리 시간, 분량, 재료 제한, 썸네일 캐릭터/영화를 확인한다. 말하지 않은 부분은 아래 기본값을 쓴다.
   - 기본값: 15분 이내, 1인분, 쉬움, 냉장고에 흔히 있는 재료
   - 썸네일 캐릭터를 말하지 않았으면 지브리풍 소녀가 그 요리를 먹는 장면으로 그린다.
2. **레시피 작성**: 아래 템플릿 그대로 작성한다. 만드는 법의 단계별 소요 시간을 다 더하면 총 조리 시간 안에 들어와야 한다.
3. **썸네일 생성**: `scripts/gen-thumbnail.ps1`을 실행한다(아래 참고).
4. **확인**: 생성된 PNG를 Read로 열어 요리와 장면이 맞는지 확인한다. 이상하면 프롬프트를 고쳐 한 번 더 생성한다.
5. **보고**: 레시피 파일과 이미지 경로를 링크로 알려준다.

## 레시피 템플릿

```markdown
![<캐릭터>가 <요리>를 먹는 장면](images/<영문-슬러그>.png)

# 🍳 <시간>분 <요리 이름>

> <한 줄 소개>

| 항목 | 내용 |
|------|------|
| ⏱️ 조리 시간 | <N>분 |
| 🍽️ 분량 | <N>인분 |
| 📊 난이도 | <쉬움/보통> |

---

## 🥬 재료

### 주재료
- <재료> <양>

### 양념
- <양념> <양>

---

## 👩‍🍳 만드는 법

1. **<단계 이름> (<N>분)**
   <설명>

...

---

## 💡 팁

- <팁 3~4개: 식감 살리는 법, 재료 대체, 응용 메뉴>
```

## 썸네일 생성

API 키는 `.claude/settings.local.json`의 `env.GEMINI_API_KEY`에 보관한다(이 파일은 .gitignore에 등록되어 커밋되지 않음). 스크립트는 `GEMINI_API_KEY` 환경변수가 있으면 그것을, 없으면 이 파일에서 키를 읽는다. 따라서 명령에서 키를 따로 설정하지 않는다.

- **키를 스킬, 레시피, 스크립트 파일에 절대 적지 않는다.** 키를 출력하거나 채팅에 다시 보여주지도 않는다.
- 스크립트가 `GEMINI_API_KEY is not set` 오류를 내면(값이 비었거나 `PASTE_...` 플레이스홀더), 사용자에게 `.claude/settings.local.json`에 키를 붙여넣어 달라고 안내한다.

프롬프트는 영어로 쓴다(Windows PowerShell 5.1에서 한글이 깨질 수 있음). 경로는 인자로 넘기므로 한글 경로여도 괜찮다.

```powershell
& '.claude\skills\recipe-book\scripts\gen-thumbnail.ps1' `
  -OutPath (Join-Path (Get-Location) 'week1\quests\레시피북\images\<영문-슬러그>.png') `
  -Prompt '<영어 프롬프트>'
```

### 프롬프트 형식

```
A warm, cozy hand-painted Japanese anime film still in the style of a classic Studio Ghibli movie,
inspired by <캐릭터 설명: 나이, 머리, 옷>, sitting at a small wooden table and happily eating
<요리 설명: 그릇, 토핑, 김>, <곁들인 재료 소품>. <시간대> light, soft steam rising,
rich food details that look delicious. Wide 16:9 composition, cinematic, no text.
```

예시(센과 치히로): `inspired by the protagonist of Spirited Away (Chihiro): a 10-year-old girl with brown hair tied in a ponytail, wearing a pink work uniform from the bathhouse`

- 기본 모델은 `gemini-2.5-flash-image`(나노바나나). 다른 모델은 `-Model`로 바꾼다.
- 이미지가 반환되지 않으면 스크립트가 응답 JSON을 출력하니, 거절 사유를 확인해 프롬프트를 고친다.
