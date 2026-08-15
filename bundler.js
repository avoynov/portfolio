/**
 * Bundler runtime — unpacks compressed assets from inline manifest data,
 * fetches the template HTML, and renders the final document.
 */

// --- Error Handling -----------------------------------------------------------

/**
 * Global error handler. Persists across replaceWith since it's on window.
 */
function installErrorHandler() {
  window.addEventListener("error", (e) => {
    if (!e.message && !e.error && e.target && e.target !== window) {
      console.warn("[bundle] resource failed to load:", e.target.tagName, String(e.target.src || e.target.href || ''));
      return;
    }
    var p = document.body || document.documentElement;
    var d = document.getElementById("__bundler_err") || p.appendChild(document.createElement("div"));
    d.id = "__bundler_err";
    d.style.cssText = "position:fixed;bottom:12px;left:12px;right:12px;font:12px/1.4 ui-monospace,monospace;background:#2a1215;color:#ff8a80;padding:10px 14px;border-radius:8px;border:1px solid #5c2b2e;z-index:99999;white-space:pre-wrap;max-height:40vh;overflow:auto";
    d.textContent = (d.textContent ? d.textContent + String.fromCharCode(10) : '') +
      "[bundle] " + (e.message || e.type) +
      (e.filename ? " (" + e.filename.slice(0, 60) + ":" + e.lineno + ")" : "");
  }, true);
}

//---- Asset Decoding -----------------------------------------------------------

const FONT_MIME = /^(font[/]|application[/](x-)?font-|application[/]vnd\.ms-fontobject)/i;
const MIME_TOKEN = /^[\w.+-]+[/][\w.+-]+$/;

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Decode and decompress all manifest assets into blob URLs
 */
async function decodeAssets(manifest, pageSet, pageTexts, blobUrls, resourceBlobs, setStatus) {
  const uuids = Object.keys(manifest);
  setStatus("Unpacking " + uuids.length + " assets...");

  await Promise.all(uuids.map(async (uuid) => {
    const entry = manifest[uuid];
    try {
      const binaryStr = atob(entry.data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      let finalBytes = bytes;
      if (entry.compressed) {
        if (typeof DecompressionStream !== "undefined") {
          const ds = new DecompressionStream("gzip");
          const writer = ds.writable.getWriter();
          const reader = ds.readable.getReader();
          writer.write(bytes);
          writer.close();
          const chunks = [];
          let totalLen = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalLen += value.length;
          }
          finalBytes = new Uint8Array(totalLen);
          let offset = 0;
          for (const chunk of chunks) { finalBytes.set(chunk, offset); offset += chunk.length; }
        } else {
          console.warn("DecompressionStream not available, asset " + uuid + " may not render");
        }
      }

      if (pageSet.has(uuid)) {
        pageTexts[uuid] = new TextDecoder().decode(finalBytes);
        return;
      }
      if (FONT_MIME.test(entry.mime) && MIME_TOKEN.test(entry.mime)) {
        blobUrls[uuid] = "data:" + entry.mime + ";base64," +
          (entry.compressed ? toBase64(finalBytes) : entry.data);
      } else {
        const blob = new Blob([finalBytes], { type: entry.mime });
        blobUrls[uuid] = URL.createObjectURL(blob);
        resourceBlobs[blobUrls[uuid]] = blob;
      }
    } catch (err) {
      console.error("Failed to decode asset " + uuid + ":", err);
      const blob = new Blob([], { type: entry.mime });
      blobUrls[uuid] = URL.createObjectURL(blob);
      resourceBlobs[blobUrls[uuid]] = blob;
    }
  }));

  return uuids;
}

// --- Page Relay Protocol -----------------------------------------------------------------

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const OWN_TARGET = /^https?:[/][/]/.test(window.origin || "")
  ? window.origin
  : "*";

function trustedOrigin(e) {
  if (e.origin === window.origin) return true;
  return (
    (e.origin === "null" &&
      (window.origin === "file://" ||
        window.location.protocol === "file:")) ||
    (/^file:/.test(e.origin) && window.origin === "null")
  );
}

function mountPage(el, frag, text, resourceBlobs) {
  const pageBlob = new Blob([text], { type: "text/html" });
  const u = URL.createObjectURL(pageBlob);
  resourceBlobs[u] = pageBlob;
  el.src = u + frag;
}

function deliverPage(uuid, text, pendingFrames, pendingRelays, resourceBlobs) {
  const frames = pendingFrames[uuid];
  delete pendingFrames[uuid];
  if (frames) for (const f of frames) mountPage(f.el, f.frag, text, resourceBlobs);
  const relays = pendingRelays[uuid];
  delete pendingRelays[uuid];
  if (relays) {
    for (const cw of relays) {
      try { cw.postMessage({ __bundler_page: uuid, __bundler_text: text }, OWN_TARGET); } catch (err) { /* gone */ }
    }
  }
}

function ownFrameWindows() {
  const out = [];
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    try { if (f.contentWindow) out.push(f.contentWindow); } catch (err) { /* detached */ }
  }
  return out;
}

function installPageRelay(pageTexts, isPageRoot, pendingFrames, pendingRelays, resourceBlobs) {
  window.addEventListener("message", function (e) {
    const d = e.data;
    if (!d || typeof d !== "object" || !e.source) return;
    if (!trustedOrigin(e)) return;

    if (typeof d.__bundler_need === "string" && UUID_SHAPE.test(d.__bundler_need)) {
      if (ownFrameWindows().indexOf(e.source) < 0) return;
      const uuid = d.__bundler_need;
      const text = pageTexts[uuid];
      if (typeof text === "string") {
        try { e.source.postMessage({ __bundler_page: uuid, __bundler_text: text }, OWN_TARGET); } catch (err) { /* gone */ }
        return;
      }
      if (isPageRoot || window.parent === window) return;
      const waiting = pendingRelays[uuid];
      if (waiting) {
        if (waiting.indexOf(e.source) < 0) waiting.push(e.source);
        return;
      }
      if (Object.keys(pendingRelays).length >= 128) return;
      pendingRelays[uuid] = [e.source];
      window.parent.postMessage({ __bundler_need: uuid }, OWN_TARGET);
    } else if (
      typeof d.__bundler_page === "string" &&
      UUID_SHAPE.test(d.__bundler_page) &&
      typeof d.__bundler_text === "string"
    ) {
      if (e.source !== window.parent || window.parent === window) return;
      if (!(d.__bundler_page in pendingFrames) && !(d.__bundler_page in pendingRelays)) return;
      deliverPage(d.__bundler_page, d.__bundler_text, pendingFrames, pendingRelays, resourceBlobs);
    }
  });
}

function resolvePageFrames(pageTexts, isPageRoot, pendingFrames, resourceBlobs) {
  const MARKER = /^about:blank#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(#.*)?$/;
  const needed = [];
  for (const el of Array.from(document.querySelectorAll("iframe"))) {
    const m = MARKER.exec(el.getAttribute("src") || "");
    if (!m) continue;
    const text = pageTexts[m[1]];
    if (typeof text === "string") {
      mountPage(el, m[2] || "", text, resourceBlobs);
    } else if (window.parent !== window && !isPageRoot) {
      const had = pendingFrames[m[1]];
      (pendingFrames[m[1]] = had || []).push({ el: el, frag: m[2] || "" });
      if (!had) needed.push(m[1]);
    }
  }
  for (const uuid of needed) {
    window.parent.postMessage({ __bundler_need: uuid }, OWN_TARGET);
  }
}

// --- Template Rendering -------------------------------------------------------

function buildResourceMap(blobUrls) {
  const extResEl = document.querySelector('script[type="__bundler/ext_resources"]');
  const extResources = extResEl ? JSON.parse(extResEl.textContent) : [];
  const resourceMap = {};
  for (const entry of extResources) {
    if (blobUrls[entry.uuid]) resourceMap[entry.id] = blobUrls[entry.uuid];
  }
  return resourceMap;
}

function prepareTemplate(template, uuids, pageSet, blobUrls, resourceMap) {
  for (const uuid of uuids) {
    if (pageSet.has(uuid)) continue;
    template = template.split(uuid).join(blobUrls[uuid]);
  }

  template = template.replace(/\s+integrity="[^"]*"/gi, "").replace(/\s+crossorigin="[^"]*"/gi, "");

  const resourceScript = "<script>window.__resources = " +
    JSON.stringify(resourceMap).replace(/<\//g, "<\\/") +
    ";</" + "script>";
  const headOpen = template.match(/<head[^>]*>/i);
  if (headOpen) {
    const i = headOpen.index + headOpen[0].length;
    template = template.slice(0, i) + resourceScript + template.slice(i);
  }

  return template;
}

function swapDocument(template) {
  const doc = new DOMParser().parseFromString(template, "text/html");
  document.documentElement.replaceWith(doc.documentElement);
}

async function activateScripts(resourceBlobs) {
  const dead = Array.from(document.scripts);
  for (const old of dead) {
    const s = document.createElement("script");
    for (const a of old.attributes) s.setAttribute(a.name, a.value);
    s.textContent = old.textContent;
    if ((s.type === "text/babel" || s.type === "text/jsx") && s.src) {
      const pre = resourceBlobs[s.src.split("#")[0]];
      s.textContent = pre ? await pre.text() : await (await fetch(s.src)).text();
      s.removeAttribute("src");
    }
    const p = s.src ? new Promise(function (r) { s.onload = s.onerror = r; }) : null;
    old.replaceWith(s);
    if (p) await p;
  }
  if (window.Babel && typeof window.Babel.transformScriptTags === "function") {
    window.Babel.transformScriptTags();
  }
}

// --- Entry Point --------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async function () {
  if (this.location.hash) {
    const withoutHash = this.location.href.replace(this.location.hash, "");
    history.replaceState({}, "", withoutHash);
    console.log("Stripped hash by assigning new url:", withoutHash);
  }

  const loading = document.getElementById("__bundler_loading");
  function setStatus(msg) { if (loading) loading.textContent = msg; }

  installErrorHandler();

  try {
    const manifestEl = document.querySelector('script[type="__bundler/manifest"]');
    if (!manifestEl) {
      setStatus("Error: missing bundle data");
      console.error("[bundler] Missing manifest script tag");
      return;
    }

    const manifest = JSON.parse(manifestEl.textContent);

    // Load template from external file.
    const templateResp = await fetch("template.html");
    if (!templateResp.ok) {
      setStatus("Error: failed to load template");
      console.error("[bundler] Failed to fetch template.html:", templateResp.status);
      return;
    }
    let template = await templateResp.text();

    // Page order determines which assets are nested page bundles.
    const pageOrderEl = document.querySelector('script[type="__bundler/page_order"]');
    const pageOrder = pageOrderEl ? JSON.parse(pageOrderEl.textContent) : [];
    const pageSet = new Set(pageOrder);
    const pageTexts = {};

    const isPageRoot = pageOrder.length > 0;
    const blobUrls = {};
    const resourceBlobs = {};
    const pendingFrames = {};
    const pendingRelays = {};

    installPageRelay(pageTexts, isPageRoot, pendingFrames, pendingRelays, resourceBlobs);

    const uuids = await decodeAssets(manifest, pageSet, pageTexts, blobUrls, resourceBlobs, setStatus);

    const resourceMap = buildResourceMap(blobUrls);

    window.__resourceBlobs = resourceBlobs;

    setStatus("Rendering...");

    template = prepareTemplate(template, uuids, pageSet, blobUrls, resourceMap);
    swapDocument(template);

    resolvePageFrames(pageTexts, isPageRoot, pendingFrames, resourceBlobs);

    await activateScripts(resourceBlobs);

  } catch (err) {
    setStatus("Error unpacking: " + err.message);
    console.error("Bundle unpack error:", err);
  }
});
