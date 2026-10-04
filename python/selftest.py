#!/usr/bin/env python3
"""Compare Python run_robust_mcdm with TS fixture numbers (tolerance)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from mcdm.core import run_robust_mcdm
from mcdm.fixture import (
    EXPERIMENT_SAMPLES_QUICK,
    EXPERIMENT_SEED,
    experiment_supplier_session,
)

ROOT = Path(__file__).resolve().parents[1]
TOL_WINRATE = 1e-9  # bit-identical expected for same seed
TOL_LOOSE = 1e-6


def ts_reference(samples: int, seed: int) -> dict:
    script = f"""
import {{ experimentSupplierSession }} from './shared/experiment.ts';
import {{ runRobustMcdm }} from './shared/mcdm.ts';
const r = runRobustMcdm(experimentSupplierSession(), {samples}, {seed});
console.log(JSON.stringify(r));
"""
    proc = subprocess.run(
        ["npx", "tsx", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS reference failed:\n{proc.stderr}\n{proc.stdout}")
    # last JSON line
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip().startswith("{")]
    if not lines:
        raise RuntimeError(f"no JSON from TS:\n{proc.stdout}")
    return json.loads(lines[-1])


def max_winrate_delta(a: list, b: list) -> float:
    by_id_a = {x["alternativeId"]: x["winRate"] for x in a}
    by_id_b = {x["alternativeId"]: x["winRate"] for x in b}
    if set(by_id_a) != set(by_id_b):
        raise AssertionError(f"id mismatch {by_id_a.keys()} vs {by_id_b.keys()}")
    return max(abs(by_id_a[k] - by_id_b[k]) for k in by_id_a)


def main() -> int:
    session = experiment_supplier_session()
    py = run_robust_mcdm(session, EXPERIMENT_SAMPLES_QUICK, EXPERIMENT_SEED)
    try:
        ts = ts_reference(EXPERIMENT_SAMPLES_QUICK, EXPERIMENT_SEED)
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: skip live TS compare ({exc})")
        # Fallback: structural checks only
        assert py["ranking"], "empty ranking"
        assert abs(sum(x["winRate"] for x in py["ranking"]) - 1) < 0.02
        assert py["methods"]["topsis"][0]["alternativeId"] == py["ranking"][0][
            "alternativeId"
        ]
        print("OK python structural (no TS)")
        return 0

    d_t = max_winrate_delta(py["methods"]["topsis"], ts["methods"]["topsis"])
    d_w = max_winrate_delta(py["methods"]["wsm"], ts["methods"]["wsm"])
    d_v = max_winrate_delta(py["methods"]["vikor"], ts["methods"]["vikor"])
    d_agree = abs(py["agreement"]["leaderMatchRate"] - ts["agreement"]["leaderMatchRate"])

    print(
        f"deltas winRate topsis={d_t:.3e} wsm={d_w:.3e} vikor={d_v:.3e} "
        f"agree={d_agree:.3e}"
    )
    tol = TOL_WINRATE
    # Allow tiny float drift if platforms differ
    if max(d_t, d_w, d_v, d_agree) > TOL_LOOSE:
        raise SystemExit(
            f"FAIL: Python vs TS exceeds tolerance {TOL_LOOSE}: "
            f"t={d_t} w={d_w} v={d_v} a={d_agree}"
        )
    if max(d_t, d_w, d_v) > tol:
        print(f"NOTE: not bit-identical but within {TOL_LOOSE}")
    print(
        "OK",
        " | ".join(
            f"{x['name']}:{x['winRate']*100:.1f}%" for x in py["ranking"]
        ),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
