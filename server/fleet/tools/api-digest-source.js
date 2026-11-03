/**
 * One pass over JavaScript or TypeScript source that tells strings, template literals, regular
 * expression literals and comments apart.
 *
 * The digest reads source for two things: the string literals a collector spells (they decide
 * which traced path segments survive, and which response values the privacy gate lets through)
 * and the `api.<name>` calls and imports the console makes. A regex over the raw text cannot do
 * either reliably: `path: rule.path || '/*'` in collectors/networking.js opens a "block comment"
 * that swallows every line up to the next `*` + `/`, and every literal in between is lost.
 *
 * Heuristic where JavaScript itself is ambiguous: a `/` starts a regular expression when the last
 * significant character is an operator or opening bracket, or the last word is a keyword such as
 * `return`. `<` is deliberately not such a character, so a JSX closing tag is never read as one,
 * and neither is the division after `i++`. A "regular expression" that reaches the end of its line
 * unterminated was a division after all, and is read as one.
 *
 * Known limit: JSX text holding `//` (a URL written between tags) reads as a line comment, and the
 * literals after it on that line are lost. Losing a literal errs the safe way for both callers: a
 * traced path keeps `{value}`, and the privacy gate refuses more, never less.
 */

const REGEX_AFTER_CHAR = new Set([...'(,=:[!&|?{};~+-*%^>']);
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof'
]);

/**
 * @param {string} src
 * @returns {{ code: string, literals: string[] }} the source with every comment removed (a line
 *   comment's newline stays), and the text of every string literal; a template literal
 *   contributes its static parts one by one.
 */
function scanSource(src) {
  const n = src.length;
  const literals = [];
  const depth = []; // open `${`: brace depth inside each
  let code = '';
  let i = 0;
  let prev = ''; // last significant character outside strings and comments
  let word = ''; // the identifier that ends at `prev`, if any
  let gap = false; // whitespace since `prev`

  const seen = c => {
    if (/[\w$]/.test(c)) word = gap || !/[\w$]/.test(prev) ? c : word + c;
    else word = '';
    prev = c;
    gap = false;
  };

  /** From an opening backtick, or the `}` that closes a `${`, to the closing backtick or next `${`. */
  const template = () => {
    let j = i + 1;
    let part = '';
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        part += src.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === '`') {
        if (part) literals.push(part);
        code += src.slice(i, j + 1);
        i = j + 1;
        seen('`');
        return;
      }
      if (c === '$' && src[j + 1] === '{') {
        if (part) literals.push(part);
        code += src.slice(i, j + 2);
        i = j + 2;
        depth.push(0);
        prev = '{';
        word = '';
        return;
      }
      part += c;
      j += 1;
    }
    code += src.slice(i);
    i = n;
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end;
      gap = true;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      gap = true;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let text = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          text += src.slice(j, j + 2);
          j += 2;
        } else {
          text += src[j];
          j += 1;
        }
      }
      literals.push(text);
      code += src.slice(i, j + 1);
      i = j + 1;
      seen(c);
      continue;
    }
    if (c === '`') {
      template();
      continue;
    }
    const postfix = (prev === '+' || prev === '-') && code.trimEnd().endsWith(prev + prev);
    if (c === '/' && !postfix && (!prev || REGEX_AFTER_CHAR.has(prev) || REGEX_AFTER_WORD.has(word))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        const x = src[j];
        if (x === '\\') {
          j += 2;
          continue;
        }
        if (inClass) {
          if (x === ']') inClass = false;
        } else if (x === '[') {
          inClass = true;
        } else if (x === '/') {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        j += 1;
        while (j < n && /[a-z]/i.test(src[j])) j += 1;
        code += src.slice(i, j);
        i = j;
        seen('/');
        word = '';
        continue;
      }
    }
    if (depth.length && c === '{') depth[depth.length - 1] += 1;
    if (depth.length && c === '}') {
      if (depth[depth.length - 1] === 0) {
        depth.pop();
        template();
        continue;
      }
      depth[depth.length - 1] -= 1;
    }
    code += c;
    if (/\s/.test(c)) gap = true;
    else seen(c);
    i += 1;
  }
  return { code, literals };
}

/** The source with its comments removed and every string and regular expression intact. */
const stripComments = src => scanSource(src).code;

/** The character each one-letter escape stands for, as a code point. */
const ESCAPE_CODES = { n: 10, r: 13, t: 9, b: 8, f: 12, v: 11, 0: 0 };
const LINE_SEPARATORS = new Set([0x2028, 0x2029]);

/**
 * A literal's text as it prints. `scanSource` keeps every escape as written, which is what a
 * reader of the source needs; a sentence vouches for a document only as it prints, and
 * `One cluster\'s` prints `One cluster's`. A line continuation prints nothing, and an escape no
 * string could hold (a tagged template's) stays as written.
 */
function unescapeLiteral(text) {
  return text.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (whole, e) => {
    if (e[0] === 'u' && e.length > 1) {
      const cp = parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === '\r\n' || e === '\n' || e === '\r' || LINE_SEPARATORS.has(e.codePointAt(0))) return '';
    return e in ESCAPE_CODES ? String.fromCharCode(ESCAPE_CODES[e]) : e;
  });
}

export default { scanSource, stripComments, unescapeLiteral };
