import assert from "node:assert/strict";
import test from "node:test";
import { ScreencastHub } from "../dist/screencast.js";

/**
 * Fan-out, against a fake CDP session.
 *
 * The property under test is that watchers share one stream: a second operator
 * opening a view must not restart or disturb the first, and the last one out
 * must actually stop the encode rather than leaving Chrome producing frames
 * nobody reads.
 */

function fakePage() {
  const sent = [];
  const handlers = new Map();
  const session = {
    sent,
    send: async (method, params) => {
      sent.push({ method, params });
      return {};
    },
    on: (event, handler) => handlers.set(event, handler),
    emit: (event, payload) => handlers.get(event)?.(payload),
    detach: async () => {},
  };
  return {
    session,
    context: () => ({ newCDPSession: async () => session }),
  };
}

function fakeSocket() {
  const messages = [];
  const listeners = new Map();
  return {
    readyState: 1,
    messages,
    send: (data) => messages.push(data),
    close: () => {},
    on: (event, handler) => listeners.set(event, handler),
    fire: (event) => listeners.get(event)?.(),
  };
}

const OPTIONS = { quality: 60, maxWidth: 1280, maxHeight: 1024 };

test("one stream serves many watchers", async () => {
  const page = fakePage();
  const hub = new ScreencastHub(OPTIONS);

  await hub.subscribe("p1", page, fakeSocket());
  await hub.subscribe("p1", page, fakeSocket());

  const starts = page.session.sent.filter((c) => c.method === "Page.startScreencast");
  assert.equal(starts.length, 1, "a second watcher must not restart the stream");
  assert.equal(hub.watchers("p1"), 2);
});

test("the last watcher out stops the encode", async () => {
  const page = fakePage();
  const hub = new ScreencastHub(OPTIONS);
  const first = fakeSocket();
  const second = fakeSocket();

  await hub.subscribe("p1", page, first);
  await hub.subscribe("p1", page, second);

  await hub.unsubscribe("p1", first);
  assert.equal(hub.watchers("p1"), 1);
  assert.equal(page.session.sent.filter((c) => c.method === "Page.stopScreencast").length, 0);

  await hub.unsubscribe("p1", second);
  assert.equal(hub.watchers("p1"), 0);
  assert.equal(page.session.sent.filter((c) => c.method === "Page.stopScreencast").length, 1);
});

test("tells the registry when a tab gains and loses its last watcher", async () => {
  // This is what stops the collector closing a page somebody is reading.
  const page = fakePage();
  const watched = [];
  const hub = new ScreencastHub(OPTIONS, (pageId, watching) => watched.push([pageId, watching]));

  const a = fakeSocket();
  const b = fakeSocket();
  await hub.subscribe("p1", page, a);
  await hub.subscribe("p1", page, b);
  await hub.unsubscribe("p1", a);
  await hub.unsubscribe("p1", b);

  assert.deepEqual(watched, [
    ["p1", true],
    ["p1", false],
  ]);
});

test("a frame reaches every watcher, and is acked once", async () => {
  const page = fakePage();
  const hub = new ScreencastHub(OPTIONS);
  const a = fakeSocket();
  const b = fakeSocket();
  await hub.subscribe("p1", page, a);
  await hub.subscribe("p1", page, b);

  page.session.emit("Page.screencastFrame", {
    data: Buffer.from("jpeg-bytes").toString("base64"),
    sessionId: 7,
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: 1280,
      deviceHeight: 800,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
  });
  await new Promise((r) => setImmediate(r));

  // Metadata as text, then the image as bytes.
  for (const socket of [a, b]) {
    assert.equal(socket.messages.length, 2);
    assert.equal(JSON.parse(socket.messages[0]).pageWidth, 1280);
    assert.ok(Buffer.isBuffer(socket.messages[1]));
  }

  const acks = page.session.sent.filter((c) => c.method === "Page.screencastFrameAck");
  assert.equal(acks.length, 1, "acked once for the stream, not once per watcher");
  assert.equal(acks[0].params.sessionId, 7);
});

test("metadata is resent only when it changes", async () => {
  // It is the same JSON on every frame of a still page; repeating it would
  // double the message count for nothing.
  const page = fakePage();
  const hub = new ScreencastHub(OPTIONS);
  const socket = fakeSocket();
  await hub.subscribe("p1", page, socket);

  const frame = (scrollOffsetY) => ({
    data: "",
    sessionId: 1,
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: 1280,
      deviceHeight: 800,
      scrollOffsetX: 0,
      scrollOffsetY,
    },
  });

  page.session.emit("Page.screencastFrame", frame(0));
  await new Promise((r) => setImmediate(r));
  page.session.emit("Page.screencastFrame", frame(0));
  await new Promise((r) => setImmediate(r));

  const texts = socket.messages.filter((m) => typeof m === "string");
  assert.equal(texts.length, 1);

  page.session.emit("Page.screencastFrame", frame(240));
  await new Promise((r) => setImmediate(r));
  assert.equal(socket.messages.filter((m) => typeof m === "string").length, 2);
});

test("input is dispatched to the right tab, and dropped for a tab nobody watches", async () => {
  const page = fakePage();
  const hub = new ScreencastHub(OPTIONS);
  await hub.subscribe("p1", page, fakeSocket());

  await hub.dispatch("p1", { type: "mouse", action: "mousePressed", x: 10, y: 20 });
  await hub.dispatch("gone", { type: "mouse", action: "mousePressed", x: 1, y: 1 });

  const clicks = page.session.sent.filter((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(clicks.length, 1);
  assert.deepEqual([clicks[0].params.x, clicks[0].params.y], [10, 20]);
});

test("a named key carries the virtual code Chrome needs to act on it", async () => {
  // Enter without windowsVirtualKeyCode types nothing and submits nothing.
  const page = fakePage();
  const hub = new ScreencastHub(OPTIONS);
  await hub.subscribe("p1", page, fakeSocket());

  await hub.dispatch("p1", { type: "key", action: "keyDown", key: "Enter" });
  const [key] = page.session.sent.filter((c) => c.method === "Input.dispatchKeyEvent");

  assert.equal(key.params.windowsVirtualKeyCode, 13);
});
