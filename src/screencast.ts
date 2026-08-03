/**
 * Live view of one tab, over CDP.
 *
 * noVNC serves the whole X *screen*, which on a browser several clients share
 * means the watcher sees whichever window happens to be raised — silently the
 * wrong thing — and on a phone means panning around a desktop hunting for a
 * form. `Page.startScreencast` is per *target*: one Chrome, one profile, N
 * tabs, N independent streams, input dispatched per tab.
 *
 * What makes this worth building rather than adopting a remote desktop: we
 * also *drive* this browser, so the viewer can ask where an element is and
 * frame it (see `elementBounds`). A generic VNC can never do that.
 *
 * Two details that are not optional:
 *
 *   - **Frames must be acked.** Chrome sends the next frame only once the last
 *     is acknowledged, so the ack doubles as backpressure: acking after the
 *     write means a slow client throttles itself instead of growing a backlog.
 *   - **One stream, many watchers.** Subscribers are refcounted per tab. A
 *     second operator opening a view must not restart or disturb the first.
 */

import type { CDPSession, Page } from "playwright-core";
import type { Protocol } from "playwright-core/types/protocol";
import type { WebSocket } from "ws";

type ScreencastFrame = Protocol.Page.screencastFramePayload;

export interface ScreencastOptions {
  quality: number;
  maxWidth: number;
  maxHeight: number;
}

/**
 * What the client needs to turn a click on a canvas into a click on the page.
 *
 * Sent as a JSON text frame whenever it changes; frames themselves are binary,
 * because base64 over the wire would cost a third again for nothing.
 */
export interface FrameMetadata {
  type: "metadata";
  /** CSS pixels of the page viewport. */
  pageWidth: number;
  pageHeight: number;
  /** Where the page is scrolled to, so an element's page rect maps to the view. */
  offsetTop: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  deviceScaleFactor: number;
}

/** Input arrives on the same socket as the frames go out. */
export type InputMessage =
  | { type: "mouse"; action: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "key"; action: "keyDown" | "keyUp" | "char"; key?: string; code?: string; text?: string; modifiers?: number }
  | { type: "touch"; action: "touchStart" | "touchMove" | "touchEnd"; x: number; y: number }
  /**
   * Paste, as one operation.
   *
   * A clipboard blob sent as N char events is N round trips and loses newlines
   * on some editors; `Input.insertText` puts it in as a single input event,
   * which is also what the page's own paste handler expects to see.
   */
  | { type: "text"; text: string }
  /**
   * Lay the *page* out for the watcher's screen.
   *
   * The reason a remote desktop is unusable on a phone is not the pixels, it is
   * that a 1280-wide page scaled into 350 makes every field a few pixels tall —
   * so aiming a finger at one is luck. Emulating the watcher's viewport makes
   * the destination render its own mobile layout, at which point the frame is
   * 1:1 and a tap lands where it looks.
   */
  | { type: "viewport"; width: number; height: number; deviceScaleFactor?: number; mobile?: boolean };

interface Stream {
  session: CDPSession;
  subscribers: Set<WebSocket>;
  lastMetadata: string | null;
  /** The layout currently forced on the page, if a watcher asked for one. */
  viewport: { width: number; height: number } | null;
}

/** Chrome's own key naming needs a `windowsVirtualKeyCode` for the keys that do things. */
const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

export class ScreencastHub {
  private readonly streams = new Map<string, Stream>();

  constructor(
    private readonly options: ScreencastOptions,
    /** Told whenever a tab gains or loses a watcher, so it is not collected mid-read. */
    private readonly onWatched?: (pageId: string, watching: boolean) => void
  ) {}

  /** How many sockets are watching a tab. Exposed for tests and for /api/pages. */
  watchers(pageId: string): number {
    return this.streams.get(pageId)?.subscribers.size ?? 0;
  }

  async subscribe(pageId: string, page: Page, socket: WebSocket): Promise<void> {
    let stream = this.streams.get(pageId);

    if (!stream) {
      const session = await page.context().newCDPSession(page);
      stream = { session, subscribers: new Set(), lastMetadata: null, viewport: null };
      this.streams.set(pageId, stream);

      session.on("Page.screencastFrame", (frame) => {
        void this.onFrame(pageId, frame);
      });

      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: this.options.quality,
        maxWidth: this.options.maxWidth,
        maxHeight: this.options.maxHeight,
        everyNthFrame: 1,
      });
      this.onWatched?.(pageId, true);
    }

    stream.subscribers.add(socket);
    // A late joiner should not sit on a blank canvas until the page next moves.
    if (stream.lastMetadata) socket.send(stream.lastMetadata);

    socket.on("close", () => void this.unsubscribe(pageId, socket));
    socket.on("error", () => void this.unsubscribe(pageId, socket));
  }

  async unsubscribe(pageId: string, socket: WebSocket): Promise<void> {
    const stream = this.streams.get(pageId);
    if (!stream) return;

    stream.subscribers.delete(socket);
    if (stream.subscribers.size > 0) return;

    // Last watcher out turns the lights off — a stream nobody reads still costs
    // Chrome an encode per frame.
    this.streams.delete(pageId);
    this.onWatched?.(pageId, false);
    try {
      await stream.session.send("Page.stopScreencast");
      // Hand the page back the way it was found: a tab left emulating a phone
      // would lay out differently for the automation that comes after.
      if (stream.viewport) await stream.session.send("Emulation.clearDeviceMetricsOverride");
    } catch {
      /* the tab may already be gone */
    }
    await stream.session.detach().catch(() => {});
  }

  private async onFrame(pageId: string, frame: ScreencastFrame): Promise<void> {
    const stream = this.streams.get(pageId);
    if (!stream) return;

    const metadata: FrameMetadata = {
      type: "metadata",
      pageWidth: frame.metadata.deviceWidth,
      pageHeight: frame.metadata.deviceHeight,
      offsetTop: frame.metadata.offsetTop,
      scrollOffsetX: frame.metadata.scrollOffsetX,
      scrollOffsetY: frame.metadata.scrollOffsetY,
      deviceScaleFactor: frame.metadata.pageScaleFactor,
    };
    const encoded = JSON.stringify(metadata);

    const image = Buffer.from(frame.data, "base64");
    for (const socket of stream.subscribers) {
      if (socket.readyState !== 1) continue;
      if (encoded !== stream.lastMetadata) socket.send(encoded);
      socket.send(image, { binary: true });
    }
    stream.lastMetadata = encoded;

    /**
     * Acked after the writes, never before: Chrome withholds the next frame
     * until this returns, so a slow consumer slows the stream down instead of
     * queueing megabytes of stale JPEG behind itself.
     */
    try {
      await stream.session.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    } catch {
      /* stream torn down mid-flight */
    }
  }

  /** Turn a client message into a CDP input event on the right tab. */
  async dispatch(pageId: string, message: InputMessage): Promise<void> {
    const stream = this.streams.get(pageId);
    if (!stream) return;
    const { session } = stream;

    switch (message.type) {
      case "mouse":
        await session.send("Input.dispatchMouseEvent", {
          type: message.action,
          x: message.x,
          y: message.y,
          button: message.button ?? "left",
          buttons: message.action === "mouseReleased" ? 0 : 1,
          clickCount: message.clickCount ?? (message.action === "mouseMoved" ? 0 : 1),
          modifiers: message.modifiers ?? 0,
        });
        return;

      case "wheel":
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: message.x,
          y: message.y,
          deltaX: message.deltaX,
          deltaY: message.deltaY,
        });
        return;

      case "key": {
        // `char` carries the typed character; keyDown/keyUp carry the key
        // itself. Sending both is what makes a real text field fill in.
        const virtual = message.key ? VIRTUAL_KEYS[message.key] : undefined;
        await session.send("Input.dispatchKeyEvent", {
          type: message.action,
          key: message.key,
          code: message.code,
          text: message.text,
          unmodifiedText: message.text,
          windowsVirtualKeyCode: virtual,
          nativeVirtualKeyCode: virtual,
          modifiers: message.modifiers ?? 0,
        });
        return;
      }

      case "touch":
        await session.send("Input.dispatchTouchEvent", {
          type: message.action,
          touchPoints:
            message.action === "touchEnd" ? [] : [{ x: message.x, y: message.y }],
        });
        return;

      case "text":
        await session.send("Input.insertText", { text: message.text });
        return;

      case "viewport": {
        const width = Math.max(320, Math.round(message.width));
        const height = Math.max(240, Math.round(message.height));
        if (width === stream.viewport?.width && height === stream.viewport?.height) return;
        stream.viewport = { width, height };
        await session.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: message.deviceScaleFactor ?? 1,
          mobile: message.mobile ?? false,
        });
        /**
         * Chrome emits a frame when the page *changes*, and a resize on a still
         * page is not reliably a change — so a viewer that just asked for a new
         * layout would sit looking at a blank canvas until something moved.
         *
         * Restarting the screencast forces one. Twice, spaced: the first often
         * lands mid-relayout and captures a page that has not painted yet, and
         * a still page will not send another by itself.
         */
        for (const delay of [150, 700]) {
          setTimeout(() => void this.forceFrame(pageId), delay);
        }
        return;
      }
    }
  }

  /**
   * Ask Chrome for a frame it would not otherwise send.
   *
   * Restarting the screencast is the only way to do that — there is no
   * "capture now" — and it is harmless: the stream carries on afterwards.
   */
  private async forceFrame(pageId: string): Promise<void> {
    const stream = this.streams.get(pageId);
    if (!stream) return;
    try {
      await stream.session.send("Page.startScreencast", {
        format: "jpeg",
        quality: this.options.quality,
        maxWidth: this.options.maxWidth,
        maxHeight: this.options.maxHeight,
        everyNthFrame: 1,
      });
    } catch {
      /* the tab went while we waited */
    }
  }

  /** Everything, for shutdown. */
  async stopAll(): Promise<void> {
    for (const [pageId, stream] of [...this.streams]) {
      for (const socket of stream.subscribers) socket.close();
      this.streams.delete(pageId);
      await stream.session.send("Page.stopScreencast").catch(() => {});
      await stream.session.detach().catch(() => {});
    }
  }
}

/**
 * Where an element is, in page coordinates.
 *
 * The point of this endpoint: on a phone, "zoom to the captcha" beats panning
 * around a 1280×800 desktop looking for a checkbox — and only a system that
 * drives the browser as well as watching it can answer the question.
 */
export async function elementBounds(
  page: Page,
  selector: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const handle = await page.$(selector);
  if (!handle) return null;
  const box = await handle.boundingBox();
  await handle.dispose();
  return box;
}
