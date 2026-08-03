import assert from "node:assert/strict";
import test from "node:test";
import { collectable, PageRegistry } from "../dist/page-registry.js";

/**
 * The collector's judgement, tested without a browser.
 *
 * Every case here is a way closing the wrong tab would hurt someone: the last
 * one standing, a page a human was told to read, or a session we cannot see
 * but which is plainly still moving.
 */

const TTL = 30 * 60 * 1000;
const NOW = 1_000_000_000;

const page = (over = {}) => ({
  pageId: "p1",
  owner: null,
  url: "https://example.test/",
  title: "Example",
  createdAt: NOW - TTL * 2,
  lastChangedAt: NOW - TTL * 2,
  keepUntil: null,
  ...over,
});

test("never collects the only page", () => {
  assert.deepEqual(collectable([page()], NOW, TTL), []);
});

test("always leaves one page standing, even when all are idle", () => {
  const pages = [
    page({ pageId: "a", lastChangedAt: NOW - TTL * 3 }),
    page({ pageId: "b", lastChangedAt: NOW - TTL * 2 }),
    page({ pageId: "c", lastChangedAt: NOW - TTL * 4 }),
  ];
  const collected = collectable(pages, NOW, TTL);

  assert.equal(collected.length, 2);
  // The survivor is the most recently touched — likeliest to be someone's work.
  assert.ok(!collected.some((d) => d.page.pageId === "b"));
});

test("a page someone is holding is never collected", () => {
  const pages = [
    page({ pageId: "held", keepUntil: NOW + 60_000 }),
    page({ pageId: "idle" }),
  ];
  assert.deepEqual(
    collectable(pages, NOW, TTL).map((d) => d.page.pageId),
    ["idle"],
  );
});

test("an expired hold stops protecting", () => {
  const pages = [page({ pageId: "stale-hold", keepUntil: NOW - 1 }), page({ pageId: "other" })];
  assert.equal(collectable(pages, NOW, TTL).length, 1);
});

test("a page that changed inside the ttl is left alone", () => {
  const pages = [
    page({ pageId: "busy", lastChangedAt: NOW - 60_000 }),
    page({ pageId: "idle" }),
  ];
  assert.deepEqual(
    collectable(pages, NOW, TTL).map((d) => d.page.pageId),
    ["idle"],
  );
});

test("says why, so a close is auditable", () => {
  const pages = [
    page({ pageId: "mine", owner: "newsdesk" }),
    page({ pageId: "stray" }),
    page({ pageId: "keeper", lastChangedAt: NOW }),
  ];
  const byId = Object.fromEntries(collectable(pages, NOW, TTL).map((d) => [d.page.pageId, d.reason]));

  assert.equal(byId.mine, "owner-gone");
  assert.equal(byId.stray, "unowned-idle");
});

test("observing adopts tabs nobody registered and forgets ones that went", () => {
  // The tabs that actually leak are the ones no client ever told us about.
  const registry = new PageRegistry();
  registry.track("known", "newsdesk", "https://a.test/", "A", NOW);

  registry.observe(
    [
      { pageId: "known", url: "https://a.test/", title: "A" },
      { pageId: "stray", url: "https://b.test/", title: "B" },
    ],
    NOW,
  );
  assert.equal(registry.get("stray")?.owner, null);

  registry.observe([{ pageId: "stray", url: "https://b.test/", title: "B" }], NOW);
  assert.equal(registry.get("known"), undefined);
});

test("a moving page keeps resetting its idle clock", () => {
  const registry = new PageRegistry();
  registry.track("p", null, "https://a.test/", "A", NOW);

  registry.observe([{ pageId: "p", url: "https://a.test/next", title: "A" }], NOW + TTL * 2);
  assert.equal(registry.get("p")?.lastChangedAt, NOW + TTL * 2);

  // Unchanged this time, so the clock stands still rather than restarting.
  registry.observe([{ pageId: "p", url: "https://a.test/next", title: "A" }], NOW + TTL * 3);
  assert.equal(registry.get("p")?.lastChangedAt, NOW + TTL * 2);
});

test("keep extends a hold and counts as activity", () => {
  const registry = new PageRegistry();
  registry.track("p", "newsdesk", "https://a.test/", "A", NOW - TTL * 2);

  registry.keep("p", 15 * 60_000, NOW);
  const held = registry.get("p");

  assert.equal(held?.keepUntil, NOW + 15 * 60_000);
  assert.equal(held?.lastChangedAt, NOW);
  assert.deepEqual(collectable([held], NOW, TTL), []);
});
