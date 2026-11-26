"""fixture — 샘플 서비스 모듈.

analysis.jsonl 의 분석 대상. 레코드 line..endLine 이 이 파일의 실제
함수/클래스 본문과 정확히 일치해야 stale 판정이 ok 로 나온다.
"""


def build_slice(idx, seed, max_depth):
    """BFS 로 호출체인을 수집하는 fixture 함수."""
    seen = set()
    queue = [(seed, 0)]
    result = []
    while queue:
        node, depth = queue.pop(0)
        if node in seen or depth > max_depth:
            continue
        seen.add(node)
        result.append((node, depth))
        for nxt in _resolve(node, idx):
            queue.append((nxt, depth + 1))
    return result


def _resolve(node, idx):
    """노드의 다음 단계 후보 반환 (fixture)."""
    base = idx * 2 + node
    return [base, base + 1, node_key(base)]


def node_key(base):
    """키 문자열 생성 (fixture)."""
    return f"key-{base}"


class Parser:
    """fixture 파서 클래스 — 메서드 2개. """

    def __init__(self, dialect):
        self.dialect = dialect
        self.cache = {}

    def parse(self, text):
        """텍스트를 토큰 리스트로 (fixture)."""
        tokens = []
        for raw in text.split():
            tok = self._tokenize(raw)
            if tok is not None:
                tokens.append(tok)
        return tokens

    def _tokenize(self, raw):
        """단일 토큰화 (fixture)."""
        if not raw:
            return None
        key = (self.dialect, raw)
        if key not in self.cache:
            self.cache[key] = raw.strip(".,;:!?")
        return self.cache[key]
