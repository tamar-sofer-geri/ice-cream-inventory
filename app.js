/* Geri's Glideria — ice cream inventory
 *
 * containers  : one row per physical tub { id, flavor, state, date_made }
 * empties     : running count of empty tubs on hand (increment on finish,
 *               decrement when new tubs are made)
 * consumptions: immutable history { flavor, date_made, consumed_at } — one row
 *               each time a tub is finished; powers the analytics page.
 *
 * Data lives in Supabase and syncs across devices in real time. localStorage
 * is an offline read cache for instant paint.
 */
(function () {
  "use strict";

  var CACHE_KEY = "glideriaCache";
  var cfg = window.GLIDERIA_CONFIG || {};
  var usingSupabase = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  var db = usingSupabase
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : null;

  // ----- DOM -----
  var listEl = document.getElementById("inventory-list");
  var emptyEl = document.getElementById("empty-state");
  var summaryEl = document.getElementById("summary-list");
  var summaryEmptyEl = document.getElementById("summary-empty");
  var syncNote = document.getElementById("sync-note");
  var addBtn = document.getElementById("add-btn");
  var modal = document.getElementById("add-modal");
  var addForm = document.getElementById("add-form");
  var flavorInput = document.getElementById("flavor-input");
  var qtyInput = document.getElementById("qty-input");
  var dateInput = document.getElementById("date-input");
  var suggestions = document.getElementById("flavor-suggestions");
  var emptiesNumEl = document.getElementById("empties-num");
  var emptiesResetEl = document.getElementById("empties-reset");
  // undo
  var undoBar = document.getElementById("undo-bar");
  var undoBtn = document.getElementById("undo-btn");
  var undoLabelEl = document.getElementById("undo-label");
  // analytics
  var periodSeg = document.getElementById("period-seg");
  var flavorFilterEl = document.getElementById("flavor-filter");
  var statTotalEl = document.getElementById("stat-total");
  var statStockEl = document.getElementById("stat-stock");
  var statTopEl = document.getElementById("stat-top");
  var chartEl = document.getElementById("consumption-chart");
  var periodWordEl = document.getElementById("period-word");
  var flavorBreakdownEl = document.getElementById("flavor-breakdown");
  var waitListEl = document.getElementById("wait-list");
  var sittingListEl = document.getElementById("sitting-list");
  var analyticsEmptyEl = document.getElementById("analytics-empty");

  // ----- state -----
  var emptiesCount = 0;
  var consumptions = [];
  var inventory = loadCache(); // also sets emptiesCount + consumptions
  var currentView = "containers";
  var expanded = {};
  var analyticsPeriod = "week";
  var analyticsFlavor = "all";
  var pendingUndo = null;
  var undoTimer = null;

  /* ---------- helpers ---------- */

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function pad2(n) { return String(n).padStart(2, "0"); }

  function shortDate(iso) {
    if (!iso) return "";
    var p = String(iso).slice(0, 10).split("-");
    if (p.length !== 3) return iso;
    return parseInt(p[1], 10) + "/" + parseInt(p[2], 10);
  }

  function makeId() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function byFlavorThenDate(a, b) {
    var f = a.flavor.toLowerCase().localeCompare(b.flavor.toLowerCase());
    if (f !== 0) return f;
    return String(a.date_made).localeCompare(String(b.date_made));
  }

  function showNote(msg) {
    if (!msg) { syncNote.hidden = true; return; }
    syncNote.textContent = msg;
    syncNote.hidden = false;
  }

  function daysBetween(later, earlier) {
    return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
  }
  function parseDay(iso) { return new Date(String(iso).slice(0, 10) + "T00:00:00"); }

  function tubSVG() {
    return '<svg class="tub-svg" viewBox="0 0 24 26">' +
      '<path class="lid" d="M2.6 3.2 h18.8 a2.4 2.4 0 0 1 0 4.8 h-18.8 a2.4 2.4 0 0 1 0 -4.8 z"/>' +
      '<path class="body" d="M3.6 7.6 h16.8 l-1.9 15.1 a1.4 1.4 0 0 1 -1.4 1.2 h-10.2 a1.4 1.4 0 0 1 -1.4 -1.2 z"/>' +
      '<text class="tub-frac" x="12" y="18.5" text-anchor="middle">½</text>' +
      '</svg>';
  }
  function countTubSVG(n) {
    return '<svg class="count-tub-svg" viewBox="0 0 24 26">' +
      '<path class="lid" d="M2.6 3.2 h18.8 a2.4 2.4 0 0 1 0 4.8 h-18.8 a2.4 2.4 0 0 1 0 -4.8 z"/>' +
      '<path class="body" d="M3.6 7.6 h16.8 l-1.9 15.1 a1.4 1.4 0 0 1 -1.4 1.2 h-10.2 a1.4 1.4 0 0 1 -1.4 -1.2 z"/>' +
      '<text class="count-num" x="12" y="18.7" text-anchor="middle">' + n + '</text>' +
      '</svg>';
  }

  /* ---------- cache ---------- */

  function loadCache() {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.containers)) {
        emptiesCount = parsed.empties || 0;
        consumptions = Array.isArray(parsed.consumptions) ? parsed.consumptions : [];
        return parsed.containers;
      }
      if (Array.isArray(parsed)) return parsed; // legacy
      return [];
    } catch (e) { return []; }
  }

  function saveCache() {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify({
        containers: inventory, empties: emptiesCount, consumptions: consumptions
      }));
    } catch (e) { /* ignore */ }
  }

  /* ---------- data access ---------- */

  function fetchAll() {
    if (!usingSupabase) { render(); return Promise.resolve(); }
    return Promise.all([
      db.from("containers").select("id, flavor, state, date_made"),
      db.from("empties").select("*", { count: "exact", head: true }),
      db.from("consumptions").select("flavor, date_made, consumed_at")
    ]).then(function (res) {
      var c = res[0], e = res[1], k = res[2];
      if (c.error) throw c.error;
      inventory = c.data || [];
      if (!e.error && typeof e.count === "number") emptiesCount = e.count;
      if (!k.error && Array.isArray(k.data)) {
        consumptions = k.data.map(function (r) {
          return { id: makeId(), flavor: r.flavor, date_made: r.date_made, consumed_at: r.consumed_at };
        });
      }
      saveCache();
      showNote("");
      render();
    }).catch(function (err) {
      console.error("fetch failed", err);
      showNote("Offline — showing last synced data.");
      render();
    });
  }

  // Simple optimistic mutation helper for single ops.
  function mutate(runRemote, applyLocal) {
    applyLocal();
    saveCache();
    render();
    if (!usingSupabase) return;
    runRemote()
      .then(function (res) {
        if (res && res.error) throw res.error;
        showNote("");
      })
      .catch(function (err) {
        console.error("save failed", err);
        showNote("Couldn't reach the server — changes may not have saved.");
      })
      .then(function () { fetchAll(); });
  }

  function decrementEmptiesRemote(n) {
    if (n <= 0) return Promise.resolve({ error: null });
    return db.from("empties").select("id").limit(n).then(function (res) {
      if (res.error) return { error: res.error };
      var ids = (res.data || []).map(function (r) { return r.id; });
      if (ids.length === 0) return { error: null };
      return db.from("empties").delete().in("id", ids);
    });
  }

  function deleteLatestConsumptionRemote(flavor) {
    return db.from("consumptions").select("id").eq("flavor", flavor)
      .order("consumed_at", { ascending: false }).limit(1)
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) return { error: null };
        return db.from("consumptions").delete().eq("id", res.data[0].id);
      });
  }

  /* ---------- rendering ---------- */

  function render() {
    var sorted = inventory.slice().sort(byFlavorThenDate);
    renderContainers(sorted);
    renderInventory(sorted);
    emptiesNumEl.textContent = emptiesCount;
    renderAnalytics();
    refreshSuggestions();
  }

  function renderContainers(sorted) {
    listEl.innerHTML = "";
    emptyEl.hidden = sorted.length > 0;
    sorted.forEach(function (item) { listEl.appendChild(buildRow(item)); });
  }

  function buildRow(item) {
    var li = document.createElement("li");
    li.className = "row";
    li.dataset.id = item.id;

    var tub = document.createElement("span");
    tub.className = "tub";
    tub.dataset.state = item.state;
    tub.setAttribute("aria-hidden", "true");
    tub.innerHTML = tubSVG();

    var name = document.createElement("span");
    name.className = "row-flavor";
    name.textContent = item.flavor;
    var date = document.createElement("span");
    date.className = "row-date";
    date.textContent = shortDate(item.date_made);
    name.appendChild(date);

    var actions = document.createElement("span");
    actions.className = "row-actions";

    if (item.state === "full") {
      var fullBtn = document.createElement("button");
      fullBtn.type = "button";
      fullBtn.className = "btn btn-full";
      fullBtn.textContent = "Full";
      fullBtn.setAttribute("aria-label", "Ate a full container of " + item.flavor);
      fullBtn.addEventListener("click", function () { eatFull(item.id); });
      actions.appendChild(fullBtn);
    }

    var halfBtn = document.createElement("button");
    halfBtn.type = "button";
    halfBtn.className = "btn btn-half";
    halfBtn.textContent = "Half";
    halfBtn.setAttribute("aria-label", "Ate half a container of " + item.flavor);
    halfBtn.addEventListener("click", function () { eatHalf(item.id); });
    actions.appendChild(halfBtn);

    li.appendChild(tub);
    li.appendChild(name);
    li.appendChild(actions);
    return li;
  }

  function groupByFlavor(sorted) {
    var groups = [], index = {};
    sorted.forEach(function (item) {
      var key = item.flavor.toLowerCase();
      if (!(key in index)) { index[key] = groups.length; groups.push({ flavor: item.flavor, items: [] }); }
      groups[index[key]].items.push(item);
    });
    return groups;
  }

  function renderInventory(sorted) {
    var groups = groupByFlavor(sorted);
    summaryEl.innerHTML = "";
    summaryEmptyEl.hidden = groups.length > 0;

    groups.forEach(function (g) {
      var li = document.createElement("li");
      li.className = "summary-item";
      var key = g.flavor.toLowerCase();
      if (expanded[key]) li.classList.add("open");

      var head = document.createElement("button");
      head.type = "button";
      head.className = "summary-head";
      head.setAttribute("aria-expanded", expanded[key] ? "true" : "false");
      head.setAttribute("aria-label", g.items.length + " " + g.flavor);

      var count = document.createElement("span");
      count.className = "summary-count";
      count.setAttribute("aria-hidden", "true");
      count.innerHTML = countTubSVG(g.items.length);

      var flavor = document.createElement("span");
      flavor.className = "summary-flavor";
      flavor.textContent = g.flavor;

      var caret = document.createElement("span");
      caret.className = "summary-caret";
      caret.setAttribute("aria-hidden", "true");
      caret.textContent = "›";

      head.appendChild(count);
      head.appendChild(flavor);
      head.appendChild(caret);
      head.addEventListener("click", function () {
        expanded[key] = !expanded[key];
        li.classList.toggle("open", expanded[key]);
        head.setAttribute("aria-expanded", expanded[key] ? "true" : "false");
      });

      var dates = document.createElement("ul");
      dates.className = "summary-dates";
      g.items.forEach(function (item) {
        var d = document.createElement("li");
        var badge = document.createElement("span");
        badge.className = "date-badge";
        badge.textContent = shortDate(item.date_made);
        var lbl = document.createElement("span");
        lbl.textContent = g.flavor;
        var st = document.createElement("span");
        st.className = "date-state";
        st.textContent = item.state === "half" ? "½ tub" : "full";
        d.appendChild(badge); d.appendChild(lbl); d.appendChild(st);
        dates.appendChild(d);
      });

      li.appendChild(head);
      li.appendChild(dates);
      summaryEl.appendChild(li);
    });
  }

  function refreshSuggestions() {
    var seen = {}, names = [];
    inventory.forEach(function (item) {
      var key = item.flavor.toLowerCase();
      if (!seen[key]) { seen[key] = true; names.push(item.flavor); }
    });
    names.sort(function (a, b) { return a.localeCompare(b); });
    suggestions.innerHTML = "";
    names.forEach(function (n) {
      var opt = document.createElement("option"); opt.value = n; suggestions.appendChild(opt);
    });
  }

  /* ---------- analytics ---------- */

  function startOfWeek(d) {
    var x = new Date(d);
    var diff = (x.getDay() + 6) % 7; // Monday-based
    x.setDate(x.getDate() - diff); x.setHours(0, 0, 0, 0);
    return x;
  }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function periodKey(date, period) {
    var d = new Date(date);
    if (period === "year") return String(d.getFullYear());
    if (period === "month") return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
    var s = startOfWeek(d);
    return s.getFullYear() + "-" + pad2(s.getMonth() + 1) + "-" + pad2(s.getDate());
  }
  function periodLabel(key, period) {
    var p = key.split("-");
    if (period === "year") return key;
    if (period === "month") return MON[parseInt(p[1], 10) - 1] + " '" + p[0].slice(2);
    return parseInt(p[1], 10) + "/" + parseInt(p[2], 10);
  }
  function generatePeriods(period, n) {
    var out = [], now = new Date();
    for (var i = n - 1; i >= 0; i--) {
      var d;
      if (period === "year") d = new Date(now.getFullYear() - i, 0, 1);
      else if (period === "month") d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      else { d = startOfWeek(now); d.setDate(d.getDate() - 7 * i); }
      var key = periodKey(d, period);
      out.push({ key: key, label: periodLabel(key, period) });
    }
    return out;
  }

  function flavorTotals(list) {
    var m = {};
    list.forEach(function (c) { m[c.flavor] = (m[c.flavor] || 0) + 1; });
    return Object.keys(m).map(function (k) { return { flavor: k, count: m[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
  }

  function avgWaitByFlavor() {
    var m = {};
    consumptions.forEach(function (c) {
      if (!c.date_made) return;
      var d = daysBetween(new Date(c.consumed_at), parseDay(c.date_made));
      if (d < 0) d = 0;
      if (!m[c.flavor]) m[c.flavor] = { sum: 0, n: 0 };
      m[c.flavor].sum += d; m[c.flavor].n++;
    });
    return Object.keys(m).map(function (k) {
      var avg = Math.round(m[k].sum / m[k].n);
      return { label: k, value: avg + (avg === 1 ? " day" : " days"), sort: avg };
    }).sort(function (a, b) { return b.sort - a.sort; });
  }

  function sittingLongest() {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    return inventory.map(function (i) {
      var age = daysBetween(today, parseDay(i.date_made));
      if (age < 0) age = 0;
      return { label: i.flavor + (i.state === "half" ? " (½)" : ""), value: age + (age === 1 ? " day" : " days"), sort: age };
    }).sort(function (a, b) { return b.sort - a.sort; }).slice(0, 6);
  }

  function populateFlavorFilter() {
    var names = {};
    inventory.forEach(function (i) { names[i.flavor] = true; });
    consumptions.forEach(function (c) { names[c.flavor] = true; });
    var list = Object.keys(names).sort(function (a, b) { return a.localeCompare(b); });
    var sig = list.join("|");
    if (flavorFilterEl._sig === sig) return;
    flavorFilterEl._sig = sig;
    var cur = analyticsFlavor;
    flavorFilterEl.innerHTML = "";
    var all = document.createElement("option"); all.value = "all"; all.textContent = "All flavors";
    flavorFilterEl.appendChild(all);
    var stillValid = cur === "all";
    list.forEach(function (n) {
      var o = document.createElement("option");
      o.value = n.toLowerCase(); o.textContent = n;
      flavorFilterEl.appendChild(o);
      if (o.value === cur) stillValid = true;
    });
    if (!stillValid) analyticsFlavor = "all";
    flavorFilterEl.value = analyticsFlavor;
  }

  function renderBarList(el, items) {
    el.innerHTML = "";
    if (!items.length) { el.innerHTML = '<li class="muted-row">No data yet</li>'; return; }
    var max = items[0].count || 1;
    items.forEach(function (it) {
      var li = document.createElement("li");
      var name = document.createElement("span"); name.className = "bl-name"; name.textContent = it.flavor;
      var track = document.createElement("span"); track.className = "bl-track";
      var fill = document.createElement("span"); fill.className = "bl-fill";
      fill.style.width = Math.max(6, it.count / max * 100) + "%";
      track.appendChild(fill);
      var val = document.createElement("span"); val.className = "bl-val"; val.textContent = it.count;
      li.appendChild(name); li.appendChild(track); li.appendChild(val);
      el.appendChild(li);
    });
  }

  function renderStatList(el, items, emptyMsg) {
    el.innerHTML = "";
    if (!items.length) { el.innerHTML = '<li class="muted-row">' + emptyMsg + "</li>"; return; }
    items.forEach(function (it) {
      var li = document.createElement("li");
      var a = document.createElement("span"); a.textContent = it.label;
      var b = document.createElement("span"); b.className = "sl-val"; b.textContent = it.value;
      li.appendChild(a); li.appendChild(b);
      el.appendChild(li);
    });
  }

  function renderAnalytics() {
    populateFlavorFilter();
    var sel = analyticsFlavor;
    var cons = sel === "all" ? consumptions
      : consumptions.filter(function (c) { return c.flavor.toLowerCase() === sel; });

    statTotalEl.textContent = cons.length;
    var stock = sel === "all" ? inventory.length
      : inventory.filter(function (i) { return i.flavor.toLowerCase() === sel; }).length;
    statStockEl.textContent = stock;
    var top = flavorTotals(consumptions);
    statTopEl.textContent = top.length ? top[0].flavor : "—";

    // segmented control active state
    Array.prototype.forEach.call(periodSeg.querySelectorAll(".seg-btn"), function (b) {
      b.classList.toggle("is-active", b.dataset.period === analyticsPeriod);
    });
    periodWordEl.textContent = analyticsPeriod;

    // bar chart
    var nMap = { week: 8, month: 6, year: 5 };
    var periods = generatePeriods(analyticsPeriod, nMap[analyticsPeriod]);
    var counts = {};
    cons.forEach(function (c) {
      var k = periodKey(c.consumed_at, analyticsPeriod);
      counts[k] = (counts[k] || 0) + 1;
    });
    var max = 1;
    periods.forEach(function (p) { if ((counts[p.key] || 0) > max) max = counts[p.key]; });
    chartEl.innerHTML = "";
    periods.forEach(function (p) {
      var val = counts[p.key] || 0;
      var col = document.createElement("div"); col.className = "col";
      var v = document.createElement("span"); v.className = "bar-val"; v.textContent = val ? val : "";
      var bar = document.createElement("div"); bar.className = "bar";
      bar.style.height = (val ? Math.max(4, Math.round(val / max * 96)) : 2) + "px";
      var lab = document.createElement("span"); lab.className = "bar-lab"; lab.textContent = p.label;
      col.appendChild(v); col.appendChild(bar); col.appendChild(lab);
      chartEl.appendChild(col);
    });

    renderBarList(flavorBreakdownEl, flavorTotals(consumptions));
    renderStatList(waitListEl, avgWaitByFlavor(), "No wait data yet");
    renderStatList(sittingListEl, sittingLongest(), "Nothing in stock");

    analyticsEmptyEl.hidden = consumptions.length > 0 || inventory.length > 0;
  }

  /* ---------- actions ---------- */

  function findById(id) {
    for (var i = 0; i < inventory.length; i++) if (inventory[i].id === id) return inventory[i];
    return null;
  }
  function removeLocal(id) {
    inventory = inventory.filter(function (it) { return it.id !== id; });
  }

  // Finish (fully consume) a container: remove it, bump the empty tally, and
  // log a consumption for analytics. Offers an undo.
  function finishContainer(id) {
    var item = findById(id);
    if (!item) return;
    var snap = { flavor: item.flavor, date_made: item.date_made, state: item.state };
    animateRemoval(id, function () {
      removeLocal(id);
      emptiesCount++;
      consumptions.push({ id: makeId(), flavor: snap.flavor, date_made: snap.date_made, consumed_at: new Date().toISOString() });
      saveCache();
      render();
      armUndo({ type: "finish", snap: snap, emptyId: null, consId: null });

      if (usingSupabase) {
        Promise.all([
          db.from("containers").delete().eq("id", id),
          db.from("empties").insert({}).select("id"),
          db.from("consumptions").insert({ flavor: snap.flavor, date_made: snap.date_made }).select("id")
        ]).then(function (r) {
          if (r[0] && r[0].error) showNote("Couldn't reach the server — changes may not have saved.");
          else showNote("");
          if (pendingUndo && pendingUndo.type === "finish") {
            pendingUndo.emptyId = (r[1] && r[1].data && r[1].data[0]) ? r[1].data[0].id : null;
            pendingUndo.consId = (r[2] && r[2].data && r[2].data[0]) ? r[2].data[0].id : null;
          }
          fetchAll();
        }).catch(function (err) {
          console.error("finish failed", err);
          showNote("Couldn't reach the server — changes may not have saved.");
        });
      }
    });
  }

  function eatFull(id) {
    if (!findById(id)) return;
    finishContainer(id);
  }

  function eatHalf(id) {
    var item = findById(id);
    if (!item) return;
    if (item.state === "full") {
      mutate(
        function () { return db.from("containers").update({ state: "half" }).eq("id", id); },
        function () { item.state = "half"; }
      );
      armUndo({ type: "half", id: id });
    } else {
      finishContainer(id);
    }
  }

  function resetEmpties() {
    mutate(
      function () { return db.from("empties").delete().not("id", "is", null); },
      function () { emptiesCount = 0; }
    );
  }

  function addContainers(flavor, qty, dateISO) {
    var rows = [];
    for (var i = 0; i < qty; i++) rows.push({ flavor: flavor, state: "full", date_made: dateISO });
    var dec = Math.min(qty, emptiesCount);
    mutate(
      function () {
        return Promise.all([
          db.from("containers").insert(rows),
          decrementEmptiesRemote(dec)
        ]).then(function (results) {
          var bad = results.filter(function (r) { return r && r.error; })[0];
          return { error: bad ? bad.error : null };
        });
      },
      function () {
        rows.forEach(function (r) {
          inventory.push({ id: makeId(), flavor: r.flavor, state: r.state, date_made: r.date_made });
        });
        emptiesCount = Math.max(0, emptiesCount - dec);
      }
    );
  }

  function animateRemoval(id, done) {
    var row = listEl.querySelector('.row[data-id="' + id + '"]');
    if (!row || currentView !== "containers") { done(); return; }
    row.classList.add("removing");
    var finished = false;
    var finish = function () { if (finished) return; finished = true; done(); };
    row.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 250);
  }

  /* ---------- undo ---------- */

  function armUndo(action) {
    pendingUndo = action;
    undoLabelEl.textContent = action.type === "finish"
      ? "Finished " + action.snap.flavor
      : "Marked half";
    undoBar.hidden = false;
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 2600);
  }
  function hideUndo() {
    undoBar.hidden = true;
    pendingUndo = null;
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  }
  function performUndo() {
    var a = pendingUndo;
    hideUndo();
    if (!a) return;
    if (a.type === "half") undoHalf(a);
    else if (a.type === "finish") undoFinish(a);
  }

  function undoHalf(a) {
    var item = findById(a.id);
    if (item) item.state = "full";
    saveCache();
    render();
    if (usingSupabase) {
      db.from("containers").update({ state: "full" }).eq("id", a.id)
        .then(function () { fetchAll(); });
    }
  }

  function undoFinish(a) {
    // restore container
    inventory.push({ id: makeId(), flavor: a.snap.flavor, state: a.snap.state, date_made: a.snap.date_made });
    emptiesCount = Math.max(0, emptiesCount - 1);
    // remove one local consumption for this flavor (most recent)
    for (var i = consumptions.length - 1; i >= 0; i--) {
      if (consumptions[i].flavor === a.snap.flavor) { consumptions.splice(i, 1); break; }
    }
    saveCache();
    render();
    if (usingSupabase) {
      var ops = [db.from("containers").insert({ flavor: a.snap.flavor, state: a.snap.state, date_made: a.snap.date_made })];
      ops.push(a.emptyId ? db.from("empties").delete().eq("id", a.emptyId) : decrementEmptiesRemote(1));
      ops.push(a.consId ? db.from("consumptions").delete().eq("id", a.consId) : deleteLatestConsumptionRemote(a.snap.flavor));
      Promise.all(ops).then(function () { fetchAll(); }).catch(function (e) { console.error("undo failed", e); });
    }
  }

  undoBtn.addEventListener("click", performUndo);

  /* ---------- view switching ---------- */

  function switchView(view) {
    currentView = view;
    document.getElementById("view-containers").hidden = view !== "containers";
    document.getElementById("view-inventory").hidden = view !== "inventory";
    document.getElementById("view-analytics").hidden = view !== "analytics";
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      var active = t.dataset.view === view;
      t.classList.toggle("is-active", active);
      if (active) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
    t.addEventListener("click", function () { switchView(t.dataset.view); });
  });

  emptiesResetEl.addEventListener("click", function () {
    if (emptiesCount === 0) return;
    if (window.confirm("Reset the empty-container count to zero?")) resetEmpties();
  });

  Array.prototype.forEach.call(periodSeg.querySelectorAll(".seg-btn"), function (b) {
    b.addEventListener("click", function () { analyticsPeriod = b.dataset.period; renderAnalytics(); });
  });
  flavorFilterEl.addEventListener("change", function () {
    analyticsFlavor = flavorFilterEl.value; renderAnalytics();
  });

  /* ---------- add modal ---------- */

  function openModal() {
    modal.hidden = false;
    flavorInput.value = "";
    qtyInput.value = "1";
    dateInput.value = todayISO();
    flavorInput.focus();
  }
  function closeModal() { modal.hidden = true; }

  addBtn.addEventListener("click", openModal);
  modal.addEventListener("click", function (e) { if (e.target.hasAttribute("data-close")) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) closeModal(); });

  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var flavor = flavorInput.value.trim();
    var qty = Math.max(1, Math.min(99, parseInt(qtyInput.value, 10) || 1));
    var dateISO = dateInput.value || todayISO();
    if (!flavor) return;
    addContainers(flavor, qty, dateISO);
    closeModal();
  });

  /* ---------- realtime + boot ---------- */

  if (usingSupabase) {
    db.channel("glideria-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "containers" }, function () { fetchAll(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "empties" }, function () { fetchAll(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "consumptions" }, function () { fetchAll(); })
      .subscribe();

    document.addEventListener("visibilitychange", function () { if (!document.hidden) fetchAll(); });
  } else {
    showNote("Local-only mode: add your Supabase keys in config.js to sync across devices.");
  }

  render();
  fetchAll();
})();
