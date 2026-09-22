import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeScene,
  findUnblockCandidates,
  serializeScene,
  validateScene,
  type Analysis,
  type ConductorHeatmap,
  type Scene,
  type UnblockCandidate,
} from '../../shared/geometry';
import { PRESETS, defaultScene } from './presets';
import { Stage, CONDUCTOR_ID } from './Stage';
import { Sidebar } from './Sidebar';
import { GraphView } from './GraphView';
import type { HeatPreview, HeatStatus } from './HeatmapPanel';
import type { UnblockState } from './UnblockPanel';

interface Notice {
  kind: 'info' | 'error' | 'success';
  text: string;
}

function nextSingerIndex(scene: Scene): number {
  let max = 0;
  for (const s of scene.singers) {
    const m = /^S(\d+)$/i.exec(s.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export default function App() {
  const [scene, setScene] = useState<Scene>(() => defaultScene());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [checking, setChecking] = useState(false);
  // 场景版本号：任何编辑都 +1，用于判定自动解遮挡搜索结果是否过期
  const [sceneVersion, setSceneVersion] = useState(0);
  const [unblock, setUnblock] = useState<UnblockState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- 指挥站位热区模式 ----
  const [heatMode, setHeatMode] = useState(false);
  const [heatmap, setHeatmap] = useState<ConductorHeatmap | null>(null);
  const [heatStatus, setHeatStatus] = useState<HeatStatus>('ready');
  const [heatCellSize, setHeatCellSize] = useState(0.25);
  const [heatPreview, setHeatPreview] = useState<HeatPreview | null>(null);
  const heatSeqRef = useRef(0);

  const analysis: Analysis = useMemo(() => analyzeScene(scene), [scene]);

  // 热区放在 Worker 中计算：场景每一次编辑后立即重算（0.25 m 网格 × 全部视线），
  // 结果按序号比对丢弃过期响应；空场景在主线程直接清空，给出明确提示。
  useEffect(() => {
    if (!heatMode) return;
    if (scene.singers.length === 0) {
      setHeatPreview(null);
      setHeatmap({
        region: { minX: -1, maxX: scene.stage.width + 1, minY: -2.8, maxY: 0 },
        gridStep: 0.25,
        total: 0,
        points: [],
        candidates: [],
        bestScore: 0,
      });
      setHeatStatus('ready');
      return;
    }
    const seq = ++heatSeqRef.current;
    setHeatStatus('computing');
    const worker = new Worker(new URL('./heatmap.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ seq: number; heatmap: ConductorHeatmap }>) => {
      if (e.data.seq !== seq) return;
      setHeatmap(e.data.heatmap);
      setHeatStatus('ready');
      worker.terminate();
    };
    worker.onerror = () => {
      worker.terminate();
      setHeatStatus('ready');
    };
    worker.postMessage({ seq, scene });
    return () => worker.terminate();
  }, [heatMode, scene]);

  const toggleHeatMode = () => {
    // 退出热区模式时收起预览与候选
    if (heatMode) setHeatPreview(null);
    setHeatMode((m) => !m);
  };

  /** 使自动解遮挡结果过期（场景被编辑过，候选不再可信）。 */
  const markSceneChanged = () => {
    setSceneVersion((v) => v + 1);
    setUnblock((u) => (u && u.status === 'done' ? { ...u, status: 'stale' } : u));
  };

  // ---- 场景编辑 ----
  const updateSingers = (fn: (s: Scene['singers']) => Scene['singers']) => {
    setScene((sc) => ({ ...sc, singers: fn(sc.singers) }));
    markSceneChanged();
  };

  const addSingerAt = (x: number, y: number) => {
    const n = nextSingerIndex(scene);
    const id = `s${Date.now().toString(36)}${n}`;
    updateSingers((list) => [...list, { id, name: `S${n}`, x, y, radius: 0.3 }]);
    selectId(id);
  };

  const addSingerAuto = () => {
    // 依次尝试舞台中部空位
    const { width, depth } = scene.stage;
    const candidates = [
      { x: width / 2, y: depth / 2 },
      { x: width / 3, y: depth / 2 },
      { x: (2 * width) / 3, y: depth / 2 },
      { x: width / 2, y: depth / 3 },
      { x: width / 2, y: (2 * depth) / 3 },
    ];
    const spot =
      candidates.find(
        (c) => !scene.singers.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < 0.8),
      ) ?? { x: width / 2, y: depth / 2 };
    addSingerAt(Number(spot.x.toFixed(2)), Number(spot.y.toFixed(2)));
  };

  const moveSinger = (id: string, x: number, y: number) =>
    updateSingers((list) => list.map((s) => (s.id === id ? { ...s, x, y } : s)));

  const moveConductor = (x: number, y: number) => {
    setScene((sc) => ({ ...sc, conductor: { x, y } }));
    markSceneChanged();
  };

  // ---- 指挥站位热区：应用候选（仅此时才真正移动指挥）----
  const applyHeatPoint = (p: { x: number; y: number; clear?: number; tangent?: number; blocked?: number; degenerate?: number }) => {
    moveConductor(Number(p.x.toFixed(3)), Number(p.y.toFixed(3)));
    setHeatPreview(null);
    const detail =
      p.clear !== undefined
        ? `通畅 ${p.clear} / 相切 ${p.tangent} / 遮挡 ${p.blocked}${p.degenerate ? ` / 退化 ${p.degenerate}` : ''}`
        : '热区正在重算';
    setNotice({
      kind: 'success',
      text: `已应用指挥位置 (${p.x.toFixed(2)}, ${p.y.toFixed(2)})：${detail}。`,
    });
  };

  const changeRadius = (id: string, radius: number) =>
    updateSingers((list) => list.map((s) => (s.id === id ? { ...s, radius } : s)));

  const rename = (id: string, name: string) =>
    updateSingers((list) => list.map((s) => (s.id === id ? { ...s, name } : s)));

  const removeSinger = (id: string) => {
    updateSingers((list) => list.filter((s) => s.id !== id));
    setSelectedId((sel) => (sel === id ? null : sel));
    setUnblock((u) => (u && u.singerId === id ? null : u));
  };

  // ---- 自动解遮挡（纯搜索，不修改场景；只有“应用”才移动该演唱者）----
  const runUnblockSearch = () => {
    if (!selectedId || selectedId === CONDUCTOR_ID) return;
    const result = findUnblockCandidates(scene, selectedId);
    setUnblock({
      singerId: selectedId,
      sceneVersion,
      status: 'done',
      result,
      previewIndex: null,
    });
    if (result.error) {
      setNotice({ kind: 'error', text: `自动解遮挡：${result.error}` });
    } else if (result.candidates.length === 0 && !result.alreadyClear) {
      setNotice({
        kind: 'error',
        text: `自动解遮挡：未找到可行方案（已采样 ${result.sampledCount} 个位置，只允许移动当前演唱者）。`,
      });
    } else {
      setNotice({ kind: 'info', text: '自动解遮挡搜索完成，可点击候选预览后应用。' });
    }
  };

  const previewUnblock = (index: number | null) =>
    setUnblock((u) => (u ? { ...u, previewIndex: index } : u));

  const applyUnblock = (candidate: UnblockCandidate) => {
    if (!unblock) return;
    moveSinger(unblock.singerId, candidate.x, candidate.y);
    setUnblock(null);
    setNotice({
      kind: 'success',
      text: `已应用解遮挡位置（位移 ${candidate.distance.toFixed(2)} m），遮挡统计已实时刷新。`,
    });
  };

  const selectId = (id: string | null) => {
    setSelectedId(id);
    // 切换选中对象时收起自动解遮挡面板的预览/结果（结果只对搜索时的演唱者有意义）
    setUnblock((u) => (u && u.singerId !== id ? null : u));
  };

  const loadPreset = (key: string) => {
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setScene(preset.build());
    setSelectedId(null);
    setUnblock(null);
    markSceneChanged();
    setNotice({ kind: 'info', text: `已载入预设：${preset.label}` });
  };

  // ---- 导出 / 导入 ----
  const exportJSON = () => {
    const blob = new Blob([serializeScene(scene)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'choir-scene.json';
    a.click();
    URL.revokeObjectURL(url);
    setNotice({ kind: 'success', text: '已导出场景 JSON 文件。' });
  };

  const importJSON = async (file: File) => {
    try {
      const text = await file.text();
      const raw: unknown = JSON.parse(text);
      const v = validateScene(raw);
      if (!v.ok) {
        setNotice({ kind: 'error', text: `导入失败：${v.errors.join('；')}` });
        return;
      }
      setScene(v.scene);
      setSelectedId(null);
      setUnblock(null);
      markSceneChanged();
      setNotice({ kind: 'success', text: `导入成功：${v.scene.singers.length} 名演唱者。` });
    } catch (err) {
      setNotice({ kind: 'error', text: `导入失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---- 服务器校验（POST /api/analyze，与本地结果对比）----
  const serverCheck = async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serializeScene(scene),
      });
      const data = (await res.json()) as
        | { ok: true; analysis: Analysis }
        | { ok: false; errors: string[] };
      if (!data.ok) {
        setNotice({ kind: 'error', text: `服务器拒绝场景：${data.errors.join('；')}` });
        return;
      }
      const local = analysis.summary;
      const remote = data.analysis.summary;
      const same =
        local.clear === remote.clear &&
        local.tangent === remote.tangent &&
        local.blocked === remote.blocked &&
        local.degenerate === remote.degenerate &&
        local.total === remote.total;
      setNotice(
        same
          ? { kind: 'success', text: `服务器校验一致 ✓（遮挡 ${remote.blocked} / 相切 ${remote.tangent} / 通畅 ${remote.clear}）` }
          : { kind: 'error', text: `服务器结果不一致：${JSON.stringify(remote)}` },
      );
    } catch {
      setNotice({ kind: 'error', text: '无法连接服务器（开发模式请先启动 server）。' });
    } finally {
      setChecking(false);
    }
  };

  // 预览覆盖：仅渲染用，不改变场景（统计仍按真实场景计算）
  const previewCandidate =
    unblock && unblock.status === 'done' && unblock.previewIndex !== null
      ? (unblock.result?.candidates[unblock.previewIndex] ?? null)
      : null;
  const preview =
    previewCandidate && unblock
      ? {
          singerId: unblock.singerId,
          x: previewCandidate.x,
          y: previewCandidate.y,
          candidates: unblock.status === 'done' ? (unblock.result?.candidates ?? []) : [],
          previewIndex: unblock.previewIndex ?? 0,
        }
      : null;

  // 热区舞台渲染数据（heatMode 且已有热区结果时显示）
  const heatStageProp =
    heatMode && heatmap
      ? {
          heatmap,
          cellSize: heatCellSize,
          preview: heatPreview,
          onPreviewCandidate: setHeatPreview,
        }
      : null;

  return (
    <div className="app">
      <header className="toolbar">
        <h1>合唱视线遮挡检查台</h1>
        <div className="actions">
          <button onClick={addSingerAuto}>＋ 添加演唱者</button>
          <button
            className={heatMode ? 'heat-toggle active' : 'heat-toggle'}
            onClick={toggleHeatMode}
            title="在舞台前方按 0.25 m 网格模拟指挥位置并推荐最佳站位"
          >
            🧭 指挥站位热区
          </button>
          <select defaultValue="" onChange={(e) => e.target.value && loadPreset(e.target.value)}>
            <option value="" disabled>
              载入预设…
            </option>
            {PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          <button onClick={exportJSON}>导出 JSON</button>
          <button onClick={() => fileInputRef.current?.click()}>导入 JSON</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importJSON(f);
              e.target.value = '';
            }}
          />
          <button onClick={() => void serverCheck()} disabled={checking}>
            {checking ? '校验中…' : '服务器校验'}
          </button>
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.kind}`} onClick={() => setNotice(null)}>
          {notice.text}
          <span className="dismiss">✕</span>
        </div>
      )}

      <main className="main">
        <div className="stage-wrap">
          <div className="stage-main">
            <Stage
              scene={scene}
              analysis={analysis}
              selectedId={selectedId}
              preview={preview}
              heat={heatStageProp}
              onSelect={selectId}
              onMoveSinger={moveSinger}
              onMoveConductor={moveConductor}
              onAddSingerAt={addSingerAt}
              onRadiusChange={changeRadius}
              onPreviewCandidate={previewUnblock}
            />
            {selectedId === CONDUCTOR_ID && !heatPreview && (
              <div className="conductor-hint">已选中指挥：拖动调整位置，点击空白处取消选择。</div>
            )}
            {heatPreview && (
              <div className="heat-preview-bar">
                正在预览候选指挥位置 ({heatPreview.x.toFixed(2)}, {heatPreview.y.toFixed(2)}) 的全部视线 ——
                指挥尚未移动，确认后再应用。
                <button
                  className="heat-apply-btn"
                  onClick={() => {
                    if (!heatmap) return;
                    // 优先用候选明细；编辑后预览点掉出前 3 时退回网格点明细
                    const c =
                      heatmap.candidates.find(
                        (q) => Math.abs(q.x - heatPreview.x) < 1e-9 && Math.abs(q.y - heatPreview.y) < 1e-9,
                      ) ??
                      heatmap.points.find(
                        (q) => Math.abs(q.x - heatPreview.x) < 1e-9 && Math.abs(q.y - heatPreview.y) < 1e-9,
                      );
                    if (c) applyHeatPoint(c);
                    else applyHeatPoint(heatPreview);
                  }}
                >
                  ✓ 应用该指挥位置
                </button>
                <button className="link" onClick={() => setHeatPreview(null)}>
                  取消预览
                </button>
              </div>
            )}
            {heatMode && heatStatus === 'computing' && (
              <div className="heat-computing-hint">⏳ 正在重算指挥站位热区…</div>
            )}
          </div>
          <GraphView scene={scene} analysis={analysis} selectedId={selectedId} onSelect={selectId} />
        </div>
        <Sidebar
          scene={scene}
          analysis={analysis}
          selectedId={selectedId}
          onSelect={selectId}
          onRadiusChange={changeRadius}
          onRename={rename}
          onRemove={removeSinger}
          unblock={unblock}
          onUnblockSearch={runUnblockSearch}
          onUnblockPreview={previewUnblock}
          onUnblockApply={applyUnblock}
          heatMode={heatMode}
          heatmap={heatmap}
          heatStatus={heatStatus}
          heatCellSize={heatCellSize}
          onHeatCellSize={setHeatCellSize}
          heatPreview={heatPreview}
          onHeatPreview={setHeatPreview}
          onHeatApply={applyHeatPoint}
          onCloseHeat={toggleHeatMode}
        />
      </main>
    </div>
  );
}
