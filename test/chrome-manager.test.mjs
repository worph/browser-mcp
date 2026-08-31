import assert from "node:assert/strict";
import test from "node:test";
import { isOurBrowserProcess } from "../dist/chrome-manager.js";

/**
 * Recognising a Chrome we lost track of.
 *
 * Every relaunch spawns onto a fixed CDP port and a fixed profile directory, so a browser
 * process the manager is no longer tracking is not merely untidy — it holds the port the next
 * one needs, and Chrome's second instance quietly gives up its own debugging socket rather
 * than failing. One box accumulated four of them over eight days: the manager tracked the
 * newest, every CDP call reached the oldest, and every call timed out.
 */

const PORT = 9222;
const DIR = "/data/chrome-profile";
const cmd = (...args) => args;

const browser = [
  "/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome",
  `--remote-debugging-port=${PORT}`,
  "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${DIR}`,
  "--no-sandbox",
  "about:blank",
];

test("the browser process on our port and our profile is a stray", () => {
  assert.equal(isOurBrowserProcess(browser, PORT, DIR), true);
});

/**
 * Renderers, the GPU process and the utility services all carry the same `--user-data-dir`.
 * They are not strays: they belong to a browser process and die with it, so killing them
 * individually would only destabilise a Chrome that is working.
 */
test("its children are not, however much of the command line they share", () => {
  for (const type of ["renderer", "gpu-process", "utility", "zygote"]) {
    const child = cmd(browser[0], `--type=${type}`, `--user-data-dir=${DIR}`, `--remote-debugging-port=${PORT}`);
    assert.equal(isOurBrowserProcess(child, PORT, DIR), false, type);
  }
});

/** Matches are exact, so a neighbouring profile or port is somebody else's business. */
test("another profile or another port is not ours to kill", () => {
  assert.equal(isOurBrowserProcess(cmd(browser[0], `--remote-debugging-port=${PORT}`, "--user-data-dir=/data/other"), PORT, DIR), false);
  assert.equal(isOurBrowserProcess(cmd(browser[0], "--remote-debugging-port=92220", `--user-data-dir=${DIR}`), PORT, DIR), false);
  assert.equal(isOurBrowserProcess(cmd(browser[0], `--user-data-dir=${DIR}-old`, `--remote-debugging-port=${PORT}`), PORT, DIR), false);
});

/** A Chrome with no debugging port is not on the socket we are trying to reclaim. */
test("a browser with no CDP port is not a stray", () => {
  assert.equal(isOurBrowserProcess(cmd(browser[0], `--user-data-dir=${DIR}`), PORT, DIR), false);
});

test("and neither is anything else on the box", () => {
  assert.equal(isOurBrowserProcess(cmd("/usr/bin/python3", "/usr/bin/supervisord"), PORT, DIR), false);
  assert.equal(isOurBrowserProcess([""], PORT, DIR), false);
});
