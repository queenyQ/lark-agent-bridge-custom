import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DshAdapter } from '../../src/agent/dsh/adapter';
import type { AgentEvent } from '../../src/agent/types';
import { createTmpProfile } from '../helpers/tmp-profile';

it.skipIf(process.platform === 'win32')('uses DSH JSON events, native resume and process-group interruption', async () => {
  const tmp = await createTmpProfile('dsh-adapter-');
  const binaryPath = join(tmp.root, 'fake-dsh');
  try {
    await writeFile(binaryPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
const emit = (event) => console.log(JSON.stringify(event));
if (args.includes('--version')) {
  console.log('fake DSH 1.0');
} else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { prompt += chunk; });
  process.stdin.on('end', () => {
    if (JSON.stringify(args) !== JSON.stringify(['--profile', 'headless', '--json', '--session-id', 'session-native', '-'])) {
      process.exitCode = 1;
      return;
    }
    emit({ type: 'session', sessionId: 'session-native' });
    if (prompt.endsWith('interrupt this run')) {
      setInterval(() => {}, 1000);
    } else {
      emit({ type: 'text', text: 'hello' });
      emit({ type: 'final', text: 'hello' });
    }
  });
}
`, { mode: 0o700 });

    const adapter = new DshAdapter({ binaryPath, profile: 'headless' });
    expect(await adapter.isAvailable()).toBe(true);
    const opts = { runId: 'native', cwd: tmp.workspace, sessionId: 'session-native' };
    const run = adapter.run({ ...opts, prompt: 'reply' });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events).toEqual([
      { type: 'system', sessionId: 'session-native' },
      { type: 'text', delta: 'hello' },
      { type: 'final_text', content: 'hello' },
      { type: 'done', sessionId: 'session-native', terminationReason: 'normal' },
    ]);

    const interrupted = adapter.run({ ...opts, prompt: 'interrupt this run' });
    try {
      const stopped: AgentEvent[] = [];
      for await (const event of interrupted.events) {
        stopped.push(event);
        if (event.type === 'system') await interrupted.stop();
      }
      expect(stopped.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
      expect(await interrupted.waitForExit(100)).toBe(true);
    } finally {
      await interrupted.stop();
    }
  } finally {
    await tmp.cleanup();
  }
}, 15000);
