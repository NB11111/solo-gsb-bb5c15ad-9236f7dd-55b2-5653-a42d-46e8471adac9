import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeScene, validateScene } from '../../shared/geometry';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'choir-sightline-checker', time: new Date().toISOString() });
});

/**
 * 服务端视线分析：与前端共用 shared/geometry，保证判定结果一致。
 * 请求体为场景 JSON（与导入/导出格式相同）。
 */
app.post('/api/analyze', (req, res) => {
  const v = validateScene(req.body);
  if (!v.ok) {
    res.status(400).json({ ok: false, errors: v.errors });
    return;
  }
  res.json({ ok: true, analysis: analyzeScene(v.scene) });
});

// 生产模式：托管前端构建产物（SPA 回退到 index.html）
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = process.env.CLIENT_DIST ?? path.resolve(here, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(503)
      .send('前端尚未构建：请先运行 npm run build，或使用 npm run dev 启动开发服务器。');
  });
}

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`[server] 合唱视线遮挡检查台已启动: http://localhost:${port}`);
});
