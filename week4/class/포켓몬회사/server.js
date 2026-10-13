const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// 로컬: .env 에서 DATABASE_URL 로드 / Vercel: 프로젝트 환경변수 사용
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database ─────────────────────────────────
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 5,
});
// 풀러가 유휴 연결을 끊을 때 발생하는 에러로 프로세스가 죽지 않도록 처리
pool.on('error', (err) => console.error('[pg pool]', err.message));

let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(50)   NOT NULL,
      email      VARCHAR(100)  NOT NULL,
      phone      VARCHAR(30),
      category   VARCHAR(20)   NOT NULL,
      message    VARCHAR(2000) NOT NULL,
      created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);
  dbInitialized = true;
}

// ── Middleware ───────────────────────────────
app.use(express.json());
// 서버 소스·설정 파일이 정적 서빙으로 노출되지 않도록 차단
app.use((req, res, next) => {
  if (/\.(txt|js|json)$/i.test(req.path) || /(^|\/)\./.test(req.path)) return res.status(404).end();
  next();
});
app.use(express.static(path.join(__dirname)));

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '데이터베이스 연결에 실패했습니다.' });
  }
});

// ── API routes ───────────────────────────────
app.post('/api/inquiries', async (req, res) => {
  try {
    const { name, email, phone = '', category = '기타', message } = req.body || {};

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: '이름을 입력해주세요.' });
    }
    if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: '올바른 이메일을 입력해주세요.' });
    }
    if (typeof message !== 'string' || message.trim().length < 5) {
      return res.status(400).json({ success: false, message: '문의 내용을 5자 이상 입력해주세요.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO inquiries (name, email, phone, category, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        name.trim().slice(0, 50),
        email.trim().slice(0, 100),
        String(phone).trim().slice(0, 30) || null,
        String(category).trim().slice(0, 20),
        message.trim().slice(0, 2000),
      ]
    );
    res.status(201).json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '문의 저장에 실패했습니다.' });
  }
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

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
