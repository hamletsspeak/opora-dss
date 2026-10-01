import { applyDemoSuppliers } from './demo';
import { runRobustMcdm, isAnalysisReady } from './mcdm';
import { emptySession } from './types';

const s = applyDemoSuppliers(emptySession());
if (!isAnalysisReady(s)) throw new Error('demo not ready');
const r = runRobustMcdm(s, 500, 7);
if (!r.ranking.length) throw new Error('empty ranking');
const sum = r.ranking.reduce((a, x) => a + x.winRate, 0);
if (Math.abs(sum - 1) > 0.02) throw new Error(`winRate sum ${sum}`);
console.log(
  'OK',
  r.ranking.map((x) => `${x.name}:${(x.winRate * 100).toFixed(0)}%`).join(' | '),
);
