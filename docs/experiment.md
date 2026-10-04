# Эксперимент Klar: фиксированный датасет поставщиков

Воспроизводимая таблица `winRate` для ВКР. Источник данных — демо-матрица `shared/demo.ts`, сессия — `shared/experiment.ts` / `python/mcdm/fixture.py`.

## Датасет

**Контекст:** выбор поставщика.  
**Критерии** (все `weightUncertain: true`):

| id | Имя | direction | importance |
|----|-----|-----------|------------|
| price | Цена | min | high |
| lead_time | Срок поставки | min | high |
| defect_rate | Процент брака | min | medium |
| min_lot | Минимальная партия | min | low |

**Альтернативы (оценки):**

| id | Имя | Цена | Срок | Брак | Мин. партия |
|----|-----|------|------|------|-------------|
| alpha | ООО «АльфаСнаб» | [470, 490] | 5 | [1.2, 1.8] | 100 |
| beta | ИП Бета Логистик | [430, 460] | [7, 10] | 0.8 | 200 |
| gamma | Гамма Трейд | 520 | 3 | [2.0, 2.5] | 50 |
| delta | Дельта Партнёр | [450, 480] | 6 | [1.0, 1.4] | [80, 120] |

## Параметры воспроизведения

| Параметр | Значение |
|----------|----------|
| seed | **42** (`EXPERIMENT_SEED`) |
| samples | **2000** (`EXPERIMENT_SAMPLES`) |
| PRNG | Mulberry32 |
| Методы на одной выборке | TOPSIS-like (primary), Weighted Sum, VIKOR (v=0.5) |

Команды:

```bash
# TypeScript
npm run test:mcdm
npx tsx -e "import { experimentSupplierSession, EXPERIMENT_SAMPLES, EXPERIMENT_SEED } from './shared/experiment.ts'; import { runRobustMcdm } from './shared/mcdm.ts'; console.log(JSON.stringify(runRobustMcdm(experimentSupplierSession(), EXPERIMENT_SAMPLES, EXPERIMENT_SEED), null, 2))"

# Python (тот же seed)
cd python && python3 selftest.py
```

## Опорная таблица winRate (seed=42, samples=2000)

Значения получены `runRobustMcdm` / `run_robust_mcdm` на датасете выше (регрессия: не менять матрицу без обновления таблицы).

### TOPSIS-like (`ranking` / primary)

| Альтернатива | winRate | meanRank |
|--------------|---------|----------|
| Дельта Партнёр | 0.3710 | 1.964 |
| ООО «АльфаСнаб» | 0.2490 | 2.126 |
| ИП Бета Логистик | 0.2085 | 2.764 |
| Гамма Трейд | 0.1715 | 3.147 |

### Weighted Sum

| Альтернатива | winRate | meanRank |
|--------------|---------|----------|
| Дельта Партнёр | 0.4360 | 1.781 |
| ИП Бета Логистик | 0.2790 | 2.579 |
| ООО «АльфаСнаб» | 0.1680 | 2.272 |
| Гамма Трейд | 0.1170 | 3.367 |

### VIKOR

| Альтернатива | winRate | meanRank |
|--------------|---------|----------|
| Дельта Партнёр | 0.4805 | 1.692 |
| ООО «АльфаСнаб» | 0.3380 | 1.903 |
| ИП Бета Логистик | 0.0970 | 3.009 |
| Гамма Трейд | 0.0845 | 3.397 |

### Согласованность методов

| Метрика | Значение |
|---------|----------|
| leaderMatchRate (все три) | 0.617 |
| topsis↔wsm | 0.7695 |
| topsis↔vikor | 0.7545 |
| wsm↔vikor | 0.685 |

**Интерпретация для текста ВКР:** при фиксированном seed лидер всех трёх методов — «Дельта Партнёр», но TOPSIS-`winRate` ≈ 37% → лидер **неустойчив** (см. `sensitivityNote`). Согласие лидеров на выборках ≈ 62%.

## Audit trail

После `POST /api/analyze` ответ содержит `audit`: `{ id, ts, messages?, session, mcdmParams, ranking, methods, agreement, explanation, … }`.  
Дополнительно: `POST /api/audit` (echo + in-memory) и `GET /api/audit` / `?id=`. Клиент может дублировать запись в `localStorage` и отдавать JSON-файл (UI — отдельный патч).
