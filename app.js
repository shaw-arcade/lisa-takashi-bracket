/* Lisa & Takashi - The Great Photo Playoff */

const CONFIG = {
  PASSCODE: 'TOKYO2026',
  WEBHOOK_URL: 'https://script.google.com/macros/s/AKfycbwaAA1_bELjqyufdM4oqq7qMjVl76hqmKltkzp0y6P8nbXBi9cPlY7tjt7FfoPULOK8CA/exec',
  SYNC_EVERY: 20,  // send queued votes every N picks
};

const LS_GATE = 'wpb_gate_ok';
const LS_CURRENT = 'wpb_current_voter';
const voterKey = (name) => 'wpb_voter_' + name.trim().toLowerCase();

let manifest = [];      // all photo ids (strings)
let photoPairs = null;  // round-1 similar-photo pairings [[a,b],...]
let voter = null;       // { name, picks: [winnerId...], queue: [...], champion, done }
let bracket = null;     // derived state, rebuilt from picks
let currentPair = null; // { a, b, round, matchIndex, matchesInRound }
let zoomSide = null;

/* ---------- utilities ---------- */

function $(id) { return document.getElementById(id); }

function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(screenId).classList.add('active');
  window.scrollTo(0, 0);
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const a = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function photoUrl(id) { return 'photos/' + id + '.jpg'; }

function roundLabel(size) {
  if (size <= 2) return 'The Championship';
  if (size <= 4) return 'The Final Four';
  if (size <= 8) return 'The Elite Eight';
  if (size <= 16) return 'The Sweet Sixteen';
  return 'Round of ' + size.toLocaleString('en-US');
}

/* ---------- storage ---------- */

function loadVoter(name) {
  try {
    const raw = localStorage.getItem(voterKey(name));
    if (raw) {
      const v = JSON.parse(raw);
      if (v && Array.isArray(v.picks)) {
        // Legacy voters mid-bracket keep their shuffled order so nothing resets;
        // anyone who has not picked yet is upgraded to the chronological order.
        if (!v.order) v.order = v.picks.length > 0 ? 'shuffle' : 'chrono';
        return v;
      }
    }
  } catch (e) { /* corrupted; start fresh */ }
  return { name: name.trim(), picks: [], queue: [], champion: null, done: false, order: 'chrono', startedAt: Date.now() };
}

function saveVoter() {
  if (!voter) return;
  try {
    localStorage.setItem(voterKey(voter.name), JSON.stringify(voter));
    localStorage.setItem(LS_CURRENT, voter.name);
  } catch (e) { /* storage full; keep playing, votes still sync */ }
}

/* ---------- bracket engine ----------
   Deterministic: round 1 order = seededShuffle(manifest, hash(name)).
   Each round: pairs (0,1),(2,3)... ; odd count -> last photo gets a bye.
   picks[] stores winner ids (or 'BOTH' for a keep-both) in global pick order;
   replaying picks rebuilds everything. Keep-both advances both photos and has a
   per-round budget so rounds always shrink; it is unavailable at 4 photos or fewer. */

function bothBudget(roundLength, matches) {
  if (roundLength <= 4) return 0;
  // Never allow every match in a round to be a keep-both, so rounds always shrink.
  return Math.min(matches - 1, Math.max(2, Math.round(matches * 0.1)));
}

function firstRound(seed, order) {
  // Round 1 pairs similar photos so lookalikes battle each other first.
  if (!photoPairs) return seededShuffle(manifest, seed);

  if (order === 'chrono') {
    // Follow the wedding day: matchups run from morning prep to the last dance.
    // Frame numbers are chronological, so sort pairs by their earlier frame.
    const sorted = photoPairs
      .map(p => (Number(p[0]) <= Number(p[1]) ? [p[0], p[1]] : [p[1], p[0]]))
      .sort((x, y) => Number(x[0]) - Number(y[0]));
    const round = [];
    for (const p of sorted) round.push(p[0], p[1]);
    return round;
  }

  // Legacy order for voters who started before the chronological update.
  const shuffled = seededShuffle(photoPairs, seed);
  const flip = mulberry32(seed ^ 0x9e3779b9);
  const round = [];
  for (const p of shuffled) {
    if (flip() < 0.5) round.push(p[0], p[1]);
    else round.push(p[1], p[0]);
  }
  return round;
}

function rebuildBracket() {
  const seed = hashString(voter.name.trim().toLowerCase());
  let round = firstRound(seed, voter.order || 'shuffle');
  let roundNumber = 1;
  let pickCursor = 0;
  const picks = voter.picks;

  while (round.length > 1) {
    const matches = Math.floor(round.length / 2);
    const bye = (round.length % 2 === 1) ? round[round.length - 1] : null;
    const budget = bothBudget(round.length, matches);
    let bothUsed = 0;
    const winners = [];
    let m = 0;
    for (; m < matches; m++) {
      if (pickCursor >= picks.length) break;
      const a = round[m * 2], b = round[m * 2 + 1];
      const w = picks[pickCursor];
      if (w === 'BOTH') {
        winners.push(a, b);
        bothUsed++;
      } else if (w === 'NEITHER') {
        // Both photos eliminated; nobody advances from this match.
      } else if (w === a || w === b) {
        winners.push(w);
      } else {
        // Corrupted history relative to manifest; truncate and resume from here.
        voter.picks = picks.slice(0, pickCursor);
        return rebuildBracket();
      }
      pickCursor++;
    }
    if (m < matches) {
      // Current match is m of this round. Estimate remaining picks assuming
      // every future match is decisive.
      let remaining = matches - m;
      let len = winners.length + (matches - m) + (bye ? 1 : 0);
      while (len > 1) {
        remaining += Math.floor(len / 2);
        len = Math.ceil(len / 2);
      }
      // Drop Both is allowed unless it could leave the round with no survivors:
      // never on the last match of a round that has produced no winners and has no bye.
      const neitherOk = round.length > 4 &&
        !(m === matches - 1 && winners.length === 0 && !bye);
      return {
        round, roundNumber, matches, bye,
        matchIndex: m,
        a: round[m * 2], b: round[m * 2 + 1],
        picksDone: picks.length,
        remaining,
        bothLeft: Math.max(0, budget - bothUsed),
        neitherOk,
      };
    }
    round = bye ? winners.concat([bye]) : winners;
    roundNumber++;
  }

  return { champion: round[0], picksDone: picks.length, remaining: 0 };
}

/* ---------- sync ---------- */

let syncTimer = null;
let syncInFlight = false;

function queueVote(winner, loser, roundNumber, pickIndex) {
  // 5th element ties the queue entry to a pick so Back can retract unsent votes.
  voter.queue.push([winner, loser, roundNumber, Date.now(), pickIndex]);
}

function flushQueue(force) {
  if (!CONFIG.WEBHOOK_URL || !voter || voter.queue.length === 0) return;
  if (syncInFlight) return; // never double-send a batch that is already on the wire
  if (!force && voter.queue.length < CONFIG.SYNC_EVERY) return;
  syncInFlight = true;
  const batch = voter.queue.slice();
  const payload = JSON.stringify({
    type: 'votes',
    voter: voter.name,
    total: manifest.length,
    votes: batch,
  });
  const dot = $('sync-dot');
  dot.classList.add('on');
  fetch(CONFIG.WEBHOOK_URL, { method: 'POST', body: payload })
    .then(() => {
      // Remove exactly the entries we sent.
      voter.queue = voter.queue.slice(batch.length);
      saveVoter();
    })
    .catch(() => { /* keep queue, retry on next flush */ })
    .finally(() => {
      syncInFlight = false;
      setTimeout(() => dot.classList.remove('on'), 600);
    });
}

function sendCompletion() {
  if (!CONFIG.WEBHOOK_URL) return;
  const payload = JSON.stringify({
    type: 'complete',
    voter: voter.name,
    champion: voter.champion,
    total: manifest.length,
  });
  try {
    navigator.sendBeacon
      ? navigator.sendBeacon(CONFIG.WEBHOOK_URL, payload)
      : fetch(CONFIG.WEBHOOK_URL, { method: 'POST', body: payload });
  } catch (e) { /* best effort */ }
}

window.addEventListener('pagehide', () => {
  if (!CONFIG.WEBHOOK_URL || !voter || voter.queue.length === 0) return;
  try {
    navigator.sendBeacon(CONFIG.WEBHOOK_URL, JSON.stringify({
      type: 'votes', voter: voter.name, total: manifest.length, votes: voter.queue,
    }));
    voter.queue = [];
    saveVoter();
  } catch (e) { /* keep queue for next visit */ }
});

/* ---------- play flow ---------- */

let lastSeenRound = null;
let lastSeenLabel = '';

function renderMatch(skipRoundCheck) {
  const st = rebuildBracket();
  bracket = st;

  if (st.champion) {
    voter.champion = st.champion;
    voter.done = true;
    saveVoter();
    flushQueue(true);
    sendCompletion();
    showChampion(st.champion);
    return;
  }

  // A finished round deserves a moment: celebrate and offer a break.
  if (!skipRoundCheck && lastSeenRound !== null && st.roundNumber > lastSeenRound) {
    flushQueue(true);
    currentPair = st;
    $('roundend-title').textContent = lastSeenLabel;
    $('roundend-detail').textContent = 'You have made ' + st.picksDone.toLocaleString('en-US') +
      ' picks. Next up: ' + roundLabel(st.round.length) + ', ' + st.matches.toLocaleString('en-US') +
      ' picks. Keep going, or come back later; everything is saved.';
    lastSeenRound = st.roundNumber;
    lastSeenLabel = roundLabel(st.round.length);
    show('roundend');
    return;
  }

  currentPair = st;
  lastSeenRound = st.roundNumber;
  lastSeenLabel = roundLabel(st.round.length);
  $('round-name').textContent = roundLabel(st.round.length);
  $('round-progress').textContent = 'Pick ' + (st.matchIndex + 1) + ' of ' + st.matches;
  const overall = st.picksDone / (st.picksDone + st.remaining);
  $('progress-fill').style.width = (overall * 100).toFixed(2) + '%';

  $('back-btn').disabled = st.picksDone === 0;
  const bothBtn = $('both-btn');
  if (st.round.length <= 4) {
    bothBtn.style.display = 'none';
  } else {
    bothBtn.style.display = '';
    bothBtn.disabled = st.bothLeft === 0;
    bothBtn.textContent = st.bothLeft === 0 ? 'No Keep Boths Left This Round' : 'Keep Both';
  }
  $('neither-btn').style.display = st.neitherOk ? '' : 'none';

  const cardA = $('card-a'), cardB = $('card-b');
  cardA.classList.remove('picked', 'dimmed');
  cardB.classList.remove('picked', 'dimmed');
  $('img-a').src = photoUrl(st.a);
  $('img-b').src = photoUrl(st.b);

  // Preload the next matchup so picks feel instant.
  const nextM = st.matchIndex + 1;
  if (nextM < st.matches) {
    new Image().src = photoUrl(st.round[nextM * 2]);
    new Image().src = photoUrl(st.round[nextM * 2 + 1]);
  }
  show('play');
}

let pickLock = false;

function pick(side) {
  if (pickLock || !currentPair) return;
  pickLock = true;
  const winner = side === 'a' ? currentPair.a : currentPair.b;
  const loser = side === 'a' ? currentPair.b : currentPair.a;

  $(side === 'a' ? 'card-a' : 'card-b').classList.add('picked');
  $(side === 'a' ? 'card-b' : 'card-a').classList.add('dimmed');

  const idx = voter.picks.length;
  voter.picks.push(winner);
  queueVote(winner, loser, currentPair.roundNumber, idx);
  saveVoter();
  flushQueue(false);

  setTimeout(() => { pickLock = false; renderMatch(); }, 220);
}

function keepBoth() {
  if (pickLock || !currentPair || currentPair.bothLeft <= 0) return;
  pickLock = true;
  $('card-a').classList.add('picked');
  $('card-b').classList.add('picked');

  const idx = voter.picks.length;
  voter.picks.push('BOTH');
  // Both photos advance and both get credit for a win.
  queueVote(currentPair.a, currentPair.b, currentPair.roundNumber, idx);
  queueVote(currentPair.b, currentPair.a, currentPair.roundNumber, idx);
  saveVoter();
  flushQueue(false);

  setTimeout(() => { pickLock = false; renderMatch(); }, 220);
}

function dropBoth() {
  if (pickLock || !currentPair || !currentPair.neitherOk) return;
  pickLock = true;
  $('card-a').classList.add('dimmed');
  $('card-b').classList.add('dimmed');

  const idx = voter.picks.length;
  voter.picks.push('NEITHER');
  // Both photos are eliminated; 'OUT' rows record the loss without crediting a win.
  queueVote('OUT', currentPair.a, currentPair.roundNumber, idx);
  queueVote('OUT', currentPair.b, currentPair.roundNumber, idx);
  saveVoter();
  flushQueue(false);

  setTimeout(() => { pickLock = false; renderMatch(); }, 220);
}

function goBack() {
  if (pickLock || !voter || voter.picks.length === 0) return;
  const idx = voter.picks.length - 1;
  voter.picks.pop();
  // Retract matching votes still waiting in the queue (already-synced ones are
  // a negligible drop in the ocean of 1,400 picks).
  while (voter.queue.length && voter.queue[voter.queue.length - 1][4] === idx) {
    voter.queue.pop();
  }
  saveVoter();
  renderMatch();
}

function saveForLater() {
  flushQueue(true);
  const st = rebuildBracket();
  $('resume-name').textContent = voter.name;
  $('resume-detail').textContent = 'You have made ' + voter.picks.length.toLocaleString('en-US') +
    ' picks, about ' + st.remaining.toLocaleString('en-US') +
    ' to go. Everything is saved on this device. Open the same link on this device anytime and your bracket will be waiting.';
  show('resume');
}

/* ---------- champion + confetti ---------- */

function showChampion(id) {
  $('champion-img').src = photoUrl(id);
  show('champion');
  startConfetti();
}

let confettiRAF = null;

function startConfetti() {
  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  const colors = ['#b49a5a', '#d8c99b', '#9b8fb8', '#ece8f3', '#fdfcfa'];
  let w, h;
  function size() {
    w = canvas.width = canvas.offsetWidth * devicePixelRatio;
    h = canvas.height = canvas.offsetHeight * devicePixelRatio;
  }
  size();
  window.addEventListener('resize', size);

  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * w,
    y: -20 - Math.random() * h,
    r: (3 + Math.random() * 5) * devicePixelRatio,
    c: colors[Math.floor(Math.random() * colors.length)],
    vy: (1 + Math.random() * 2.2) * devicePixelRatio,
    vx: (Math.random() - 0.5) * 1.2 * devicePixelRatio,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.12,
  }));

  const started = Date.now();
  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const p of pieces) {
      p.y += p.vy; p.x += p.vx; p.rot += p.vr;
      if (p.y > h + 20 && Date.now() - started < 9000) { p.y = -20; p.x = Math.random() * w; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      ctx.restore();
    }
    confettiRAF = requestAnimationFrame(frame);
  }
  if (confettiRAF) cancelAnimationFrame(confettiRAF);
  frame();
}

/* ---------- lightbox ---------- */

function openLightbox(side) {
  if (!currentPair) return;
  zoomSide = side;
  $('lightbox-img').src = photoUrl(side === 'a' ? currentPair.a : currentPair.b);
  $('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('lightbox').classList.add('hidden');
  zoomSide = null;
}

/* ---------- screens / wiring ---------- */

function tryGate() {
  const val = $('passcode').value.trim().toUpperCase().replace(/\s+/g, '');
  if (val === CONFIG.PASSCODE) {
    sessionStorage.setItem(LS_GATE, '1');
    $('gate-error').classList.add('hidden');
    routeAfterGate();
  } else {
    $('gate-error').classList.remove('hidden');
  }
}

function routeAfterGate() {
  const last = localStorage.getItem(LS_CURRENT);
  if (last) {
    const v = loadVoter(last);
    if (v.picks.length > 0 && !v.done) {
      voter = v;
      const st = rebuildBracket();
      $('resume-name').textContent = v.name;
      $('resume-detail').textContent = 'You have made ' + v.picks.length.toLocaleString('en-US') +
        ' picks, about ' + st.remaining.toLocaleString('en-US') + ' to go. Your bracket is waiting right where you left it.';
      show('resume');
      return;
    }
    if (v.done) {
      voter = v;
      show('thanks');
      return;
    }
  }
  show('welcome');
}

function startNewOrExisting() {
  const name = $('voter-name').value.trim();
  if (!name) { $('name-error').classList.remove('hidden'); return; }
  $('name-error').classList.add('hidden');
  voter = loadVoter(name);
  saveVoter();
  if (voter.done) { show('thanks'); return; }
  renderMatch();
}

function init() {
  $('gate-btn').addEventListener('click', tryGate);
  $('passcode').addEventListener('keydown', e => { if (e.key === 'Enter') tryGate(); });

  $('start-btn').addEventListener('click', startNewOrExisting);
  $('voter-name').addEventListener('keydown', e => { if (e.key === 'Enter') startNewOrExisting(); });

  $('resume-btn').addEventListener('click', () => renderMatch());
  $('restart-btn').addEventListener('click', () => { $('voter-name').value = ''; show('welcome'); });

  $('card-a').addEventListener('click', e => { if (!e.target.closest('.zoom-btn')) pick('a'); });
  $('card-b').addEventListener('click', e => { if (!e.target.closest('.zoom-btn')) pick('b'); });
  document.querySelectorAll('.zoom-btn').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation(); openLightbox(b.dataset.side); }));

  $('roundend-continue').addEventListener('click', () => renderMatch(true));
  $('roundend-save').addEventListener('click', saveForLater);

  $('back-btn').addEventListener('click', goBack);
  $('both-btn').addEventListener('click', keepBoth);
  $('neither-btn').addEventListener('click', dropBoth);
  $('save-btn').addEventListener('click', saveForLater);

  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox-pick').addEventListener('click', () => { const s = zoomSide; closeLightbox(); pick(s); });

  $('finish-btn').addEventListener('click', () => {
    if (confettiRAF) cancelAnimationFrame(confettiRAF);
    show('thanks');
  });

  // Periodic sync safety net.
  syncTimer = setInterval(() => flushQueue(true), 45000);

  Promise.all([
    fetch('manifest.json').then(r => r.json()),
    fetch('pairs.json').then(r => r.json()).catch(() => null),
  ]).then(([list, pairs]) => {
    manifest = list.map(String);
    if (pairs && pairs.length) photoPairs = pairs.map(p => [String(p[0]), String(p[1])]);
    if (sessionStorage.getItem(LS_GATE) === '1') routeAfterGate();
    else show('gate');
  });
}

document.addEventListener('DOMContentLoaded', init);
