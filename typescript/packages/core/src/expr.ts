// Sandboxed expression language for guard / entryCondition / exitCondition /
// skipCondition. Deliberately tiny; identical evaluator in Python. Grammar:
//
//   expr    := or
//   or      := and ( "||" and )*
//   and     := unary ( "&&" unary )*
//   unary   := "!" unary | cmp
//   cmp     := primary ( ("=="|"!="|"<="|">="|"<"|">") primary )?
//   primary := literal | "has" "(" ident ")" | ident | "(" expr ")"
//   literal := number | string | true | false | null
//   ident   := name ("." name)*
//
// Semantics (pinned by fixtures):
// - identifiers resolve dotted paths in the vars bag; a missing path is null
// - == / != are strict; values of different types are never ==
// - < <= > >= require two numbers or two strings; anything else is false
// - && || ! operate on truthiness (false, null, 0, "" are falsy) and return booleans
// - has(x) is true iff the dotted path exists and its value is not null

export type ExprValue = string | number | boolean | null;

type Token =
  | { t: "op"; v: string }
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "lparen" }
  | { t: "rparen" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "&&" || two === "||") {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (c === "<" || c === ">" || c === "!") {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ t: "rparen" });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < n) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= n) throw new Error(`Unterminated string in expression: ${src}`);
      tokens.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && ((src[j]! >= "0" && src[j]! <= "9") || src[j] === ".")) j++;
      const lit = src.slice(i, j);
      if ((lit.match(/\./g) ?? []).length > 1) {
        throw new Error(`Malformed number literal '${lit}' in expression: ${src}`);
      }
      tokens.push({ t: "num", v: Number(lit) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.]/.test(src[j]!)) j++;
      tokens.push({ t: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character '${c}' in expression: ${src}`);
  }
  return tokens;
}

type Ast =
  | { k: "lit"; v: ExprValue }
  | { k: "var"; path: string }
  | { k: "has"; path: string }
  | { k: "not"; e: Ast }
  | { k: "bin"; op: string; l: Ast; r: Ast };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private src: string) {}

  parse(): Ast {
    const e = this.or();
    if (this.pos !== this.tokens.length) throw new Error(`Trailing tokens in expression: ${this.src}`);
    return e;
  }
  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private takeOp(...ops: string[]): string | null {
    const t = this.peek();
    if (t && t.t === "op" && ops.includes(t.v)) {
      this.pos++;
      return t.v;
    }
    return null;
  }
  private or(): Ast {
    let l = this.and();
    while (this.takeOp("||")) l = { k: "bin", op: "||", l, r: this.and() };
    return l;
  }
  private and(): Ast {
    let l = this.unary();
    while (this.takeOp("&&")) l = { k: "bin", op: "&&", l, r: this.unary() };
    return l;
  }
  private unary(): Ast {
    if (this.takeOp("!")) return { k: "not", e: this.unary() };
    return this.cmp();
  }
  private cmp(): Ast {
    const l = this.primary();
    const op = this.takeOp("==", "!=", "<=", ">=", "<", ">");
    if (op) return { k: "bin", op, l, r: this.primary() };
    return l;
  }
  private primary(): Ast {
    const t = this.peek();
    if (!t) throw new Error(`Unexpected end of expression: ${this.src}`);
    if (t.t === "num") {
      this.pos++;
      return { k: "lit", v: t.v };
    }
    if (t.t === "str") {
      this.pos++;
      return { k: "lit", v: t.v };
    }
    if (t.t === "lparen") {
      this.pos++;
      const e = this.or();
      const close = this.peek();
      if (!close || close.t !== "rparen") throw new Error(`Missing ')' in expression: ${this.src}`);
      this.pos++;
      return e;
    }
    if (t.t === "ident") {
      this.pos++;
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      if (t.v === "has") {
        const open = this.peek();
        if (open && open.t === "lparen") {
          this.pos++;
          const arg = this.peek();
          if (!arg || arg.t !== "ident") throw new Error(`has() requires an identifier: ${this.src}`);
          this.pos++;
          const close = this.peek();
          if (!close || close.t !== "rparen") throw new Error(`Missing ')' after has(: ${this.src}`);
          this.pos++;
          return { k: "has", path: arg.v };
        }
      }
      return { k: "var", path: t.v };
    }
    throw new Error(`Unexpected token in expression: ${this.src}`);
  }
}

export function parseExpr(src: string): Ast {
  return new Parser(tokenize(src), src).parse();
}

function resolvePath(vars: Record<string, unknown>, path: string): { found: boolean; value: unknown } {
  let cur: unknown = vars;
  for (const part of path.split(".")) {
    if (cur !== null && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return { found: false, value: null };
    }
  }
  return { found: true, value: cur };
}

function truthy(v: unknown): boolean {
  return !(v === false || v === null || v === undefined || v === 0 || v === "");
}

function evalAst(ast: Ast, vars: Record<string, unknown>): unknown {
  switch (ast.k) {
    case "lit":
      return ast.v;
    case "var": {
      const r = resolvePath(vars, ast.path);
      return r.found ? r.value : null;
    }
    case "has": {
      const r = resolvePath(vars, ast.path);
      return r.found && r.value !== null && r.value !== undefined;
    }
    case "not":
      return !truthy(evalAst(ast.e, vars));
    case "bin": {
      const op = ast.op;
      if (op === "&&") return truthy(evalAst(ast.l, vars)) && truthy(evalAst(ast.r, vars));
      if (op === "||") return truthy(evalAst(ast.l, vars)) || truthy(evalAst(ast.r, vars));
      const l = evalAst(ast.l, vars);
      const r = evalAst(ast.r, vars);
      if (op === "==") return strictEq(l, r);
      if (op === "!=") return !strictEq(l, r);
      if (typeof l === "number" && typeof r === "number") {
        if (op === "<") return l < r;
        if (op === "<=") return l <= r;
        if (op === ">") return l > r;
        if (op === ">=") return l >= r;
      }
      if (typeof l === "string" && typeof r === "string") {
        if (op === "<") return l < r;
        if (op === "<=") return l <= r;
        if (op === ">") return l > r;
        if (op === ">=") return l >= r;
      }
      return false;
    }
  }
}

function strictEq(l: unknown, r: unknown): boolean {
  const ln = l === undefined ? null : l;
  const rn = r === undefined ? null : r;
  if (ln === null && rn === null) return true;
  if (typeof ln !== typeof rn) return false;
  return ln === rn;
}

/** Evaluate an expression against a vars bag. Throws on parse errors. */
export function evalExpr(src: string, vars: Record<string, unknown>): unknown {
  return evalAst(parseExpr(src), vars);
}

/** Convenience: evaluate and coerce to boolean via pinned truthiness. */
export function evalCondition(src: string, vars: Record<string, unknown>): boolean {
  return truthy(evalExpr(src, vars));
}
