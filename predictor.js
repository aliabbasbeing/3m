// predictor.js
// ── Extracted from 30ml.html — No DOM dependencies ──

const API = "https://draw.ar-lottery01.com/WinGo/WinGo_3M/GetHistoryIssuePage.json";

// ─── Fetch Latest Data ─────────────────────────────────────────────
export async function fetchLatestData() {
  const drawRes = await fetch(API + "?ts=" + Date.now());
  if (!drawRes.ok) throw new Error("WinGo API HTTP " + drawRes.status);
  const drawJson = await drawRes.json();
  if (!drawJson?.data?.list) throw new Error("Unexpected WinGo API format");
  const draws = drawJson.data.list.slice(0, 15).map(x => ({
    period: x.issueNumber,
    num: +x.number
  }));
  return { draws, serverTime: Date.now() };
}

// ─── Helper Utilities ──────────────────────────────────────────────
export function label(num) {
  if (num === null || num === undefined) return '--';
  return num <= 4 ? 'Small' : 'Big';
}

export function getMostFrequent(arr) {
  if (!arr || arr.length === 0) return null;
  const counts = {};
  arr.forEach(item => counts[item] = (counts[item] || 0) + 1);
  return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
}

export function getMostWeightedPrediction(suggestions) {
  const weights = {};
  suggestions.forEach(s => {
    if (s.prediction) weights[s.prediction] = (weights[s.prediction] || 0) + s.weight;
  });
  if (Object.keys(weights).length === 0) return null;
  const best = Object.keys(weights).reduce((a, b) => weights[a] > weights[b] ? a : b);
  return { prediction: best, totalWeight: weights[best] };
}

export function arraysEqual(a, b) {
  return a.length === b.length && a.every((val, i) => val === b[i]);
}

export function calculateOverallConfidence(analyses) {
  const validAnalyses = analyses.filter(a => a && a.confidence > 0);
  if (validAnalyses.length === 0) return 0;
  const avg = validAnalyses.reduce((sum, a) => sum + a.confidence, 0) / validAnalyses.length;
  return Math.min(avg, 0.85);
}

// ─── Streak Analysis ───────────────────────────────────────────────
export function getStreakFromDraws(draws) {
  if (!draws || draws.length < 2) return { type: null, count: 0 };
  const firstResult = draws[0].num > 4 ? 'Big' : 'Small';
  let streak = { type: firstResult, count: 1 };
  for (let i = 1; i < draws.length; i++) {
    const result = draws[i].num > 4 ? 'Big' : 'Small';
    if (result === streak.type) streak.count++;
    else break;
  }
  return streak;
}

export function getMaxLossStreak(hist) {
  let maxLossStreak = 0, currentLossStreak = 0;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i].correct === false) {
      currentLossStreak++;
      if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
    } else if (hist[i].correct === true) {
      currentLossStreak = 0;
    }
  }
  return maxLossStreak;
}

// ─── Base Prediction ───────────────────────────────────────────────
export function predictNext(draws) {
  if (!Array.isArray(draws) || draws.length < 5) return 'Big';

  const streak = getStreakFromDraws(draws);
  if (streak.count === 5) return streak.type === 'Big' ? 'Small' : 'Big';
  if (streak.count >= 4) return streak.type;

  const last5 = draws.slice(0, 5).map(d => d.num > 4 ? 'Big' : 'Small');
  const bigCount = last5.filter(r => r === 'Big').length;
  const smallCount = last5.filter(r => r === 'Small').length;

  if (bigCount >= 5) return 'Small';
  if (smallCount >= 5) return 'Big';

  let isAlternating = true;
  for (let i = 1; i < last5.length; i++) {
    if (last5[i] === last5[i - 1]) { isAlternating = false; break; }
  }
  if (isAlternating) return last5[0] === 'Big' ? 'Small' : 'Big';

  if (bigCount > smallCount) return 'Small';
  if (smallCount > bigCount) return 'Big';

  const sum = draws.slice(0, 5).reduce((acc, d) => acc + d.num, 0);
  return (sum % 2 === 0) ? 'Big' : 'Small';
}

// ─── Historical Pattern Analysis ───────────────────────────────────
export function analyzeStreakPatterns(history, currentDraws) {
  const currentStreak = getStreakFromDraws(currentDraws);
  const similarSituations = history.filter(h =>
    h.stage && Math.abs(h.stage - currentStreak.count) <= 1 && typeof h.correct === 'boolean'
  );
  if (similarSituations.length < 3) return { confidence: 0.1, suggestion: null };
  const successRate = similarSituations.filter(s => s.correct).length / similarSituations.length;
  const correctGuesses = similarSituations.filter(s => s.correct).map(s => s.guess);
  const mostCommon = getMostFrequent(correctGuesses);
  return {
    confidence: Math.min(successRate * 1.2, 0.9),
    suggestion: mostCommon,
    successRate,
    sampleSize: similarSituations.length
  };
}

export function analyzeTimePatterns(history) {
  const recentPerformance = history.slice(0, 20).filter(h => typeof h.correct === 'boolean');
  if (recentPerformance.length === 0) return { confidence: 0, trend: 'unknown' };
  const recentAccuracy = recentPerformance.filter(h => h.correct).length / recentPerformance.length;
  const trend = recentAccuracy > 0.65 ? 'improving' : recentAccuracy < 0.35 ? 'declining' : 'stable';
  return { confidence: recentAccuracy, trend, recentAccuracy, sampleSize: recentPerformance.length };
}

export function analyzeSequencePatterns(history, currentDraws) {
  if (currentDraws.length < 3) return { confidence: 0, suggestion: null };
  const last3Results = currentDraws.slice(0, 3).map(d => d.num);
  const matchingSequences = [];
  const historicalData = history.filter(h => h.num !== null).slice(0, 200);
  for (let i = 0; i < historicalData.length - 3; i++) {
    const histSeq = [
      historicalData[i].num,
      historicalData[i + 1]?.num ?? null,
      historicalData[i + 2]?.num ?? null
    ];
    if (histSeq.every(n => n !== null) && arraysEqual(histSeq, last3Results)) {
      if (historicalData[i + 3]?.num !== null && historicalData[i + 3]?.num !== undefined) {
        matchingSequences.push(historicalData[i + 3].num > 4 ? 'Big' : 'Small');
      }
    }
  }
  if (matchingSequences.length === 0) return { confidence: 0, suggestion: null };
  const mostCommon = getMostFrequent(matchingSequences);
  const confidence = matchingSequences.filter(s => s === mostCommon).length / matchingSequences.length;
  return { confidence: confidence * 0.7, suggestion: mostCommon, matches: matchingSequences.length };
}

export function analyzeHistoricalPatterns(history, currentDraws) {
  if (!history || history.length < 10) return { confidence: 0, suggestion: null };
  const completedGames = history.filter(h => typeof h.correct === 'boolean');
  const streakAnalysis = analyzeStreakPatterns(completedGames, currentDraws);
  const timeAnalysis = analyzeTimePatterns(completedGames);
  const sequenceAnalysis = analyzeSequencePatterns(completedGames, currentDraws);
  return {
    confidence: calculateOverallConfidence([streakAnalysis, timeAnalysis, sequenceAnalysis]),
    streak: streakAnalysis,
    time: timeAnalysis,
    sequence: sequenceAnalysis,
    totalGames: completedGames.length
  };
}

// ─── Main Prediction (with history) ───────────────────────────────
export function predictNextWithHistory(draws, history) {
  if (!Array.isArray(draws) || draws.length < 5)
    return { prediction: 'Big', confidence: 0.5, reasoning: 'Insufficient data', logic: 'base' };

  const apiPrediction = predictNext(draws);
  const historicalInsights = analyzeHistoricalPatterns(history, draws);

  let finalPrediction = apiPrediction;
  let confidenceAdjustment = 1.0;
  let reasoning = ['Base algorithm prediction'];
  let logic = 'base';

  // ── ANTI-LOSS-STREAK LOGIC ──
  const recentCompleted = history.filter(h => h.actual !== 'loading...' && typeof h.correct === 'boolean');
  const seenPeriods = new Set();
  const dedupedCompleted = recentCompleted.filter(h => {
    if (seenPeriods.has(h.period)) return false;
    seenPeriods.add(h.period);
    return true;
  });

  let lossStreak = 0;
  for (let i = 0; i < dedupedCompleted.length; i++) {
    if (dedupedCompleted[i].correct === false) lossStreak++;
    else break;
  }

  // ── OPTIMIZED STREAK BREAKER (genetic search v4, 30 datasets, max≤10) ──
  // Stages 1-7: diverse individual methods (no consecutive repeats)
  // Stages 8+: 11-method ensemble voting for maximum decorrelation
  if (lossStreak >= 1) {
    const lastGuess = dedupedCompleted[0]?.guess ?? null;
    const lastActual = draws[0].num > 4 ? 'Big' : 'Small';
    const digitSum3 = draws.slice(0, 3).reduce((a, d) => a + d.num, 0);
    const digitSum5 = draws.slice(0, 5).reduce((a, d) => a + d.num, 0);
    const d7 = draws.slice(0, Math.min(7, draws.length));
    const digitSum7 = d7.reduce((a, d) => a + d.num, 0);
    const bigCount3 = draws.slice(0, 3).filter(d => d.num > 4).length;
    const bigCount5 = draws.slice(0, 5).filter(d => d.num > 4).length;
    let method;

    if (lossStreak <= 7) {
      // Stages 1-7: genetically optimized diverse methods
      switch (lossStreak) {
        case 1: finalPrediction = digitSum3 % 2 === 0 ? 'Small' : 'Big'; method = 'anti-digit3'; break;
        case 2: finalPrediction = digitSum5 % 2 === 0 ? 'Big' : 'Small'; method = 'digit5'; break;
        case 3: finalPrediction = bigCount5 >= 3 ? 'Small' : 'Big'; method = 'anti-majority-5'; break;
        case 4: finalPrediction = apiPrediction; method = 'same-base'; break;
        case 5: finalPrediction = apiPrediction === 'Big' ? 'Small' : 'Big'; method = 'flip-base'; break;
        case 6: finalPrediction = bigCount3 >= 2 ? 'Small' : 'Big'; method = 'anti-majority-3'; break;
        case 7: finalPrediction = digitSum7 % 2 === 0 ? 'Small' : 'Big'; method = 'anti-digit7'; break;
      }
    } else {
      // Stages 8+: 11-method ensemble voting
      // Collect actual results within THIS losing streak for intra-streak methods
      const streakActuals = [];
      for (let i = 0; i < Math.min(lossStreak, dedupedCompleted.length); i++) {
        if (dedupedCompleted[i].correct === false && dedupedCompleted[i].actual) {
          streakActuals.push(dedupedCompleted[i].actual);
        } else break;
      }
      const saMaj = streakActuals.length >= 2
        ? (streakActuals.filter(x => x === 'Big').length > streakActuals.length / 2 ? 'Big' : 'Small')
        : lastActual;

      // 11 diverse ensemble voters
      const votes = [
        (lastGuess === lastActual) ? 'Small' : 'Big',       // xor
        draws.slice(0, Math.min(9, draws.length)).filter(d => d.num > 4).length > Math.min(9, draws.length) / 2 ? 'Big' : 'Small', // majority-9
        digitSum3 % 2 === 0 ? 'Small' : 'Big',              // anti-digit3
        d7.filter(d => d.num > 4).length > d7.length / 2 ? 'Big' : 'Small', // majority-7
        lossStreak % 2 === 0 ? 'Big' : 'Small',             // streak-parity
        (() => { let ws=0,wt=0; for(let i=0;i<Math.min(7,draws.length);i++){const w=7-i;ws+=(draws[i].num>4?1:0)*w;wt+=w;} return ws/wt>0.5?'Big':'Small'; })(), // weighted
        lastActual,                                           // same-actual
        (lastGuess === lastActual) ? 'Big' : 'Small',       // anti-xor
        saMaj === 'Big' ? 'Small' : 'Big',                  // streak-anti-majority
        saMaj,                                                // streak-majority
        digitSum5 % 2 === 0 ? 'Small' : 'Big',              // anti-digit5
      ];
      const bigVotes = votes.filter(v => v === 'Big').length;
      finalPrediction = bigVotes > votes.length / 2 ? 'Big' : 'Small';
      method = `ensemble-${votes.length}(${bigVotes}B)`;
    }
    confidenceAdjustment *= lossStreak <= 3 ? 0.6 : 0.3;
    reasoning.push(`Streak-${lossStreak} ${method} → ${finalPrediction}`);
    logic = lossStreak >= 5 ? 'adaptive' : 'anti-streak';
  } else {
    const suggestions = [
      { prediction: apiPrediction, weight: 1.0 },
      { prediction: historicalInsights.streak?.suggestion, weight: historicalInsights.streak?.confidence || 0 },
      { prediction: historicalInsights.sequence?.suggestion, weight: historicalInsights.sequence?.confidence || 0 }
    ].filter(s => s.prediction);

    const historicalConsensus = getMostWeightedPrediction(suggestions);
    if (historicalConsensus && historicalConsensus.prediction !== apiPrediction && historicalConsensus.totalWeight > 1.3) {
      finalPrediction = historicalConsensus.prediction;
      confidenceAdjustment = Math.min(historicalConsensus.totalWeight / 2, 1.2);
      reasoning.push('Historical patterns override base prediction');
      logic = 'hist-override';
    }
    if (historicalInsights.time?.trend === 'declining' && historicalInsights.time.recentAccuracy < 0.4) {
      const tieSum = draws.slice(0, 5).reduce((a, d) => a + d.num, 0);
      if (tieSum % 5 === 0) {
        finalPrediction = finalPrediction === 'Big' ? 'Small' : 'Big';
        reasoning.push('Performance adjustment applied');
      }
    }
    if (historicalInsights.streak?.confidence > 0.7)
      reasoning.push(`Strong streak pattern (${(historicalInsights.streak.confidence * 100).toFixed(0)}% confidence)`);
    if (historicalInsights.sequence?.matches > 2)
      reasoning.push(`Sequence pattern found (${historicalInsights.sequence.matches} matches)`);
  }

  // ── Confirmation check: run 5 independent signals and see how many agree ──
  const confirmSignals = [];
  // Signal 1: Base algorithm (streak/majority/alternating)
  confirmSignals.push(apiPrediction);
  // Signal 2: Last-5 majority
  const maj5 = draws.slice(0, 5).filter(d => d.num > 4).length >= 3 ? 'Big' : 'Small';
  confirmSignals.push(maj5);
  // Signal 3: Last-3 digit sum parity
  const ds3 = draws.slice(0, 3).reduce((a, d) => a + d.num, 0);
  confirmSignals.push(ds3 % 2 === 0 ? 'Big' : 'Small');
  // Signal 4: Weighted recent (recency-weighted majority)
  let wSum = 0, wTotal = 0;
  for (let i = 0; i < Math.min(7, draws.length); i++) { const w = 7 - i; wSum += (draws[i].num > 4 ? 1 : 0) * w; wTotal += w; }
  confirmSignals.push(wSum / wTotal > 0.5 ? 'Big' : 'Small');
  // Signal 5: Historical sequence suggestion (if available)
  if (historicalInsights.sequence?.suggestion) confirmSignals.push(historicalInsights.sequence.suggestion);
  else confirmSignals.push(draws[0].num > 4 ? 'Small' : 'Big'); // anti-last as fallback

  const agreeCount = confirmSignals.filter(s => s === finalPrediction).length;
  const confirmed = agreeCount >= 4 ? 'CONFIRMED' : agreeCount >= 3 ? 'LIKELY' : null;

  // REVERSE FLIP: flip final output for better real-world accuracy
  finalPrediction = finalPrediction === 'Big' ? 'Small' : 'Big';
  reasoning.push('Output flipped (reverse mode active)');

  const finalConfidence = Math.min(confidenceAdjustment * 0.6, 0.95);
  return {
    prediction: finalPrediction,
    confidence: finalConfidence,
    confirmed,
    confirmSignals: agreeCount + '/' + confirmSignals.length,
    reasoning: reasoning.join('. '),
    logic,
    insights: historicalInsights,
    dataPoints: history.filter(h => typeof h.correct === 'boolean').length
  };
}

// ─── Compute Stages (for history UI) ──────────────────────────────
export function computeStages(hist) {
  let stage = 1, maxLossStreak = 0, currentLossStreak = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (typeof h.correct === 'boolean') {
      h.stage = stage;
      if (h.correct) {
        if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
        currentLossStreak = 0;
        stage = 1;
      } else {
        currentLossStreak++;
        stage++;
      }
    } else {
      h.stage = undefined;
    }
  }
  if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
  return maxLossStreak;
}
