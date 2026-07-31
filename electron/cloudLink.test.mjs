import assert from "node:assert/strict";
import test from "node:test";
import { cloudLinkFromArgs, parseCloudLink } from "./cloudLink.mjs";

test("cloud sync protocol links are extracted from desktop launch arguments", () => {
  const link = "ecom-monitor://cloud-sync?endpoint=https%3A%2F%2Fjvspp.cloud&code=DEVICE-123";
  assert.equal(cloudLinkFromArgs(["EcomMonitor.exe", "--launch-mode=desktop", link]), link);
  assert.equal(cloudLinkFromArgs(["EcomMonitor.exe", "ECOM-MONITOR://cloud-sync?code=UPPER"]), "ECOM-MONITOR://cloud-sync?code=UPPER");
  assert.equal(cloudLinkFromArgs(["EcomMonitor.exe", "https://jvspp.cloud"]), null);
  assert.equal(cloudLinkFromArgs(null), null);
});

test("cloud sync protocol links decode the endpoint and device code", () => {
  assert.deepEqual(
    parseCloudLink("ecom-monitor://cloud-sync?endpoint=https%3A%2F%2Fjvspp.cloud&code=DEVICE-123"),
    { endpoint: "https://jvspp.cloud", code: "DEVICE-123" },
  );
  assert.deepEqual(parseCloudLink("ecom-monitor://cloud-sync?code=%20DEVICE-456%20"), {
    endpoint: "",
    code: "DEVICE-456",
  });
});

test("cloud sync protocol links reject malformed or unrelated input", () => {
  assert.equal(parseCloudLink("ecom-monitor://cloud-sync?endpoint=https%3A%2F%2Fjvspp.cloud"), null);
  assert.equal(parseCloudLink("ecom-monitor://other?code=DEVICE-123"), null);
  assert.equal(parseCloudLink("https://jvspp.cloud/?code=DEVICE-123"), null);
  assert.equal(parseCloudLink("not-a-link"), null);
  assert.equal(parseCloudLink(null), null);
});
