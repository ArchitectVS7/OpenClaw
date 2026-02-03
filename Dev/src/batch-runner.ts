#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { TestPrompt, TestResult, TurnMetrics, QualityEvaluation, TestConfig } from './types.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

interface BatchConfig {
  category?: string;
  testIds?: string[];
  model?: string;
}

async function loadAllTests(): Promise<TestPrompt[]> {
  const testPromptsDir = path.join(process.cwd(), 'test-prompts');
  const tests: TestPrompt[] = [];

  const categories = await fs.readdir(testPromptsDir);

  for (const category of categories) {
    const categoryPath = path.join(testPromptsDir, category);
    const stat = await fs.stat(categoryPath);
    if (!stat.isDirectory()) continue;

    const files = await fs.readdir(categoryPath);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const testPath = path.join(categoryPath, file);
        const content = await fs.readFile(testPath, 'utf-8');
        tests.push(JSON.parse(content) as TestPrompt);
      }
    }
  }

  return tests.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

async function loadConfig(): Promise<TestConfig> {
  const configPath = path.join(process.cwd(), 'test-config.json');
  const content = await fs.readFile(configPath, 'utf-8');
  return JSON.parse(content) as TestConfig;
}

async function saveResult(config: TestConfig, result: TestResult, model?: string): Promise<void> {
  const instanceDir = model
    ? `${config.instanceName}-${model}`
    : config.instanceName;
  const outputDir = path.join(process.cwd(), config.outputDir, instanceDir);
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${result.testId}.json`);
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2));

  console.log(`   Saved: ${outputPath}`);
}

async function runSingleTest(test: TestPrompt, config: TestConfig, model?: string): Promise<TestResult> {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  TEST ${test.id}: ${test.name}`);
  console.log(`${'═'.repeat(65)}\n`);

  console.log(`Category: ${test.category}`);
  console.log(`Description: ${test.description}`);
  console.log(`Estimated Duration: ${test.estimatedDuration}`);
  console.log(`Instance: ${config.instanceName}${model ? ` (${model})` : ''}\n`);

  const turns: TurnMetrics[] = [];

  for (const turn of test.turns) {
    console.log(`\n${'─'.repeat(65)}`);
    console.log(`TURN ${turn.number}/${test.turns.length}`);
    console.log(`${'─'.repeat(65)}\n`);

    console.log('PROMPT:');
    console.log(`  ${turn.prompt.split('\n').join('\n  ')}\n`);
    console.log(`Expected: ${turn.expectedBehavior}\n`);

    await question('Press Enter after sending prompt...');

    const startTime = Date.now();
    await question('Press Enter after receiving response...');
    const endTime = Date.now();

    const totalTokens = parseInt(await question('Total tokens: '), 10);
    const bootstrapTokens = await question('Bootstrap tokens (optional): ');
    const historyTokens = await question('History tokens (optional): ');
    const responseNote = await question('Response summary: ');

    turns.push({
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
    });
  }

  console.log(`\n${'─'.repeat(65)}`);
  console.log('QUALITY EVALUATION');
  console.log(`${'─'.repeat(65)}\n`);

  console.log('Success Criteria:');
  console.log(`  Task: ${test.successCriteria.taskCompleted.description}`);
  console.log(`  Context: ${test.successCriteria.contextRetained.description}`);
  console.log(`  Code: ${test.successCriteria.codeWorks.description}\n`);

  const taskCompleted = (await question('Task completed? (y/n): ')).toLowerCase() === 'y';
  const contextRetained = (await question('Context retained? (y/n): ')).toLowerCase() === 'y';
  const codeWorks = (await question('Code works? (y/n/na): ')).toLowerCase();
  const notes = await question('Notes (optional): ');

  const qualityEvaluation: QualityEvaluation = {
    taskCompleted,
    contextRetained,
    codeWorks: codeWorks === 'y' || codeWorks === 'na',
    notes,
  };

  const result: TestResult = {
    instanceName: config.instanceName,
    testId: test.id,
    testName: test.name,
    category: test.category,
    timestamp: new Date().toISOString(),
    turns,
    qualityEvaluation,
    totalTokens: turns.reduce((sum, t) => sum + t.tokensUsed.total, 0),
    totalTimeMs: turns.reduce((sum, t) => sum + t.responseTimeMs, 0),
    model,
  };

  return result;
}

function printBatchSummary(results: TestResult[]): void {
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  BATCH SUMMARY');
  console.log(`${'═'.repeat(65)}\n`);

  console.log('| Test | Tokens | Time | Task | Context | Code |');
  console.log('|------|--------|------|------|---------|------|');

  for (const result of results) {
    const task = result.qualityEvaluation.taskCompleted ? 'Y' : 'N';
    const context = result.qualityEvaluation.contextRetained ? 'Y' : 'N';
    const code = result.qualityEvaluation.codeWorks ? 'Y' : 'N';
    console.log(`| ${result.testId} | ${result.totalTokens.toLocaleString()} | ${(result.totalTimeMs / 1000).toFixed(0)}s | ${task} | ${context} | ${code} |`);
  }

  const totalTokens = results.reduce((sum, r) => sum + r.totalTokens, 0);
  const avgTokens = totalTokens / results.length;
  const passRate = results.filter(r =>
    r.qualityEvaluation.taskCompleted &&
    r.qualityEvaluation.contextRetained &&
    r.qualityEvaluation.codeWorks
  ).length / results.length * 100;

  console.log(`\nTotal Tokens: ${totalTokens.toLocaleString()}`);
  console.log(`Average Tokens/Test: ${avgTokens.toLocaleString()}`);
  console.log(`Pass Rate: ${passRate.toFixed(0)}%`);
}

async function main(): Promise<void> {
  console.clear();
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         OpenClaw UAT Batch Test Runner                        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  const args = process.argv.slice(2);
  const batchConfig: BatchConfig = {};

  for (const arg of args) {
    if (arg.startsWith('--category=')) {
      batchConfig.category = arg.split('=')[1];
    } else if (arg.startsWith('--test-ids=')) {
      batchConfig.testIds = arg.split('=')[1].split(',');
    } else if (arg.startsWith('--model=')) {
      batchConfig.model = arg.split('=')[1];
    }
  }

  const config = await loadConfig();
  const allTests = await loadAllTests();

  let testsToRun: TestPrompt[];

  if (batchConfig.testIds && batchConfig.testIds.length > 0) {
    testsToRun = allTests.filter(t => batchConfig.testIds!.includes(t.id));
    console.log(`Running specific tests: ${batchConfig.testIds.join(', ')}`);
  } else if (batchConfig.category) {
    testsToRun = allTests.filter(t => t.category === batchConfig.category);
    console.log(`Running category: ${batchConfig.category}`);
  } else {
    testsToRun = allTests;
    console.log('Running all tests');
  }

  console.log(`Instance: ${config.instanceName}`);
  if (batchConfig.model) {
    console.log(`Model: ${batchConfig.model}`);
  }
  console.log(`Tests to run: ${testsToRun.length}\n`);

  console.log('Tests in queue:');
  for (const test of testsToRun) {
    console.log(`  ${test.id} - ${test.name} (${test.estimatedDuration})`);
  }

  const totalEstimate = testsToRun.reduce((sum, t) => {
    const match = t.estimatedDuration.match(/(\d+)/);
    return sum + (match ? parseInt(match[1], 10) : 5);
  }, 0);

  console.log(`\nEstimated total time: ${totalEstimate}-${totalEstimate * 1.5} minutes\n`);

  const proceed = await question('Proceed? (y/n): ');
  if (proceed.toLowerCase() !== 'y') {
    console.log('Batch cancelled.');
    rl.close();
    return;
  }

  const results: TestResult[] = [];

  for (let i = 0; i < testsToRun.length; i++) {
    const test = testsToRun[i];
    console.log(`\n[${ i + 1}/${testsToRun.length}] Starting test ${test.id}...`);

    try {
      const result = await runSingleTest(test, config, batchConfig.model);
      results.push(result);
      await saveResult(config, result, batchConfig.model);

      if (i < testsToRun.length - 1) {
        console.log(`\nTest ${test.id} complete.`);
        const continueNext = await question('Continue to next test? (y/n/pause): ');

        if (continueNext.toLowerCase() === 'n') {
          console.log('Batch stopped by user.');
          break;
        } else if (continueNext.toLowerCase() === 'pause') {
          console.log('\nBatch paused. Results so far have been saved.');
          await question('Press Enter when ready to continue...');
        }
      }
    } catch (error) {
      console.error(`Error in test ${test.id}:`, error);
      const skip = await question('Skip this test and continue? (y/n): ');
      if (skip.toLowerCase() !== 'y') {
        break;
      }
    }
  }

  printBatchSummary(results);

  console.log('\nBatch complete!');
  rl.close();
}

main();
