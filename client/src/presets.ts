import type { Scene, Singer } from '../../shared/geometry';

let counter = 0;
function s(name: string, x: number, y: number, radius = 0.3): Singer {
  counter += 1;
  return { id: `s${counter}-${name}`, name, x, y, radius };
}

/** 默认合唱队形：两排弧形站位 */
export function defaultScene(): Scene {
  counter = 0;
  const singers: Singer[] = [];
  const rows = [
    { y: 2.2, n: 5, spread: 7.2 },
    { y: 3.6, n: 6, spread: 8.6 },
  ];
  let idx = 0;
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      idx += 1;
      const x = 6 + (i / (row.n - 1) - 0.5) * row.spread;
      singers.push(s(`S${idx}`, Number(x.toFixed(2)), row.y, 0.3));
    }
  }
  return {
    version: 1,
    stage: { width: 12, depth: 8 },
    conductor: { x: 6, y: -1.2 },
    singers,
  };
}

/** 共线测试：多名演唱者站在同一视线上，验证最近遮挡者判定 */
export function collinearScene(): Scene {
  counter = 0;
  return {
    version: 1,
    stage: { width: 12, depth: 8 },
    conductor: { x: 6, y: 0 },
    singers: [
      s('S1', 6, 1.5, 0.3),
      s('S2', 6, 3, 0.3),
      s('S3', 6, 4.5, 0.3),
      s('S4', 6, 6, 0.3),
      s('S5', 3, 2, 0.3),
      s('S6', 9, 2, 0.3),
    ],
  };
}

/** 相切测试：S2 与 S1 的视线恰好相切（擦边），S3 留有余量 */
export function tangentScene(): Scene {
  counter = 0;
  return {
    version: 1,
    stage: { width: 12, depth: 8 },
    conductor: { x: 6, y: 0 },
    singers: [
      s('S1', 6, 4, 0.3), // 视线为直线 x=6
      s('S2', 7, 2, 1.0), // 圆心距视线 1.0 = 半径 → 恰好相切
      s('S3', 4.9, 2, 0.9), // 圆心距视线 1.1 > 0.9 → 不接触
      s('S4', 6, 6.5, 0.3), // 被 S1 遮挡（共线）
    ],
  };
}

/** 重合测试：站位重合与视线退化 */
export function coincideScene(): Scene {
  counter = 0;
  return {
    version: 1,
    stage: { width: 12, depth: 8 },
    conductor: { x: 6, y: 0 },
    singers: [
      s('S1', 4, 3, 0.3),
      s('S2', 4, 3, 0.35), // 与 S1 圆心重合
      s('S3', 6, 0, 0.3), // 与指挥重合 → 视线退化
      s('S4', 8, 3, 0.3),
    ],
  };
}

export const PRESETS: { key: string; label: string; build: () => Scene }[] = [
  { key: 'default', label: '默认队形', build: defaultScene },
  { key: 'collinear', label: '共线测试', build: collinearScene },
  { key: 'tangent', label: '相切测试', build: tangentScene },
  { key: 'coincide', label: '重合测试', build: coincideScene },
];
