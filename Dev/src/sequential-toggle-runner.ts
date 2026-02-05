#!/usr/bin/env node

/**
 * Sequential Toggle Test Runner
 *
 * Runs tests sequentially on a SINGLE Docker instance, toggling VS7 on/off between runs.
 * Uses the OpenClaw WebSocket Gateway API with proper agent.wait synchronization.
 *
 * Key fixes implemented:
 * 1. Uses agent.wait API to properly wait for full agentic loop completion
 * 2. Queries session metadata for accurate token tracking
 * 3. Resets session before each test for clean comparisons
 * 4. Captures workspace only after agent fully completes
 *
 * Usage:
 *   npm run sequential -- --test-id=4.1
 *   npm run sequential -- --test-ids=4.1,4.2,4.3
 *   npm run sequential -- --category=homestead-farm-management
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import type {
  TestPrompt,
  TestResult,
  TurnMetrics,
  QualityEvaluation,
  ChatEvent,
  ResponseFrame,
  EventFrame,
  AgentLifecycleEvent,
  SessionMetadata,
  TokenUsage,
} from './types.js';

const execAsync = promisify(exec);

// Device identity helpers
interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  publicKeyBase64Url: string;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyRaw = derivePublicKeyRaw(publicKeyPem);
  const deviceId = crypto.createHash('sha256').update(publicKeyRaw).digest('hex');
  const publicKeyBase64Url = base64UrlEncode(publicKeyRaw);
  return { deviceId, publicKeyPem, privateKeyPem, publicKeyBase64Url };
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(sig);
}

interface RunnerConfig {
  gatewayUrl: string;
  sessionKey: string;
  workspaceDir: string;
  configPath: string;
  dockerContainer: string;
  agentWaitTimeoutMs: number;
  gatewayToken?: string;
  composeDir?: string; // Directory containing docker-compose.yml
}

interface TestRun {
  testId: string;
  mode: 'vs7' | 'baseline';
  results: TurnMetrics[];
  totalTokens: number;
  totalTimeMs: number;
  generatedFiles: string[];
}

interface PromptResult {
  response: string;
  tokens: TokenUsage;
  timeMs: number;
}

/**
 * OpenClaw WebSocket Client with agent.wait support
 */
class OpenClawClient {
  private ws: WebSocket | null = null;
  private config: RunnerConfig;
  private messageHandlers = new Map<string, (response: ResponseFrame) => void>();
  private eventHandlers = new Map<string, (event: EventFrame) => void>();
  private connected = false;
  private accumulatedResponse = '';
  private deviceIdentity: DeviceIdentity;

  constructor(config: RunnerConfig) {
    this.config = config;
    // Generate a unique device identity for this client instance
    this.deviceIdentity = generateDeviceIdentity();
    console.log(`  Generated device ID: ${this.deviceIdentity.deviceId.substring(0, 16)}...`);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.connected) {
          this.ws?.close();
          reject(new Error('Connection timeout after 15 seconds'));
        }
      }, 15000);

      this.ws = new WebSocket(this.config.gatewayUrl);
      const connectId = randomUUID();
      let handshakeComplete = false;
      let challengeReceived = false;

      const sendConnectRequest = (nonce?: string) => {
        // Send connect frame per gateway protocol v3
        const signedAt = Date.now();
        // Use Control UI client ID to take advantage of dangerouslyDisableDeviceAuth bypass
        const clientId = 'openclaw-control-ui';
        const clientMode = 'ui';
        const role = 'operator';
        const scopes = ['operator.read', 'operator.write', 'operator.admin'];
        const token = this.config.gatewayToken || '';

        // Build the signature payload per gateway device-auth format
        // v2 (with nonce): v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
        // v1 (without nonce): v1|deviceId|clientId|clientMode|role|scopes|signedAtMs|token
        const version = nonce ? 'v2' : 'v1';
        const scopesStr = scopes.join(',');
        const payloadParts = [
          version,
          this.deviceIdentity.deviceId,
          clientId,
          clientMode,
          role,
          scopesStr,
          String(signedAt),
          token,
        ];
        if (nonce) {
          payloadParts.push(nonce);
        }
        const signPayload = payloadParts.join('|');
        const signature = signDevicePayload(this.deviceIdentity.privateKeyPem, signPayload);

        const connectFrame = {
          type: 'req',
          id: connectId,
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: clientId,
              displayName: 'Sequential Toggle Runner',
              version: '1.0.0',
              platform: 'windows',
              mode: clientMode,
            },
            role,
            scopes,
            caps: [],
            commands: [],
            permissions: {},
            locale: 'en-US',
            userAgent: 'sequential-toggle-runner/1.0.0',
            auth: token ? { token } : undefined,
            device: {
              id: this.deviceIdentity.deviceId,
              publicKey: this.deviceIdentity.publicKeyBase64Url,
              signature,
              signedAt,
              nonce, // Include the server's nonce
            },
          },
        };

        this.ws?.send(JSON.stringify(connectFrame));
      };

      this.ws.on('open', () => {
        console.log(`  WebSocket open to ${this.config.gatewayUrl}`);
        // Wait for server to send connect.challenge event
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const frame = JSON.parse(data.toString());

          // Check for connect.challenge event from server
          if (!challengeReceived && frame.type === 'event' && frame.event === 'connect.challenge') {
            challengeReceived = true;
            const nonce = frame.payload?.nonce;
            console.log(`  Received challenge, nonce: ${nonce?.substring(0, 16)}...`);
            sendConnectRequest(nonce);
            return;
          }

          // Check for connect handshake response: {type:"res", id, ok, payload}
          if (!handshakeComplete && frame.type === 'res' && frame.id === connectId) {
            if (frame.ok) {
              const protocol = frame.payload?.protocol || 'unknown';
              console.log(`  Handshake complete (protocol v${protocol})`);
              handshakeComplete = true;
              this.connected = true;
              clearTimeout(timeout);
              resolve();
            } else {
              clearTimeout(timeout);
              reject(new Error(frame.error?.message || 'Connect handshake failed'));
            }
            return;
          }

          this.handleFrame(frame);
        } catch (error) {
          console.error('  Error parsing WebSocket message:', error);
        }
      });

      this.ws.on('error', (error) => {
        console.error('  WebSocket error:', error);
        clearTimeout(timeout);
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`  WebSocket disconnected (code: ${code}, reason: ${reason?.toString() || 'none'})`);
        this.connected = false;
        if (!handshakeComplete) {
          clearTimeout(timeout);
          reject(new Error(`Connection closed before handshake (code: ${code})`));
        }
      });
    });
  }

  private handleFrame(frame: any): void {
    // Handle response frames: {type:"res", id, ok, payload|error}
    if (frame.type === 'res' && frame.id) {
      const handler = this.messageHandlers.get(frame.id);
      if (handler) {
        // Map to our ResponseFrame format
        const response: ResponseFrame = {
          ok: frame.ok,
          id: frame.id,
          result: frame.payload,
          payload: frame.payload,
          error: frame.error,
          status: frame.ok ? 'ok' : 'error',
        };
        handler(response);
        this.messageHandlers.delete(frame.id);
      }
      return;
    }

    // Handle event frames: {type:"event", event, payload, seq?, stateVersion?}
    if (frame.type === 'event' && frame.event) {
      const eventFrame = frame as EventFrame;

      // Chat events - payload contains ChatEvent data
      if (frame.event === 'chat' && frame.payload) {
        const chatEvent = frame.payload as ChatEvent;
        const handler = this.eventHandlers.get(chatEvent.runId);
        if (handler) {
          // Wrap in EventFrame format expected by handlers
          handler({ event: frame.event, data: chatEvent, payload: frame.payload });
        }
      }

      // Agent lifecycle events
      if (frame.event === 'agent' && frame.payload?.stream === 'lifecycle') {
        const lifecycleData = frame.payload.data as AgentLifecycleEvent;
        if (lifecycleData.runId) {
          const handler = this.eventHandlers.get(lifecycleData.runId);
          if (handler) {
            handler(eventFrame);
          }
        }
      }
    }
  }

  /**
   * Send a WebSocket request and wait for response
   */
  private async sendRequest(method: string, params: any, timeoutMs = 30000): Promise<ResponseFrame> {
    if (!this.ws || !this.connected) {
      throw new Error('Not connected to OpenClaw gateway');
    }

    const messageId = randomUUID();
    // Use protocol v3 frame format: {type:"req", id, method, params}
    const requestFrame = { type: 'req', id: messageId, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(messageId);
        reject(new Error(`Request timeout for ${method}`));
      }, timeoutMs);

      this.messageHandlers.set(messageId, (response) => {
        clearTimeout(timeout);
        if (!response.ok) {
          reject(new Error(response.error?.message || `${method} failed`));
        } else {
          resolve(response);
        }
      });

      this.ws?.send(JSON.stringify(requestFrame));
    });
  }

  /**
   * Reset/clear the current session
   */
  async resetSession(): Promise<void> {
    try {
      await this.sendRequest('sessions.reset', {
        sessionKey: this.config.sessionKey,
      });
      console.log('  Session reset successfully');
    } catch (error) {
      // Session may not exist yet, which is fine
      console.log('  Session reset: no existing session (OK)');
    }
  }

  /**
   * Get session metadata including token counts
   */
  async getSessionTokens(): Promise<TokenUsage> {
    try {
      const response = await this.sendRequest('sessions.list', {
        agentId: 'main',
      });

      const payload = response.result || response.payload;
      const sessions = payload?.sessions || [];

      // Session keys in the API response have format: "agent:{agentId}:{sessionKey}"
      // We need to match against either the full key or just the session key portion
      const session = sessions.find(
        (s: SessionMetadata) => {
          const key = s.sessionKey || s.key; // API might return as 'key' not 'sessionKey'
          return key === this.config.sessionKey ||
                 key === `agent:main:${this.config.sessionKey}` ||
                 key?.endsWith(`:${this.config.sessionKey}`);
        }
      );

      if (session) {
        // Token fields might be named differently in the API
        // The session has a nested 'tokens' object with the breakdown
        const tokens = session.tokens || {};
        const totalTokens = session.totalTokens ?? tokens.total ?? 0;
        const inputTokens = session.inputTokens ?? tokens.input ?? 0;
        const outputTokens = session.outputTokens ?? tokens.output ?? 0;
        const cacheCreation = session.cacheCreationTokens ?? tokens.cacheCreation ?? 0;
        const cacheRead = session.cacheReadTokens ?? tokens.cacheRead ?? 0;
        return {
          total: totalTokens,
          input: inputTokens,
          output: outputTokens,
          cacheCreation: cacheCreation || undefined,
          cacheRead: cacheRead || undefined,
        };
      }

      return { total: 0, input: 0, output: 0 };
    } catch (error) {
      console.warn('  Could not get session tokens:', error);
      return { total: 0, input: 0, output: 0 };
    }
  }

  /**
   * Wait for an agent run to fully complete using agent.wait API
   */
  private async waitForAgent(runId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.eventHandlers.delete(runId);
        reject(new Error(`Agent wait timeout after ${this.config.agentWaitTimeoutMs}ms`));
      }, this.config.agentWaitTimeoutMs);

      // Listen for agent lifecycle events
      this.eventHandlers.set(runId, (event: EventFrame) => {
        if (event.event === 'agent' && event.payload?.stream === 'lifecycle') {
          const data = event.payload.data as AgentLifecycleEvent;

          if (data.phase === 'end') {
            clearTimeout(timeout);
            this.eventHandlers.delete(runId);
            resolve();
          } else if (data.phase === 'error') {
            clearTimeout(timeout);
            this.eventHandlers.delete(runId);
            reject(new Error(data.error || 'Agent error'));
          }
        }
      });

      // Also send agent.wait request as a backup (with long timeout)
      this.sendRequest('agent.wait', {
        runId,
        timeoutMs: this.config.agentWaitTimeoutMs,
      }, this.config.agentWaitTimeoutMs + 30000) // Add 30s buffer to request timeout
        .then(() => {
          clearTimeout(timeout);
          this.eventHandlers.delete(runId);
          resolve();
        })
        .catch((error) => {
          // Ignore if lifecycle events already resolved/rejected
          if (this.eventHandlers.has(runId)) {
            clearTimeout(timeout);
            this.eventHandlers.delete(runId);
            reject(error);
          }
        });
    });
  }

  /**
   * Send a prompt and wait for the FULL agentic loop to complete
   */
  async sendPrompt(prompt: string): Promise<PromptResult> {
    const startTime = Date.now();
    const startTokens = await this.getSessionTokens();

    // Reset accumulated response
    this.accumulatedResponse = '';

    // Send chat.send request
    const messageId = randomUUID();
    const idempotencyKey = randomUUID();

    const sendResponse = await this.sendRequest('chat.send', {
      sessionKey: this.config.sessionKey,
      message: prompt,
      idempotencyKey,
    });

    const runId = sendResponse.result?.runId;
    if (!runId) {
      throw new Error('No runId received from chat.send');
    }

    console.log(`    RunId: ${runId}`);

    // Set up chat event handler to accumulate response
    const chatHandler = (event: EventFrame) => {
      if (event.event === 'chat' && event.data) {
        const chatEvent = event.data as ChatEvent;

        if (chatEvent.state === 'delta' && chatEvent.message) {
          // Accumulate response text
          if (typeof chatEvent.message === 'string') {
            this.accumulatedResponse += chatEvent.message;
          } else if (chatEvent.message.content) {
            if (typeof chatEvent.message.content === 'string') {
              this.accumulatedResponse += chatEvent.message.content;
            } else if (Array.isArray(chatEvent.message.content)) {
              for (const block of chatEvent.message.content) {
                if (block.type === 'text' && block.text) {
                  this.accumulatedResponse += block.text;
                }
              }
            }
          }
        }
      }
    };

    // Register chat event handler
    const existingHandler = this.eventHandlers.get(runId);
    this.eventHandlers.set(runId, (event) => {
      chatHandler(event);
      if (existingHandler) existingHandler(event);
    });

    // Wait for the FULL agent loop to complete
    console.log('    Waiting for agent loop to complete...');
    await this.waitForAgent(runId);

    const endTime = Date.now();
    const endTokens = await this.getSessionTokens();

    // Calculate tokens used in this prompt
    const tokens: TokenUsage = {
      total: endTokens.total - startTokens.total,
      input: endTokens.input - startTokens.input,
      output: endTokens.output - startTokens.output,
      cacheCreation:
        (endTokens.cacheCreation || 0) - (startTokens.cacheCreation || 0) || undefined,
      cacheRead:
        (endTokens.cacheRead || 0) - (startTokens.cacheRead || 0) || undefined,
    };

    return {
      response: this.accumulatedResponse,
      tokens,
      timeMs: endTime - startTime,
    };
  }

  disconnect(): void {
    if (this.ws) {
      // Clean up all handlers
      this.messageHandlers.clear();
      this.eventHandlers.clear();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

/**
 * Configure VS7 mode and restart Docker container
 */
async function setVS7Mode(config: RunnerConfig, enabled: boolean): Promise<void> {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  Configuring: ${enabled ? 'VS7 MODE (Context Management ON)' : 'BASELINE (VS7 OFF)'}`);
  console.log(`${'─'.repeat(70)}`);

  let openclawConfig: any = {};
  try {
    const content = await fs.readFile(config.configPath, 'utf-8');
    openclawConfig = JSON.parse(content);
  } catch {
    // Config doesn't exist, start fresh
  }

  // Set contextManagement config
  if (!openclawConfig.agents) openclawConfig.agents = {};
  if (!openclawConfig.agents.defaults) openclawConfig.agents.defaults = {};

  if (enabled) {
    // VS7 MODE: Enable full context management with rollingSummary
    // Note: semanticHistory disabled - requires OpenAI API key for embeddings
    openclawConfig.agents.defaults.contextManagement = {
      enabled: true,
      budget: {
        systemPromptRatio: 0.15,
        bootstrapRatio: 0.1,
        historyRatio: 0.45,
        responseRatio: 0.2,
        minResponseTokens: 4096,
      },
      rollingSummary: {
        enabled: true,
        windowSize: 3, // Keep last 3 turns verbatim, summarize older
        summaryMaxTokens: 2000,
        triggerThreshold: 10000, // Lower threshold for testing (default: 30000)
      },
    };
  } else {
    // BASELINE: Disable all context management
    openclawConfig.agents.defaults.contextManagement = {
      enabled: false,
    };
  }

  // Disable gateway auth for testing (allow unauthenticated local connections)
  if (!openclawConfig.gateway) openclawConfig.gateway = {};
  // Remove auth to allow open loopback connections
  delete openclawConfig.gateway.auth;
  // Also set controlUi settings for testing
  if (!openclawConfig.gateway.controlUi) openclawConfig.gateway.controlUi = {};
  openclawConfig.gateway.controlUi.dangerouslyDisableDeviceAuth = true;

  await fs.mkdir(path.dirname(config.configPath), { recursive: true });
  await fs.writeFile(config.configPath, JSON.stringify(openclawConfig, null, 2));
  if (enabled) {
    console.log(`  Config: VS7 enabled with rollingSummary (threshold: 10k, window: 3 turns)`);
  } else {
    console.log(`  Config: contextManagement DISABLED (baseline)`);
  }

  // Restart Docker container using docker-compose to preserve environment variables
  console.log(`  Restarting Docker container: ${config.dockerContainer}...`);
  try {
    // Use docker-compose up -d to restart with proper env vars
    const composeDir = config.composeDir || path.resolve(process.cwd(), '..');

    // Container name format: {project}-{service}-{number}, e.g., "openclaw-openclaw-gateway-1"
    // We need the service name "openclaw-gateway"
    const parts = config.dockerContainer.split('-');
    // Remove project prefix (first part) and number suffix (last part)
    const serviceName = parts.slice(1, -1).join('-');

    // Pass environment variables through exec options (works on Windows and Unix)
    const env = { ...process.env };
    await execAsync(`docker-compose up -d ${serviceName}`, {
      cwd: composeDir,
      env,
    });
  } catch (error) {
    console.error('  Failed to restart Docker:', error);
    throw error;
  }

  // Wait for service to be ready
  console.log('  Waiting for service to start...');
  await waitForGateway(config.gatewayUrl, 30000);
  console.log(`  Ready in ${enabled ? 'VS7' : 'BASELINE'} mode\n`);
}

/**
 * Wait for the WebSocket gateway to be ready
 */
async function waitForGateway(url: string, timeoutMs: number): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, 3000);

        ws.on('open', () => {
          clearTimeout(timeout);
          ws.close();
          resolve();
        });

        ws.on('error', () => {
          clearTimeout(timeout);
          reject(new Error('Connection failed'));
        });
      });

      return; // Connected successfully
    } catch {
      // Wait before retrying
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error(`Gateway not ready after ${timeoutMs}ms`);
}

/**
 * Capture workspace files from Docker container
 */
async function captureWorkspaceFiles(
  config: RunnerConfig,
  outputDir: string
): Promise<string[]> {
  try {
    await fs.mkdir(outputDir, { recursive: true });

    // Use tar to copy workspace, excluding node_modules and other large directories
    // This avoids Windows symlink permission issues
    const tarPath = `${outputDir.replace(/\\/g, '/')}/workspace.tar`;
    try {
      // First, create a tarball in the container excluding problematic dirs
      await execAsync(
        `docker exec ${config.dockerContainer} sh -c "cd /home/node/.openclaw/workspace && tar --exclude='node_modules' --exclude='.git' --exclude='*.lock' --exclude='.pnpm' -cf /tmp/workspace.tar . 2>/dev/null || echo 'tar failed'"`
      );
      // Then copy the tarball out
      await execAsync(
        `docker cp ${config.dockerContainer}:/tmp/workspace.tar "${tarPath}"`
      );
      // Extract locally using Git Bash tar on Windows
      await execAsync(
        `tar -xf "${tarPath}" -C "${outputDir.replace(/\\/g, '/')}"`
      );
      // Clean up
      await fs.unlink(tarPath).catch(() => {});
    } catch (tarError) {
      // Tar approach failed - workspace may be empty or tar not available
      console.log('  Note: tar-based capture failed, workspace may be empty');
    }

    // List captured files
    const listFiles = async (dir: string, prefix = ''): Promise<string[]> => {
      const items = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];

      for (const item of items) {
        const relativePath = path.join(prefix, item.name);
        if (item.isDirectory()) {
          const subFiles = await listFiles(path.join(dir, item.name), relativePath);
          files.push(...subFiles);
        } else {
          files.push(relativePath);
        }
      }

      return files;
    };

    const files = await listFiles(outputDir);
    return files.filter(
      (f) => !f.includes('.openclaw') && !f.includes('node_modules') && !f.startsWith('.')
    );
  } catch (error) {
    console.warn('  Could not capture workspace files:', error);
    return [];
  }
}

/**
 * Clear workspace in Docker container
 */
async function clearWorkspace(config: RunnerConfig): Promise<void> {
  try {
    await execAsync(
      `docker exec ${config.dockerContainer} rm -rf /home/node/.openclaw/workspace/*`
    );
    console.log('  Workspace cleared');
  } catch (error) {
    console.warn('  Could not clear workspace:', error);
  }
}

/**
 * Load a test prompt by ID
 */
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

/**
 * Load all test IDs for a category
 */
async function loadTestIdsByCategory(category: string): Promise<string[]> {
  const testPromptsDir = path.join(process.cwd(), 'test-prompts');

  try {
    // Find the category directory (may have a numbered prefix like "1-context-retention")
    const dirs = await fs.readdir(testPromptsDir);
    const categoryDir = dirs.find(
      (d) => d === category || d.endsWith(`-${category}`) || d.match(new RegExp(`^\\d+-${category}$`))
    );

    if (!categoryDir) {
      throw new Error(`Category ${category} not found. Available: ${dirs.join(', ')}`);
    }

    const categoryPath = path.join(testPromptsDir, categoryDir);
    const files = await fs.readdir(categoryPath);
    const testIds: string[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const match = file.match(/^(\d+\.\d+)/);
        if (match) testIds.push(match[1]);
      }
    }

    return testIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      throw error;
    }
    throw new Error(`Category ${category} not found`);
  }
}

/**
 * Run a single test with all turns
 */
async function runTest(
  client: OpenClawClient,
  test: TestPrompt,
  mode: 'vs7' | 'baseline',
  config: RunnerConfig,
  outputBaseDir: string
): Promise<TestRun> {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  TEST ${test.id}: ${test.name}`);
  console.log(`  Mode: ${mode.toUpperCase()}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Reset session and workspace before test
  await client.resetSession();
  await clearWorkspace(config);

  const results: TurnMetrics[] = [];

  for (const turn of test.turns) {
    console.log(`\n  Turn ${turn.number}/${test.turns.length}:`);
    console.log(`  Prompt: ${turn.prompt.substring(0, 60)}...`);

    try {
      const result = await client.sendPrompt(turn.prompt);

      console.log(`    Response: ${result.response.substring(0, 80)}...`);
      console.log(
        `    Tokens: ${result.tokens.total.toLocaleString()} (in: ${result.tokens.input}, out: ${result.tokens.output})`
      );
      console.log(`    Time: ${(result.timeMs / 1000).toFixed(1)}s`);

      results.push({
        turnNumber: turn.number,
        userPrompt: turn.prompt,
        agentResponse: result.response,
        tokensUsed: {
          total: result.tokens.total,
          input: result.tokens.input,
          output: result.tokens.output,
          cacheCreation: result.tokens.cacheCreation,
          cacheRead: result.tokens.cacheRead,
        },
        responseTimeMs: result.timeMs,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`    Turn ${turn.number} failed:`, error);
      throw error;
    }
  }

  // Capture workspace files AFTER all turns complete
  const workspaceOutputDir = path.join(outputBaseDir, `test-${test.id}-${mode}`, 'workspace');
  const generatedFiles = await captureWorkspaceFiles(config, workspaceOutputDir);
  console.log(`\n  Captured ${generatedFiles.length} workspace files`);

  const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed.total, 0);
  const totalTimeMs = results.reduce((sum, r) => sum + r.responseTimeMs, 0);

  console.log(`\n  Test ${test.id} complete:`);
  console.log(`    Total tokens: ${totalTokens.toLocaleString()}`);
  console.log(`    Total time: ${(totalTimeMs / 1000).toFixed(1)}s`);

  return {
    testId: test.id,
    mode,
    results,
    totalTokens,
    totalTimeMs,
    generatedFiles,
  };
}

/**
 * Save test results to disk
 */
async function saveTestResult(
  run: TestRun,
  test: TestPrompt,
  outputDir: string
): Promise<void> {
  const result: TestResult = {
    instanceName: run.mode,
    testId: test.id,
    testName: test.name,
    category: test.category,
    timestamp: new Date().toISOString(),
    turns: run.results,
    qualityEvaluation: {
      taskCompleted: true, // To be validated manually
      contextRetained: true,
      codeWorks: true,
      notes: 'Auto-generated - needs manual validation',
    },
    totalTokens: run.totalTokens,
    totalTimeMs: run.totalTimeMs,
  };

  const resultPath = path.join(outputDir, `${test.id}-${run.mode}.json`);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
}

/**
 * Print comparison summary
 */
function printComparison(baseline: TestRun, vs7: TestRun): void {
  const tokenDiff = baseline.totalTokens - vs7.totalTokens;
  const tokenPct = baseline.totalTokens > 0
    ? ((tokenDiff / baseline.totalTokens) * 100).toFixed(1)
    : '0.0';

  const timeDiff = baseline.totalTimeMs - vs7.totalTimeMs;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  COMPARISON: Test ${baseline.testId}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Tokens:`);
  console.log(`    Baseline: ${baseline.totalTokens.toLocaleString()}`);
  console.log(`    VS7:      ${vs7.totalTokens.toLocaleString()}`);
  console.log(
    `    Savings:  ${tokenDiff > 0 ? '+' : ''}${tokenDiff.toLocaleString()} (${tokenDiff > 0 ? '+' : ''}${tokenPct}%)`
  );
  console.log(`  Time:`);
  console.log(`    Baseline: ${(baseline.totalTimeMs / 1000).toFixed(1)}s`);
  console.log(`    VS7:      ${(vs7.totalTimeMs / 1000).toFixed(1)}s`);
  console.log(
    `    Diff:     ${timeDiff > 0 ? '+' : ''}${(timeDiff / 1000).toFixed(1)}s`
  );
  console.log(`  Files:`);
  console.log(`    Baseline: ${baseline.generatedFiles.length} files`);
  console.log(`    VS7:      ${vs7.generatedFiles.length} files`);
  console.log(`${'─'.repeat(70)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse arguments
  let testIds: string[] = [];
  let gatewayUrl = 'ws://localhost:18789';
  let dockerContainer = 'openclaw-openclaw-gateway-1';
  // Config path is relative to OpenClaw root, not Dev directory
  let configPath = '../data/openclaw-config/openclaw.json';
  let workspaceDir = './data/openclaw-workspace';
  let gatewayToken: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--test-id=')) {
      testIds = [arg.split('=')[1]];
    } else if (arg.startsWith('--test-ids=')) {
      testIds = arg.split('=')[1].split(',');
    } else if (arg.startsWith('--category=')) {
      const category = arg.split('=')[1];
      testIds = await loadTestIdsByCategory(category);
    } else if (arg.startsWith('--gateway-url=')) {
      gatewayUrl = arg.split('=')[1];
    } else if (arg.startsWith('--docker=')) {
      dockerContainer = arg.split('=')[1];
    } else if (arg.startsWith('--config=')) {
      configPath = arg.split('=')[1];
    } else if (arg.startsWith('--token=')) {
      gatewayToken = arg.split('=')[1];
    }
  }

  // Try to get token from environment if not provided
  if (!gatewayToken) {
    gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  }

  if (testIds.length === 0) {
    console.error('Usage:');
    console.error('  npm run sequential -- --test-id=4.1');
    console.error('  npm run sequential -- --test-ids=4.1,4.2,4.3');
    console.error('  npm run sequential -- --category=homestead-farm-management');
    console.error('\nOptions:');
    console.error('  --gateway-url=ws://host:port  Gateway URL (default: ws://localhost:18789)');
    console.error('  --docker=container-name       Docker container (default: openclaw-openclaw-gateway-1)');
    console.error('  --config=path                 Config file path');
    process.exit(1);
  }

  const sessionId = `sequential-${Date.now()}`;
  const outputDir = path.join(process.cwd(), 'results', sessionId);

  console.log('\n' + '═'.repeat(70));
  console.log('  SEQUENTIAL TOGGLE TEST RUNNER');
  console.log('  VS7 On/Off Comparison with agent.wait');
  console.log('═'.repeat(70));
  console.log(`\nSession: ${sessionId}`);
  console.log(`Tests: ${testIds.join(', ')}`);
  console.log(`Gateway: ${gatewayUrl}`);
  console.log(`Docker: ${dockerContainer}\n`);

  const config: RunnerConfig = {
    gatewayUrl,
    sessionKey: `test-${sessionId}`,
    workspaceDir,
    configPath,
    dockerContainer,
    agentWaitTimeoutMs: 15 * 60 * 1000, // 15 minutes
    gatewayToken,
    composeDir: path.resolve(process.cwd(), '..'), // OpenClaw root (parent of Dev)
  };

  const allResults: { baseline: TestRun[]; vs7: TestRun[] } = { baseline: [], vs7: [] };

  for (const testId of testIds) {
    const test = await loadTestPrompt(testId);

    // Run BASELINE first (VS7 OFF)
    await setVS7Mode(config, false);
    // Use unique session key for baseline run
    const baselineConfig = { ...config, sessionKey: `${config.sessionKey}-baseline-${testId}` };
    const client = new OpenClawClient(baselineConfig);

    try {
      await client.connect();
      const baselineRun = await runTest(client, test, 'baseline', baselineConfig, outputDir);
      allResults.baseline.push(baselineRun);
      await saveTestResult(baselineRun, test, outputDir);
    } finally {
      client.disconnect();
    }

    // Run VS7 (Context Management ON)
    await setVS7Mode(config, true);
    // Use unique session key for VS7 run
    const vs7Config = { ...config, sessionKey: `${config.sessionKey}-vs7-${testId}` };
    const vs7Client = new OpenClawClient(vs7Config);

    try {
      await vs7Client.connect();
      const vs7Run = await runTest(vs7Client, test, 'vs7', vs7Config, outputDir);
      allResults.vs7.push(vs7Run);
      await saveTestResult(vs7Run, test, outputDir);

      // Print comparison for this test
      const baselineRun = allResults.baseline[allResults.baseline.length - 1];
      printComparison(baselineRun, vs7Run);
    } finally {
      vs7Client.disconnect();
    }
  }

  // Final summary
  const totalBaselineTokens = allResults.baseline.reduce((sum, r) => sum + r.totalTokens, 0);
  const totalVS7Tokens = allResults.vs7.reduce((sum, r) => sum + r.totalTokens, 0);
  const totalSavings = totalBaselineTokens - totalVS7Tokens;
  const savingsPct = totalBaselineTokens > 0
    ? ((totalSavings / totalBaselineTokens) * 100).toFixed(1)
    : '0.0';

  console.log('\n' + '═'.repeat(70));
  console.log('  FINAL SUMMARY');
  console.log('═'.repeat(70));
  console.log(`\n  Tests completed: ${testIds.length}`);
  console.log(`  Total baseline tokens: ${totalBaselineTokens.toLocaleString()}`);
  console.log(`  Total VS7 tokens: ${totalVS7Tokens.toLocaleString()}`);
  console.log(`  Total savings: ${totalSavings.toLocaleString()} (${savingsPct}%)`);
  console.log(`\n  Results saved to: ${outputDir}/`);
  console.log('═'.repeat(70) + '\n');
}

main().catch((error) => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
