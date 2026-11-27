export type BrowserResponse = {
  url: string; status: number; headers: Record<string, string>; response: unknown;
};

export function isChallenge(response: BrowserResponse) {
  return Object.entries(response.headers).some(([key, value]) =>
    key.toLowerCase() === "cf-mitigated" && value.toLowerCase() === "challenge");
}

// One coordinator per browser session. Navigation drains existing fetches and
// blocks new ones; concurrent challenge responses share the same recovery.
export class SessionGet {
  private readyOrigin = "";
  private generation = 0;
  private recovering?: Promise<void>;
  private active = new Set<Promise<unknown>>();

  constructor(
    private fetch: (url: string) => Promise<BrowserResponse>,
    private solve: (url: string) => Promise<void>,
  ) {}

  private async recover(url: string, generation: number) {
    if (this.recovering) {
      await this.recovering;
      return;
    }
    if (generation !== this.generation && this.readyOrigin === new URL(url).origin) return;
    const recovery = (async () => {
      await Promise.allSettled([...this.active]);
      await this.solve(url);
      this.readyOrigin = new URL(url).origin;
      this.generation++;
    })();
    this.recovering = recovery;
    try { await recovery; }
    finally { this.recovering = undefined; }
  }

  async get(url: string): Promise<BrowserResponse> {
    const origin = new URL(url).origin;
    while (this.recovering || this.readyOrigin !== origin) {
      await this.recover(url, this.generation);
    }
    const generation = this.generation;
    const pending = this.fetch(url);
    this.active.add(pending);
    let response: BrowserResponse;
    try { response = await pending; }
    finally { this.active.delete(pending); }
    if (!isChallenge(response)) return response;
    await this.recover(url, generation);
    // Exactly one retry. An unresolved challenge is surfaced, never looped.
    return this.getAfterRecovery(url);
  }

  private async getAfterRecovery(url: string) {
    while (this.recovering) await this.recovering;
    const pending = this.fetch(url);
    this.active.add(pending);
    try {
      const response = await pending;
      if (isChallenge(response)) throw new Error("Challenge unresolved after session recovery");
      return response;
    } finally { this.active.delete(pending); }
  }
}
