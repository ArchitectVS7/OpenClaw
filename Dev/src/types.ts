/**
 * Test prompt structure
 */
export interface TestTurn {
  number: number;
  prompt: string;
  expectedBehavior: string;
}

export interface SuccessCriterion {
  description: string;
  validation: string;
}

export interface TestPrompt {
  id: string;
  name: string;
  category: string;
  description: string;
  turns: TestTurn[];
  successCriteria: {
    taskCompleted: SuccessCriterion;
    contextRetained: SuccessCriterion;
    codeWorks: SuccessCriterion;
  };
  estimatedDuration: string;
}

/**
 * Test result structure
 */
export interface TurnMetrics {
  turnNumber: number;
  userPrompt: string;
  agentResponse: string;
  tokensUsed: {
    total: number;
    bootstrap?: number;
    history?: number;
    system?: number;
  };
  responseTimeMs: number;
  timestamp: string;
}

export interface QualityEvaluation {
  taskCompleted: boolean;
  contextRetained: boolean;
  codeWorks: boolean;
  notes: string;
}

export interface TestResult {
  instanceName: string;
  testId: string;
  testName: string;
  category: string;
  timestamp: string;
  turns: TurnMetrics[];
  qualityEvaluation: QualityEvaluation;
  totalTokens: number;
  totalTimeMs: number;
  model?: string;
}

/**
 * Comparison result structure
 */
export interface ComparisonMetrics {
  testId: string;
  testName: string;
  category: string;
  
  main: {
    totalTokens: number;
    totalTimeMs: number;
    taskCompleted: boolean;
    contextRetained: boolean;
    codeWorks: boolean;
  };
  
  vs7: {
    totalTokens: number;
    totalTimeMs: number;
    taskCompleted: boolean;
    contextRetained: boolean;
    codeWorks: boolean;
  };
  
  tokenReduction: number; // percentage
  timeChange: number; // percentage
  qualityChange: number; // -1, 0, or 1
}

export interface ComparisonReport {
  timestamp: string;
  testsCompared: number;
  
  summary: {
    avgTokenReduction: number;
    avgTimeChange: number;
    mainTaskCompletionRate: number;
    vs7TaskCompletionRate: number;
    mainContextRetentionRate: number;
    vs7ContextRetentionRate: number;
    mainCodeWorksRate: number;
    vs7CodeWorksRate: number;
  };
  
  byCategory: {
    [category: string]: {
      avgTokenReduction: number;
      tests: ComparisonMetrics[];
    };
  };
  
  verdict: {
    tokenGoalMet: boolean; // >= 20% reduction
    contextGoalMet: boolean; // >= 95% retention
    codeQualityGoalMet: boolean; // equal or better
    taskCompletionGoalMet: boolean; // >= 95%
    overallPass: boolean;
  };
}

/**
 * Test configuration
 */
export interface TestConfig {
  instanceName: string;
  openclawBinary: string;
  sessionKey: string;
  outputDir: string;
  defaultModel?: string;
}

/**
 * Dual-instance test session
 */
export interface DualTestSession {
  sessionId: string;
  startTime: string;
  testsPlanned: string[];
  testsCompleted: string[];
  mainResults: TestResult[];
  vs7Results: TestResult[];
  status: 'in_progress' | 'paused' | 'completed';
  notes: string[];
}
