# Klar — СППР (MVP)

Мобильный веб-MVP **Klar**: в диалоге собираем нечёткие критерии, затем устойчиво сравниваем варианты (Monte-Carlo / SMAA-lite + TOPSIS) с учётом интервалов и неопределённых весов.

## Быстрый старт (локально)

```bash
git clone https://github.com/hamletsspeak/opora-dss.git
cd dss-opora
cp .env.example .env
# Впишите OPENAI_API_KEY в .env (не коммитьте)
npm install
npm run dev
```

- UI: http://localhost:5173  
- API (Express): http://localhost:8787  

Продакшен локально: `npm run build && npm start`.

## Переменные окружения

| Переменная | Обязательно | Описание |
|---|---|---|
| `OPENAI_API_KEY` | да | Ключ OpenAI (только сервер / Vercel env) |
| `OPENAI_MODEL` | нет | По умолчанию `gpt-4o-mini` |
| `PORT` | нет | Порт локального Express (по умолчанию `8787`) |

`.env` в `.gitignore`. Шаблон — `.env.example`.

## Деплой на Vercel

Проект готов к Vercel: статика Vite (`dist`) + serverless-функции в `/api` (`chat`, `demo`, `analyze`, `health`).

1. Залейте репозиторий на GitHub.
2. [vercel.com/new](https://vercel.com/new) → Import репозитория.
3. Framework Preset: **Vite** (или оставьте авто из `vercel.json`).
4. Environment Variables:
   - `OPENAI_API_KEY` = ваш ключ  
   - `OPENAI_MODEL` = `gpt-4o-mini` (опционально)
5. Deploy.

CLI:

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
# env: vercel env add OPENAI_API_KEY
```

После деплоя UI и `/api/*` на одном домене (без отдельного Express).

## Архитектура

```
Браузер (React/Vite, RU UI)
    │  POST /api/chat | /api/demo | /api/analyze
    ▼
Локально: Express (server/)     Прод/Vercel: api/*.ts (serverless)
    │
    ├── server/agent.ts  — LLM-извлечение структуры
    └── shared/mcdm.ts   — робастный MCDM без LLM
```

**Поток:** чат → уточнения / демо → `runRobustMcdm` → ранжирование + LLM-объяснение по метрикам.

## Пример фразы

> Я выбираю поставщика. Есть цена, срок поставки, процент брака и минимальная партия. По цене точно сказать не могу — примерно 450–500 рублей. Цена и срок для меня наиболее важны, но насколько именно — не знаю.

Кнопки: «Пример про поставщика» → «Демо-поставщики» → «Запустить анализ».

## Скрипты

- `npm run dev` — Express API + Vite  
- `npm run test:mcdm` — самопроверка движка  
- `npm run build` / `npm start` — локальный production  

## Ограничения MVP

- Без аккаунтов и сохранения сессий.  
- Качество извлечения зависит от LLM (есть fallback).  
- Manifest есть; полноценный service worker не подключён.
