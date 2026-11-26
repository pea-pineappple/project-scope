"""fixture — 별칭 import 와 모듈 한정 호출 (동명 해석 검증용)."""
from .core import node_key as key_of
from . import util


def handle(seed):
    a = key_of(seed)
    b = util.node_key(seed)
    return a + b
