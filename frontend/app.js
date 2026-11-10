"use strict";
(function () {
  var PROGRAM_ID = "6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt";
  var PAGE_SIZE = 10;
  var POLL_MS = 5000;
  var B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var SIG = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/;

  var params = new URLSearchParams(location.search);
  var LOCAL = params.get("backend") === "local";
  var SELLER_URL = LOCAL ? "http://localhost:4021" : (window.SELLER_URL || "http://localhost:4021");
  var BUYER_URL = LOCAL ? "http://localhost:4022" : (window.BUYER_SERVER_URL || "http://localhost:4022");

  var state = {
    agents: [], events: [], loaded: false, failed: false,
    sortKey: "reputationScore", sortDir: "desc", tier: "all", conf: "all", q: "", page: 1,
    seen: null, current: null
  };

  /* ---------- helpers ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.indexOf("on") === 0 && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  function setChildren(el, kids) { el.textContent = ""; append(el, kids); }
  function shortKey(k) { return k.slice(0, 4) + "..." + k.slice(-4); }
  function usdc(n) { return (n / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function price(n) { return (n / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }); }
  function timeAgo(sec) {
    if (!sec) return "Never";
    var d = Math.floor(Date.now() / 1000) - sec;
    if (d < 60) return "Just now";
    if (d < 3600) return Math.floor(d / 60) + " min ago";
    if (d < 86400) return Math.floor(d / 3600) + " h ago";
    return Math.floor(d / 86400) + " days ago";
  }
  function solscanAcct(k) { return "https://solscan.io/account/" + k + "?cluster=devnet"; }
  function solscanTx(s) { return "https://solscan.io/tx/" + s + "?cluster=devnet"; }
  function ext(href, text, cls) { return h("a", { href: href, target: "_blank", rel: "noopener", "class": cls || "link", text: text }); }

  function getTier(a) {
    if (a.completedCount >= 15 && a.reputationScore >= 90) return "Elite";
    if (a.completedCount >= 5 && a.reputationScore >= 70) return "Trusted";
    return "New";
  }
  var TIER_RANK = { Elite: 3, Trusted: 2, New: 1 };
  var CONF_RANK = { High: 4, Medium: 3, Low: 2, Unknown: 1, Unrated: 0 };
  function tierBadge(t) { return h("span", { "class": "badge b-" + t.toLowerCase(), text: t }); }
  function confBadge(c) { return h("span", { "class": "badge b-" + c.toLowerCase(), text: c }); }
  var STATUS = { pass: "✓ Pass", caution: "! Caution", fail: "✕ Fail", unknown: "? Unknown" };
  function statusBadge(s) { return h("span", { "class": "badge b-" + s, text: STATUS[s] }); }

  function enrich(a) {
    a._tier = getTier(a); a._conf = getConfidence(a); return a;
  }

  /* ---------- network ---------- */
  function fetchJson(base, path, opts, timeoutMs) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000);
    var o = Object.assign({}, opts || {}, { signal: ctrl.signal });
    return fetch(base + path, o).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { ok: res.ok, status: res.status, body: body, aborted: false };
      });
    }).catch(function (err) {
      return { ok: false, status: 0, body: null, aborted: !!(err && err.name === "AbortError") };
    }).then(function (r) { clearTimeout(t); return r; });
  }

  /* ---------- events (shape-tolerant) ---------- */
  function evList(b) { return Array.isArray(b) ? b : (b && Array.isArray(b.events) ? b.events : []); }
  function evSig(e) { var s = e.signature || e.sig || e.txSignature || e.tx; return (typeof s === "string" && SIG.test(s)) ? s : ""; }
  function evKey(e) { return evSig(e) || e.id || JSON.stringify(e); }
  function evSeller(e) { return e.seller || e.sellerPubkey || e.sellerProfile || e.agent || e.pubkey || ""; }
  function evText(e) { return String(e.message || e.label || e.title || e.step || e.type || e.event || "Event"); }
  function evTime(e) {
    var t = e.timestamp || e.time || e.ts || e.createdAt;
    if (!t) return 0;
    var n = typeof t === "number" ? t : Date.parse(t) / 1000;
    if (!n || isNaN(n)) return 0;
    return n > 1e12 ? n / 1000 : n;
  }
  function matchesAgent(e, a) { var s = evSeller(e); return s && (s === a.pubkey || s === a.authority); }

  /* ---------- polling ---------- */
  function poll() {
    if (document.hidden && state.loaded) { return schedule(); }
    Promise.all([fetchJson(SELLER_URL, "/agents"), fetchJson(SELLER_URL, "/events")]).then(function (rs) {
      var ag = rs[0], ev = rs[1];
      if (ag.ok && Array.isArray(ag.body)) {
        var prev = {};
        state.agents.forEach(function (x) { prev[x.pubkey] = x.completedCount; });
        var hadAgents = state.loaded;
        state.agents = ag.body.map(enrich); state.loaded = true; state.failed = false;
        if (hadAgents) state.agents.forEach(function (x) { if (prev[x.pubkey] !== undefined && x.completedCount > prev[x.pubkey]) fireNode(x.pubkey); });
      } else { state.failed = true; }
      if (ev.ok) {
        var list = evList(ev.body).slice();
        if (list.some(function (e) { return evTime(e) > 0; })) list.sort(function (a, b) { return evTime(b) - evTime(a); });
        detectNew(list);
        state.events = list;
      }
      $("#status-banner").hidden = !state.failed;
      renderAll();
    }).then(schedule, schedule);
  }
  function schedule() { setTimeout(poll, state.failed ? 5000 : POLL_MS); }

  function detectNew(list) {
    var keys = list.map(evKey);
    if (state.seen === null) { state.seen = new Set(keys); return; }
    var fresh = list.filter(function (e) { return !state.seen.has(evKey(e)); });
    keys.forEach(function (k) { state.seen.add(k); });
    fresh.slice(0, 3).forEach(function (e) { fireNode(evSeller(e)); });
  }

  /* ---------- rendering: home ---------- */
  function renderAll() {
    renderStats(); renderHighway(); renderTable(); renderActivity();
    if (state.current) renderDetail();
  }

  function renderStats() {
    var a = state.agents, vals;
    if (!state.loaded) return;
    var pay = a.reduce(function (s, x) { return s + x.completedCount; }, 0);
    var vol = a.reduce(function (s, x) { return s + x.totalVolume; }, 0);
    var avg = a.length ? Math.round(a.reduce(function (s, x) { return s + x.reputationScore; }, 0) / a.length) : 0;
    vals = { agents: String(a.length), payments: pay.toLocaleString("en-US"), volume: usdc(vol), avg: a.length ? String(avg) : "n/a" };
    Object.keys(vals).forEach(function (k) {
      var el = $('[data-stat="' + k + '"]');
      if (el) { el.textContent = vals[k]; el.classList.remove("skel"); }
    });
  }

  function ranked() {
    return state.agents.slice().sort(function (x, y) {
      return (y.reputationScore - x.reputationScore) || (y.completedCount - x.completedCount);
    });
  }

  function renderHighway() {
    var box = $("#highway-track");
    if (!state.loaded) { box.textContent = "Loading agents..."; return; }
    var top = ranked().slice(0, 6);
    var sig = top.map(function (a) { return [a.pubkey, a.reputationScore, a._tier, a.completedCount, a.failedCount, a.lastUpdated].join(":"); }).join("|");
    if (box.dataset.sig === sig) { applyFlash(); return; }
    box.dataset.sig = sig;
    if (!top.length) { setChildren(box, h("p", { "class": "muted", text: "No agents yet." })); return; }
    var max = top.reduce(function (m, a) { return Math.max(m, a.completedCount + a.failedCount); }, 1);
    var nowSec = Math.floor(Date.now() / 1000);
    setChildren(box, top.map(function (a, i) {
      var total = a.completedCount + a.failedCount;
      var okW = total ? Math.max(a.completedCount / max * 100, a.completedCount ? 3 : 0) : 0;
      var badW = total ? Math.max(a.failedCount / max * 100, a.failedCount ? 3 : 0) : 0;
      var age = (nowSec - a.lastUpdated) / 86400;
      var stale = age > 30;
      return h("a", { "class": "al-row", href: "#/agent/" + a.pubkey, "data-pk": a.pubkey, role: "listitem",
          "aria-label": "Agent " + shortKey(a.pubkey) + ", reputation " + a.reputationScore },
        h("span", { "class": "al-light " + (age <= 7 ? "on" : age <= 30 ? "mid" : "off"), "aria-hidden": "true" }),
        h("span", { "class": "al-rank", text: "#" + String(i + 1) }),
        h("span", { "class": "al-name" },
          h("strong", { "class": "al-key", text: shortKey(a.pubkey) }),
          tierBadge(a._tier),
          confBadge(a._conf)),
        h("span", { "class": "al-score" }, h("strong", { text: String(a.reputationScore) }), h("span", { "class": "muted", text: " score" })),
        h("span", { "class": "al-when" + (stale ? " stale" : ""), text: "Active " + timeAgo(a.lastUpdated) }),
        h("span", { "class": "al-barcell" },
          h("span", { "class": "al-bar", "aria-hidden": "true" },
            h("span", { "class": "al-ok", style: "width:" + okW + "%" }),
            h("span", { "class": "al-bad", style: "width:" + badW + "%" }))));
    }));















    applyFlash();
  }

  // A payment landed for this seller (pubkey or payout address): flash its row.
  function fireNode(pubkey) {
    if (!pubkey) return;
    state.pendingFlash = state.pendingFlash || {};
    state.pendingFlash[pubkey] = true; // applied by renderHighway once rows are rebuilt
  }
  function applyFlash() {
    var box = $("#highway-track"), pend = state.pendingFlash;
    if (!box || !pend) return;
    Array.prototype.forEach.call(box.querySelectorAll(".al-row"), function (r) {
      var a = state.agents.filter(function (x) { return x.pubkey === r.dataset.pk; })[0];
      if (pend[r.dataset.pk] || (a && pend[a.authority])) {
        r.classList.add("al-flash");
        var light = r.querySelector(".al-light"); if (light) { light.classList.add("flash"); setTimeout(function () { light.classList.remove("flash"); }, 800); }
        setTimeout(function () { r.classList.remove("al-flash"); }, 1800);
      }
    });
    state.pendingFlash = null;
  }

  var COLS = [
    { key: "rank", label: "#", sort: null },
    { key: "pubkey", label: "Agent", sort: "pubkey" },
    { key: "tier", label: "Tier", sort: "_tierRank" },
    { key: "reputationScore", label: "Reputation", sort: "reputationScore", num: true },
    { key: "conf", label: "Confidence", sort: "_confRank" },
    { key: "completedCount", label: "Completed", sort: "completedCount", num: true },
    { key: "failedCount", label: "Failed", sort: "failedCount", num: true },
    { key: "distinctBuyers", label: "Buyers", sort: "distinctBuyers", num: true },
    { key: "totalVolume", label: "Volume (USDC)", sort: "totalVolume", num: true },
    { key: "lastUpdated", label: "Last active", sort: "lastUpdated", num: true }
  ];

  function buildHead() {
    var row = $("#thead-row");
    setChildren(row, COLS.map(function (c) {
      var th = h("th", { scope: "col", "class": c.num ? "num" : null });
      if (!c.sort) { th.textContent = c.label; return th; }
      var active = state.sortKey === c.sort;
      th.setAttribute("aria-sort", active ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
      th.append(h("button", { type: "button", onclick: function () { setSort(c.sort); } }, c.label, active ? (state.sortDir === "asc" ? " ▲" : " ▼") : ""));
      return th;
    }));
  }
  function setSort(key) {
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else { state.sortKey = key; state.sortDir = key === "pubkey" ? "asc" : "desc"; }
    state.page = 1; renderTable();
  }

  function filtered() {
    var rk = {}; ranked().forEach(function (a, i) { rk[a.pubkey] = i + 1; });
    var q = state.q.trim().toLowerCase();
    var list = state.agents.filter(function (a) {
      if (state.tier !== "all" && a._tier !== state.tier) return false;
      if (state.conf !== "all" && a._conf !== state.conf) return false;
      if (q && a.pubkey.toLowerCase().indexOf(q) === -1 && a.authority.toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).map(function (a) { a._rank = rk[a.pubkey]; a._tierRank = TIER_RANK[a._tier]; a._confRank = CONF_RANK[a._conf]; return a; });
    var k = state.sortKey, dir = state.sortDir === "asc" ? 1 : -1;
    list.sort(function (x, y) {
      var a = x[k], b = y[k];
      var c = typeof a === "string" ? a.localeCompare(b) : (a - b);
      return c * dir || (x._rank - y._rank);
    });
    return list;
  }

  function renderTable() {
    buildHead();
    var body = $("#tbody"), pager = $("#pager");
    if (!state.loaded) {
      var rows = [];
      for (var i = 0; i < 5; i++) rows.push(h("tr", null, h("td", { colspan: COLS.length }, h("div", { "class": "skel", style: "height:22px" }, " "))));
      setChildren(body, rows); setChildren(pager, null); return;
    }
    var list = filtered();
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * PAGE_SIZE, slice = list.slice(start, start + PAGE_SIZE);
    if (!slice.length) {
      setChildren(body, h("tr", null, h("td", { colspan: COLS.length, "class": "empty" }, state.agents.length ? "No agents match your filters." : "No agents found yet.")));
    } else {
      setChildren(body, slice.map(function (a) {
        var go = function (e) { if (e.target.tagName !== "A") location.hash = "#/agent/" + a.pubkey; };
        return h("tr", { onclick: go },
          h("td", { "data-label": "Rank" }, String(a._rank)),
          h("td", { "data-label": "Agent" }, h("a", { "class": "agent-link", href: "#/agent/" + a.pubkey, text: shortKey(a.pubkey) })),
          h("td", { "data-label": "Tier" }, tierBadge(a._tier)),
          h("td", { "data-label": "Reputation", "class": "num" }, String(a.reputationScore)),
          h("td", { "data-label": "Confidence" }, confBadge(a._conf)),
          h("td", { "data-label": "Completed", "class": "num" }, String(a.completedCount)),
          h("td", { "data-label": "Failed", "class": "num" }, String(a.failedCount)),
          h("td", { "data-label": "Buyers", "class": "num" }, (a.distinctBuyers === 0 && a.completedCount > 0) ? "Unknown" : String(a.distinctBuyers)),
          h("td", { "data-label": "Volume (USDC)", "class": "num" }, usdc(a.totalVolume)),
          h("td", { "data-label": "Last active", "class": "num" }, timeAgo(a.lastUpdated)));
      }));
    }
    setChildren(pager, [
      h("span", { text: list.length ? "Showing " + (start + 1) + " to " + (start + slice.length) + " of " + list.length + " agents" : "0 agents" }),
      h("span", { "class": "btns" },
        h("button", { "class": "btn btn-ghost btn-sm", type: "button", disabled: state.page <= 1, onclick: function () { state.page--; renderTable(); } }, "Previous"),
        h("span", { text: "Page " + state.page + " of " + pages }),
        h("button", { "class": "btn btn-ghost btn-sm", type: "button", disabled: state.page >= pages, onclick: function () { state.page++; renderTable(); } }, "Next"))
    ]);
  }

  var STEP_TAGS = {
    "receive_request": { label: "Request", cls: "tag-request" },
    "402_challenge": { label: "402", cls: "tag-402" },
    "verify_payment": { label: "Verify", cls: "tag-verify" },
    "deliver_result": { label: "Deliver", cls: "tag-deliver" },
    "reputation_update": { label: "Reputation", cls: "tag-rep" }
  };
  function renderActivity() {
    var ul = $("#activity");
    if (!state.events.length) { setChildren(ul, h("li", null, h("span", { "class": "muted", text: "No activity yet. Run a purchase to see it live." }))); return; }
    var sig = state.events.slice(0, 12).map(evKey).join("|");
    if (ul.dataset.sig === sig) return;
    ul.dataset.sig = sig;
    setChildren(ul, state.events.slice(0, 12).map(activityRow));
  }
  function activityRow(e) {
    var s = evSig(e), t = evTime(e), who = evSeller(e);
    var step = e.step || "";
    var tag = STEP_TAGS[step];
    return h("li", { "data-step": step },
      h("span", null,
        tag ? h("span", { "class": "step-tag " + tag.cls, text: tag.label }) : "",
        evText(e),
        who && B58.test(who) ? " (" + shortKey(who) + ")" : ""),
      h("span", { "class": "when" }, t ? timeAgo(Math.floor(t)) + " " : "", s ? ext(solscanTx(s), "View on Solscan") : ""));
  }

  /* ---------- rendering: agent detail ---------- */
  function reasonFor(a) {
    var c = a.completedCount, b = a.distinctBuyers;
    switch (a._conf) {
      case "Unrated": return "Fewer than 5 completed payments, so there is not enough history to rate this agent.";
      case "Unknown": return c + " payments are recorded, but the distinct buyer count was not recorded for this agent, so confidence cannot be judged.";
      case "High": return c + " payments from " + b + " different buyers.";
      case "Medium": return c + " payments from " + b + " different buyers. More independent buyers would raise confidence.";
      default: return c + " payments but only " + b + " distinct buyer" + (b === 1 ? "" : "s") + ". A single buyer can inflate a score, so confidence is low.";
    }
  }

  function renderDetail() {
    var root = $("#agent-root");
    var a = state.agents.filter(function (x) { return x.pubkey === state.current; })[0];
    if (!state.loaded) { setChildren(root, [h("a", { "class": "crumb", href: "#/" }, "← All agents"), h("div", { "class": "skel", style: "height:240px;border-radius:16px" }, " ")]); return; }
    if (!a) { setChildren(root, [h("a", { "class": "crumb", href: "#/" }, "← All agents"), h("div", { "class": "card empty" }, "No agent with this public key was found.")]); return; }

    var evs = state.events.filter(function (e) { return matchesAgent(e, a); }).slice(0, 10);
    var sig = JSON.stringify(a) + evs.map(evKey).join("|");
    if (root.dataset.sig === sig) return;
    root.dataset.sig = sig;
    document.title = "Agent " + shortKey(a.pubkey) + " | Routex402";

    var checks = runVettingChecks(a);
    var counts = { pass: 0, caution: 0, fail: 0, unknown: 0 };
    checks.forEach(function (c) { counts[c.status]++; });
    var total = a.completedCount + a.failedCount;
    var rate = total ? (a.completedCount / total * 100).toFixed(1) + "%" : "n/a";
    var avgPay = a.completedCount ? usdc(a.totalVolume / a.completedCount) + " USDC" : "n/a";
    var buyers = (a.distinctBuyers === 0 && a.completedCount > 0) ? "Not recorded" : String(a.distinctBuyers);
    var curl = "curl -s " + SELLER_URL + "/agents | jq '.[] | select(.pubkey==\"" + a.pubkey + "\")'";
    var copyKey = h("button", { "class": "btn btn-ghost btn-sm", type: "button" }, "Copy");
    copyKey.addEventListener("click", function () { copy(a.pubkey, copyKey); });
    var copyCurl = h("button", { "class": "btn btn-ghost btn-sm", type: "button" }, "Copy command");
    copyCurl.addEventListener("click", function () { copy(curl, copyCurl); });

    setChildren(root, [
      h("a", { "class": "crumb", href: "#/" }, "← All agents"),
      h("div", { "class": "ag-head" },
        h("div", null,
          h("h1", { style: "font-size:30px" }, "Agent ", h("span", { "class": "mono", text: shortKey(a.pubkey) })),
          h("div", { "class": "ag-key" }, h("span", { "class": "mono muted", text: a.pubkey }), copyKey),
          h("p", { "class": "muted", style: "margin-top:8px" }, "Name and description: Not provided")),
        h("div", { "class": "ag-links" }, ext(solscanAcct(a.pubkey), "Seller account on Solscan"), ext(solscanAcct(PROGRAM_ID), "Program on Solscan"))),

      h("div", { "class": "sum" },
        h("div", { "class": "card" }, h("span", { "class": "lab", text: "Reputation" }), h("span", { "class": "big", text: String(a.reputationScore) }), tierBadge(a._tier)),
        h("div", { "class": "card" }, h("span", { "class": "lab", text: "Confidence" }), h("span", { "class": "big", text: a._conf }), confBadge(a._conf)),
        h("div", { "class": "card" }, h("span", { "class": "lab", text: "Why" }), h("p", { text: reasonFor(a) }))),

      h("div", { "class": "two" },
        h("section", { "class": "card", "aria-labelledby": "vet-t" },
          h("h2", { id: "vet-t", "class": "h3" }, "Vetting checklist"),
          h("p", { "class": "muted", text: counts.pass + " pass, " + counts.caution + " caution, " + counts.fail + " fail, " + counts.unknown + " unknown" }),
          h("ul", { "class": "checks" }, checks.map(function (c) {
            return h("li", null, h("span", { "class": "nm", text: c.label }), statusBadge(c.status), h("span", { "class": "dt", text: c.detail }));
          }))),
        h("section", { "class": "card", "aria-labelledby": "ev-t" },
          h("h2", { id: "ev-t", "class": "h3" }, "Evidence"),
          h("dl", { "class": "kv" },
            kv("Completed payments", String(a.completedCount)), kv("Failed", String(a.failedCount)), kv("Success rate", rate),
            kv("Distinct buyers", buyers), kv("Listed price", price(a.price) + " USDC"), kv("Total volume", usdc(a.totalVolume) + " USDC"),
            kv("Average payment", avgPay), kv("Last updated", timeAgo(a.lastUpdated) + (a.lastUpdated ? " (" + new Date(a.lastUpdated * 1000).toISOString().slice(0, 10) + ")" : ""))))),

      h("section", { "class": "card flat", style: "margin-bottom:24px" },
        h("h2", { "class": "h3" }, "How this score was verified"),
        h("p", null, "The reputation program only accepts a score update when the buyer's own wallet signs it. A seller cannot report its own successes. Every number above is read from the seller's on-chain account. ", h("a", { href: "docs.html" }, "Read the security model"), "."),
        h("p", { "class": "muted", text: "Verify it yourself:" }),
        h("pre", { "class": "code", text: curl }), copyCurl),

      h("section", { "class": "card", style: "margin-bottom:24px" },
        h("h2", { "class": "h3" }, "Recent activity"),
        evs.length ? h("ul", { "class": "act" }, evs.map(activityRow)) : h("p", { "class": "muted", text: "No recent activity found for this agent." })),

      h("p", { "class": "note" }, h("strong", null, "Limits. "), "One person who controls both the buyer and the seller wallet can still inflate a score. The buyer independence check flags this pattern but cannot rule it out. Scores are informational, not a guarantee. This is a devnet demonstration.")
    ]);
  }
  function kv(k, v) { return [h("dt", { text: k }), h("dd", { text: v })]; }
  function copy(text, btn) {
    var done = function () { var o = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = o; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
  }

  /* ---------- demo purchase ---------- */
  function runPurchase() {
    var btn = $("#run-purchase"), out = $("#purchase-result");
    btn.disabled = true; btn.textContent = "Purchasing..."; out.className = "demo-msg"; out.textContent = "";
    var res = { ok: false, status: 0, body: null, aborted: false };
    fetchJson(BUYER_URL, "/demo-purchase", { method: "POST" }, 55000).then(function (r) { res = r; }, function () {}).then(function () {
      if (res.ok && res.body && res.body.success) {
        btn.textContent = "Purchase complete"; out.className = "demo-msg ok"; out.textContent = "Payment settled on devnet. ";
        var s = res.body.signature;
        if (typeof s === "string" && SIG.test(s)) out.append(ext(solscanTx(s), "View transaction"));
      } else if (res.aborted) { btn.textContent = "Try again shortly"; out.className = "demo-msg err"; out.textContent = "Backend waking up. Try again in a moment."; }
      else if (res.status === 429) { btn.textContent = "Rate limited"; out.className = "demo-msg err"; out.textContent = "Too many demo purchases. Try again in a minute."; }
      else { btn.textContent = "Purchase failed"; out.className = "demo-msg err"; out.textContent = "The backend could not be reached or rejected the request."; }
      setTimeout(function () { btn.disabled = false; btn.textContent = "Run purchase"; }, 3000);
      poll_now();
    });
  }
  var pollTimer = null;
  function poll_now() { setTimeout(function () { fetchJson(SELLER_URL, "/events").then(function (r) { if (r.ok) { var l = evList(r.body); detectNew(l); state.events = l; renderAll(); } }); }, 1500); }

  /* ---------- routing + init ---------- */
  function route() {
    var hash = location.hash || "";
    var m = hash.match(/^#\/agent\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    $("#view-home").hidden = !!m; $("#view-agent").hidden = !m;
    $("#nav").classList.remove("open"); $("#nav-toggle").setAttribute("aria-expanded", "false");
    if (m) { state.current = m[1]; $("#agent-root").dataset.sig = ""; renderDetail(); window.scrollTo(0, 0); }
    else {
      state.current = null; document.title = "Routex402: Verified reputation for AI agent payments";
      var target = (hash === "#how" || hash === "#explorer") ? document.getElementById(hash.slice(1)) : null;
      if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
    }
  }

  function init() {
    var pitch = $("#pitch-link");
    if (pitch && pitch.getAttribute("href").indexOf("__") === 0) pitch.hidden = true;
    $("#run-purchase").addEventListener("click", runPurchase);
    $("#q").addEventListener("input", function (e) { state.q = e.target.value; state.page = 1; renderTable(); });
    $("#f-tier").addEventListener("change", function (e) { state.tier = e.target.value; state.page = 1; renderTable(); });
    $("#f-conf").addEventListener("change", function (e) { state.conf = e.target.value; state.page = 1; renderTable(); });
    $("#nav-toggle").addEventListener("click", function () {
      var open = $("#nav").classList.toggle("open"); this.setAttribute("aria-expanded", open ? "true" : "false");
    });
    window.addEventListener("hashchange", route);
    renderTable(); renderHighway(); route(); poll();
  }
  window.__rx = { state: state, route: route, poll: poll };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();

/* ---------- live agents dashboard ---------- */
(function () {
  var SELLER_URL = window.SELLER_URL || "http://localhost:4021";

  /* --- Price Oracle (enhanced) --- */
  var priceEl = document.getElementById("oracle-price");
  var slotEl = document.getElementById("oracle-slot");
  var epochEl = document.getElementById("oracle-epoch");
  var timeEl = document.getElementById("oracle-time");
  var changeEl = document.getElementById("oracle-change");
  var healthEl = document.getElementById("oracle-health");
  var tpsEl = document.getElementById("oracle-tps");
  var refreshBtn = document.getElementById("oracle-refresh");

  function fetchPrice() {
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = "..."; }
    fetch(SELLER_URL + "/preview/price")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.data) {
          priceEl.textContent = "$" + d.data.price.toFixed(2);
          priceEl.classList.remove("skel");
          if (slotEl) { slotEl.textContent = "Slot " + d.data.slot; slotEl.classList.remove("skel"); }
          if (epochEl) { epochEl.textContent = "Epoch " + d.data.epoch; epochEl.classList.remove("skel"); }
          if (timeEl) { timeEl.textContent = new Date(d.data.generatedAt).toLocaleTimeString(); timeEl.classList.remove("skel"); }
          if (changeEl) {
            var c = d.data.change24h || 0;
            changeEl.textContent = (c >= 0 ? "+" : "") + c.toFixed(2) + "%";
            changeEl.className = "oracle-meta-item oracle-change " + (c >= 0 ? "up" : "down");
          }
          if (healthEl) {
            var h = d.data.networkHealth || "healthy";
            healthEl.textContent = h.toUpperCase();
            healthEl.className = "oracle-meta-item oracle-health " + h;
          }
          if (tpsEl) { tpsEl.textContent = (d.data.avgTps || 0) + " TPS"; tpsEl.className = "oracle-meta-item"; }
        }
      })
      .catch(function () { if (priceEl) { priceEl.textContent = "—"; priceEl.classList.remove("skel"); } })
      .then(function () { if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "Refresh"; } });
  }
  if (priceEl) { fetchPrice(); setInterval(fetchPrice, 15000); }
  if (refreshBtn) refreshBtn.addEventListener("click", fetchPrice);

  /* --- Uptime Monitor --- */
  var uptimeStatus = document.getElementById("uptime-status");
  var uptimeLatency = document.getElementById("uptime-latency");
  var uptimeTps = document.getElementById("uptime-tps");

  function fetchUptime() {
    fetch(SELLER_URL + "/preview/uptime")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.data) {
          var s = d.data.status;
          var icon = s === "operational" ? "✅" : s === "degraded" ? "⚠️" : "❌";
          uptimeStatus.textContent = icon + " " + s.charAt(0).toUpperCase() + s.slice(1);
          uptimeStatus.classList.remove("skel");
          if (uptimeLatency) { uptimeLatency.textContent = d.data.rpcLatencyMs + "ms latency"; uptimeLatency.classList.remove("skel"); }
          if (uptimeTps) { uptimeTps.textContent = d.data.avgTps + " TPS"; }
        }
      })
      .catch(function () { if (uptimeStatus) { uptimeStatus.textContent = "—"; uptimeStatus.classList.remove("skel"); } });
  }
  if (uptimeStatus) { fetchUptime(); setInterval(fetchUptime, 20000); }

  /* --- Whale Watcher --- */
  var whaleTop = document.getElementById("whale-top");
  var whaleList = document.getElementById("whale-list");

  function fetchWhales() {
    fetch(SELLER_URL + "/preview/whales")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.data && d.data.topAccounts) {
          var accts = d.data.topAccounts;
          var totalSol = accts.reduce(function (s, a) { return s + a.balanceSol; }, 0);
          whaleTop.textContent = totalSol.toLocaleString() + " SOL";
          whaleTop.classList.remove("skel");
          if (whaleList) {
            whaleList.innerHTML = "";
            accts.slice(0, 5).forEach(function (a) {
              var row = document.createElement("div");
              row.className = "whale-row";
              row.innerHTML = '<span class="whale-addr">#' + a.rank + ' ' + a.address.slice(0, 4) + '...' + a.address.slice(-4) + '</span><span class="whale-bal">' + a.balanceSol.toLocaleString() + ' SOL</span>';
              whaleList.appendChild(row);
            });
          }
        }
      })
      .catch(function () { if (whaleTop) { whaleTop.textContent = "—"; whaleTop.classList.remove("skel"); } });
  }
  if (whaleTop) { fetchWhales(); setInterval(fetchWhales, 30000); }

  /* --- Validator Scorecard --- */
  var validatorCount = document.getElementById("validator-count");
  var validatorStake = document.getElementById("validator-stake");
  var validatorEpoch = document.getElementById("validator-epoch");

  function fetchValidators() {
    fetch(SELLER_URL + "/preview/validators")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.data) {
          validatorCount.textContent = d.data.activeValidators + " / " + d.data.totalValidators + " active";
          validatorCount.classList.remove("skel");
          if (validatorStake) { validatorStake.textContent = d.data.networkStakeSol.toLocaleString() + " SOL staked"; }
          if (validatorEpoch) { validatorEpoch.textContent = "Epoch " + d.data.epoch; }
        }
      })
      .catch(function () { if (validatorCount) { validatorCount.textContent = "—"; validatorCount.classList.remove("skel"); } });
  }
  if (validatorCount) { fetchValidators(); setInterval(fetchValidators, 30000); }
})();

/* dark mode toggle */
const dmBtn=document.createElement("button");
dmBtn.className="btn btn-ghost btn-sm";
dmBtn.textContent="🌙";
dmBtn.style.cssText="font-size:18px;padding:6px 10px;min-height:0";
dmBtn.onclick=()=>{const d=document.documentElement;const next=d.getAttribute("data-theme")==="dark"?"light":"dark";d.setAttribute("data-theme",next);localStorage.setItem("theme",next);dmBtn.textContent=next==="dark"?"☀️":"🌙"};
const saved=localStorage.getItem("theme")||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");
document.documentElement.setAttribute("data-theme",saved);
if(saved==="dark")dmBtn.textContent="☀️";
document.querySelector(".nav")?.prepend(dmBtn);
