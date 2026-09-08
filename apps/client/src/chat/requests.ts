/**
 * History is fetched over HTTP while blocks, live frames and channel switches keep changing
 * what the answer *should* have been, so a response is only worth merging if the request it
 * belongs to is still the current one for its channel.
 *
 * A token stops being current when a newer request for the same channel is issued, or when
 * `invalidateAll` is called — a block rewrites what the server would return for every channel
 * at once, so every request outstanding at that moment answers a question nobody asked.
 */
export class HistoryRequests {
  private next = 1;
  private readonly current = new Map<string, number>();

  issue(channelId: string): number {
    const token = this.next++;
    this.current.set(channelId, token);
    return token;
  }

  isCurrent(channelId: string, token: number): boolean {
    return this.current.get(channelId) === token;
  }

  invalidateAll(): void {
    this.current.clear();
  }
}
