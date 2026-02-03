# VS7 Context Management Testing Strategy

**Document Version:** 1.0
**Date:** 2026-02-03
**Purpose:** Evaluate testing approach and define execution plan for VS7 vs Main branch comparison

---

## 1. Evaluation of Current Test Harness

### Strengths

| Component | Assessment |
|-----------|------------|
| **TypeScript Foundation** | Well-typed interfaces in `types.ts` enable reliable data handling |
| **Test Structure** | JSON-based prompts are easy to create, modify, and version |
| **Comparison Tool** | `compare-results.ts` produces actionable markdown reports with clear pass/fail criteria |
| **Metrics Captured** | Token breakdown (total, bootstrap, history, system) addresses the core hypothesis |
| **Success Criteria** | Clear thresholds: ≥20% token reduction, ≥95% context retention, quality parity |

### Gaps Identified

| Gap | Impact | Resolution |
|-----|--------|------------|
| Only 5 of 15 tests defined | Insufficient data for statistical confidence | Create remaining 10 tests |
| No batch execution | Each test requires manual initiation | Add `batch-runner.ts` |
| Single-instance runner | Cannot run VS7 + Main simultaneously | Add `dual-runner.ts` |
| No model variance | Cannot test with different LLMs | Extend config schema |
| Manual metric entry | Error-prone, time-consuming | Future: API token extraction |

---

## 2. Your Testing Vision - Assessment

### Proposed Test Plan

| Batch | Mode | Instances | Purpose |
|-------|------|-----------|---------|
| **Batch 1-4** | Auto | VS7 + Main | Quantitative comparison (token usage, task completion) |
| **Batch 5** | Manual | VS7 + Main | Qualitative validation ("feel" of the system) |

### Analysis

**What's Good:**
- Running 4 batches provides statistical power (N=20 per test if using 5 tests per batch)
- Side-by-side comparison eliminates environmental variables
- Manual validation catches UX issues metrics miss
- Model variance testing addresses generalizability

**Refinements Suggested:**

1. **Batch Structure**: Rather than 4 arbitrary batches, align batches with test categories:
   - Batch 1: Context Retention (tests 1.1-1.5)
   - Batch 2: Code Quality (tests 2.1-2.5)
   - Batch 3: Mixed Workload (tests 3.1-3.5)
   - Batch 4: Repeat critical tests with different model

2. **Pause Points**: After each batch, validate:
   - Token metrics look reasonable (not anomalous)
   - Generated code compiles/runs
   - No obvious regressions in quality

3. **Model Variance**: Test at least 2 models:
   - Primary: Claude Sonnet (cost-effective, fast)
   - Validation: Claude Opus (highest quality baseline)

---

## 3. Test Execution Plan

### Phase 1: Preparation (Before Testing)

```
[ ] Install dependencies: cd Dev && npm install
[ ] Verify VS7 instance running on cloud server
[ ] Set up Main instance on local machine
[ ] Create all 15 test prompt files
[ ] Validate test-runner works with test 1.1
```

### Phase 2: Automated Batches (Quantitative)

**Batch 1: Context Retention**
```bash
# Terminal 1 (VS7 - cloud server)
npm run batch -- --category=context-retention --instance=vs7

# Terminal 2 (Main - local)
npm run batch -- --category=context-retention --instance=main
```

**Pause Point 1**: Compare token usage for tests 1.1-1.5
- Expected: VS7 shows 20-40% reduction
- Action if not met: Check VS7 config, verify summarization active

**Batch 2: Code Quality**
```bash
npm run batch -- --category=code-quality --instance=vs7
npm run batch -- --category=code-quality --instance=main
```

**Pause Point 2**: Validate generated code
- Run python -m py_compile on generated Python files
- Run tsc on TypeScript files
- Action if failures: Note in quality evaluation

**Batch 3: Mixed Workload**
```bash
npm run batch -- --category=mixed-workload --instance=vs7
npm run batch -- --category=mixed-workload --instance=main
```

**Pause Point 3**: Context drift check
- Review long conversation test (3.3)
- Check if VS7 maintains coherence vs Main
- This is the "stress test" for summarization

**Batch 4: Model Variance (Optional)**
```bash
# Repeat critical tests with Opus model
npm run batch -- --test-ids=1.1,2.1,3.3 --instance=vs7 --model=opus
npm run batch -- --test-ids=1.1,2.1,3.3 --instance=main --model=opus
```

### Phase 3: Manual Validation (Qualitative)

**Purpose**: Get the "feel" of conversational flow

**Process**:
1. Open two terminal windows side-by-side
2. Run `npm run test:manual -- --test-id=1.1` in both
3. Send identical prompts to VS7 and Main simultaneously
4. Observe:
   - Response latency difference
   - Quality of explanations
   - Context awareness in follow-up turns
   - Any "drift" or confusion

**Tests for Manual Validation**:
- Test 1.1 (Multi-Turn Memory) - baseline
- Test 3.3 (Long Conversation) - stress test

### Phase 4: Analysis

```bash
# Generate comparison report
npm run compare -- results/main results/vs7

# Review output
cat comparison-report.md
```

**Decision Criteria**:

| Outcome | Action |
|---------|--------|
| All 4 goals met | VS7 ready for production |
| Token goal missed | Investigate summarization config |
| Quality goal missed | Review context window parameters |
| Context goal missed | Check semantic history implementation |

---

## 4. Data Collection Strategy

### Metrics to Capture

| Metric | Source | Purpose |
|--------|--------|---------|
| Total Tokens | OpenClaw response footer | Primary comparison metric |
| Bootstrap Tokens | Telegram/CLI status | Measure static overhead |
| History Tokens | Telegram/CLI status | Measure conversation growth |
| Response Time | Test harness timer | Secondary efficiency metric |
| Task Completed | Human evaluation | Quality gate |
| Context Retained | Human evaluation | Core hypothesis test |
| Code Works | Automated validation | Quality gate |

### Statistical Considerations

- **Sample Size**: 15 tests × 2 instances = 30 data points minimum
- **Variance**: Repeat critical tests 3× to measure consistency
- **Outliers**: Flag any test with >50% token difference for investigation

---

## 5. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Network variance affects timing | Use token count as primary metric, timing as secondary |
| Model randomness affects output | Run tests 3× when in doubt |
| Tester bias in quality eval | Use objective criteria (code compiles, specific terms mentioned) |
| Configuration drift | Document exact config used for each batch |

---

## 6. Implementation Checklist

### Code to Create

- [x] `src/test-runner.ts` - Manual interactive runner
- [x] `src/compare-results.ts` - Results analysis
- [x] `src/types.ts` - TypeScript interfaces
- [ ] `src/batch-runner.ts` - Run multiple tests sequentially
- [ ] `src/dual-runner.ts` - Side-by-side comparison orchestrator

### Tests to Create

**Context Retention (3 more needed)**:
- [ ] 1.4 - Interrupted Task Resumption
- [ ] 1.5 - Workspace File Reference

**Code Quality (3 more needed)**:
- [ ] 2.3 - API Integration
- [ ] 2.4 - Code Review
- [ ] 2.5 - Codebase Analysis

**Mixed Workload (5 needed)**:
- [ ] 3.1 - Realistic Day Workflow
- [ ] 3.2 - Learning and Applying
- [ ] 3.3 - Long Conversation (10+ turns)
- [ ] 3.4 - Emergency Interrupt
- [ ] 3.5 - Knowledge Synthesis

---

## 7. Expected Outcomes

### Hypothesis

VS7's rolling summarization and semantic history will:
- Reduce token usage by 25-40% on multi-turn conversations
- Maintain ≥95% context retention accuracy
- Have no negative impact on code quality
- Show greater benefits on longer conversations (tests 3.x)

### If Hypothesis Fails

1. **Minor miss (15-19% reduction)**: Consider acceptable, document findings
2. **Major miss (<15% or quality degradation)**:
   - Review summarization aggressiveness
   - Check semantic history relevance scoring
   - Consider hybrid approach

---

## 8. Timeline

| Day | Activity |
|-----|----------|
| Day 1 | Create remaining tests, batch runner |
| Day 2 | Run Batches 1-2, validate results |
| Day 3 | Run Batch 3, manual validation |
| Day 4 | Analysis, model variance testing (optional) |
| Day 5 | Final report, decision |

---

**Next Step**: Create the missing test prompts and batch runner to enable automated testing.
