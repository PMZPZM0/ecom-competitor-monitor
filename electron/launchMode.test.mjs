import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearLaunchMode,
  DESKTOP_MODE,
  launchModeFromArgs,
  normalizeLaunchMode,
  readLaunchMode,
  shouldResetLaunchMode,
  WEB_MODE,
  writeLaunchMode,
} from "./launchMode.mjs";

test("launch mode arguments accept desktop and browser aliases", () => {
  assert.equal(launchModeFromArgs(["app", "--launch-mode=desktop"]), DESKTOP_MODE);
  assert.equal(launchModeFromArgs(["app", "--launch-mode=app"]), DESKTOP_MODE);
  assert.equal(launchModeFromArgs(["app", "--launch-mode=web"]), WEB_MODE);
  assert.equal(launchModeFromArgs(["app", "--launch-mode=browser"]), WEB_MODE);
  assert.equal(launchModeFromArgs(["app", "--launch-mode=invalid"]), null);
  assert.equal(shouldResetLaunchMode(["app", "--reset-launch-mode"]), true);
  assert.equal(shouldResetLaunchMode(["app"]), false);
  assert.equal(normalizeLaunchMode("APP"), DESKTOP_MODE);
  assert.equal(normalizeLaunchMode(" unknown "), null);
});

test("launch preference persists, ignores corruption, and can be cleared", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ecom-launch-mode-"));
  const filePath = path.join(directory, "launch-mode.json");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(readLaunchMode(filePath), null);
  assert.equal(writeLaunchMode(filePath, WEB_MODE), WEB_MODE);
  assert.equal(readLaunchMode(filePath), WEB_MODE);
  assert.throws(() => writeLaunchMode(filePath, "invalid"), /Unsupported launch mode/);
  assert.equal(readLaunchMode(filePath), WEB_MODE);
  fs.writeFileSync(filePath, "not-json", "utf8");
  assert.equal(readLaunchMode(filePath), null);
  fs.writeFileSync(filePath, JSON.stringify({ mode: "browser" }), "utf8");
  assert.equal(readLaunchMode(filePath), WEB_MODE);
  writeLaunchMode(filePath, DESKTOP_MODE);
  clearLaunchMode(filePath);
  assert.equal(readLaunchMode(filePath), null);
});
