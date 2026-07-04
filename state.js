// state.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MARTINGALE_FILE = path.join(DATA_DIR, 'martingale.json');
export const HISTORY_RETENTION_HOURS = 96;
export const HISTORY_RETENTION_MS = HISTORY_RETENTION_HOURS * 60 * 60 * 1000;
export const HISTORY_LIMIT = HISTORY_RETENTION_MS / 180000;
export const SNAPSHOT_HISTORY_LIMIT = 50;
const DEFAULT_NOTIFY_CONFIG = {
  topic: 'wingo-ali',
  threshold: 6
};

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── In-Memory State ───────────────────────────────────────────────
export let history = [];          // Array of prediction records
export let lastPrediction = null; // { period, guess, num, actual, correct, ... }
export let lastPeriod = null;     // String — last resolved period
export let lastPeriodForTimer = null;
export let prevPeriod = null;
export let notifyConfig = { ...DEFAULT_NOTIFY_CONFIG };

// ─── Martingale State ─────────────────────────────────────────────
export let mgState = {
  active: false,
  startBal: 25000,
  baseBet: 15,
  lossMulti: 2,
  payoutMulti: 1.96,
  balance: 25000,
  stage: 0,
  bet: 0,
  sessionPL: 0,
  lossStreak: 0,
  processedPeriods: [],
  log: [],
  BETS: [],
  setupBets: []
};

// Setters (needed because ES modules export bindings)
export function setHistory(val) { history = val; }
export function setLastPrediction(val) { lastPrediction = val; }
export function setLastPeriod(val) { lastPeriod = val; }
export function setLastPeriodForTimer(val) { lastPeriodForTimer = val; }
export function setPrevPeriod(val) { prevPeriod = val; }
export function setNotifyConfig(val) {
  notifyConfig = sanitizeNotifyConfig(val);
}

// ─── Martingale Functions ──────────────────────────────────────────
export function mgStart(config) {
  const { startBal, baseBet, lossMulti, payoutMulti, setupBets } = config;
  mgState.startBal = Number(startBal) > 0 ? Number(startBal) : 25000;
  mgState.baseBet = Number(baseBet) > 0 ? Number(baseBet) : 15;
  mgState.lossMulti = Number(lossMulti) > 1 ? Number(lossMulti) : 2;
  mgState.payoutMulti = Number(payoutMulti) > 1 ? Number(payoutMulti) : 1.96;
  mgState.setupBets = Array.isArray(setupBets) && setupBets.length > 0
    ? setupBets.map(Number).filter(n => n > 0)
    : buildDefaultBets(mgState.baseBet, mgState.lossMulti);
  mgState.BETS = mgState.setupBets.slice();
  mgState.balance = mgState.startBal;
  mgState.stage = 0;
  mgState.bet = mgState.BETS[0];
  mgState.sessionPL = 0;
  mgState.lossStreak = 0;
  mgState.log = [];
  mgState.active = true;
  mgState.processedPeriods = captureResolvedPeriods();
  saveMartingale();
  return mgState;
}

export function mgReset() {
  mgState.active = false;
  mgState.log = [];
  mgState.processedPeriods = [];
  mgState.lossStreak = 0;
  mgState.stage = 0;
  mgState.sessionPL = 0;
  saveMartingale();
  return mgState;
}

export function mgEnd() {
  if (!mgState.active) return mgState;
  mgState.active = false;
  mgState.startBal = Math.round(mgState.balance * 100) / 100;
  saveMartingale();
  return mgState;
}

export function mgProcessHistory() {
  if (!mgState.active) return false;

  const resolved = history.filter(h => typeof h.correct === 'boolean');
  const processed = new Set(mgState.processedPeriods);
  const unprocessed = [];
  const seenNew = new Set();

  for (const entry of resolved) {
    const period = String(entry.period || '');
    if (!period || processed.has(period) || seenNew.has(period)) continue;
    seenNew.add(period);
    unprocessed.push(entry);
  }

  if (unprocessed.length === 0) return false;

  let changed = false;
  for (let i = unprocessed.length - 1; i >= 0; i--) {
    const entry = unprocessed[i];
    const period = String(entry.period || '');
    if (entry.correct === true) mgApplyWin(period);
    else if (entry.correct === false) mgApplyLoss(period);
    processed.add(period);
    changed = true;
  }

  mgState.processedPeriods = Array.from(processed);
  if (mgState.processedPeriods.length > 1000) {
    mgState.processedPeriods = mgState.processedPeriods.slice(-1000);
  }
  if (changed) saveMartingale();
  return changed;
}

function mgApplyWin(period) {
  const net = Math.round((mgState.bet * mgState.payoutMulti - mgState.bet) * 100) / 100;
  mgState.balance = Math.round((mgState.balance + net) * 100) / 100;
  mgState.sessionPL = Math.round((mgState.sessionPL + net) * 100) / 100;
  mgState.log.unshift({ n: mgState.log.length + 1, period, win: true, stage: mgState.stage, bet: mgState.bet, balance: mgState.balance });
  mgState.lossStreak = 0;
  mgState.stage = 0;
  mgState.bet = mgState.baseBet;
}

function mgApplyLoss(period) {
  mgState.balance = Math.round((mgState.balance - mgState.bet) * 100) / 100;
  mgState.sessionPL = Math.round((mgState.sessionPL - mgState.bet) * 100) / 100;
  mgState.log.unshift({ n: mgState.log.length + 1, period, win: false, stage: mgState.stage, bet: mgState.bet, balance: mgState.balance });
  mgState.lossStreak++;
  mgState.stage = Math.min(mgState.stage + 1, mgState.BETS.length - 1);
  mgState.bet = mgState.BETS[mgState.stage];
}

function captureResolvedPeriods() {
  const seen = new Set();
  const periods = [];
  for (const entry of history) {
    if (typeof entry.correct !== 'boolean') continue;
    const period = String(entry.period || '');
    if (!period || seen.has(period)) continue;
    seen.add(period);
    periods.push(period);
  }
  return periods;
}

function buildDefaultBets(base, multi) {
  const bets = [base];
  for (let i = 0; i < 9; i++) bets.push(Math.round(bets[bets.length - 1] * multi));
  return bets;
}

function saveMartingale() {
  try {
    fs.writeFileSync(MARTINGALE_FILE, JSON.stringify(mgState, null, 2));
  } catch (e) {
    console.error('[State] Martingale save error:', e.message);
  }
}

function loadMartingale() {
  try {
    if (fs.existsSync(MARTINGALE_FILE)) {
      const raw = fs.readFileSync(MARTINGALE_FILE, 'utf8');
      const saved = JSON.parse(raw);
      mgState = { ...mgState, ...saved };
      console.log(`[State] Loaded martingale state: active=${mgState.active}, balance=${mgState.balance}`);
    }
  } catch (e) {
    console.error('[State] Martingale load error:', e.message);
  }
}

// ─── Persistence ──────────────────────────────────────────────────

/**
 * Save history + meta to disk.
 * Call this on every new period (not every second).
 */
export function saveState() {
  try {
    history = pruneHistoryEntries(history);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastPeriod,
      lastPrediction,
      notifyConfig,
      savedAt: Date.now()
    }, null, 2));
  } catch (e) {
    console.error('[State] Save error:', e.message);
  }
}

/**
 * Load history from disk on server startup.
 * No expiry — history is permanent until manually cleared.
 */
export function loadState() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
      history = JSON.parse(raw);
      // Deduplicate (same logic as HTML file)
      const seenLoad = new Set();
      history = history.filter(h => {
        const key = h.period + '|' + h.timestamp;
        if (seenLoad.has(h.period) && h.actual !== 'loading...') return false;
        if (seenLoad.has(key)) return false;
        seenLoad.add(h.period);
        seenLoad.add(key);
        return true;
      });
      history = pruneHistoryEntries(history);
      console.log(`[State] Loaded ${history.length} history records from disk.`);
    }
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const s = JSON.parse(raw);
      lastPeriod = s.lastPeriod || null;
      lastPrediction = s.lastPrediction || null;
      notifyConfig = sanitizeNotifyConfig(s.notifyConfig);
      console.log(`[State] Loaded lastPeriod: ${lastPeriod}`);
    }
    loadMartingale();
  } catch (e) {
    console.error('[State] Load error:', e.message);
    history = [];
    lastPrediction = null;
    lastPeriod = null;
  }
}

/**
 * Full reset — clears memory + disk.
 */
export function resetState() {
  history = [];
  lastPrediction = null;
  lastPeriod = null;
  lastPeriodForTimer = null;
  prevPeriod = null;
  try {
    if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastPeriod,
      lastPrediction,
      notifyConfig,
      savedAt: Date.now()
    }, null, 2));
  } catch (e) {}
  console.log('[State] Full reset done.');
}

/**
 * Returns current state snapshot for WebSocket broadcast / API.
 */
export function getStateSnapshot() {
  history = pruneHistoryEntries(history);
  const wins = history.filter(h => h.correct === true).length;
  const losses = history.filter(h => h.correct === false).length;
  const total = wins + losses;
  const accuracy = total > 0 ? Math.round((wins / total) * 100) : null;
  const maxLossStreak = computeMaxLossStreak(history);
  const currentLossStreak = computeCurrentLossStreak(history);
  const currentStreak = computeCurrentStreak(history);

  return {
    history: history.slice(0, SNAPSHOT_HISTORY_LIMIT),
    historyCount: history.length,
    lastPrediction,
    lastPeriod,
    notifyConfig,
    currentLossStage: currentLossStreak + 1,
    currentStreak,
    mgState,
    stats: { wins, losses, total, accuracy, maxLossStreak, currentLossStreak }
  };
}

export function pruneHistory() {
  history = pruneHistoryEntries(history);
  return history;
}

function sanitizeNotifyConfig(config) {
  const topic = String(config?.topic || DEFAULT_NOTIFY_CONFIG.topic).trim() || DEFAULT_NOTIFY_CONFIG.topic;
  const thresholdRaw = Number(config?.threshold);
  const threshold = Number.isFinite(thresholdRaw)
    ? Math.max(1, Math.floor(thresholdRaw))
    : DEFAULT_NOTIFY_CONFIG.threshold;
  return { topic, threshold };
}

function pruneHistoryEntries(entries) {
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  const trimmed = entries.filter((entry, index) => {
    const timestamp = Number(entry?.timestamp);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      return timestamp >= cutoff;
    }
    return index < HISTORY_LIMIT;
  });
  return trimmed.slice(0, HISTORY_LIMIT);
}

function computeMaxLossStreak(hist) {
  let max = 0, cur = 0;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i].correct === false) { cur++; if (cur > max) max = cur; }
    else if (hist[i].correct === true) { cur = 0; }
  }
  return max;
}

function computeCurrentLossStreak(hist) {
  // Dedupe first
  const recentCompleted = hist.filter(h => h.actual !== 'loading...' && typeof h.correct === 'boolean');
  const seen = new Set();
  const deduped = recentCompleted.filter(h => {
    if (seen.has(h.period)) return false;
    seen.add(h.period);
    return true;
  });
  let streak = 0;
  for (let i = 0; i < deduped.length; i++) {
    if (deduped[i].correct === false) streak++;
    else break;
  }
  return streak;
}

function computeCurrentStreak(hist) {
  const recentCompleted = hist.filter(h => h.actual !== 'loading...' && typeof h.correct === 'boolean' && h.num != null);
  const seen = new Set();
  const deduped = recentCompleted.filter(h => {
    if (seen.has(h.period)) return false;
    seen.add(h.period);
    return true;
  });
  if (deduped.length === 0) return { type: null, count: 0 };
  const firstResult = deduped[0].num > 4 ? 'Big' : 'Small';
  let streak = { type: firstResult, count: 1 };
  for (let i = 1; i < deduped.length; i++) {
    const result = deduped[i].num > 4 ? 'Big' : 'Small';
    if (result === streak.type) streak.count++;
    else break;
  }
  return streak;
}
