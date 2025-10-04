// index.js － 多週期匯總版（含 5m/15m/30m/1h/4h/1d/1w）
// 依賴：dotenv, telegraf, ccxt, node-schedule
require('dotenv').config();
const { Telegraf } = require('telegraf');
const ccxt = require('ccxt');
const schedule = require('node-schedule');

/* ========= 時間 ========= */
function nowTW() {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date());
}

/* ========= 環境 ========= */
const bot = new Telegraf(process.env.BOT_TOKEN);
const LIVE = String(process.env.LIVE || '0') === '1' || String(process.env.LIVE).toLowerCase() === 'true';
const DEFAULT_TYPE = process.env.BINGX_TYPE || 'swap';
const AUTO_CRON = process.env.AUTO_CRON || '*/3 * * * *'; // 每 3 分鐘掃描

/* 幣種與週期 */
const SYMBOLS = ['BTC/USDT','ETH/USDT','SOL/USDT','DOGE/USDT','XRP/USDT','ADA/USDT','LINK/USDT'];
const ALL_TFS = ['5m','15m','30m','1h','4h','1d','1w'];            // 匯總使用
const TIMEFRAMES = ['5m','15m','30m','1h','4h','1d'];               // 一般 /signal
const HTF_TIMEFRAMES = ['30m','1h','4h','1d','1w'];                 // /signal_htf

/* SMC/OB 參數 */
const SWING_LOOKBACK = 5;
const ATR_PERIOD = 14;
const ATR_MULT = 0.6;
const OB_USE_WICKS = true;
const ENTRY_MODE = 'ob_mid';      // ob_mid | ob_top | ob_bottom
const SL_ATR_PAD = 0.1;
const TP_R_MULTS = [1.0, 1.5, 2.0];

/* 交易所（BingX 合約） */
const exOpt = {
  enableRateLimit: true,
  apiKey: process.env.API_KEY || undefined,
  secret: process.env.API_SECRET || undefined,
  options: { defaultType: DEFAULT_TYPE }
};
const exchange = new ccxt.bingx(exOpt);

/* ========= 小工具 ========= */
const toFixed = (n, p = 4) => (n == null || isNaN(n)) ? '' : Number(n).toFixed(p);
function candidateSymbols(symbol) {
  return symbol.includes(':USDT') ? [symbol] : [symbol, `${symbol}:USDT`];
}
async function fetchTickerFlex(symbol) {
  for (const s of candidateSymbols(symbol)) {
    try { const t = await exchange.fetchTicker(s); return { ...t, _symbol: s }; } catch (_) {}
  }
  throw new Error(`Ticker 不可用：${symbol}`);
}
async function fetchOHLCVFlex(symbol, timeframe, limit = 300) {
  for (const s of candidateSymbols(symbol)) {
    try { return await exchange.fetchOHLCV(s, timeframe, undefined, limit); } catch (_) {}
  }
  throw new Error(`OHLCV 不可用：${symbol} ${timeframe}`);
}
function calcATR(c, period = 14) {
  if (!c || c.length < period + 1) return null;
  const TRs = [];
  for (let i = 1; i < c.length; i++) {
    const h = c[i][2], l = c[i][3], pc = c[i-1][4];
    TRs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const last = TRs.slice(-period);
  return last.reduce((a,b)=>a+b,0)/last.length;
}
function swingHigh(c, look = 5) {
  const n = c.length;
  for (let i = n - look - 2; i >= look; i--) {
    const h = c[i][2]; let L = true, R = true;
    for (let k = 1; k <= look; k++) { if (c[i-k][2] >= h) L=false; if (c[i+k][2] >= h) R=false; }
    if (L && R) return { idx:i, price:h };
  }
  return null;
}
function swingLow(c, look = 5) {
  const n = c.length;
  for (let i = n - look - 2; i >= look; i--) {
    const l = c[i][3]; let L = true, R = true;
    for (let k = 1; k <= look; k++) { if (c[i-k][3] <= l) L=false; if (c[i+k][3] <= l) R=false; }
    if (L && R) return { idx:i, price:l };
  }
  return null;
}
function findOrderBlock(c, bosIndex, isUp) {
  for (let j = bosIndex - 1; j >= Math.max(0, bosIndex - 50); j--) {
    const o = c[j][1], cl = c[j][4], h = c[j][2], l = c[j][3];
    const isBear = cl < o, isBull = cl > o;
    if (isUp && isBear) return OB_USE_WICKS ? { low:l, high:h, idx:j } : { low:Math.min(o,cl), high:Math.max(o,cl), idx:j };
    if (!isUp && isBull) return OB_USE_WICKS ? { low:l, high:h, idx:j } : { low:Math.min(o,cl), high:Math.max(o,cl), idx:j };
  }
  return null;
}
function pickEntryFromOB(ob, dir) {
  if (ENTRY_MODE === 'ob_mid') return (ob.low + ob.high) / 2;
  if (ENTRY_MODE === 'ob_top') return dir === 'LONG' ? ob.high : ob.low;
  if (ENTRY_MODE === 'ob_bottom') return dir === 'LONG' ? ob.low : ob.high;
  return (ob.low + ob.high) / 2;
}

/* ========= 產生僅 OB 內觸發的訊號 ========= */
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

  // 上破 BOS
  if (close > sh.price && volOK) {
    const bosIdx = candles.length - 1;
    const ob = findOrderBlock(candles, bosIdx, true);
    if (!ob) return null;
    if (!(close <= ob.high && close >= ob.low)) return null; // 僅 OB 內觸發
    const entry = pickEntryFromOB(ob, 'LONG');
    const stop = ob.low - atr * SL_ATR_PAD;
    const risk = entry - stop;
    const tps = TP_R_MULTS.map(r => entry + r * risk);
    return { dir:'LONG', timeframe, entry, stop, tps, obLow:ob.low, obHigh:ob.high };
  }

  // 下破 BOS
  if (close < sl.price && volOK) {
    const bosIdx = candles.length - 1;
    const ob = findOrderBlock(candles, bosIdx, false);
    if (!ob) return null;
    if (!(close <= ob.high && close >= ob.low)) return null; // 僅 OB 內觸發
    const entry = pickEntryFromOB(ob, 'SHORT');
    const stop = ob.high + atr * SL_ATR_PAD;
    const risk = stop - entry;
    const tps = TP_R_MULTS.map(r => entry - r * risk);
    return { dir:'SHORT', timeframe, entry, stop, tps, obLow:ob.low, obHigh:ob.high };
  }
  return null;
}

/* ========= 單幣分析 / 多週期分析 ========= */
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

// 多週期匯總：回傳每個週期的訊號
async function analyzeSymbolMulti(symbol, tfList = ALL_TFS) {
  const t = await fetchTickerFlex(symbol);
  const perTf = {};
  for (const tf of tfList) {
    try {
      const c = await fetchOHLCVFlex(symbol, tf, 300);
      perTf[tf] = genSignal_OB_Only(c, tf); // 可能為 null
    } catch (e) {
      perTf[tf] = { error: e.message, timeframe: tf };
    }
  }
  return { symbol: t._symbol, price: t.last, pct: t.percentage, perTf };
}
async function analyzeAllMulti(tfList = ALL_TFS) {
  const out = [];
  for (const s of SYMBOLS) {
    try { out.push(await analyzeSymbolMulti(s, tfList)); }
    catch (e) { out.push({ symbol: s, error: e.message }); }
  }
  return out;
}

/* ========= 訊息格式 ========= */
// /signal（一般）
function fmtSignal(rows, onlyHits = false) {
  const ts = nowTW();
  let txt = onlyHits
    ? `📊 潛在進場訊號（僅 OB 內）\n🕒 訊號時間：${ts}\n\n`
    : `📈 合約即時報價與潛在進場（僅 OB 內）\n🕒 生成時間：${ts}\n\n`;

  for (const r of rows) {
    if (r.error) { txt += `${r.symbol}\n錯誤：${r.error}\n\n`; continue; }
    if (!onlyHits) {
      txt += `${r.symbol}\n價格：${toFixed(r.price, 4)}\n漲跌：${toFixed(r.pct ?? 0, 2)}%\n`;
    }
    if (r.dir) {
      const icon = r.dir === 'LONG' ? '🟢' : '🔴';
      txt += `${icon} 幣種：${r.symbol}\n`;
      txt += `方向：${icon} ${r.dir}（${r.timeframe}）\n`;
      txt += `OB 區間：${toFixed(r.obLow)} ~ ${toFixed(r.obHigh)}\n`;
      txt += `入場：${toFixed(r.entry)}｜止損：${toFixed(r.stop)}\n`;
      txt += `🎯 TP1/2/3：${toFixed(r.tps[0])} / ${toFixed(r.tps[1])} / ${toFixed(r.tps[2])}\n\n`;
    } else if (!onlyHits) {
      txt += `— 訊號：無\n\n`;
    }
  }
  return txt.trim();
}

// /summary（多週期匯總：含 5m/15m/30m/1h/4h/1d/1w）
function fmtSummary(rows) {
  const ts = nowTW();
  let out = `📊 多週期潛在進場匯總（僅 OB 內）\n🕒 生成時間：${ts}\n\n`;

  // 先整理每個幣種信號方向
  const unify = [];   // 一致方向
  const diverge = []; // 分歧或缺訊號

  for (const r of rows) {
    if (r.error) { diverge.push({ symbol:r.symbol, reason:r.error }); continue; }

    const tfKeys = ALL_TFS;
    const dirs = tfKeys.map(tf => r.perTf[tf]?.dir || null);
    const haveAny = dirs.some(Boolean);
    if (!haveAny) { diverge.push({ symbol:r.symbol, reason:'各週期皆無訊號' }); continue; }

    const nonNullDirs = dirs.filter(Boolean);
    const allSame = nonNullDirs.length>0 && nonNullDirs.every(d => d === nonNullDirs[0]);
    if (allSame && nonNullDirs.length >= 2) {
      unify.push({ symbol:r.symbol, dir:nonNullDirs[0], price:r.price, pct:r.pct, perTf:r.perTf });
    } else {
      diverge.push({ symbol:r.symbol, price:r.price, pct:r.pct, perTf:r.perTf });
    }
  }

  // 一致方向區塊
  if (unify.length) {
    out += `🟢 一致方向（所有出現訊號的週期同方向）\n\n`;
    for (const u of unify) {
      const icon = u.dir === 'LONG' ? '🟢' : '🔴';
      out += `${u.symbol}\n現價：${toFixed(u.price,4)}　漲跌：${toFixed(u.pct??0,2)}%\n`;
      out += `一致方向：${icon} ${u.dir}\n`;
      for (const tf of ALL_TFS) {
        const s = u.perTf[tf];
        if (!s || !s.dir) continue;
        out += `— ${tf}\n`;
        out += `OB：${toFixed(s.obLow)} ~ ${toFixed(s.obHigh)}\n`;
        out += `入場：${toFixed(s.entry)}｜止損：${toFixed(s.stop)}\n`;
        out += `TP1/2/3：${toFixed(s.tps[0])} / ${toFixed(s.tps[1])} / ${toFixed(s.tps[2])}\n`;
      }
      out += `\n`;
    }
  }

  // 分歧區塊
  if (diverge.length) {
    out += `⚠ 多週期分歧/缺訊號\n\n`;
    for (const d of diverge) {
      out += `${d.symbol}\n`;
      if (d.reason) { out += `原因：${d.reason}\n\n`; continue; }
      out += `現價：${toFixed(d.price,4)}　漲跌：${toFixed(d.pct??0,2)}%\n`;
      const lines = [];
      for (const tf of ALL_TFS) {
        const s = d.perTf?.[tf];
        if (s?.dir) {
          const icon = s.dir === 'LONG' ? '🟢' : '🔴';
          lines.push(`${tf}=${icon}${s.dir}`);
        } else {
          lines.push(`${tf}=無`);
        }
      }
      out += `方向：${lines.join('、')}\n\n`;
    }
  }

  return out.trim();
}

/* ========= Telegram 指令 ========= */
const subscribers = new Set();

bot.command('signal', async (ctx) => {
  try { const rows = await analyzeAll(TIMEFRAMES); await ctx.reply(fmtSignal(rows)); }
  catch (e) { await ctx.reply(`查詢失敗：${e.message}`); }
});

bot.command('signal_htf', async (ctx) => {
  try { const rows = await analyzeAll(HTF_TIMEFRAMES); await ctx.reply(fmtSignal(rows)); }
  catch (e) { await ctx.reply(`查詢失敗：${e.message}`); }
});

bot.command('summary', async (ctx) => {
  try { const rows = await analyzeAllMulti(ALL_TFS); await ctx.reply(fmtSummary(rows)); }
  catch (e) { await ctx.reply(`匯總失敗：${e.message}`); }
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
  ctx.reply(`模式：${LIVE ? '實單' : '僅報價'}｜市場：${DEFAULT_TYPE}\n週期：${TIMEFRAMES.join(', ')}\n匯總週期：${ALL_TFS.join(', ')}\n訂閱中：${subscribers.size} 個聊天\n時間：${nowTW()}`);
});

bot.command('market', (ctx) => ctx.reply('已停用下單功能（僅提供訊號與報價）'));
bot.command('limit',  (ctx) => ctx.reply('已停用下單功能（僅提供訊號與報價）'));

/* ========= 排程推播（每 3 分鐘只推有訊號者） ========= */
schedule.scheduleJob(AUTO_CRON, async () => {
  try {
    if (subscribers.size === 0) return;
    const rows = await analyzeAll(TIMEFRAMES);
    const hits = rows.filter(r => r.dir);
    if (hits.length === 0) return;
    const msg = fmtSignal(hits, true);
    for (const id of subscribers) {
      await bot.telegram.sendMessage(id, msg).catch(()=>{});
    }
  } catch (_) {}
});

/* ========= 防呆與啟動 ========= */
process.once('SIGINT', () => { console.log('Bot stopped (SIGINT)'); process.exit(0); });
process.once('SIGTERM', () => { console.log('Bot stopped (SIGTERM)'); process.exit(0); });

(async () => {
  await bot.telegram.deleteWebhook().catch(()=>{});
  await bot.launch();
  console.log('🤖 Telegram Bot 已啟動｜多週期匯總（含 5m/15m/30m/1h/4h/1d/1w）｜OB 內觸發｜多目標 TP｜3分鐘自動推播');
})();
