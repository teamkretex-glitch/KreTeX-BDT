// KreTeX AI — live dashboard (Delta Exchange India)
// Data source: https://api.india.delta.exchange  +  wss://socket.india.delta.exchange
// Layer 1: REST polling (hamesha kaam karta hai). Layer 2: WebSocket ticker (faster ticks).

const REST = "https://api.india.delta.exchange";
const WS_URL = "wss://socket.india.delta.exchange";
const SYMBOLS = ["BTCUSD", "ETHUSD", "SOLUSD", "XAUTUSD"];
const DECIMALS = { BTCUSD: 1, ETHUSD: 2, SOLUSD: 3, XAUTUSD: 2 };
const TF_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

const state = {
  symbol: "BTCUSD",
  tf: "15m",
  tickers: {},        // symbol -> { price, mark, high, low, open, turnover }
  closes: [],         // latest closes for the signal
  loadToken: 0,       // stale-response guard
  restOk: false,
  wsOk: false,
};

const $ = (id) => document.getElementById(id);

// ---------- helpers ----------
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const dec = (sym) => DECIMALS[sym] ?? 2;
const fmt = (n, d = 2) =>
  isNaN(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtBig = (n) => {
  if (isNaN(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
};

async function getJSON(path) {
  const res = await fetch(REST + path);
  if (!res.ok) throw new Error(path + " → HTTP " + res.status);
  const json = await res.json();
  if (json.success === false) throw new Error(path + " → API error");
  return json.result;
}

function setStatus() {
  const el = $("status");
  el.classList.remove("live", "error");
  if (state.wsOk) {
    el.classList.add("live");
    $("status-text").textContent = "Live (WebSocket)";
  } else if (state.restOk) {
    el.classList.add("live");
    $("status-text").textContent = "Live (polling)";
  } else {
    el.classList.add("error");
    $("status-text").textContent = "Disconnected — retrying";
  }
}

// ---------- Chart ----------
const chartEl = $("chart");
const chart = LightweightCharts.createChart(chartEl, {
  width: chartEl.clientWidth,
  height: chartEl.clientHeight || 460,
  layout: { background: { color: "#13161b" }, textColor: "#8a92a0" },
  grid: { vertLines: { color: "#1b1f26" }, horzLines: { color: "#1b1f26" } },
  rightPriceScale: { borderColor: "#232830" },
  timeScale: {
    borderColor: "#232830",
    timeVisible: true,
    secondsVisible: false,
    tickMarkFormatter: (t) => {
      const d = new Date(t * 1000);
      return state.tf === "1d"
        ? d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" })
        : d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
    },
  },
  localization: {
    timeFormatter: (t) =>
      new Date(t * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }),
  },
  crosshair: { mode: 0 },
});

const candles = chart.addCandlestickSeries({
  upColor: "#2cb72c", downColor: "#e5484d",
  borderUpColor: "#2cb72c", borderDownColor: "#e5484d",
  wickUpColor: "#2cb72c", wickDownColor: "#e5484d",
});
const volume = chart.addHistogramSeries({
  priceFormat: { type: "volume" },
  priceScaleId: "vol",
});
chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

new ResizeObserver(() => {
  chart.applyOptions({ width: chartEl.clientWidth, height: chartEl.clientHeight });
}).observe(chartEl);

async function fetchCandles(symbol, tf, count) {
  const end = Math.floor(Date.now() / 1000);              // seconds
  const start = end - TF_SECONDS[tf] * count;
  const rows = await getJSON(
    `/v2/history/candles?resolution=${tf}&symbol=${symbol}&start=${start}&end=${end}`
  );
  const seen = new Set();
  return rows
    .map((c) => ({
      time: Number(c.time),
      open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close),
      volume: num(c.volume),
    }))
    .filter((c) => c.time && !isNaN(c.close) && !seen.has(c.time) && seen.add(c.time))
    .sort((a, b) => a.time - b.time);                      // oldest → newest (flat chart fix)
}

async function loadChart() {
  const token = ++state.loadToken;
  try {
    const data = await fetchCandles(state.symbol, state.tf, 300);
    if (token !== state.loadToken) return;                 // user ne symbol/tf badal diya
    candles.setData(data.map(({ volume: _v, ...c }) => c));
    volume.setData(
      data.map((c) => ({
        time: c.time,
        value: isNaN(c.volume) ? 0 : c.volume,
        color: c.close >= c.open ? "rgba(44,183,44,0.35)" : "rgba(229,72,77,0.35)",
      }))
    );
    chart.timeScale().fitContent();
    state.closes = data.map((c) => c.close);
    state.restOk = true;
    updateSignal();
  } catch (e) {
    console.error("loadChart:", e);
    state.restOk = false;
  }
  setStatus();
}

async function refreshLastCandles() {
  const symbol = state.symbol, tf = state.tf;
  try {
    const data = await fetchCandles(symbol, tf, 3);
    if (symbol !== state.symbol || tf !== state.tf) return;
    data.forEach((c) => {
      try {
        candles.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
        volume.update({
          time: c.time,
          value: isNaN(c.volume) ? 0 : c.volume,
          color: c.close >= c.open ? "rgba(44,183,44,0.35)" : "rgba(229,72,77,0.35)",
        });
      } catch (_) { /* purani candle update skip */ }
    });
    if (data.length) {
      state.closes[state.closes.length - 1] = data[data.length - 1].close;
      updateSignal();
    }
    state.restOk = true;
  } catch (e) {
    console.error("refreshLast:", e);
    state.restOk = false;
  }
  setStatus();
}

// ---------- Tickers / watchlist ----------
function applyTicker(symbol, t) {
  const prev = state.tickers[symbol]?.price;
  const price = num(t.close ?? t.mark_price);
  if (isNaN(price)) return;
  state.tickers[symbol] = {
    price,
    mark: num(t.mark_price),
    high: num(t.high),
    low: num(t.low),
    open: num(t.open),
    turnover: num(t.turnover_usd ?? t.turnover),
    prev,
  };
  renderMarkets();
  if (symbol === state.symbol) renderStats();
}

async function pollTickers() {
  await Promise.all(
    SYMBOLS.map(async (sym) => {
      try {
        applyTicker(sym, await getJSON(`/v2/tickers/${sym}`));
        state.restOk = true;
      } catch (e) {
        console.error("ticker", sym, e);
        state.restOk = false;
      }
    })
  );
  setStatus();
}

function changePct(t) {
  if (!t || isNaN(t.open) || t.open === 0) return NaN;
  return ((t.price - t.open) / t.open) * 100;
}

function renderMarkets() {
  const ul = $("market-list");
  if (!ul.children.length) {
    SYMBOLS.forEach((sym) => {
      const li = document.createElement("li");
      li.dataset.sym = sym;
      li.tabIndex = 0;
      li.innerHTML =
        `<span class="m-sym">${sym}</span><span class="m-price" data-p>—</span>` +
        `<span class="m-sub">Perpetual</span><span class="m-chg" data-c>—</span>`;
      li.addEventListener("click", () => selectSymbol(sym));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") selectSymbol(sym); });
      ul.appendChild(li);
    });
  }
  SYMBOLS.forEach((sym) => {
    const li = ul.querySelector(`[data-sym="${sym}"]`);
    li.classList.toggle("active", sym === state.symbol);
    const t = state.tickers[sym];
    if (!t) return;
    const p = li.querySelector("[data-p]");
    p.textContent = fmt(t.price, dec(sym));
    flash(p, t.price, t.prev);
    const c = changePct(t);
    const ce = li.querySelector("[data-c]");
    ce.textContent = isNaN(c) ? "—" : (c >= 0 ? "+" : "") + c.toFixed(2) + "%";
    ce.className = "m-chg " + (c >= 0 ? "up" : "down");
  });
}

function flash(el, now, prev) {
  if (prev === undefined || now === prev) return;
  const cls = now > prev ? "flash-up" : "flash-down";
  el.classList.remove("flash-up", "flash-down");
  void el.offsetWidth;
  el.classList.add(cls);
}

function renderStats() {
  const t = state.tickers[state.symbol];
  $("symbol-name").textContent = state.symbol;
  if (!t) return;
  const d = dec(state.symbol);
  const lp = $("last-price");
  lp.textContent = fmt(t.price, d);
  lp.className = "val " + (t.price >= (t.prev ?? t.price) ? "up" : "down");
  const c = changePct(t);
  const ce = $("chg");
  ce.textContent = isNaN(c) ? "—" : (c >= 0 ? "+" : "") + c.toFixed(2) + "%";
  ce.className = "val " + (c >= 0 ? "up" : "down");
  $("mark").textContent = fmt(t.mark, d);
  $("high").textContent = fmt(t.high, d);
  $("low").textContent = fmt(t.low, d);
  $("vol").textContent = isNaN(t.turnover) ? "—" : "$" + fmtBig(t.turnover);
  document.title = `${fmt(t.price, d)} ${state.symbol} — KreTeX AI`;
}

// ---------- Order book ----------
async function refreshBook() {
  const symbol = state.symbol;
  try {
    const ob = await getJSON(`/v2/l2orderbook/${symbol}?depth=12`);
    if (symbol !== state.symbol) return;
    const asks = (ob.sell || []).slice(0, 10).map((r) => ({ p: num(r.price), s: num(r.size) }));
    const bids = (ob.buy || []).slice(0, 10).map((r) => ({ p: num(r.price), s: num(r.size) }));
    const max = Math.max(...asks.map((r) => r.s), ...bids.map((r) => r.s), 1);
    const d = dec(symbol);
    const row = (r, cls) =>
      `<div class="row ${cls}"><div class="bar" style="width:${(r.s / max) * 100}%"></div>` +
      `<span class="p">${fmt(r.p, d)}</span><span>${fmt(r.s, 0)}</span></div>`;
    // asks: sabse door wala upar, best ask spread ke paas
    $("asks").innerHTML = asks.slice().sort((a, b) => b.p - a.p).map((r) => row(r, "ask")).join("");
    $("bids").innerHTML = bids.slice().sort((a, b) => b.p - a.p).map((r) => row(r, "bid")).join("");
    if (asks.length && bids.length) {
      const bestAsk = Math.min(...asks.map((r) => r.p));
      const bestBid = Math.max(...bids.map((r) => r.p));
      $("spread").textContent = "Spread " + fmt(bestAsk - bestBid, d);
    }
  } catch (e) {
    console.error("book:", e);
  }
}

// ---------- AI signal (EMA 9/21 + RSI 14) ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function rsi(values, period = 14) {
  if (values.length <= period) return NaN;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
function updateSignal() {
  const v = state.closes;
  if (v.length < 30) return;
  const e9 = ema(v, 9), e21 = ema(v, 21), r = rsi(v);
  let label = "Neutral", cls = "";
  if (e9 > e21 && r < 70) { label = "Bullish"; cls = "up"; }
  else if (e9 < e21 && r > 30) { label = "Bearish"; cls = "down"; }
  else if (r >= 70) { label = "Overbought"; cls = "down"; }
  else if (r <= 30) { label = "Oversold"; cls = "up"; }
  const m = $("signal-main");
  m.textContent = label;
  m.className = "signal-main " + cls;
  const d = dec(state.symbol);
  $("signal-meta").textContent =
    `${state.symbol} · ${state.tf} · EMA9 ${fmt(e9, d)} · EMA21 ${fmt(e21, d)} · RSI ${r.toFixed(1)}`;
}

// ---------- WebSocket (live ticks) ----------
let ws, wsRetry = 0;
function connectWS() {
  try { ws = new WebSocket(WS_URL); } catch (e) { return scheduleWS(); }
  ws.onopen = () => {
    wsRetry = 0;
    ws.send(JSON.stringify({
      type: "subscribe",
      payload: { channels: [{ name: "v2/ticker", symbols: SYMBOLS }] },
    }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "v2/ticker" && msg.symbol && SYMBOLS.includes(msg.symbol)) {
      state.wsOk = true;
      applyTicker(msg.symbol, msg);
      setStatus();
    }
  };
  ws.onclose = ws.onerror = () => {
    state.wsOk = false;
    setStatus();
    scheduleWS();
  };
}
function scheduleWS() {
  clearTimeout(scheduleWS.t);
  scheduleWS.t = setTimeout(connectWS, Math.min(1000 * 2 ** wsRetry++, 15000));
}

// ---------- Controls ----------
function selectSymbol(sym) {
  state.symbol = sym;
  renderMarkets();
  renderStats();
  $("asks").innerHTML = $("bids").innerHTML = "";
  loadChart();
  refreshBook();
}

$("tf-buttons").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tf]");
  if (!btn) return;
  state.tf = btn.dataset.tf;
  document.querySelectorAll("#tf-buttons button").forEach((b) => b.classList.toggle("active", b === btn));
  loadChart();
});

// ---------- Boot ----------
renderMarkets();
pollTickers().then(renderStats);
loadChart();
refreshBook();
connectWS();

setInterval(pollTickers, 4000);        // WS chale ya na chale, prices fresh rahenge
setInterval(refreshLastCandles, 2500); // current candle live update
setInterval(refreshBook, 2000);        // order book live
