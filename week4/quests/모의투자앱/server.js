const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// ── Config (환경변수) ─────────────────────────
// 비밀값·설정은 전부 서버 환경변수로만 읽는다. 클라이언트(index.html)에는 절대 넣지 않는다.
// 로컬: .env 파일 (.env.example 참고) / Vercel: 프로젝트 Settings → Environment Variables
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) {}

const env = (key, fallback = '') => (process.env[key] ?? fallback).trim();

const DATABASE_URL = env('DATABASE_URL');
const UPBIT_API_URL = env('UPBIT_API_URL', 'https://api.upbit.com/v1').replace(/\/+$/, '');
const PORT = env('PORT', '3000');

if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL 환경변수가 없어요. .env.example 을 .env 로 복사해 값을 넣어주세요.');

const app = express();

const INITIAL_CASH = 1_000_000;
const MIN_ORDER_KRW = 5_000;
const UPBIT_TICKER_URL = `${UPBIT_API_URL}/ticker`;
const UPBIT_CANDLES_URL = `${UPBIT_API_URL}/candles/minutes/60`;
const MARKET_PATTERN = /^KRW-[A-Z0-9]{1,10}$/;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── DB lazy init ─────────────────────────────
// wallet: currency='KRW' 행이 현금, 나머지 행(BTC, ETH …)이 보유 코인
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  if (!DATABASE_URL) throw new HttpError(500, 'DATABASE_URL 환경변수가 설정되지 않았어요');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet (
      currency TEXT PRIMARY KEY,
      balance NUMERIC NOT NULL DEFAULT 0,
      avg_price NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      market TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      qty NUMERIC NOT NULL,
      price NUMERIC NOT NULL,
      amount NUMERIC NOT NULL,
      memo TEXT NOT NULL DEFAULT ''
    );
  `);
  await pool.query(
    `INSERT INTO wallet (currency, balance) VALUES ('KRW', $1) ON CONFLICT (currency) DO NOTHING`,
    [INITIAL_CASH]
  );
  dbInitialized = true;
}

// ── Helpers ──────────────────────────────────
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const floor8 = (n) => Math.floor(n * 1e8) / 1e8;

// 업비트 현재가 조회 (여러 마켓 한 번에) → { 'KRW-BTC': ticker, ... }
async function fetchTickers(markets) {
  if (!markets.length) return {};
  const upbitRes = await fetch(`${UPBIT_TICKER_URL}?markets=${markets.join(',')}`, {
    headers: { accept: 'application/json' },
  });
  if (upbitRes.status === 404) throw new HttpError(404, `존재하지 않는 마켓이에요: ${markets.join(', ')}`);
  if (!upbitRes.ok) throw new HttpError(502, `시세 조회 실패 (업비트 ${upbitRes.status})`);
  const list = await upbitRes.json();
  return Object.fromEntries(list.map((t) => [t.market, t]));
}

function formatTicker(t) {
  return {
    market: t.market,
    price: t.trade_price,
    change: t.change,                 // RISE | EVEN | FALL
    changePrice: t.signed_change_price,
    changeRate: t.signed_change_rate, // 0.0123 = +1.23%
    high: t.high_price,
    low: t.low_price,
    volume24h: t.acc_trade_price_24h,
    timestamp: t.timestamp,
  };
}

function parseMarket(raw) {
  const market = String(raw || '').trim().toUpperCase();
  if (!MARKET_PATTERN.test(market)) throw new HttpError(400, 'market 형식이 올바르지 않아요 (예: KRW-BTC)');
  return market;
}

// ── Middleware ───────────────────────────────
app.use(express.json());
// 폴더 전체를 static 으로 열면 server.js·package.json·node_modules 까지 브라우저에서 받아갈 수 있다.
// 클라이언트에 필요한 건 index.html 하나뿐이므로 아래 SPA fallback 으로만 서빙한다.

app.use('/api', async (req, res, next) => {
  if (['/price', '/prices', '/candles'].includes(req.path)) return next(); // 시세 조회는 DB 불필요
  try {
    await initDB();
    next();
  } catch (err) {
    console.error(err);
    const message = err instanceof HttpError ? err.message : 'Database initialization failed';
    res.status(500).json({ success: false, message });
  }
});

// ── API routes ───────────────────────────────
// GET /api/price?market=KRW-BTC → 업비트 현재가 (단일)
app.get('/api/price', async (req, res, next) => {
  try {
    const market = parseMarket(req.query.market);
    const t = (await fetchTickers([market]))[market];
    if (!t) throw new HttpError(404, `존재하지 않는 마켓이에요: ${market}`);
    res.json({ success: true, data: formatTicker(t) });
  } catch (err) { next(err); }
});

// GET /api/prices?markets=KRW-BTC,KRW-ETH → 여러 마켓 현재가를 업비트 1회 호출로
app.get('/api/prices', async (req, res, next) => {
  try {
    const markets = [...new Set(String(req.query.markets || '').split(',').filter(Boolean).map(parseMarket))];
    if (!markets.length) throw new HttpError(400, 'markets 를 입력해주세요 (예: KRW-BTC,KRW-ETH)');
    if (markets.length > 20) throw new HttpError(400, '한 번에 20개 마켓까지 조회할 수 있어요');
    const tickers = await fetchTickers(markets);
    res.json({ success: true, data: markets.filter((m) => tickers[m]).map((m) => formatTicker(tickers[m])) });
  } catch (err) { next(err); }
});

// GET /api/candles?market=KRW-BTC&count=200 → 1시간 캔들 (오래된 → 최신 순)
app.get('/api/candles', async (req, res, next) => {
  try {
    const market = parseMarket(req.query.market);
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 200, 1), 200);
    const upbitRes = await fetch(`${UPBIT_CANDLES_URL}?market=${market}&count=${count}`, {
      headers: { accept: 'application/json' },
    });
    if (upbitRes.status === 404) throw new HttpError(404, `존재하지 않는 마켓이에요: ${market}`);
    if (!upbitRes.ok) throw new HttpError(502, `캔들 조회 실패 (업비트 ${upbitRes.status})`);
    const list = await upbitRes.json();
    res.json({
      success: true,
      data: list.reverse().map((c) => ({
        time: c.candle_date_time_kst, // "2026-10-14T01:00:00" (KST)
        open: c.opening_price,
        high: c.high_price,
        low: c.low_price,
        close: c.trade_price,
        volume: c.candle_acc_trade_volume,
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/wallet → 현금 + 보유 코인 평가액 + 수익률
app.get('/api/wallet', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT currency, balance, avg_price FROM wallet WHERE balance > 0 OR currency = $1', ['KRW']);
    const cash = Number(rows.find((r) => r.currency === 'KRW')?.balance || 0);
    const coins = rows.filter((r) => r.currency !== 'KRW');
    const tickers = await fetchTickers(coins.map((c) => `KRW-${c.currency}`));

    const holdings = coins.map((c) => {
      const market = `KRW-${c.currency}`;
      const qty = Number(c.balance);
      const avgPrice = Number(c.avg_price);
      const price = tickers[market]?.trade_price ?? avgPrice;
      const value = qty * price;
      const cost = qty * avgPrice;
      return { market, currency: c.currency, qty, avgPrice, price, value, profit: value - cost, profitRate: cost ? (value - cost) / cost : 0 };
    });
    const coinValue = holdings.reduce((sum, h) => sum + h.value, 0);
    const total = cash + coinValue;

    res.json({
      success: true,
      data: {
        initialCash: INITIAL_CASH,
        cash,
        coinValue,
        total,
        profit: total - INITIAL_CASH,
        returnRate: (total - INITIAL_CASH) / INITIAL_CASH,
        holdings,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/orders?limit=50 → 주문 내역 (최신순)
app.get('/api/orders', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT $1', [limit]);
    res.json({
      success: true,
      data: rows.map((o) => ({ ...o, qty: Number(o.qty), price: Number(o.price), amount: Number(o.amount) })),
    });
  } catch (err) { next(err); }
});

// POST /api/order { market, side: 'buy'|'sell', qty?, amount?, memo? }
// 매수는 qty(코인 수량) 또는 amount(원화 금액), 매도는 qty 로 주문 → 현재가로 즉시 체결
app.post('/api/order', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { side, qty: rawQty, amount: rawAmount, memo = '' } = req.body || {};
    const market = parseMarket(req.body?.market);
    if (side !== 'buy' && side !== 'sell') throw new HttpError(400, "side 는 'buy' 또는 'sell' 이어야 해요");
    if (String(memo).length > 200) throw new HttpError(400, '메모는 200자 이하로 입력해주세요');

    const t = (await fetchTickers([market]))[market];
    if (!t) throw new HttpError(404, `존재하지 않는 마켓이에요: ${market}`);
    const price = t.trade_price;

    let qty;
    if (rawQty !== undefined && rawQty !== '') qty = floor8(Number(rawQty));
    else if (side === 'buy' && rawAmount !== undefined) qty = floor8(Number(rawAmount) / price);
    else throw new HttpError(400, side === 'buy' ? 'qty 또는 amount 를 입력해주세요' : 'qty 를 입력해주세요');
    if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, '주문 수량이 올바르지 않아요');

    const amount = Math.round(qty * price);
    if (amount < MIN_ORDER_KRW) throw new HttpError(400, `최소 주문 금액은 ${MIN_ORDER_KRW.toLocaleString()}원이에요`);

    const currency = market.split('-')[1];
    await client.query('BEGIN');
    await client.query(`INSERT INTO wallet (currency, balance) VALUES ($1, 0) ON CONFLICT (currency) DO NOTHING`, [currency]);
    const { rows } = await client.query(
      'SELECT currency, balance, avg_price FROM wallet WHERE currency IN ($1, $2) FOR UPDATE',
      ['KRW', currency]
    );
    const cash = Number(rows.find((r) => r.currency === 'KRW').balance);
    const coin = rows.find((r) => r.currency === currency);
    const held = Number(coin.balance);

    if (side === 'buy') {
      if (amount > cash) throw new HttpError(400, `현금이 부족해요 (필요 ${amount.toLocaleString()}원 / 보유 ${Math.floor(cash).toLocaleString()}원)`);
      const newQty = held + qty;
      const avgPrice = (Number(coin.avg_price) * held + amount) / newQty;
      await client.query('UPDATE wallet SET balance = balance - $1, updated_at = now() WHERE currency = $2', [amount, 'KRW']);
      await client.query('UPDATE wallet SET balance = balance + $1, avg_price = $2, updated_at = now() WHERE currency = $3', [qty, avgPrice, currency]);
    } else {
      if (qty > held) throw new HttpError(400, `보유 수량이 부족해요 (보유 ${held} ${currency})`);
      await client.query('UPDATE wallet SET balance = balance + $1, updated_at = now() WHERE currency = $2', [amount, 'KRW']);
      await client.query(
        `UPDATE wallet SET balance = balance - $1,
           avg_price = CASE WHEN balance - $1 <= 0 THEN 0 ELSE avg_price END,
           updated_at = now()
         WHERE currency = $2`,
        [qty, currency]
      );
    }

    const { rows: [order] } = await client.query(
      `INSERT INTO orders (market, side, qty, price, amount, memo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [market, side, qty, price, amount, String(memo).trim()]
    );
    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      data: { ...order, qty: Number(order.qty), price: Number(order.price), amount: Number(order.amount) },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/wallet/reset → 현금 1,000,000원으로 초기화 + 주문 내역 삭제
app.post('/api/wallet/reset', async (_req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM orders');
    await client.query('DELETE FROM wallet');
    await client.query(`INSERT INTO wallet (currency, balance) VALUES ('KRW', $1)`, [INITIAL_CASH]);
    await client.query('COMMIT');
    res.json({ success: true, data: { cash: INITIAL_CASH } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message });
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app
    .listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))
    .on('error', (err) => {
      if (err.code !== 'EADDRINUSE') throw err;
      console.error(`❌ ${PORT} 포트를 다른 앱이 쓰고 있어요. 다른 포트로 실행하세요: PORT=3100 npm start (PowerShell: $env:PORT=3100; npm start)`);
      process.exit(1);
    });
}
module.exports = app;
