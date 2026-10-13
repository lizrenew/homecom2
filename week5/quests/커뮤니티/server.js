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
if (JWT_SECRET.length < 32) console.warn('⚠️  JWT_SECRET 환경변수가 없거나 너무 짧아요(32자 이상). 로그인·회원가입이 비활성화됩니다.');

const app = express();

// ── 입력 제한 ────────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_]{4,20}$/;
const NAME_MAX = 20;
const TITLE_MAX = 100;
const CONTENT_MAX = 10_000;

// ── 인증 설정 ────────────────────────────────
// 토큰: JWT(HS256) 를 Authorization: Bearer 헤더로 주고받는다. 만료되면 다시 로그인.
// 비밀번호: OWASP Password Storage Cheat Sheet 권장값의 scrypt (N=2^17, r=8, p=1) 로 해시한다.
const JWT_EXPIRES_IN = '7d';
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const SCRYPT_KEYLEN = 64;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const scrypt = promisify(crypto.scrypt);

// ── Seed data (가짜 데이터 → 회원이 한 명도 없을 때 한 번만 넣는다) ──
// 시드 계정도 실제로 로그인할 수 있다: 아이디 그대로 + 비밀번호 SEED_PASSWORD
const SEED_PASSWORD = 'password123';
const SEED_USERS = [
  ['minji', '김민지'],
  ['seojun', '박서준'],
  ['jiwoo', '이지우'],
  ['hayun', '최하윤'],
  ['dohyun', '정도현'],
];
// [작성자 아이디, 제목, 내용, 며칠 전, 몇 시간 전]
const SEED_POSTS = [
  ['minji', '커뮤니티 오픈했어요! 🎉', '안녕하세요, 여러분!\n오늘부터 커뮤니티가 열렸어요. 자유롭게 이야기 나눠 주세요.\n서로 존중하는 분위기 부탁드려요 :)', 20, 3],
  ['seojun', '가입 인사 드립니다', '안녕하세요, 박서준입니다.\n개발 공부하다가 들어왔어요. 잘 부탁드립니다!', 19, 6],
  ['jiwoo', '요즘 읽고 있는 책 추천', '「달러구트 꿈 백화점」 읽고 있는데 술술 읽혀요.\n가볍게 읽을 소설 찾는 분들께 추천합니다.', 18, 2],
  ['hayun', '점심 메뉴 고민…', '회사 근처에 맛집이 너무 없어요.\n다들 점심 보통 뭐 드세요? 도시락 싸 오시는 분 계신가요?', 17, 5],
  ['dohyun', '주말 등산 같이 가실 분?', '이번 주 토요일 북한산 가려고 해요.\n초보 코스로 천천히 갈 예정이라 부담 없이 오셔도 됩니다.', 16, 8],
  ['minji', 'React 처음 배우는데 useEffect가 어려워요', '의존성 배열을 언제 비워 두고 언제 채워야 하는지 헷갈려요.\n쉽게 이해하는 팁 있으면 알려 주세요!', 14, 1],
  ['seojun', 'Re: useEffect 팁', '"이 effect 안에서 쓰는 값은 전부 배열에 넣는다"부터 시작해 보세요.\n린트 규칙(eslint-plugin-react-hooks)을 켜 두면 많이 도와줘요.', 14, 0],
  ['jiwoo', '홈카페 입문했어요 ☕', '핸드드립 세트를 샀어요.\n원두는 에티오피아 예가체프로 시작했는데 산미가 좋네요.', 12, 4],
  ['hayun', '고양이 사진 자랑합니다', '우리 집 고양이 이름은 "두부"예요.\n하루 종일 창가에서 햇볕 쬐는 게 일과입니다 🐱', 11, 7],
  ['dohyun', '등산 후기 (사진 없음 주의)', '지난 토요일 다녀왔어요. 날씨가 정말 좋았습니다.\n같이 가 주신 분들 감사해요! 다음엔 관악산 어떠세요?', 10, 2],
  ['minji', '공부 습관 만드는 법 공유해요', '1. 매일 같은 시간에 시작하기\n2. 25분 집중 + 5분 휴식\n3. 오늘 한 일 세 줄로 기록하기\n3주째 지키고 있어요!', 9, 9],
  ['seojun', 'Supabase 써 보신 분?', 'Postgres를 바로 쓸 수 있어서 편하더라고요.\n무료 플랜으로 어디까지 쓸 수 있는지 궁금합니다.', 8, 3],
  ['jiwoo', '비 오는 날 듣기 좋은 노래', '아이유 - 비밀의 화원\n검정치마 - 기다린 만큼, 더\n잔잔한 노래 더 추천해 주세요 🌧️', 7, 6],
  ['hayun', '이번 달 가계부 정리 끝!', '고정 지출을 정리해 보니 구독료가 생각보다 많았어요.\n안 쓰는 구독 두 개 해지했습니다.', 6, 1],
  ['dohyun', '자취 요리 레시피: 계란 볶음밥', '파 기름 먼저 내고 → 계란 스크램블 → 밥 → 간장 한 숟갈.\n10분이면 완성이에요!', 5, 5],
  ['minji', '질문: JWT 토큰은 어디에 저장하나요?', 'localStorage 와 쿠키 중 어디에 두는 게 좋은지 의견이 갈리던데,\n다들 어떻게 하시나요?', 4, 2],
  ['seojun', '오늘의 회고', '버그 하나 잡는 데 세 시간 걸렸는데 원인은 오타였습니다…\n그래도 잡아서 뿌듯해요.', 3, 4],
  ['jiwoo', '전시회 다녀왔어요', '국립현대미술관 다녀왔는데 사람이 많지 않아 여유롭게 봤어요.\n평일 오전 추천합니다.', 2, 6],
  ['hayun', '다음 주 모임 장소 투표', '1) 강남역  2) 홍대입구  3) 온라인\n댓글 기능이 아직 없어서 글로 남겨 주세요 😅', 1, 3],
  ['dohyun', '커뮤니티 이용 꿀팁', '글 제목을 누르면 상세 내용을 볼 수 있고,\n내가 쓴 글에는 "내 글" 표시가 붙어요. 수정·삭제는 상세 화면에서!', 0, 1],
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
// 같은 Supabase DB 를 다른 앱들과 같이 쓰므로 테이블은 community_ 접두사로 구분한다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  if (!DATABASE_URL) throw new HttpError(500, 'DATABASE_URL 환경변수가 설정되지 않았어요');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 서버리스 cold start 가 동시에 여러 번 일어나도 스키마 변경이 겹치지 않게 잠근다
    await client.query("SELECT pg_advisory_xact_lock(hashtext('community_app_init'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS community_users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS community_posts (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS community_posts_created_idx ON community_posts(created_at DESC);
    `);

    const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM community_users');
    if (count === 0) await seed(client);

    await client.query('COMMIT');
    dbInitialized = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function seed(client) {
  const passwordHash = await hashPassword(SEED_PASSWORD); // 시드 계정은 같은 비밀번호라 한 번만 해시
  const ids = {};
  for (const [username, name] of SEED_USERS) {
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO community_users (username, name, password_hash, created_at)
       VALUES ($1, $2, $3, now() - interval '21 days') RETURNING id`,
      [username, name, passwordHash],
    );
    ids[username] = id;
  }
  for (const [username, title, content, days, hours] of SEED_POSTS) {
    await client.query(
      `INSERT INTO community_posts (user_id, title, content, created_at)
       VALUES ($1, $2, $3, now() - make_interval(days => $4, hours => $5))`,
      [ids[username], title, content, days, hours],
    );
  }
  console.log(`🌱 시드 데이터: 회원 ${SEED_USERS.length}명, 게시글 ${SEED_POSTS.length}개를 넣었어요`);
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

// 없는 아이디로 로그인해도 응답 시간이 같도록 비교용 더미 해시 (아이디 존재 여부 노출 방지)
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword(crypto.randomUUID()));

function requireJwtSecret() {
  if (JWT_SECRET.length < 32) throw new HttpError(503, '서버에 JWT_SECRET 이 설정되지 않아 로그인을 쓸 수 없어요');
}

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name });

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

function toUsername(raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!USERNAME_RE.test(v)) throw new HttpError(400, '아이디는 영문·숫자·밑줄 4~20자로 입력해주세요');
  return v;
}

function toPassword(raw) {
  if (typeof raw !== 'string' || raw.length < PASSWORD_MIN || raw.length > PASSWORD_MAX) {
    throw new HttpError(400, `비밀번호는 ${PASSWORD_MIN}~${PASSWORD_MAX}자로 입력해주세요`);
  }
  return raw;
}

// ── Helpers ──────────────────────────────────
function text(raw, { name, max }) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) throw new HttpError(400, `${name}을(를) 입력해주세요`);
  if (v.length > max) throw new HttpError(400, `${name}은(는) ${max}자 이하로 입력해주세요`);
  return v;
}

function toId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, '잘못된 id 예요');
  return n;
}

// 작성자 이름을 함께 꺼낸다
const POST_SELECT = `
  SELECT p.id, p.title, p.content, p.user_id AS "authorId", u.name AS "authorName",
         p.created_at AS "createdAt", p.updated_at AS "updatedAt"
  FROM community_posts p JOIN community_users u ON u.id = p.user_id`;

// 라우트 핸들러의 async 에러를 에러 미들웨어로 넘긴다
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Middleware ───────────────────────────────
// 정적 파일은 index.html 하나뿐이라 express.static 대신 아래 SPA fallback 으로만 보낸다
// (폴더 전체를 static 으로 열면 server.js·package.json 까지 노출된다)
app.use(express.json());

app.use('/api', wrap(async (_req, _res, next) => {
  await initDB();
  next();
}));

// ── API: 인증 (토큰 없이 접근 가능) ───────────
// body: { username, name, password }
app.post('/api/auth/signup', wrap(async (req, res) => {
  requireJwtSecret();
  const b = req.body || {};
  const username = toUsername(b.username);
  const name = text(b.name, { name: '이름', max: NAME_MAX });
  const password = toPassword(b.password);

  const { rows } = await pool.query(
    `INSERT INTO community_users (username, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO NOTHING RETURNING id, username, name`,
    [username, name, await hashPassword(password)],
  );
  if (!rows.length) throw new HttpError(409, '이미 사용 중인 아이디예요');
  const user = rows[0];
  res.status(201).json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
}));

// body: { username, password }
app.post('/api/auth/login', wrap(async (req, res) => {
  requireJwtSecret();
  const b = req.body || {};
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!username || !password) throw new HttpError(400, '아이디와 비밀번호를 입력해주세요');

  const { rows: [user] } = await pool.query('SELECT id, username, name, password_hash FROM community_users WHERE username = $1', [username]);
  const ok = await verifyPassword(password.slice(0, PASSWORD_MAX), user ? user.password_hash : await getDummyHash());
  // 아이디가 없는지 비밀번호가 틀렸는지는 구분해서 알려주지 않는다
  if (!user || !ok) throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않아요');
  res.json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
}));

// ── 여기부터는 로그인한 사용자만 ──────────────
app.use('/api', (req, res, next) => (req.path.startsWith('/auth/') && req.path !== '/auth/me' ? next() : requireAuth(req, res, next)));

app.get('/api/auth/me', wrap(async (req, res) => {
  const { rows: [user] } = await pool.query('SELECT id, username, name FROM community_users WHERE id = $1', [req.userId]);
  if (!user) throw new HttpError(401, '탈퇴했거나 존재하지 않는 계정이에요');
  res.json({ success: true, data: publicUser(user) });
}));

// ── API: 게시글 ──────────────────────────────
// 목록: 최신순, 본문은 빼고 보낸다
app.get('/api/posts', wrap(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.user_id AS "authorId", u.name AS "authorName", p.created_at AS "createdAt"
     FROM community_posts p JOIN community_users u ON u.id = p.user_id
     ORDER BY p.created_at DESC, p.id DESC`,
  );
  res.json({ success: true, data: rows });
}));

app.get('/api/posts/:id', wrap(async (req, res) => {
  const { rows: [post] } = await pool.query(`${POST_SELECT} WHERE p.id = $1`, [toId(req.params.id)]);
  if (!post) throw new HttpError(404, '게시글을 찾을 수 없어요');
  res.json({ success: true, data: post });
}));

// body: { title, content }
app.post('/api/posts', wrap(async (req, res) => {
  const b = req.body || {};
  const title = text(b.title, { name: '제목', max: TITLE_MAX });
  const content = text(b.content, { name: '내용', max: CONTENT_MAX });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO community_posts (user_id, title, content) VALUES ($1, $2, $3) RETURNING id',
    [req.userId, title, content],
  );
  const { rows: [post] } = await pool.query(`${POST_SELECT} WHERE p.id = $1`, [id]);
  res.status(201).json({ success: true, data: post });
}));

// 존재하지 않음(404)과 남의 글(403)을 구분해서 알려준다
async function assertOwner(postId, userId) {
  const { rows: [post] } = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [postId]);
  if (!post) throw new HttpError(404, '게시글을 찾을 수 없어요');
  if (post.user_id !== userId) throw new HttpError(403, '본인이 작성한 글만 수정·삭제할 수 있어요');
}

app.put('/api/posts/:id', wrap(async (req, res) => {
  const id = toId(req.params.id);
  const b = req.body || {};
  const title = text(b.title, { name: '제목', max: TITLE_MAX });
  const content = text(b.content, { name: '내용', max: CONTENT_MAX });
  await assertOwner(id, req.userId);
  await pool.query(
    'UPDATE community_posts SET title = $1, content = $2, updated_at = now() WHERE id = $3 AND user_id = $4',
    [title, content, id, req.userId],
  );
  const { rows: [post] } = await pool.query(`${POST_SELECT} WHERE p.id = $1`, [id]);
  res.json({ success: true, data: post });
}));

app.delete('/api/posts/:id', wrap(async (req, res) => {
  const id = toId(req.params.id);
  await assertOwner(id, req.userId);
  await pool.query('DELETE FROM community_posts WHERE id = $1 AND user_id = $2', [id, req.userId]);
  res.json({ success: true, data: { id } });
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
  app.listen(PORT, () => console.log(`커뮤니티 서버 실행 중 → http://localhost:${PORT}`));
}
module.exports = app;
