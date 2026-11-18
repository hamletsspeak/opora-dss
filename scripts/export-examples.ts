/** Writes the built-in synthetic examples to data/examples/<problem_id>.json (keeps files in sync with code). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLES, validateProblem } from '../shared/problem/index.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'examples');
fs.mkdirSync(dir, { recursive: true });
for (const p of Object.values(EXAMPLES)) {
  const rep = validateProblem(p, { forRun: true });
  if (!rep.ok) throw new Error(`${p.problem_id}: ${rep.issues.map((i) => i.message).join('; ')}`);
  fs.writeFileSync(path.join(dir, `${p.problem_id}.json`), `${JSON.stringify(p, null, 2)}\n`, 'utf8');
  console.log(`data/examples/${p.problem_id}.json`);
}
