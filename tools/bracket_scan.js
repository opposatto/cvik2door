const fs = require('fs');
const s = fs.readFileSync('./index.js','utf8');
let line = 1, col = 0;
const stack = [];
let state = 'normal';
let quote = null;
for (let i = 0; i < s.length; i++) {
  const c = s[i];
  col++;
  if (c === '\n') { line++; col = 0; }
  if (state === 'normal') {
    if (c === '/' && s[i+1] === '/') { state = 'line'; i++; col++; continue; }
    if (c === '/' && s[i+1] === '*') { state = 'block'; i++; col++; continue; }
    if (c === '"' || c === "'" ) { state = 'str'; quote = c; continue; }
    if (c === '`') { state = 'template'; continue; }
    if (c === '{' || c === '(' || c === '[') stack.push({ch: c, line, col, i});
    if (c === '}' || c === ')' || c === ']') {
      const expect = c === '}' ? '{' : c === ')' ? '(' : '[';
      const top = stack[stack.length-1];
      if (!top || top.ch !== expect) {
        console.log(`Mismatch: unexpected closing '${c}' at line ${line} col ${col}`);
        console.log('Surrounding context:\n' + s.slice(Math.max(0, i-80), i+80));
        process.exit(0);
      }
      stack.pop();
    }
  } else if (state === 'line') {
    if (c === '\n') state = 'normal';
  } else if (state === 'block') {
    if (c === '*' && s[i+1] === '/') { state = 'normal'; i++; col++; }
  } else if (state === 'str') {
    if (c === '\\') { i++; col++; continue; }
    if (c === quote) state = 'normal';
  } else if (state === 'template') {
    if (c === '\\') { i++; col++; continue; }
    if (c === '`') state = 'normal';
  }
}
console.log('Scan complete. Unmatched openings:', stack.length);
if (stack.length) {
  console.log('Top unmatched items (most recent last):');
  stack.slice(-10).forEach(it => console.log(`${it.ch} at line ${it.line} col ${it.col}`));
}
