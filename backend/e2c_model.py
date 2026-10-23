"""Inference-only E2c network, ported from experiments/e2c_train_tilt_diffuse.py.

Keep the float32 operations and state_dict names identical to the research model.
No training code, dataset imports, or guessed geometry belongs in this module.
"""
import math

import torch
from torch import nn


class E2cModel(nn.Module):
    def __init__(self):
        super().__init__()
        layers = []
        previous = 22
        for hidden in (256, 256, 128, 64):
            layers.extend([nn.Linear(previous, hidden), nn.GELU()])
            previous = hidden
        self.backbone = nn.Sequential(*layers)
        self.correction_head = nn.Linear(previous, 1)
        self.register_buffer('direction_rad', torch.tensor(
            [math.radians(d) for d in range(0, 360, 45)], dtype=torch.float32), persistent=False)

    def forward(self, independent, conditioning):
        features = torch.cat([independent, conditioning.detach()], dim=-1)
        correction = nn.functional.softplus(self.correction_head(self.backbone(features)))
        sin_alt, cos_alt, sin_az, cos_az = [independent[:, i:i+1] for i in range(4, 8)]
        nx, ny, nz = [conditioning[:, i:i+1] for i in range(3)]
        sx, sy, sz = cos_alt * sin_az, cos_alt * cos_az, sin_alt
        cos_aoi = nx * sx + ny * sy + nz * sz
        beam = conditioning[:, 3:4] * 1000.0 * torch.clamp(cos_aoi, min=0.0) * conditioning[:, 13:14]
        norm = torch.sqrt(torch.clamp(nx * nx + ny * ny + nz * nz, min=1e-12))
        cos_tilt = torch.clamp(nz / norm, min=-1.0, max=1.0)
        gamma = torch.atan2(nx, ny)
        direction = self.direction_rad.to(device=conditioning.device, dtype=conditioning.dtype).reshape(1, 8)
        selected = torch.cos(direction - gamma) > 0.0
        selected = torch.where(cos_tilt > math.cos(math.radians(15)), torch.ones_like(selected), selected)
        selected = selected.to(conditioning.dtype)
        cos2 = torch.cos(conditioning[:, 5:13] * (math.pi / 2.0)).pow(2)
        horizon_factor = (cos2 * selected).sum(dim=1, keepdim=True) / selected.sum(dim=1, keepdim=True)
        diffuse = conditioning[:, 4:5] * 1000.0 * ((1.0 + cos_tilt) / 2.0) * horizon_factor
        prediction = (beam + diffuse) * correction
        return torch.where(sin_alt > 0.0, prediction, torch.zeros_like(prediction))
