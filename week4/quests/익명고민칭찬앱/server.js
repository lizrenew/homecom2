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

// ── Domain constants ─────────────────────────
const CATEGORIES = ['worry', 'praise']; // 고민, 칭찬
const SORTS = {
  latest: 'created_at DESC, id DESC',
  likes: 'likes DESC, created_at DESC, id DESC',
};
const CONTENT_MAX = 1000;
const PAGE_LIMIT = 100;

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
// 익명 게시판: 작성자 식별 정보(IP, 쿠키 등)는 저장하지 않는다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  if (!DATABASE_URL) throw new HttpError(500, 'DATABASE_URL 환경변수가 설정되지 않았어요');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('worry', 'praise')),
      content TEXT NOT NULL,
      likes INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS posts_likes_idx ON posts (likes DESC, created_at DESC);
  `);
  dbInitialized = true;
}

// ── Helpers ──────────────────────────────────
function validateCategory(category) {
  if (!CATEGORIES.includes(category)) throw new HttpError(400, '카테고리는 고민 또는 칭찬 중에서 골라주세요');
  return category;
}

function validateContent(content) {
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, '내용을 입력해주세요');
  const text = content.trim();
  if (text.length > CONTENT_MAX) throw new HttpError(400, `내용은 ${CONTENT_MAX}자 이하로 입력해주세요`);
  return text;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, '잘못된 글 번호예요');
  return id;
}

const toPost = (r) => ({
  id: r.id,
  category: r.category,
  content: r.content,
  likes: r.likes,
  createdAt: r.created_at,
});

// 라우트 핸들러의 async 에러를 에러 미들웨어로 넘긴다
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.use('/api', wrap(async (_req, _res, next) => {
  await initDB();
  next();
}));

// ── API: posts ───────────────────────────────
// 쿼리: ?sort=latest|likes  &category=worry|praise (생략 시 전체)
app.get('/api/posts', wrap(async (req, res) => {
  const sort = SORTS[req.query.sort] ? req.query.sort : 'latest';
  const category = req.query.category ? validateCategory(req.query.category) : null;

  const where = category ? 'WHERE category = $2' : '';
  const params = category ? [PAGE_LIMIT, category] : [PAGE_LIMIT];
  const [list, counts] = await Promise.all([
    pool.query(`SELECT * FROM posts ${where} ORDER BY ${SORTS[sort]} LIMIT $1`, params),
    pool.query('SELECT category, COUNT(*)::int AS count FROM posts GROUP BY category'),
  ]);

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const r of counts.rows) byCategory[r.category] = r.count;

  res.json({
    success: true,
    data: {
      posts: list.rows.map(toPost),
      counts: { all: byCategory.worry + byCategory.praise, ...byCategory },
    },
  });
}));

app.post('/api/posts', wrap(async (req, res) => {
  const { category, content } = req.body || {};
  const { rows } = await pool.query(
    'INSERT INTO posts (category, content) VALUES ($1, $2) RETURNING *',
    [validateCategory(category), validateContent(content)]
  );
  res.status(201).json({ success: true, data: toPost(rows[0]) });
}));

// 공감 +1 (원자적 UPDATE — 동시에 눌려도 숫자가 유실되지 않는다)
app.post('/api/posts/:id/like', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE posts SET likes = likes + 1 WHERE id = $1 RETURNING id, likes',
    [parseId(req.params.id)]
  );
  if (!rows.length) throw new HttpError(404, '글을 찾을 수 없어요');
  res.json({ success: true, data: rows[0] });
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
  app.listen(PORT, () => console.log(`익명 고민·칭찬 게시판 실행 중 → http://localhost:${PORT}`));
}
module.exports = app;
