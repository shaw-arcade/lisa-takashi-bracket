/* Lisa & Takashi - The Great Photo Playoff */

const CONFIG = {
  PASSCODE: 'TOKYO2026',
  WEBHOOK_URL: '', // Google Apps Script web app URL; empty = offline mode (picks still save locally)
  SYNC_EVERY: 20,  // send queued votes every N picks
};

const LS_GATE = 'wpb_gate_ok';
const LS_CURRENT = 'wpb_current_voter';
const voterKey = (name) => 'wpb_voter_' + name.trim().toLowerCase();

let manifest = [];      // all photo ids (strings)
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
      if (v && Array.isArray(v.picks)) return v;
    }
  } catch (e) { /* corrupted; start fresh */ }
  return { name: name.trim(), picks: [], queue: [], champion: null, done: false, startedAt: Date.now() };
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
   picks[] stores winner ids in global pick order; replaying picks rebuilds everything. */

function rebuildBracket() {
  const seed = hashString(voter.name.trim().toLowerCase());
  let round = seededShuffle(manifest, seed);
  let roundNumber = 1;
  let pickCursor = 0;
  const picks = voter.picks;

  while (round.length > 1) {
    const matches = Math.floor(round.length / 2);
    const bye = (round.length % 2 === 1) ? round[round.length - 1] : null;
    const winners = [];
    let m = 0;
    for (; m < matches; m++) {
      if (pickCursor >= picks.length) break;
      const a = round[m * 2], b = round[m * 2 + 1];
      const w = picks[pickCursor];
      if (w !== a && w !== b) {
        // Corrupted history relative to manifest; truncate and resume from here.
        voter.picks = picks.slice(0, pickCursor);
        return rebuildBracket();
      }
      winners.push(w);
      pickCursor++;
    }
    if (m < matches) {
      // Current match is m of this round.
      return {
        round, roundNumber, matches, bye,
        matchIndex: m,
        a: round[m * 2], b: round[m * 2 + 1],
        totalPicks: manifest.length - 1,
        picksDone: picks.length,
      };
    }
    round = bye ? winners.concat([bye]) : winners;
    roundNumber++;
  }

  return { champion: round[0], totalPicks: manifest.length - 1, picksDone: picks.length };
}

/* ---------- sync ---------- */

let syncTimer = null;

function queueVote(winner, loser, roundNumber) {
  voter.queue.push([winner, loser, roundNumber, Date.now()]);
}

function flushQueue(force) {
  if (!CONFIG.WEBHOOK_URL || !voter || voter.queue.length === 0) return;
  if (!force && voter.queue.length < CONFIG.SYNC_EVERY) return;
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
    .finally(() => setTimeout(() => dot.classList.remove('on'), 600));
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

function renderMatch() {
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

  currentPair = st;
  $('round-name').textContent = roundLabel(st.round.length);
  $('round-progress').textContent = 'Pick ' + (st.matchIndex + 1) + ' of ' + st.matches;
  $('progress-fill').style.width = ((st.picksDone / st.totalPicks) * 100).toFixed(2) + '%';

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

  voter.picks.push(winner);
  queueVote(winner, loser, currentPair.roundNumber);
  saveVoter();
  flushQueue(false);

  setTimeout(() => { pickLock = false; renderMatch(); }, 220);
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
      $('resume-name').textContent = v.name;
      const total = manifest.length - 1;
      const pct = Math.round((v.picks.length / total) * 100);
      $('resume-detail').textContent = 'You have made ' + v.picks.length.toLocaleString('en-US') +
        ' of ' + total.toLocaleString('en-US') + ' picks (' + pct + '%). Your bracket is waiting right where you left it.';
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

  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox-pick').addEventListener('click', () => { const s = zoomSide; closeLightbox(); pick(s); });

  $('finish-btn').addEventListener('click', () => {
    if (confettiRAF) cancelAnimationFrame(confettiRAF);
    show('thanks');
  });

  // Periodic sync safety net.
  syncTimer = setInterval(() => flushQueue(true), 45000);

  fetch('manifest.json')
    .then(r => r.json())
    .then(list => {
      manifest = list.map(String);
      if (sessionStorage.getItem(LS_GATE) === '1') routeAfterGate();
      else show('gate');
    });
}

document.addEventListener('DOMContentLoaded', init);
