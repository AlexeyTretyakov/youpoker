// Клиент покерного мини-аппа.
const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand();

const socket = io();
let me = null;
let state = null;
let currentTable = null;

const $ = (id) => document.getElementById(id);
const show = (id) => { document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden')); $(id).classList.remove('hidden'); };

// --- авторизация ---
function devFallbackUser() {
  let id = localStorage.getItem('devId');
  if (!id) { id = Math.random().toString(36).slice(2, 8); localStorage.setItem('devId', id); }
  const name = localStorage.getItem('devName') || ('Гость-' + id.slice(0, 3));
  return { id, name };
}

socket.on('connect', () => {
  const payload = {};
  if (tg?.initData) payload.initData = tg.initData;
  else payload.devUser = devFallbackUser();
  socket.emit('hello', payload, (res) => {
    if (res.ok) { me = res.user; $('hi').textContent = `Привет, ${me.name}!`; handleDeepLink(); }
    else $('hi').textContent = res.err;
  });
});

// Стол по startapp-параметру (?tgWebAppStartParam) или ?table=
function handleDeepLink() {
  let code = null;
  const sp = tg?.initDataUnsafe?.start_param;
  if (sp) code = sp;
  const url = new URL(location.href);
  code = code || url.searchParams.get('table');
  if (code) doJoin(code);
}

// --- лобби ---
$('btnCreate').onclick = () => show('createScreen');
$('btnCreateBack').onclick = () => show('lobby');
$('btnCreateGo').onclick = () => {
  const opts = {
    smallBlind: +$('cfgSb').value || 10,
    bigBlind: +$('cfgBb').value || 20,
    buyIn: +$('cfgBuy').value || 1000,
  };
  socket.emit('createTable', opts, (res) => {
    if (!res.ok) return alert(res.err);
    doJoin(res.tableId);
  });
};
$('btnJoin').onclick = () => {
  const code = $('joinCode').value.trim().toUpperCase();
  if (!code) return;
  doJoin(code);
};

function doJoin(code) {
  socket.emit('joinTable', { tableId: code }, (res) => {
    if (!res.ok) { $('lobbyErr').textContent = res.err; return; }
    currentTable = res.tableId;
    show('game');
  });
}

// --- игровые действия ---
$('btnStart').onclick = () => socket.emit('startHand', {}, (r) => { if (!r.ok) toast(r.err); });
$('btnLeave').onclick = () => socket.emit('leaveTable', {}, () => { currentTable = null; show('lobby'); });
$('btnInvite').onclick = () => {
  const botLink = window.BOT_LINK; // если задан — красивая startapp-ссылка
  const link = `${location.origin}${location.pathname}?table=${currentTable}`;
  const text = `Заходи в покер! Код стола: ${currentTable}`;
  if (tg?.switchInlineQuery) {
    // делимся ссылкой через Telegram
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    tg.openTelegramLink ? tg.openTelegramLink(shareUrl) : window.open(shareUrl);
  } else if (navigator.share) {
    navigator.share({ text, url: link });
  } else {
    navigator.clipboard?.writeText(link);
    toast('Ссылка скопирована: код ' + currentTable);
  }
};

document.querySelectorAll('#actions .btn').forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.a;
    if (a === 'raise') return openRaise();
    socket.emit('action', { action: a }, (r) => { if (!r.ok) toast(r.err); });
  };
});

// --- рейз-слайдер ---
let raiseOpen = false; // открыт ли слайдер ставки (чтобы ре-рендер его не сбивал)

function openRaise() {
  const you = state.you;
  const max = you.stack + you.bet;                       // максимум = олл-ин
  let min = state.currentBet + state.minRaise;           // минимальный рейз/бет
  if (min > max) min = max;                              // короткий стек — ставка = олл-ин
  const range = $('raiseRange');
  range.min = min; range.max = max;
  range.step = state.bigBlind >= 1 ? Math.max(1, Math.floor(state.bigBlind / 2)) : 1;
  range.value = min;
  $('raiseVal').textContent = min;
  raiseOpen = true;
  $('actions').classList.add('hidden');
  $('raiseBox').classList.remove('hidden');
}
function closeRaise() {
  raiseOpen = false;
  $('raiseBox').classList.add('hidden');
  $('actions').classList.remove('hidden');
}
$('raiseRange').oninput = (e) => { $('raiseVal').textContent = e.target.value; };
$('raiseCancel').onclick = () => closeRaise();
$('raiseGo').onclick = () => {
  const amount = +$('raiseRange').value;
  socket.emit('action', { action: 'raise', amount }, (r) => { if (!r.ok) toast(r.err); });
  closeRaise();
};

// --- рендер ---
socket.on('state', (s) => { state = s; render(); });

const suitMap = { s: '♠', h: '♥', d: '♦', c: '♣' };
function cardEl(code, mini) {
  const d = document.createElement('div');
  d.className = 'card' + (mini ? ' mini' : '');
  if (!code || code === '??') { d.classList.add('back'); return d; }
  const rank = code[0] === 'T' ? '10' : code[0];
  const suit = code[1];
  d.textContent = rank + suitMap[suit];
  if (suit === 'h' || suit === 'd') d.classList.add('red');
  return d;
}

// позиции 6 мест по эллипсу (проценты внутри .felt)
const SEAT_XY = [
  [50, 92], [12, 72], [12, 30], [50, 8], [88, 30], [88, 72],
];

function render() {
  if (!state) return;
  $('tCode').textContent = 'Стол ' + state.id;
  $('tBlinds').textContent = `Блайнды ${state.smallBlind}/${state.bigBlind}`;
  $('phase').textContent = state.phaseLabel;
  $('pot').textContent = state.pot > 0 ? `Банк: ${state.pot}` : '';

  // борд
  const board = $('board'); board.innerHTML = '';
  state.board.forEach((c) => board.appendChild(cardEl(c)));

  // места: находим мой индекс, чтобы посадить себя внизу
  const myIdx = state.seats.findIndex((p) => p && p.isMe);
  const seatsEl = $('seats'); seatsEl.innerHTML = '';
  for (let visual = 0; visual < 6; visual++) {
    const realPos = myIdx >= 0 ? (myIdx + visual) % 6 : visual;
    const [x, y] = SEAT_XY[visual];
    const p = state.seats[realPos];
    const el = document.createElement('div');
    el.className = 'seat';
    el.style.left = x + '%'; el.style.top = y + '%';
    if (!p) {
      el.innerHTML = `<div class="empty-seat">Свободно</div>`;
      seatsEl.appendChild(el); continue;
    }
    if (p.folded) el.classList.add('folded');
    if (p.isTurn) el.classList.add('turn');
    if (state.showdown?.winners?.some((w) => w.pos === realPos)) el.classList.add('winner');
    const dealer = realPos === state.dealerPos ? `<div class="dealer">D</div>` : '';
    const badge = p.allIn ? `<div class="badge">ALL-IN</div>` : '';
    const holeHtml = document.createElement('div'); holeHtml.className = 'phole';
    (p.hole || []).forEach((c) => holeHtml.appendChild(cardEl(c, true)));
    const initial = (p.name || '?').trim().charAt(0).toUpperCase();
    const avatarHtml = p.photoUrl
      ? `<img class="avatar" src="${p.photoUrl}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar avatar-fallback',textContent:'${initial}'}))" />`
      : `<div class="avatar avatar-fallback">${initial}</div>`;
    el.innerHTML = `<div class="plate">${dealer}${badge}
      ${avatarHtml}
      <div class="pname">${escapeHtml(p.name)}${p.connected ? '' : ' 💤'}</div>
      <div class="pstack">${p.stack} фишек</div>
      <div class="phole"></div>
      <div class="pbet">${p.bet > 0 ? 'ставка ' + p.bet : ''}</div>
    </div>`;
    el.querySelector('.phole').replaceWith(holeHtml);
    seatsEl.appendChild(el);
  }

  // лог
  const log = $('log'); log.innerHTML = state.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  log.scrollTop = log.scrollHeight;

  // управление
  renderControls();
}

function renderControls() {
  const canStart = (state.phase === 'waiting' || state.phase === 'showdown');
  const seatedCount = state.seats.filter(Boolean).length;
  $('btnStart').classList.toggle('hidden', !(canStart && seatedCount >= 2));
  const myTurn = state.you && state.you.isTurn && !canStart;
  // ход потерян — закрываем открытый слайдер ставки
  if (!myTurn && raiseOpen) { raiseOpen = false; $('raiseBox').classList.add('hidden'); }
  // пока слайдер ставки открыт (и всё ещё мой ход) — не трогаем панель, чтобы ре-рендер не мешал вводу
  if (raiseOpen && myTurn) return;
  $('actions').classList.toggle('hidden', !myTurn);
  if (myTurn) {
    const toCall = state.you.toCall;
    const checkBtn = document.querySelector('.act-check');
    const callBtn = document.querySelector('.act-call');
    const raiseBtn = document.querySelector('.act-raise');
    checkBtn.classList.toggle('hidden', toCall > 0);
    callBtn.classList.toggle('hidden', toCall <= 0);
    callBtn.textContent = toCall > 0 ? `Колл ${Math.min(toCall, state.you.stack)}` : 'Колл';
    // если колла хватает только на олл-ин — рейз недоступен
    const canRaise = state.you.stack > toCall;
    raiseBtn.classList.toggle('hidden', !canRaise);
    // «Бет» когда ставок ещё не было, иначе «Рейз»
    raiseBtn.textContent = state.currentBet > 0 ? 'Рейз' : 'Бет';
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let toastTimer;
function toast(msg) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#000d;color:#fff;padding:10px 16px;border-radius:10px;z-index:99;font-size:14px'; document.body.appendChild(t); }
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2200);
}
