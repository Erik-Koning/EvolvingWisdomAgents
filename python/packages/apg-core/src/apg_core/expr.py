# Sandboxed expression language for guard / entryCondition / exitCondition /
# skipCondition. Deliberately tiny; identical evaluator in TypeScript. Grammar:
#
#   expr    := or
#   or      := and ( "||" and )*
#   and     := unary ( "&&" unary )*
#   unary   := "!" unary | cmp
#   cmp     := primary ( ("=="|"!="|"<="|">="|"<"|">") primary )?
#   primary := literal | "has" "(" ident ")" | ident | "(" expr ")"
#   literal := number | string | true | false | null
#   ident   := name ("." name)*
#
# Semantics (pinned by fixtures):
# - identifiers resolve dotted paths in the vars bag; a missing path is null
# - == / != are strict; values of different types are never ==
# - < <= > >= require two numbers or two strings; anything else is false
# - && || ! operate on truthiness (false, null, 0, "" are falsy) and return booleans
# - has(x) is true iff the dotted path exists and its value is not null
import re
from typing import Any

_IDENT_START = re.compile(r"[A-Za-z_]")
_IDENT_CHAR = re.compile(r"[A-Za-z0-9_.]")


def _tokenize(src: str) -> list[tuple[str, Any]]:
    tokens: list[tuple[str, Any]] = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c in " \t\n\r":
            i += 1
            continue
        two = src[i : i + 2]
        if two in ("==", "!=", "<=", ">=", "&&", "||"):
            tokens.append(("op", two))
            i += 2
            continue
        if c in ("<", ">", "!"):
            tokens.append(("op", c))
            i += 1
            continue
        if c == "(":
            tokens.append(("lparen", None))
            i += 1
            continue
        if c == ")":
            tokens.append(("rparen", None))
            i += 1
            continue
        if c in ("'", '"'):
            quote = c
            j = i + 1
            out = ""
            while j < n and src[j] != quote:
                if src[j] == "\\" and j + 1 < n:
                    out += src[j + 1]
                    j += 2
                else:
                    out += src[j]
                    j += 1
            if j >= n:
                raise ValueError(f"Unterminated string in expression: {src}")
            tokens.append(("str", out))
            i = j + 1
            continue
        if "0" <= c <= "9":
            j = i
            while j < n and (("0" <= src[j] <= "9") or src[j] == "."):
                j += 1
            text = src[i:j]
            if text.count(".") > 1:
                raise ValueError(f"Malformed number literal '{text}' in expression: {src}")
            value: Any = float(text) if "." in text else int(text)
            tokens.append(("num", value))
            i = j
            continue
        if _IDENT_START.match(c):
            j = i
            while j < n and _IDENT_CHAR.match(src[j]):
                j += 1
            tokens.append(("ident", src[i:j]))
            i = j
            continue
        raise ValueError(f"Unexpected character '{c}' in expression: {src}")
    return tokens


class _Parser:
    def __init__(self, tokens: list[tuple[str, Any]], src: str) -> None:
        self.tokens = tokens
        self.src = src
        self.pos = 0

    def parse(self) -> dict:
        e = self._or()
        if self.pos != len(self.tokens):
            raise ValueError(f"Trailing tokens in expression: {self.src}")
        return e

    def _peek(self) -> tuple[str, Any] | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def _take_op(self, *ops: str) -> str | None:
        t = self._peek()
        if t is not None and t[0] == "op" and t[1] in ops:
            self.pos += 1
            return t[1]
        return None

    def _or(self) -> dict:
        left = self._and()
        while self._take_op("||"):
            left = {"k": "bin", "op": "||", "l": left, "r": self._and()}
        return left

    def _and(self) -> dict:
        left = self._unary()
        while self._take_op("&&"):
            left = {"k": "bin", "op": "&&", "l": left, "r": self._unary()}
        return left

    def _unary(self) -> dict:
        if self._take_op("!"):
            return {"k": "not", "e": self._unary()}
        return self._cmp()

    def _cmp(self) -> dict:
        left = self._primary()
        op = self._take_op("==", "!=", "<=", ">=", "<", ">")
        if op:
            return {"k": "bin", "op": op, "l": left, "r": self._primary()}
        return left

    def _primary(self) -> dict:
        t = self._peek()
        if t is None:
            raise ValueError(f"Unexpected end of expression: {self.src}")
        kind, value = t
        if kind == "num" or kind == "str":
            self.pos += 1
            return {"k": "lit", "v": value}
        if kind == "lparen":
            self.pos += 1
            e = self._or()
            close = self._peek()
            if close is None or close[0] != "rparen":
                raise ValueError(f"Missing ')' in expression: {self.src}")
            self.pos += 1
            return e
        if kind == "ident":
            self.pos += 1
            if value == "true":
                return {"k": "lit", "v": True}
            if value == "false":
                return {"k": "lit", "v": False}
            if value == "null":
                return {"k": "lit", "v": None}
            if value == "has":
                open_ = self._peek()
                if open_ is not None and open_[0] == "lparen":
                    self.pos += 1
                    arg = self._peek()
                    if arg is None or arg[0] != "ident":
                        raise ValueError(f"has() requires an identifier: {self.src}")
                    self.pos += 1
                    close = self._peek()
                    if close is None or close[0] != "rparen":
                        raise ValueError(f"Missing ')' after has(: {self.src}")
                    self.pos += 1
                    return {"k": "has", "path": arg[1]}
            return {"k": "var", "path": value}
        raise ValueError(f"Unexpected token in expression: {self.src}")


def parse_expr(src: str) -> dict:
    return _Parser(_tokenize(src), src).parse()


_MISSING = object()


def _resolve_path(vars: dict, path: str) -> Any:
    cur: Any = vars
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return _MISSING
    return cur


def truthy(v: Any) -> bool:
    if v is False or v is None:
        return False
    if isinstance(v, bool):
        return True
    if isinstance(v, (int, float)) and v == 0:
        return False
    if isinstance(v, str) and v == "":
        return False
    return True


def _js_type(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    return "object"


def _strict_eq(l: Any, r: Any) -> bool:
    if l is None and r is None:
        return True
    if _js_type(l) != _js_type(r):
        return False
    if isinstance(l, (dict, list)) or isinstance(r, (dict, list)):
        return l is r  # JS reference equality for objects
    return l == r


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _eval_ast(ast: dict, vars: dict) -> Any:
    k = ast["k"]
    if k == "lit":
        return ast["v"]
    if k == "var":
        r = _resolve_path(vars, ast["path"])
        return None if r is _MISSING else r
    if k == "has":
        r = _resolve_path(vars, ast["path"])
        return r is not _MISSING and r is not None
    if k == "not":
        return not truthy(_eval_ast(ast["e"], vars))
    # bin
    op = ast["op"]
    if op == "&&":
        return truthy(_eval_ast(ast["l"], vars)) and truthy(_eval_ast(ast["r"], vars))
    if op == "||":
        return truthy(_eval_ast(ast["l"], vars)) or truthy(_eval_ast(ast["r"], vars))
    l = _eval_ast(ast["l"], vars)
    r = _eval_ast(ast["r"], vars)
    if op == "==":
        return _strict_eq(l, r)
    if op == "!=":
        return not _strict_eq(l, r)
    if _is_number(l) and _is_number(r):
        if op == "<":
            return l < r
        if op == "<=":
            return l <= r
        if op == ">":
            return l > r
        if op == ">=":
            return l >= r
    if isinstance(l, str) and isinstance(r, str):
        if op == "<":
            return l < r
        if op == "<=":
            return l <= r
        if op == ">":
            return l > r
        if op == ">=":
            return l >= r
    return False


def eval_expr(src: str, vars: dict) -> Any:
    """Evaluate an expression against a vars bag. Raises on parse errors."""
    return _eval_ast(parse_expr(src), vars)


def eval_condition(src: str, vars: dict) -> bool:
    """Convenience: evaluate and coerce to boolean via pinned truthiness."""
    return truthy(eval_expr(src, vars))
