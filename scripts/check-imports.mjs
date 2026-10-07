// Static check: every named import in public/js resolves to a real export in
// its target file. One missing export kills the whole ES-module graph (the
// browser shows a SyntaxError and the app never boots), so catch them here.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js');
const exportsOf = {};
const importSpecs = [];

for (const f of readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const src = readFileSync(join(dir, f), 'utf8');
  exportsOf[f] = [
    ...src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z0-9_$]+)/g),
  ].map((m) => m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    importSpecs.push([f, m[2], names]);
  }
}

let bad = 0;
for (const [f, spec, names] of importSpecs) {
  if (!spec.startsWith('.')) continue; // 'three' / bare specifiers
  const target = spec.endsWith('.js') ? spec : `${spec}.js`;
  const targetFile = normalize(join(dir, target)).replace(`${dir}/`, '');
  const avail = exportsOf[targetFile];
  if (!avail) {
    console.log(`MISSING FILE: ${f} imports ${spec}`);
    bad++;
    continue;
  }
  for (const n of names) {
    if (!avail.includes(n)) {
      console.log(`MISSING EXPORT: ${f} imports { ${n} } from ${spec}`);
      bad++;
    }
  }
}
console.log(bad ? `${bad} problem(s)` : 'All named imports resolve ✔');
process.exitCode = bad ? 1 : 0;
