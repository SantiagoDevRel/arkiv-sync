/** Mask strings/comments without changing offsets; their question marks are data. */
function codeMask(code) {
  return code.replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    token => (token.startsWith('//') || token.startsWith('/*') ? ' ' : '0') + ' '.repeat(token.length - 1));
}

function ternaryQuestions(code) {
  const masked = codeMask(code), stack = [], matched = new Set();
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const char = masked[i];
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (char === '?' && !['?', '.'].includes(masked[i + 1]) && masked[i - 1] !== '?') stack.push({ index: i, depth });
    else if (char === ':') {
      const at = stack.findLastIndex(item => item.depth === depth);
      if (at < 0) continue;
      const question = stack.splice(at, 1)[0].index;
      const before = masked.slice(0, question).trimEnd();
      const yes = masked.slice(question + 1, i).trim();
      const no = masked.slice(i + 1).trimStart();
      if (/[\w)\]}]$/.test(before) && /^[\w([{!~+\-]/.test(yes) && /^[\w([{!~+\-]/.test(no)) matched.add(question);
    }
  }
  return { masked, matched };
}

/** Reject lost prose/arithmetic symbols, allowing conditional operators only in code. */
export function markdownOperatorViolations(file, text) {
  if (!/\.md$/i.test(file)) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n'), spans = [], offsets = [];
  let fence, offset = 0;
  for (const [index, line] of lines.entries()) {
    offsets.push(offset);
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], size: marker[1].length, start: offset + line.length + 1, firstLine: index + 1, js: /^(?:js|javascript|ts|typescript|jsx|tsx|mjs|cjs)\s*$/i.test(marker[2].trim()) };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) {
        if (fence.js) spans.push({ start: fence.start, end: offset, ...ternaryQuestions(lines.slice(fence.firstLine, index).join('\n')) });
        fence = undefined;
      }
    } else if (!fence) {
      for (const match of line.matchAll(/(`+)([\s\S]*?)\1/g)) {
        const start = offset + match.index + match[1].length;
        spans.push({ start, end: start + match[2].length, ...ternaryQuestions(match[2]) });
      }
    }
    offset += line.length + 1;
  }
  if (fence?.js) spans.push({ start: fence.start, end: offset, ...ternaryQuestions(lines.slice(fence.firstLine).join('\n')) });
  return lines.flatMap((line, index) => {
    return [...line.matchAll(/\S\s+\?(?=\s+\S)/g)].flatMap(match => {
      const question = offsets[index] + match.index + match[0].lastIndexOf('?');
      const span = spans.find(item => question >= item.start && question < item.end);
      if (span) {
        const offset = question - span.start;
        if (span.masked[offset] !== '?' || span.matched.has(offset)) return [];
      }
      return [`${file}:${index + 1}: ambiguous question-mark operator; use the intended ASCII operator or arrow`];
    });
  });
}
