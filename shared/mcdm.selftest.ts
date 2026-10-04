import { applyDemoSuppliers } from './demo.js';
import {
  experimentSupplierSession,
  EXPERIMENT_SAMPLES_QUICK,
  EXPERIMENT_SEED,
} from './experiment.js';
import { runRobustMcdm, isAnalysisReady } from './mcdm.js';
import { emptySession } from './types.js';
import { buildAuditRecord } from './audit.js';

const s = applyDemoSuppliers(emptySession());
if (!isAnalysisReady(s)) throw new Error('demo not ready');
const r = runRobustMcdm(s, EXPERIMENT_SAMPLES_QUICK, 7);
if (!r.ranking.length) throw new Error('empty ranking');
const sum = r.ranking.reduce((a, x) => a + x.winRate, 0);
if (Math.abs(sum - 1) > 0.02) throw new Error(`winRate sum ${sum}`);

if (!r.methods?.topsis?.length || !r.methods.wsm?.length || !r.methods.vikor?.length) {
  throw new Error('missing multi-method rankings');
}
if (r.ranking[0].alternativeId !== r.methods.topsis[0].alternativeId) {
  throw new Error('primary ranking must equal TOPSIS');
}
if (r.mcdmParams.seed !== 7 || r.mcdmParams.samples !== EXPERIMENT_SAMPLES_QUICK) {
  throw new Error('mcdmParams mismatch');
}
const { leaderMatchRate, pairwiseLeaderMatch } = r.agreement;
if (leaderMatchRate < 0 || leaderMatchRate > 1) throw new Error('bad leaderMatchRate');
for (const [k, v] of Object.entries(pairwiseLeaderMatch)) {
  if (v < 0 || v > 1) throw new Error(`bad pairwise ${k}`);
}

const exp = experimentSupplierSession();
const rExp = runRobustMcdm(exp, EXPERIMENT_SAMPLES_QUICK, EXPERIMENT_SEED);
const audit = buildAuditRecord({
  session: exp,
  analysis: rExp,
  explanation: rExp.sensitivityNote,
  messages: [{ role: 'user', content: 'эксперимент' }],
});
if (!audit.id || !audit.ranking.length || audit.mcdmParams.seed !== EXPERIMENT_SEED) {
  throw new Error('audit payload incomplete');
}

console.log(
  'OK',
  r.ranking.map((x) => `${x.name}:${(x.winRate * 100).toFixed(0)}%`).join(' | '),
);
console.log(
  'methods',
  `topsis=${r.methods.topsis[0].name}`,
  `wsm=${r.methods.wsm[0].name}`,
  `vikor=${r.methods.vikor[0].name}`,
  `agree=${(leaderMatchRate * 100).toFixed(0)}%`,
);
console.log(
  'experiment@seed7quick',
  rExp.ranking.map((x) => `${x.name}:${(x.winRate * 100).toFixed(1)}%`).join(' | '),
);
