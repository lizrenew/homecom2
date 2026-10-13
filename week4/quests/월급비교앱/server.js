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

// ── Domain constants (클라이언트는 /api/meta 로 받아간다) ──
const JOBS = [
  '개발', '디자인', '기획/PM', '마케팅', '영업', '경영/사무', '재무/회계',
  '인사/HR', '생산/제조', '의료/보건', '교육', '공무원', '서비스', '기타',
];

// 금액 단위는 모두 '만원/월'
const CATEGORIES = [
  { key: 'housing', label: '주거·관리비' },
  { key: 'food', label: '식비' },
  { key: 'transport', label: '교통' },
  { key: 'telecom', label: '통신·구독' },
  { key: 'shopping', label: '쇼핑·생활' },
  { key: 'leisure', label: '여가·문화' },
  { key: 'etc', label: '기타' },
];

const YEAR_BANDS = [
  { key: '0', label: '신입(1년 미만)', min: 0, max: 0 },
  { key: '1-3', label: '1~3년차', min: 1, max: 3 },
  { key: '4-6', label: '4~6년차', min: 4, max: 6 },
  { key: '7-9', label: '7~9년차', min: 7, max: 9 },
  { key: '10+', label: '10년차 이상', min: 10, max: 50 },
];

// 분포 구간: <150, 150~200, …, 650~700, 700+ (50만원 간격, 13칸)
const HIST_START = 150;
const HIST_STEP = 50;
const HIST_BINS = 13;

const SALARY_MAX = 10_000; // 월 1억
const SPEND_MAX = 10_000;
const YEARS_MAX = 50;
// 익명성 보호: 표본이 이보다 적은 그룹은 평균을 공개하지 않는다
const MIN_GROUP = 3;

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
// 개인 식별이 가능한 값(IP, 쿠키, 정확한 시각 등)은 저장하지 않는다. 날짜만 남긴다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  if (!DATABASE_URL) throw new HttpError(500, 'DATABASE_URL 환경변수가 설정되지 않았어요');
  const spendCols = CATEGORIES.map((c) => `spend_${c.key} INT NOT NULL DEFAULT 0`).join(',\n      ');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salary_entries (
      id SERIAL PRIMARY KEY,
      job TEXT NOT NULL,
      years INT NOT NULL,
      salary INT NOT NULL,
      ${spendCols},
      spend_total INT NOT NULL,
      created_on DATE NOT NULL DEFAULT CURRENT_DATE
    );
  `);
  dbInitialized = true;
}

// ── Helpers ──────────────────────────────────
function toInt(raw, { min, max, name }) {
  const n = Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name}은(는) ${min.toLocaleString()}~${max.toLocaleString()} 사이의 정수로 입력해주세요`);
  }
  return n;
}

function validateJob(job) {
  if (!JOBS.includes(job)) throw new HttpError(400, '직군을 목록에서 선택해주세요');
  return job;
}

function bandOf(years) {
  return YEAR_BANDS.find((b) => years >= b.min && years <= b.max);
}

function validateEntry(body) {
  const { job, years, salary, spending = {} } = body || {};
  const entry = {
    job: validateJob(job),
    years: toInt(years, { min: 0, max: YEARS_MAX, name: '연차' }),
    salary: toInt(salary, { min: 1, max: SALARY_MAX, name: '월급' }),
    spending: {},
  };
  if (typeof spending !== 'object' || spending === null) throw new HttpError(400, '지출 형식이 올바르지 않아요');
  for (const c of CATEGORIES) {
    entry.spending[c.key] = toInt(spending[c.key] ?? 0, { min: 0, max: SPEND_MAX, name: `${c.label} 지출` });
  }
  entry.spendTotal = Object.values(entry.spending).reduce((a, b) => a + b, 0);
  if (entry.spendTotal > SPEND_MAX) throw new HttpError(400, `월 지출 합계는 ${SPEND_MAX.toLocaleString()}만원 이하로 입력해주세요`);
  return entry;
}

const round1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

// 상위 % = (나보다 큰 사람 수 + 1) / 전체 × 100  (내 값이 이미 저장돼 있다는 전제)
function topPercent(higher, total) {
  if (!total) return null;
  return Math.max(0.1, round1(((higher + 1) / total) * 100));
}

const catAvgSql = CATEGORIES.map((c) => `AVG(spend_${c.key}) AS ${c.key}`).join(', ');
function mapCategoryRow(row) {
  return Object.fromEntries(CATEGORIES.map((c) => [c.key, round1(row[c.key])]));
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

// ── API: meta ────────────────────────────────
app.get('/api/meta', (_req, res) => {
  res.json({
    success: true,
    data: { jobs: JOBS, categories: CATEGORIES, yearBands: YEAR_BANDS, minGroup: MIN_GROUP },
  });
});

// ── API: stats ───────────────────────────────
// 쿼리: ?job=&years=&salary=&spend=  (모두 선택. 넘기면 '내 위치'와 '내 그룹' 통계를 함께 돌려준다)
app.get('/api/stats', wrap(async (req, res) => {
  const q = req.query;
  const job = q.job ? validateJob(q.job) : null;
  const years = q.years !== undefined && q.years !== '' ? toInt(q.years, { min: 0, max: YEARS_MAX, name: '연차' }) : null;
  const salary = q.salary !== undefined && q.salary !== '' ? toInt(q.salary, { min: 1, max: SALARY_MAX, name: '월급' }) : null;
  const spend = q.spend !== undefined && q.spend !== '' ? toInt(q.spend, { min: 0, max: SPEND_MAX, name: '월 지출' }) : null;
  const band = years !== null ? bandOf(years) : null;

  const [overallQ, histQ, catQ, byJobQ] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS count,
             AVG(salary) AS avg_salary,
             AVG(spend_total) AS avg_spend,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY salary) AS median_salary,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY spend_total) AS median_spend
      FROM salary_entries`),
    pool.query(`
      SELECT LEAST(GREATEST(FLOOR((salary - $1) / $2::numeric) + 1, 0), $3::int - 1)::int AS bin,
             COUNT(*)::int AS count
      FROM salary_entries GROUP BY bin`, [HIST_START, HIST_STEP, HIST_BINS]),
    pool.query(`SELECT ${catAvgSql} FROM salary_entries`),
    pool.query(`
      SELECT job, COUNT(*)::int AS count, AVG(salary) AS avg_salary, AVG(spend_total) AS avg_spend
      FROM salary_entries GROUP BY job`),
  ]);

  const o = overallQ.rows[0];
  const histCounts = new Map(histQ.rows.map((r) => [r.bin, r.count]));
  const histogram = Array.from({ length: HIST_BINS }, (_, i) => {
    const min = i === 0 ? null : HIST_START + HIST_STEP * (i - 1);
    const max = i === HIST_BINS - 1 ? null : HIST_START + HIST_STEP * i;
    const label = min === null ? `${max} 미만` : max === null ? `${min} 이상` : `${min}~${max}`;
    return { bin: i, min, max, label, count: histCounts.get(i) || 0 };
  });

  const data = {
    overall: {
      count: o.count,
      avgSalary: round1(o.avg_salary),
      avgSpend: round1(o.avg_spend),
      medianSalary: round1(o.median_salary),
      medianSpend: round1(o.median_spend),
    },
    histogram,
    categories: { overall: o.count ? mapCategoryRow(catQ.rows[0]) : null, job: null },
    // 공개 그룹은 평균 월급 순, 비공개 그룹은 뒤에 인원 순 (정렬로 비공개 평균이 새지 않게)
    byJob: byJobQ.rows
      .map((r) => {
        const open = r.count >= MIN_GROUP;
        return {
          job: r.job,
          count: r.count,
          avgSalary: open ? round1(r.avg_salary) : null,
          avgSpend: open ? round1(r.avg_spend) : null,
        };
      })
      .sort((a, b) => (b.avgSalary ?? -1) - (a.avgSalary ?? -1) || b.count - a.count || a.job.localeCompare(b.job)),
    me: null,
  };

  // 내 직군의 카테고리 평균
  if (job) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count, ${catAvgSql} FROM salary_entries WHERE job = $1`, [job]
    );
    data.categories.job = {
      job,
      count: rows[0].count,
      avg: rows[0].count >= MIN_GROUP ? mapCategoryRow(rows[0]) : null,
    };
  }

  // 내 위치 (상위 %)
  if (salary !== null) {
    // 소그룹(MIN_GROUP 미만)은 상위 %만 봐도 다른 사람 값이 짐작되므로 숨긴다
    const rank = async (col, value, where = '', params = []) => {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${col} > $1)::int AS higher
         FROM salary_entries ${where}`, [value, ...params]
      );
      const { total, higher } = rows[0];
      return { total, top: total >= MIN_GROUP ? topPercent(higher, total) : null };
    };
    const [salaryAll, spendAll, salaryJob, salaryGroup] = await Promise.all([
      rank('salary', salary),
      spend !== null ? rank('spend_total', spend) : null,
      job ? rank('salary', salary, 'WHERE job = $2', [job]) : null,
      job && band ? rank('salary', salary, 'WHERE job = $2 AND years BETWEEN $3 AND $4', [job, band.min, band.max]) : null,
    ]);
    data.me = {
      salaryTop: salaryAll.top,
      spendTop: spendAll ? spendAll.top : null,
      salaryTopInJob: salaryJob,
      salaryTopInGroup: salaryGroup ? { ...salaryGroup, band: band.label } : null,
      bin: histogram.find((h) => (h.min === null || salary >= h.min) && (h.max === null || salary < h.max)).bin,
    };
  }

  res.json({ success: true, data });
}));

// ── API: entries (익명 저장) ──────────────────
app.post('/api/entries', wrap(async (req, res) => {
  const e = validateEntry(req.body);
  const cols = ['job', 'years', 'salary', ...CATEGORIES.map((c) => `spend_${c.key}`), 'spend_total'];
  const values = [e.job, e.years, e.salary, ...CATEGORIES.map((c) => e.spending[c.key]), e.spendTotal];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(`INSERT INTO salary_entries (${cols.join(', ')}) VALUES (${placeholders})`, values);
  // id 등 식별자는 돌려주지 않는다 — 저장된 값만 확인용으로 반환
  res.status(201).json({
    success: true,
    data: { job: e.job, years: e.years, salary: e.salary, spending: e.spending, spendTotal: e.spendTotal },
  });
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
  app.listen(PORT, () => console.log(`월급 비교 서버 실행 중 → http://localhost:${PORT}`));
}
module.exports = app;
