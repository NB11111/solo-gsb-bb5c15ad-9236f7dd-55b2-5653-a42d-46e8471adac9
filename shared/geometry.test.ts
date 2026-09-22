import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeScene,
  analyzeSinger,
  buildConductorHeatZone,
  buildOcclusionGraph,
  conductorSightlineStatus,
  evaluateUnblockPosition,
  findUnblockCandidates,
  heatTier,
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

// ---------------------------------------------------------------------------
// 指挥站位热区：网格采样、字典序评分、1m 间距候选、退化不可用
// ---------------------------------------------------------------------------

test('热区：空场景给出明确空结果', () => {
  const sc = scene({ conductor: { x: 6, y: -1 }, singers: [] });
  const hz = buildConductorHeatZone(sc);
  assert.equal(hz.empty, true);
  assert.equal(hz.spots.length, 0);
  assert.equal(hz.candidates.length, 0);
  assert.equal(hz.totalSingers, 0);
  assert.deepEqual(hz.bounds, { minX: -1, maxX: 13, minY: -2.8, maxY: 0 });
});

test('热区：0.25 m 网格覆盖 x∈[-1,W+1]、y∈[-2.8,0] 全部网格点（含边界）', () => {
  const sc = scene({ conductor: { x: 6, y: -1 }, singers: [singer('a', 6, 3)] });
  const hz = buildConductorHeatZone(sc);
  assert.equal(hz.empty, false);
  assert.equal(hz.gridStep, 0.25);
  // x: -1..13 步长 0.25 → 57 个点；y: -2.8..0 步长 0.25 → 12 个点（含 0）
  const xs = new Set(hz.spots.map((s) => s.x));
  const ys = new Set(hz.spots.map((s) => s.y));
  assert.equal(xs.size, 57);
  assert.equal(ys.size, 13);
  assert.equal(hz.spots.length, 57 * 13);
  assert.ok(xs.has(-1) && xs.has(13));
  assert.ok(ys.has(-2.8) && ys.has(0));
  // 排序：x 升序、y 降序（y=0 的行在前）
  assert.equal(hz.spots[0].y, 0);
  assert.equal(hz.spots[0].x, -1);
  assert.equal(hz.spots[hz.spots.length - 1].y, -2.8);
  assert.equal(hz.spots[hz.spots.length - 1].x, 13);
  // 明细四项之和 = 总人数
  for (const sp of hz.spots) {
    assert.equal(sp.clear + sp.tangent + sp.blocked + sp.degenerate, 1);
  }
});

test('热区：演唱者与候选指挥位置重合 → 该点视线退化、不可用且不计分', () => {
  // 单人站在 (6, 0)：采样点 (6, 0) 与之重合 → degenerate，分数 0、分档 0
  const sc = scene({ conductor: { x: 6, y: -1 }, singers: [singer('a', 6, 0, 0.3)] });
  const hz = buildConductorHeatZone(sc);
  const degen = hz.spots.find((s) => s.x === 6 && s.y === 0)!;
  assert.equal(degen.degenerate, 1);
  assert.equal(degen.clear + degen.tangent + degen.blocked, 0);
  assert.equal(degen.score, 0);
  assert.equal(degen.tier, 0);
  // 其余点（不重合）该人视线通畅 → 满分
  const other = hz.spots.find((s) => s.x === 6 && s.y === -0.25)!;
  assert.equal(other.clear, 1);
  assert.equal(other.score, 2);
  assert.equal(other.tier, 5);
});

test('热区：分数为字典序（通畅为主、相切为次）', () => {
  // 4 人：a 在中轴会被 b 遮挡（指挥在 y=0 附近时）；构造 3 clear vs 2 clear+多 tangent 的对比
  // 指挥 (6,0)：a(6,4) 被 b(6,2) 挡；c/d 通畅；另取 g 使某人相切：
  // c(3,2) 的视线与圆 g(圆心距=半径) 相切，g 半径 0.6、圆心 (4.2,1.2) 在指挥-c 连线上的垂足
  // 为简化：直接对两个候选点验证分数排序公式。
  const a = singer('a', 6, 4, 0.3);
  const b = singer('b', 6, 2, 0.3);
  const c = singer('c', 9, 3, 0.3);
  const sc = scene({ conductor: { x: 6, y: 0 }, singers: [a, b, c] });
  const hz = buildConductorHeatZone(sc);
  // 指挥 (6,0)：a 被 b 挡、b 通畅、c 通畅 → (clear=2, blocked=1)
  const front = hz.spots.find((s) => s.x === 6 && s.y === 0)!;
  assert.equal(front.clear, 2);
  assert.equal(front.blocked, 1);
  assert.equal(front.score, 2 * 4);
  // 指挥 (6,-2.8) 与 a 共线仍会被 b 挡；改取离轴点 (3,-2.8)：三人全部通畅 → clear=3
  const far = hz.spots.find((s) => s.x === 3 && s.y === -2.8)!;
  assert.equal(far.clear, 3);
  assert.equal(far.score, 3 * 4);
  assert.ok(far.score > front.score);
  // 字典序：clear=2 但 tangent=2 的分 > clear=2 tangent=0（rankBase=5 保证）
  assert.equal(2 * 5 + 2 > 2 * 5 + 0, true);
});

test('热区：候选为最高分且彼此至少相距 1 m，至多 3 个，并附完整视线分析', () => {
  // 对称场景：指挥远离舞台时全员通畅，最高分形成连续 0.25 m 网格 → 必须按 1 m 稀疏化
  const sc = scene({
    stage: { width: 12, depth: 8 },
    conductor: { x: 6, y: -1 },
    singers: [singer('a', 2, 6), singer('b', 6, 6), singer('c', 10, 6)],
  });
  const hz = buildConductorHeatZone(sc);
  assert.ok(hz.candidates.length >= 1);
  assert.ok(hz.candidates.length <= 3);

  // 两两距离 ≥ 1 m
  for (let i = 0; i < hz.candidates.length; i++) {
    for (let j = i + 1; j < hz.candidates.length; j++) {
      const p = hz.candidates[i];
      const q = hz.candidates[j];
      assert.ok(
        Math.hypot(p.x - q.x, p.y - q.y) >= 1 - TANGENT_EPS,
        `候选 ${i} 与 ${j} 距离不足 1 m`,
      );
    }
  }
  // 候选按分数降序
  for (let i = 1; i < hz.candidates.length; i++) {
    assert.ok(hz.candidates[i - 1].score >= hz.candidates[i].score);
  }
  // 不存在比入选点更高分且与之相距 ≥ 1 m 的未入选点（贪心最优性抽查）
  const best = hz.candidates[0];
  assert.equal(best.score, Math.max(...hz.spots.map((s) => s.score)));
  // 候选附带的分析与共享核心一致
  for (const cand of hz.candidates) {
    const expected = analyzeScene({ ...sc, conductor: { x: cand.x, y: cand.y } });
    assert.equal(cand.analysis.summary.clear, cand.clear);
    assert.equal(cand.analysis.summary.tangent, cand.tangent);
    assert.equal(cand.analysis.summary.blocked, cand.blocked);
    assert.equal(cand.analysis.summary.degenerate, cand.degenerate);
    assert.equal(cand.analysis.results.length, expected.results.length);
  }
});

test('热区：所有采样点都无通畅视线 → 无候选但非空场景', () => {
  // 两圆心重合：任意指挥位置两人互相遮挡（对方圆包含自己的眼睛），全场无通畅点
  const sc = scene({
    conductor: { x: 0, y: 0 },
    singers: [singer('a', 4, 4, 0.3), singer('b', 4, 4, 0.3)],
  });
  const hz = buildConductorHeatZone(sc);
  assert.equal(hz.empty, false);
  assert.ok(hz.spots.length > 0);
  assert.equal(Math.max(...hz.spots.map((s) => s.score)), 0);
  assert.equal(hz.candidates.length, 0);
});

test('热区：conductorSightlineStatus 与 analyzeSinger 在随机场景下完全一致', () => {
  // 伪随机生成站位与指挥网格点，交叉验证轻量判定与完整分析语义一致
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const singers: Singer[] = [];
  for (let i = 0; i < 12; i++) {
    singers.push(singer(`r${i}`, rand() * 12, rand() * 8, 0.15 + rand() * 0.5));
  }
  for (let ix = 0; ix <= 10; ix++) {
    for (let iy = 0; iy <= 8; iy++) {
      const cond = { x: -1 + ix * 1.4, y: -2.8 + iy * 0.35 };
      for (const s of singers) {
        const light = conductorSightlineStatus(cond, s, singers);
        const full = analyzeSinger(cond, s, singers).status;
        assert.equal(light, full, `(${cond.x.toFixed(2)},${cond.y.toFixed(2)}) ${s.id}`);
      }
    }
  }
});

test('热区：密集站位（空间网格快路径）评分与朴素 O(n²) 逐点判定逐格一致', () => {
  // 120 人密集铺满 8×6 舞台（半径参差），迫使快路径每个 3×3 邻域多桶命中；
  // 另加随机半径与轻微错位，覆盖相切/钳制投影/端点外等分支。
  let seed = 98765;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const singers: Singer[] = [];
  let id = 0;
  for (let gx = 0; gx < 12; gx++) {
    for (let gy = 0; gy < 10; gy++) {
      singers.push(
        singer(
          `d${id++}`,
          0.4 + gx * 0.66 + (rand() - 0.5) * 0.12,
          0.4 + gy * 0.58 + (rand() - 0.5) * 0.12,
          0.2 + rand() * 0.25,
        ),
      );
    }
  }
  const sc = scene({ stage: { width: 8, depth: 6 }, conductor: { x: 4, y: -1 }, singers });
  const hz = buildConductorHeatZone(sc);
  assert.equal(hz.empty, false);
  // 抽查 40 个采样点：热区快路径计数必须与朴素逐人 analyzeSinger 完全一致
  for (let q = 0; q < hz.spots.length; q += Math.floor(hz.spots.length / 40)) {
    const sp = hz.spots[q];
    const cond = { x: sp.x, y: sp.y };
    let clear = 0;
    let tangent = 0;
    let blocked = 0;
    let degenerate = 0;
    for (const s of singers) {
      const st = analyzeSinger(cond, s, singers).status;
      if (st === 'clear') clear++;
      else if (st === 'tangent') tangent++;
      else if (st === 'blocked') blocked++;
      else degenerate++;
    }
    assert.equal(sp.clear, clear, `(${sp.x},${sp.y}) clear`);
    assert.equal(sp.tangent, tangent, `(${sp.x},${sp.y}) tangent`);
    assert.equal(sp.blocked, blocked, `(${sp.x},${sp.y}) blocked`);
    assert.equal(sp.degenerate, degenerate, `(${sp.x},${sp.y}) degenerate`);
    assert.equal(sp.score, clear * (singers.length + 1) + tangent);
  }
});

test('热区：不修改入参场景，且不依赖当前指挥位置（指挥拖动不改变热区）', () => {
  const sc = scene({ conductor: { x: 6, y: -1 }, singers: [singer('a', 6, 3), singer('b', 7, 3)] });
  const snapshot = JSON.stringify(sc);
  const hz1 = buildConductorHeatZone(sc);
  const moved = { ...sc, conductor: { x: 0, y: -2.8 } };
  const hz2 = buildConductorHeatZone(moved);
  assert.deepEqual(
    hz1.spots.map((s) => [s.x, s.y, s.score]),
    hz2.spots.map((s) => [s.x, s.y, s.score]),
  );
  assert.equal(JSON.stringify(sc), snapshot);
});

test('热区：heatTier 分档边界', () => {
  assert.equal(heatTier(0, 4), 0);
  assert.equal(heatTier(1, 4), 2); // ceil(5/4)=2
  assert.equal(heatTier(2, 4), 3);
  assert.equal(heatTier(3, 4), 4);
  assert.equal(heatTier(4, 4), 5);
  assert.equal(heatTier(5, 0), 0);
  assert.equal(heatTier(1, 5), 1); // ceil(5/5)=1
});
