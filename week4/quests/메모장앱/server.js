const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// ── Config (환경변수) ─────────────────────────
// 비밀값은 서버 환경변수로만 읽는다. 클라이언트(index.html)에는 절대 넣지 않는다.
// 로컬: .env 파일 (.env.example 참고) / Vercel: 프로젝트 Settings → Environment Variables
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) {}

const env = (key, fallback = '') => (process.env[key] ?? fallback).trim();

const DATABASE_URL = env('DATABASE_URL');
const PORT = env('PORT', '3000');

if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL 환경변수가 없어요. .env.example 을 .env 로 복사해 값을 넣어주세요.');

const app = express();

const TITLE_MAX = 200;
const CONTENT_MAX = 20_000;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── DB lazy init ─────────────────────────────
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  if (!DATABASE_URL) throw new HttpError(500, 'DATABASE_URL 환경변수가 설정되지 않았어요');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  dbInitialized = true;
}

// ── Helpers ──────────────────────────────────
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '올바르지 않은 메모 ID예요');
  return id;
}

function validateMemo(body) {
  const { title, content = '' } = body || {};
  if (typeof title !== 'string' || !title.trim()) throw new HttpError(400, '제목을 입력해주세요');
  if (typeof content !== 'string') throw new HttpError(400, '내용은 문자열이어야 해요');
  if (title.trim().length > TITLE_MAX) throw new HttpError(400, `제목은 ${TITLE_MAX}자 이하로 입력해주세요`);
  if (content.length > CONTENT_MAX) throw new HttpError(400, `내용은 ${CONTENT_MAX.toLocaleString()}자 이하로 입력해주세요`);
  return { title: title.trim(), content };
}

// 라우트 핸들러의 async 에러를 에러 미들웨어로 넘긴다
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.use('/api', wrap(async (_req, _res, next) => {
  await initDB();
  next();
}));

// ── API: memos ───────────────────────────────
app.get('/api/memos', wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM memos ORDER BY created_at DESC, id DESC');
  res.json({ success: true, data: rows });
}));

app.get('/api/memos/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM memos WHERE id = $1', [parseId(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, '메모를 찾을 수 없어요');
  res.json({ success: true, data: rows[0] });
}));

app.post('/api/memos', wrap(async (req, res) => {
  const { title, content } = validateMemo(req.body);
  const { rows } = await pool.query(
    'INSERT INTO memos (title, content) VALUES ($1, $2) RETURNING *',
    [title, content]
  );
  res.status(201).json({ success: true, data: rows[0] });
}));

app.put('/api/memos/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { title, content } = validateMemo(req.body);
  const { rows } = await pool.query(
    'UPDATE memos SET title = $1, content = $2 WHERE id = $3 RETURNING *',
    [title, content, id]
  );
  if (!rows[0]) throw new HttpError(404, '메모를 찾을 수 없어요');
  res.json({ success: true, data: rows[0] });
}));

app.delete('/api/memos/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM memos WHERE id = $1 RETURNING id', [parseId(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, '메모를 찾을 수 없어요');
  res.json({ success: true, data: { id: rows[0].id } });
}));

app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API예요' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '요청 형식이 올바르지 않아요' });
  }
  console.error(err);
  res.status(500).json({ success: false, message: '서버 오류가 발생했어요' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`메모장 서버 실행 중 → http://localhost:${PORT}`));
}
module.exports = app;
