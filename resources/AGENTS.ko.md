# AGENTS.md — 코드 분석 결과 규약 (English: `AGENTS.md`, this file: 한국어)

로컬 AI 에이전트는 소스 코드 분석 후 그 결과를 아래 규약으로 기록한다.
이 파일은 에이전트(Claude Code 등)가 읽는 유일한 계약 문서다.

## 기록 위치

    <workspace>/.scope/analysis.jsonl

- JSON Lines 형식. **1줄 = 분석 1건.**
- Append-only. 이미 존재하는 대상을 다시 분석했으면 새 줄을 추가한다.
  (마지막 줄이 최신 상태로 해석됨 — 기존 줄은 수정·삭제하지 않는다.)
- 함수·클래스가 소스에서 **사라졌으면** 삭제 표시 줄을 추가한다:
  `{"v": 1, "target": "func:src/a.ts:old", "deleted": true, "generatedAt": "…"}`
  (같은 target 을 나중에 다시 기록하면 다시 나타난다)

## 레코드 스키마

한 줄에 하나의 JSON 객체:

    {
      "v": 1,
      "target": "func:src/services/core.py:build_slice",
      "kind": "func",
      "name": "build_slice",
      "file": "src/services/core.py",
      "line": 186,
      "endLine": 214,
      "lang": "python",
      "srcHash": "a3f9c1d2e4b5",
      "summary": "이 함수가 무엇을 하는지 한 문단 요약",
      "params": ["idx", "seed", "max_depth"],
      "calls": ["_resolve", "node_key"],
      "calledBy": ["internal_calls"],
      "imports": [{"module": ".util", "names": ["node_key"]}],
      "model": "claude-sonnet-4-5",
      "generatedAt": "2026-10-12T09:30:00Z"
    }

## 필드 규칙

| 필수 | 필드 | 규칙 |
|---|---|---|
| Y | v | 스키마 버전, 항상 1 |
| Y | target | `<kind>:<file>:<qual>` 형식의 유니크 키. kind 는 func 또는 class. qual 규칙은 아래 |
| Y | kind | func \| class |
| Y | name | 심볼 이름 = qual 의 **마지막 세그먼트만** (`Invoice.Total` 이면 `Total`) |
| Y | file | 워크스페이스 상대경로, `/` 구분자 |
| Y | line / endLine | 정의 시작·끝 줄 (1-based) |
| Y | lang | python, typescript, go … |
| Y | srcHash | **함수 본문 텍스트의 sha1 앞 16자.** 본문은 file 의 line..endLine 범위 각 줄에서 줄 끝 `\r` 을 떼고 `\n` 으로 이은 것 (LF 파일은 원문 그대로) |
| Y | summary | LLM 요약. 한국어 또는 코드 주석 언어를 따름 |
| N | params | 파라미터 이름 배열 |
| N | calls | 본문에서 호출하는 프로젝트 내부 함수들. 코드에 적힌 한정자를 살려 쓴다 (`Invoice.Total`, `math::normalize`, `util.node_key`) — 동명 함수 구분에 쓰임 |
| N | calledBy | 이 함수를 호출하는 프로젝트 내부 함수들 (없으면 확장이 calls 로 역산) |
| N | imports | 이 파일의 import 목록. `{"module", "names"?, "alias"?}` 배열 — 아래 참고 |
| N | ns | 이 심볼이 속한 namespace / package / module (C# `Shop.Billing`, C++ `math`, Java `com.shop`) |
| N | entry | `true` 면 프레임워크·런타임이 부르는 진입점 (라우트 핸들러, 콜백, 이벤트 핸들러) — 고아 판정 제외 |
| N | model | 요약 생성에 쓴 모델 이름 |
| Y | generatedAt | ISO 8601 UTC |

## qual 규칙

- 클래스 메서드: `Class.method` (중첩 클래스는 `Outer.Inner.method`)
- 함수 안의 중첩 함수: `outer.<locals>.inner` (Python `__qualname__` 과 같음)
- 구분자는 언어와 무관하게 `.` — C++/Rust 의 `::` 도 `.` 로 쓴다
- namespace / package 는 qual 에 넣지 않고 `ns` 필드에 적는다

## imports — 동명 함수 해석

확장은 소스의 import 줄(`import`, `from … import`, `using`, `#include`, `use`, Go `import`)을
직접 읽어 같은 이름 함수 중 어느 쪽을 부르는지 판정한다. 확장이 못 읽는 경우
(매크로·코드 생성·빌드 설정의 경로 별칭 등) 에이전트가 `imports` 로 보완한다.
**파일 단위로 병합되므로 같은 파일의 레코드 하나에만 적어도 된다.**

| 언어 | module 표기 | 예 |
|---|---|---|
| Python | 점 표기, 상대 import 는 앞 점 | `{"module": ".core", "names": ["node_key"]}` |
| TS / JS | import 문 문자열 그대로 | `{"module": "../render", "names": ["blankCell"]}`, `{"module": "./cell", "alias": "cells"}` |
| C# / Java | namespace / package | `{"module": "Shop.Billing"}` |
| C / C++ | include 경로 또는 namespace | `{"module": "math/vec.h"}`, `{"module": "math"}` |
| Rust | use 경로 | `{"module": "crate::net::parse", "names": ["parse"]}` |
| Go | import 경로 | `{"module": "example.com/proj/math", "alias": "m"}` |

- `names` 가 없으면 모듈 전체 (`using`, `#include`, `use x::*`)
- `alias` 는 모듈 자체의 별칭 (`import * as cells`, `using R = Shop.Report`)
- 문자열만 적어도 된다: `"imports": ["Shop.Billing", "math/vec.h"]`

## 주의

- `.scope/` 디렉터리는 소스 분석 대상에서 제외한다
- summary 외에 코드를 복사해 넣지 않는다 — 확장이 원본 소스를 직접 읽음
- 클래스 분석의 경우 kind=class, params/calls/calledBy 는 생략 가능
- 새 필드(imports, ns, entry)는 모두 선택 — 기존 레코드는 그대로 유효
