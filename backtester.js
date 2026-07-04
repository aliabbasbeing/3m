#!/usr/bin/env node
// backtester.js — CLI backtester for WinGo predictor
// Usage:
//   node backtester.js <dataset.json>              — summary only
//   node backtester.js <dataset.json> --full        — full round-by-round report
//   node backtester.js <dataset.json> --streaks     — show loss streak events ≥ 5
//
// Imports predictNextWithHistory from predictor.js to ensure consistency.

import fs from 'fs';
import path from 'path';
import { predictNext, predictNextWithHistory, analyzeHistoricalPatterns } from './predictor.js';

// ─── Load & parse dataset ──────────────────────────────────────
function loadDataset(filepath) {
  const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  let arr = Array.isArray(raw) ? raw : (raw.entries || raw.data || []);
  return arr
    .map(r => ({ period: String(r.period || ''), num: parseInt(r.num, 10) }))
    .filter(r => r.period && !isNaN(r.num))
    .sort((a, b) => a.period.localeCompare(b.period));
}

// ─── Simulation ────────────────────────────────────────────────
function simulate(records, { full = false, streaks = false } = {}) {
  let simIndex = 14;
  let simHistory = [];
  let wins = 0, losses = 0, maxStreak = 0, curStreak = 0;
  let maxStreakRound = 0;
  const streakEvents = []; // { startRound, endRound, length }
  let streakStart = 0;

  const roundLog = [];

  while (simIndex < records.length - 1) {
    const end = simIndex + 1;
    const start = Math.max(0, end - 15);
    const draws = records.slice(start, end).slice().reverse();

    const result = predictNextWithHistory(draws, simHistory);
    const prediction = result.prediction;

    simIndex++;
    const roundNum = wins + losses + 1;
    const actual = records[simIndex];
    const actualLabel = actual.num > 4 ? 'Big' : 'Small';
    const correct = prediction === actualLabel;

    if (correct) {
      if (curStreak >= 5) {
        streakEvents.push({ startRound: streakStart, endRound: roundNum - 1, length: curStreak });
      }
      wins++;
      curStreak = 0;
    } else {
      if (curStreak === 0) streakStart = roundNum;
      losses++;
      curStreak++;
      if (curStreak > maxStreak) {
        maxStreak = curStreak;
        maxStreakRound = roundNum;
      }
    }

    if (full) {
      roundLog.push({
        round: roundNum,
        period: actual.period,
        prediction,
        actual: actualLabel,
        correct,
        streak: correct ? 0 : curStreak,
        logic: result.logic,
        reasoning: result.reasoning
      });
    }

    simHistory.unshift({
      period: actual.period,
      guess: prediction,
      num: actual.num,
      actual: actualLabel,
      correct,
      confidence: result.confidence,
      reasoning: result.reasoning,
      timestamp: Date.now()
    });
    if (simHistory.length > 1000) simHistory.pop();
  }

  // Capture final streak if still running
  if (curStreak >= 5) {
    streakEvents.push({ startRound: streakStart, endRound: wins + losses, length: curStreak });
  }

  const total = wins + losses;
  return {
    total,
    wins,
    losses,
    winRate: (wins / total * 100).toFixed(2),
    maxStreak,
    maxStreakRound,
    streakEvents,
    roundLog
  };
}

// ─── Main ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node backtester.js <dataset.json> [--full] [--streaks]');
  console.log('  --full     Print every round');
  console.log('  --streaks  Print loss streak events ≥ 5');
  process.exit(0);
}

const datasetPath = args.find(a => !a.startsWith('--'));
if (!datasetPath || !fs.existsSync(datasetPath)) {
  console.error(`Error: Dataset file not found: ${datasetPath}`);
  process.exit(1);
}

const full = args.includes('--full');
const showStreaks = args.includes('--streaks');

const records = loadDataset(datasetPath);
console.log(`Dataset: ${path.basename(datasetPath)} (${records.length} records)`);
console.log(`Simulating ${records.length - 15} rounds...\n`);

const result = simulate(records, { full, streaks: showStreaks });

// ─── Summary ───────────────────────────────────────────────────
console.log('════════════════════════════════════════');
console.log(` Rounds:      ${result.total}`);
console.log(` Wins:        ${result.wins}`);
console.log(` Losses:      ${result.losses}`);
console.log(` Win Rate:    ${result.winRate}%`);
console.log(` Max Streak:  ${result.maxStreak} (at round ${result.maxStreakRound})`);
console.log(` Streak ≤ 9:  ${result.maxStreak <= 9 ? 'PASS' : 'FAIL'}`);
console.log('════════════════════════════════════════');

// ─── Streak events ─────────────────────────────────────────────
if (showStreaks && result.streakEvents.length > 0) {
  console.log(`\nLoss streak events ≥ 5 (${result.streakEvents.length} total):`);
  for (const e of result.streakEvents) {
    const flag = e.length >= 9 ? ' ⚠' : '';
    console.log(`  Rounds ${e.startRound}-${e.endRound}: ${e.length} consecutive losses${flag}`);
  }
}

// ─── Full report ───────────────────────────────────────────────
if (full && result.roundLog.length > 0) {
  console.log('\nFull round-by-round report:');
  console.log('Round  Period          Pred    Actual  Result  Streak  Logic');
  console.log('─'.repeat(75));
  for (const r of result.roundLog) {
    const res = r.correct ? '✓' : `✗ L${r.streak}`;
    console.log(
      `${String(r.round).padStart(5)}  ${r.period.padEnd(14)}  ${r.prediction.padEnd(6)}  ${r.actual.padEnd(6)}  ${res.padEnd(6)}  ${String(r.streak).padStart(6)}  ${r.logic}`
    );
  }
}
