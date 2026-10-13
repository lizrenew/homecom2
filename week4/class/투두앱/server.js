const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// 로컬: .env 에서 DATABASE_URL 로드 / Vercel: 프로젝트 환경변수 사용
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// ── DB lazy init ─────────────────────────────
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  dbInitialized = true;
}

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Database initialization failed' });
  }
});

// ── API routes ───────────────────────────────
app.get('/api/todos', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM todos ORDER BY done ASC, created_at DESC');
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

app.post('/api/todos', async (req, res, next) => {
  try {
    const title = (req.body?.title || '').trim();
    if (!title) return res.status(400).json({ success: false, message: '할 일을 입력해주세요' });
    if (title.length > 200) return res.status(400).json({ success: false, message: '200자 이하로 입력해주세요' });
    const { rows } = await pool.query('INSERT INTO todos (title) VALUES ($1) RETURNING *', [title]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

app.patch('/api/todos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const { title, done } = req.body || {};
    if (title !== undefined && !String(title).trim()) {
      return res.status(400).json({ success: false, message: '할 일을 입력해주세요' });
    }
    if (done !== undefined && typeof done !== 'boolean') {
      return res.status(400).json({ success: false, message: 'done must be boolean' });
    }
    const { rows } = await pool.query(
      `UPDATE todos SET title = COALESCE($1, title), done = COALESCE($2, done)
       WHERE id = $3 RETURNING *`,
      [title === undefined ? null : String(title).trim(), done === undefined ? null : done, id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Todo not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

app.delete('/api/todos/completed', async (_req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM todos WHERE done = true');
    res.json({ success: true, data: { deleted: rowCount } });
  } catch (err) { next(err); }
});

app.delete('/api/todos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const { rowCount } = await pool.query('DELETE FROM todos WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Todo not found' });
    res.json({ success: true, data: { id } });
  } catch (err) { next(err); }
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
