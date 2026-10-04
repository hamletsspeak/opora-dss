# Klar — Python MCDM

Порт робастного ядра `shared/mcdm.ts` (`run_robust_mcdm`): Monte-Carlo + TOPSIS-like / Weighted Sum / VIKOR на **одних** выборках.

## Запуск HTTP

```bash
cd python
python3 server.py
# POST http://127.0.0.1:8790/analyze
# body: { "session": {…}, "samples": 2000, "seed": 42 }
```

Переменные: `KLAR_PY_HOST` (default `127.0.0.1`), `KLAR_PY_PORT` (default `8790`).

Зависимости: только стандартная библиотека Python 3.10+.

## Самотест vs TypeScript

Из корня репозитория (нужны `npm ci` и `npx tsx`):

```bash
cd python
python3 selftest.py
```

Ожидание: `winRate` по методам совпадает с TS в пределах `1e-6` (обычно бит-в-бит при том же seed).

## Связь с TS API

Прод на Vercel по умолчанию использует TypeScript (`api/analyze.ts`).  
Локально можно держать Python-сервер рядом; опциональный флаг `MCDM_BACKEND=python|ts` в Express — см. `server/index.ts` (если включён интегратором). Клиент UI не обязан знать про Python.
