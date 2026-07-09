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

  var cfg = window.GLIDERIA_CONFIG || {};
  // Demo mode (?demo=1): runs entirely on-device, never touches the real
  // backend, and is seeded with sample data so friends can play freely.
  var isDemo = false;
  try { isDemo = new URLSearchParams(location.search).get("demo") === "1"; } catch (e) {}
  var CACHE_KEY = isDemo ? "glideriaDemoCache" : "glideriaCache";
  var usingSupabase = !isDemo && !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  var db = usingSupabase
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : null;

  // ----- DOM -----
  var listEl = document.getElementById("inventory-list");
  var emptyEl = document.getElementById("empty-state");
  var summaryEl = document.getElementById("summary-list");
  var summaryEmptyEl = document.getElementById("summary-empty");
  var syncNote = document.getElementById("sync-note");
  var demoBanner = document.getElementById("demo-banner");
  var demoResetEl = document.getElementById("demo-reset");
  var addBtn = document.getElementById("add-btn");
  var modal = document.getElementById("add-modal");
  var addForm = document.getElementById("add-form");
  var flavorInput = document.getElementById("flavor-input");
  var qtyInput = document.getElementById("qty-input");
  var dateInput = document.getElementById("date-input");
  var notesInput = document.getElementById("notes-input");
  var suggestions = document.getElementById("flavor-suggestions");
  var emptiesNumEl = document.getElementById("empties-num");
  var emptiesMinusEl = document.getElementById("empties-minus");
  var emptiesPlusEl = document.getElementById("empties-plus");
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
  // Deep link: /?tub=<id> opens the Flavors view focused on that container.
  var deepLinkTub = null;
  try { deepLinkTub = new URLSearchParams(location.search).get("tub"); } catch (e) {}
  var deepLinkHandled = false;

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

  // A tub is still "curing" (not ready to eat) for 24h after it was made.
  var CURE_MS = 24 * 60 * 60 * 1000;
  function isCuring(item) {
    if (!item || !item.created_at) return false;
    var created = new Date(item.created_at).getTime();
    var age = Date.now() - created;
    if (age < 0 || age >= CURE_MS) return false;
    // Don't show the timer for tubs backdated to an earlier day (i.e. logging
    // an older batch) — the ice cream was made well before it was entered.
    if (item.date_made) {
      var made = new Date(String(item.date_made).slice(0, 10) + "T00:00:00").getTime();
      if (created - made > CURE_MS + 12 * 60 * 60 * 1000) return false; // entered >36h after the made date
    }
    return true;
  }

  // Purple sand timer shown in place of the tub while a flavor is curing.
  function hourglassSVG() {
    return '<svg class="timer-svg" viewBox="0 0 24 26">' +
      '<rect x="4.6" y="2" width="14.8" height="2.8" rx="1"/>' +
      '<rect x="4.6" y="21.2" width="14.8" height="2.8" rx="1"/>' +
      '<path class="glass" d="M7 4.8 C 7 9.6 10 11.8 12 13 C 14 14.2 17 16.6 17 21.2"/>' +
      '<path class="glass" d="M17 4.8 C 17 9.6 14 11.8 12 13 C 10 14.2 7 16.6 7 21.2"/>' +
      '<path d="M8.2 5.6 Q 10 7.2 12 6.4 Q 14 5.6 15.8 6.4 C 14.4 9.6 12.9 11 12 12.1 C 11.1 11 9.6 9.6 8.2 6.4 Z"/>' +
      '<circle cx="12" cy="14.6" r="0.5"/>' +
      '<circle cx="12" cy="16" r="0.42"/>' +
      '<circle cx="12" cy="17.3" r="0.36"/>' +
      '<path d="M8 20.5 C 8.5 17.6 15.5 17.6 16 20.5 Z"/>' +
      '</svg>';
  }

  function tubSVG() {
    // Full = solid purple fill; Half = white top with a purple bottom half.
    // Fills are drawn first, outlines last so the stroke stays crisp.
    return '<svg class="tub-svg" viewBox="0 0 24 26">' +
      '<path class="body-fill" d="M3.6 7.6 h16.8 l-1.9 15.1 a1.4 1.4 0 0 1 -1.4 1.2 h-10.2 a1.4 1.4 0 0 1 -1.4 -1.2 z"/>' +
      '<path class="half-fill" d="M4.6 15.6 L19.4 15.6 L18.5 22.7 a1.4 1.4 0 0 1 -1.4 1.2 h-10.2 a1.4 1.4 0 0 1 -1.4 -1.2 Z"/>' +
      '<path class="lid-fill" d="M2.6 3.2 h18.8 a2.4 2.4 0 0 1 0 4.8 h-18.8 a2.4 2.4 0 0 1 0 -4.8 z"/>' +
      '<path class="tub-outline" d="M3.6 7.6 h16.8 l-1.9 15.1 a1.4 1.4 0 0 1 -1.4 1.2 h-10.2 a1.4 1.4 0 0 1 -1.4 -1.2 z"/>' +
      '<path class="tub-outline" d="M2.6 3.2 h18.8 a2.4 2.4 0 0 1 0 4.8 h-18.8 a2.4 2.4 0 0 1 0 -4.8 z"/>' +
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

  // Sample data for the demo sandbox (dates are relative to "now" each load).
  function demoSeed() {
    var now = Date.now(), DAY = 86400000;
    function iso(msAgo) { return new Date(now - msAgo).toISOString(); }
    function d(daysAgo) {
      var x = new Date(now - daysAgo * DAY);
      return x.getFullYear() + "-" + pad2(x.getMonth() + 1) + "-" + pad2(x.getDate());
    }
    var containers = [
      { id: makeId(), flavor: "Vanilla", state: "full", date_made: d(3), notes: null, created_at: iso(3 * DAY) },
      { id: makeId(), flavor: "Vanilla", state: "half", date_made: d(6), notes: null, created_at: iso(6 * DAY) },
      { id: makeId(), flavor: "Chocolate", state: "full", date_made: d(2), notes: "extra cocoa", created_at: iso(2 * DAY) },
      { id: makeId(), flavor: "Strawberry", state: "full", date_made: d(0), notes: "fresh local berries", created_at: iso(90 * 1000) },
      { id: makeId(), flavor: "Coffee", state: "full", date_made: d(4), notes: null, created_at: iso(4 * DAY) },
      { id: makeId(), flavor: "Mango", state: "half", date_made: d(5), notes: null, created_at: iso(5 * DAY) },
      { id: makeId(), flavor: "Pistachio", state: "full", date_made: d(1), notes: null, created_at: iso(1 * DAY) },
      { id: makeId(), flavor: "Cookies & Cream", state: "full", date_made: d(3), notes: null, created_at: iso(3 * DAY) },
      { id: makeId(), flavor: "Cookies & Cream", state: "full", date_made: d(3), notes: null, created_at: iso(3 * DAY) }
    ];
    var flavors = ["Vanilla", "Chocolate", "Coffee", "Mango", "Strawberry", "Pistachio", "Cookies & Cream", "Lemon", "Peach"];
    var consumptions = [];
    for (var i = 0; i < 20; i++) {
      var daysAgo = Math.floor(Math.random() * 42) + 1;
      var wait = Math.floor(Math.random() * 10) + 2;
      consumptions.push({
        id: makeId(),
        flavor: flavors[Math.floor(Math.random() * flavors.length)],
        date_made: d(daysAgo + wait),
        consumed_at: iso(daysAgo * DAY)
      });
    }
    return { containers: containers, empties: 3, consumptions: consumptions };
  }

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
    } catch (e) { /* fall through */ }
    if (isDemo) {
      var seed = demoSeed();
      emptiesCount = seed.empties;
      consumptions = seed.consumptions;
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(
          { containers: seed.containers, empties: seed.empties, consumptions: seed.consumptions }));
      } catch (e) { /* ignore */ }
      return seed.containers;
    }
    return [];
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
    if (!usingSupabase) { render(); maybeHandleDeepLink(); return Promise.resolve(); }
    return Promise.all([
      db.from("containers").select("*"),
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
      maybeHandleDeepLink();
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
    applyFocusClass(false); // keep a deep-link highlight through re-renders
  }

  // Swap curing hourglasses to the tub icon once 24h passes, without a full
  // re-render (so it never disrupts editing on the Inventory page).
  function refreshCuringIcons() {
    Array.prototype.forEach.call(listEl.querySelectorAll(".row"), function (row) {
      var item = findById(row.dataset.id);
      var tub = row.querySelector(".tub");
      if (!item || !tub) return;
      var curingNow = isCuring(item);
      if (curingNow === tub.classList.contains("curing")) return;
      if (curingNow) {
        tub.classList.add("curing");
        tub.innerHTML = hourglassSVG();
      } else {
        tub.classList.remove("curing");
        tub.dataset.state = item.state;
        tub.innerHTML = tubSVG();
      }
    });
  }

  function buildRow(item) {
    var li = document.createElement("li");
    li.className = "row";
    li.dataset.id = item.id;

    var tub = document.createElement("span");
    tub.className = "tub";
    tub.dataset.state = item.state;
    tub.setAttribute("aria-hidden", "true");
    if (isCuring(item)) {
      tub.classList.add("curing");
      tub.innerHTML = hourglassSVG();
    } else {
      tub.innerHTML = tubSVG();
    }

    var main = document.createElement("span");
    main.className = "row-main";
    var name = document.createElement("span");
    name.className = "row-flavor";
    name.textContent = item.flavor;
    var date = document.createElement("span");
    date.className = "row-date";
    date.textContent = shortDate(item.date_made);
    name.appendChild(date);
    main.appendChild(name);
    if (item.notes) {
      var note = document.createElement("span");
      note.className = "row-note";
      note.textContent = item.notes;
      note.title = item.notes;
      main.appendChild(note);
    }

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
    li.appendChild(main);
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
    // Flavors currently in stock...
    var byKey = {}, order = [];
    groupByFlavor(sorted).forEach(function (g) {
      var key = g.flavor.toLowerCase();
      byKey[key] = { flavor: g.flavor, items: g.items };
      order.push(key);
    });
    // ...plus flavors we've made before, so they stay on the list at 0.
    consumptions.forEach(function (c) {
      var key = c.flavor.toLowerCase();
      if (!(key in byKey)) { byKey[key] = { flavor: c.flavor, items: [] }; order.push(key); }
    });
    var groups = order.map(function (k) { return byKey[k]; })
      .sort(function (a, b) { return a.flavor.toLowerCase().localeCompare(b.flavor.toLowerCase()); });

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
      var low = g.items.length <= 1;
      head.setAttribute("aria-label", g.items.length + " " + g.flavor +
        (g.items.length === 0 ? " (out of stock)" : low ? " (low stock)" : ""));

      var count = document.createElement("span");
      count.className = "summary-count";
      count.setAttribute("aria-hidden", "true");
      count.innerHTML = countTubSVG(g.items.length);
      if (low) {
        var flag = document.createElement("span");
        flag.className = "low-flag";
        flag.textContent = "❗";
        count.appendChild(flag);
      }

      var flavor = document.createElement("span");
      flavor.className = "summary-flavor";
      flavor.textContent = g.flavor;

      head.appendChild(count);
      head.appendChild(flavor);

      if (g.items.length > 0) {
        var caret = document.createElement("span");
        caret.className = "summary-caret";
        caret.setAttribute("aria-hidden", "true");
        caret.textContent = "›";
        head.appendChild(caret);
        head.addEventListener("click", function () {
          expanded[key] = !expanded[key];
          li.classList.toggle("open", expanded[key]);
          head.setAttribute("aria-expanded", expanded[key] ? "true" : "false");
        });
      } else {
        head.classList.add("no-expand");
      }

      var dates = document.createElement("ul");
      dates.className = "summary-dates";
      g.items.forEach(function (item) {
        var d = document.createElement("li");
        var dateEdit = document.createElement("input");
        dateEdit.type = "date";
        dateEdit.className = "date-edit";
        dateEdit.value = String(item.date_made || "").slice(0, 10);
        dateEdit.setAttribute("aria-label", "Date made for this " + g.flavor + " container");
        dateEdit.addEventListener("change", function () {
          updateContainerDate(item.id, dateEdit.value);
        });
        var flavorEdit = document.createElement("input");
        flavorEdit.type = "text";
        flavorEdit.className = "flavor-edit";
        flavorEdit.value = g.flavor;
        flavorEdit.setAttribute("aria-label", "Flavor name for this container");
        flavorEdit.addEventListener("change", function () {
          updateContainerFlavor(item.id, flavorEdit.value);
        });
        flavorEdit.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); flavorEdit.blur(); }
        });
        var st = document.createElement("span");
        st.className = "date-state";
        st.textContent = item.state === "half" ? "half" : "full";

        var top = document.createElement("div");
        top.className = "sd-top";
        top.appendChild(dateEdit); top.appendChild(flavorEdit); top.appendChild(st);

        var noteEdit = document.createElement("input");
        noteEdit.type = "text";
        noteEdit.className = "note-edit";
        noteEdit.value = item.notes || "";
        noteEdit.placeholder = "Notes";
        noteEdit.setAttribute("aria-label", "Notes for this container");
        noteEdit.addEventListener("change", function () {
          updateContainerNotes(item.id, noteEdit.value);
        });

        d.appendChild(top);
        d.appendChild(noteEdit);
        var rowBtns = document.createElement("div");
        rowBtns.className = "sd-actions";
        if (window.GlideriaPrinter && navigator.bluetooth) {
          var printBtn = document.createElement("button");
          printBtn.type = "button";
          printBtn.className = "print-btn";
          printBtn.textContent = "🏷️ Print label";
          (function (c) {
            printBtn.addEventListener("click", function () { window.GlideriaPrinter.printLabel(c); });
          })(item);
          rowBtns.appendChild(printBtn);
        }
        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "delete-btn";
        delBtn.textContent = "🗑️ Delete tub";
        (function (c) {
          delBtn.addEventListener("click", function () { deleteContainer(c.id); });
        })(item);
        rowBtns.appendChild(delBtn);
        d.appendChild(rowBtns);
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
      return { label: i.flavor + (i.state === "half" ? " (half)" : ""), value: age + (age === 1 ? " day" : " days"), sort: age };
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
    var snap = { flavor: item.flavor, date_made: item.date_made, state: item.state, notes: item.notes || null, created_at: item.created_at || null };
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

  // Remove a tub outright (mistake, spoiled, tossed) WITHOUT logging a
  // consumption or bumping the empties count — so it leaves analytics alone.
  // Undoable, like the other actions.
  function deleteContainer(id) {
    var item = findById(id);
    if (!item) return;
    if (!window.confirm("Delete this " + item.flavor + " tub? It won't be counted as eaten.")) return;
    var snap = { flavor: item.flavor, date_made: item.date_made, state: item.state, notes: item.notes || null, created_at: item.created_at || null };
    animateRemoval(id, function () {
      removeLocal(id);
      saveCache();
      render();
      armUndo({ type: "delete", snap: snap });
      if (usingSupabase) {
        db.from("containers").delete().eq("id", id)
          .then(function (r) {
            showNote(r && r.error ? "Couldn't reach the server — changes may not have saved." : "");
            fetchAll();
          })
          .catch(function (err) { console.error("delete failed", err); showNote("Couldn't reach the server — changes may not have saved."); });
      }
    });
  }

  // Edit the "date made" of a specific container from the Inventory page.
  function updateContainerDate(id, dateISO) {
    var item = findById(id);
    if (!item || !dateISO || item.date_made === dateISO) return;
    mutate(
      function () { return db.from("containers").update({ date_made: dateISO }).eq("id", id); },
      function () { item.date_made = dateISO; }
    );
  }

  // Rename a specific container's flavor from the Inventory page.
  function updateContainerFlavor(id, flavor) {
    var item = findById(id);
    var name = (flavor || "").trim();
    if (!item || !name || item.flavor === name) { render(); return; }
    mutate(
      function () { return db.from("containers").update({ flavor: name }).eq("id", id); },
      function () { item.flavor = name; }
    );
  }

  // Manually adjust the empty-container tally by one (minus floored at 0).
  function incEmpties() {
    mutate(
      function () { return db.from("empties").insert({}); },
      function () { emptiesCount++; }
    );
  }
  function decEmpties() {
    if (emptiesCount <= 0) return;
    mutate(
      function () { return decrementEmptiesRemote(1); },
      function () { emptiesCount = Math.max(0, emptiesCount - 1); }
    );
  }

  // Print a label for each freshly-inserted row, one after another.
  function printLabels(list) {
    if (!window.GlideriaPrinter || !list || !list.length) return;
    var i = 0;
    (function next() {
      if (i >= list.length) return;
      var row = list[i++];
      Promise.resolve(window.GlideriaPrinter.printLabel(row)).then(next, next);
    })();
  }

  function addContainers(flavor, qty, dateISO, notes, printAfter) {
    var rows = [];
    for (var i = 0; i < qty; i++) {
      rows.push({ flavor: flavor, state: "full", date_made: dateISO, notes: notes || null });
    }
    var dec = Math.min(qty, emptiesCount);
    mutate(
      function () {
        return Promise.all([
          db.from("containers").insert(rows).select("*"),
          decrementEmptiesRemote(dec)
        ]).then(function (results) {
          var bad = results.filter(function (r) { return r && r.error; })[0];
          // Print the server rows (real id + created_at) so the QR is valid.
          if (!bad && printAfter && results[0] && results[0].data) printLabels(results[0].data);
          return { error: bad ? bad.error : null };
        });
      },
      function () {
        var nowISO = new Date().toISOString();
        rows.forEach(function (r) {
          inventory.push({ id: makeId(), flavor: r.flavor, state: r.state, date_made: r.date_made, notes: r.notes, created_at: nowISO });
        });
        emptiesCount = Math.max(0, emptiesCount - dec);
      }
    );
  }

  // Edit the notes of a specific container from the Inventory page.
  function updateContainerNotes(id, notes) {
    var item = findById(id);
    var val = (notes || "").trim();
    if (!item || (item.notes || "") === val) return;
    mutate(
      function () { return db.from("containers").update({ notes: val || null }).eq("id", id); },
      function () { item.notes = val || null; }
    );
  }

  // Deep link: focus the Flavors view on a specific container (from a QR link).
  var focusTubId = null;
  var focusTubTimer = null;

  function applyFocusClass(scroll) {
    if (!focusTubId) return;
    var row = listEl.querySelector('.row[data-id="' + focusTubId + '"]');
    if (!row) return;
    row.classList.add("tub-focus");
    if (scroll) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function focusTub(id) {
    focusTubId = id;
    if (focusTubTimer) clearTimeout(focusTubTimer);
    setTimeout(function () { applyFocusClass(true); }, 60);
    focusTubTimer = setTimeout(function () {
      focusTubId = null;
      var r = listEl.querySelector(".row.tub-focus");
      if (r) r.classList.remove("tub-focus");
    }, 6000);
  }

  function maybeHandleDeepLink() {
    if (!deepLinkTub || deepLinkHandled) return;
    deepLinkHandled = true;
    switchView("containers");
    if (!findById(deepLinkTub)) {
      showNote("That tub isn't in stock anymore 🍦");
      setTimeout(function () { showNote(""); }, 5000);
      return;
    }
    focusTub(deepLinkTub);
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
      : action.type === "delete"
      ? "Deleted " + action.snap.flavor
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
    else if (a.type === "delete") undoDelete(a);
  }

  function undoDelete(a) {
    inventory.push({ id: makeId(), flavor: a.snap.flavor, state: a.snap.state, date_made: a.snap.date_made, notes: a.snap.notes, created_at: a.snap.created_at });
    saveCache();
    render();
    if (usingSupabase) {
      var rec = { flavor: a.snap.flavor, state: a.snap.state, date_made: a.snap.date_made, notes: a.snap.notes };
      if (a.snap.created_at) rec.created_at = a.snap.created_at;
      db.from("containers").insert(rec).then(function () { fetchAll(); }).catch(function (e) { console.error("undo delete failed", e); });
    }
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
    inventory.push({ id: makeId(), flavor: a.snap.flavor, state: a.snap.state, date_made: a.snap.date_made, notes: a.snap.notes, created_at: a.snap.created_at });
    emptiesCount = Math.max(0, emptiesCount - 1);
    // remove one local consumption for this flavor (most recent)
    for (var i = consumptions.length - 1; i >= 0; i--) {
      if (consumptions[i].flavor === a.snap.flavor) { consumptions.splice(i, 1); break; }
    }
    saveCache();
    render();
    if (usingSupabase) {
      var rec = { flavor: a.snap.flavor, state: a.snap.state, date_made: a.snap.date_made, notes: a.snap.notes };
      if (a.snap.created_at) rec.created_at = a.snap.created_at;
      var ops = [db.from("containers").insert(rec)];
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

  emptiesPlusEl.addEventListener("click", incEmpties);
  emptiesMinusEl.addEventListener("click", decEmpties);

  Array.prototype.forEach.call(periodSeg.querySelectorAll(".seg-btn"), function (b) {
    b.addEventListener("click", function () { analyticsPeriod = b.dataset.period; renderAnalytics(); });
  });
  flavorFilterEl.addEventListener("change", function () {
    analyticsFlavor = flavorFilterEl.value; renderAnalytics();
  });

  var stockBtn = document.getElementById("stock-btn");
  if (stockBtn) stockBtn.addEventListener("click", function () {
    switchView("containers");
    window.scrollTo(0, 0);
  });

  /* ---------- consumed-tubs list (from the Analytics "consumed" stat) ---------- */

  var consumedModal = document.getElementById("consumed-modal");
  var consumedListEl = document.getElementById("consumed-list");
  var consumedTitleEl = document.getElementById("consumed-title");
  var consumedBtn = document.getElementById("consumed-btn");

  function formatConsumedAt(iso) {
    var dt = new Date(iso);
    if (isNaN(dt)) return "";
    var opts = { month: "short", day: "numeric" };
    if (dt.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    var date = dt.toLocaleDateString(undefined, opts);
    var time = dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return date + " · " + time;
  }

  function openConsumedList() {
    var sel = analyticsFlavor;
    var cons = (sel === "all"
      ? consumptions
      : consumptions.filter(function (c) { return c.flavor.toLowerCase() === sel; })).slice();
    cons.sort(function (a, b) { return new Date(b.consumed_at) - new Date(a.consumed_at); });

    var flavorName = sel === "all" ? "" : (cons[0] ? cons[0].flavor : sel);
    consumedTitleEl.textContent = (sel === "all" ? "Consumed tubs" : "Consumed " + flavorName) + " (" + cons.length + ")";

    consumedListEl.innerHTML = "";
    if (!cons.length) {
      consumedListEl.innerHTML = '<p class="muted-row">No consumed tubs yet.</p>';
    } else {
      cons.forEach(function (c) {
        var row = document.createElement("div");
        row.className = "consumed-item";
        var name = document.createElement("span");
        name.className = "ci-flavor";
        name.textContent = c.flavor;
        var when = document.createElement("span");
        when.className = "ci-when";
        when.textContent = formatConsumedAt(c.consumed_at);
        row.appendChild(name);
        row.appendChild(when);
        consumedListEl.appendChild(row);
      });
    }
    consumedModal.hidden = false;
  }

  function closeConsumedList() { consumedModal.hidden = true; }

  if (consumedBtn) consumedBtn.addEventListener("click", openConsumedList);
  if (consumedModal) consumedModal.addEventListener("click", function (e) {
    if (e.target.hasAttribute("data-consumed-close")) closeConsumedList();
  });

  /* ---------- add modal ---------- */

  function openModal() {
    modal.hidden = false;
    flavorInput.value = "";
    qtyInput.value = "1";
    dateInput.value = todayISO();
    notesInput.value = "";
    flavorInput.focus();
  }
  function closeModal() { modal.hidden = true; }

  addBtn.addEventListener("click", openModal);
  modal.addEventListener("click", function (e) { if (e.target.hasAttribute("data-close")) closeModal(); });

  var printStatus = document.getElementById("print-status");
  if (printStatus) printStatus.addEventListener("click", function (e) {
    if (e.target.hasAttribute("data-print-close")) printStatus.hidden = true;
    if (e.target.hasAttribute("data-print-test") && window.GlideriaPrinter) window.GlideriaPrinter.selfTest();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!modal.hidden) closeModal();
    if (consumedModal && !consumedModal.hidden) closeConsumedList();
  });

  function readAddForm() {
    var flavor = flavorInput.value.trim();
    if (!flavor) return null;
    return {
      flavor: flavor,
      qty: Math.max(1, Math.min(99, parseInt(qtyInput.value, 10) || 1)),
      dateISO: dateInput.value || todayISO(),
      notes: notesInput.value.trim()
    };
  }

  function submitAdd(printAfter) {
    var f = readAddForm();
    if (!f) { flavorInput.focus(); return; }
    addContainers(f.flavor, f.qty, f.dateISO, f.notes, printAfter);
    closeModal();
  }

  addForm.addEventListener("submit", function (e) { e.preventDefault(); submitAdd(false); });

  var addPrintBtn = document.getElementById("add-print-btn");
  if (addPrintBtn && window.GlideriaPrinter && navigator.bluetooth) {
    addPrintBtn.hidden = false;
    addPrintBtn.addEventListener("click", function () {
      if (!readAddForm()) { flavorInput.focus(); return; }
      // Start connecting now, while this tap still counts as a user gesture.
      window.GlideriaPrinter.warmup();
      submitAdd(true);
    });
  }

  /* ---------- realtime + boot ---------- */

  if (usingSupabase) {
    db.channel("glideria-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "containers" }, function () { fetchAll(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "empties" }, function () { fetchAll(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "consumptions" }, function () { fetchAll(); })
      .subscribe();

    document.addEventListener("visibilitychange", function () { if (!document.hidden) fetchAll(); });
  } else if (isDemo) {
    if (demoBanner) demoBanner.hidden = false;
  } else {
    showNote("Local-only mode: add your Supabase keys in config.js to sync across devices.");
  }

  if (demoResetEl) demoResetEl.addEventListener("click", function () {
    try { window.localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
    location.reload();
  });

  render();
  fetchAll();
  setInterval(refreshCuringIcons, 60000); // flip curing icons at the 24h mark
})();
