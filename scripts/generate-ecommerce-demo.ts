import { mkdir, writeFile } from 'node:fs/promises';
import { demoDataset } from '../shared/ecommerce/demo.js';

await mkdir('data/ecommerce', { recursive: true });
await writeFile('data/ecommerce/synthetic-monthly.csv', demoDataset(), 'utf8');
console.log('Создан data/ecommerce/synthetic-monthly.csv: 3 синтетических SKU × 48 месяцев, seed=42');
