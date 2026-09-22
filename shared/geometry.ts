/**
 * 合唱视线遮挡检查 —— 共享几何核心。
 *
 * 该模块同时被前端（实时分析）与后端（/api/analyze 校验）引用，保证两端判定结果一致。
 *
 * 判定语义（单位：米）：
 *  - 视线：演唱者眼睛（站位圆圆心）到指挥点的线段。
 *  - 遮挡：其他站位圆与视线线段相交（圆心到线段的距离 < 半径 - TANGENT_EPS）。
 *  - 相切：圆心到线段的距离与半径之差在 ±TANGENT_EPS 内，视为“擦边”，
 *          单独标注为 tangent，不判定为遮挡（线段与圆仅一个接触点）。
 *  - 重合：站位圆包含眼睛或指挥点时按相交处理（进入参数 t 被钳制到 0/1）；
 *          演唱者与指挥重合时视线退化（degenerate），单独标注。
 *  - 共线：多个遮挡圆按进入参数 tEnter 升序排列，最近的非相切遮挡者决定着色。
 */

export interface Vec {
  x: number;
  y: number;
}

export interface Singer {
  id: string;
  name: string;
  x: number;
  y: number;
  /** 人体半径（米），> 0 */
  radius: number;
}

export interface Scene {
  version: 1;
  /** 舞台尺寸（米）：宽 × 深 */
  stage: { width: number; depth: number };
  /** 指挥位置（舞台坐标，y<0 表示舞台前方） */
  conductor: Vec;
  singers: Singer[];
}

/** 相切判定容差（米）：|圆心距 - 半径| ≤ 该值视为相切 */
export const TANGENT_EPS = 1e-6;
/** 视线退化阈值：演唱者与指挥距离小于该值视为重合 */
const DEGENERATE_EPS = 1e-9;
/** 站位重合阈值：两圆心距离小于该值视为重合 */
const COINCIDE_EPS = 1e-9;

export type LOSStatus = 'clear' | 'tangent' | 'blocked' | 'degenerate';

export interface Occlusion {
  blockerId: string;
  blockerName: string;
  /** 视线进入遮挡圆时的参数 t（0 = 演唱者眼睛，1 = 指挥） */
  tEnter: number;
  /** 沿视线从眼睛到进入点的距离（米） */
  distance: number;
  /** 净余量 = 圆心到线段距离 - 半径；< 0 表示侵入（遮挡），≈0 表示相切 */
  clearance: number;
  /** 是否相切（擦边，不判定为遮挡） */
  tangent: boolean;
}

export interface SingerLOS {
  singerId: string;
  singerName: string;
  status: LOSStatus;
  /** 全部遮挡/相切事件，按 tEnter 升序（沿视线由近及远） */
  occlusions: Occlusion[];
  /** 最近的非相切遮挡者（决定该演唱者的着色）；无则 undefined */
  nearest?: Occlusion;
}

export interface SceneWarning {
  type: 'coincident-singers' | 'coincident-conductor';
  message: string;
  ids: string[];
}

export interface AnalysisSummary {
  total: number;
  clear: number;
  tangent: number;
  blocked: number;
  degenerate: number;
}

export interface Analysis {
  results: SingerLOS[];
  warnings: SceneWarning[];
  summary: AnalysisSummary;
}

/** 分析单个演唱者到指挥的视线。 */
export function analyzeSinger(conductor: Vec, singer: Singer, all: Singer[]): SingerLOS {
  const p0x = singer.x;
  const p0y = singer.y;
  const dx = conductor.x - p0x;
  const dy = conductor.y - p0y;
  const len2 = dx * dx + dy * dy;

  if (len2 < DEGENERATE_EPS * DEGENERATE_EPS) {
    return { singerId: singer.id, singerName: singer.name, status: 'degenerate', occlusions: [] };
  }
  const len = Math.sqrt(len2);

  const occlusions: Occlusion[] = [];
  for (const o of all) {
    if (o.id === singer.id) continue;
    if (!(o.radius > 0)) continue;

    // 圆心在线段上的投影参数（钳制到 [0,1]，正确处理端点外/包含端点的圆）
    const tRaw = ((o.x - p0x) * dx + (o.y - p0y) * dy) / len2;
    const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
    const qx = p0x + t * dx;
    const qy = p0y + t * dy;
    const dist = Math.hypot(o.x - qx, o.y - qy);
    const clearance = dist - o.radius;

    if (clearance < -TANGENT_EPS) {
      // 遮挡：求视线进入圆的参数（线段-圆求交，取较小根并钳制）
      const half = Math.sqrt(Math.max(0, o.radius * o.radius - dist * dist)) / len;
      let tEnter = t - half;
      if (tEnter < 0) tEnter = 0;
      else if (tEnter > 1) tEnter = 1;
      occlusions.push({
        blockerId: o.id,
        blockerName: o.name,
        tEnter,
        distance: tEnter * len,
        clearance,
        tangent: false,
      });
    } else if (clearance <= TANGENT_EPS) {
      // 相切（擦边）：记录但不判定为遮挡
      occlusions.push({
        blockerId: o.id,
        blockerName: o.name,
        tEnter: t,
        distance: t * len,
        clearance,
        tangent: true,
      });
    }
  }

  occlusions.sort((a, b) => a.tEnter - b.tEnter);
  const nearest = occlusions.find((o) => !o.tangent);
  const status: LOSStatus = nearest ? 'blocked' : occlusions.length > 0 ? 'tangent' : 'clear';
  return { singerId: singer.id, singerName: singer.name, status, occlusions, nearest };
}

/** 分析整个场景：每位演唱者的视线 + 全局警告 + 统计。 */
export function analyzeScene(scene: Scene): Analysis {
  const results = scene.singers.map((s) => analyzeSinger(scene.conductor, s, scene.singers));

  const warnings: SceneWarning[] = [];
  // 站位两两重合检查
  for (let i = 0; i < scene.singers.length; i++) {
    for (let j = i + 1; j < scene.singers.length; j++) {
      const a = scene.singers[i];
      const b = scene.singers[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < COINCIDE_EPS) {
        warnings.push({
          type: 'coincident-singers',
          message: `站位重合：${a.name} 与 ${b.name} 的圆心重合`,
          ids: [a.id, b.id],
        });
      }
    }
  }
  // 演唱者与指挥重合检查
  for (const s of scene.singers) {
    if (Math.hypot(s.x - scene.conductor.x, s.y - scene.conductor.y) < DEGENERATE_EPS) {
      warnings.push({
        type: 'coincident-conductor',
        message: `视线退化：${s.name} 与指挥位置重合`,
        ids: [s.id],
      });
    }
  }

  const summary: AnalysisSummary = { total: results.length, clear: 0, tangent: 0, blocked: 0, degenerate: 0 };
  for (const r of results) summary[r.status]++;

  return { results, warnings, summary };
}

// ---------------------------------------------------------------------------
// 遮挡关系图谱：演唱者 → 沿视线最近遮挡者 的有向图
//
// 每个节点出度 ≤ 1（仅当被遮挡时指向最近遮挡者），因此从任意节点出发的
// 可达链路唯一：要么终止于通畅/相切/退化节点（无出边），要么进入一个有向
// 循环（例如两圆互相包含对方眼睛时形成 A↔B 互挡循环）。出度 ≤ 1 的有向图
// 中循环两两不相交，可用一次沿边行走全部找出。
// ---------------------------------------------------------------------------

export interface OcclusionGraphNode {
  singerId: string;
  name: string;
  status: LOSStatus;
}

export interface OcclusionGraphEdge {
  /** 被遮挡的演唱者 id */
  from: string;
  /** 其沿视线最近的遮挡者 id */
  to: string;
  /** 沿视线从眼睛到进入点的距离（米） */
  distance: number;
}

export interface OcclusionGraph {
  nodes: OcclusionGraphNode[];
  edges: OcclusionGraphEdge[];
  /**
   * 图中全部有向循环；每个循环为按遮挡指向排列的 singerId 列表
   * （已规范化为从最小 id 开始，保证输出确定），循环之间互不重叠。
   */
  cycles: string[][];
}

/** 由场景分析结果构建遮挡关系图谱（纯函数）。 */
export function buildOcclusionGraph(analysis: Analysis): OcclusionGraph {
  const nodes: OcclusionGraphNode[] = analysis.results.map((r) => ({
    singerId: r.singerId,
    name: r.singerName,
    status: r.status,
  }));
  const edges: OcclusionGraphEdge[] = [];
  for (const r of analysis.results) {
    if (r.nearest) {
      edges.push({ from: r.singerId, to: r.nearest.blockerId, distance: r.nearest.distance });
    }
  }

  // 循环检测：出度 ≤ 1，从每个未访问节点沿边行走，遇到本次路径上的节点即成环
  const next = new Map(edges.map((e) => [e.from, e.to]));
  const visited = new Set<string>();
  const cycles: string[][] = [];
  for (const n of nodes) {
    if (visited.has(n.singerId)) continue;
    const path: string[] = [];
    const index = new Map<string, number>();
    let cur: string | undefined = n.singerId;
    while (cur !== undefined && !visited.has(cur)) {
      visited.add(cur);
      index.set(cur, path.length);
      path.push(cur);
      cur = next.get(cur);
    }
    if (cur !== undefined && index.has(cur)) {
      const cycle = path.slice(index.get(cur)!);
      // 规范化：旋转到最小 id 开头，保证多次构建输出一致
      let minAt = 0;
      for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[minAt]) minAt = i;
      cycles.push([...cycle.slice(minAt), ...cycle.slice(0, minAt)]);
    }
  }
  cycles.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { nodes, edges, cycles };
}

export interface OcclusionChain {
  /** 从起点出发沿遮挡边依次可达的节点（含起点，不重复） */
  nodes: string[];
  /** 可达边 [from, to]（若进入循环，含回到循环起点的闭合边） */
  edges: [string, string][];
  /** 链路进入的有向循环（按遮挡指向排列，从再次到达的节点开始）；无循环时为 undefined */
  cycle?: string[];
}

/** 从指定演唱者出发的可达遮挡链路（纯函数）；起点不在图中时返回空链路。 */
export function occlusionChainFrom(graph: OcclusionGraph, startId: string): OcclusionChain {
  if (!graph.nodes.some((n) => n.singerId === startId)) return { nodes: [], edges: [] };
  const next = new Map(graph.edges.map((e) => [e.from, e.to]));
  const nodes: string[] = [];
  const edges: [string, string][] = [];
  const index = new Map<string, number>();
  let cur: string | undefined = startId;
  while (cur !== undefined && !index.has(cur)) {
    index.set(cur, nodes.length);
    nodes.push(cur);
    const to = next.get(cur);
    if (to !== undefined) edges.push([cur, to]);
    cur = to;
  }
  const cycle = cur !== undefined ? nodes.slice(index.get(cur)!) : undefined;
  return { nodes, edges, cycle };
}

// ---------------------------------------------------------------------------
// 自动解遮挡：网格采样 + 细化搜索
//
// 只移动“被选中的演唱者”一人，寻找位移最小的可行新位置。可行位置必须同时满足：
//  1) 留在舞台内：整个站位圆（含半径）位于舞台矩形内，即圆心 ∈ [r, W-r] × [r, D-r]；
//  2) 间距：与其余每个站位圆的圆心距 ≥ 自身半径 + 对方半径（相切允许，侵入不行）；
//  3) 视线：从新位置到指挥的线段不被任何其他站位圆侵入（相切擦边允许，
//     analyzeSinger 判定为 blocked 才算违规；与指挥重合的退化也视为违规）。
// 所有判定均复用 TANGENT_EPS 容差，与实时着色语义完全一致。
// 搜索是纯函数：构造被移动者的临时副本参与计算，绝不修改入参场景中的任何人。
// ---------------------------------------------------------------------------

export type UnblockViolationType = 'stage' | 'spacing' | 'sightline' | 'degenerate';

export interface UnblockViolation {
  type: UnblockViolationType;
  message: string;
  /** spacing / sightline 违规时涉及的对方演唱者 id */
  otherId?: string;
}

export interface UnblockFeasibility {
  feasible: boolean;
  /** 全部不满足的约束（可能同时有多个），可行时为空数组 */
  violations: UnblockViolation[];
}

export interface UnblockCandidate {
  x: number;
  y: number;
  /** 相对当前位置的位移距离（米） */
  distance: number;
}

export interface InfeasibleSample {
  x: number;
  y: number;
  /** 相对当前位置的位移距离（米） */
  distance: number;
  violations: UnblockViolation[];
}

export interface UnblockOptions {
  /** 粗采样网格间距（米），默认 0.5 */
  gridStep?: number;
  /** 细化轮数（每轮步长减半），默认 5（最细步长 0.5/2^5 ≈ 0.016 m） */
  refineRounds?: number;
  /** 返回的可行候选数量，默认 3 */
  maxFeasible?: number;
  /** 返回的不可行采样数量，默认 3 */
  maxInfeasible?: number;
}

export interface UnblockResult {
  singerId: string;
  /** 可行候选，按位移距离升序（至多 maxFeasible 个） */
  candidates: UnblockCandidate[];
  /** 距当前位置最近的不可行采样及其原因（至多 maxInfeasible 个） */
  infeasibleSamples: InfeasibleSample[];
  /** 实际评估过的去重采样点数量（含细化点） */
  sampledCount: number;
  /** 其中可行的采样点数量 */
  feasibleCount: number;
  /** 当前位置（位移 0）本身已可行，无需移动 */
  alreadyClear: boolean;
  /** 无法执行搜索的致命原因（找不到演唱者 / 舞台小到放不下该站位圆） */
  error?: string;
}

/** 站位圆完全留在舞台内时圆心允许的矩形范围（inclusive）。 */
export function stageInterior(
  stage: { width: number; depth: number },
  radius: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: Math.min(0, stage.width) + radius,
    maxX: Math.max(0, stage.width) - radius,
    minY: Math.min(0, stage.depth) + radius,
    maxY: Math.max(0, stage.depth) - radius,
  };
}

/**
 * 评估“把 singerId 移到 pos”是否可行。纯函数：不修改 scene。
 * 同时检查舞台边界、两两圆间距与视线遮挡，返回全部违规原因。
 */
export function evaluateUnblockPosition(
  scene: Scene,
  singerId: string,
  pos: Vec,
): UnblockFeasibility {
  const me = scene.singers.find((s) => s.id === singerId);
  const violations: UnblockViolation[] = [];
  if (!me) {
    return {
      feasible: false,
      violations: [{ type: 'stage', message: '未找到该演唱者，无法评估位置' }],
    };
  }

  // 1) 留在舞台内（整圆，不只是圆心）
  const b = stageInterior(scene.stage, me.radius);
  if (
    pos.x < b.minX - TANGENT_EPS ||
    pos.x > b.maxX + TANGENT_EPS ||
    pos.y < b.minY - TANGENT_EPS ||
    pos.y > b.maxY + TANGENT_EPS
  ) {
    violations.push({
      type: 'stage',
      message:
        `超出舞台：圆心须位于 x∈[${b.minX.toFixed(2)}, ${b.maxX.toFixed(2)}] m、` +
        `y∈[${b.minY.toFixed(2)}, ${b.maxY.toFixed(2)}] m 内` +
        `（r=${me.radius.toFixed(2)} m 的站位圆需完全留在舞台内）`,
    });
  }

  // 与指挥重合 → 视线退化（无法解遮挡）
  const degenerate =
    Math.hypot(pos.x - scene.conductor.x, pos.y - scene.conductor.y) < DEGENERATE_EPS;
  if (degenerate) {
    violations.push({ type: 'degenerate', message: '与指挥位置重合，视线退化为点' });
  }

  // 2) 与其余站位圆保持 ≥ r_me + r_other 的间距
  for (const o of scene.singers) {
    if (o.id === singerId) continue;
    const d = Math.hypot(o.x - pos.x, o.y - pos.y);
    const minDist = me.radius + o.radius;
    if (d < minDist - TANGENT_EPS) {
      violations.push({
        type: 'spacing',
        otherId: o.id,
        message:
          `与 ${o.name} 间距不足：圆心距 ${d.toFixed(3)} m，需 ≥ ${minDist.toFixed(3)} m` +
          `（两圆侵入 ${(minDist - d).toFixed(3)} m）`,
      });
    }
  }

  // 3) 新位置到指挥的视线不被任何其他站位圆侵入（构造临时副本，scene 不被修改）
  if (!degenerate) {
    const moved: Singer = { ...me, x: pos.x, y: pos.y };
    const others = scene.singers.filter((o) => o.id !== singerId);
    const los = analyzeSinger(scene.conductor, moved, [moved, ...others]);
    if (los.status === 'blocked' && los.nearest) {
      violations.push({
        type: 'sightline',
        otherId: los.nearest.blockerId,
        message: `视线仍被 ${los.nearest.blockerName} 遮挡（侵入 ${(-los.nearest.clearance).toFixed(3)} m）`,
      });
    }
  }

  return { feasible: violations.length === 0, violations };
}

interface EvaluatedPoint {
  x: number;
  y: number;
  distance: number;
  feasible: boolean;
  violations: UnblockViolation[];
}

const round9 = (n: number) => Math.round(n * 1e9) / 1e9;
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

function byDistanceThenXY(a: { distance: number; x: number; y: number }, b: typeof a): number {
  return a.distance - b.distance || a.x - b.x || a.y - b.y;
}

/**
 * 自动解遮挡搜索：先在舞台内部按网格粗采样，再对位移最小的若干可行种子做多轮
 * 贪心细化（每轮在 8 邻域内沿步长下降、步长逐轮减半），最后按位移排序。
 * 全程只评估候选位置，不修改场景中的任何演唱者。
 */
export function findUnblockCandidates(
  scene: Scene,
  singerId: string,
  options: UnblockOptions = {},
): UnblockResult {
  const gridStep = options.gridStep ?? 0.5;
  const refineRounds = Math.max(0, options.refineRounds ?? 5);
  const maxFeasible = options.maxFeasible ?? 3;
  const maxInfeasible = options.maxInfeasible ?? 3;

  const me = scene.singers.find((s) => s.id === singerId);
  if (!me) {
    return {
      singerId,
      candidates: [],
      infeasibleSamples: [],
      sampledCount: 0,
      feasibleCount: 0,
      alreadyClear: false,
      error: '未找到该演唱者，无法搜索解遮挡位置。',
    };
  }

  const b = stageInterior(scene.stage, me.radius);
  if (!(b.maxX >= b.minX - TANGENT_EPS && b.maxY >= b.minY - TANGENT_EPS)) {
    return {
      singerId,
      candidates: [],
      infeasibleSamples: [],
      sampledCount: 0,
      feasibleCount: 0,
      alreadyClear: false,
      error:
        `舞台空间不足：r=${me.radius.toFixed(2)} m 的站位圆无法完全留在 ` +
        `${scene.stage.width} m × ${scene.stage.depth} m 的舞台内` +
        `（至少需要 ${(2 * me.radius).toFixed(2)} m × ${(2 * me.radius).toFixed(2)} m）。`,
    };
  }

  // 评估点缓存（网格点与细化点共享），按 1nm 精度去重
  const evaluated = new Map<string, EvaluatedPoint>();
  const evaluate = (x: number, y: number): EvaluatedPoint => {
    const rx = round9(x);
    const ry = round9(y);
    const key = `${rx}|${ry}`;
    const hit = evaluated.get(key);
    if (hit) return hit;
    const f = evaluateUnblockPosition(scene, singerId, { x: rx, y: ry });
    const point: EvaluatedPoint = {
      x: rx,
      y: ry,
      distance: Math.hypot(rx - me.x, ry - me.y),
      feasible: f.feasible,
      violations: f.violations,
    };
    evaluated.set(key, point);
    return point;
  };

  // 单轴采样：边界 + 等距网格（含最靠近另一端边界的点）+（若在范围内）当前坐标
  const axisPoints = (min: number, max: number, center: number): number[] => {
    const set = new Set<number>();
    const add = (v: number) => set.add(round9(v < min ? min : v > max ? max : v));
    add(min);
    add(max);
    if (center >= min - TANGENT_EPS && center <= max + TANGENT_EPS) add(center);
    const span = max - min;
    const n = Math.ceil(span / gridStep);
    for (let k = 1; k < n; k++) add(min + (span * k) / n);
    return [...set].sort((a, c) => a - c);
  };

  const xs = axisPoints(b.minX, b.maxX, me.x);
  const ys = axisPoints(b.minY, b.maxY, me.y);

  // 粗采样：舞台内部完整网格；当前实际位置即使越界也额外评估（给出原因）
  for (const x of xs) for (const y of ys) evaluate(x, y);
  evaluate(me.x, me.y);

  const feasiblePoints = [...evaluated.values()].filter((p) => p.feasible);
  feasiblePoints.sort(byDistanceThenXY);
  const alreadyClear = feasiblePoints.some((p) => p.distance <= TANGENT_EPS);

  // 细化：取位移最小的 5 个可行种子，逐轮贪心下降
  const NEIGHBORS = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ] as const;
  const SEED_COUNT = 5;

  const refine = (seed: EvaluatedPoint): EvaluatedPoint => {
    let best = seed;
    let step = gridStep / 2;
    for (let round = 0; round < refineRounds; round++) {
      let improved = true;
      let guard = 0;
      while (improved && guard < 10000) {
        improved = false;
        guard++;
        for (const [gx, gy] of NEIGHBORS) {
          const nx = Math.min(b.maxX, Math.max(b.minX, best.x + gx * step));
          const ny = Math.min(b.maxY, Math.max(b.minY, best.y + gy * step));
          const cand = evaluate(nx, ny);
          // 只在可行点之间下降；改进需超过数值噪声，避免来回抖动
          if (cand.feasible && cand.distance < best.distance - 1e-9) {
            best = cand;
            improved = true;
          }
        }
      }
      step /= 2;
    }
    return best;
  };

  const refined: EvaluatedPoint[] = [];
  for (const seed of feasiblePoints.slice(0, SEED_COUNT)) refined.push(refine(seed));

  // 汇总：细化点 + 粗采样可行点，按 1mm 去重后取位移最小的若干个
  const dedup = new Map<string, EvaluatedPoint>();
  for (const p of [...refined, ...feasiblePoints]) {
    const key = `${round4(p.x)}|${round4(p.y)}`;
    const ex = dedup.get(key);
    if (!ex || byDistanceThenXY(p, ex) < 0) dedup.set(key, p);
  }
  const finalCandidates: UnblockCandidate[] = [...dedup.values()]
    .sort(byDistanceThenXY)
    .slice(0, maxFeasible)
    .map((p) => {
      // 输出坐标保留 0.1mm；若舍入恰好越过容差边界则改用未舍入坐标，保证候选可行
      const rx = round4(p.x);
      const ry = round4(p.y);
      const check = evaluateUnblockPosition(scene, singerId, { x: rx, y: ry });
      const x = check.feasible ? rx : p.x;
      const y = check.feasible ? ry : p.y;
      return { x, y, distance: Math.hypot(x - me.x, y - me.y) };
    });

  const infeasibleSamples: InfeasibleSample[] = [...evaluated.values()]
    .filter((p) => !p.feasible)
    .sort(byDistanceThenXY)
    .slice(0, maxInfeasible)
    .map((p) => ({ x: p.x, y: p.y, distance: p.distance, violations: p.violations }));

  return {
    singerId,
    candidates: finalCandidates,
    infeasibleSamples,
    sampledCount: evaluated.size,
    feasibleCount: [...evaluated.values()].filter((p) => p.feasible).length,
    alreadyClear,
  };
}

// ---------------------------------------------------------------------------
// 场景校验 / 规范化（导入 JSON 与后端 API 共用）
// ---------------------------------------------------------------------------

export const LIMITS = {
  maxSingers: 500,
  minRadius: 0.05,
  maxRadius: 1.5,
  minStage: 2,
  maxStageWidth: 40,
  maxStageDepth: 30,
  coordAbsMax: 100,
} as const;

export type ValidateResult = { ok: true; scene: Scene } | { ok: false; errors: string[] };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 校验并规范化未知输入为 Scene；失败时返回全部错误信息。 */
export function validateScene(raw: unknown): ValidateResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['场景必须是一个 JSON 对象'] };
  }
  const obj = raw as Record<string, unknown>;

  // stage
  const stageRaw = obj.stage as Record<string, unknown> | undefined;
  let stage = { width: 12, depth: 8 };
  if (typeof stageRaw !== 'object' || stageRaw === null) {
    errors.push('缺少 stage 对象（{ width, depth }）');
  } else if (!isFiniteNumber(stageRaw.width) || !isFiniteNumber(stageRaw.depth)) {
    errors.push('stage.width / stage.depth 必须是有限数字');
  } else if (
    stageRaw.width < LIMITS.minStage ||
    stageRaw.width > LIMITS.maxStageWidth ||
    stageRaw.depth < LIMITS.minStage ||
    stageRaw.depth > LIMITS.maxStageDepth
  ) {
    errors.push(
      `舞台尺寸超出范围：宽 ${LIMITS.minStage}~${LIMITS.maxStageWidth} m，深 ${LIMITS.minStage}~${LIMITS.maxStageDepth} m`,
    );
  } else {
    stage = { width: stageRaw.width, depth: stageRaw.depth };
  }

  // conductor
  const condRaw = obj.conductor as Record<string, unknown> | undefined;
  let conductor: Vec = { x: stage.width / 2, y: -1.5 };
  if (typeof condRaw !== 'object' || condRaw === null) {
    errors.push('缺少 conductor 对象（{ x, y }）');
  } else if (!isFiniteNumber(condRaw.x) || !isFiniteNumber(condRaw.y)) {
    errors.push('conductor.x / conductor.y 必须是有限数字');
  } else if (Math.abs(condRaw.x) > LIMITS.coordAbsMax || Math.abs(condRaw.y) > LIMITS.coordAbsMax) {
    errors.push('指挥坐标超出允许范围');
  } else {
    conductor = { x: condRaw.x, y: condRaw.y };
  }

  // singers
  const singersRaw = obj.singers;
  const singers: Singer[] = [];
  if (!Array.isArray(singersRaw)) {
    errors.push('缺少 singers 数组');
  } else if (singersRaw.length > LIMITS.maxSingers) {
    errors.push(`演唱者数量超过上限 ${LIMITS.maxSingers}`);
  } else {
    const seenIds = new Set<string>();
    singersRaw.forEach((item, i) => {
      const prefix = `singers[${i}]`;
      if (typeof item !== 'object' || item === null) {
        errors.push(`${prefix} 必须是对象`);
        return;
      }
      const s = item as Record<string, unknown>;
      const id = typeof s.id === 'string' && s.id.length > 0 ? s.id : `s${i + 1}`;
      if (seenIds.has(id)) {
        errors.push(`${prefix}.id 重复：${id}`);
        return;
      }
      seenIds.add(id);
      const name = typeof s.name === 'string' && s.name.length > 0 ? s.name : id.toUpperCase();
      if (!isFiniteNumber(s.x) || !isFiniteNumber(s.y)) {
        errors.push(`${prefix}.x / .y 必须是有限数字`);
        return;
      }
      if (Math.abs(s.x) > LIMITS.coordAbsMax || Math.abs(s.y) > LIMITS.coordAbsMax) {
        errors.push(`${prefix} 坐标超出允许范围`);
        return;
      }
      if (!isFiniteNumber(s.radius) || s.radius < LIMITS.minRadius || s.radius > LIMITS.maxRadius) {
        errors.push(`${prefix}.radius 必须在 ${LIMITS.minRadius}~${LIMITS.maxRadius} m 之间`);
        return;
      }
      singers.push({ id, name, x: s.x, y: s.y, radius: s.radius });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scene: { version: 1, stage, conductor, singers } };
}

/** 序列化为可导入/导出的 JSON 字符串。 */
export function serializeScene(scene: Scene): string {
  return JSON.stringify(scene, null, 2);
}
