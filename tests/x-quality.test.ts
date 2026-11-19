import { describe, expect, it } from 'vitest';
import {
  isPureJokeXPost,
  isXReply,
  parseXTrustedHandles,
  xHotEligible,
} from '../src/shared/x-quality';

const trusted = new Set(['trustedacct']);

function post(overrides: Record<string, unknown> = {}) {
  return {
    title: 'A new open-source agent framework',
    body: 'We released the code and docs today.',
    authorHandle: 'trustedacct',
    extra: {},
    ...overrides,
  };
}

describe('X hot gate', () => {
  it('requires a trusted account or a cross-source confirmation', () => {
    expect(xHotEligible(post({ authorHandle: 'randomacct' }), 0, trusted)).toBe(false);
    expect(xHotEligible(post(), 0, trusted)).toBe(true);
    expect(xHotEligible(post({ authorHandle: 'randomacct' }), 1, trusted)).toBe(true);
  });

  it('drops replies even when the account is trusted or confirmed', () => {
    expect(isXReply(post({ title: '@someone here is the fix' }))).toBe(true);
    expect(isXReply(post({ extra: { isReply: true } }))).toBe(true);
    expect(xHotEligible(post({ title: '@someone here is the fix' }), 1, trusted)).toBe(false);
  });

  it('drops short linkless jokes, but not substantive commentary', () => {
    const joke = post({
      title: '英伟达版《最后的晩餐》。。。 犹大是谁有点儿太明显了。。。🌚',
      body: '',
    });
    expect(isPureJokeXPost(joke)).toBe(true);
    expect(xHotEligible(joke, 1, trusted)).toBe(false);

    const linked = post({
      title: 'Shipping an open-source agent runtime 😂',
      body: 'Code: https://github.com/example/runtime',
    });
    expect(isPureJokeXPost(linked)).toBe(false);

    const commentary = post({
      title: 'A long technical thread about agent evaluation',
      body: 'x'.repeat(200),
    });
    expect(isPureJokeXPost(commentary)).toBe(false);
  });

  it('parses an explicit allowlist and falls back to the curated defaults', () => {
    expect(parseXTrustedHandles(undefined).has('simonw')).toBe(true);
    const custom = parseXTrustedHandles('@Foo, BAR  baz');
    expect([...custom]).toEqual(['foo', 'bar', 'baz']);
    expect(custom.has('simonw')).toBe(false);
  });
});
