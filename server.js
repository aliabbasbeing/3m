// server.js
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  fetchLatestData,
  predictNextWithHistory,
  computeStages,
  getStreakFromDraws,
  label,
  predictNext,
  analyzeHistoricalPatterns
} from './predictor.js';

import {
  history, lastPrediction, lastPeriod, lastPeriodForTimer, prevPeriod,
  setHistory, setLastPrediction, setLastPeriod, setLastPeriodForTimer, setPrevPeriod,
  loadState, saveState, resetState, getStateSnapshot, pruneHistory,
  notifyConfig, setNotifyConfig,
  mgState, mgStart, mgReset, mgEnd, mgProcessHistory
} from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3003;
let ntfyLastAlertPeriod = null;

// ─── Express Setup ─────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// REST API Endpoints
app.get('/api/state', (req, res) => {
  res.json(getStateSnapshot());
});

app.get('/api/history', (req, res) => {
  pruneHistory();
  res.json({ history, total: history.length });
});

app.get('/api/notify-config', (req, res) => {
  res.json({ ok: true, notifyConfig });
});

app.post('/api/notify-config', (req, res) => {
  try {
    setNotifyConfig(req.body || {});
    ntfyLastAlertPeriod = null;
    saveState();
    broadcast({ type: 'notify_config', notifyConfig });
    res.json({ ok: true, notifyConfig });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Invalid notify config' });
  }
});

app.post('/api/reset', (req, res) => {
  resetState();
  mgReset();
  ntfyLastAlertPeriod = null;
  broadcast({ type: 'reset' });
  res.json({ ok: true });
});

// ─── Martingale API ────────────────────────────────────────────────
app.get('/api/mg/state', (req, res) => {
  res.json({ ok: true, mgState });
});

app.post('/api/mg/start', (req, res) => {
  try {
    const config = req.body || {};
    mgStart(config);
    saveState();
    broadcast({ type: 'state', data: getStateSnapshot() });
    res.json({ ok: true, mgState });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Invalid martingale config' });
  }
});

app.post('/api/mg/reset', (req, res) => {
  mgReset();
  saveState();
  broadcast({ type: 'state', data: getStateSnapshot() });
  res.json({ ok: true, mgState });
});

app.post('/api/mg/end', (req, res) => {
  mgEnd();
  saveState();
  broadcast({ type: 'state', data: getStateSnapshot() });
  res.json({ ok: true, mgState });
});

// ─── Backtest API ──────────────────────────────────────────────────

// ─── Synthetic Dataset Generator ───────────────────────────────────
app.post('/api/generate-dataset', (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body.count, 10) || 5000, 50), 50000);
  const seed = req.body.seed || null;

  // Seeded PRNG (xorshift32) for reproducibility
  let s = seed ? (seed ^ 0xDEADBEEF) >>> 0 : (Date.now() ^ 0xC0FFEE) >>> 0;
  function rand() {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0xFFFFFFFF;
  }

  // Generate base period number (mimics real 17-digit format)
  const basePeriod = BigInt('20260401100050000');
  const records = [];

  // Pattern state
  let streakType = null; // 'Big' or 'Small'
  let streakLen = 0;

  for (let i = 0; i < count; i++) {
    const period = String(basePeriod + BigInt(i));
    let num;

    const r = rand();
    // Mimic real WinGo patterns:
    // 1. Streaks of 2-4 are common (~30% chance to continue a streak)
    // 2. Long streaks (5+) are rare (~15% chance)
    // 3. Alternating patterns appear sometimes
    // 4. Numbers cluster around certain values temporarily

    if (streakLen > 0 && streakLen < 3 && rand() < 0.42) {
      // Continue short streak
      num = streakType === 'Big' ? Math.floor(rand() * 5) + 5 : Math.floor(rand() * 5);
    } else if (streakLen >= 3 && streakLen < 6 && rand() < 0.25) {
      // Continue medium streak (less likely)
      num = streakType === 'Big' ? Math.floor(rand() * 5) + 5 : Math.floor(rand() * 5);
    } else if (streakLen >= 6 && rand() < 0.12) {
      // Continue long streak (rare)
      num = streakType === 'Big' ? Math.floor(rand() * 5) + 5 : Math.floor(rand() * 5);
    } else {
      // Fresh number — weighted distribution mimicking real data
      // Real data shows slight bias patterns that shift over time
      const phase = Math.sin(i / 80) * 0.08; // slow drift bias
      const bias = 0.5 + phase;
      if (rand() < bias) {
        num = Math.floor(rand() * 5) + 5; // Big: 5-9
      } else {
        num = Math.floor(rand() * 5); // Small: 0-4
      }
    }

    const label = num > 4 ? 'Big' : 'Small';
    if (records.length > 0) {
      const prevLabel = records[records.length - 1].num > 4 ? 'Big' : 'Small';
      if (label === prevLabel) {
        if (label === streakType) streakLen++;
        else { streakType = label; streakLen = 2; }
      } else {
        streakType = label;
        streakLen = 1;
      }
    } else {
      streakType = label;
      streakLen = 1;
    }

    // Color mapping (matches real WinGo API)
    let color;
    if (num === 0) color = 'red,violet';
    else if (num === 5) color = 'green,violet';
    else if (num % 2 === 0) color = 'red';
    else color = 'green';

    records.push({
      period,
      num,
      color,
      premium: num,
      timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
      bigSmall: label
    });
  }

  // Compute stats for the generated dataset
  const bigCount = records.filter(r => r.num > 4).length;
  const smallCount = records.length - bigCount;
  let maxStreak = 0, curStreak = 0, prevType = null;
  for (const r of records) {
    const t = r.num > 4 ? 'Big' : 'Small';
    if (t === prevType) { curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
    else { curStreak = 1; prevType = t; }
  }

  res.json({
    ok: true,
    records,
    count: records.length,
    stats: {
      big: bigCount, small: smallCount,
      bigPct: +(bigCount / records.length * 100).toFixed(1),
      smallPct: +(smallCount / records.length * 100).toFixed(1),
      maxConsecutive: maxStreak
    }
  });
});

// Import data from external API (same as backtester HTML)
app.get('/api/backtest/import', async (req, res) => {
  try {
    const apiRes = await fetch('http://64.227.185.106:3000/api/wingo3m-history');
    if (!apiRes.ok) throw new Error('External API HTTP ' + apiRes.status);
    const data = await apiRes.json();
    const entries = data.entries;
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('No entries');
    const records = entries
      .map(e => ({ period: String(e.period || ''), num: parseInt(e.num, 10) }))
      .filter(r => r.period && !isNaN(r.num))
      .sort((a, b) => a.period.localeCompare(b.period));
    res.json({ ok: true, records, count: records.length });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Run backtest on provided records
app.post('/api/backtest/run', (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length < 20) {
    return res.status(400).json({ ok: false, error: 'Need at least 20 records' });
  }

  // Sort oldest→newest
  const sorted = records
    .map(r => ({ period: String(r.period || ''), num: parseInt(r.num, 10) }))
    .filter(r => r.period && !isNaN(r.num))
    .sort((a, b) => a.period.localeCompare(b.period));

  let simIndex = 14;
  let simHistory = [];
  let wins = 0, losses = 0, maxStreak = 0, curStreak = 0, maxStreakRound = 0;
  let curWinStreak = 0, maxWinStreak = 0;
  let antiStreakCount = 0, adaptiveCount = 0, histOverrideCount = 0;
  const log = [];
  const streakEvents = [];
  let streakStart = 0;

  while (simIndex < sorted.length - 1) {
    const end = simIndex + 1;
    const start = Math.max(0, end - 15);
    const draws = sorted.slice(start, end).slice().reverse();

    const result = predictNextWithHistory(draws, simHistory);
    const prediction = result.prediction;

    simIndex++;
    const roundNum = log.length + 1;
    const actual = sorted[simIndex];
    const actualLabel = actual.num > 4 ? 'Big' : 'Small';
    const correct = prediction === actualLabel;

    if (result.logic === 'anti-streak') antiStreakCount++;
    if (result.logic === 'adaptive') adaptiveCount++;
    if (result.logic === 'hist-override') histOverrideCount++;

    if (correct) {
      if (curStreak >= 5) streakEvents.push({ start: streakStart, end: roundNum - 1, len: curStreak });
      wins++; curStreak = 0; curWinStreak++;
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    } else {
      if (curStreak === 0) streakStart = roundNum;
      losses++; curStreak++; curWinStreak = 0;
      if (curStreak > maxStreak) { maxStreak = curStreak; maxStreakRound = roundNum; }
    }

    log.push({
      n: roundNum, period: actual.period,
      pred: prediction, actual: actualLabel,
      correct, lossStreak: correct ? 0 : curStreak, logic: result.logic
    });

    simHistory.unshift({
      period: actual.period, guess: prediction, num: actual.num,
      actual: actualLabel, correct,
      confidence: result.confidence, reasoning: result.reasoning,
      timestamp: Date.now()
    });
    if (simHistory.length > 1000) simHistory.pop();
  }

  if (curStreak >= 5) streakEvents.push({ start: streakStart, end: log.length, len: curStreak });

  const total = wins + losses;
  res.json({
    ok: true,
    stats: {
      total, wins, losses,
      winRate: +(wins / total * 100).toFixed(2),
      maxLossStreak: maxStreak, maxLossStreakRound: maxStreakRound,
      maxWinStreak,
      antiStreakCount, adaptiveCount, histOverrideCount
    },
    streakEvents,
    log
  });
});

// Run backtest on server's own live history
app.get('/api/backtest/live-stats', (req, res) => {
  const resolved = history.filter(h => typeof h.correct === 'boolean');
  const wins = resolved.filter(h => h.correct).length;
  const losses = resolved.filter(h => !h.correct).length;
  const total = wins + losses;

  let maxStreak = 0, curStreak = 0, maxStreakRound = 0;
  let maxWinStreak = 0, curWinStreak = 0;
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (!resolved[i].correct) {
      curStreak++; curWinStreak = 0;
      if (curStreak > maxStreak) { maxStreak = curStreak; maxStreakRound = resolved.length - i; }
    } else {
      curWinStreak++; curStreak = 0;
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    }
  }

  // Loss streak distribution
  const streakDist = {};
  let cs = 0;
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (!resolved[i].correct) { cs++; }
    else { if (cs > 0) streakDist[cs] = (streakDist[cs] || 0) + 1; cs = 0; }
  }
  if (cs > 0) streakDist[cs] = (streakDist[cs] || 0) + 1;

  res.json({
    ok: true,
    total, wins, losses,
    winRate: total > 0 ? +(wins / total * 100).toFixed(2) : 0,
    maxLossStreak: maxStreak, maxWinStreak,
    streakDistribution: streakDist,
    historyCount: history.length,
    oldestRecord: resolved[resolved.length - 1]?.period || null,
    newestRecord: resolved[0]?.period || null
  });
});

// ─── HTTP + WebSocket Server ────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Browser connected. Total:', wss.clients.size);
  // Send current state immediately to newly connected browser
  ws.send(JSON.stringify({ type: 'state', data: getStateSnapshot() }));

  ws.on('close', () => {
    console.log('[WS] Browser disconnected. Total:', wss.clients.size);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

/**
 * Broadcast to ALL connected browsers
 */
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN = 1
      client.send(msg);
    }
  });
}

function getCurrentLossStage(hist) {
  const resolved = hist.filter(entry => entry.actual !== 'loading...' && typeof entry.correct === 'boolean');
  const seenPeriods = new Set();
  const deduped = resolved.filter(entry => {
    if (seenPeriods.has(entry.period)) return false;
    seenPeriods.add(entry.period);
    return true;
  });

  let lossStreak = 0;
  for (let i = 0; i < deduped.length; i++) {
    if (deduped[i].correct === false) lossStreak++;
    else break;
  }

  return lossStreak + 1;
}

async function sendNtfyStageAlert({ period, prediction, stage }) {
  const normalizedPrediction = String(prediction).toUpperCase();
  const message = [
    'WINGO LOSS STAGE ALERT',
    '',
    `Period: ${period}`,
    `Prediction: ${normalizedPrediction}`,
    `Stage: S${stage}`,
    '',
    'Alert will continue until stage resets to S1.'
  ].join('\n');

  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(notifyConfig.topic)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Title': `WinGO Stage S${stage}`,
      'Priority': 'high',
      'Tags': 'warning,chart_with_upwards_trend'
    },
    body: message
  });

  if (!response.ok) {
    throw new Error(`ntfy HTTP ${response.status}`);
  }

  console.log(`[ntfy] Alert sent -> ${message}`);
}

// ─── Predictor Engine ──────────────────────────────────────────────
let _tickRunning = false;
let polling = null;
let pollInterval = null;

async function tick(force = false) {
  if (_tickRunning) return;
  _tickRunning = true;

  try {
    const { draws, serverTime } = await fetchLatestData();
    if (!draws || !draws.length) {
      console.error('[Tick] No draws data.');
      return;
    }

    const latest = draws[0];
    const currentStreak = getStreakFromDraws(draws);

    // ── Timer: New period? Broadcast countdown reset ──
    if (lastPeriodForTimer !== latest.period) {
      setLastPeriodForTimer(latest.period);
      broadcast({ type: 'countdown_reset', serverTime, period: latest.period });
    }

    // ── If same period and not forced, just broadcast streak update ──
    if (!force && lastPeriod === latest.period) {
      broadcast({
        type: 'tick_same',
        streak: currentStreak,
        stats: getStateSnapshot().stats
      });
      scheduleNextPoll(serverTime);
      return;
    }

    // ── Resolve last prediction result ──
    // _lastPrediction and _history hold references to the live state objects
    let _lastPrediction = lastPrediction;
    let _history = history;

    if (_lastPrediction && _lastPrediction.period === latest.period) {
      _lastPrediction.num = latest.num;
      _lastPrediction.actual = label(latest.num);
      _lastPrediction.correct = _lastPrediction.guess === _lastPrediction.actual;

      if (_lastPrediction.correct) {
        broadcast({ type: 'win', period: latest.period });
        console.log(`[Tick] ✅ WIN — Period ${latest.period}`);
      } else {
        console.log(`[Tick] ❌ LOSS — Period ${latest.period}`);
      }
    }

    // ── Resolve ALL orphaned "loading..." entries from draws ──
    const drawMap = new Map(draws.map(d => [d.period, d]));
    for (let i = 0; i < _history.length; i++) {
      const h = _history[i];
      if (h.actual === 'loading...' && drawMap.has(h.period)) {
        const draw = drawMap.get(h.period);
        h.num = draw.num;
        h.actual = label(draw.num);
        h.correct = h.guess === h.actual;
      }
    }

    // ── New prediction for next period ──
    const nextPeriod = String(BigInt(latest.period) + 1n);
    const predictionResult = predictNextWithHistory(draws, _history);
    const nextGuess = predictionResult.prediction;

    const newPrediction = {
      period: nextPeriod,
      guess: nextGuess,
      num: null,
      actual: 'loading...',
      correct: null,
      confidence: predictionResult.confidence,
      reasoning: predictionResult.reasoning,
      logic: predictionResult.logic,
      confirmed: predictionResult.confirmed || null,
      confirmSignals: predictionResult.confirmSignals || null,
      timestamp: Date.now()
    };

    setLastPrediction(newPrediction);

    // Add to history (deduplicate)
    const alreadyExists = _history.some(
      h => h.period === newPrediction.period && h.actual === 'loading...'
    );
    if (!alreadyExists) {
      _history.unshift(newPrediction);
    }
    pruneHistory();

    // Compute stages for UI
    computeStages(_history);

    // Process martingale if active
    if (mgState.active) {
      mgProcessHistory();
    }

    const currentLossStage = getCurrentLossStage(_history);
    if (currentLossStage === 1) {
      ntfyLastAlertPeriod = null;
    } else if (currentLossStage >= notifyConfig.threshold && ntfyLastAlertPeriod !== nextPeriod) {
      try {
        await sendNtfyStageAlert({
          period: nextPeriod,
          prediction: nextGuess,
          stage: currentLossStage
        });
        ntfyLastAlertPeriod = nextPeriod;
      } catch (notifyErr) {
        console.error('[ntfy] Send failed:', notifyErr.message);
      }
    }

    setLastPeriod(latest.period);

    // ── Console log ──
    console.log(`[Tick] Period ${latest.period} resolved. Next: ${nextPeriod} → ${nextGuess}`);
    console.log(`[Tick] Confidence: ${(predictionResult.confidence * 100).toFixed(1)}% | Logic: ${predictionResult.logic} | ${predictionResult.confirmed ? predictionResult.confirmed + ' (' + predictionResult.confirmSignals + ')' : 'unconfirmed'}`);
    console.log(`[Tick] Reasoning: ${predictionResult.reasoning}`);

    // ── Save state to disk ──
    saveState();

    // ── Broadcast new state to all browsers ──
    broadcast({
      type: 'state',
      data: getStateSnapshot()
    });

    // ── Schedule next poll ──
    scheduleNextPoll(serverTime);

  } catch (err) {
    console.error('[Tick] Error:', err.message);
    // Retry in 5 seconds on error
    setTimeout(() => tick(true), 5000);
  } finally {
    _tickRunning = false;
  }
}

/**
 * Schedule next poll for 3M periods.
 * Period boundaries occur at :00, :03, :06, :09, …, :57 of each hour.
 * Poll 10 seconds before next boundary, then high-frequency poll.
 */
function scheduleNextPoll(serverTime) {
  if (polling) clearTimeout(polling);

  const now = new Date(serverTime);
  const minutes = now.getUTCMinutes();
  const nextMultipleOf3 = Math.ceil((minutes + 1) / 3) * 3;
  let nextBoundary = new Date(serverTime);
  nextBoundary.setUTCMinutes(nextMultipleOf3, 0, 0);
  if (nextMultipleOf3 >= 60) {
    nextBoundary.setUTCHours(nextBoundary.getUTCHours() + 1);
    nextBoundary.setUTCMinutes(0, 0, 0);
  }

  const deadline = nextBoundary.getTime();
  const timeToPoll = deadline - serverTime - 10000; // Start polling 10s before boundary

  polling = setTimeout(startPeriodPolling, Math.max(100, timeToPoll));
  console.log(`[Timer] Next poll in ${Math.round(Math.max(100, timeToPoll) / 1000)}s`);
}

/**
 * High-frequency polling — check every 1.2s for new period.
 * Stop as soon as period changes, then run tick().
 */
function startPeriodPolling() {
  if (pollInterval) clearInterval(pollInterval);
  let lastCheckedPeriod = lastPeriod;

  console.log('[Poll] High-frequency polling started...');

  pollInterval = setInterval(async () => {
    try {
      const { draws } = await fetchLatestData();
      if (!draws || !draws.length) return;
      const latest = draws[0];
      if (latest.period !== lastCheckedPeriod) {
        clearInterval(pollInterval);
        pollInterval = null;
        console.log(`[Poll] New period detected: ${latest.period}. Running tick...`);
        tick(true);
      }
    } catch (e) {
      // Silent — retry next interval
    }
  }, 1200);
}

// ─── Startup ────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🚀 WinGO Predictor Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`📂 API: http://localhost:${PORT}/api/state\n`);

  // Load saved state from disk
  loadState();
  ntfyLastAlertPeriod = getCurrentLossStage(history) >= notifyConfig.threshold
    ? lastPrediction?.period || null
    : null;

  // Run first tick immediately
  console.log('[Startup] Running initial tick...');
  await tick(true);
});

// ─── Graceful Shutdown ──────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Saving state before exit...');
  saveState();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  process.exit(0);
});
