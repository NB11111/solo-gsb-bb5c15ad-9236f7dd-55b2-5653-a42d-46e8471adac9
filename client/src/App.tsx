import { useMemo, useRef, useState } from 'react';
import {
  analyzeScene,
  findUnblockCandidates,
  serializeScene,
  validateScene,
  type Analysis,
  type Scene,
  type UnblockCandidate,
} from '../../shared/geometry';
import { PRESETS, defaultScene } from './presets';
import { Stage, CONDUCTOR_ID } from './Stage';
import { Sidebar } from './Sidebar';
import { GraphView } from './GraphView';
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

  const analysis: Analysis = useMemo(() => analyzeScene(scene), [scene]);

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

  return (
    <div className="app">
      <header className="toolbar">
        <h1>合唱视线遮挡检查台</h1>
        <div className="actions">
          <button onClick={addSingerAuto}>＋ 添加演唱者</button>
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
              onSelect={selectId}
              onMoveSinger={moveSinger}
              onMoveConductor={moveConductor}
              onAddSingerAt={addSingerAt}
              onRadiusChange={changeRadius}
              onPreviewCandidate={previewUnblock}
            />
            {selectedId === CONDUCTOR_ID && (
              <div className="conductor-hint">已选中指挥：拖动调整位置，点击空白处取消选择。</div>
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
        />
      </main>
    </div>
  );
}
