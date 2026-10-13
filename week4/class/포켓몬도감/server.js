const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── In-memory store ──────────────────────────
const IMAGE_URL = (id) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;

const STAT_LABELS = {
  hp: 'HP', attack: '공격', defense: '방어',
  'special-attack': '특수공격', 'special-defense': '특수방어', speed: '스피드',
};

// stats 순서: HP, 공격, 방어, 특수공격, 특수방어, 스피드
const pokemons = [
  {
    id: 1, name: '씨앗꿍', nameEn: 'bulbasaur', genus: '씨앗포켓몬', generation: 1, types: ['grass', 'poison'],
    height: 0.7, weight: 6.9, stats: [45, 49, 49, 65, 65, 45],
    abilities: [{ name: '심록', hidden: false }, { name: '엽록소', hidden: true }],
    description: '태어났을 때부터 등에 이상한 씨앗이 심어져 있으며 몸과 함께 자란다.',
    evolution: [1, 2, 3],
  },
  {
    id: 2, name: '봉오리', nameEn: 'ivysaur', genus: '씨앗포켓몬', generation: 1, types: ['grass', 'poison'],
    height: 1.0, weight: 13.0, stats: [60, 62, 63, 80, 80, 60],
    abilities: [{ name: '심록', hidden: false }, { name: '엽록소', hidden: true }],
    description: '꽃봉오리가 등에 붙어 있으며 양분을 흡수하면 커다란 꽃이 핀다고 한다.',
    evolution: [1, 2, 3],
  },
  {
    id: 3, name: '꽃대장', nameEn: 'venusaur', genus: '씨앗포켓몬', generation: 1, types: ['grass', 'poison'],
    height: 2.0, weight: 100.0, stats: [80, 82, 83, 100, 100, 80],
    abilities: [{ name: '심록', hidden: false }, { name: '엽록소', hidden: true }],
    description: '큰 꽃잎을 펼치고 햇빛을 받으면 몸에 힘이 넘쳐흐른다.',
    evolution: [1, 2, 3],
  },
  {
    id: 4, name: '불꼬리', nameEn: 'charmander', genus: '도롱뇽포켓몬', generation: 1, types: ['fire'],
    height: 0.6, weight: 8.5, stats: [39, 52, 43, 60, 50, 65],
    abilities: [{ name: '맹화', hidden: false }, { name: '선파워', hidden: true }],
    description: '꼬리의 불꽃은 생명력의 상징이다. 기운이 넘치면 불꽃이 더 세게 타오른다.',
    evolution: [4, 5, 6],
  },
  {
    id: 5, name: '불발톱', nameEn: 'charmeleon', genus: '화염포켓몬', generation: 1, types: ['fire'],
    height: 1.1, weight: 19.0, stats: [58, 64, 58, 80, 65, 80],
    abilities: [{ name: '맹화', hidden: false }, { name: '선파워', hidden: true }],
    description: '날카로운 발톱으로 상대를 가차 없이 쓰러뜨린다. 강한 상대를 만나면 흥분해서 불꽃이 푸르게 타오른다.',
    evolution: [4, 5, 6],
  },
  {
    id: 6, name: '화룡왕', nameEn: 'charizard', genus: '화염포켓몬', generation: 1, types: ['fire', 'flying'],
    height: 1.7, weight: 90.5, stats: [78, 84, 78, 109, 85, 100],
    abilities: [{ name: '맹화', hidden: false }, { name: '선파워', hidden: true }],
    description: '강한 상대를 찾아 하늘을 날아다닌다. 무엇이든 녹여버리는 뜨거운 불꽃을 내뿜는다.',
    evolution: [4, 5, 6],
  },
  {
    id: 7, name: '물꼬마', nameEn: 'squirtle', genus: '꼬마거북포켓몬', generation: 1, types: ['water'],
    height: 0.5, weight: 9.0, stats: [44, 48, 65, 50, 64, 43],
    abilities: [{ name: '급류', hidden: false }, { name: '젖은접시', hidden: true }],
    description: '등껍질에 몸을 숨기고 입으로 물을 뿜어 반격한다.',
    evolution: [7, 8, 9],
  },
  {
    id: 8, name: '물결귀', nameEn: 'wartortle', genus: '거북포켓몬', generation: 1, types: ['water'],
    height: 1.0, weight: 22.5, stats: [59, 63, 80, 65, 80, 58],
    abilities: [{ name: '급류', hidden: false }, { name: '젖은접시', hidden: true }],
    description: '털로 덮인 꼬리는 장수의 상징으로 사랑받고 있다.',
    evolution: [7, 8, 9],
  },
  {
    id: 9, name: '물대포', nameEn: 'blastoise', genus: '껍질포켓몬', generation: 1, types: ['water'],
    height: 1.6, weight: 85.5, stats: [79, 83, 100, 85, 105, 78],
    abilities: [{ name: '급류', hidden: false }, { name: '젖은접시', hidden: true }],
    description: '등껍질의 분사구에서 뿜어내는 물줄기는 두꺼운 강철도 뚫을 만큼 강력하다.',
    evolution: [7, 8, 9],
  },
  {
    id: 25, name: '찌릿볼', nameEn: 'pikachu', genus: '쥐포켓몬', generation: 1, types: ['electric'],
    height: 0.4, weight: 6.0, stats: [35, 55, 40, 50, 50, 90],
    abilities: [{ name: '정전기', hidden: false }, { name: '피뢰침', hidden: true }],
    description: '볼의 전기 주머니에 전기를 모아 둔다. 위험을 느끼면 한꺼번에 방전한다.',
    evolution: [172, 25, 26],
  },
];

// 도감에 없지만 진화 단계에 표시할 포켓몬 이름
const EXTRA_NAMES = { 172: '찌릿콩', 26: '번개쥐' };

const byId = new Map(pokemons.map((p) => [p.id, p]));

function toSummary(p) {
  const { id, name, nameEn, genus, generation, types } = p;
  return { id, name, nameEn, genus, generation, types, image: IMAGE_URL(id) };
}

function toDetail(p) {
  const statKeys = Object.keys(STAT_LABELS);
  return {
    ...toSummary(p),
    isLegendary: false,
    isMythical: false,
    description: p.description,
    height: p.height,
    weight: p.weight,
    stats: p.stats.map((value, i) => ({ key: statKeys[i], label: STAT_LABELS[statKeys[i]], value })),
    abilities: p.abilities,
    evolution: p.evolution.map((id) => ({
      id,
      name: byId.get(id)?.name || EXTRA_NAMES[id] || '',
      image: IMAGE_URL(id),
      inDex: byId.has(id),
    })),
  };
}

// ── API routes ───────────────────────────────
app.get('/api/pokemon', (_req, res) => {
  res.json({ success: true, data: pokemons.map(toSummary) });
});

app.get('/api/pokemon/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, message: 'id는 1 이상의 정수여야 해요' });
  }
  const p = byId.get(id);
  if (!p) {
    return res.status(404).json({ success: false, message: '포켓몬 정보를 찾을 수 없어요' });
  }
  res.json({ success: true, data: toDetail(p) });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'API not found' });
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

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
