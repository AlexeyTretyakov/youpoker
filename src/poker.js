// Движок Техасского Холдема: колода, оценка руки из 7 карт.

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['s', 'h', 'd', 'c']; // spades, hearts, diamonds, clubs

const RANK_VAL = Object.fromEntries(RANKS.map((r, i) => [r, i + 2])); // 2..14

export function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Категории комбинаций (чем больше — тем сильнее)
export const CATEGORY = {
  1: 'Старшая карта',
  2: 'Пара',
  3: 'Две пары',
  4: 'Тройка',
  5: 'Стрит',
  6: 'Флеш',
  7: 'Фулл-хаус',
  8: 'Каре',
  9: 'Стрит-флеш',
};

// Оценивает лучшую 5-карточную руку из 7 карт.
// Возвращает { cat, tiebreak: [...], name } — сравнивать лексикографически по [cat, ...tiebreak].
export function evaluate7(cards) {
  const codes = cards.map((c) => ({ v: RANK_VAL[c[0]], s: c[1] }));
  let best = null;
  const combos = kCombinations(codes, 5);
  for (const combo of combos) {
    const score = score5(combo);
    if (!best || cmpScore(score, best) > 0) best = score;
  }
  return best;
}

function cmpScore(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  for (let i = 0; i < a.tiebreak.length; i++) {
    if (a.tiebreak[i] !== b.tiebreak[i]) return a.tiebreak[i] - b.tiebreak[i];
  }
  return 0;
}
export { cmpScore };

function score5(cards) {
  const vs = cards.map((c) => c.v).sort((a, b) => b - a);
  const ss = cards.map((c) => c.s);
  const isFlush = ss.every((s) => s === ss[0]);

  // счётчик рангов
  const counts = {};
  for (const v of vs) counts[v] = (counts[v] || 0) + 1;
  // сортируем ранги: сначала по количеству, потом по значению
  const groups = Object.entries(counts)
    .map(([v, c]) => ({ v: +v, c }))
    .sort((a, b) => b.c - a.c || b.v - a.v);

  // стрит (учёт колеса A-2-3-4-5)
  const uniq = [...new Set(vs)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // колесо
  }

  if (isFlush && straightHigh) return { cat: 9, tiebreak: [straightHigh], name: CATEGORY[9] };
  if (groups[0].c === 4) return { cat: 8, tiebreak: [groups[0].v, groups[1].v], name: CATEGORY[8] };
  if (groups[0].c === 3 && groups[1].c === 2) return { cat: 7, tiebreak: [groups[0].v, groups[1].v], name: CATEGORY[7] };
  if (isFlush) return { cat: 6, tiebreak: vs, name: CATEGORY[6] };
  if (straightHigh) return { cat: 5, tiebreak: [straightHigh], name: CATEGORY[5] };
  if (groups[0].c === 3) return { cat: 4, tiebreak: [groups[0].v, ...groups.slice(1).map((g) => g.v)], name: CATEGORY[4] };
  if (groups[0].c === 2 && groups[1].c === 2) {
    const pairs = [groups[0].v, groups[1].v].sort((a, b) => b - a);
    return { cat: 3, tiebreak: [...pairs, groups[2].v], name: CATEGORY[3] };
  }
  if (groups[0].c === 2) return { cat: 2, tiebreak: [groups[0].v, ...groups.slice(1).map((g) => g.v)], name: CATEGORY[2] };
  return { cat: 1, tiebreak: vs, name: CATEGORY[1] };
}

function kCombinations(arr, k) {
  const res = [];
  const n = arr.length;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    res.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return res;
}
