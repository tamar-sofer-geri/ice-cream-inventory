/* Geri's Glideria — label printing for the Phomemo M220 over Web Bluetooth.
 *
 * Protocol (Phomemo "m-series", ESC/POS raster) reverse-engineered by the
 * community (github.com/transcriptionstream/phomymo, vivier/phomemo-tools):
 *   BLE service 0xff00, write characteristic 0xff02, notify 0xff03.
 *   INIT (ESC @) -> heat/density -> media type -> raster header (GS v 0)
 *   -> 1-bit bitmap data (128-byte chunks) -> feed.
 *
 * The M220 has a 72-byte (576 px) print head at 203 dpi (8 px/mm) and a
 * right-aligned roll, so a narrow label's pixels are packed to the RIGHT of
 * each line.  Values below are easy to tweak while we dial it in.
 */
(function () {
  "use strict";

  // ---- adjustable config ------------------------------------------------
  var CFG = {
    labelWidthMm: 30,   // across the roll (print width)
    labelHeightMm: 40,  // along the feed (print length)
    rotate: 270,        // degrees clockwise to rotate the design before printing (0/90/180/270)
    align: "right",     // right-aligned roll on the M220
    density: 8,         // 1–8 (darkness)
    feedDots: 40,       // feed after printing
    mediaType: 0x0a,    // 0x0a = die-cut labels with gaps
    includeQR: true
  };
  var DPM = 8;                 // dots per mm (203 dpi)
  var HEAD_BYTES = 72;         // M220 print-head width in bytes (576 px)
  var SERVICE = 0xff00, SERVICE_FULL = "0000ff00-0000-1000-8000-00805f9b34fb";
  var WRITE_CHAR = 0xff02;

  var device = null, writeChar = null, writeNeedsResponse = false;

  // ---- tiny status UI ---------------------------------------------------
  function statusEl() { return document.getElementById("print-status"); }
  function statusBody() { return document.getElementById("print-status-body"); }
  function show() { var e = statusEl(); if (e) e.hidden = false; }
  function log(msg, isErr) {
    var b = statusBody();
    if (b) {
      var line = document.createElement("div");
      if (isErr) line.className = "print-err";
      line.textContent = msg;
      b.appendChild(line);
      b.scrollTop = b.scrollHeight;
    }
    (isErr ? console.error : console.log)("[print] " + msg);
  }
  function resetStatus(title) {
    show();
    var b = statusBody();
    if (b) b.innerHTML = "";
    var t = document.getElementById("print-status-title");
    if (t) t.textContent = title || "Printing…";
  }

  // ---- BLE --------------------------------------------------------------
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function props(c) {
    var p = c.properties, out = [];
    if (p.write) out.push("write");
    if (p.writeWithoutResponse) out.push("writeNR");
    if (p.notify) out.push("notify");
    if (p.indicate) out.push("indicate");
    if (p.read) out.push("read");
    return out.join(",") || "none";
  }
  function shortUuid(u) {
    // 0000ff02-0000-1000-8000-00805f9b34fb -> ff02
    var m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(u);
    return m ? m[1] : u;
  }

  async function connect() {
    if (device && device.gatt && device.gatt.connected && writeChar) return;
    if (!navigator.bluetooth) throw new Error("This browser has no Web Bluetooth. Use Chrome on Android.");
    if (!device) {
      log("Choose your printer in the popup (look for M220…)…");
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE, SERVICE_FULL, 0xff10, "0000ffe0-0000-1000-8000-00805f9b34fb", 0x18f0]
      });
      device.addEventListener("gattserverdisconnected", function () { writeChar = null; });
    }
    log("Connecting to " + (device.name || "printer") + "…");
    var server = await device.gatt.connect();
    await delay(300);

    // Enumerate everything so we can see what this M220 actually exposes.
    writeChar = null;
    var notifyChar = null, preferred = null;
    var services = [];
    try { services = await server.getPrimaryServices(); } catch (e) { log("getPrimaryServices failed: " + e.message, true); }
    log("Found " + services.length + " service(s):");
    for (var i = 0; i < services.length; i++) {
      var svc = services[i];
      var chars = [];
      try { chars = await svc.getCharacteristics(); } catch (e) { chars = []; }
      log("• svc " + shortUuid(svc.uuid));
      for (var j = 0; j < chars.length; j++) {
        var ch = chars[j], p = ch.properties;
        log("   – " + shortUuid(ch.uuid) + " [" + props(ch) + "]");
        if (p.write || p.writeWithoutResponse) {
          if (shortUuid(ch.uuid).toLowerCase() === "ff02") preferred = ch;
          else if (!writeChar) writeChar = ch;
        }
        if ((p.notify || p.indicate) && !notifyChar) notifyChar = ch;
      }
    }
    if (preferred) writeChar = preferred;
    if (!writeChar) throw new Error("No writable characteristic found on this printer.");
    writeNeedsResponse = !writeChar.properties.writeWithoutResponse;
    log("Using write char " + shortUuid(writeChar.uuid) + " (" + (writeNeedsResponse ? "with response" : "no response") + ").");

    // Listen to the printer's status channel, if any, so we can see it react.
    if (notifyChar) {
      try {
        await notifyChar.startNotifications();
        notifyChar.addEventListener("characteristicvaluechanged", function (ev) {
          var v = ev.target.value, hex = [];
          for (var k = 0; k < v.byteLength; k++) hex.push(("0" + v.getUint8(k).toString(16)).slice(-2));
          log("↩ printer: " + hex.join(" "));
        });
        log("Listening on " + shortUuid(notifyChar.uuid) + " for printer status.");
      } catch (e) { log("notify subscribe skipped: " + e.message); }
    }
    log("Connected.");
  }

  async function send(arr) {
    var buf = (arr instanceof Uint8Array) ? arr : new Uint8Array(arr);
    if (writeNeedsResponse) { await writeChar.writeValue(buf); return; }
    try { await writeChar.writeValueWithoutResponse(buf); }
    catch (e) { await writeChar.writeValue(buf); }
  }
  async function sendChunked(data) {
    for (var i = 0; i < data.length; i += 128) {
      await send(data.subarray(i, Math.min(i + 128, data.length)));
      await delay(20);
    }
  }

  // ---- ESC/POS commands -------------------------------------------------
  var INIT = [0x1b, 0x40];
  function HEAT(maxDots, heatTime, interval) { return [0x1b, 0x37, maxDots, heatTime, interval]; }
  function DENS(level) { return [0x1d, 0x7c, level]; }
  function MEDIA(type) { return [0x1f, 0x11, type]; }
  function RASTER_HEADER(wb, h) { return [0x1d, 0x76, 0x30, 0x00, wb & 0xff, (wb >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]; }
  function FEED(dots) { return [0x1b, 0x4a, dots & 0xff]; }
  var FOOTER = [0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00];
  function heatTimeFor(d) { var t = [15, 35, 55, 75, 95, 120, 150, 180]; return t[Math.max(0, Math.min(7, d - 1))]; }

  // ---- label rendering --------------------------------------------------
  function shortDateTime(container) {
    var dm = container.date_made ? new Date(String(container.date_made).slice(0, 10) + "T00:00:00") : null;
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var dateStr = dm ? (months[dm.getMonth()] + " " + dm.getDate() + ", " + dm.getFullYear()) : "";
    var t = container.created_at ? new Date(container.created_at) : null;
    var timeStr = "";
    if (t) {
      var h = t.getHours(), m = t.getMinutes();
      var ap = h < 12 ? "AM" : "PM";
      var h12 = h % 12; if (h12 === 0) h12 = 12;
      timeStr = h12 + ":" + (m < 10 ? "0" + m : m) + " " + ap;
    }
    return { date: dateStr, time: timeStr };
  }

  var FONT = "-apple-system, Helvetica, Arial, sans-serif";
  function setFont(ctx, size, weight) { ctx.font = (weight || "bold") + " " + size + "px " + FONT; }

  function fitFont(ctx, text, maxWidth, startPx, weight) {
    var size = startPx;
    do {
      setFont(ctx, size, weight);
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 2;
    } while (size > 12);
    return size;
  }

  // greedy word-wrap at the current ctx.font
  function wrapText(ctx, text, maxWidth) {
    var words = String(text).split(/\s+/), lines = [], cur = "";
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + " " + words[i] : words[i];
      if (!cur || ctx.measureText(test).width <= maxWidth) cur = test;
      else { lines.push(cur); cur = words[i]; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // shrink until the text wraps into <= maxLines lines that each fit maxWidth
  function fitWrapped(ctx, text, maxWidth, maxLines, startPx, weight) {
    for (var size = startPx; size >= 12; size -= 2) {
      setFont(ctx, size, weight);
      var lines = wrapText(ctx, text, maxWidth), ok = lines.length <= maxLines;
      for (var i = 0; ok && i < lines.length; i++) if (ctx.measureText(lines[i]).width > maxWidth) ok = false;
      if (ok) return { lines: lines, size: size };
    }
    setFont(ctx, 12, weight);
    return { lines: wrapText(ctx, text, maxWidth), size: 12 };
  }

  function rot() { return ((CFG.rotate % 360) + 360) % 360; }

  // Rotate the (readable) design canvas into the physical print bitmap, which
  // must stay labelWidthMm × labelHeightMm regardless of design orientation.
  function orient(design) {
    var r = rot();
    if (r === 0) return design;
    var pw = CFG.labelWidthMm * DPM, ph = CFG.labelHeightMm * DPM;
    var out = document.createElement("canvas");
    out.width = pw; out.height = ph;
    var ctx = out.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, pw, ph);
    if (r === 90) { ctx.translate(pw, 0); ctx.rotate(Math.PI / 2); }
    else if (r === 180) { ctx.translate(pw, ph); ctx.rotate(Math.PI); }
    else if (r === 270) { ctx.translate(0, ph); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(design, 0, 0);
    return out;
  }

  function renderLabel(container) {
    // Draw in the reading orientation; swap dims for 90/270 so text is upright
    // after orient() rotates it onto the print bitmap.
    var pw = CFG.labelWidthMm * DPM, ph = CFG.labelHeightMm * DPM;
    var r = rot();
    var w = (r === 90 || r === 270) ? ph : pw;
    var h = (r === 90 || r === 270) ? pw : ph;
    var canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#000"; ctx.textBaseline = "top";

    var pad = 12;

    // QR on the right (deep link to this tub); build first so text knows its width
    var qr = null, qrCount = 0, qrCell = 0, qrDim = 0;
    if (CFG.includeQR && window.qrcode) {
      try {
        var url = location.origin + location.pathname + "?tub=" + container.id;
        qr = window.qrcode(0, "M"); qr.addData(url); qr.make();
        qrCount = qr.getModuleCount();
        var target = Math.min(h - pad * 2, Math.round(w * 0.42));
        qrCell = Math.max(1, Math.floor(target / qrCount));
        qrDim = qrCell * qrCount;
      } catch (e) { log("QR skipped: " + e.message); qr = null; }
    }

    // Text column fills the space left of the QR.
    var textW = (qrDim ? (w - qrDim - pad * 3) : (w - pad * 2));
    var cx = pad + textW / 2;
    var gap = 4;

    var fl = fitWrapped(ctx, container.flavor, textW, 3, 46, "bold");
    var dt = shortDateTime(container);
    var dtSize = 30;
    if (dt.date) dtSize = Math.min(dtSize, fitFont(ctx, dt.date, textW, dtSize, "bold"));
    if (dt.time) dtSize = Math.min(dtSize, fitFont(ctx, dt.time, textW, dtSize, "bold"));

    var blockH = fl.lines.length * fl.size + (fl.lines.length - 1) * gap;
    if (dt.date) blockH += 12 + dtSize;
    if (dt.time) blockH += gap + dtSize;
    var y = Math.max(pad, Math.floor((h - blockH) / 2));

    ctx.textAlign = "center";
    setFont(ctx, fl.size, "bold");
    for (var i = 0; i < fl.lines.length; i++) { ctx.fillText(fl.lines[i], cx, y); y += fl.size + gap; }
    y += 12 - gap;
    setFont(ctx, dtSize, "bold");
    if (dt.date) { ctx.fillText(dt.date, cx, y); y += dtSize + gap; }
    if (dt.time) { ctx.fillText(dt.time, cx, y); }

    if (qr) {
      var ox = w - pad - qrDim, oy = Math.floor((h - qrDim) / 2);
      ctx.fillStyle = "#000";
      for (var r = 0; r < qrCount; r++) {
        for (var c = 0; c < qrCount; c++) {
          if (qr.isDark(r, c)) ctx.fillRect(ox + c * qrCell, oy + r * qrCell, qrCell, qrCell);
        }
      }
    }
    return canvas;
  }

  // canvas -> 1-bit raster packed into HEAD_BYTES-wide lines (right-aligned)
  function rasterize(canvas) {
    var w = canvas.width, h = canvas.height;
    var data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    var out = new Uint8Array(HEAD_BYTES * h);
    var headPx = HEAD_BYTES * 8;
    var xOffset = CFG.align === "right" ? Math.max(0, headPx - w)
                : CFG.align === "center" ? Math.max(0, Math.floor((headPx - w) / 2)) : 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (data[i + 3] > 128 && lum < 128) {
          var px = xOffset + x;
          out[y * HEAD_BYTES + (px >> 3)] |= (1 << (7 - (px & 7)));
        }
      }
    }
    return { bytes: out, widthBytes: HEAD_BYTES, heightLines: h };
  }

  // ---- public: print one container's label ------------------------------
  async function printLabel(container) {
    resetStatus("Printing " + container.flavor + " label");
    try {
      await connect();
      log("Building label (" + CFG.labelWidthMm + "×" + CFG.labelHeightMm + "mm)…");
      var raster = rasterize(orient(renderLabel(container)));
      log("Sending to printer…");
      await send(INIT); await delay(100);
      await send(HEAT(7, heatTimeFor(CFG.density), 2)); await delay(30);
      await send(DENS(CFG.density)); await delay(30);
      await send(MEDIA(CFG.mediaType)); await delay(30);
      await send(RASTER_HEADER(raster.widthBytes, raster.heightLines));
      await sendChunked(raster.bytes);
      await delay(300);
      await send(FEED(CFG.feedDots));
      await send(FOOTER);
      await delay(500);
      log("Done! 🎉");
    } catch (e) {
      log((e && e.message) || String(e), true);
      log("Tip: make sure the printer is on, and you're in Chrome on Android.", true);
    }
  }

  // ---- diagnostics: prove commands reach the printer --------------------
  // Connects, enumerates, then just feeds paper. If the motor moves, the
  // transport is good and any "nothing prints" issue is in the raster.
  async function selfTest() {
    resetStatus("Printer self-test");
    try {
      await connect();
      log("Sending INIT + a paper feed…");
      await send(INIT); await delay(120);
      await send(FEED(80));
      await delay(400);
      log("If the paper advanced, transport works. If not, the write");
      log("characteristic/protocol is wrong — copy the service list above.");
    } catch (e) {
      log((e && e.message) || String(e), true);
    }
  }

  window.GlideriaPrinter = {
    printLabel: printLabel, selfTest: selfTest, config: CFG,
    previewLabel: function (c) { return orient(renderLabel(c)); }
  };
})();
