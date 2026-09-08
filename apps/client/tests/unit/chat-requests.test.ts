import { describe, expect, it } from 'vitest';
import { HistoryRequests } from '../../src/chat/requests.js';

const TOWN = '018f3a00-0000-7000-8000-0000000000aa';
const DM = '018f3a00-0000-7000-8000-0000000000dd';

describe('deciding whether a history response is still worth having', () => {
  it('keeps the response to the request that is still outstanding', () => {
    const requests = new HistoryRequests();
    const token = requests.issue(TOWN);
    expect(requests.isCurrent(TOWN, token)).toBe(true);
  });

  it('disowns a response once a newer request for the same channel has gone out', () => {
    const requests = new HistoryRequests();
    const first = requests.issue(TOWN);
    const second = requests.issue(TOWN);

    expect(requests.isCurrent(TOWN, first)).toBe(false);
    expect(requests.isCurrent(TOWN, second)).toBe(true);
  });

  it('disowns everything outstanding when a block changes the answer for every channel', () => {
    const requests = new HistoryRequests();
    const town = requests.issue(TOWN);
    const dm = requests.issue(DM);

    requests.invalidateAll();

    expect(requests.isCurrent(TOWN, town)).toBe(false);
    expect(requests.isCurrent(DM, dm)).toBe(false);

    // The refetch that the block itself kicks off was issued after, so it still counts.
    const refetch = requests.issue(TOWN);
    expect(requests.isCurrent(TOWN, refetch)).toBe(true);
  });

  it('keeps one channel out of another channel’s way', () => {
    const requests = new HistoryRequests();
    const town = requests.issue(TOWN);
    requests.issue(DM);

    expect(requests.isCurrent(TOWN, town)).toBe(true);
  });

  it('never re-issues a token a stale response could still be holding', () => {
    const requests = new HistoryRequests();
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      requests.invalidateAll();
      seen.add(requests.issue(i % 2 === 0 ? TOWN : DM));
    }
    expect(seen.size).toBe(200);
  });
});
