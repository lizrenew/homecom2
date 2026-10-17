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
const PORT = env('PORT', '3000');
const JWT_SECRET = env('JWT_SECRET');
// 토스페이먼츠 주문서형(결제위젯) 연동 키. 클라이언트 키는 공개돼도 되지만 시크릿 키는 서버에만 둔다.
const TOSS_CLIENT_KEY = env('TOSS_CLIENT_KEY');
const TOSS_SECRET_KEY = env('TOSS_SECRET_KEY');

if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL 환경변수가 없어요. .env.example 을 .env 로 복사해 값을 넣어주세요.');
if (JWT_SECRET.length < 32) console.warn('⚠️  JWT_SECRET 환경변수가 없거나 너무 짧아요(32자 이상). 로그인·회원가입이 비활성화됩니다.');
if (!TOSS_CLIENT_KEY || !TOSS_SECRET_KEY) console.warn('⚠️  TOSS_CLIENT_KEY / TOSS_SECRET_KEY 환경변수가 없어요. 결제가 비활성화됩니다.');

const app = express();

// ── 인증 설정 ────────────────────────────────
// 토큰: JWT(HS256) 를 Authorization: Bearer 헤더로 주고받는다. 만료되면 다시 로그인.
// 비밀번호: OWASP Password Storage Cheat Sheet 권장값의 scrypt (N=2^17, r=8, p=1) 로 해시한다.
const JWT_EXPIRES_IN = '7d';
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const SCRYPT_KEYLEN = 64;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const scrypt = promisify(crypto.scrypt);

// ── 상품 설정 ────────────────────────────────
const CATEGORIES = ['living', 'dining', 'bedroom', 'lighting', 'storage'];
const SORTS = {
  recommended: 'sort_order, id',
  low: 'price ASC, sort_order',
  high: 'price DESC, sort_order',
  review: 'reviews DESC, sort_order',
};
const PRICE_MAX = 100_000_000;

// ── 주문·결제 설정 (index.html 의 장바구니 표시와 같은 규칙) ──
const QTY_MAX = 99;
const CART_LINES_MAX = 50;
const FREE_SHIPPING_MIN = 300000;
const SHIPPING_FEE = 30000;
const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';

// ── 시드 데이터 (원래 index.html 에 있던 데모 가구 12개) ──
// colors: [이름, HEX] 쌍 배열 → JSONB 로 저장
const SEED_PRODUCTS = [
  { id: 'p01', name: '누크 라운지 체어', en: 'Nook Lounge Chair', category: 'living', price: 890000, original: 990000, badge: 'BEST', rating: 4.9, reviews: 128,
    material: '오크 원목 · 부클레 패브릭', size: 'W76 × D80 × H72 cm', colors: [['크림', '#EFE8DC'], ['오트', '#D9CDB8'], ['차콜', '#4A4642']],
    desc: '몸을 깊게 감싸는 곡선형 시트와 단단한 오크 프레임. 오후의 햇살 아래 책 한 권을 위한 의자입니다.' },
  { id: 'p02', name: '소프트 리넨 3인 소파', en: 'Soft Linen Sofa', category: 'living', price: 2450000, badge: 'NEW', rating: 4.8, reviews: 64,
    material: '내추럴 리넨 · 페더 쿠션', size: 'W220 × D95 × H70 cm', colors: [['베이지', '#E2D6C2'], ['샌드', '#CBB99D']],
    desc: '낮은 좌고와 깊은 쿠션으로 공간을 넓고 편안하게. 커버는 분리해 세탁할 수 있습니다.' },
  { id: 'p03', name: '트래버틴 라운드 테이블', en: 'Travertine Coffee Table', category: 'living', price: 1290000, rating: 4.9, reviews: 41,
    material: '이탈리아산 트래버틴', size: 'Ø80 × H35 cm', colors: [['아이보리', '#E8DFD0']],
    desc: '자연석 고유의 기공과 결이 살아있는 원형 테이블. 같은 제품은 하나도 없습니다.' },
  { id: 'p04', name: '오벌 오크 다이닝 테이블', en: 'Oval Oak Dining Table', category: 'dining', price: 1680000, rating: 4.7, reviews: 52,
    material: '화이트 오크 원목 · 오일 마감', size: 'W180 × D95 × H74 cm', colors: [['내추럴 오크', '#C9A47A'], ['스모크 오크', '#7B5E44']],
    desc: '모서리 없는 타원형 상판이 대화를 부드럽게 이어줍니다. 4–6인용.' },
  { id: 'p05', name: '플루티드 월넛 사이드보드', en: 'Fluted Walnut Sideboard', category: 'storage', price: 1980000, original: 2200000, rating: 4.8, reviews: 33,
    material: '월넛 원목 · 무늬목', size: 'W180 × D45 × H65 cm', colors: [['월넛', '#5C3F2C']],
    desc: '세로 결의 플루티드 슬라이딩 도어가 빛과 그림자를 만드는 낮은 수납장.' },
  { id: 'p06', name: '아카리 페이퍼 펜던트', en: 'Paper Pendant Lamp', category: 'lighting', price: 240000, badge: 'BEST', rating: 4.9, reviews: 210,
    material: '한지 · 대나무 살', size: 'Ø60 cm', colors: [['화이트', '#F4F0E8']],
    desc: '한지를 통과한 빛은 눈부시지 않고 따뜻합니다. 공간 전체를 부드럽게 채우는 조명.' },
  { id: 'p07', name: '세라믹 사이드 테이블', en: 'Ceramic Side Table', category: 'living', price: 320000, rating: 4.6, reviews: 27,
    material: '무광 세라믹', size: 'Ø38 × H45 cm', colors: [['샌드', '#D6C6AE'], ['테라코타', '#B5714F']],
    desc: '손으로 빚은 원통형 사이드 테이블. 스툴이나 화분대로도 쓸 수 있습니다.' },
  { id: 'p08', name: '로우 오크 플랫폼 베드', en: 'Low Oak Platform Bed', category: 'bedroom', price: 1590000, badge: 'NEW', rating: 4.8, reviews: 46,
    material: '화이트 오크 원목', size: 'Queen · W165 × D215 × H75 cm', colors: [['내추럴 오크', '#C9A47A']],
    desc: '바닥에 가깝게 내려앉은 낮은 침대 프레임. 방이 한층 넓고 고요해집니다.' },
  { id: 'p09', name: '페이퍼코드 다이닝 체어', en: 'Paper Cord Chair', category: 'dining', price: 380000, rating: 4.7, reviews: 89,
    material: '애쉬 원목 · 페이퍼코드', size: 'W48 × D50 × H78 cm', colors: [['내추럴', '#D8BE97'], ['블랙', '#2B2926']],
    desc: '손으로 엮은 페이퍼코드 시트가 오래 앉아도 편안한 다이닝 체어.' },
  { id: 'p10', name: '플리츠 플로어 램프', en: 'Pleated Floor Lamp', category: 'lighting', price: 460000, rating: 4.6, reviews: 38,
    material: '리넨 쉐이드 · 브라스', size: 'Ø40 × H160 cm', colors: [['리넨', '#E6DCCB']],
    desc: '주름진 리넨 쉐이드와 가는 브라스 스템. 켜지 않아도 오브제가 되는 램프.' },
  { id: 'p11', name: '오크 오픈 선반', en: 'Oak Open Shelf', category: 'storage', price: 690000, rating: 4.7, reviews: 22,
    material: '화이트 오크 원목', size: 'W90 × D32 × H120 cm', colors: [['내추럴 오크', '#C9A47A']],
    desc: '책과 오브제를 위한 여백 있는 3단 선반. 벽에 기대거나 고정해 사용합니다.' },
  { id: 'p12', name: '아치 오크 거울', en: 'Arched Oak Mirror', category: 'bedroom', price: 420000, rating: 4.8, reviews: 57,
    material: '오크 프레임 · 저철분 유리', size: 'W70 × H170 cm', colors: [['내추럴 오크', '#C9A47A']],
    desc: '부드러운 아치 형태의 전신 거울. 공간에 빛을 한 번 더 들여옵니다.' },
];

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

// ── DB lazy init ─────────────────────────────
// 같은 Supabase DB 를 다른 앱들과 같이 쓰므로 테이블은 furn_ 접두사로 구분한다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  if (!DATABASE_URL) throw new HttpError(500, 'DATABASE_URL 환경변수가 설정되지 않았어요');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 서버리스 cold start 가 동시에 여러 번 일어나도 스키마 생성·시드가 겹치지 않게 잠근다
    await client.query("SELECT pg_advisory_xact_lock(hashtext('furn_app_init'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS furn_users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- id 는 이미지 파일명·URL 과 맞추기 위해 'p01' 같은 문자열을 그대로 쓴다
      CREATE TABLE IF NOT EXISTS furn_products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_en TEXT NOT NULL,
        category TEXT NOT NULL,
        price INT NOT NULL CHECK (price >= 0),
        original_price INT CHECK (original_price >= 0),
        badge TEXT,
        rating NUMERIC(2,1) NOT NULL DEFAULT 0,
        reviews INT NOT NULL DEFAULT 0,
        material TEXT NOT NULL,
        size TEXT NOT NULL,
        colors JSONB NOT NULL DEFAULT '[]',
        description TEXT NOT NULL,
        image TEXT NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS furn_products_category_idx ON furn_products(category);
      -- 토스페이먼츠 customerKey: 이메일·자동증가 id 처럼 유추 가능한 값 대신 무작위 UUID 를 쓴다
      ALTER TABLE furn_users ADD COLUMN IF NOT EXISTS customer_key TEXT UNIQUE;
      -- 주문: 결제 요청 전에 READY 로 만들고(금액은 서버가 DB 가격으로 계산), 승인되면 DONE
      CREATE TABLE IF NOT EXISTS furn_orders (
        id SERIAL PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE,
        user_id INT NOT NULL REFERENCES furn_users(id) ON DELETE CASCADE,
        order_name TEXT NOT NULL,
        items JSONB NOT NULL,
        subtotal INT NOT NULL,
        shipping INT NOT NULL,
        amount INT NOT NULL CHECK (amount > 0),
        status TEXT NOT NULL DEFAULT 'READY',
        payment_key TEXT UNIQUE,
        method TEXT,
        receipt_url TEXT,
        approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS furn_orders_user_idx ON furn_orders(user_id, created_at DESC);
    `);

    // 시드 상품: 이미 있는 id 는 건드리지 않는다 (DB 에서 직접 고친 값이 덮어써지지 않게)
    for (const [i, p] of SEED_PRODUCTS.entries()) {
      await client.query(
        `INSERT INTO furn_products (id, name, name_en, category, price, original_price, badge, rating, reviews, material, size, colors, description, image, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.en, p.category, p.price, p.original ?? null, p.badge ?? null, p.rating, p.reviews,
          p.material, p.size, JSON.stringify(p.colors), p.desc, `images/${p.id}.jpg`, i + 1]
      );
    }
    await client.query('COMMIT');
    dbInitialized = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// DB 행 → 클라이언트 응답 형태 (NUMERIC → number)
const toProduct = (r) => ({
  id: r.id,
  name: r.name,
  en: r.name_en,
  category: r.category,
  price: r.price,
  original: r.original_price,
  badge: r.badge,
  rating: Number(r.rating),
  reviews: r.reviews,
  material: r.material,
  size: r.size,
  colors: r.colors,
  desc: r.description,
  image: r.image,
});

const toOrder = (r) => ({
  orderId: r.order_id,
  orderName: r.order_name,
  items: r.items,
  subtotal: r.subtotal,
  shipping: r.shipping,
  amount: r.amount,
  status: r.status,
  method: r.method,
  receiptUrl: r.receipt_url,
  approvedAt: r.approved_at,
  createdAt: r.created_at,
});

// ── Payment helpers ──────────────────────────
function requireToss() {
  if (!TOSS_CLIENT_KEY || !TOSS_SECRET_KEY) throw new HttpError(503, '서버에 토스페이먼츠 키가 설정되지 않아 결제를 쓸 수 없어요');
}

// 토스페이먼츠 결제 승인 API. 시크릿 키 뒤에 ':' 를 붙여 base64 로 인코딩한 Basic 인증을 쓴다.
async function confirmTossPayment({ paymentKey, orderId, amount }) {
  let res;
  try {
    res = await fetch(TOSS_CONFIRM_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (_) {
    throw new HttpError(502, '결제사에 연결하지 못했어요. 잠시 후 다시 시도해주세요');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn('[toss confirm]', res.status, body.code, body.message);
    throw new HttpError(400, body.message || '결제 승인에 실패했어요');
  }
  return body;
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

// 없는 이메일로 로그인해도 응답 시간이 같도록 비교용 더미 해시 (가입 여부 노출 방지)
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword(crypto.randomUUID()));

function requireJwtSecret() {
  if (JWT_SECRET.length < 32) throw new HttpError(503, '서버에 JWT_SECRET 이 설정되지 않아 로그인을 쓸 수 없어요');
}

const publicUser = (u) => ({ id: u.id, email: u.email, createdAt: u.created_at });

function issueToken(user) {
  return jwt.sign({ sub: String(user.id) }, JWT_SECRET, { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN });
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
  const id = Number(payload.sub);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(401, '로그인 정보가 올바르지 않아요');
  req.userId = id;
  next();
}

// ── Validators ───────────────────────────────
function toEmail(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(v) || v.length > EMAIL_MAX) throw new HttpError(400, '이메일 형식을 확인해주세요');
  return v;
}

function toPassword(raw) {
  if (typeof raw !== 'string' || raw.length < PASSWORD_MIN || raw.length > PASSWORD_MAX) {
    throw new HttpError(400, `비밀번호는 ${PASSWORD_MIN}~${PASSWORD_MAX}자로 입력해주세요`);
  }
  return raw;
}

// 라우트 핸들러의 async 에러를 에러 미들웨어로 넘긴다
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Middleware ───────────────────────────────
app.use(express.json());
// 정적 파일은 가구 이미지만 공개한다 (server.js·.env 등 소스는 노출하지 않음). index.html 은 아래 SPA fallback 이 보낸다.
app.use('/images', express.static(path.join(__dirname, 'images')));

app.use('/api', async (_req, _res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    next(err instanceof HttpError ? err : new HttpError(500, '데이터베이스 초기화에 실패했어요'));
  }
});

// ── API routes: 상품 (로그인 없이 누구나 조회) ──
// GET /api/products?category=living&sort=low&maxPrice=1000000 (모두 선택)
app.get('/api/products', wrap(async (req, res) => {
  const category = String(req.query.category || 'all');
  const sort = String(req.query.sort || 'recommended');
  const maxPriceRaw = req.query.maxPrice;

  if (category !== 'all' && !CATEGORIES.includes(category)) throw new HttpError(400, '알 수 없는 카테고리예요');
  if (!SORTS[sort]) throw new HttpError(400, '알 수 없는 정렬 방식이에요');

  const where = [];
  const params = [];
  if (category !== 'all') {
    params.push(category);
    where.push(`category = $${params.length}`);
  }
  if (maxPriceRaw !== undefined && maxPriceRaw !== 'all') {
    const maxPrice = Number(maxPriceRaw);
    if (!Number.isInteger(maxPrice) || maxPrice < 0 || maxPrice > PRICE_MAX) throw new HttpError(400, '가격 조건이 올바르지 않아요');
    params.push(maxPrice);
    where.push(`price <= $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT * FROM furn_products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${SORTS[sort]}`,
    params
  );
  res.json({ success: true, data: rows.map(toProduct) });
}));

app.get('/api/products/:id', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new HttpError(400, '잘못된 상품 번호예요');
  const { rows: [row] } = await pool.query('SELECT * FROM furn_products WHERE id = $1', [id]);
  if (!row) throw new HttpError(404, '상품을 찾을 수 없어요');
  res.json({ success: true, data: toProduct(row) });
}));

// ── API routes: 인증 ─────────────────────────
app.get('/api/auth/me', requireAuth, wrap(async (req, res) => {
  const { rows: [user] } = await pool.query('SELECT id, email, created_at FROM furn_users WHERE id = $1', [req.userId]);
  if (!user) throw new HttpError(401, '탈퇴했거나 존재하지 않는 계정이에요');
  res.json({ success: true, data: publicUser(user) });
}));

// body: { email, password }
app.post('/api/auth/signup', wrap(async (req, res) => {
  requireJwtSecret();
  const b = req.body || {};
  const email = toEmail(b.email);
  const password = toPassword(b.password);

  const { rows } = await pool.query(
    `INSERT INTO furn_users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING RETURNING id, email, created_at`,
    [email, await hashPassword(password)]
  );
  if (!rows.length) throw new HttpError(409, '이미 가입된 이메일이에요');
  const user = rows[0];
  res.status(201).json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
}));

// body: { email, password }
app.post('/api/auth/login', wrap(async (req, res) => {
  requireJwtSecret();
  const b = req.body || {};
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!email || !password) throw new HttpError(400, '이메일과 비밀번호를 입력해주세요');

  const { rows: [user] } = await pool.query('SELECT id, email, password_hash, created_at FROM furn_users WHERE email = $1', [email]);
  const ok = await verifyPassword(password.slice(0, PASSWORD_MAX), user ? user.password_hash : await getDummyHash());
  // 이메일이 없는지 비밀번호가 틀렸는지는 구분해서 알려주지 않는다
  if (!user || !ok) throw new HttpError(401, '이메일 또는 비밀번호가 올바르지 않아요');
  res.json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
}));

// ── API routes: 주문·결제 (토스페이먼츠, 로그인 필요) ──
// 결제위젯 초기화에 필요한 공개 클라이언트 키
app.get('/api/payments/config', (_req, res, next) => {
  try {
    requireToss();
    res.json({ success: true, data: { clientKey: TOSS_CLIENT_KEY } });
  } catch (err) {
    next(err);
  }
});

// 내 결제 내역 (결제창만 열고 끝난 READY 주문은 빼고 보여준다)
app.get('/api/orders', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM furn_orders WHERE user_id = $1 AND status <> 'READY' ORDER BY created_at DESC LIMIT 100",
    [req.userId]
  );
  res.json({ success: true, data: rows.map(toOrder) });
}));

// body: { items: [{ id, color, qty }] } — 가격·배송비는 클라이언트 값을 믿지 않고 DB 로 다시 계산한다
app.post('/api/orders', requireAuth, wrap(async (req, res) => {
  requireToss();
  const raw = (req.body || {}).items;
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, '장바구니가 비어 있어요');
  if (raw.length > CART_LINES_MAX) throw new HttpError(400, '한 번에 주문할 수 있는 상품 수를 넘었어요');

  const ids = [...new Set(raw.map((i) => String(i && i.id)))];
  const { rows: products } = await pool.query('SELECT * FROM furn_products WHERE id = ANY($1)', [ids]);
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));

  const items = raw.map((i) => {
    const p = byId[String(i && i.id)];
    if (!p) throw new HttpError(400, '판매하지 않는 상품이 장바구니에 있어요');
    const qty = Number(i.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > QTY_MAX) throw new HttpError(400, `수량은 1~${QTY_MAX}개로 입력해주세요`);
    if (!p.colors.some(([name]) => name === i.color)) throw new HttpError(400, `${p.name}: 선택할 수 없는 색상이에요`);
    return { id: p.id, name: p.name, color: i.color, qty, unitPrice: p.price, lineTotal: p.price * qty, image: p.image };
  });

  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const shipping = subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FEE;
  const amount = subtotal + shipping;
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const orderName = (totalQty > 1 ? `${items[0].name} 외 ${totalQty - 1}건` : items[0].name).slice(0, 100);
  // 6~64자, 영문·숫자·-_= 만 허용 (토스페이먼츠 orderId 규칙)
  const orderId = `ondo-${Date.now().toString(36)}-${crypto.randomBytes(9).toString('base64url')}`;

  await pool.query(
    `INSERT INTO furn_orders (order_id, user_id, order_name, items, subtotal, shipping, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orderId, req.userId, orderName, JSON.stringify(items), subtotal, shipping, amount]
  );

  // customerKey 가 없으면 이때 한 번 만들어 저장한다
  const { rows: [user] } = await pool.query(
    'UPDATE furn_users SET customer_key = COALESCE(customer_key, $2) WHERE id = $1 RETURNING email, customer_key',
    [req.userId, crypto.randomUUID()]
  );

  res.status(201).json({
    success: true,
    data: { orderId, orderName, amount, subtotal, shipping, items, customerKey: user.customer_key, customerEmail: user.email },
  });
}));

// body: { paymentKey, orderId, amount } — successUrl 로 돌아온 값을 서버에서 검증한 뒤 승인한다
app.post('/api/payments/confirm', requireAuth, wrap(async (req, res) => {
  requireToss();
  const b = req.body || {};
  const paymentKey = typeof b.paymentKey === 'string' ? b.paymentKey : '';
  const orderId = typeof b.orderId === 'string' ? b.orderId : '';
  const amount = Number(b.amount);
  if (!paymentKey || paymentKey.length > 200 || !/^[A-Za-z0-9_=-]{6,64}$/.test(orderId) || !Number.isInteger(amount)) {
    throw new HttpError(400, '결제 정보가 올바르지 않아요');
  }

  const { rows: [order] } = await pool.query('SELECT * FROM furn_orders WHERE order_id = $1 AND user_id = $2', [orderId, req.userId]);
  if (!order) throw new HttpError(404, '주문을 찾을 수 없어요');
  // 새로고침 등으로 같은 결제를 다시 승인하려 하면 저장된 결과를 그대로 돌려준다
  if (order.status === 'DONE') {
    if (order.payment_key !== paymentKey) throw new HttpError(409, '이미 다른 결제로 완료된 주문이에요');
    return res.json({ success: true, data: toOrder(order) });
  }
  if (order.status !== 'READY') throw new HttpError(409, '결제할 수 없는 주문 상태예요');
  // 클라이언트에서 금액을 조작했는지 확인 (서버가 계산해 저장한 금액과 비교)
  if (order.amount !== amount) throw new HttpError(400, '결제 금액이 주문 금액과 달라요');

  const payment = await confirmTossPayment({ paymentKey, orderId, amount });
  if (payment.totalAmount !== order.amount) {
    console.error('[toss confirm] 승인 금액 불일치', orderId, payment.totalAmount, order.amount);
    throw new HttpError(400, '승인된 금액이 주문 금액과 달라요. 고객센터에 문의해주세요');
  }

  const { rows: [done] } = await pool.query(
    `UPDATE furn_orders SET status = 'DONE', payment_key = $2, method = $3, receipt_url = $4, approved_at = $5
     WHERE order_id = $1 RETURNING *`,
    [orderId, payment.paymentKey, payment.method || null, (payment.receipt && payment.receipt.url) || null, payment.approvedAt || new Date()]
  );
  res.json({ success: true, data: toOrder(done) });
}));

// ── 404 for unknown API ──────────────────────
app.use('/api', (_req, _res, next) => next(new HttpError(404, '존재하지 않는 API 예요')));

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  // express.json() 의 잘못된 JSON 본문은 400 으로 돌려준다
  if (err.type === 'entity.parse.failed') err = new HttpError(400, '요청 형식이 올바르지 않아요');
  if (!(err instanceof HttpError)) console.error(err);
  const status = err instanceof HttpError ? err.status : 500;
  res.status(status).json({ success: false, message: err instanceof HttpError ? err.message : '서버 오류가 발생했어요' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`🪑  ONDO server running on http://localhost:${PORT}`));
}
module.exports = app;
