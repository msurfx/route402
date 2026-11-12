/*
 * Aomi chat on the Routex402 home page. ES module, no build step.
 *
 * Flow:
 *   1. The visitor signs in to the Aomi widget with a Solana wallet.
 *   2. They tell the agent what to do on-chain.
 *   3. This module watches the wallet on-chain and, when a new confirmed
 *      transaction lands, reports it to the Routex402 seller API, which
 *      verifies it against the chain and logs it to the live feed.
 *   4. The side panel turns into the visitor's agent card: wallet, app id,
 *      recent actions, and a Telegram / Aomi Chat handoff with a QR code.
 *
 * Page config (set in index.html): AOMI_APPLICATION_ID, AOMI_BASE_URL,
 * AOMI_CHAT_URL, AOMI_TELEGRAM_BOT, AOMI_SOLANA_RPCS, SELLER_URL.
 */
const WIDGET_VERSION = "4.0.2";
// React comes from the page's import map so the widget and this module share one copy.
// @assistant-ui/tap is pinned: esm.sh otherwise resolves two versions, which loops in React's store hook.
const ESM_QUERY = "?external=react,react-dom&deps=@assistant-ui/tap@0.9.3";
const POLL_MS = 8000;

const cfg = {
  applicationId: String(window.AOMI_APPLICATION_ID || "").trim(),
  baseUrl: String(window.AOMI_BASE_URL || "https://chat.aomi.dev").replace(/\/+$/, ""),
  chatUrl: String(window.AOMI_CHAT_URL || "https://chat.aomi.dev").replace(/\/+$/, ""),
  telegramBot: String(window.AOMI_TELEGRAM_BOT || "").replace(/^@/, "").trim(),
  rpcs: window.AOMI_SOLANA_RPCS || { "solana:devnet": "https://api.devnet.solana.com" },
  sellerUrl: String(window.SELLER_URL || "http://localhost:4021").replace(/\/+$/, ""),
};

const chatRoot = document.getElementById("aomi-chat");
const panelRoot = document.getElementById("aomi-agent-panel");
if (!chatRoot || !panelRoot) throw new Error("aomi.js: #aomi-chat and #aomi-agent-panel are required");

/* ---------- helpers ---------- */

function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) {
    if (k === "class") node.className = attrs[k];
    else if (k === "text") node.textContent = attrs[k];
    else node.setAttribute(k, attrs[k]);
  }
  for (const kid of kids) if (kid != null) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
}
function shortKey(k) { return k && k.length > 12 ? k.slice(0, 4) + "..." + k.slice(-4) : k || ""; }
function clusterQuery(cluster) { return cluster === "solana:mainnet" ? "" : "?cluster=" + (cluster || "solana:devnet").split(":")[1]; }
function solscanTx(sig, cluster) { return "https://solscan.io/tx/" + sig + clusterQuery(cluster); }
function solscanAcct(k, cluster) { return "https://solscan.io/account/" + k + clusterQuery(cluster); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function showWait(message, isError) {
  chatRoot.replaceChildren(el("div", { class: "aomi-wait", role: "status", "aria-live": "polite" },
    isError ? null : el("span", { class: "spin", "aria-hidden": "true" }),
    el("span", { class: isError ? "err" : "", text: message })));
}

/* esm.sh builds a package on first request and answers 408 until it is cached. */
async function importWithRetry(url, label, tries) {
  let lastErr;
  for (let i = 0; i < (tries || 4); i++) {
    try { return await import(url); } catch (err) {
      lastErr = err;
      showWait("Loading " + label + " (attempt " + (i + 2) + ")...");
      await sleep(3000 * (i + 1));
    }
  }
  throw lastErr;
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error("rpc " + res.status);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || "rpc error");
  return body.result;
}

async function seller(path, init) {
  const res = await fetch(cfg.sellerUrl + path, Object.assign({ headers: { "content-type": "application/json" } }, init || {}));
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

function qrSvg(text) {
  if (!window.qrcode) return null;
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const wrap = el("div", { class: "aomi-qr", "aria-label": "QR code: " + text });
    wrap.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    return wrap;
  } catch { return null; }
}

/* ---------- theme: follow the page's data-theme toggle ---------- */

function pageTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "dark" || t === "light" ? t : "system";
}

/* ---------- mount ---------- */

async function main() {
  if (!cfg.applicationId) {
    chatRoot.replaceChildren(el("div", { class: "aomi-setup" },
      el("p", { class: "h3", text: "Aomi chat is almost here" }),
      el("p", { class: "muted", text: "The Routex402 App is being activated on Aomi. Once it is live, this card becomes a chat where you sign in with your Solana wallet and tell the agent what to do on-chain." }),
      el("p", { class: "muted" }, "Operators: set ", el("code", { text: "window.AOMI_APPLICATION_ID" }), " in index.html to the activated App's Application ID.")));
    renderPanel(panelRoot, { stage: 0 });
    return;
  }

  showWait("Loading Aomi...");
  const widgetUrl = "https://esm.sh/@aomi-labs/widget@" + WIDGET_VERSION + ESM_QUERY;
  const hostUrl = "https://esm.sh/@aomi-labs/widget@" + WIDGET_VERSION + "/host-composition" + ESM_QUERY;
  let React, ReactDOM, ReactDOMClient, widget, host;
  try {
    [React, ReactDOM, ReactDOMClient, widget, host] = await Promise.all([
      import("react"), import("react-dom"), import("react-dom/client"),
      importWithRetry(widgetUrl, "Aomi"), importWithRetry(hostUrl, "Aomi"),
    ]);
  } catch (err) {
    console.error("[aomi] failed to load widget", err);
    showWait("Aomi could not load. Refresh to try again.", true);
    renderPanel(panelRoot, { stage: 0 });
    return;
  }

  const h = React.createElement;
  const { useEffect, useRef, useState, useSyncExternalStore } = React;
  const { AomiWidget } = widget;
  const { useAomiWalletKit } = host;

  function subscribeTheme(cb) {
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }

  /* Watches the connected Solana wallet and drives the side panel. Rendered as a
     child of AomiWidget so it shares the widget's wallet session. */
  function AgentWatcher() {
    const kit = useAomiWalletKit();
    const wallet = (kit && kit.identity && kit.identity.svmAddress) || "";
    const [view, setView] = useState({ stage: 0, wallet: "", actions: [], session: null });
    const seen = useRef({ wallet: "", sigs: new Set(), primed: false });

    // Stage 1: signed in. Register the session and restore any earlier actions.
    useEffect(() => {
      if (!wallet) { setView({ stage: 0, wallet: "", actions: [], session: null }); return; }
      let cancelled = false;
      seen.current = { wallet, sigs: new Set(), primed: false };
      setView({ stage: 1, wallet, actions: [], session: null });
      (async () => {
        const reg = await seller("/api/v1/aomi/sessions", { method: "POST", body: JSON.stringify({ wallet }) }).catch(() => null);
        const act = await seller("/api/v1/aomi/activity?wallet=" + encodeURIComponent(wallet)).catch(() => null);
        if (cancelled) return;
        const actions = (act && act.ok && act.body && act.body.recent) || [];
        const session = (act && act.ok && act.body && act.body.session) || (reg && reg.body && reg.body.session) || null;
        setView({ stage: actions.length ? 3 : 1, wallet, actions, session });
      })();
      return () => { cancelled = true; };
    }, [wallet]);

    // Stages 2-3: watch the chain for new confirmed signatures from this wallet.
    useEffect(() => {
      if (!wallet) return;
      let stopped = false;
      async function tick() {
        const clusters = Object.keys(cfg.rpcs);
        for (const cluster of clusters) {
          let sigs;
          try { sigs = await rpc(cfg.rpcs[cluster], "getSignaturesForAddress", [wallet, { limit: 8 }]); } catch { continue; }
          if (stopped || seen.current.wallet !== wallet) return;
          const key = (s) => cluster + ":" + s.signature;
          if (!seen.current.primed) { sigs.forEach((s) => seen.current.sigs.add(key(s))); continue; }
          for (const s of sigs.slice().reverse()) {
            if (seen.current.sigs.has(key(s))) continue;
            seen.current.sigs.add(key(s));
            if (s.err || (s.confirmationStatus !== "confirmed" && s.confirmationStatus !== "finalized")) continue;
            setView((v) => (v.stage < 2 ? Object.assign({}, v, { stage: 2 }) : v));
            const rep = await seller("/api/v1/aomi/actions", { method: "POST", body: JSON.stringify({ wallet, signature: s.signature, cluster }) }).catch(() => null);
            if (stopped || seen.current.wallet !== wallet) return;
            if (rep && rep.ok && rep.body && rep.body.action) {
              const action = rep.body.action;
              setView((v) => ({ stage: 3, wallet, actions: [action].concat(v.actions.filter((a) => a.signature !== action.signature)).slice(0, 20), session: rep.body.session || v.session }));
              if (window.__rx && typeof window.__rx.poll === "function") window.__rx.poll();
            }
          }
        }
        seen.current.primed = true;
      }
      tick();
      const id = setInterval(tick, POLL_MS);
      return () => { stopped = true; clearInterval(id); };
    }, [wallet]);

    useEffect(() => { renderPanel(panelRoot, view); }, [view]);
    return null;
  }

  function App() {
    const theme = useSyncExternalStore(subscribeTheme, pageTheme, () => "system");
    return h(AomiWidget, {
      applicationId: cfg.applicationId,
      baseUrl: cfg.baseUrl,
      theme,
      walletFamilies: ["solana"],
      // Sign-in lives in the thread sidebar's footer, the widget's standard layout.
      walletPosition: "footer",
      showSidebar: true,
      height: "560px",
    }, h(AgentWatcher));
  }

  chatRoot.replaceChildren();
  rewriteProviderErrors();
  renderPanel(panelRoot, { stage: 0 });
  // Extensions inject a little after load; re-check once so the notice does not flash wrongly.
  setTimeout(() => { if (!panelRoot.dataset.stage || panelRoot.dataset.stage === "0") renderPanel(panelRoot, { stage: 0 }); }, 1500);
  ReactDOMClient.createRoot(chatRoot).render(h(App));
}

/* ---------- no-wallet handling ---------- */

// Safari, and most phone browsers outside a wallet app, have no injected wallet. The widget's
// "Browser wallet" option then fails with wagmi's raw "Provider not found" text.
const NO_WALLET_TEXT = "No browser wallet found. Install Phantom or another Solana wallet extension, " +
  "or open this page in your wallet app's built-in browser.";

function hasBrowserWallet() {
  const w = window;
  return Boolean(w.ethereum || w.solana || (w.phantom && w.phantom.solana) || w.solflare || w.backpack);
}

// Replace the raw wagmi error with a message a visitor can act on. Radix portals toasts outside
// the widget root, so watch the whole body.
function rewriteProviderErrors() {
  const fix = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (/^\s*Provider not found\b/.test(n.nodeValue)) n.nodeValue = NO_WALLET_TEXT;
    }
  };
  new MutationObserver(fix).observe(document.body, { childList: true, subtree: true, characterData: true });
}

/* ---------- side panel (plain DOM) ---------- */

const STEPS = [
  ["Sign in with your wallet", "Use Sign in at the bottom of the chat sidebar."],
  ["Tell Aomi what to do", "Swaps, transfers, contract calls: in plain language."],
  ["Approve the on-chain action", "You sign; the agent never holds your keys."],
  ["Your agent joins Routex402", "The action is verified on-chain and logged to the live feed."],
  ["Keep talking on Telegram or Aomi Chat", "Scan the QR code to continue with the same account."],
];

function renderPanel(root, view) {
  const stage = view.stage || 0;
  const wallet = view.wallet || "";
  const actions = view.actions || [];
  const live = stage >= 3;
  const stepIndex = live ? 4 : stage;

  const head = el("div", null,
    live ? el("span", { class: "aomi-live" }, el("i", { "aria-hidden": "true" }), "Your agent is live") : null,
    el("h3", { class: "h3", text: live ? "Your Aomi agent" : "Get your own agent" }),
    el("p", { class: "muted", text: live
      ? "This wallet now has a verified on-chain record on Routex402. Keep the conversation going anywhere."
      : "Each step lights up as you go." }));

  const steps = el("ol", { class: "aomi-steps" }, ...STEPS.map(([title, sub], i) => {
    const cls = i < stepIndex ? "done" : i === stepIndex ? "now" : "";
    return el("li", { class: cls }, el("span", null, title, el("span", { class: "sub", text: sub })));
  }));

  const kids = [head];
  root.dataset.stage = String(stage);
  if (stage === 0 && !wallet && !hasBrowserWallet()) {
    kids.push(el("p", { class: "aomi-nowallet", role: "note", text: NO_WALLET_TEXT }));
  }
  kids.push(steps);

  if (wallet) {
    const cluster = actions.length ? actions[0].cluster : Object.keys(cfg.rpcs)[0];
    const copyBtn = (value) => { const b = el("button", { class: "aomi-copy", type: "button", text: "Copy" }); b.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(value).then(() => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1200); }); }; return b; };
    const kv = el("dl", { class: "aomi-kv" },
      el("dt", { text: "Wallet" }), el("dd", null, el("a", { href: solscanAcct(wallet, cluster), target: "_blank", rel: "noopener", class: "link", text: shortKey(wallet) }), copyBtn(wallet)),
      el("dt", { text: "Aomi App" }), el("dd", null, cfg.applicationId || "pending", cfg.applicationId ? copyBtn(cfg.applicationId) : null),
      el("dt", { text: "Actions" }), el("dd", { text: String((view.session && view.session.actions) || actions.length || 0) }));
    kids.push(kv);
  }

  if (actions.length) {
    kids.push(el("ul", { class: "aomi-recent" }, ...actions.slice(0, 5).map((a) =>
      el("li", null,
        el("span", { class: "mono", text: shortKey(a.signature) }),
        el("a", { href: solscanTx(a.signature, a.cluster), target: "_blank", rel: "noopener", class: "link", text: "View on Solscan" })))));
  }

  if (live) {
    const tgUrl = cfg.telegramBot ? "https://t.me/" + cfg.telegramBot : "";
    const qr = qrSvg(tgUrl || cfg.chatUrl);
    kids.push(el("div", { class: "aomi-tg" },
      qr,
      el("div", null,
        el("p", null, el("strong", { text: tgUrl ? "Continue on Telegram." : "Continue in Aomi Chat." })),
        el("p", { class: "muted", text: tgUrl
          ? "Open the bot, send /link, and sign with this wallet to attach it to your Aomi account."
          : "Scan to open Aomi Chat; sign in with the same wallet to pick up this agent." }))));
    kids.push(el("div", { class: "aomi-actions" },
      tgUrl ? el("a", { class: "btn btn-primary", href: tgUrl, target: "_blank", rel: "noopener", text: "Open in Telegram" }) : null,
      el("a", { class: tgUrl ? "btn btn-ghost" : "btn btn-primary", href: cfg.chatUrl, target: "_blank", rel: "noopener", text: "Open Aomi Chat" })));
  }

  root.replaceChildren(...kids);
}

main().catch((err) => {
  console.error("[aomi]", err);
  showWait("Aomi could not start. See the console for details.", true);
});
