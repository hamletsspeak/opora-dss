"""Fixed supplier experiment session (mirrors shared/experiment.ts + demo.ts)."""

from __future__ import annotations

from typing import Any, Dict

EXPERIMENT_SEED = 42
EXPERIMENT_SAMPLES = 2000
EXPERIMENT_SAMPLES_QUICK = 500


def experiment_supplier_session() -> Dict[str, Any]:
    return {
        "context": "Эксперимент: выбор поставщика (фиксированный датасет Klar)",
        "criteria": [
            {
                "id": "price",
                "name": "Цена",
                "direction": "min",
                "weightUncertain": True,
                "importance": "high",
                "valueHint": [450, 500],
            },
            {
                "id": "lead_time",
                "name": "Срок поставки",
                "direction": "min",
                "weightUncertain": True,
                "importance": "high",
            },
            {
                "id": "defect_rate",
                "name": "Процент брака",
                "direction": "min",
                "weightUncertain": True,
                "importance": "medium",
            },
            {
                "id": "min_lot",
                "name": "Минимальная партия",
                "direction": "min",
                "weightUncertain": True,
                "importance": "low",
            },
        ],
        "alternatives": [
            {
                "id": "alpha",
                "name": "ООО «АльфаСнаб»",
                "scores": {
                    "price": [470, 490],
                    "lead_time": 5,
                    "defect_rate": [1.2, 1.8],
                    "min_lot": 100,
                },
            },
            {
                "id": "beta",
                "name": "ИП Бета Логистик",
                "scores": {
                    "price": [430, 460],
                    "lead_time": [7, 10],
                    "defect_rate": 0.8,
                    "min_lot": 200,
                },
            },
            {
                "id": "gamma",
                "name": "Гамма Трейд",
                "scores": {
                    "price": 520,
                    "lead_time": 3,
                    "defect_rate": [2.0, 2.5],
                    "min_lot": 50,
                },
            },
            {
                "id": "delta",
                "name": "Дельта Партнёр",
                "scores": {
                    "price": [450, 480],
                    "lead_time": 6,
                    "defect_rate": [1.0, 1.4],
                    "min_lot": [80, 120],
                },
            },
        ],
        "missing": [],
        "readyForAnalysis": True,
        "usedDemoData": True,
    }
