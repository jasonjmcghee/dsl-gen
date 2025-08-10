/* PRELUDE injected by lang-gen */
export function makeRunner(get_parser) {
  const parser = get_parser({ propagate_positions: true });
  
  function treeToJSON(node) {
    if (!node) return node;
    // Token (has type and value, but not data)
    if (node && node.type && 'value' in node && !('data' in node)) {
      return { type: node.type, value: node.value };
    }
    // Tree (has data and children)
    if (node && node.data && Array.isArray(node.children)) {
      const children = node.children.map(treeToJSON).filter(x => x !== undefined);
      return { type: node.data, children };
    }
    return node;
  }
  
  function debugTree(node, indent = '') {
    if (!node) return 'null';
    if (node && node.type && 'value' in node && !('data' in node)) {
      // Token
      console.log(indent + 'Token:', node.type, '=', node.value);
      return;
    }
    if (node && node.data && Array.isArray(node.children)) {
      // Tree
      console.log(indent + 'Tree:', node.data);
      for (const child of node.children) {
        debugTree(child, indent + '  ');
      }
      return;
    }
    console.log(indent + 'Unknown:', node);
  }
  
  return async function run(input) {
    const cst = parser.parse(input);
    console.log('=== RAW CST STRUCTURE ===');
    debugTree(cst);
    console.log('=========================');
    const ast = treeToJSON(cst);
    console.log('Input:', input);
    console.log('Parsed AST:', JSON.stringify(ast, null, 2));
    // User code below will define evaluate()
    const result = await evaluate(ast);
    return result;
  }
}

/* USER CODE BELOW */

function evaluate(ast) {
  const env = Object.create(null);

  function isToken(n) {
    return n && typeof n === 'object' && 'value' in n && !('children' in n);
  }

  function isTree(n) {
    return n && typeof n === 'object' && Array.isArray(n.children);
  }

  function tokenIs(n, sym) {
    if (!isToken(n)) return false;
    return n.value === sym || n.type === sym;
  }

  function firstTreeChild(children) {
    for (const c of children) if (isTree(c)) return c;
    return null;
  }

  function lastTreeChild(children) {
    for (let i = children.length - 1; i >= 0; i--) {
      if (isTree(children[i])) return children[i];
    }
    return null;
  }

  function expectTokenType(node, typeName) {
    if (!isToken(node) || node.type !== typeName) {
      throw new Error(`Expected token ${typeName}, got ${isToken(node) ? node.type : node.type || typeof node}`);
    }
  }

  function evalNumber(node) {
    // node: number -> [NUMBER]
    const tok = node.children.find(isToken);
    if (!tok) throw new Error('Malformed number node');
    expectTokenType(tok, 'NUMBER');
    const v = parseFloat(tok.value);
    if (Number.isNaN(v)) throw new Error(`Invalid number literal: ${tok.value}`);
    return v;
  }

  function evalVar(node) {
    // node: var -> [NAME]
    const tok = node.children.find(isToken);
    if (!tok) throw new Error('Malformed var node');
    expectTokenType(tok, 'NAME');
    const name = tok.value;
    if (!(name in env)) {
      throw new Error(`Undefined variable '${name}'`);
    }
    return env[name];
  }

  function evalParen(node) {
    // node: paren -> "(" expr ")"
    const inner = firstTreeChild(node.children);
    if (!inner) throw new Error('Malformed paren node');
    return evalNode(inner);
  }

  function evalSigned(node) {
    // node: signed -> ("+"|"-")* atom
    let sign = 1;
    for (const c of node.children) {
      if (isToken(c)) {
        if (tokenIs(c, '-')) sign = -sign;
        else if (tokenIs(c, '+')) { /* no-op */ }
      } else {
        // First non-token should be the atom
        const val = evalNode(c);
        return sign * val;
      }
    }
    // If no atom found (shouldn't happen)
    throw new Error('Malformed signed node');
  }

  function evalPow(node) {
    // node: pow -> unary ("^" power)?
    const baseNode = firstTreeChild(node.children);
    if (!baseNode) throw new Error('Malformed pow node');
    if (node.children.some((c) => isToken(c) && tokenIs(c, '^'))) {
      const expNode = lastTreeChild(node.children);
      if (!expNode || expNode === baseNode) throw new Error('Malformed pow exponent');
      const base = evalNode(baseNode);
      const exp = evalNode(expNode);
      return Math.pow(base, exp);
    }
    return evalNode(baseNode);
  }

  function evalAddSub(children) {
    // pattern: term (("+"|"-") term)*
    console.log('evalAddSub children:', children);
    if (children.length === 0) throw new Error('Malformed binary chain (empty)');
    let i = 0;
    // Find first tree node
    while (i < children.length && !isTree(children[i])) i++;
    if (i >= children.length) throw new Error('Malformed binary chain (no left term)');
    let acc = evalNode(children[i]);
    i++;
    while (i < children.length) {
      // Find operator token
      while (i < children.length && !isToken(children[i])) i++;
      if (i >= children.length) break;
      const opTok = children[i];
      i++;
      // Find next tree node
      while (i < children.length && !isTree(children[i])) i++;
      if (i >= children.length) break;
      const rhsNode = children[i];
      i++;
      
      const op = opTok.type;  // Now we have ADD_OP, SUB_OP tokens
      const rhs = evalNode(rhsNode);
      if (op === 'ADD_OP') acc = acc + rhs;
      else if (op === 'SUB_OP') acc = acc - rhs;
    }
    return acc;
  }

  function evalMulDiv(children) {
    // pattern: term (("*"|"/") term)*
    console.log('evalMulDiv children:', children);
    if (children.length === 0) throw new Error('Malformed binary chain (empty)');
    let i = 0;
    // Find first tree node
    while (i < children.length && !isTree(children[i])) i++;
    if (i >= children.length) throw new Error('Malformed binary chain (no left term)');
    let acc = evalNode(children[i]);
    i++;
    while (i < children.length) {
      // Find operator token
      while (i < children.length && !isToken(children[i])) i++;
      if (i >= children.length) break;
      const opTok = children[i];
      i++;
      // Find next tree node  
      while (i < children.length && !isTree(children[i])) i++;
      if (i >= children.length) break;
      const rhsNode = children[i];
      i++;
      
      const op = opTok.type;  // Now we have MUL_OP, DIV_OP tokens
      const rhs = evalNode(rhsNode);
      if (op === 'MUL_OP') acc = acc * rhs;
      else if (op === 'DIV_OP') acc = acc / rhs;
    }
    return acc;
  }

  function evalAssign(node) {
    // node: assign -> NAME "=" expr
    let nameTok = null;
    let exprNode = null;
    for (const c of node.children) {
      if (isToken(c) && c.type === 'NAME') nameTok = c;
      if (isTree(c)) exprNode = c; // the expr is typically the only tree child
    }
    if (!nameTok || !exprNode) throw new Error('Malformed assign node');
    const value = evalNode(exprNode);
    env[nameTok.value] = value;
    return value;
  }

  function evalStatement(node) {
    // Could be assign_stmt or expr_stmt; or raw statement with one child
    if (node.type === 'assign_stmt' || node.type === 'expr_stmt') {
      const child = firstTreeChild(node.children);
      if (!child) throw new Error(`Malformed ${node.type}`);
      return evalNode(child);
    }
    // Fallback for 'statement' rule node
    const meaningful = node.children.filter(isTree);
    if (meaningful.length === 1) return evalNode(meaningful[0]);
    // Try to find assign/expr statements specifically
    for (const c of node.children) {
      if (isTree(c) && (c.type === 'assign_stmt' || c.type === 'expr_stmt')) {
        return evalStatement(c);
      }
    }
    throw new Error('Malformed statement node');
  }

  function evalStart(node) {
    let last = undefined;
    for (const child of node.children) {
      if (!isTree(child)) continue;
      last = evalStatement(child.type === 'statement' ? child : child);
    }
    return last;
  }

  function evalNode(node) {
    if (!node || typeof node !== 'object') {
      throw new Error(`Invalid AST node: ${node}`);
    }
    if (isToken(node)) {
      // Only meaningful tokens at leaf level in this grammar are NUMBER and NAME,
      // but they should be wrapped by 'number'/'var' nodes. If reached, handle gracefully.
      if (node.type === 'NUMBER') {
        const v = parseFloat(node.value);
        if (Number.isNaN(v)) throw new Error(`Invalid number literal: ${node.value}`);
        return v;
      }
      if (node.type === 'NAME') {
        const name = node.value;
        if (!(name in env)) throw new Error(`Undefined variable '${name}'`);
        return env[name];
      }
      throw new Error(`Unexpected token '${node.type}'`);
    }

    switch (node.type) {
      case 'start':
        return evalStart(node);

      case 'assign_stmt':
      case 'expr_stmt':
      case 'statement':
        return evalStatement(node);

      case 'assign':
      case 'assignment':
        return evalAssign(node);

      case 'expr': {
        const inner = firstTreeChild(node.children);
        if (!inner) throw new Error('Malformed expr node');
        return evalNode(inner);
      }

      case 'sum':
        return evalAddSub(node.children);

      case 'product':
        return evalMulDiv(node.children);

      case 'pow':
      case 'power':
        return evalPow(node);

      case 'signed':
      case 'unary':
        return evalSigned(node);

      case 'number':
        return evalNumber(node);

      case 'var':
        return evalVar(node);

      case 'paren':
      case 'atom':
        // paren has an inner expr; atom may wrap number/var/paren
        if (node.type === 'paren') return evalParen(node);
        // 'atom' should have exactly one meaningful child; delegate
        {
          const inner = firstTreeChild(node.children);
          if (!inner) {
            // Could be raw token NUMBER/NAME if aliasing failed
            const tok = node.children.find(isToken);
            if (tok) return evalNode(tok);
            throw new Error('Malformed atom node');
          }
          return evalNode(inner);
        }

      default:
        throw new Error(`Unknown node type: ${node.type}`);
    }
  }

  return evalNode(ast);
}