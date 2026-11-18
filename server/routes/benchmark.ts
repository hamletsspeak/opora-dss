import { readFileSync } from "node:fs";
import express from "express";
import { z } from "zod";
import { BenchmarkCorpus } from "../../shared/llm-eval/schema.js";
import { runBenchmark } from "../llm-eval/runner.js";
import type { AppDeps } from "../deps.js";
import { asyncRoute, HttpError, rateLimit } from "../http/middleware.js";
import { parseBody } from "./schemas.js";

export function benchmarkRouter(deps: AppDeps) {
  const r = express.Router();
  const loadCorpus = () =>
    BenchmarkCorpus.parse(
      JSON.parse(
        readFileSync(
          new URL("../../data/llm-benchmark/cases.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  r.get("/cases", (_req, res) => res.json(loadCorpus()));
  let running = false;
  r.post(
    "/",
    rateLimit(deps.config.llmRatePerMinute),
    express.json({ limit: deps.config.jsonLimit }),
    asyncRoute(async (req, res) => {
      const body = parseBody(
        z.strictObject({
          providers: z
            .array(
              z.enum(["mock", "openai", "yandexgpt", "ollama", "llamacpp"]),
            )
            .min(1)
            .max(5),
          case_ids: z.array(z.string().max(64)).min(1).max(36),
        }),
        req.body,
      );
      if (running)
        throw new HttpError(
          409,
          "Сравнение уже выполняется. Дождитесь завершения.",
          "benchmark_busy",
        );
      const corpus = loadCorpus();
      const selected = new Set(body.case_ids);
      if (
        [...selected].some((id) => !corpus.cases.some((c) => c.case_id === id))
      )
        throw new HttpError(400, "Неизвестная постановка", "bad_request");
      running = true;
      try {
        res.json(
          await runBenchmark(
            deps.llm,
            {
              ...corpus,
              cases: corpus.cases.filter((c) => selected.has(c.case_id)),
            },
            { providers: body.providers, app: deps.app },
          ),
        );
      } finally {
        running = false;
      }
    }),
  );
  return r;
}
