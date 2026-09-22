import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeScene,
  analyzeSinger,
  buildOcclusionGraph,
  evaluateUnblockPosition,
  findUnblockCandidates,
  occlusionChainFrom,
  stageInterior,
  validateScene,
  TANGENT_EPS,
  type Scene,
  type Singer,
} from './geometry';

function singer(id: string, x: number, y: number, radius = 0.3): Singer {
  return { id, name: id.toUpperCase(), x, y, radius };
}

function scene(partial: Partial<Scene> & Pick<Scene, 'conductor' | 'singers'>): Scene {
  return { version: 1, stage: { width: 12, depth: 8 }, ...partial };
}

test('无遮挡：视线通畅', () => {
  const s1 = singer('s1', 2, 3);
  const s2 = singer('s2', 8, 3);
  const r = analyzeSinger({ x: 6, y: 0 }, s1, [s1, s2]);
  assert.equal(r.status, 'clear');
  assert.equal(r.occlusions.length, 0);
});

test('遮挡：中间一人挡住视线，进入点距离正确', () => {
  // 指挥 (0,0)，演唱者 (0,4)，遮挡者 (0,2) r=0.5 → 进入点距眼睛 4-2-0.5 = 1.5
  const me = singer('me', 0, 4);
  const blocker = singer('b', 0, 2, 0.5);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, blocker]);
  assert.equal(r.status, 'blocked');
  assert.equal(r.nearest?.blockerId, 'b');
  assert.ok(Math.abs((r.nearest?.distance ?? 0) - 1.5) < 1e-9);
});

test('相切：圆心距恰好等于半径 → tangent，不判为遮挡', () => {
  // 视线为 x=0 的竖直线，遮挡圆心 (1,2)，r=1 → 恰好相切
  const me = singer('me', 0, 4);
  const grazer = singer('g', 1, 2, 1);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, grazer]);
  assert.equal(r.status, 'tangent');
  assert.equal(r.occlusions.length, 1);
  assert.equal(r.occlusions[0].tangent, true);
  assert.ok(Math.abs(r.occlusions[0].clearance) <= TANGENT_EPS);
});

test('相切容差边界：+eps 内相切，-eps 外遮挡', () => {
  const me = singer('me', 0, 4);
  // 圆心距 = 1，半径 = 1 + 0.5e-6 → 净余量 -0.5e-6，在容差内 → 相切
  const a = singer('a', 1, 2, 1 + TANGENT_EPS / 2);
  assert.equal(analyzeSinger({ x: 0, y: 0 }, me, [me, a]).status, 'tangent');
  // 半径 = 1 + 2e-6 → 净余量 -2e-6，超出容差 → 遮挡
  const b = singer('b', 1, 2, 1 + 2 * TANGENT_EPS);
  assert.equal(analyzeSinger({ x: 0, y: 0 }, me, [me, b]).status, 'blocked');
  // 半径 = 1 - 2e-6 → 净余量 +2e-6 → 通畅
  const c = singer('c', 1, 2, 1 - 2 * TANGENT_EPS);
  assert.equal(analyzeSinger({ x: 0, y: 0 }, me, [me, c]).status, 'clear');
});

test('多人共线：最近遮挡者决定着色，遮挡列表按距离升序', () => {
  // 指挥 (0,0)，me (0,10)，中间共线两人：near (0,3)、far (0,7)
  const me = singer('me', 0, 10);
  const near = singer('near', 0, 3, 0.3);
  const far = singer('far', 0, 7, 0.3);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, near, far]);
  assert.equal(r.status, 'blocked');
  assert.equal(r.nearest?.blockerId, 'far'); // 距眼睛 10-7-0.3=2.7 < 10-3-0.3=6.7
  assert.deepEqual(
    r.occlusions.map((o) => o.blockerId),
    ['far', 'near'],
  );
  assert.ok(r.occlusions[0].tEnter < r.occlusions[1].tEnter);
});

test('重合：遮挡者与演唱者圆心重合 → 进入参数 t=0', () => {
  const me = singer('me', 0, 4);
  const twin = singer('twin', 0, 4, 0.3);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, twin]);
  assert.equal(r.status, 'blocked');
  assert.equal(r.nearest?.tEnter, 0);
  assert.equal(r.nearest?.distance, 0);
});

test('重合：演唱者与指挥重合 → 视线退化', () => {
  const me = singer('me', 5, 5);
  const r = analyzeSinger({ x: 5, y: 5 }, me, [me]);
  assert.equal(r.status, 'degenerate');
});

test('遮挡圆包含指挥端点 → 遮挡且进入点 t<1', () => {
  // 指挥 (0,0) 位于遮挡圆 (0,0.2) r=0.5 内
  const me = singer('me', 0, 4);
  const atConductor = singer('c', 0, 0.2, 0.5);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, atConductor]);
  assert.equal(r.status, 'blocked');
  assert.ok((r.nearest?.tEnter ?? 1) < 1);
});

test('投影在线段延长线上的圆不遮挡', () => {
  // 圆在指挥身后（t>1），且距指挥超过半径
  const me = singer('me', 0, 4);
  const behind = singer('behind', 0, -2, 0.5);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, behind]);
  assert.equal(r.status, 'clear');
});

test('analyzeScene：统计与重合警告', () => {
  const sc = scene({
    conductor: { x: 0, y: 0 },
    singers: [
      singer('a', 0, 4), // 被 b 遮挡
      singer('b', 0, 2),
      singer('c', 5, 5), // 通畅
      singer('d', 5, 5), // 与 c 重合 → 也被遮挡（c 包含其眼睛）
    ],
  });
  const a = analyzeScene(sc);
  assert.equal(a.summary.total, 4);
  // a 被 b 挡；c 与 d 圆心重合 → 互相遮挡（对方圆包含自己的眼睛）
  assert.equal(a.summary.blocked, 3);
  assert.equal(a.summary.clear, 1); // 仅 b 通畅
  assert.ok(a.warnings.some((w) => w.type === 'coincident-singers'));
});

test('validateScene：接受合法场景并规范化', () => {
  const v = validateScene({
    version: 1,
    stage: { width: 10, depth: 6 },
    conductor: { x: 5, y: -1 },
    singers: [{ id: 's1', name: 'S1', x: 1, y: 2, radius: 0.3 }],
  });
  assert.ok(v.ok);
  if (v.ok) assert.equal(v.scene.singers.length, 1);
});

test('validateScene：拒绝非法输入并给出错误', () => {
  assert.equal(validateScene(null).ok, false);
  assert.equal(validateScene({}).ok, false);
  const bad = validateScene({
    stage: { width: 10, depth: 6 },
    conductor: { x: 0, y: 0 },
    singers: [
      { id: 's1', x: 0, y: 1, radius: 0 }, // 半径非法
      { id: 's1', x: 0, y: 2, radius: 0.3 }, // id 重复
      { id: 's2', x: NaN, y: 2, radius: 0.3 }, // 坐标非法
    ],
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.errors.length >= 3);
});

// ---------------------------------------------------------------------------
// 自动解遮挡：网格采样 + 细化
// ---------------------------------------------------------------------------

test('stageInterior：圆心范围保证整圆留在舞台内', () => {
  const b = stageInterior({ width: 10, depth: 6 }, 0.3);
  assert.deepEqual(b, { minX: 0.3, maxX: 9.7, minY: 0.3, maxY: 5.7 });
});

test('自动解遮挡：共线被挡 → 最小位移候选可行、按距离升序且不修改场景', () => {
  const me = singer('me', 0, 4, 0.3);
  const blocker = singer('b', 0, 2, 0.3);
  const sc = scene({
    stage: { width: 12, depth: 8 },
    conductor: { x: 0, y: 0 },
    singers: [me, blocker],
  });
  const snapshot = JSON.stringify(sc);
  const r = findUnblockCandidates(sc, 'me');

  assert.equal(r.error, undefined);
  assert.equal(r.alreadyClear, false);
  assert.ok(r.candidates.length >= 1, '应至少找到一个可行候选');
  assert.ok(r.candidates.length <= 3);
  assert.ok(r.sampledCount > 100, '应对舞台网格采样');
  assert.ok(r.feasibleCount > 0);

  // 每个候选都必须同时满足全部三条约束
  for (const c of r.candidates) {
    const f = evaluateUnblockPosition(sc, 'me', { x: c.x, y: c.y });
    assert.equal(f.feasible, true, `候选 (${c.x},${c.y}) 应可行：${f.violations.map((v) => v.message).join('；')}`);
    // 留在舞台内（整圆）
    assert.ok(c.x >= 0.3 - 1e-9 && c.x <= 11.7 + 1e-9 && c.y >= 0.3 - 1e-9 && c.y <= 7.7 + 1e-9);
    // 与遮挡者间距 ≥ 两半径之和
    assert.ok(Math.hypot(c.x - blocker.x, c.y - blocker.y) >= 0.6 - TANGENT_EPS);
    // 视线不再被挡
    const moved: Singer = { ...me, x: c.x, y: c.y };
    const los = analyzeSinger(sc.conductor, moved, [moved, blocker]);
    assert.notEqual(los.status, 'blocked');
  }

  // 按位移距离升序
  const dists = r.candidates.map((c) => c.distance);
  for (let i = 1; i < dists.length; i++) assert.ok(dists[i] >= dists[i - 1] - 1e-9);

  // 最接近的候选应该是“侧向移出视线”：位移 ≈ 0.6（移动一个半径），不超过 ~0.75
  assert.ok(r.candidates[0].distance < 0.75, `首候选位移 ${r.candidates[0].distance} 应接近 0.6`);

  // 纯函数：场景未被修改
  assert.equal(JSON.stringify(sc), snapshot);
});

test('自动解遮挡：当前位置已通畅 → alreadyClear 且首候选位移为 0', () => {
  const me = singer('me', 4, 4, 0.3);
  const other = singer('b', -3, 2, 0.3); // 完全不相关的位置
  const sc = scene({ conductor: { x: 0, y: 0 }, singers: [me, other] });
  const r = findUnblockCandidates(sc, 'me');
  assert.equal(r.error, undefined);
  assert.equal(r.alreadyClear, true);
  assert.ok(r.candidates.length >= 1);
  assert.ok(r.candidates[0].distance <= 1e-6);
  const f = evaluateUnblockPosition(sc, 'me', { x: me.x, y: me.y });
  assert.equal(f.feasible, true);
});

test('自动解遮挡：候选去重（细化收敛点不重复出现）', () => {
  const me = singer('me', 0, 4, 0.3);
  const blocker = singer('b', 0, 2, 0.3);
  const sc = scene({ stage: { width: 12, depth: 8 }, conductor: { x: 0, y: 0 }, singers: [me, blocker] });
  const r = findUnblockCandidates(sc, 'me');
  const keys = r.candidates.map((c) => `${c.x.toFixed(3)}|${c.y.toFixed(3)}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('自动解遮挡：站位被密阵铺满窄台 → 无可行候选并给出不可行原因', () => {
  // 舞台 2×2，9 名演唱者按 0.6m 间距铺满内部（含四角），任一点都距某人 <0.6m
  const me = singer('me', 1, 1, 0.3);
  const grid = [0.3, 0.9, 1.5];
  const ring: Singer[] = [];
  for (const gx of grid) for (const gy of grid) ring.push(singer(`b${gx}-${gy}`, gx, gy, 0.3));
  const sc = scene({ stage: { width: 2, depth: 2 }, conductor: { x: 1, y: 0 }, singers: [me, ...ring] });
  const r = findUnblockCandidates(sc, 'me');
  assert.equal(r.error, undefined);
  assert.equal(r.candidates.length, 0, '不应找到可行候选');
  assert.ok(r.infeasibleSamples.length > 0, '应给出不可行采样点');
  for (const s of r.infeasibleSamples) {
    assert.ok(s.violations.length > 0);
    assert.ok(
      s.violations.some((v) => v.type === 'spacing' || v.type === 'sightline' || v.type === 'stage'),
    );
  }
  // 纯搜索：场景中的演唱者数量与位置不变
  assert.equal(sc.singers.length, 10);
});

test('自动解遮挡：间距约束 —— 重叠候选报 spacing 并带对方 id', () => {
  const me = singer('me', 5, 5, 0.3);
  const other = singer('o', 5.2, 5, 0.3); // 距 0.2 < 0.6
  const sc = scene({ stage: { width: 10, depth: 8 }, conductor: { x: 5, y: 0 }, singers: [me, other] });
  const f = evaluateUnblockPosition(sc, 'me', { x: 5.2, y: 5 });
  assert.equal(f.feasible, false);
  const spacing = f.violations.find((v) => v.type === 'spacing');
  assert.ok(spacing, '应报告间距违规');
  assert.equal(spacing!.otherId, 'o');
});

test('自动解遮挡：舞台边界 —— 圆出界报 stage 违规', () => {
  const me = singer('me', 5, 5, 0.3);
  const sc = scene({ stage: { width: 10, depth: 8 }, conductor: { x: 5, y: 0 }, singers: [me] });
  const f = evaluateUnblockPosition(sc, 'me', { x: 0.1, y: 5 }); // 圆左侧出界
  assert.equal(f.feasible, false);
  assert.ok(f.violations.some((v) => v.type === 'stage'));
});

test('自动解遮挡：视线恰好相切于对方圆（擦边）视为可行', () => {
  // 视线为 x=2 的竖直线；对方圆心 (2.5, 1) r=0.5 → 圆心距视线 0.5 = 半径，恰好相切；
  // 同时与被移动者相距 3.04 m，满足间距约束
  const me = singer('me', 2, 4, 0.3);
  const other = singer('o', 2.5, 1, 0.5);
  const sc = scene({ stage: { width: 12, depth: 8 }, conductor: { x: 2, y: 0 }, singers: [me, other] });
  const f = evaluateUnblockPosition(sc, 'me', { x: 2, y: 4 });
  assert.equal(f.feasible, true, f.violations.map((v) => v.message).join('；'));
  assert.equal(analyzeSinger(sc.conductor, me, [me, other]).status, 'tangent');
});

test('自动解遮挡：移到与指挥重合 → degenerate 违规', () => {
  const me = singer('me', 5, 5, 0.3);
  const sc = scene({ stage: { width: 12, depth: 8 }, conductor: { x: 5, y: 0.5 }, singers: [me] });
  const f = evaluateUnblockPosition(sc, 'me', { x: 5, y: 0.5 });
  assert.equal(f.feasible, false);
  assert.ok(f.violations.some((v) => v.type === 'degenerate'));
});

test('自动解遮挡：舞台放不下站位圆 → error 明确提示', () => {
  const me = singer('me', 1, 1, 2); // 直径 4 > 舞台 2×2
  const sc = scene({ stage: { width: 2, depth: 2 }, conductor: { x: 1, y: 0 }, singers: [me] });
  const r = findUnblockCandidates(sc, 'me');
  assert.equal(r.candidates.length, 0);
  assert.ok(r.error && r.error.includes('舞台空间不足'));
});

test('自动解遮挡：未知演唱者 id → error', () => {
  const sc = scene({ conductor: { x: 0, y: 0 }, singers: [singer('a', 1, 1)] });
  const r = findUnblockCandidates(sc, 'nope');
  assert.equal(r.candidates.length, 0);
  assert.ok(r.error && r.error.includes('未找到'));
});

// ---------------------------------------------------------------------------
// 遮挡关系图谱：有向图构建、可达链路与循环检测
// ---------------------------------------------------------------------------

test('图谱：边指向最近遮挡者，通畅/相切节点无出边', () => {
  // 指挥 (0,0)；a 通畅；b 被 a 挡；c 同时被 a、b 挡但 b 更近；
  // d 的视线与 g 的圆恰好相切（d→指挥线段 4x-3y=0，g 圆心距 0.6 = 半径）
  const a = singer('a', 0, 2, 0.3);
  const b = singer('b', 0, 4, 0.3);
  const c = singer('c', 0, 6, 0.3);
  const d = singer('d', 3, 4, 0.3);
  const g0 = singer('g', 0.9, 2.2, 0.6);
  const analysis = analyzeScene(scene({ conductor: { x: 0, y: 0 }, singers: [a, b, c, d, g0] }));
  // 前置校验：各节点状态符合预期
  const statusOf = (id: string) => analysis.results.find((r) => r.singerId === id)?.status;
  assert.equal(statusOf('a'), 'clear');
  assert.equal(statusOf('b'), 'blocked');
  assert.equal(statusOf('c'), 'blocked');
  assert.equal(statusOf('d'), 'tangent');
  assert.equal(statusOf('g'), 'clear');

  const g = buildOcclusionGraph(analysis);
  assert.equal(g.nodes.length, 5);
  assert.deepEqual(
    g.edges.map((ed) => [ed.from, ed.to]),
    [
      ['b', 'a'],
      ['c', 'b'], // c 的最近遮挡者是 b（距眼睛 1.7 m），不是 a（3.7 m）
    ],
  );
  assert.deepEqual(g.cycles, []);

  // 链路：c → b → a（终止于通畅节点）
  const chainC = occlusionChainFrom(g, 'c');
  assert.deepEqual(chainC.nodes, ['c', 'b', 'a']);
  assert.deepEqual(chainC.edges, [
    ['c', 'b'],
    ['b', 'a'],
  ]);
  assert.equal(chainC.cycle, undefined);

  // 通畅 / 相切节点都是链的终点（无出边）
  for (const id of ['a', 'd', 'g']) {
    const chain = occlusionChainFrom(g, id);
    assert.deepEqual(chain.nodes, [id]);
    assert.deepEqual(chain.edges, []);
  }
  // 未知起点 → 空链路
  assert.deepEqual(occlusionChainFrom(g, 'nope'), { nodes: [], edges: [] });
});

test('图谱：退化节点（与指挥重合）无出边', () => {
  const e = singer('e', 0, 0, 0.3); // 与指挥重合 → 视线退化
  const analysis = analyzeScene(scene({ conductor: { x: 0, y: 0 }, singers: [e] }));
  assert.equal(analysis.results[0].status, 'degenerate');
  const g = buildOcclusionGraph(analysis);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.nodes[0].status, 'degenerate');
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.cycles, []);
  assert.deepEqual(occlusionChainFrom(g, 'e'), { nodes: ['e'], edges: [], cycle: undefined });
});

test('图谱：互相遮挡的两圆形成循环，链路标出循环部分', () => {
  // a(0,4) r=1 与 b(0.5,3.5) r=1 互相包含对方眼睛 → 互挡循环
  const a = singer('a', 0, 4, 1);
  const b = singer('b', 0.5, 3.5, 1);
  const analysis = analyzeScene(scene({ conductor: { x: 0, y: 0 }, singers: [a, b] }));
  const g = buildOcclusionGraph(analysis);

  assert.deepEqual(
    g.edges.map((e) => [e.from, e.to]).sort(),
    [
      ['a', 'b'],
      ['b', 'a'],
    ],
  );
  assert.deepEqual(g.cycles, [['a', 'b']]); // 规范化：从最小 id 开始

  const chainA = occlusionChainFrom(g, 'a');
  assert.deepEqual(chainA.nodes, ['a', 'b']);
  assert.deepEqual(chainA.edges, [
    ['a', 'b'],
    ['b', 'a'], // 含回到循环起点的闭合边
  ]);
  assert.deepEqual(chainA.cycle, ['a', 'b']);

  const chainB = occlusionChainFrom(g, 'b');
  assert.deepEqual(chainB.nodes, ['b', 'a']);
  assert.deepEqual(chainB.cycle, ['b', 'a']); // 链路循环从再次到达的节点开始，不做规范化
});

test('图谱：链路经过他人进入循环（A→C→B→C）', () => {
  // b(0,2) r=0.5 与 c(0.3,2.3) r=0.5 互挡成环；a(0,4) 的最近遮挡者是 c
  const a = singer('a', 0, 4, 0.3);
  const b = singer('b', 0, 2, 0.5);
  const c = singer('c', 0.3, 2.3, 0.5);
  const analysis = analyzeScene(scene({ conductor: { x: 0, y: 0 }, singers: [a, b, c] }));
  const g = buildOcclusionGraph(analysis);

  assert.deepEqual(
    g.edges.map((e) => [e.from, e.to]).sort(),
    [
      ['a', 'c'],
      ['b', 'c'],
      ['c', 'b'],
    ],
  );
  assert.deepEqual(g.cycles, [['b', 'c']]);

  const chain = occlusionChainFrom(g, 'a');
  assert.deepEqual(chain.nodes, ['a', 'c', 'b']);
  assert.deepEqual(chain.edges, [
    ['a', 'c'],
    ['c', 'b'],
    ['b', 'c'],
  ]);
  assert.deepEqual(chain.cycle, ['c', 'b']);
});

test('图谱：圆心重合的站位互挡成环，且与无关循环各自独立', () => {
  // d、e 圆心重合互挡；f、g 圆心重合互挡；h 通畅
  const d = singer('d', 3, 3, 0.3);
  const e = singer('e', 3, 3, 0.35);
  const f = singer('f', 8, 3, 0.3);
  const g2 = singer('g', 8, 3, 0.3);
  const h = singer('h', 5, 6, 0.3);
  const analysis = analyzeScene(scene({ conductor: { x: 6, y: 0 }, singers: [d, e, f, g2, h] }));
  const g = buildOcclusionGraph(analysis);

  assert.deepEqual(g.cycles, [
    ['d', 'e'],
    ['f', 'g'],
  ]);
  // h 的视线不被任何人遮挡 → 无出边
  assert.ok(!g.edges.some((e2) => e2.from === 'h'));
});
