const express = require('express');
const path = require('path');

// 로컬: .env 에서 GEMINI_API_KEY 로드 / Vercel: 프로젝트 환경변수 사용
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

// ── Nano Banana config ───────────────────────
const MODEL = 'gemini-2.5-flash-image';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// 클라이언트는 id만 보내고, 실제 프롬프트 문구는 서버에서 조립한다
const FILMS = {
  trix: 'Kodak Tri-X 400 black and white film, deep blacks, punchy contrast, visible silver-halide grain',
  mono: 'Leica M Monochrom sensor, smooth tonal gradation, rich midtones, fine-grained black and white',
  portra: 'Kodak Portra 400 color negative film, warm natural skin tones, soft pastel highlights, gentle grain',
  cinestill: 'CineStill 800T tungsten film, cool teal shadows, red halation glow around lights, night city mood',
  ektachrome: 'Kodak Ektachrome E100 slide film, crisp saturated colors, clean blue skies, fine grain',
  leicacolor: 'Leica M11 digital color rendering, subtle muted tones, natural color science, high micro-contrast',
};

const LENSES = {
  '35lux': 'Leica Summilux-M 35mm f/1.4, natural perspective, gentle falloff',
  '50nocti': 'Leica Noctilux-M 50mm f/0.95 wide open, razor-thin focus plane, dreamy creamy bokeh, glowing highlights',
  '28cron': 'Leica Summicron-M 28mm f/2, wider street-photography framing, sharp edge to edge',
  '90apo': 'Leica APO-Summicron-M 90mm f/2, compressed portrait perspective, smooth background separation',
};

const RATIOS = ['3:2', '2:3', '1:1', '4:5', '16:9'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

function buildPrompt({ subject, film, lens, hasReference }) {
  const base = hasReference
    ? `Re-imagine the attached photo as if it were taken on a Leica M rangefinder camera. Keep the same subject, composition and scene${subject ? `, with this direction: ${subject}` : ''}.`
    : `A candid, authentic photograph of: ${subject}. Taken on a Leica M rangefinder camera.`;
  return [
    base,
    `Lens: ${lens}.`,
    `Look: ${film}.`,
    'Signature Leica rendering: 3D pop, high micro-contrast, natural available light, decisive-moment street photography feel.',
    'Photorealistic, not illustrated, not CGI. No text, no watermark, no borders.',
  ].join(' ');
}

// ── Middleware ───────────────────────────────
// 참고 사진(base64)이 실리므로 한도를 늘린다. Vercel 요청 본문 상한은 4.5MB.
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname), { dotfiles: 'deny' }));

// ── API routes ───────────────────────────────
app.post('/api/generate', async (req, res, next) => {
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(500).json({ success: false, message: '서버에 GEMINI_API_KEY가 설정되지 않았어요' });
    }

    const { subject = '', filmId, lensId, aspectRatio, reference } = req.body || {};
    const text = String(subject).trim();
    if (text.length > 500) return res.status(400).json({ success: false, message: '묘사는 500자 이하로 입력해주세요' });
    if (!text && !reference) return res.status(400).json({ success: false, message: '장면을 묘사하거나 사진을 올려주세요' });
    if (!FILMS[filmId]) return res.status(400).json({ success: false, message: '알 수 없는 필름이에요' });
    if (!LENSES[lensId]) return res.status(400).json({ success: false, message: '알 수 없는 렌즈예요' });
    if (!RATIOS.includes(aspectRatio)) return res.status(400).json({ success: false, message: '지원하지 않는 비율이에요' });
    if (reference && (!IMAGE_TYPES.includes(reference.mimeType) || typeof reference.data !== 'string')) {
      return res.status(400).json({ success: false, message: '참고 사진 형식이 올바르지 않아요' });
    }

    const parts = [{ text: buildPrompt({ subject: text, film: FILMS[filmId], lens: LENSES[lensId], hasReference: !!reference }) }];
    if (reference) parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.data } });

    const gRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } },
      }),
    });
    const json = await gRes.json().catch(() => ({}));

    if (!gRes.ok) {
      console.error('Gemini error', gRes.status, json.error?.message);
      if (gRes.status === 429) return res.status(429).json({ success: false, message: '요청이 너무 많아요. 잠시 후 다시 시도해주세요.' });
      return res.status(502).json({ success: false, message: '이미지 생성 서비스에서 오류가 났어요' });
    }

    const img = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!img) {
      return res.status(422).json({ success: false, message: '이미지가 생성되지 않았어요. 묘사를 바꿔 다시 시도해주세요.' });
    }
    res.json({ success: true, data: { image: `data:${img.inlineData.mimeType};base64,${img.inlineData.data}` } });
  } catch (err) { next(err); }
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: '사진 용량이 너무 커요 (3MB 이하)' });
  }
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
