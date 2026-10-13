const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// ── Config (환경변수) ─────────────────────────
// 비밀값은 서버 환경변수로만 읽는다. 클라이언트(index.html)에는 절대 넣지 않는다.
// 로컬: .env 파일 (.env.example 참고) / Vercel: 프로젝트 Settings → Environment Variables
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) {}

const env = (key, fallback = '') => (process.env[key] ?? fallback).trim();

const DATABASE_URL = env('DATABASE_URL');
const OPENAI_API_KEY = env('OPENAI_API_KEY');
const OPENAI_MODEL = env('OPENAI_MODEL', 'gpt-4o-mini');
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const PORT = env('PORT', '3000');
const JWT_SECRET = env('JWT_SECRET');

if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL 환경변수가 없어요. .env.example 을 .env 로 복사해 값을 넣어주세요.');
if (JWT_SECRET.length < 32) console.warn('⚠️  JWT_SECRET 환경변수가 없거나 너무 짧아요(32자 이상). 로그인·회원가입이 비활성화됩니다.');
if (!OPENAI_API_KEY) console.warn('⚠️  OPENAI_API_KEY 환경변수가 없어요. AI 레시피 생성이 비활성화됩니다.');

const app = express();

// ── Domain constants (index.html 의 STORAGES / CATEGORIES 와 같은 값) ──
const STORAGES = ['fridge', 'freezer', 'pantry'];
const CATEGORIES = ['채소', '과일', '육류', '해산물', '유제품·달걀', '양념·소스', '기타'];

const NAME_MAX = 40;
const QTY_MAX = 100_000;

// ── AI 레시피 설정 ───────────────────────────
// 공개 배포 + 유료 API 키라서 하루 생성 수를 DB 기준으로 제한한다 (서버리스라 메모리 카운터는 무의미)
const AI_DAILY_LIMIT = 30;       // 전체 사용자 합계 (API 비용 상한)
const AI_USER_DAILY_LIMIT = 10;  // 사용자 1명당
const AI_REQUEST_MAX = 100;   // 사용자 요청 문구 최대 길이
const AI_PICK_MAX = 15;       // 선택 가능한 재료 수
const AI_COLORS = [
  'from-tomato-50 to-yolk-50', 'from-leaf-50 to-yolk-50', 'from-yolk-50 to-cream',
  'from-yolk-50 to-tomato-50', 'from-tomato-50 to-cream', 'from-cream to-leaf-50',
];

// OpenAI Structured Outputs: 이 스키마를 벗어난 응답은 오지 않는다
const RECIPE_SCHEMA = {
  name: 'recipe',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'emoji', 'time', 'difficulty', 'servings', 'kcal', 'tags', 'ingredients', 'steps'],
    properties: {
      title: { type: 'string', description: '요리 이름 (20자 이내)' },
      emoji: { type: 'string', description: '요리를 나타내는 이모지 1개' },
      time: { type: 'integer', description: '조리 시간(분)' },
      difficulty: { type: 'string', enum: ['쉬움', '보통', '어려움'] },
      servings: { type: 'integer', description: '몇 인분' },
      kcal: { type: 'integer', description: '1인분 대략 칼로리' },
      tags: { type: 'array', items: { type: 'string' }, description: '1~3개, 예: 한식, 초간단, 국물' },
      ingredients: { type: 'array', items: { type: 'string' }, description: '재료 이름만 (수량 없이)' },
      steps: { type: 'array', items: { type: 'string' }, description: '조리 순서, 한 단계당 한 문장' },
    },
  },
};

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
pool.on('error', (err) => console.error('[pg pool]', err.message));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── 인증 설정 ────────────────────────────────
// 토큰: JWT(HS256) 를 Authorization: Bearer 헤더로 주고받는다. 만료되면 다시 로그인.
// 비밀번호: OWASP Password Storage Cheat Sheet 권장값의 scrypt (N=2^17, r=8, p=1) 로 해시한다.
const JWT_EXPIRES_IN = '7d';
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const SCRYPT_KEYLEN = 64;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const EMAIL_MAX = 254;
const scrypt = promisify(crypto.scrypt);

// ── Seed data (회원가입 시 그 사용자의 냉장고에 예시로 넣는다) ──
// expires 는 가입 시점 기준 '며칠 뒤' 로 넣어 임박/지남 예시가 보이게 한다.
// DB 의 CURRENT_DATE 는 UTC 라 한국 오전엔 하루 밀리므로 Asia/Seoul 기준 날짜를 쓴다.
const SEED_INGREDIENTS = [
  ['달걀', '🥚', 6, '개', '유제품·달걀', 'fridge', 9],
  ['우유', '🥛', 1, 'L', '유제품·달걀', 'fridge', 1],
  ['대파', '🌿', 2, '대', '채소', 'fridge', 4],
  ['양파', '🧅', 3, '개', '채소', 'pantry', 20],
  ['두부', '⬜', 1, '모', '기타', 'fridge', 0],
  ['김치', '🥬', 500, 'g', '채소', 'fridge', 30],
  ['돼지고기 앞다리', '🥩', 300, 'g', '육류', 'fridge', 2],
  ['애호박', '🥒', 1, '개', '채소', 'fridge', -1],
  ['냉동 새우', '🦐', 200, 'g', '해산물', 'freezer', 60],
  ['냉동 만두', '🥟', 12, '개', '기타', 'freezer', 45],
  ['사과', '🍎', 4, '개', '과일', 'fridge', 12],
  ['고추장', '🌶️', 1, '통', '양념·소스', 'fridge', 120],
  ['간장', '🫙', 1, '병', '양념·소스', 'pantry', 200],
  ['쌀', '🍚', 2, 'kg', '기타', 'pantry', 90],
  ['체다 치즈', '🧀', 5, '장', '유제품·달걀', 'fridge', 6],
  ['버섯', '🍄', 1, '팩', '채소', 'fridge', 3],
];

const SEED_RECIPES = [
  {
    title: '김치찌개', emoji: '🍲', time: 25, difficulty: '쉬움', servings: 2, kcal: 420,
    color: 'from-tomato-50 to-yolk-50', tags: ['한식', '국물'], favorite: true,
    ingredients: ['김치', '돼지고기 앞다리', '두부', '대파', '양파', '고춧가루'],
    steps: ['돼지고기를 한입 크기로 썰어 냄비에 볶는다.', '김치를 넣고 5분간 함께 볶는다.', '물 500ml를 붓고 끓인다.', '두부·양파를 넣고 10분 더 끓인다.', '대파를 송송 썰어 올리고 마무리.'],
  },
  {
    title: '애호박 두부 된장국', emoji: '🥣', time: 20, difficulty: '쉬움', servings: 2, kcal: 180,
    color: 'from-leaf-50 to-yolk-50', tags: ['한식', '국물', '채식'], favorite: false,
    ingredients: ['애호박', '두부', '양파', '된장', '대파'],
    steps: ['물에 된장을 풀어 끓인다.', '애호박·양파를 반달썰기해 넣는다.', '두부를 깍둑썰기해 넣는다.', '대파를 넣고 한소끔 끓인다.'],
  },
  {
    title: '대파 달걀볶음밥', emoji: '🍳', time: 15, difficulty: '쉬움', servings: 1, kcal: 520,
    color: 'from-yolk-50 to-cream', tags: ['한그릇', '초간단'], favorite: true,
    ingredients: ['달걀', '대파', '쌀', '간장'],
    steps: ['기름에 대파를 볶아 파기름을 낸다.', '달걀을 넣어 스크램블한다.', '밥을 넣고 센 불에 볶는다.', '간장을 팬 가장자리에 둘러 향을 입힌다.'],
  },
  {
    title: '새우 버섯 크림파스타', emoji: '🍝', time: 30, difficulty: '보통', servings: 2, kcal: 680,
    color: 'from-yolk-50 to-tomato-50', tags: ['양식'], favorite: false,
    ingredients: ['냉동 새우', '버섯', '우유', '체다 치즈', '파스타면', '마늘'],
    steps: ['파스타면을 8분간 삶는다.', '마늘·새우·버섯을 볶는다.', '우유와 치즈를 넣어 소스를 만든다.', '면을 넣고 소스와 버무린다.'],
  },
  {
    title: '제육볶음', emoji: '🥘', time: 25, difficulty: '보통', servings: 2, kcal: 610,
    color: 'from-tomato-50 to-cream', tags: ['한식', '밥도둑'], favorite: false,
    ingredients: ['돼지고기 앞다리', '고추장', '양파', '대파', '간장'],
    steps: ['고추장·간장·설탕으로 양념장을 만든다.', '고기를 양념에 15분 재운다.', '양파와 함께 센 불에 볶는다.', '대파를 넣고 마무리.'],
  },
  {
    title: '군만두 & 계란국', emoji: '🥟', time: 15, difficulty: '쉬움', servings: 1, kcal: 450,
    color: 'from-cream to-leaf-50', tags: ['초간단', '야식'], favorite: false,
    ingredients: ['냉동 만두', '달걀', '대파'],
    steps: ['만두를 팬에 굽다가 물을 약간 넣고 뚜껑을 덮는다.', '물을 끓여 달걀을 풀어 넣는다.', '대파를 넣고 소금으로 간한다.'],
  },
  {
    title: '사과 시나몬 토스트', emoji: '🍞', time: 10, difficulty: '쉬움', servings: 1, kcal: 330,
    color: 'from-tomato-50 to-yolk-50', tags: ['디저트', '브런치'], favorite: false,
    ingredients: ['사과', '식빵', '버터', '시나몬'],
    steps: ['사과를 얇게 썬다.', '버터 바른 식빵 위에 사과를 올린다.', '시나몬을 뿌려 에어프라이어 180℃ 6분.'],
  },
];

const SEED_SHOPPING = [
  ['고춧가루', '김치찌개용', false],
  ['된장', '', false],
  ['파스타면', '500g', true],
  ['마늘', '다진 마늘', false],
];

// ── DB lazy init ─────────────────────────────
// 같은 Supabase DB 를 다른 앱들과 같이 쓰므로 테이블은 fridge_ 접두사로 구분한다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  if (!DATABASE_URL) throw new HttpError(500, 'DATABASE_URL 환경변수가 설정되지 않았어요');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 서버리스 cold start 가 동시에 여러 번 일어나도 스키마 변경이 겹치지 않게 잠근다
    await client.query("SELECT pg_advisory_xact_lock(hashtext('fridge_app_init'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS fridge_ingredients (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL DEFAULT '🥫',
        qty NUMERIC NOT NULL DEFAULT 1,
        unit TEXT NOT NULL DEFAULT '개',
        category TEXT NOT NULL,
        storage TEXT NOT NULL,
        expires DATE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS fridge_recipes (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        emoji TEXT NOT NULL,
        time INT NOT NULL,
        difficulty TEXT NOT NULL,
        servings INT NOT NULL,
        kcal INT NOT NULL,
        color TEXT NOT NULL,
        tags TEXT[] NOT NULL DEFAULT '{}',
        ingredients TEXT[] NOT NULL DEFAULT '{}',
        steps TEXT[] NOT NULL DEFAULT '{}',
        favorite BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS fridge_shopping (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        done BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- AI 레시피 기능 추가 시 생긴 컬럼 (기존 테이블에도 붙도록 ALTER)
      ALTER TABLE fridge_recipes ADD COLUMN IF NOT EXISTS ai BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE fridge_recipes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

      -- 로그인 기능: 사용자 테이블 + 각 데이터의 소유자(user_id)
      -- 로그인 도입 전에 쌓인 행은 user_id 가 NULL 이라 어느 계정에도 보이지 않는다
      CREATE TABLE IF NOT EXISTS fridge_users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE fridge_ingredients ADD COLUMN IF NOT EXISTS user_id INT REFERENCES fridge_users(id) ON DELETE CASCADE;
      ALTER TABLE fridge_recipes ADD COLUMN IF NOT EXISTS user_id INT REFERENCES fridge_users(id) ON DELETE CASCADE;
      ALTER TABLE fridge_shopping ADD COLUMN IF NOT EXISTS user_id INT REFERENCES fridge_users(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS fridge_ingredients_user_idx ON fridge_ingredients(user_id);
      CREATE INDEX IF NOT EXISTS fridge_recipes_user_idx ON fridge_recipes(user_id);
      CREATE INDEX IF NOT EXISTS fridge_shopping_user_idx ON fridge_shopping(user_id);
    `);

    await client.query('COMMIT');
    dbInitialized = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 새 사용자에게 예시 재료·레시피·장보기를 넣는다 (회원가입 트랜잭션 안에서 호출)
async function seedUser(client, userId) {
  for (const [name, emoji, qty, unit, category, storage, days] of SEED_INGREDIENTS) {
    await client.query(
      `INSERT INTO fridge_ingredients (user_id, name, emoji, qty, unit, category, storage, expires)
       VALUES ($1, $2, $3, $4, $5, $6, $7, (now() AT TIME ZONE 'Asia/Seoul')::date + $8::int)`,
      [userId, name, emoji, qty, unit, category, storage, days],
    );
  }
  for (const r of SEED_RECIPES) {
    await client.query(
      `INSERT INTO fridge_recipes (user_id, title, emoji, time, difficulty, servings, kcal, color, tags, ingredients, steps, favorite)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [userId, r.title, r.emoji, r.time, r.difficulty, r.servings, r.kcal, r.color, r.tags, r.ingredients, r.steps, r.favorite],
    );
  }
  for (const [name, note, done] of SEED_SHOPPING) {
    await client.query('INSERT INTO fridge_shopping (user_id, name, note, done) VALUES ($1, $2, $3, $4)', [userId, name, note, done]);
  }
}

// ── Auth helpers ─────────────────────────────
// 저장 형식: scrypt$<salt hex>$<hash hex>
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

// 없는 이메일로 로그인해도 응답 시간이 같도록 비교용 더미 해시 (이메일 존재 여부 노출 방지)
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword(crypto.randomUUID()));

function requireJwtSecret() {
  if (JWT_SECRET.length < 32) throw new HttpError(503, '서버에 JWT_SECRET 이 설정되지 않아 로그인을 쓸 수 없어요');
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name });

function issueToken(user) {
  return jwt.sign({ sub: String(user.id), name: user.name }, JWT_SECRET, { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN });
}

// Authorization: Bearer <token> 을 검증해 req.userId 를 채운다
function requireAuth(req, _res, next) {
  requireJwtSecret();
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, '로그인이 필요해요');
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    throw new HttpError(401, err.name === 'TokenExpiredError' ? '로그인이 만료됐어요. 다시 로그인해주세요' : '로그인 정보가 올바르지 않아요');
  }
  req.userId = toId(payload.sub);
  next();
}

function toEmail(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!v || v.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, '올바른 이메일을 입력해주세요');
  return v;
}

function toPassword(raw) {
  if (typeof raw !== 'string' || raw.length < PASSWORD_MIN || raw.length > PASSWORD_MAX) {
    throw new HttpError(400, `비밀번호는 ${PASSWORD_MIN}~${PASSWORD_MAX}자로 입력해주세요`);
  }
  return raw;
}

// ── Helpers ──────────────────────────────────
function text(raw, { name, max = NAME_MAX, required = true }) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (required && !v) throw new HttpError(400, `${name}을(를) 입력해주세요`);
  if (v.length > max) throw new HttpError(400, `${name}은(는) ${max}자 이하로 입력해주세요`);
  return v;
}

function oneOf(raw, list, name) {
  if (!list.includes(raw)) throw new HttpError(400, `${name}을(를) 목록에서 선택해주세요`);
  return raw;
}

function toId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, '잘못된 id 예요');
  return n;
}

function toDate(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new HttpError(400, '유통기한 날짜 형식이 올바르지 않아요 (YYYY-MM-DD)');
  }
  return raw;
}

// DATE 는 타임존 밀림이 없도록 문자열로 꺼낸다
const INGREDIENT_COLS = `id, name, emoji, qty::float AS qty, unit, category, storage,
  to_char(expires, 'YYYY-MM-DD') AS expires`;

// 라우트 핸들러의 async 에러를 에러 미들웨어로 넘긴다
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.use('/api', wrap(async (_req, _res, next) => {
  await initDB();
  next();
}));

// ── API: 인증 (토큰 없이 접근 가능) ───────────
// body: { email, password, name }
app.post('/api/auth/signup', wrap(async (req, res) => {
  requireJwtSecret();
  const b = req.body || {};
  const email = toEmail(b.email);
  const password = toPassword(b.password);
  const name = text(b.name, { name: '닉네임', max: 20 });
  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  let user;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO fridge_users (email, name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
      [email, name, passwordHash],
    );
    if (!rows.length) throw new HttpError(409, '이미 가입된 이메일이에요');
    user = rows[0];
    await seedUser(client, user.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.status(201).json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
}));

// body: { email, password }
app.post('/api/auth/login', wrap(async (req, res) => {
  requireJwtSecret();
  const b = req.body || {};
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!email || !password) throw new HttpError(400, '이메일과 비밀번호를 입력해주세요');

  const { rows: [user] } = await pool.query('SELECT id, email, name, password_hash FROM fridge_users WHERE email = $1', [email]);
  const ok = await verifyPassword(password.slice(0, PASSWORD_MAX), user ? user.password_hash : await getDummyHash());
  // 이메일이 없는지 비밀번호가 틀렸는지는 구분해서 알려주지 않는다
  if (!user || !ok) throw new HttpError(401, '이메일 또는 비밀번호가 올바르지 않아요');
  res.json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
}));

// ── 여기부터는 로그인한 사용자만 ──────────────
app.use('/api', (req, res, next) => (req.path.startsWith('/auth/') && req.path !== '/auth/me' ? next() : requireAuth(req, res, next)));

app.get('/api/auth/me', wrap(async (req, res) => {
  const { rows: [user] } = await pool.query('SELECT id, email, name FROM fridge_users WHERE id = $1', [req.userId]);
  if (!user) throw new HttpError(401, '탈퇴했거나 존재하지 않는 계정이에요');
  res.json({ success: true, data: publicUser(user) });
}));

// ── API: 재료 ────────────────────────────────
app.get('/api/ingredients', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${INGREDIENT_COLS} FROM fridge_ingredients WHERE user_id = $1 ORDER BY expires, id`, [req.userId]);
  res.json({ success: true, data: rows });
}));

app.post('/api/ingredients', wrap(async (req, res) => {
  const b = req.body || {};
  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty <= 0 || qty > QTY_MAX) throw new HttpError(400, '수량은 0보다 큰 숫자로 입력해주세요');
  const { rows } = await pool.query(
    `INSERT INTO fridge_ingredients (user_id, name, emoji, qty, unit, category, storage, expires)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${INGREDIENT_COLS}`,
    [
      req.userId,
      text(b.name, { name: '재료 이름' }),
      text(b.emoji, { name: '아이콘', max: 8, required: false }) || '🥫',
      qty,
      text(b.unit, { name: '단위', max: 10, required: false }) || '개',
      oneOf(b.category, CATEGORIES, '분류'),
      oneOf(b.storage, STORAGES, '보관 장소'),
      toDate(b.expires),
    ],
  );
  res.status(201).json({ success: true, data: rows[0] });
}));

app.delete('/api/ingredients/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM fridge_ingredients WHERE id = $1 AND user_id = $2 RETURNING ${INGREDIENT_COLS}`,
    [toId(req.params.id), req.userId],
  );
  if (!rows.length) throw new HttpError(404, '재료를 찾을 수 없어요');
  res.json({ success: true, data: rows[0] });
}));

// ── API: 레시피 ──────────────────────────────
// 클라이언트에 보낼 레시피 컬럼 (user_id 는 빼고)
const RECIPE_COLS = 'id, title, emoji, time, difficulty, servings, kcal, color, tags, ingredients, steps, favorite, ai, created_at';

app.get('/api/recipes', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${RECIPE_COLS} FROM fridge_recipes WHERE user_id = $1 ORDER BY id`, [req.userId]);
  res.json({ success: true, data: rows });
}));

app.patch('/api/recipes/:id/favorite', wrap(async (req, res) => {
  const { favorite } = req.body || {};
  if (typeof favorite !== 'boolean') throw new HttpError(400, 'favorite 는 true/false 여야 해요');
  const { rows } = await pool.query(
    `UPDATE fridge_recipes SET favorite = $2 WHERE id = $1 AND user_id = $3 RETURNING ${RECIPE_COLS}`,
    [toId(req.params.id), favorite, req.userId],
  );
  if (!rows.length) throw new HttpError(404, '레시피를 찾을 수 없어요');
  res.json({ success: true, data: rows[0] });
}));

// ── API: AI 레시피 ───────────────────────────
const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const cleanList = (arr, maxItems, maxLen) =>
  [...new Set((Array.isArray(arr) ? arr : []).map((s) => String(s).trim().slice(0, maxLen)).filter(Boolean))].slice(0, maxItems);

async function askOpenAI(messages) {
  let r;
  try {
    r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.8,
        max_tokens: 1200,
        response_format: { type: 'json_schema', json_schema: RECIPE_SCHEMA },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    console.error('OpenAI fetch failed', err.name, err.message);
    throw new HttpError(504, 'AI 응답이 너무 늦어요. 잠시 후 다시 시도해주세요');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // OpenAI 원본 에러는 서버 로그에만 남기고, 클라이언트엔 일반화된 메시지만
    console.error('OpenAI error', r.status, data?.error?.message);
    throw new HttpError(502, r.status === 429 ? 'AI 사용량이 많아요. 잠시 후 다시 시도해주세요' : 'AI 레시피 생성에 실패했어요');
  }
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) throw new HttpError(400, '이 요청으로는 레시피를 만들 수 없어요. 요청을 바꿔보세요');
  try {
    return JSON.parse(msg?.content ?? '');
  } catch (_) {
    throw new HttpError(502, 'AI 응답을 해석하지 못했어요. 다시 시도해주세요');
  }
}

// body: { ingredients?: string[] (쓰고 싶은 냉장고 재료), request?: string (예: "15분 안에, 매콤하게") }
app.post('/api/recipes/generate', wrap(async (req, res) => {
  if (!OPENAI_API_KEY) throw new HttpError(503, '서버에 OPENAI_API_KEY 가 설정되지 않아 AI 기능을 쓸 수 없어요');
  const b = req.body || {};
  if (b.ingredients !== undefined && !Array.isArray(b.ingredients)) throw new HttpError(400, 'ingredients 는 배열이어야 해요');
  const picked = cleanList(b.ingredients, AI_PICK_MAX, NAME_MAX);
  const request = text(b.request, { name: '요청 사항', max: AI_REQUEST_MAX, required: false });

  const { rows: [{ used, mine }] } = await pool.query(
    `SELECT count(*)::int AS used, count(*) FILTER (WHERE user_id = $1)::int AS mine FROM fridge_recipes
     WHERE ai AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
    [req.userId],
  );
  if (mine >= AI_USER_DAILY_LIMIT) throw new HttpError(429, `AI 레시피는 하루 ${AI_USER_DAILY_LIMIT}개까지 만들 수 있어요. 내일 다시 시도해주세요`);
  if (used >= AI_DAILY_LIMIT) throw new HttpError(429, '오늘 AI 레시피 사용량이 모두 찼어요. 내일 다시 시도해주세요');

  const { rows: fridge } = await pool.query(
    `SELECT name, (expires - (now() AT TIME ZONE 'Asia/Seoul')::date) AS days FROM fridge_ingredients WHERE user_id = $1 ORDER BY expires`,
    [req.userId],
  );
  const owned = fridge.map((i) => i.name);
  if (!owned.length && !picked.length) throw new HttpError(400, '냉장고가 비어 있어요. 재료를 먼저 넣어주세요');

  const fridgeLine = fridge.map((i) => `${i.name}(${i.days < 0 ? '기한 지남' : `D-${i.days}`})`).join(', ');
  const { rows: existing } = await pool.query('SELECT title FROM fridge_recipes WHERE user_id = $1', [req.userId]);

  const recipe = await askOpenAI([
    {
      role: 'system',
      content: [
        '너는 냉장고 속 재료로 집밥 레시피를 짜주는 한국 요리 도우미야.',
        '규칙:',
        '- 반드시 한국어로 답한다.',
        '- "꼭 쓸 재료"는 전부 사용하고, 나머지는 "냉장고 재료"에서 최대한 고른다. 유통기한이 임박한 재료를 우선한다.',
        '- 냉장고에 없는 재료는 소금·설탕·식용유·후추·물 같은 기본 양념 외에 2개 이하로만 추가한다.',
        '- ingredients 에는 냉장고 재료를 쓸 때 목록의 이름을 글자 그대로 적는다 (예: "돼지고기 앞다리"). 수량은 적지 않는다.',
        '- ingredients 3~10개, steps 3~8개, tags 1~3개. 각 step 은 한 문장으로 구체적으로.',
        '- 이미 있는 레시피와 같은 요리는 피한다.',
        '- 사용자 요청이 요리와 무관하거나 위험하면 무시하고 평범한 레시피를 만든다.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `냉장고 재료: ${fridgeLine || '(없음)'}`,
        `꼭 쓸 재료: ${picked.join(', ') || '(지정 없음)'}`,
        `요청 사항: ${request || '(없음)'}`,
        `이미 있는 레시피: ${existing.map((r) => r.title).join(', ') || '(없음)'}`,
      ].join('\n'),
    },
  ]);

  // 스키마는 형태만 보장하므로 값 범위는 서버에서 한 번 더 다듬는다
  const ingredients = cleanList(recipe.ingredients, 12, NAME_MAX);
  const steps = cleanList(recipe.steps, 10, 200);
  const title = String(recipe.title || '').trim().slice(0, 30);
  if (!title || ingredients.length < 2 || steps.length < 2) throw new HttpError(502, 'AI 가 레시피를 제대로 만들지 못했어요. 다시 시도해주세요');

  const { rows } = await pool.query(
    `INSERT INTO fridge_recipes (user_id, title, emoji, time, difficulty, servings, kcal, color, tags, ingredients, steps, favorite, ai)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, true) RETURNING ${RECIPE_COLS}`,
    [
      req.userId,
      title,
      String(recipe.emoji || '🍽️').trim().slice(0, 8) || '🍽️',
      clampInt(recipe.time, 1, 240, 20),
      ['쉬움', '보통', '어려움'].includes(recipe.difficulty) ? recipe.difficulty : '보통',
      clampInt(recipe.servings, 1, 10, 2),
      clampInt(recipe.kcal, 0, 3000, 500),
      AI_COLORS[Math.floor(Math.random() * AI_COLORS.length)],
      cleanList(recipe.tags, 3, 10),
      ingredients,
      steps,
    ],
  );
  res.status(201).json({ success: true, data: rows[0] });
}));

// 기본 레시피는 지키고, AI 가 만든 레시피만 삭제할 수 있다
app.delete('/api/recipes/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM fridge_recipes WHERE id = $1 AND user_id = $2 AND ai RETURNING id, title',
    [toId(req.params.id), req.userId],
  );
  if (!rows.length) throw new HttpError(404, '삭제할 수 있는 AI 레시피를 찾지 못했어요');
  res.json({ success: true, data: rows[0] });
}));

// ── API: 장보기 ──────────────────────────────
app.get('/api/shopping', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, note, done FROM fridge_shopping WHERE user_id = $1 ORDER BY id', [req.userId]);
  res.json({ success: true, data: rows });
}));

// body: { names: ['마늘', ...], note? }  — 이미 목록에 있는(미완료) 이름은 건너뛴다
app.post('/api/shopping', wrap(async (req, res) => {
  const { names, note } = req.body || {};
  if (!Array.isArray(names) || !names.length || names.length > 30) throw new HttpError(400, 'names 는 1~30개 배열이어야 해요');
  const clean = [...new Set(names.map((n) => text(n, { name: '항목 이름' })))];
  const memo = text(note, { name: '메모', max: 60, required: false });
  const { rows } = await pool.query(
    `INSERT INTO fridge_shopping (user_id, name, note)
     SELECT $3, n, $2 FROM unnest($1::text[]) AS n
     WHERE NOT EXISTS (SELECT 1 FROM fridge_shopping s WHERE s.user_id = $3 AND s.name = n AND NOT s.done)
     RETURNING id, name, note, done`,
    [clean, memo, req.userId],
  );
  res.status(201).json({ success: true, data: rows });
}));

app.patch('/api/shopping/:id', wrap(async (req, res) => {
  const { done } = req.body || {};
  if (typeof done !== 'boolean') throw new HttpError(400, 'done 은 true/false 여야 해요');
  const { rows } = await pool.query(
    'UPDATE fridge_shopping SET done = $2 WHERE id = $1 AND user_id = $3 RETURNING id, name, note, done',
    [toId(req.params.id), done, req.userId],
  );
  if (!rows.length) throw new HttpError(404, '항목을 찾을 수 없어요');
  res.json({ success: true, data: rows[0] });
}));

// 완료 항목 일괄 삭제 (/:id 보다 먼저 등록)
app.delete('/api/shopping/done', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM fridge_shopping WHERE done AND user_id = $1', [req.userId]);
  res.json({ success: true, data: { deleted: rowCount } });
}));

app.delete('/api/shopping/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM fridge_shopping WHERE id = $1 AND user_id = $2', [toId(req.params.id), req.userId]);
  if (!rowCount) throw new HttpError(404, '항목을 찾을 수 없어요');
  res.json({ success: true, data: { id: Number(req.params.id) } });
}));

// ── API 404 ──────────────────────────────────
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API 예요' });
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
    return res.status(400).json({ success: false, message: '요청 형식(JSON)이 올바르지 않아요' });
  }
  console.error(err);
  res.status(500).json({ success: false, message: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`냉장고 파먹기 서버 실행 중 → http://localhost:${PORT}`));
}
module.exports = app;
