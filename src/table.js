// Машина состояний покерного стола (Техасский Холдем, кэш-игра).
import { freshDeck, shuffle, evaluate7, cmpScore } from './poker.js';

export class Table {
  constructor(id, { name = 'Стол', smallBlind = 10, bigBlind = 20, buyIn = 1000 } = {}) {
    this.id = id;
    this.name = name;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.buyIn = buyIn;
    this.seats = new Array(6).fill(null); // до 6 игроков
    this.dealerPos = -1;
    this.phase = 'waiting'; // waiting | preflop | flop | turn | river | showdown
    this.board = [];
    this.deck = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = bigBlind;
    this.toActPos = -1;
    this.lastAggressor = -1;
    this.handId = 0;
    this.log = [];
  }

  // --- игроки ---
  seatPlayer(user) {
    // уже за столом?
    const existing = this.seats.findIndex((p) => p && p.id === user.id);
    if (existing >= 0) {
      this.seats[existing].connected = true;
      if (user.photoUrl) this.seats[existing].photoUrl = user.photoUrl;
      return existing;
    }
    const pos = this.seats.findIndex((s) => s === null);
    if (pos < 0) return -1; // мест нет
    this.seats[pos] = {
      id: user.id,
      name: user.name,
      photoUrl: user.photoUrl || null,
      stack: this.buyIn,
      hole: [],
      bet: 0,
      totalBet: 0,
      inHand: false,
      allIn: false,
      folded: false,
      acted: false,
      connected: true,
    };
    this.pushLog(`${user.name} сел за стол`);
    return pos;
  }

  removePlayer(userId) {
    const pos = this.seats.findIndex((p) => p && p.id === userId);
    if (pos < 0) return;
    const p = this.seats[pos];
    // если игрок в текущей раздаче — считаем фолдом
    if (p.inHand && this.phase !== 'waiting' && this.phase !== 'showdown') {
      p.folded = true; p.inHand = false;
    }
    this.pushLog(`${p.name} покинул стол`);
    this.seats[pos] = null;
    if (this.activeCount() < 2 && this.phase !== 'waiting') this.endHandCleanup();
  }

  activePlayers() { return this.seats.filter(Boolean); }
  activeCount() { return this.activePlayers().length; }
  inHandPlayers() { return this.seats.filter((p) => p && p.inHand && !p.folded); }

  occupiedPositions() {
    const arr = [];
    for (let i = 0; i < 6; i++) if (this.seats[i]) arr.push(i);
    return arr;
  }

  nextOccupied(from) {
    for (let k = 1; k <= 6; k++) {
      const pos = (from + k) % 6;
      if (this.seats[pos]) return pos;
    }
    return -1;
  }

  // --- начало раздачи ---
  startHand() {
    const players = this.seats.filter((p) => p && p.stack > 0);
    if (players.length < 2) return false;
    this.handId++;
    this.deck = shuffle(freshDeck());
    this.board = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.phase = 'preflop';

    for (const p of this.seats) {
      if (!p) continue;
      p.hole = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = false;
      p.allIn = false;
      p.acted = false;
      p.inHand = p.stack > 0;
    }

    this.dealerPos = this.nextOccupied(this.dealerPos < 0 ? 5 : this.dealerPos);
    // раздаём по 2 карты
    for (let r = 0; r < 2; r++) {
      let pos = this.dealerPos;
      for (let i = 0; i < 6; i++) {
        pos = this.nextOccupied(pos);
        const p = this.seats[pos];
        if (p && p.inHand) p.hole.push(this.deck.pop());
        if (pos === this.dealerPos) break;
      }
    }

    const inHand = this.occupiedPositions().filter((i) => this.seats[i].inHand);
    const heads = inHand.length === 2;
    // блайнды
    const sbPos = heads ? this.dealerPos : this.nextOccupied(this.dealerPos);
    const bbPos = this.nextOccupied(sbPos);
    this.postBlind(sbPos, this.smallBlind);
    this.postBlind(bbPos, this.bigBlind);
    this.currentBet = this.bigBlind;
    this.lastAggressor = bbPos;
    // ход после большого блайнда
    this.toActPos = this.nextOccupied(bbPos);
    this.pushLog(`— Раздача #${this.handId} —`);
    return true;
  }

  postBlind(pos, amount) {
    const p = this.seats[pos];
    const pay = Math.min(amount, p.stack);
    p.stack -= pay; p.bet = pay; p.totalBet += pay; this.pot += pay;
    if (p.stack === 0) p.allIn = true;
  }

  // --- действие игрока ---
  act(userId, action, amount = 0) {
    const pos = this.seats.findIndex((p) => p && p.id === userId);
    if (pos < 0 || pos !== this.toActPos) return { ok: false, err: 'Не ваш ход' };
    const p = this.seats[pos];
    if (!p.inHand || p.folded || p.allIn) return { ok: false, err: 'Нельзя действовать' };
    const toCall = this.currentBet - p.bet;

    if (action === 'fold') {
      p.folded = true; p.inHand = false; p.acted = true;
      this.pushLog(`${p.name}: фолд`);
    } else if (action === 'check') {
      if (toCall > 0) return { ok: false, err: 'Нельзя чек — есть ставка' };
      p.acted = true;
      this.pushLog(`${p.name}: чек`);
    } else if (action === 'call') {
      const pay = Math.min(toCall, p.stack);
      p.stack -= pay; p.bet += pay; p.totalBet += pay; this.pot += pay;
      if (p.stack === 0) p.allIn = true;
      p.acted = true;
      this.pushLog(`${p.name}: колл ${pay}`);
    } else if (action === 'raise' || action === 'bet') {
      // amount — итоговый размер ставки игрока в этом раунде
      const target = Math.floor(amount);
      const maxTarget = p.bet + p.stack;
      if (target > maxTarget) return { ok: false, err: 'Недостаточно фишек' };
      const isAllIn = target === maxTarget;
      const raiseBy = target - this.currentBet;
      if (target <= this.currentBet) return { ok: false, err: 'Ставка слишком мала' };
      if (raiseBy < this.minRaise && !isAllIn) return { ok: false, err: `Минимальный рейз ${this.minRaise}` };
      const pay = target - p.bet;
      p.stack -= pay; p.bet = target; p.totalBet += pay; this.pot += pay;
      if (p.stack === 0) p.allIn = true;
      if (raiseBy >= this.minRaise) this.minRaise = raiseBy;
      this.currentBet = target;
      this.lastAggressor = pos;
      // остальные должны снова действовать
      for (const q of this.seats) if (q && q.inHand && !q.folded && !q.allIn && q !== p) q.acted = false;
      p.acted = true;
      this.pushLog(`${p.name}: ${action === 'bet' ? 'бет' : 'рейз'} до ${target}`);
    } else {
      return { ok: false, err: 'Неизвестное действие' };
    }

    this.advance();
    return { ok: true };
  }

  // переход хода / улицы
  advance() {
    const contenders = this.inHandPlayers();
    if (contenders.length <= 1) { this.finishHand(); return; }

    // все ли завершили круг торговли?
    const needAct = this.seats.filter((p) => p && p.inHand && !p.folded && !p.allIn && !p.acted);
    const canAct = this.seats.filter((p) => p && p.inHand && !p.folded && !p.allIn);
    if (needAct.length === 0) {
      // круг закрыт
      if (canAct.length <= 1) {
        // остальные олл-ин — доехать до вскрытия
        this.runoutAndShowdown();
        return;
      }
      this.nextStreet();
      return;
    }
    // следующий, кому ходить
    let pos = this.toActPos;
    for (let i = 0; i < 6; i++) {
      pos = this.nextOccupied(pos);
      const q = this.seats[pos];
      if (q && q.inHand && !q.folded && !q.allIn && !q.acted) { this.toActPos = pos; return; }
    }
    this.nextStreet();
  }

  nextStreet() {
    for (const p of this.seats) if (p) { p.bet = 0; p.acted = false; }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    if (this.phase === 'preflop') { this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.phase = 'flop'; }
    else if (this.phase === 'flop') { this.board.push(this.deck.pop()); this.phase = 'turn'; }
    else if (this.phase === 'turn') { this.board.push(this.deck.pop()); this.phase = 'river'; }
    else if (this.phase === 'river') { this.finishHand(); return; }
    this.pushLog(`— ${this.phaseLabel()} —`);
    // первым ходит ближайший живой слева от дилера
    let pos = this.dealerPos;
    for (let i = 0; i < 6; i++) {
      pos = this.nextOccupied(pos);
      const q = this.seats[pos];
      if (q && q.inHand && !q.folded && !q.allIn) { this.toActPos = pos; return; }
    }
    // все олл-ин
    this.runoutAndShowdown();
  }

  runoutAndShowdown() {
    while (this.board.length < 5) this.board.push(this.deck.pop());
    this.phase = 'river';
    this.finishHand();
  }

  finishHand() {
    const contenders = this.inHandPlayers();
    if (contenders.length === 1) {
      const w = contenders[0];
      w.stack += this.pot;
      this.pushLog(`${w.name} забирает банк ${this.pot} (без вскрытия)`);
      this.showdownInfo = { winners: [{ pos: this.seats.indexOf(w), name: w.name, amount: this.pot }], reveal: [] };
    } else {
      this.distributePots(contenders);
    }
    this.pot = 0;
    this.phase = 'showdown';
    this.toActPos = -1;
  }

  distributePots(contenders) {
    // оценка рук
    for (const p of contenders) p._score = evaluate7([...p.hole, ...this.board]);
    // сайд-поты по totalBet
    const players = this.seats.filter((p) => p && p.totalBet > 0);
    const levels = [...new Set(players.map((p) => p.totalBet))].sort((a, b) => a - b);
    let prev = 0;
    const payouts = {}; // pos -> amount
    const reveal = contenders.map((p) => ({ pos: this.seats.indexOf(p), name: p.name, hole: p.hole, hand: p._score.name }));
    const winnersAgg = {};

    for (const lvl of levels) {
      const slice = lvl - prev;
      const contributors = players.filter((p) => p.totalBet >= lvl);
      const potSize = slice * contributors.length;
      prev = lvl;
      if (potSize <= 0) continue;
      // претенденты на этот пот — не сфолдившие среди contributors
      const eligible = contributors.filter((p) => contenders.includes(p));
      if (eligible.length === 0) continue;
      let best = null;
      for (const p of eligible) if (!best || cmpScore(p._score, best) > 0) best = p._score;
      const winners = eligible.filter((p) => cmpScore(p._score, best) === 0);
      const share = Math.floor(potSize / winners.length);
      let rem = potSize - share * winners.length;
      for (const w of winners) {
        const pos = this.seats.indexOf(w);
        let amt = share;
        if (rem > 0) { amt++; rem--; }
        w.stack += amt;
        payouts[pos] = (payouts[pos] || 0) + amt;
        winnersAgg[pos] = { pos, name: w.name, amount: (winnersAgg[pos]?.amount || 0) + amt, hand: w._score.name };
      }
    }
    for (const w of Object.values(winnersAgg)) this.pushLog(`${w.name} выигрывает ${w.amount} (${w.hand})`);
    this.showdownInfo = { winners: Object.values(winnersAgg), reveal };
  }

  endHandCleanup() {
    this.phase = 'waiting';
    this.toActPos = -1;
    this.board = [];
    this.pot = 0;
  }

  phaseLabel() {
    return { preflop: 'Префлоп', flop: 'Флоп', turn: 'Тёрн', river: 'Ривер', showdown: 'Вскрытие', waiting: 'Ожидание' }[this.phase];
  }

  pushLog(msg) { this.log.push(msg); if (this.log.length > 40) this.log.shift(); }

  // видимое клиенту состояние (карты соперников скрыты, кроме вскрытия)
  stateFor(userId) {
    const revealAll = this.phase === 'showdown';
    return {
      id: this.id,
      name: this.name,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      phase: this.phase,
      phaseLabel: this.phaseLabel(),
      board: this.board,
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      dealerPos: this.dealerPos,
      toActPos: this.toActPos,
      handId: this.handId,
      log: this.log.slice(-12),
      showdown: this.phase === 'showdown' ? this.showdownInfo : null,
      seats: this.seats.map((p, pos) => {
        if (!p) return null;
        const me = p.id === userId;
        const show = me || (revealAll && p.inHand && !p.folded);
        return {
          pos,
          id: p.id,
          name: p.name,
          photoUrl: p.photoUrl || null,
          stack: p.stack,
          bet: p.bet,
          folded: p.folded,
          allIn: p.allIn,
          inHand: p.inHand,
          connected: p.connected,
          isMe: me,
          isTurn: pos === this.toActPos,
          hole: show ? p.hole : (p.inHand && !p.folded ? ['??', '??'] : []),
        };
      }),
      you: (() => {
        const p = this.seats.find((x) => x && x.id === userId);
        if (!p) return null;
        const toCall = this.currentBet - p.bet;
        return { seated: true, stack: p.stack, bet: p.bet, toCall, isTurn: this.seats.indexOf(p) === this.toActPos, allIn: p.allIn, folded: p.folded };
      })(),
    };
  }
}
