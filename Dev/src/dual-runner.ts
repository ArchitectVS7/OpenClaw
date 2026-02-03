#!/usr/bin/env node

/**
 * Dual-Instance Test Orchestrator
 *
 * Guides side-by-side testing of VS7 and Main branches.
 * Displays prompts for both instances simultaneously and collects
 * metrics from each, enabling direct comparison.
 *
 * Usage:
 *   npm run dual -- --test-id=1.1
 *   npm run dual -- --category=context-retention
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { TestPrompt, TestResult, TurnMetrics, QualityEvaluation, DualTestSession } from './types.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function loadTestPrompt(testId: string): Promise<TestPrompt> {
  const testPromptsDir = path.join(process.cwd(), 'test-prompts');
  const categories = await fs.readdir(testPromptsDir);

  for (const category of categories) {
    const categoryPath = path.join(testPromptsDir, category);
    const stat = await fs.stat(categoryPath);
    if (!stat.isDirectory()) continue;

    const files = await fs.readdir(categoryPath);
    const testFile = files.find((f) => f.startsWith(testId));

    if (testFile) {
      const testPath = path.join(categoryPath, testFile);
      const content = await fs.readFile(testPath, 'utf-8');
      return JSON.parse(content) as TestPrompt;
    }
  }

  throw new Error(`Test ${testId} not found`);
}

async function loadAllTestIds(): Promise<string[]> {
  const testPromptsDir = path.join(process.cwd(), 'test-prompts');
  const testIds: string[] = [];
  const categories = await fs.readdir(testPromptsDir);

  for (const category of categories) {
    const categoryPath = path.join(testPromptsDir, category);
    const stat = await fs.stat(categoryPath);
    if (!stat.isDirectory()) continue;

    const files = await fs.readdir(categoryPath);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const match = file.match(/^(\d+\.\d+)/);
        if (match) testIds.push(match[1]);
      }
    }
  }

  return testIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function saveResult(instanceName: string, result: TestResult): Promise<void> {
  const outputDir = path.join(process.cwd(), 'results', instanceName);
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${result.testId}.json`);
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
}

async function saveSession(session: DualTestSession): Promise<void> {
  const sessionDir = path.join(process.cwd(), 'results', 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });

  const sessionPath = path.join(sessionDir, `${session.sessionId}.json`);
  await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));
}

function printHeader(text: string, width: number = 65): void {
  console.log(`\n${'═'.repeat(width)}`);
  console.log(`  ${text}`);
  console.log(`${'═'.repeat(width)}`);
}

function printSubHeader(text: string, width: number = 65): void {
  console.log(`\n${'─'.repeat(width)}`);
  console.log(`  ${text}`);
  console.log(`${'─'.repeat(width)}`);
}

async function collectTurnMetrics(
  instanceName: string,
  turn: { number: number; prompt: string; expectedBehavior: string },
  totalTurns: number
): Promise<TurnMetrics> {
  printSubHeader(`${instanceName.toUpperCase()} - Turn ${turn.number}/${totalTurns}`);

  await question(`  [${instanceName}] Press Enter after sending prompt...`);

  const startTime = Date.now();
  await question(`  [${instanceName}] Press Enter after receiving response...`);
  const endTime = Date.now();

  const totalTokens = parseInt(await question(`  [${instanceName}] Total tokens: `), 10);
  const bootstrapTokens = await question(`  [${instanceName}] Bootstrap tokens (optional): `);
  const historyTokens = await question(`  [${instanceName}] History tokens (optional): `);
  const responseNote = await question(`  [${instanceName}] Response summary: `);

  return {
    turnNumber: turn.number,
    userPrompt: turn.prompt,
    agentResponse: responseNote,
    tokensUsed: {
      total: totalTokens || 0,
      bootstrap: bootstrapTokens ? parseInt(bootstrapTokens, 10) : undefined,
      history: historyTokens ? parseInt(historyTokens, 10) : undefined,
    },
    responseTimeMs: endTime - startTime,
    timestamp: new Date().toISOString(),
  };
}

async function collectQualityEvaluation(instanceName: string, test: TestPrompt): Promise<QualityEvaluation> {
  console.log(`\n  [${instanceName.toUpperCase()}] Quality Evaluation:`);
  console.log(`    Task: ${test.successCriteria.taskCompleted.description}`);
  console.log(`    Context: ${test.successCriteria.contextRetained.description}`);
  console.log(`    Code: ${test.successCriteria.codeWorks.description}\n`);

  const taskCompleted = (await question(`  [${instanceName}] Task completed? (y/n): `)).toLowerCase() === 'y';
  const contextRetained = (await question(`  [${instanceName}] Context retained? (y/n): `)).toLowerCase() === 'y';
  const codeWorks = (await question(`  [${instanceName}] Code works? (y/n/na): `)).toLowerCase();
  const notes = await question(`  [${instanceName}] Notes: `);

  return {
    taskCompleted,
    contextRetained,
    codeWorks: codeWorks === 'y' || codeWorks === 'na',
    notes,
  };
}

async function runDualTest(testId: string): Promise<{ main: TestResult; vs7: TestResult }> {
  const test = await loadTestPrompt(testId);

  console.clear();
  printHeader(`DUAL TEST: ${test.id} - ${test.name}`);

  console.log(`\nCategory: ${test.category}`);
  console.log(`Description: ${test.description}`);
  console.log(`Turns: ${test.turns.length}`);
  console.log(`Estimated Duration: ${test.estimatedDuration}`);

  console.log('\n  Instructions:');
  console.log('  1. Open TWO terminal windows side-by-side');
  console.log('  2. Left window: Main branch OpenClaw');
  console.log('  3. Right window: VS7 branch OpenClaw');
  console.log('  4. Send the SAME prompt to BOTH instances');
  console.log('  5. Record metrics for each instance');

  await question('\nPress Enter when both instances are ready...');

  const mainTurns: TurnMetrics[] = [];
  const vs7Turns: TurnMetrics[] = [];

  for (const turn of test.turns) {
    printHeader(`TURN ${turn.number}/${test.turns.length}`);

    console.log('\n  PROMPT TO SEND (to BOTH instances):\n');
    console.log('  ' + '─'.repeat(60));
    console.log('  ' + turn.prompt.split('\n').join('\n  '));
    console.log('  ' + '─'.repeat(60));
    console.log(`\n  Expected: ${turn.expectedBehavior}\n`);

    // Collect metrics for both instances
    console.log('\n  === MAIN BRANCH ===');
    const mainMetrics = await collectTurnMetrics('main', turn, test.turns.length);
    mainTurns.push(mainMetrics);

    console.log('\n  === VS7 BRANCH ===');
    const vs7Metrics = await collectTurnMetrics('vs7', turn, test.turns.length);
    vs7Turns.push(vs7Metrics);

    // Quick comparison
    const tokenDiff = mainMetrics.tokensUsed.total - vs7Metrics.tokensUsed.total;
    const tokenPct = (tokenDiff / mainMetrics.tokensUsed.total * 100).toFixed(1);
    console.log(`\n  Turn ${turn.number} Token Comparison:`);
    console.log(`    Main: ${mainMetrics.tokensUsed.total.toLocaleString()}`);
    console.log(`    VS7:  ${vs7Metrics.tokensUsed.total.toLocaleString()}`);
    console.log(`    Diff: ${tokenDiff > 0 ? '-' : '+'}${Math.abs(tokenDiff).toLocaleString()} (${tokenDiff > 0 ? '-' : '+'}${Math.abs(parseFloat(tokenPct))}%)`);

    if (turn.number < test.turns.length) {
      await question('\nPress Enter to continue to next turn...');
    }
  }

  // Quality evaluation for both
  printHeader('QUALITY EVALUATION');

  console.log('\n  === MAIN BRANCH ===');
  const mainQuality = await collectQualityEvaluation('main', test);

  console.log('\n  === VS7 BRANCH ===');
  const vs7Quality = await collectQualityEvaluation('vs7', test);

  // Build results
  const mainResult: TestResult = {
    instanceName: 'main',
    testId: test.id,
    testName: test.name,
    category: test.category,
    timestamp: new Date().toISOString(),
    turns: mainTurns,
    qualityEvaluation: mainQuality,
    totalTokens: mainTurns.reduce((sum, t) => sum + t.tokensUsed.total, 0),
    totalTimeMs: mainTurns.reduce((sum, t) => sum + t.responseTimeMs, 0),
  };

  const vs7Result: TestResult = {
    instanceName: 'vs7',
    testId: test.id,
    testName: test.name,
    category: test.category,
    timestamp: new Date().toISOString(),
    turns: vs7Turns,
    qualityEvaluation: vs7Quality,
    totalTokens: vs7Turns.reduce((sum, t) => sum + t.tokensUsed.total, 0),
    totalTimeMs: vs7Turns.reduce((sum, t) => sum + t.responseTimeMs, 0),
  };

  return { main: mainResult, vs7: vs7Result };
}

function printComparisonSummary(main: TestResult, vs7: TestResult): void {
  printHeader('TEST COMPARISON SUMMARY');

  const tokenDiff = main.totalTokens - vs7.totalTokens;
  const tokenPct = (tokenDiff / main.totalTokens * 100);

  console.log('\n  | Metric | Main | VS7 | Diff |');
  console.log('  |--------|------|-----|------|');
  console.log(`  | Tokens | ${main.totalTokens.toLocaleString()} | ${vs7.totalTokens.toLocaleString()} | ${tokenDiff > 0 ? '-' : '+'}${Math.abs(tokenPct).toFixed(1)}% |`);
  console.log(`  | Time | ${(main.totalTimeMs / 1000).toFixed(1)}s | ${(vs7.totalTimeMs / 1000).toFixed(1)}s | ${main.totalTimeMs > vs7.totalTimeMs ? 'VS7 faster' : 'Main faster'} |`);
  console.log(`  | Task | ${main.qualityEvaluation.taskCompleted ? 'Y' : 'N'} | ${vs7.qualityEvaluation.taskCompleted ? 'Y' : 'N'} | ${main.qualityEvaluation.taskCompleted === vs7.qualityEvaluation.taskCompleted ? '=' : 'differs'} |`);
  console.log(`  | Context | ${main.qualityEvaluation.contextRetained ? 'Y' : 'N'} | ${vs7.qualityEvaluation.contextRetained ? 'Y' : 'N'} | ${main.qualityEvaluation.contextRetained === vs7.qualityEvaluation.contextRetained ? '=' : 'differs'} |`);
  console.log(`  | Code | ${main.qualityEvaluation.codeWorks ? 'Y' : 'N'} | ${vs7.qualityEvaluation.codeWorks ? 'Y' : 'N'} | ${main.qualityEvaluation.codeWorks === vs7.qualityEvaluation.codeWorks ? '=' : 'differs'} |`);

  // Verdict
  console.log('\n  Quick Verdict:');
  if (tokenPct >= 20 && vs7.qualityEvaluation.taskCompleted && vs7.qualityEvaluation.contextRetained) {
    console.log('  ✅ VS7 shows significant token reduction with quality parity');
  } else if (tokenPct >= 10 && vs7.qualityEvaluation.taskCompleted) {
    console.log('  ⚠️  VS7 shows moderate token reduction');
  } else if (tokenPct < 0) {
    console.log('  ❌ VS7 used MORE tokens than Main (investigate)');
  } else {
    console.log('  ℹ️  Results inconclusive - run more tests');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let testIds: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('--test-id=')) {
      testIds = [arg.split('=')[1]];
    } else if (arg.startsWith('--category=')) {
      const category = arg.split('=')[1];
      const allIds = await loadAllTestIds();
      // Filter by category by loading each test
      for (const id of allIds) {
        try {
          const test = await loadTestPrompt(id);
          if (test.category === category) {
            testIds.push(id);
          }
        } catch {
          // Skip tests that can't be loaded
        }
      }
    }
  }

  if (testIds.length === 0) {
    console.error('Usage:');
    console.error('  npm run dual -- --test-id=1.1');
    console.error('  npm run dual -- --category=context-retention');
    process.exit(1);
  }

  console.clear();
  printHeader('DUAL-INSTANCE TEST ORCHESTRATOR');

  console.log(`\nTests to run: ${testIds.join(', ')}`);
  console.log('\nThis tool guides side-by-side testing of VS7 vs Main branches.');
  console.log('You will need TWO OpenClaw instances running simultaneously.\n');

  const proceed = await question('Ready to begin? (y/n): ');
  if (proceed.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    rl.close();
    return;
  }

  // Create session
  const session: DualTestSession = {
    sessionId: `dual-${Date.now()}`,
    startTime: new Date().toISOString(),
    testsPlanned: testIds,
    testsCompleted: [],
    mainResults: [],
    vs7Results: [],
    status: 'in_progress',
    notes: [],
  };

  for (let i = 0; i < testIds.length; i++) {
    const testId = testIds[i];
    console.log(`\n[${i + 1}/${testIds.length}] Running test ${testId}...`);

    try {
      const { main, vs7 } = await runDualTest(testId);

      // Save individual results
      await saveResult('main', main);
      await saveResult('vs7', vs7);

      session.mainResults.push(main);
      session.vs7Results.push(vs7);
      session.testsCompleted.push(testId);

      // Print comparison
      printComparisonSummary(main, vs7);

      // Save session progress
      await saveSession(session);

      if (i < testIds.length - 1) {
        const note = await question('\nNotes for this test (optional): ');
        if (note) session.notes.push(`${testId}: ${note}`);

        const cont = await question('\nContinue to next test? (y/n/pause): ');
        if (cont.toLowerCase() === 'n') {
          session.status = 'paused';
          break;
        } else if (cont.toLowerCase() === 'pause') {
          session.status = 'paused';
          console.log('\nSession paused. Progress saved.');
          await question('Press Enter when ready to continue...');
          session.status = 'in_progress';
        }
      }
    } catch (error) {
      console.error(`\nError in test ${testId}:`, error);
      const skip = await question('Skip and continue? (y/n): ');
      if (skip.toLowerCase() !== 'y') {
        session.status = 'paused';
        break;
      }
    }
  }

  // Final summary
  if (session.testsCompleted.length > 0) {
    printHeader('SESSION SUMMARY');

    const totalMainTokens = session.mainResults.reduce((sum, r) => sum + r.totalTokens, 0);
    const totalVs7Tokens = session.vs7Results.reduce((sum, r) => sum + r.totalTokens, 0);
    const avgReduction = ((totalMainTokens - totalVs7Tokens) / totalMainTokens * 100);

    console.log(`\n  Tests Completed: ${session.testsCompleted.length}/${session.testsPlanned.length}`);
    console.log(`  Total Main Tokens: ${totalMainTokens.toLocaleString()}`);
    console.log(`  Total VS7 Tokens: ${totalVs7Tokens.toLocaleString()}`);
    console.log(`  Average Token Reduction: ${avgReduction.toFixed(1)}%`);

    const vs7TaskPass = session.vs7Results.filter(r => r.qualityEvaluation.taskCompleted).length;
    const vs7ContextPass = session.vs7Results.filter(r => r.qualityEvaluation.contextRetained).length;
    console.log(`  VS7 Task Completion: ${vs7TaskPass}/${session.vs7Results.length}`);
    console.log(`  VS7 Context Retention: ${vs7ContextPass}/${session.vs7Results.length}`);

    console.log(`\n  Session saved to: results/sessions/${session.sessionId}.json`);
    console.log('  Run `npm run compare -- results/main results/vs7` for detailed report.');
  }

  session.status = 'completed';
  await saveSession(session);

  rl.close();
}

main();
