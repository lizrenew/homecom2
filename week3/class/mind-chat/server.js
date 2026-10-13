const express = require('express');
const path = require('path');

// ── Env (.env 는 로컬 전용, Vercel 에서는 대시보드 환경변수 사용) ──
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // .env 가 없으면 이미 설정된 환경변수를 그대로 사용
}

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const MAX_CONTEXT = 20;       // OpenAI 로 보내는 최근 메시지 수
const MAX_CONTENT_LEN = 2000; // 메시지 1개당 최대 글자 수
const RATE_LIMIT = 20;        // IP 당 1분 최대 요청 수

// 시스템 프롬프트는 서버에만 둔다 (클라이언트가 바꿀 수 없게)
const SYSTEM_PROMPT = `당신은 "마음쉼표"라는 이름의 따뜻하고 공감적인 AI 심리상담 동반자입니다.
- 한국어로, 차분하고 존중하는 존댓말을 사용하세요.
- 먼저 상대의 감정을 알아차리고 반영(공감)한 뒤, 열린 질문으로 이야기를 이어가도록 돕습니다.
- 섣부른 조언이나 판단을 피하고, 필요할 때 인지행동치료(CBT)·마음챙김 기반의 간단한 기법(호흡, 생각 다시보기 등)을 제안할 수 있습니다.
- 답변은 3~6문장 정도로 간결하게 합니다.
- 당신은 전문 상담사나 의사가 아니며 진단·처방을 하지 않습니다. 필요하면 전문가 상담을 부드럽게 권하세요.
- 자해·자살 생각, 타인을 해칠 위험, 학대 등 위기 신호가 보이면 안전을 최우선으로 하여 진심으로 걱정을 표현하고,
  자살예방상담전화 109, 정신건강위기상담 1577-0199, 긴급 시 119/112 에 바로 연락하도록 안내하세요.`;

// ── In-memory store (IP별 요청 기록) ─────────
const hits = new Map(); // ip -> [timestamp, ...]

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '100kb' }));

function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= RATE_LIMIT) {
    return res.status(429).json({ success: false, message: '요청이 너무 많아요. 1분 뒤에 다시 시도해 주세요.' });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}

// ── API routes ───────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { configured: !!OPENAI_API_KEY, model: OPENAI_MODEL } });
});

app.post('/api/chat', rateLimit, async (req, res, next) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ success: false, message: '서버에 OPENAI_API_KEY 가 설정되지 않았어요.' });
    }

    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'messages 배열이 필요해요.' });
    }

    // user/assistant 만 허용 (system 메시지 주입 차단), 길이 제한
    const clean = messages.slice(-MAX_CONTEXT).map((m) => ({ role: m?.role, content: m?.content }));
    const valid = clean.every(
      (m) => (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.trim() && m.content.length <= MAX_CONTENT_LEN
    );
    if (!valid || clean[clean.length - 1].role !== 'user') {
      return res.status(400).json({ success: false, message: `메시지 형식이 올바르지 않거나 너무 길어요 (최대 ${MAX_CONTENT_LEN}자).` });
    }

    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.7,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...clean],
      }),
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      // OpenAI 원본 에러는 서버 로그에만 남기고, 클라이언트엔 일반화된 메시지만
      console.error('OpenAI error', r.status, data?.error?.message);
      const message = r.status === 429
        ? 'AI 서비스 사용량이 많아요. 잠시 후 다시 시도해 주세요.'
        : 'AI 응답을 받지 못했어요. 잠시 후 다시 시도해 주세요.';
      return res.status(502).json({ success: false, message });
    }

    const reply = data.choices?.[0]?.message?.content?.trim() || '죄송해요, 답변을 만들지 못했어요.';
    res.json({ success: true, data: { reply } });
  } catch (err) {
    next(err);
  }
});

// ── Static / SPA fallback (index.html 만 서빙: .env·server.js 노출 방지) ──
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: '대화가 너무 길어요. 새 대화를 시작해 주세요.' });
  }
  res.status(500).json({ success: false, message: '서버 오류가 발생했어요.' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`마음쉼표 서버: http://localhost:${PORT}`);
    if (!OPENAI_API_KEY) console.warn('⚠️  OPENAI_API_KEY 가 없습니다. .env 파일을 만들어 주세요.');
  });
}
module.exports = app;
