require('dotenv').config();
const { Telegraf } = require('telegraf');
const ccxt = require('ccxt');
const schedule = require('node-schedule');

// ======== 基本環境 ========
const bot = new Telegraf(process.env.BOT_TOKEN);
const LIVE = String(process.env.LIVE || '0') === '1';
const DEFAULT_TYPE = process.env.BINGX_TYPE || 'swap';
const AUTO_CRON = process.env.AUTO_CRON || '*/3 * * * *'; // 每3分鐘掃描一次

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT', 'XRP/USDT', 'ADA/USDT', 'LINK/USDT'];
const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d'];
const HTF_TIMEFRAMES = ['30m', '1h', '4h', '1d'];

// ======== SMC / OB 參數 ========
const SWING_LOOKBACK = 5;
const ATR_PERIOD = 14;
const ATR_MULT = 0.6;
const OB_USE_WICKS = true;
const ENTRY_MODE = 'ob_mid';
const SL_MODE = 'ob';
const SL_ATR_PAD = 0.1;
const TP_R_MULTS = [1.0, 1.5, 2.0];

const exOpt = {
  enableRateLimit: true,
  apiKey: process.env.API_KEY || undefined,
  secret: process.env.API_SECRET || undefined,
  options: { defaultType: DEFAULT_TYPE }
};
const exchange = new ccxt.bingx(exOpt);

const toFixed = (n, p = 2) => (n == null || isNaN(n)) ? '' : Number(n).toFixed(p);

function candidateSymbols(symbol) {
  return symbol.includes(':USDT') ? [symbol] : [symbol, `${symbol}:USDT`];
}

async function fetchTickerFlex(symbol) {
  for (const s of candidateSymbols(symbol)) {
    try {
      const t = await exchange.fetchTicker(s);
      return { ...t, _symbol: s };
    } catch (_) { }
  }
  throw new Error(`Ticker 不可用：${symbol}`);
}

async function fetchOHLCVFlex(symbol, timeframe, limit = 300) {
  for (const s of candidateSymbols(symbol)) {
    try {
      return await exchange.fetchOHLCV(s, timeframe, undefined, limit);
    } catch (_) { }
  }
  throw new Error(`OHLCV 不可用：${symbol}`);
}

function calcATR(c, period = 14) {
  if (!c || c.length < period + 1) return null;
  const TRs = [];
  for (let i = 1; i < c.length; i++) {
    const high = c[i][2], low = c[i][3], prevClose = c[i - 1][4];
    TRs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const last = TRs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / last.length;
}

function swingHigh(c, look = 5) {
  const n = c.length;
  for (let i = n - look - 2; i >= look; i--) {
    const h = c[i][2]; let L = true, R = true;
    for (let k = 1; k <= look; k++) {
      if (c[i - k][2] >= h) L = false;
      if (c[i + k][2] >= h) R = false;
    }
    if (L && R) return { idx: i, price: h };
  }
  return null;
}

function swingLow(c, look = 5) {
  const n = c.length;
  for (let i = n - look - 2; i >= look; i--) {
    const l = c[i][3]; let L = true, R = true;
    for (let k = 1; k <= look; k++) {
      if (c[i - k][3] <= l) L = false;
      if (c[i + k][3] <= l) R = false;
    }
    if (L && R) return { idx: i, price: l };
  }
  return null;
}

function findOrderBlock(candles, bosIndex, isUp) {
  for (let j = bosIndex - 1; j >= Math.max(0, bosIndex - 50); j--) {
    const o = candles[j][1], c = candles[j][4], h = candles[j][2], l = candles[j][3];
    const isBear = c < o, isBull = c > o;
    if (isUp && isBear) return OB_USE_WICKS ? { low: l, high: h, idx: j } : { low: Math.min(o, c), high: Math.max(o, c), idx: j };
    if (!isUp && isBull) return OB_USE_WICKS ? { low: l, high: h, idx: j } : { low: Math.min(o, c), high: Math.max(o, c), idx: j };
  }
  return null;
}

function pickEntryFromOB(ob, dir) {
  if (ENTRY_MODE === 'ob_mid') return (ob.low + ob.high) / 2;
  if (ENTRY_MODE === 'ob_top') return dir === 'LONG' ? ob.high : ob.low;
  if (ENTRY_MODE === 'ob_bottom') return dir === 'LONG' ? ob.low : ob.high;
  return (ob.low + ob.high) / 2;
}

function genSignal_OB_Only(candles, timeframe) {
  if (!candles || candles.length < 80) return null;
  const last = candles.at(-1);
  const close = last[4];
  const atr = calcATR(candles, ATR_PERIOD);
  if (!atr) return null;

  const sh = swingHigh(candles, SWING_LOOKBACK);
  const sl = swingLow(candles, SWING_LOOKBACK);
  if (!sh || !sl) return null;

  const body = Math.abs(last[4] - last[1]);
  const volOK = body >= ATR_MULT * atr;

  if (close > sh.price && volOK) {
    const bosIdx = candles.length - 1;
    const ob = findOrderBlock(candles, bosIdx, true);
    if (!ob) return null;
    if (!(close <= ob.high && close >= ob.low)) return null;

    const entry = pickEntryFromOB(ob, 'LONG');
    const stop = ob.low - atr * SL_ATR_PAD;
    const risk = entry - stop;
    const tps = TP_R_MULTS.map(r => entry + r * risk);

    return { dir: 'LONG', timeframe, entry, stop, tps, obLow: ob.low, obHigh: ob.high };
  }

  if (close < sl.price && volOK) {
    const bosIdx = candles.length - 1;
    const ob = findOrderBlock(candles, bosIdx, false);
    if (!ob) return null;
    if (!(close <= ob.high && close >= ob.low)) return null;

    const entry = pickEntryFromOB(ob, 'SHORT');
    const stop = ob.high + atr * SL_ATR_PAD;
    const risk = stop - entry;
    const tps = TP_R_MULTS.map(r => entry - r * risk);

    return { dir: 'SHORT', timeframe, entry, stop, tps, obLow: ob.low, obHigh: ob.high };
  }

  return null;
}

async function analyzeOne(symbol, tfList = TIMEFRAMES) {
  const t = await fetchTickerFlex(symbol);
  for (const tf of tfList) {
    const c = await fetchOHLCVFlex(symbol, tf, 300);
    const sg = genSignal_OB_Only(c, tf);
    if (sg) return { symbol: t._symbol, price: t.last, pct: t.percentage, ...sg };
  }
  return { symbol: t._symbol, price: t.last, pct: t.percentage, dir: null };
}

async function analyzeAll(tfList = TIMEFRAMES) {
  const out = [];
  for (const s of SYMBOLS) {
    try { out.push(await analyzeOne(s, tfList)); }
    catch (e) { out.push({ symbol: s, error: e.message }); }
  }
  return out;
}

function fmtSignal(rows, onlyHits = false) {
  let txt = onlyHits ? '📊 潛在進場訊號（僅 OB 內）\n\n' : '📈 合約即時報價與潛在進場（僅 OB 內）\n\n';
  for (const r of rows) {
    if (r.error) { txt += `${r.symbol}\n錯誤：${r.error}\n\n`; continue; }
    if (!onlyHits) txt += `${r.symbol}\n價格：${toFixed(r.price, 4)}\n漲跌：${toFixed(r.pct ?? 0, 2)}%\n`;
    if (r.dir) {
      txt += `— 訊號：${r.dir}（${r.timeframe}）\nOB：${toFixed(r.obLow, 4)} ~ ${toFixed(r.obHigh, 4)}\n入場：${toFixed(r.entry, 4)}｜止損：${toFixed(r.stop, 4)}\nTP1/2/3：${toFixed(r.tps[0], 4)} / ${toFixed(r.tps[1], 4)} / ${toFixed(r.tps[2], 4)}\n\n`;
    } else if (!onlyHits) {
      txt += `— 訊號：無\n\n`;
    }
  }
  return txt.trim();
}

// ===== Telegram 指令 =====
bot.command('signal', async (ctx) => {
  try { const rows = await analyzeAll(TIMEFRAMES); await ctx.reply(fmtSignal(rows)); }
  catch (e) { await ctx.reply(`查詢失敗：${e.message}`); }
});

bot.command('signal_htf', async (ctx) => {
  try { const rows = await analyzeAll(HTF_TIMEFRAMES); await ctx.reply(fmtSignal(rows)); }
  catch (e) { await ctx.reply(`查詢失敗：${e.message}`); }
});

bot.command('auto_on', (ctx) => {
  subscribers.add(String(ctx.chat.id));
  ctx.reply(`✅ 自動偵測已開啟（每 3 分鐘掃描一次）`);
});

bot.command('auto_off', (ctx) => {
  subscribers.delete(String(ctx.chat.id));
  ctx.reply('🛑 自動偵測已關閉');
});

bot.command('status', (ctx) => {
  ctx.reply(`模式：${LIVE ? '實單' : '僅報價'}｜市場：${DEFAULT_TYPE}\n週期：${TIMEFRAMES.join(', ')}\n訂閱中：${subscribers.size} 個聊天`);
});

bot.command('market', (ctx) => ctx.reply('已停用下單功能（僅提供訊號與報價）'));
bot.command('limit', (ctx) => ctx.reply('已停用下單功能（僅提供訊號與報價）'));

const subscribers = new Set();

schedule.scheduleJob(AUTO_CRON, async () => {
  try {
    if (subscribers.size === 0) return;
    const rows = await analyzeAll(TIMEFRAMES);
    const hits = rows.filter(r => r.dir);
    if (hits.length === 0) return;
    const msg = fmtSignal(hits, true);
    for (const id of subscribers) {
      await bot.telegram.sendMessage(id, msg).catch(() => { });
    }
  } catch (_) { }
});

(async () => {
  await bot.telegram.deleteWebhook().catch(() => { });
  await bot.launch();
  console.log('🤖 Telegram Bot 已啟動｜BingX 合約｜OB 內觸發｜多目標 TP｜3分鐘自動推播');
})();
