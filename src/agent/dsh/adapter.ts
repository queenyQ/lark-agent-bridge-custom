import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { log } from '../../core/logger';
import type { DshConfig } from '../../config/profile-schema';
import { mergeProcessEnv } from '../../platform/spawn';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability } from '../preflight';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';

interface DshEvent {
  type?: string;
  text?: string;
  sessionId?: string;
  session_id?: string;
  phase?: string;
  reason?: { kind?: string; message?: string; error?: { message?: string } };
  callId?: string;
  call_id?: string;
  tool?: string;
  input?: unknown;
  result?: unknown;
  status?: string;
  isError?: boolean;
  message?: string;
}

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DeepSeek Harness';
  private botIdentity?: AgentBotIdentity;

  constructor(
    private readonly config: DshConfig,
    private readonly larkChannel?: LarkChannelEnvContext,
  ) {}

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  checkAvailability() {
    return checkAgentAvailability({
      agentId: this.id,
      agentName: this.displayName,
      command: this.config.binaryPath,
      binaryPath: this.config.binaryPath,
    });
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for DshAdapter.run');
    const args = ['--profile', this.config.profile];
    if (this.config.patchPath) args.push('--patch', this.config.patchPath);
    args.push('--json');
    if (opts.sessionId) args.push('--session-id', opts.sessionId);
    args.push('-');

    const detached = process.platform !== 'win32';
    const child = spawn(this.config.binaryPath, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached,
    });
    log.info('agent', 'dsh-spawn', { pid: child.pid ?? null, resume: Boolean(opts.sessionId) });
    let failure: string | undefined;
    let interrupted = false;
    let exited = false;
    let stopPromise: Promise<void> | undefined;
    const closed = new Promise<number | null>((resolve) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        failure = `DSH could not start (${err.code ?? 'spawn error'}).`;
      });
      child.once('close', (code, signal) => {
        exited = true;
        log.info('agent', 'dsh-exit', { code, signal, interrupted });
        resolve(code);
      });
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    const waitForExit = async (timeoutMs: number): Promise<boolean> => {
      if (exited) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          closed.then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const signalChild = (signal: NodeJS.Signals): void => {
      if (!child.pid || exited) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
    };

    const events = async function* (): AsyncGenerator<AgentEvent> {
      let sessionId: string | undefined;
      let final = false;
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        let event: DshEvent;
        try {
          event = JSON.parse(line) as DshEvent;
        } catch {
          continue;
        }
        if (!event || typeof event !== 'object' || interrupted) continue;
        switch (event.type) {
          case 'session':
            sessionId = event.sessionId ?? event.session_id;
            if (sessionId) yield { type: 'system', sessionId };
            break;
          case 'text':
            if (event.text) yield { type: 'text', delta: event.text };
            break;
          case 'tool_call': {
            const id = event.callId ?? event.call_id;
            if (id) yield { type: 'tool_use', id, name: event.tool ?? 'DSH tool', input: event.input };
            break;
          }
          case 'tool_result': {
            const id = event.callId ?? event.call_id;
            if (id) yield {
              type: 'tool_result',
              id,
              output: typeof event.result === 'string' ? event.result : JSON.stringify(event.result ?? ''),
              isError: event.isError === true || event.status === 'failed',
            };
            break;
          }
          case 'status':
            if (event.phase === 'turn_end' && event.reason?.kind === 'error') {
              failure = 'DSH reported a failed turn. Check the selected DSH profile and model credentials.';
            }
            break;
          case 'error':
            failure = 'DSH reported an error. Check the selected DSH profile and model credentials.';
            break;
          case 'final':
            if (!failure && !final && event.text) {
              yield { type: 'final_text', content: event.text };
            }
            final = true;
            break;
        }
      }
      const code = await closed;
      if (interrupted) yield { type: 'done', sessionId, terminationReason: 'interrupted' };
      else if (failure || code !== 0 || !final) yield {
        type: 'error',
        message: failure ?? `DSH exited without a completed response (exit: ${code ?? 'signal'}).`,
        terminationReason: 'failed',
      };
      else yield { type: 'done', sessionId, terminationReason: 'normal' };
    };

    return {
      runId: opts.runId,
      events: events(),
      waitForExit,
      stop() {
        stopPromise ??= (async () => {
          if (exited) return;
          interrupted = true;
          signalChild('SIGTERM');
          if (!(await waitForExit(opts.stopGraceMs ?? 5000))) signalChild('SIGKILL');
        })();
        return stopPromise;
      },
    };
  }
}
