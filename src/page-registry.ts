/**
 * Who owns which tab, and which tabs nobody wants any more.
 *
 * This browser is shared: the REST surface, the MCP surface and any
 * `chrome-devtools-mcp` client all open tabs on the same Chrome, and until now
 * nothing ever closed one. The only cleanup was the whole-Chrome idle reaper,
 * which measures time since *any* activity — so on an instance in daily use it
 * effectively never fires and tabs accumulate for as long as the container
 * lives.
 *
 * Collecting them needs ownership first, and that is why the two live in one
 * file rather than two. A collector that does not know who owns a tab closes
 * exactly the wrong ones: the tab sitting idle longest is often a page a human
 * was asked to look at, which is precisely the case that must survive.
 *
 * The decision itself (`collectable`) is a pure function over plain records, so
 * the judgement can be tested without a browser anywhere near it.
 */

export interface PageRecord {
  /** CDP target id — stable, and meaningful outside this process. */
  pageId: string;
  /** Who asked for it. Null for a tab we merely observed. */
  owner: string | null;
  url: string;
  title: string;
  createdAt: number;
  /**
   * When this page was last *seen to change* — a new url or title — or last
   * touched by its owner. Not "when Chrome last painted it": we cannot see
   * another client's activity, only its effects.
   */
  lastChangedAt: number;
  /**
   * Held until this moment regardless of idleness. What "a human is reading
   * this right now" looks like from here.
   */
  keepUntil: number | null;
}

export interface CollectDecision {
  page: PageRecord;
  reason: "unowned-idle" | "owner-gone";
}

/**
 * Which of these tabs may be closed.
 *
 * Three rules, and each exists because of a way this could go wrong:
 *
 *  - **never the last page** — closing it leaves Chrome with nothing, and the
 *    REST surface resolves against the first page;
 *  - **never inside `keepUntil`** — someone said they were using it;
 *  - **only when observably idle** — an unowned tab might belong to a live
 *    session we cannot see, so unchanged url *and* title for the whole TTL is
 *    the weakest claim worth acting on.
 */
export function collectable(pages: PageRecord[], now: number, ttlMs: number): CollectDecision[] {
  if (pages.length <= 1) return [];

  const decisions: CollectDecision[] = []
  for (const page of pages) {
    if (page.keepUntil !== null && page.keepUntil > now) continue;
    if (now - page.lastChangedAt < ttlMs) continue;
    decisions.push({ page, reason: page.owner === null ? "unowned-idle" : "owner-gone" });
  }

  /**
   * Whatever happens, one tab stays. Sorted so the oldest go first and the
   * survivor is the most recently touched — the one most likely to be someone's
   * current work.
   */
  const survivors = pages.length - decisions.length;
  if (survivors >= 1) return decisions;

  decisions.sort((a, b) => b.page.lastChangedAt - a.page.lastChangedAt);
  return decisions.slice(1);
}

export class PageRegistry {
  private readonly pages = new Map<string, PageRecord>();

  /** Record a tab this server opened for someone. */
  track(pageId: string, owner: string | null, url: string, title: string, now = Date.now()): PageRecord {
    const record: PageRecord = {
      pageId,
      owner,
      url,
      title,
      createdAt: now,
      lastChangedAt: now,
      keepUntil: null,
    };
    this.pages.set(pageId, record);
    return record;
  }

  /**
   * Fold in what Chrome currently has.
   *
   * Tabs nobody registered are added as unowned — those are the ones actually
   * leaking. A tab whose url or title moved counts as changed, which is the
   * only activity signal available for a client that never talks to us.
   */
  observe(live: Array<{ pageId: string; url: string; title: string }>, now = Date.now()): PageRecord[] {
    const seen = new Set<string>();

    for (const { pageId, url, title } of live) {
      seen.add(pageId);
      const known = this.pages.get(pageId);
      if (!known) {
        this.track(pageId, null, url, title, now);
        continue;
      }
      if (known.url !== url || known.title !== title) {
        known.url = url;
        known.title = title;
        known.lastChangedAt = now;
      }
    }

    // Anything Chrome no longer has is gone, however it went.
    for (const pageId of [...this.pages.keys()]) {
      if (!seen.has(pageId)) this.pages.delete(pageId);
    }

    return [...this.pages.values()];
  }

  /** Hold a tab open — a human is looking at it. */
  keep(pageId: string, ttlMs: number, now = Date.now()): PageRecord | undefined {
    const page = this.pages.get(pageId);
    if (!page) return undefined;
    page.keepUntil = now + ttlMs;
    page.lastChangedAt = now;
    return page;
  }

  release(pageId: string): void {
    const page = this.pages.get(pageId);
    if (page) page.keepUntil = null;
  }

  get(pageId: string): PageRecord | undefined {
    return this.pages.get(pageId);
  }

  forget(pageId: string): void {
    this.pages.delete(pageId);
  }

  list(now = Date.now()): Array<PageRecord & { idleForMs: number }> {
    return [...this.pages.values()].map((page) => ({
      ...page,
      idleForMs: now - page.lastChangedAt,
    }));
  }
}
