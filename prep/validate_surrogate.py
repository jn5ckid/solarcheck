"""Re-run E2c on original development sensors; never access test/holdout data.

Run: .venv/Scripts/python.exe -m prep.validate_surrogate
The eight-sensor parity check exercises XYZ normalization, all 8760 hours and
the inference port. The 523-sensor metrics are recomputed from existing research
caches and are explicitly distinct from the new eight-sensor inference check.
"""
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from backend.surrogate import (artifact_paths, sha256, load, HORIZON,
                               predict_research_sensors, aggregate_cells)


def metric(true, pred):
    true, pred = np.asarray(true, float), np.asarray(pred, float)
    error = pred - true
    denominator = np.square(true - true.mean()).sum()
    return {'r2': float(1 - np.square(error).sum() / denominator) if denominator else None,
            'rmse': float(np.sqrt(np.square(error).mean())),
            'mae': float(np.abs(error).mean()), 'mbe': float(error.mean())}


def main():
    import torch
    torch.set_num_threads(4)
    paths = artifact_paths()
    research = paths['research']
    output = Path(__file__).resolve().parents[1] / 'outputs/surrogate-validation.json'
    evaluation = research / 'analysis_outputs/e2c_e2f_20260810/e2c_evaluation_clean523'
    pred_path = evaluation / 'e2c_predictions_and_m_nn.npz'
    gt_path = research / 'analysis_outputs/p123_diagnostics_20260810/p2_facade_residuals/e1a_clean523_daytime_cache.npz'
    with np.load(pred_path, allow_pickle=False) as data:
        ids, day_hours, reference = data['sensor_row_index'], data['day_hours'], data['prediction']
    with np.load(gt_path, allow_pickle=False) as data:
        if not np.array_equal(ids, data['sensor_row_index']) or not np.array_equal(day_hours, data['day_hours']):
            raise ValueError('Prediction and GT cache identity differs')
        target = data['target']
    if reference.shape != (523, 4434) or target.shape != reference.shape:
        raise ValueError('Expected clean523 daytime development-validation caches')
    with (evaluation / 'sensor_metrics_e1b_vs_e2c.csv').open(encoding='utf-8-sig', newline='') as handle:
        geometry = {int(row['sensor_row_index']): row for row in csv.DictReader(handle)}
    # Horizon provenance is pinned by the original normalization manifest.
    horizon_path = paths['normalization'].parents[2] / 'c7_a5_horizon_run04/horizon_profile_5000.csv'
    if sha256(horizon_path) != 'F7DE2FC31E35F81D078D73639F17D3C0186B1E6B56DB1094D9628E2857826451':
        raise ValueError('Horizon file hash differs')
    with horizon_path.open(encoding='utf-8-sig', newline='') as handle:
        horizon = {int(row['sensor_row_index']): row for row in csv.DictReader(handle)}
    _, axes, _ = load()
    selected = []
    for surface in ('Roof', 'Facade'):
        candidates = [i for i, key in enumerate(ids) if geometry[int(key)]['surface_type'] == surface]
        inside = [i for i in candidates if all(axes[k]['min'] <= float(geometry[int(ids[i])][k]) <= axes[k]['max'] for k in ('Px', 'Py', 'Pz'))]
        selected.extend([inside[i] for i in np.linspace(0, len(inside) - 1, 4, dtype=int)])
    rows = [geometry[int(ids[i])] for i in selected]
    xyz = [[float(r[k]) for k in ('Px', 'Py', 'Pz')] for r in rows]
    normal = [[float(r[k]) for k in ('Nx', 'Ny', 'Nz')] for r in rows]
    horizons = [[float(horizon[int(ids[i])][k]) for k in HORIZON] for i in selected]
    prediction = predict_research_sensors(xyz, normal, horizons, coordinate_frame='original-research-local')
    fresh_day = prediction[:, day_hours]
    annual = np.asarray(aggregate_cells(prediction)['annual'])
    original_annual = reference[selected].sum(axis=1, dtype=np.float64) / 1000
    max_hourly = float(np.abs(fresh_day - reference[selected]).max())
    max_annual = float(np.abs(annual - original_annual).max())
    night = np.ones(8760, dtype=bool); night[day_hours] = False
    if max_hourly > .05 or max_annual > .05 or np.any(prediction[:, night] != 0):
        raise AssertionError(f'Inference parity failed: hourly={max_hourly}, annual={max_annual}')
    scopes = {}
    for scope in ('All', 'Roof', 'Facade'):
        mask = np.array([scope == 'All' or geometry[int(key)]['surface_type'] == scope for key in ids])
        scopes[scope] = {'sensors': int(mask.sum()),
                         'hourly_w_m2': metric(target[mask], reference[mask]),
                         'annual_kwh_m2': metric(target[mask].sum(axis=1, dtype=np.float64) / 1000,
                                                 reference[mask].sum(axis=1, dtype=np.float64) / 1000)}
    report = {
        'verified_at_utc': datetime.now(timezone.utc).isoformat(),
        'model': 'E2c', 'checkpoint_sha256': sha256(paths['checkpoint']),
        'normalization_sha256': sha256(paths['normalization']), 'solar_sha256': sha256(paths['solar']),
        'runtime': {'torch': torch.__version__, 'device': 'cpu'},
        'new_inference_check': {'sensors': 8, 'roof': 4, 'facade': 4, 'hours_per_sensor': 8760,
                                'selection': 'four evenly spaced in-range sensor IDs per surface in existing clean validation order',
                                'max_abs_vs_original_hourly_w_m2': max_hourly,
                                'max_abs_vs_original_annual_kwh_m2': max_annual,
                                'night_exact_zero': True, 'passed': True,
                                'vs_climatestudio_hourly_w_m2': metric(target[selected], fresh_day)},
        'existing_development_cache_metrics': scopes,
        'cache_sha256': {'prediction': sha256(pred_path), 'target': sha256(gt_path)},
        'limits': ['Eight sensors were newly inferred; full523 metrics use existing research caches.',
                   'Repeatedly used development validation; not independent test performance.',
                   'No test/holdout file was opened. No new address was evaluated.',
                   'Geographic registration, terrain datum and new-site validation are still missing.'],
    }
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()
