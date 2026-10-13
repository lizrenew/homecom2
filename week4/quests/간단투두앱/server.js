const express = require('express');
const path = require('path');
const crypto = require('crypto');

// ── App init & config ────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const MAX_TEXT_LENGTH = 200;

// ── In-memory store ──────────────────────────
// 재시작(또는 서버리스 cold start) 시 초기화된다.
const now = Date.now();
let todos = [
  { id: crypto.randomUUID(), text: '장보기: 우유랑 계란 사기', done: false, createdAt: new Date(now - 60000).toISOString() },
  { id: crypto.randomUUID(), text: '저녁에 30분 산책하기', done: true, createdAt: new Date(now).toISOString() },
];

function validateText(text) {
  if (typeof text !== 'string' || text.trim() === '') return '할 일 내용을 입력해주세요.';
  if (text.trim().length > MAX_TEXT_LENGTH) return `할 일은 ${MAX_TEXT_LENGTH}자 이하로 입력해주세요.`;
  return null;
}

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── API routes ───────────────────────────────
// GET: 최신순 목록
app.get('/api/todos', (_req, res) => {
  try {
    const data = [...todos].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '목록을 불러오지 못했습니다.' });
  }
});

// POST: 생성
app.post('/api/todos', (req, res) => {
  try {
    const { text } = req.body || {};
    const error = validateText(text);
    if (error) return res.status(400).json({ success: false, message: error });

    const todo = { id: crypto.randomUUID(), text: text.trim(), done: false, createdAt: new Date().toISOString() };
    todos.push(todo);
    res.status(201).json({ success: true, data: todo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '할 일을 추가하지 못했습니다.' });
  }
});

// PATCH: 수정 (text, done 중 일부)
app.patch('/api/todos/:id', (req, res) => {
  try {
    const todo = todos.find((t) => t.id === req.params.id);
    if (!todo) return res.status(404).json({ success: false, message: '할 일을 찾을 수 없습니다.' });

    const { text, done } = req.body || {};
    if (text === undefined && done === undefined) {
      return res.status(400).json({ success: false, message: 'text 또는 done 중 하나는 필요합니다.' });
    }
    if (text !== undefined) {
      const error = validateText(text);
      if (error) return res.status(400).json({ success: false, message: error });
    }
    if (done !== undefined && typeof done !== 'boolean') {
      return res.status(400).json({ success: false, message: 'done은 true/false 값이어야 합니다.' });
    }

    if (text !== undefined) todo.text = text.trim();
    if (done !== undefined) todo.done = done;
    res.json({ success: true, data: todo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '할 일을 수정하지 못했습니다.' });
  }
});

// DELETE: 완료 항목 일괄 삭제 (?done=true)
app.delete('/api/todos', (req, res) => {
  try {
    if (req.query.done !== 'true') {
      return res.status(400).json({ success: false, message: '?done=true 쿼리가 필요합니다.' });
    }
    const before = todos.length;
    todos = todos.filter((t) => !t.done);
    res.json({ success: true, data: { removed: before - todos.length } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '완료 항목을 삭제하지 못했습니다.' });
  }
});

// DELETE: 단건 삭제
app.delete('/api/todos/:id', (req, res) => {
  try {
    const index = todos.findIndex((t) => t.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: '할 일을 찾을 수 없습니다.' });
    const [removed] = todos.splice(index, 1);
    res.json({ success: true, data: { id: removed.id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '할 일을 삭제하지 못했습니다.' });
  }
});

// 알 수 없는 API 경로는 JSON 404
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'API 경로를 찾을 수 없습니다.' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) res.status(404).send('index.html not found');
  });
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '잘못된 JSON 형식입니다.' });
  }
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Startup & export ─────────────────────────
// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
