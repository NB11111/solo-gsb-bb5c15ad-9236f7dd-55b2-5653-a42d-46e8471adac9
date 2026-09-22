import type { HeatTier } from '../../shared/geometry';

/**
 * 热区分档配色（红 → 琥珀 → 绿，0 档灰红表示无通畅视线、不可用）。
 * 舞台上色块用带透明度的填充；侧栏图例使用不透明实色。
 */
const HEAT_FILL: Record<HeatTier, string> = {
  0: 'rgba(148, 163, 184, 0.10)',
  1: 'rgba(239, 68, 68, 0.30)',
  2: 'rgba(249, 115, 22, 0.32)',
  3: 'rgba(234, 179, 8, 0.34)',
  4: 'rgba(132, 204, 22, 0.36)',
  5: 'rgba(34, 197, 94, 0.40)',
};

const HEAT_SWATCH: Record<HeatTier, string> = {
  0: '#94a3b8',
  1: '#ef4444',
  2: '#f97316',
  3: '#eab308',
  4: '#84cc16',
  5: '#22c55e',
};

export const HEAT_TIER_LABEL: Record<HeatTier, string> = {
  0: '无通畅视线（不可用）',
  1: '通畅率 1~20%',
  2: '通畅率 21~40%',
  3: '通畅率 41~60%',
  4: '通畅率 61~80%',
  5: '通畅率 81~100%',
};

export function heatFill(tier: HeatTier): string {
  return HEAT_FILL[tier];
}

export function heatSwatch(tier: HeatTier): string {
  return HEAT_SWATCH[tier];
}
