# ASTRA Performance Optimization Plan

## Executive Summary
Current latency estimate: **3-5 minutes per complex task**
Target latency: **45-90 seconds per task** (3-5x speedup)

## Critical Bottlenecks Identified

### 🔴 P0: Sequential LLM Calls in Planning Loop
**Location:** `backend/src/routes/planActions.ts`
**Impact:** 5-15 seconds per round × 10 rounds = **50-150 seconds**

Every `/plan-actions` call makes these sequential operations:
1. `parseUserIntent()` - ~1-2s (cached on continuation, but still called)
2. `performWebResearch()` - ~4-8s (web search + page fetch + LLM synthesis)
3. `planPageActions()` - ~2-4s (includes vision analysis on first round/transitions)
4. `evaluateGoal()` - ~1-2s (when no actions returned)

**Fix:** Parallelize independent operations, cache aggressively

### 🔴 P0: Vision Analysis on Every Page Transition
**Location:** `backend/src/agents/pageIntelligence.ts:321-374`
**Impact:** 2-4 seconds per transition × 5 transitions = **10-20 seconds**

```typescript
// Lines 329-347: Vision calls are sequential
const visual = await analyzeScreen(screenshot, originalQuery);  // 2-3s
const visionMap = await identifyElements(screenshot, ...);       // 1-2s
```

**Fix:** Cache vision results per URL, skip on unchanged pages, or parallelize both calls

### 🟠 P1: Web Research Sequential Page Fetches
**Location:** `backend/src/agents/webResearch.ts:56-72`
**Impact:** 4-8 seconds per research operation

```typescript
// Sequential fetches
for (const res of results) {
    const text = await fetchPageContent(res.url, { timeout: 4000 });  // 4s each
}
```

**Fix:** Use `Promise.all()` for parallel fetching

### 🟠 P1: Manual Sleep Delays
**Location:** `extension/src/background/index.ts`
**Impact:** 5-15 seconds per task

```typescript
await sleep(2000);  // Line 336: After navigation
await sleep(2500);  // Line 352: After search
await sleep(3000);  // Line 388: On retry
```

**Fix:** Replace with event-based waits (MutationObserver, load events)

### 🟡 P2: Large Screenshot Payloads
**Location:** `extension/src/background/index.ts:475-480`
**Impact:** Network latency + potential 413 errors

200-500KB base64 screenshots transmitted on page changes.

**Fix:** Compress images, use WebP format, or only send diffs

---

## Hypotheses to Test

### Hypothesis A: Sequential LLM calls dominate latency
**Prediction:** 60%+ of total latency is in sequential LLM calls
**Instrumentation:** Add timing around each LLM call in planActions.ts
**Expected finding:** `performWebResearch` + `planPageActions` = 6-12s per round

### Hypothesis B: Vision analysis adds 2-4s per transition
**Prediction:** Vision calls appear as distinct 2-4s blocks in logs
**Instrumentation:** Add timing around `analyzeScreen` and `identifyElements`
**Expected finding:** Vision = 30% of planning latency

### Hypothesis C: Web research page fetches are sequential and slow
**Prediction:** Each `fetchPageContent` takes 2-4s, running sequentially
**Instrumentation:** Add timing around each fetch in webResearch.ts
**Expected finding:** 2 sequential fetches = 4-8s total

### Hypothesis D: Manual sleep delays add unnecessary wait time
**Prediction:** 30%+ of total task time is in `sleep()` calls
**Instrumentation:** Log sleep duration and actual page ready time
**Expected finding:** Pages load in 1s but code waits 3s

### Hypothesis E: Screenshot encoding/transfer is slow
**Prediction:** Screenshot capture + base64 encoding takes 500ms-1s
**Instrumentation:** Time `captureScreenshot()` and measure payload size
**Expected finding:** 200-500KB screenshots taking 500ms-1s to encode

---

## Optimization Strategy

### Phase 1: Quick Wins (Expected: 30% speedup)
1. **Parallelize web research page fetches**
   ```typescript
   // Before: Sequential
   for (const res of results) {
       const text = await fetchPageContent(res.url);
   }
   
   // After: Parallel
   const fetches = results.slice(0, 2).map(res => 
       fetchPageContent(res.url).catch(() => null)
   );
   const texts = await Promise.all(fetches);
   ```

2. **Parallelize vision analysis calls**
   ```typescript
   // Before: Sequential
   const visual = await analyzeScreen(screenshot, query);
   const visionMap = await identifyElements(screenshot, elements, query);
   
   // After: Parallel
   const [visual, visionMap] = await Promise.all([
       analyzeScreen(screenshot, query),
       identifyElements(screenshot, elements, query),
   ]);
   ```

3. **Reduce sleep delays with adaptive waits**
   ```typescript
   // Before: Fixed 3s wait
   await sleep(3000);
   
   // After: Poll for ready state
   await waitForPageReady(tabId, { maxWait: 3000, pollInterval: 100 });
   ```

### Phase 2: Structural Optimizations (Expected: 40% speedup)
1. **Cache vision results per URL hash**
   - Store vision analysis in Redis with URL + DOM hash as key
   - Skip re-analysis if page hasn't changed

2. **Parallel planning + research**
   - Start web research in background while planning first actions
   - Merge research results into subsequent planning rounds

3. **Stream LLM responses**
   - Use streaming for action planning to start execution earlier
   - Execute high-confidence actions before full response completes

### Phase 3: Advanced Optimizations (Expected: 20% speedup)
1. **Compress screenshots to WebP**
   - Reduce payload from 200-500KB to 50-100KB
   - Use canvas API for compression in extension

2. **Predictive action prefetching**
   - Predict likely next actions and pre-fetch research
   - Warm up LLM context for expected follow-ups

3. **Action batching**
   - Combine multiple independent actions into single LLM call
   - Execute batch in parallel in extension

---

## Instrumentation Plan

### Log Format (NDJSON)
```json
{"timestamp":"2026-03-18T16:51:00.000Z","location":"planActions.ts:94","event":"web_research_start","sessionId":"abc123"}
{"timestamp":"2026-03-18T16:51:04.500Z","location":"planActions.ts:94","event":"web_research_end","duration_ms":4500,"sources":2}
```

### Instrumentation Points
1. `backend/src/routes/planActions.ts` - Time each phase (intent, research, planning, critic)
2. `backend/src/agents/pageIntelligence.ts` - Time vision analysis
3. `backend/src/agents/webResearch.ts` - Time each page fetch
4. `extension/src/background/index.ts` - Time sleep delays, screenshot capture

---

## Expected Results

| Optimization | Before | After | Savings |
|-------------|--------|-------|---------|
| Parallel web fetches | 8s | 4s | 4s |
| Parallel vision calls | 4s | 2s | 2s |
| Adaptive waits | 10s | 3s | 7s |
| Cached vision | 12s | 4s | 8s |
| Screenshot compression | 2s | 0.5s | 1.5s |
| **Total per task** | **180s** | **60s** | **120s** |

**Speedup factor: 3x**
