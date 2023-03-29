# Server

## 브랜치 관리 규칙

- `master` : 정식 배포용
- `develop` : 다음 버전 개발용
    - `master`에서 분기, 작업 후 `master`로 병합
- `feature/기능명` : 특정 기능 개발용
    - `develop`에서 분기, 작업 후 `develop`으로 병합
- `hotfix` : `master` 브랜치의 오류 수정용
    - `master`에서 분기, 작업 후 `master`로 병합

## 커밋 메세지 규칙
제목 작성 시, 커밋 유형에 맞는 `[Type]`을 앞에 붙여주세요. 

- `[FEAT ADD/UPDATE/REMOVE]` 기능 추가/수정/삭제
- `[FIX]` 버그 수정
- `[DOCS]` 문서 수정
- `[STYLE]` 코드 포맷팅
- `[REFACTOR]` 코드 리팩토링
- `[TEST]` 테스트 코드
- `[BUILD]` 빌드 파일 수정
- `[CHORE]` 기타 파일 수정
