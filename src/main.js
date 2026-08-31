import { CONFIG, DIFFICULTY_LABELS } from './config.js';
import { Game } from './game/Game.js';
import { Camera } from './ui/Camera.js';
import { Renderer } from './render/Renderer.js';
import { Input } from './ui/Input.js';
import { HUD } from './ui/HUD.js';
import { seedFromString } from './core/rng.js';

const $ = (id) => document.getElementById(id);

const ui = {
  buildMode: null,
  selectedCell: -1,
  selectedFleet: null,
  hoverCell: -1,
  trenchPreview: null,
  ratio: CONFIG.ui.defaultRatio,
};

let game = null;
let camera = null;
let renderer = null;
let input = null;
let hud = null;
let lastTime = 0;
let rafId = 0;
let hudTimer = 0;
const HUD_INTERVAL = 1 / 12;

// ---- 메뉴 ------------------------------------------------------------------

let menuDifficulty = 'normal';
let menuAiCount = CONFIG.match.aiCount;

function setupMenu() {
  for (const btn of document.querySelectorAll('#difficulty-row button')) {
    btn.addEventListener('click', () => {
      menuDifficulty = btn.dataset.diff;
      for (const b of document.querySelectorAll('#difficulty-row button')) {
        b.classList.toggle('active', b === btn);
      }
    });
  }
  for (const btn of document.querySelectorAll('#ai-row button')) {
    btn.addEventListener('click', () => {
      menuAiCount = Number(btn.dataset.ai);
      for (const b of document.querySelectorAll('#ai-row button')) {
        b.classList.toggle('active', b === btn);
      }
    });
  }
  $('btn-start').addEventListener('click', () => {
    const raw = $('seed-input').value.trim();
    const seed = raw ? seedFromString(raw) : (Math.random() * 0xffffffff) >>> 0;
    startGame({ seed, difficulty: menuDifficulty, aiCount: menuAiCount });
  });
  $('btn-restart').addEventListener('click', () => {
    $('result').classList.add('hidden');
    $('menu').classList.remove('hidden');
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  });
}

// ---- 게임 시작 --------------------------------------------------------------

function startGame(opts) {
  if (rafId) cancelAnimationFrame(rafId);
  $('menu').classList.add('hidden');
  $('result').classList.add('hidden');
  $('hud').classList.remove('hidden');

  ui.buildMode = null;
  ui.selectedCell = -1;
  ui.selectedFleet = null;
  ui.trenchPreview = null;

  game = new Game(opts);
  const canvas = $('game');
  camera = new Camera(game.map);
  renderer = new Renderer(canvas, game, camera);
  hud = new HUD(game, ui, camera, makeActions());
  input = new Input(canvas, camera, game, ui, {
    onTap: (x, y) => hud.handleTap(x, y),
    onTrenchPreview: (plan) => showTrenchCost(plan),
    onTrenchCommit: (preview) => commitTrench(preview),
    onTrenchCancel: () => hideTrenchCost(),
  });

  resize();
  const cap = game.countries[game.playerId].capitalCell;
  camera.centerOn(game.map.xOf(cap), game.map.yOf(cap), 4.5);

  $('seed-label').textContent = `seed ${opts.seed} · ${DIFFICULTY_LABELS[opts.difficulty]}`;
  hud.syncBuildButtons();
  hud.update();

  lastTime = performance.now();
  rafId = requestAnimationFrame(loop);
}

function makeActions() {
  const fail = {
    'no-border': '육상 국경이 없습니다',
    'no-balance': 'Balance 가 부족합니다',
    'no-route': '해상 경로가 없습니다',
    peace: '화친 중입니다',
    'not-coast': '해안이 아닙니다',
    invalid: '여기에는 지을 수 없습니다',
    gone: '대상이 사라졌습니다',
    own: '자기 자신입니다',
    self: '자기 자신입니다',
  };
  const report = (res) => {
    if (res && res.error) { hud.toast(fail[res.error] || '실행할 수 없습니다'); return false; }
    return true;
  };

  return {
    attack: (enemyId) => {
      if (report(game.launchAttack(game.playerId, enemyId, ui.ratio))) hud.closePanel();
    },
    expand: () => {
      if (report(game.launchExpansion(game.playerId, ui.ratio))) hud.closePanel();
    },
    invade: (cell) => {
      if (report(game.launchInvasion(game.playerId, cell, ui.ratio))) hud.closePanel();
    },
    intercept: (fleet) => {
      if (report(game.launchIntercept(game.playerId, fleet, ui.ratio))) hud.closePanel();
    },
    peace: (enemyId) => {
      const res = game.requestPeace(game.playerId, enemyId);
      hud.toast(res.ok ? '화친이 성립했습니다' : '상대가 거절했습니다');
      hud.refreshPanel();
    },
    build: (mode, cell) => {
      const res = mode === 'city'
        ? game.buildCity(game.playerId, cell)
        : game.buildFort(game.playerId, cell);
      if (res.error) hud.toast(res.error === 'no-balance' ? `Balance 부족 (${res.cost} 필요)` : '여기에는 지을 수 없습니다');
      else hud.toast(mode === 'city' ? '도시 건설' : '방어기지 건설');
    },
  };
}

// ---- 참호 미리보기 ----------------------------------------------------------

function showTrenchCost(plan) {
  const el = $('trench-cost');
  el.classList.remove('hidden');
  const p = game.countries[game.playerId];
  const ok = p.balance >= plan.cost && plan.buildableCount > 0;
  el.classList.toggle('poor', !ok);
  el.textContent = `참호 ${plan.buildableCount}칸 · ${plan.cost}`;
}

function hideTrenchCost() {
  $('trench-cost').classList.add('hidden');
}

function commitTrench(preview) {
  hideTrenchCost();
  const res = game.buildTrench(game.playerId, preview.from, preview.to);
  if (res.error === 'no-balance') hud.toast(`Balance 부족 (${res.cost} 필요)`);
  else if (res.error) hud.toast('여기에는 참호를 팔 수 없습니다');
  else hud.toast(`참호 ${res.built}칸 건설`);
}

// ---- 루프 -------------------------------------------------------------------

function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  game.tick(dt);
  renderer.render(ui);

  // HUD 는 DOM 을 다시 만드는 비용이 있으므로 매 프레임 갱신하지 않는다
  hudTimer -= dt;
  if (hudTimer <= 0) { hudTimer = HUD_INTERVAL; hud.update(); }

  if (game.over) {
    hud.showResult(game.over);
    rafId = 0;
    return;
  }
  rafId = requestAnimationFrame(loop);
}

// ---- 리사이즈 ----------------------------------------------------------------

function resize() {
  const canvas = $('game');
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  if (camera) camera.resize(rect.width, rect.height);
  if (renderer) renderer.dpr = dpr;
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));

setupMenu();
resize();

// 디버그 편의: 콘솔에서 상태를 들여다보거나 시뮬레이션을 수동으로 돌릴 수 있게 노출.
// (탭이 백그라운드면 requestAnimationFrame 이 멈추므로 자동 테스트에서 필요하다)
window.__territorial = () => ({
  game, camera, renderer, hud, ui,
  step(seconds, dt = 1 / 30) {
    for (let t = 0; t < seconds; t += dt) game.tick(dt);
    renderer.render(ui);
    hud.update();
  },
});
