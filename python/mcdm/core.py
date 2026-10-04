"""Port of shared/mcdm.ts — same Mulberry32 seed → close results."""

from __future__ import annotations

import math
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

ScoreValue = Union[float, int, List[float], Tuple[float, float]]
SessionState = Dict[str, Any]
RankItem = Dict[str, Any]
McdmResult = Dict[str, Any]

DEFAULT_MCDM_SAMPLES = 2000
DEFAULT_MCDM_SEED = 42


def _u32(x: int) -> int:
    return x & 0xFFFFFFFF


def _to_int32(x: int) -> int:
    x = _u32(x)
    return x - 0x100000000 if x >= 0x80000000 else x


def _imul(a: int, b: int) -> int:
    """JS Math.imul — signed 32-bit multiply."""
    return _to_int32(_u32(a) * _u32(b))


def mulberry32(seed: int) -> Callable[[], float]:
    """Bit-identical to shared/mcdm.ts mulberry32."""
    t = _u32(seed)

    def rng() -> float:
        nonlocal t
        t = _u32(t + 0x6D2B79F5)
        r = _imul(t ^ (t >> 15), 1 | t)
        r = _to_int32(r ^ _to_int32(r + _imul(r ^ (_u32(r) >> 7), 61 | r)))
        return _u32(r ^ (_u32(r) >> 14)) / 4294967296.0

    return rng


def sample_interval(rng: Callable[[], float], v: ScoreValue) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    lo, hi = float(v[0]), float(v[1])
    if lo > hi:
        lo, hi = hi, lo
    return lo + (hi - lo) * rng()


def sample_weights(
    criteria: Sequence[Dict[str, Any]], rng: Callable[[], float]
) -> Dict[str, float]:
    alphas: List[float] = []
    for c in criteria:
        w = c.get("weight")
        if w is not None and not c.get("weightUncertain"):
            alphas.append(max(0.05, float(w) * 20))
            continue
        imp = c.get("importance")
        if imp == "high":
            alphas.append(4 + rng() * 2)
        elif imp == "medium":
            alphas.append(2 + rng())
        elif imp == "low":
            alphas.append(0.8 + rng() * 0.5)
        else:
            alphas.append(1 + rng() * 2)

    draws: List[float] = []
    for a in alphas:
        g = 0.0
        full = int(math.floor(a))
        for _ in range(full):
            g -= math.log(max(1e-12, rng()))
        frac = a - full
        if frac > 0.01:
            g -= math.log(max(1e-12, rng())) * frac
        draws.append(max(1e-9, g))

    total = sum(draws)
    out = {c["id"]: draws[i] / total for i, c in enumerate(criteria)}

    high = [c for c in criteria if c.get("importance") == "high"]
    low = [c for c in criteria if c.get("importance") == "low"]
    if high and low:
        for h in high:
            for l in low:
                hi = out[h["id"]]
                lo = out[l["id"]]
                if hi < lo:
                    mid = (hi + lo) / 2
                    half = abs(lo - hi) / 2
                    out[h["id"]] = mid + half
                    out[l["id"]] = max(1e-9, mid - half)
        s2 = sum(out.values())
        for k in list(out.keys()):
            out[k] /= s2

    return out


def normalize_matrix(
    values: List[List[float]], directions: Sequence[str]
) -> List[List[float]]:
    n_crit = len(directions)
    ideal: List[float] = []
    anti: List[float] = []
    for j in range(n_crit):
        col = [row[j] for row in values]
        mn = min(col)
        mx = max(col)
        if directions[j] == "min":
            ideal.append(mn)
            anti.append(mx)
        else:
            ideal.append(mx)
            anti.append(mn)

    out: List[List[float]] = []
    for row in values:
        nrow: List[float] = []
        for j, v in enumerate(row):
            span = abs(ideal[j] - anti[j])
            if span < 1e-12:
                nrow.append(0.5)
            else:
                nrow.append(abs(v - anti[j]) / span)
        out.append(nrow)
    return out


def topsis_scores(norm: List[List[float]], weights: Sequence[float]) -> List[float]:
    scores: List[float] = []
    for row in norm:
        d_pos = 0.0
        d_neg = 0.0
        for j, val in enumerate(row):
            w = weights[j]
            d_pos += (w * (1 - val)) ** 2
            d_neg += (w * (0 - val)) ** 2
        d_pos = math.sqrt(d_pos)
        d_neg = math.sqrt(d_neg)
        den = d_pos + d_neg
        scores.append(0.5 if den < 1e-12 else d_neg / den)
    return scores


def wsm_scores(norm: List[List[float]], weights: Sequence[float]) -> List[float]:
    return [sum(weights[j] * row[j] for j in range(len(row))) for row in norm]


def vikor_q_scores(
    norm: List[List[float]], weights: Sequence[float], v: float = 0.5
) -> List[float]:
    n_alt = len(norm)
    n_crit = len(weights)
    if not n_alt:
        return []

    f_star: List[float] = []
    f_minus: List[float] = []
    for j in range(n_crit):
        col = [norm[i][j] for i in range(n_alt)]
        f_star.append(max(col))
        f_minus.append(min(col))

    S: List[float] = []
    R: List[float] = []
    for i in range(n_alt):
        s = 0.0
        r = 0.0
        for j in range(n_crit):
            span = f_star[j] - f_minus[j]
            u = 0.0 if span < 1e-12 else (f_star[j] - norm[i][j]) / span
            wu = weights[j] * u
            s += wu
            if wu > r:
                r = wu
        S.append(s)
        R.append(r)

    s_star, s_minus = min(S), max(S)
    r_star, r_minus = min(R), max(R)
    d_s = s_minus - s_star
    d_r = r_minus - r_star

    q: List[float] = []
    for i, si in enumerate(S):
        term_s = 0.0 if d_s < 1e-12 else (si - s_star) / d_s
        term_r = 0.0 if d_r < 1e-12 else (R[i] - r_star) / d_r
        q.append(v * term_s + (1 - v) * term_r)
    return q


def _order_desc(scores: Sequence[float]) -> List[Tuple[float, int]]:
    return sorted(
        [(sc, i) for i, sc in enumerate(scores)],
        key=lambda x: (-x[0], x[1]),
    )


def _order_asc(scores: Sequence[float]) -> List[Tuple[float, int]]:
    return sorted(
        [(sc, i) for i, sc in enumerate(scores)],
        key=lambda x: (x[0], x[1]),
    )


class _Agg:
    def __init__(self, n: int) -> None:
        self.win = [0] * n
        self.rank_sums = [0.0] * n
        self.score_sums = [0.0] * n
        self.worst = [0] * n

    def record(self, order: List[Tuple[float, int]]) -> None:
        self.win[order[0][1]] += 1
        self.worst[order[-1][1]] += 1
        for rank, (sc, i) in enumerate(order):
            self.rank_sums[i] += rank + 1
            self.score_sums[i] += sc


def _to_ranking(
    alternatives: Sequence[Dict[str, Any]],
    agg: _Agg,
    samples: int,
    higher_better: bool = True,
) -> List[RankItem]:
    items: List[RankItem] = []
    for i, alt in enumerate(alternatives):
        items.append(
            {
                "alternativeId": alt["id"],
                "name": alt["name"],
                "expectedScore": agg.score_sums[i] / samples,
                "winRate": agg.win[i] / samples,
                "meanRank": agg.rank_sums[i] / samples,
                "pBest": agg.win[i] / samples,
                "pWorst": agg.worst[i] / samples,
            }
        )
    if higher_better:
        items.sort(key=lambda x: (-x["winRate"], -x["expectedScore"]))
    else:
        items.sort(key=lambda x: (-x["winRate"], x["expectedScore"]))
    return items


def _sensitivity(ranking: Sequence[RankItem]) -> str:
    if not ranking:
        return "Ранжирование пусто."
    leader = ranking[0]
    if len(ranking) < 2:
        return f"{leader['name']} — единственная альтернатива."
    runner = ranking[1]
    if leader["winRate"] < 0.55:
        return (
            f"Лидер неустойчив: {leader['name']} побеждает лишь в "
            f"{leader['winRate'] * 100:.0f}% симуляций. При изменении весов/оценок "
            f"возможна смена лидера ({runner['name']}: {runner['winRate'] * 100:.0f}%)."
        )
    if abs(leader["expectedScore"] - runner["expectedScore"]) < 0.05:
        return (
            f"{leader['name']} чаще первый ({leader['winRate'] * 100:.0f}%), "
            f"но ожидаемые оценки близки к {runner['name']} — решение чувствительно "
            f"к уточнению весов."
        )
    return (
        f"{leader['name']} устойчиво лидирует ({leader['winRate'] * 100:.0f}% побед). "
        f"Уточнение неопределённых весов вряд ли сменит топ-1."
    )


def is_analysis_ready(session: SessionState) -> bool:
    criteria = session.get("criteria") or []
    alternatives = session.get("alternatives") or []
    if len(criteria) < 2 or len(alternatives) < 2:
        return False
    crit_ids = [c["id"] for c in criteria]
    for alt in alternatives:
        scores = alt.get("scores") or {}
        for cid in crit_ids:
            if scores.get(cid) is None:
                return False
    return True


def run_robust_mcdm(
    session: SessionState,
    samples: int = DEFAULT_MCDM_SAMPLES,
    seed: int = DEFAULT_MCDM_SEED,
) -> McdmResult:
    criteria = session.get("criteria") or []
    alternatives = session.get("alternatives") or []
    empty_agree = {
        "leaderMatchRate": 0.0,
        "pairwiseLeaderMatch": {
            "topsis_wsm": 0.0,
            "topsis_vikor": 0.0,
            "wsm_vikor": 0.0,
        },
        "meanRankByMethod": {},
    }
    if not criteria or not alternatives:
        return {
            "ranking": [],
            "samples": 0,
            "sensitivityNote": "Недостаточно данных для анализа.",
            "weightMeans": {},
            "methods": {"topsis": [], "wsm": [], "vikor": []},
            "agreement": empty_agree,
            "mcdmParams": {"samples": samples, "seed": seed},
        }

    rng = mulberry32(seed)
    n_alt = len(alternatives)
    topsis_agg = _Agg(n_alt)
    wsm_agg = _Agg(n_alt)
    vikor_agg = _Agg(n_alt)
    weight_sums = {c["id"]: 0.0 for c in criteria}

    all_agree = tw = tv = wv = 0

    for _ in range(samples):
        w_map = sample_weights(criteria, rng)
        weights = []
        for c in criteria:
            weight_sums[c["id"]] += w_map[c["id"]]
            weights.append(w_map[c["id"]])

        matrix: List[List[float]] = []
        for alt in alternatives:
            row: List[float] = []
            scores = alt.get("scores") or {}
            for c in criteria:
                raw = scores.get(c["id"])
                row.append(0.0 if raw is None else sample_interval(rng, raw))
            matrix.append(row)

        directions = [c["direction"] for c in criteria]
        norm = normalize_matrix(matrix, directions)

        o_t = _order_desc(topsis_scores(norm, weights))
        o_w = _order_desc(wsm_scores(norm, weights))
        o_v = _order_asc(vikor_q_scores(norm, weights, 0.5))

        topsis_agg.record(o_t)
        wsm_agg.record(o_w)
        vikor_agg.record(o_v)

        lt, lw, lv = o_t[0][1], o_w[0][1], o_v[0][1]
        if lt == lw == lv:
            all_agree += 1
        if lt == lw:
            tw += 1
        if lt == lv:
            tv += 1
        if lw == lv:
            wv += 1

    topsis_ranking = _to_ranking(alternatives, topsis_agg, samples, True)
    wsm_ranking = _to_ranking(alternatives, wsm_agg, samples, True)
    vikor_ranking = _to_ranking(alternatives, vikor_agg, samples, False)

    weight_means = {cid: weight_sums[cid] / samples for cid in weight_sums}
    mean_rank_by_method: Dict[str, Dict[str, float]] = {}
    for i, alt in enumerate(alternatives):
        mean_rank_by_method[alt["id"]] = {
            "topsis": topsis_agg.rank_sums[i] / samples,
            "wsm": wsm_agg.rank_sums[i] / samples,
            "vikor": vikor_agg.rank_sums[i] / samples,
        }

    agreement = {
        "leaderMatchRate": all_agree / samples,
        "pairwiseLeaderMatch": {
            "topsis_wsm": tw / samples,
            "topsis_vikor": tv / samples,
            "wsm_vikor": wv / samples,
        },
        "meanRankByMethod": mean_rank_by_method,
    }

    return {
        "ranking": topsis_ranking,
        "samples": samples,
        "sensitivityNote": _sensitivity(topsis_ranking),
        "weightMeans": weight_means,
        "methods": {
            "topsis": topsis_ranking,
            "wsm": wsm_ranking,
            "vikor": vikor_ranking,
        },
        "agreement": agreement,
        "mcdmParams": {"samples": samples, "seed": seed},
    }
