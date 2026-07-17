import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-image-route-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;
process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP = "0";
process.env.MODEL_STABLE_API_KEY = "sk-image-route-test";

const { startServer, stopServer } = await import("../index.js");

test("image routes accept multipart references and persist a manageable local library", async () => {
  const server = await startServer({ port: 0 });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#336699" } }).png().toBuffer();
  let upstreamRequest;

  try {
    globalThis.fetch = async (url, init) => {
      upstreamRequest = { url: String(url), init };
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const request = {
      prompt: "use the reference product",
      negativePrompt: "watermark",
      ratio: "1:1",
      resolution: "1k",
      quality: "medium",
      format: "png",
      background: "auto",
      count: 1,
    };
    const form = new FormData();
    form.append("request", JSON.stringify(request));
    form.append("referenceImages", new Blob([png], { type: "image/png" }), "reference.png");
    const generatedResponse = await nativeFetch(`${baseUrl}/api/images/generate`, { method: "POST", body: form });
    const generated = await generatedResponse.json();

    assert.equal(generatedResponse.status, 200);
    assert.equal(upstreamRequest.url, "https://cn.pptoken.cc/v1/images/edits");
    assert.ok(upstreamRequest.init.body instanceof FormData);
    assert.equal(generated.images.length, 1);
    assert.equal(generated.images[0].resolution, "1k");
    assert.equal(generated.images[0].parentImageId, null);
    assert.equal(generated.appliedOptions.mode, "edit");
    assert.ok(Array.isArray(generated.warnings));

    globalThis.fetch = nativeFetch;
    const libraryResponse = await nativeFetch(`${baseUrl}/api/images`);
    const library = await libraryResponse.json();
    assert.equal(libraryResponse.status, 200);
    assert.equal(library.length, 1);
    assert.equal(library[0].id, generated.images[0].id);

    const fileResponse = await nativeFetch(`${baseUrl}${library[0].src}`);
    assert.equal(fileResponse.status, 200);
    assert.equal(fileResponse.headers.get("content-type"), "image/png");
    assert.equal(fileResponse.headers.get("x-content-type-options"), "nosniff");
    assert.ok((await fileResponse.arrayBuffer()).byteLength > 0);

    const favoriteResponse = await nativeFetch(`${baseUrl}/api/images/${library[0].id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isFavorite: true }),
    });
    assert.equal(favoriteResponse.status, 200);
    assert.equal((await favoriteResponse.json()).isFavorite, true);

    const deleteResponse = await nativeFetch(`${baseUrl}/api/images/${library[0].id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 204);
    assert.deepEqual(await (await nativeFetch(`${baseUrl}/api/images`)).json(), []);

    globalThis.fetch = async (url, init) => {
      upstreamRequest = { url: String(url), init };
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
    };
    const textOnlyResponse = await nativeFetch(`${baseUrl}/api/images/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const textOnly = await textOnlyResponse.json();
    assert.equal(textOnlyResponse.status, 200);
    assert.equal(upstreamRequest.url, "https://cn.pptoken.cc/v1/images/generations");
    assert.equal(textOnly.appliedOptions.mode, "generate");

    const editInstruction = "改成白色陶瓷材质";
    const annotationForm = new FormData();
    annotationForm.append("request", JSON.stringify({ ...request, prompt: editInstruction, sourceImageId: textOnly.images[0].id, editMode: "annotation" }));
    annotationForm.append("referenceImages", new Blob([png], { type: "image/png" }), "annotation.png");
    const annotationResponse = await nativeFetch(`${baseUrl}/api/images/generate`, { method: "POST", body: annotationForm });
    const annotation = await annotationResponse.json();
    assert.equal(annotationResponse.status, 200);
    assert.equal(annotation.images[0].prompt, editInstruction);
    assert.doesNotMatch(annotation.images[0].prompt, /局部批注编辑任务/);
    assert.match(String(upstreamRequest.init.body.get("prompt")), /局部批注编辑任务/);
    assert.match(String(upstreamRequest.init.body.get("prompt")), /修改内容：改成白色陶瓷材质/);
    await nativeFetch(`${baseUrl}/api/images/${annotation.images[0].id}`, { method: "DELETE" });
    globalThis.fetch = nativeFetch;
    await nativeFetch(`${baseUrl}/api/images/${textOnly.images[0].id}`, { method: "DELETE" });

    let startUpstream;
    let releaseUpstream;
    const upstreamStarted = new Promise((resolve) => { startUpstream = resolve; });
    const upstreamReleased = new Promise((resolve) => { releaseUpstream = resolve; });
    globalThis.fetch = async () => {
      startUpstream();
      await upstreamReleased;
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
    };
    const firstRequest = nativeFetch(`${baseUrl}/api/images/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, prompt: "first concurrent request" }),
    });
    await upstreamStarted;
    const blockedResponse = await nativeFetch(`${baseUrl}/api/images/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, prompt: "second concurrent request" }),
    });
    assert.equal(blockedResponse.status, 409);
    releaseUpstream();
    const firstResult = await (await firstRequest).json();
    globalThis.fetch = nativeFetch;
    await nativeFetch(`${baseUrl}/api/images/${firstResult.images[0].id}`, { method: "DELETE" });

    let startDisconnectedUpstream;
    let releaseDisconnectedUpstream;
    const disconnectedUpstreamStarted = new Promise((resolve) => { startDisconnectedUpstream = resolve; });
    const disconnectedUpstreamReleased = new Promise((resolve) => { releaseDisconnectedUpstream = resolve; });
    globalThis.fetch = async () => {
      startDisconnectedUpstream();
      await disconnectedUpstreamReleased;
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
    };
    const controller = new AbortController();
    const disconnectedRequest = nativeFetch(`${baseUrl}/api/images/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, prompt: "persist after client disconnect" }),
      signal: controller.signal,
    }).catch((error) => error);
    await disconnectedUpstreamStarted;
    controller.abort();
    releaseDisconnectedUpstream();
    await disconnectedRequest;
    globalThis.fetch = nativeFetch;
    let disconnectedRecord;
    for (let attempt = 0; attempt < 50 && !disconnectedRecord; attempt += 1) {
      const items = await (await nativeFetch(`${baseUrl}/api/images`)).json();
      disconnectedRecord = items.find((item) => item.prompt === "persist after client disconnect");
      if (!disconnectedRecord) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(disconnectedRecord, "the billed result should persist after the client disconnects");
    await nativeFetch(`${baseUrl}/api/images/${disconnectedRecord.id}`, { method: "DELETE" });

    const invalidForm = new FormData();
    invalidForm.append("request", JSON.stringify(request));
    invalidForm.append("referenceImages", new Blob(["not an image"], { type: "text/plain" }), "reference.txt");
    const invalidResponse = await nativeFetch(`${baseUrl}/api/images/generate`, { method: "POST", body: invalidForm });
    const invalid = await invalidResponse.json();
    assert.equal(invalidResponse.status, 400);
    assert.equal(invalid.error.code, "IMAGE_REFERENCE_TYPE_INVALID");
  } finally {
    globalThis.fetch = nativeFetch;
    await stopServer(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
