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

if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL 환경변수가 없어요. .env.example 을 .env 로 복사해 값을 넣어주세요.');
if (JWT_SECRET.length < 32) console.warn('⚠️  JWT_SECRET 환경변수가 없거나 너무 짧아요(32자 이상). 로그인·장바구니가 비활성화됩니다.');

const app = express();

// ── 인증 설정 ────────────────────────────────
// 토큰: JWT(HS256) 를 Authorization: Bearer 헤더로 주고받는다. 만료되면 다시 로그인.
// 비밀번호: OWASP Password Storage Cheat Sheet 권장값의 scrypt (N=2^17, r=8, p=1) 로 해시한다.
const JWT_EXPIRES_IN = '7d';
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const SCRYPT_KEYLEN = 64;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const NAME_MAX = 20;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const scrypt = promisify(crypto.scrypt);

// ── 장바구니 설정 ─────────────────────────────
const QTY_MAX = 99;
const FREE_SHIPPING_MIN = 50000;
const SHIPPING_FEE = 3000;

// ── 상수 ─────────────────────────────────────
const CATEGORIES = ['아우터', '상의', '하의', '원피스', '가방', '슈즈', '액세서리'];
const SORTS = {
  recommend: 'rating * reviews DESC, id',
  low: 'COALESCE(sale_price, price) ASC, id',
  high: 'COALESCE(sale_price, price) DESC, id',
  review: 'reviews DESC, id',
};
const SEARCH_MAX = 50;

// ── 시드 데이터 (프로토타입 가짜 상품 10개) ───
// [name, category, price, sale_price, image, description, rating, reviews, tags, colors]
const SEED_PRODUCTS = [
  ['데일리 린넨 브이넥 블라우스', '상의', 59000, 47200, 'images/linen-blouse.png', '구김이 덜한 워싱 린넨으로 출근룩·주말룩 모두 깔끔하게.', 4.8, 312, ['BEST'], ['아이보리', '스카이', '블랙']],
  ['하이웨스트 원턱 와이드 슬랙스', '하의', 69000, null, 'images/wide-slacks.png', '허리선을 잡아주는 원턱 디테일로 다리가 길어 보이는 핏.', 4.7, 528, ['BEST'], ['베이지', '그레이', '네이비']],
  ['캐멀 싱글 울 롱코트', '아우터', 289000, 231200, 'images/wool-coat.png', '울 70% 혼방, 가볍지만 따뜻한 미니멀 롱코트.', 4.9, 146, ['NEW'], ['캐멀', '차콜']],
  ['캐시미어 블렌드 진주 가디건', '상의', 89000, null, 'images/knit-cardigan.png', '진주 단추 포인트, 부드러운 캐시미어 혼방 니트.', 4.8, 203, ['NEW'], ['오트밀', '크림', '모카']],
  ['더스티 로즈 새틴 슬립 원피스', '원피스', 98000, 78400, 'images/midi-dress.png', '은은한 광택의 새틴 소재, 하객룩으로도 추천.', 4.6, 97, [], ['더스티로즈', '블랙']],
  ['코냑 레더 스퀘어 토트백', '가방', 159000, null, 'images/leather-tote.png', '노트북 13인치 수납, 소가죽 데일리 토트백.', 4.9, 241, ['BEST'], ['코냑', '블랙']],
  ['담수진주 드롭 귀걸이', '액세서리', 39000, 31200, 'images/pearl-earrings.png', '14K 골드필드 후크, 얼굴선을 밝혀주는 담수진주.', 4.7, 389, [], ['골드']],
  ['블록힐 페니 로퍼', '슈즈', 119000, null, 'images/loafers.png', '3cm 블록힐로 하루 종일 편안한 소가죽 로퍼.', 4.5, 176, ['NEW'], ['블랙', '브라운']],
  ['보태니컬 실크 스카프', '액세서리', 49000, null, 'images/silk-scarf.png', '실크 100%, 가방·목·헤어에 다양하게 연출.', 4.6, 64, [], ['세이지', '크림']],
  ['클래식 더블 트렌치코트', '아우터', 219000, 175200, 'images/trench-coat.png', '발수 코튼 개버딘, 간절기 필수 클래식 트렌치.', 4.8, 433, ['BEST'], ['베이지', '카키']],
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
// 같은 Supabase DB 를 다른 앱들과 같이 쓰므로 테이블은 shop_ 접두사로 구분한다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  if (!DATABASE_URL) throw new HttpError(500, 'DATABASE_URL 환경변수가 설정되지 않았어요');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 서버리스 cold start 가 동시에 여러 번 일어나도 스키마 생성·시드가 겹치지 않게 잠근다
    await client.query("SELECT pg_advisory_xact_lock(hashtext('shop_app_init'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS shop_products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price INT NOT NULL CHECK (price >= 0),
        sale_price INT CHECK (sale_price >= 0),
        image TEXT NOT NULL,
        description TEXT NOT NULL,
        rating NUMERIC(2,1) NOT NULL DEFAULT 0,
        reviews INT NOT NULL DEFAULT 0,
        tags TEXT[] NOT NULL DEFAULT '{}',
        colors TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS shop_products_category_idx ON shop_products(category);
      CREATE TABLE IF NOT EXISTS shop_users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- 같은 상품이라도 색상이 다르면 다른 줄로 담는다
      CREATE TABLE IF NOT EXISTS shop_cart_items (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES shop_users(id) ON DELETE CASCADE,
        product_id INT NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
        color TEXT NOT NULL,
        qty INT NOT NULL CHECK (qty BETWEEN 1 AND ${QTY_MAX}),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, product_id, color)
      );
    `);

    // 데모 계정 (회원이 한 명도 없을 때만): demo@maison.com / password123
    const { rows: [{ users }] } = await client.query('SELECT count(*)::int AS users FROM shop_users');
    if (users === 0) {
      await client.query(
        'INSERT INTO shop_users (email, name, password_hash) VALUES ($1, $2, $3)',
        ['demo@maison.com', '데모회원', await hashPassword('password123')]
      );
    }

    const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM shop_products');
    if (count === 0) {
      for (const p of SEED_PRODUCTS) {
        await client.query(
          `INSERT INTO shop_products (name, category, price, sale_price, image, description, rating, reviews, tags, colors)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          p
        );
      }
      console.log(`🌱 shop_products 에 시드 상품 ${SEED_PRODUCTS.length}개를 넣었어요`);
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

// DB 행 → 클라이언트 응답 형태 (camelCase, NUMERIC → number)
const toProduct = (r) => ({
  id: r.id,
  name: r.name,
  category: r.category,
  price: r.price,
  salePrice: r.sale_price,
  image: r.image,
  desc: r.description,
  rating: Number(r.rating),
  reviews: r.reviews,
  tags: r.tags,
  colors: r.colors,
});

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

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name });

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
  req.userId = toId(payload.sub);
  next();
}

// ── Validators ───────────────────────────────
function toId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, '잘못된 번호예요');
  return n;
}

function toEmail(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(v) || v.length > EMAIL_MAX) throw new HttpError(400, '이메일 형식을 확인해주세요');
  return v;
}

function toName(raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v || v.length > NAME_MAX) throw new HttpError(400, `이름은 1~${NAME_MAX}자로 입력해주세요`);
  return v;
}

function toPassword(raw) {
  if (typeof raw !== 'string' || raw.length < PASSWORD_MIN || raw.length > PASSWORD_MAX) {
    throw new HttpError(400, `비밀번호는 ${PASSWORD_MIN}~${PASSWORD_MAX}자로 입력해주세요`);
  }
  return raw;
}

function toQty(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > QTY_MAX) throw new HttpError(400, `수량은 1~${QTY_MAX}개로 입력해주세요`);
  return n;
}

// ── Cart helpers ─────────────────────────────
// 내 장바구니 + 합계를 한 번에 돌려준다 (담기·수량 변경·삭제 후에도 같은 형태로 응답)
async function getCart(userId) {
  const { rows } = await pool.query(
    `SELECT c.id AS cart_id, c.color, c.qty, p.*
     FROM shop_cart_items c JOIN shop_products p ON p.id = c.product_id
     WHERE c.user_id = $1 ORDER BY c.created_at, c.id`,
    [userId]
  );
  const items = rows.map((r) => {
    const product = toProduct(r);
    const unitPrice = product.salePrice ?? product.price;
    return { id: r.cart_id, color: r.color, qty: r.qty, unitPrice, lineTotal: unitPrice * r.qty, product };
  });
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const shipping = subtotal === 0 || subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FEE;
  const count = items.reduce((s, i) => s + i.qty, 0);
  return { items, count, subtotal, shipping, total: subtotal + shipping };
}

// 라우트 핸들러의 async 에러를 에러 미들웨어로 넘긴다
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Middleware ───────────────────────────────
app.use(express.json());
// 정적 파일은 상품 이미지만 공개한다 (server.js·.env 등 소스는 노출하지 않음). index.html 은 아래 SPA fallback 이 보낸다.
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
// GET /api/products?category=상의&q=코트&sort=low
app.get('/api/products', async (req, res, next) => {
  try {
    const category = String(req.query.category || '').trim();
    const q = String(req.query.q || '').trim();
    const sort = String(req.query.sort || 'recommend');

    if (category && category !== '전체' && !CATEGORIES.includes(category)) {
      throw new HttpError(400, '알 수 없는 카테고리예요');
    }
    if (!SORTS[sort]) throw new HttpError(400, '알 수 없는 정렬 방식이에요');
    if (q.length > SEARCH_MAX) throw new HttpError(400, `검색어는 ${SEARCH_MAX}자 이하로 입력해 주세요`);

    const where = [];
    const params = [];
    if (category && category !== '전체') {
      params.push(category);
      where.push(`category = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length} OR category ILIKE $${params.length})`);
    }

    const { rows } = await pool.query(
      `SELECT * FROM shop_products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${SORTS[sort]}`,
      params
    );
    res.json({ success: true, data: rows.map(toProduct) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/products/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, '잘못된 상품 번호예요');
    const { rows } = await pool.query('SELECT * FROM shop_products WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, '상품을 찾을 수 없어요');
    res.json({ success: true, data: toProduct(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/categories', (_req, res) => {
  res.json({ success: true, data: ['전체', ...CATEGORIES] });
});

// ── API routes: 인증 ─────────────────────────
// body: { email, name, password }
app.post('/api/auth/signup', wrap(async (req, res) => {
  requireJwtSecret();
  const b = req.body || {};
  const email = toEmail(b.email);
  const name = toName(b.name);
  const password = toPassword(b.password);

  const { rows } = await pool.query(
    `INSERT INTO shop_users (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
    [email, name, await hashPassword(password)]
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

  const { rows: [user] } = await pool.query('SELECT id, email, name, password_hash FROM shop_users WHERE email = $1', [email]);
  const ok = await verifyPassword(password.slice(0, PASSWORD_MAX), user ? user.password_hash : await getDummyHash());
  // 이메일이 없는지 비밀번호가 틀렸는지는 구분해서 알려주지 않는다
  if (!user || !ok) throw new HttpError(401, '이메일 또는 비밀번호가 올바르지 않아요');
  res.json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
}));

app.get('/api/auth/me', requireAuth, wrap(async (req, res) => {
  const { rows: [user] } = await pool.query('SELECT id, email, name FROM shop_users WHERE id = $1', [req.userId]);
  if (!user) throw new HttpError(401, '탈퇴했거나 존재하지 않는 계정이에요');
  res.json({ success: true, data: publicUser(user) });
}));

// ── API routes: 장바구니 (로그인 필요) ─────────
app.get('/api/cart', requireAuth, wrap(async (req, res) => {
  res.json({ success: true, data: await getCart(req.userId) });
}));

// body: { productId, color, qty? } — 같은 상품·색상이 이미 있으면 수량을 더한다
app.post('/api/cart', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const productId = toId(b.productId);
  const qty = b.qty === undefined ? 1 : toQty(b.qty);

  const { rows: [product] } = await pool.query('SELECT colors FROM shop_products WHERE id = $1', [productId]);
  if (!product) throw new HttpError(404, '상품을 찾을 수 없어요');
  const color = b.color === undefined ? product.colors[0] : b.color;
  if (!product.colors.includes(color)) throw new HttpError(400, '선택할 수 없는 색상이에요');

  await pool.query(
    `INSERT INTO shop_cart_items (user_id, product_id, color, qty) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, product_id, color)
     DO UPDATE SET qty = LEAST(shop_cart_items.qty + EXCLUDED.qty, ${QTY_MAX})`,
    [req.userId, productId, color, qty]
  );
  res.status(201).json({ success: true, data: await getCart(req.userId) });
}));

// body: { qty }
app.patch('/api/cart/:id', requireAuth, wrap(async (req, res) => {
  const qty = toQty((req.body || {}).qty);
  const { rowCount } = await pool.query(
    'UPDATE shop_cart_items SET qty = $1 WHERE id = $2 AND user_id = $3',
    [qty, toId(req.params.id), req.userId]
  );
  if (!rowCount) throw new HttpError(404, '장바구니에 없는 상품이에요');
  res.json({ success: true, data: await getCart(req.userId) });
}));

app.delete('/api/cart/:id', requireAuth, wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM shop_cart_items WHERE id = $1 AND user_id = $2',
    [toId(req.params.id), req.userId]
  );
  if (!rowCount) throw new HttpError(404, '장바구니에 없는 상품이에요');
  res.json({ success: true, data: await getCart(req.userId) });
}));

// ── 404 for unknown API ──────────────────────
app.use('/api', (_req, _res, next) => next(new HttpError(404, '존재하지 않는 API 예요')));

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  if (!(err instanceof HttpError)) console.error(err);
  const status = err instanceof HttpError ? err.status : 500;
  res.status(status).json({ success: false, message: status === 500 && !(err instanceof HttpError) ? '서버 오류가 발생했어요' : err.message });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`🛍️  Shop server running on http://localhost:${PORT}`));
}
module.exports = app;
