import { afterEach, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { PendingQueue } from '../../../src/bot/pending-queue';
afterEach(() => vi.useRealTimers());
it('retains failed messages without retry looping and retries before new input', () => {
  vi.useFakeTimers();
  const flush = vi.fn();
  const queue = new PendingQueue(600, flush);
  const old = { messageId: 'old' } as NormalizedMessage;
  const newer = { messageId: 'new' } as NormalizedMessage;
  queue.restore('chat', [old]);
  vi.advanceTimersByTime(6000);
  expect(flush).not.toHaveBeenCalled();
  queue.push('chat', newer);
  vi.advanceTimersByTime(600);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(flush).toHaveBeenCalledWith('chat', [old, newer]);
});

it('flushes retained pending messages immediately after the active run stops', () => {
  vi.useFakeTimers();
  const flush = vi.fn();
  const queue = new PendingQueue(600, flush);
  const msg = { messageId: 'queued' } as NormalizedMessage;
  queue.block('chat');
  queue.push('chat', msg);
  vi.advanceTimersByTime(6000);
  expect(flush).not.toHaveBeenCalled();
  queue.unblock('chat');
  expect(flush).toHaveBeenCalledWith('chat', [msg]);
});

it('does not flush cleared pending messages when the active run stops', () => {
  vi.useFakeTimers();
  const flush = vi.fn();
  const queue = new PendingQueue(600, flush);
  const msg = { messageId: 'queued' } as NormalizedMessage;
  queue.block('chat');
  queue.push('chat', msg);
  expect(queue.cancel('chat')).toEqual([msg]);
  queue.unblock('chat');
  vi.advanceTimersByTime(6000);
  expect(flush).not.toHaveBeenCalled();
});
