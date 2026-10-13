const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// ── Config (환경변수) ─────────────────────────
// 로컬: .env 파일 (.env.example 참고) / Vercel: 프로젝트 Settings → Environment Variables
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) {}

const env = (key, fallback = '') => (process.env[key] ?? fallback).trim();

const DATABASE_URL = env('DATABASE_URL');
const PORT = env('PORT', '3000');

if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL 환경변수가 없어요. .env.example 을 .env 로 복사해 값을 넣어주세요.');

const app = express();

// ── Domain constants (index.html 의 CATEGORIES 와 같은 값) ──
const TYPES = ['income', 'expense'];
const CATEGORIES = {
  expense: ['식비', '교통', '주거', '구독료', '경조사', '쇼핑', '의료/건강', '기타'],
  income: ['월급', '부수입', '용돈', '이자'],
};
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Seed data (프로토타입의 가짜 데이터 → 테이블이 비어 있을 때 한 번만 넣는다) ──
const SEED_TRANSACTIONS = [
  // 10월 (10건)
  ['income', '2026-10-10', 3200000, '월급', '10월 월급'],
  ['expense', '2026-10-01', 650000, '주거', '월세'],
  ['expense', '2026-10-02', 17000, '구독료', '넷플릭스 프리미엄'],
  ['expense', '2026-10-03', 12500, '식비', '점심 김치찌개'],
  ['expense', '2026-10-04', 62000, '교통', '교통카드 충전'],
  ['expense', '2026-10-05', 100000, '경조사', '친구 결혼식 축의금'],
  ['expense', '2026-10-06', 48300, '식비', '이마트 장보기'],
  ['income', '2026-10-07', 150000, '부수입', '블로그 원고료'],
  ['expense', '2026-10-08', 39000, '쇼핑', '니트 가디건'],
  ['expense', '2026-10-12', 29000, '구독료', 'ChatGPT Plus'],
  // 9월 (4건)
  ['income', '2026-09-10', 3200000, '월급', '9월 월급'],
  ['expense', '2026-09-01', 650000, '주거', '월세'],
  ['expense', '2026-09-14', 300000, '경조사', '추석 부모님 용돈'],
  ['expense', '2026-09-18', 184000, '식비', '추석 장보기'],
  // 8월 (3건) — 월별 차트용
  ['income', '2026-08-10', 3200000, '월급', '8월 월급'],
  ['expense', '2026-08-01', 650000, '주거', '월세'],
  ['expense', '2026-08-05', 412000, '쇼핑', '여름 휴가 준비'],
  // 7월 (3건) — 월별 차트용
  ['income', '2026-07-10', 3200000, '월급', '7월 월급'],
  ['expense', '2026-07-01', 650000, '주거', '월세'],
  ['expense', '2026-07-12', 312000, '식비', '7월 식비'],
];

// 카테고리별 월 예산 (원)
const SEED_BUDGETS = [
  ['식비', 400000], ['교통', 80000], ['주거', 750000], ['구독료', 60000],
  ['경조사', 150000], ['쇼핑', 100000], ['의료/건강', 50000], ['기타', 30000],
];

// ── DB (Supabase Postgres) ───────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

let dbInitPromise = null;
function initDB() {
  // 서버리스 cold start 마다 불릴 수 있어 Promise 로 한 번만 실행한다
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ledger_transactions (
          id         SERIAL PRIMARY KEY,
          type       TEXT NOT NULL CHECK (type IN ('income', 'expense')),
          category   TEXT NOT NULL,
          amount     INTEGER NOT NULL CHECK (amount > 0),
          memo       TEXT NOT NULL DEFAULT '',
          date       DATE NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS ledger_transactions_date_idx ON ledger_transactions (date);
        CREATE TABLE IF NOT EXISTS ledger_budgets (
          category TEXT PRIMARY KEY,
          amount   INTEGER NOT NULL CHECK (amount >= 0)
        );
      `);

      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM ledger_transactions');
      if (rows[0].n === 0) {
        const values = SEED_TRANSACTIONS.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(',');
        await pool.query(`INSERT INTO ledger_transactions (type, date, amount, category, memo) VALUES ${values}`, SEED_TRANSACTIONS.flat());
        console.log(`🌱 ledger_transactions 에 시드 ${SEED_TRANSACTIONS.length}건을 넣었어요`);
      }
      const budgetValues = SEED_BUDGETS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',');
      await pool.query(`INSERT INTO ledger_budgets (category, amount) VALUES ${budgetValues} ON CONFLICT (category) DO NOTHING`, SEED_BUDGETS.flat());
    })().catch(err => { dbInitPromise = null; throw err; });
  }
  return dbInitPromise;
}

// date 컬럼은 문자열로 꺼내 타임존 밀림을 피한다
const TX_COLUMNS = `id, type, category, amount, memo, to_char(date, 'YYYY-MM-DD') AS date`;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const currentMonth = () => new Date().toISOString().slice(0, 7);
function parseMonth(value) {
  const month = (value || currentMonth()).toString();
  if (!MONTH_RE.test(month)) throw new HttpError(400, 'month 는 YYYY-MM 형식이어야 해요');
  return month;
}
// 'YYYY-MM' → [그 달 1일, 다음 달 1일)
const monthRange = (month) => {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${month}-01`, `${next}-01`];
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Middleware ───────────────────────────────
app.use(express.json());
// 정적 파일은 index.html 하나뿐이라 express.static 대신 SPA fallback 으로만 서빙한다
// (server.js·.env 같은 파일이 브라우저로 노출되지 않게)

app.use('/api', wrap(async (_req, _res, next) => {
  if (!DATABASE_URL) throw new HttpError(500, 'DATABASE_URL 환경변수가 설정되지 않았어요');
  await initDB();
  next();
}));

// ── API: 조회 (GET) ──────────────────────────
// 내역 목록: ?month=YYYY-MM&type=&category=&q=
app.get('/api/transactions', wrap(async (req, res) => {
  const [from, to] = monthRange(parseMonth(req.query.month));
  const where = ['date >= $1', 'date < $2'];
  const params = [from, to];
  if (TYPES.includes(req.query.type)) { params.push(req.query.type); where.push(`type = $${params.length}`); }
  if (req.query.category) { params.push(String(req.query.category)); where.push(`category = $${params.length}`); }
  if (req.query.q) { params.push(`%${String(req.query.q)}%`); where.push(`(memo ILIKE $${params.length} OR category ILIKE $${params.length})`); }
  const { rows } = await pool.query(
    `SELECT ${TX_COLUMNS} FROM ledger_transactions WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC`, params);
  res.json({ success: true, data: rows });
}));

// 월 요약 + 카테고리별 합계 (GROUP BY)
app.get('/api/summary', wrap(async (req, res) => {
  const [from, to] = monthRange(parseMonth(req.query.month));
  const { rows } = await pool.query(`
    SELECT type, category, SUM(amount)::float8 AS total, COUNT(*)::int AS count
    FROM ledger_transactions
    WHERE date >= $1 AND date < $2
    GROUP BY type, category
    ORDER BY total DESC`, [from, to]);
  const sumOf = (type) => rows.filter(r => r.type === type).reduce((s, r) => s + r.total, 0);
  res.json({
    success: true,
    data: {
      income: sumOf('income'),
      expense: sumOf('expense'),
      incomeCount: rows.filter(r => r.type === 'income').reduce((s, r) => s + r.count, 0),
      expenseCount: rows.filter(r => r.type === 'expense').reduce((s, r) => s + r.count, 0),
      byCategory: rows,
    },
  });
}));

// 월별 수입·지출 추이 (기준 달 포함 최근 N개월, GROUP BY 월)
app.get('/api/monthly', wrap(async (req, res) => {
  const month = parseMonth(req.query.month);
  const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);
  const { rows } = await pool.query(`
    WITH m AS (
      SELECT to_char(d, 'YYYY-MM') AS month
      FROM generate_series(($1 || '-01')::date - make_interval(months => $2 - 1), ($1 || '-01')::date, interval '1 month') AS d
    )
    SELECT m.month,
           COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'income'), 0)::float8  AS income,
           COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense'), 0)::float8 AS expense
    FROM m
    LEFT JOIN ledger_transactions t ON to_char(t.date, 'YYYY-MM') = m.month
    GROUP BY m.month
    ORDER BY m.month`, [month, months]);
  res.json({ success: true, data: rows });
}));

// 예산 대비 사용량 (카테고리별 예산 + 해당 월 지출 합계)
app.get('/api/budgets', wrap(async (req, res) => {
  const [from, to] = monthRange(parseMonth(req.query.month));
  const { rows } = await pool.query(`
    SELECT b.category, b.amount::float8 AS budget, COALESCE(s.spent, 0)::float8 AS spent
    FROM ledger_budgets b
    LEFT JOIN (
      SELECT category, SUM(amount) AS spent
      FROM ledger_transactions
      WHERE type = 'expense' AND date >= $1 AND date < $2
      GROUP BY category
    ) s ON s.category = b.category`, [from, to]);
  const order = CATEGORIES.expense;
  rows.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  res.json({ success: true, data: rows });
}));

// ── API: 생성 (POST) ─────────────────────────
app.post('/api/transactions', wrap(async (req, res) => {
  const { type, category, date } = req.body || {};
  const amount = Number(req.body?.amount);
  const memo = String(req.body?.memo ?? '').trim().slice(0, 100);
  if (!TYPES.includes(type)) throw new HttpError(400, 'type 은 income 또는 expense 여야 해요');
  if (!CATEGORIES[type].includes(category)) throw new HttpError(400, `${type === 'income' ? '수입' : '지출'} 카테고리가 올바르지 않아요`);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 2_000_000_000) throw new HttpError(400, '금액은 0보다 큰 정수여야 해요');
  if (!DATE_RE.test(date || '') || Number.isNaN(Date.parse(date))) throw new HttpError(400, '날짜는 YYYY-MM-DD 형식이어야 해요');

  const { rows } = await pool.query(
    `INSERT INTO ledger_transactions (type, category, amount, memo, date) VALUES ($1, $2, $3, $4, $5) RETURNING ${TX_COLUMNS}`,
    [type, category, amount, memo, date]);
  res.status(201).json({ success: true, data: rows[0] });
}));

// ── API: 수정 (PUT) ──────────────────────────
app.put('/api/budgets/:category', wrap(async (req, res) => {
  const { category } = req.params;
  const amount = Number(req.body?.amount);
  if (!CATEGORIES.expense.includes(category)) throw new HttpError(400, '지출 카테고리가 올바르지 않아요');
  if (!Number.isInteger(amount) || amount < 0 || amount > 2_000_000_000) throw new HttpError(400, '예산은 0 이상의 정수여야 해요');
  const { rows } = await pool.query(
    `INSERT INTO ledger_budgets (category, amount) VALUES ($1, $2)
     ON CONFLICT (category) DO UPDATE SET amount = EXCLUDED.amount
     RETURNING category, amount::float8 AS budget`, [category, amount]);
  res.json({ success: true, data: rows[0] });
}));

// ── API: 삭제 (DELETE) ───────────────────────
app.delete('/api/transactions/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id 가 올바르지 않아요');
  const { rowCount } = await pool.query('DELETE FROM ledger_transactions WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, '내역을 찾을 수 없어요');
  res.json({ success: true, data: { id } });
}));

// ── API 404 ──────────────────────────────────
app.use('/api', (_req, res) => res.status(404).json({ success: false, message: 'API not found' }));

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: '요청 본문이 올바른 JSON 이 아니에요' });
  console.error(err);
  res.status(500).json({ success: false, message: '서버 오류가 발생했어요' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`💰 가계부 서버 실행 중: http://localhost:${PORT}`));
}
module.exports = app;
