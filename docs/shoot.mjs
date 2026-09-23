/**
 * One-off screenshot helper driving Edge over the Chrome DevTools Protocol
 * directly, since this Edge build's `--screenshot` CLI flag fails outright
 * ("Multiple targets are not supported in headless mode") regardless of
 * flags, profile, or running processes. CDP is the same mechanism
 * Puppeteer/Playwright use under the hood, and it works here where the CLI
 * flag doesn't. Not part of the shipped project, just a way to get real
 * evidence images into docs/.
 */
import { WebSocket } from "ws";
import { writeFileSync } from "node:fs";

const CDP = "http://localhost:9333";
const [, , url, outPath, scrollY = "0"] = process.argv;

async function main() {
  const versionRes = await fetch(`${CDP}/json/version`);
  const { webSocketDebuggerUrl } = await versionRes.json();

  const browserWs = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browserWs.once("open", resolve);
    browserWs.once("error", reject);
  });

  let id = 0;
  const pending = new Map();
  browserWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  function send(ws, method, params = {}) {
    const thisId = ++id;
    return new Promise((resolve) => {
      pending.set(thisId, resolve);
      ws.send(JSON.stringify({ id: thisId, method, params }));
    });
  }

  const target = await send(browserWs, "Target.createTarget", { url: "about:blank" });
  const targetId = target.result.targetId;
  const attach = await send(browserWs, "Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attach.result.sessionId;

  function sendSession(method, params = {}) {
    const thisId = ++id;
    return new Promise((resolve) => {
      pending.set(thisId, resolve);
      browserWs.send(JSON.stringify({ id: thisId, method, params, sessionId }));
    });
  }

  await sendSession("Page.enable");
  await sendSession("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sendSession("Page.navigate", { url });

  // Wait for the real page to actually load and settle (animations, live
  // API calls to /api/consensus, the preloader lift), not just the
  // navigation event.
  await new Promise((r) => setTimeout(r, 9000));

  if (Number(scrollY) > 0) {
    await sendSession("Runtime.evaluate", { expression: `window.scrollTo(0, ${scrollY})` });
    await new Promise((r) => setTimeout(r, 1200));
  }

  const shot = await sendSession("Page.captureScreenshot", { format: "png" });
  writeFileSync(outPath, Buffer.from(shot.result.data, "base64"));
  console.log(`wrote ${outPath}`);

  await sendSession("Target.closeTarget", { targetId });
  browserWs.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
