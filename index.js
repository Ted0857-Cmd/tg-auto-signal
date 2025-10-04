// index.js — Multi-layer scan + Per-timeframe TP + SNR filter（高勝率取向）
// 依賴：dotenv, telegraf, ccxt, node-schedule
require('dotenv').config();
const { Telegraf } = require('telegraf');
const ccxt = require('ccxt');
const schedule = require('node-schedule');

/* ===== 時間 ===== */
function nowTW() {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date());
}

/* ===== 環境 / 幣種 / 週期分層 ===== */
const bot = new Telegraf(process.env.BOT_TOKEN);
const DEFAULT_TYPE = process.env.BINGX_TYPE || 'swap';
const SYMBOLS = ['BTC/USDT','ETH/USDT','SOL/USDT','DOGE/USDT','XRP/USDT','ADA/USDT','LINK/USDT'];

const TFS_SHORT = ['5m','15m'];      // 每 3 分鐘掃描
const TFS_MID   = ['30m','1h'];      // 每 10 分鐘掃描
const TFS_LONG  = ['4h','1d','1w'];  // 每 30 分鐘掃描

/* ===== SMC / OB 參數（穩健偏保守） ===== */
const SWING_LOOKBACK = 5;
const ATR_PERIOD = 14;
// 提高觸發門檻：放大實體 K 槓桿，抑制假突破（勝率優先）
const ATR_MULT = 0.8;
const OB_USE_WICKS = true;
const ENTRY_MODE = 'ob_mid';
const SL_ATR_PAD = 0.12; // 止損留更寬緩衝，避免微掃（勝率優先）

/* ===== TP 依週期放大（長週期給更大目標）===== */
// 環境變數做為 fallback（可在 Render 覆寫）
const TP_R_MULTS_DEFAULT = (process.env.TP_R_MULTS || '1.5,2.5,4.0')
  .split(',').map(x => Number(x.trim())).filter(x => Number.isFinite(x) && x > 0);

// 依週期配置（可依偏好再調整）
const TP_BY_TF = {
  '5m':  [1.2, 2.0, 3.0],
  '15m': [1.3, 2.2, 3.5],
  '30m': [1.5, 2.5, 4.0],
  '1h':  [2.0, 3.5, 5.5],
  '4h':  [2.5, 4.5, 7.0],
  '1d':  [3.0, 5.5, 9.0],
  '1w':  [4.0, 6.5, 10.0],
};

/* ===== SNR 過濾（高勝率基礎） ===== */
// SNR = |回歸斜率| / 殘差標準差；越大表示趨勢越乾淨
const SNR_ENABLED = true;
const SNR_LEN = 60;  // 回看長度略增，降低雜訊（勝率優先）
const SNR_MIN = {    // 各週期門檻（可視實測微調）
  '5m':  1.30,
  '15m': 1.25,
  '30m': 1.15,
  '1h':  1.05,
  '4h':  0.90,
  '1d':  0.80,
  '1w':  0.70
};

/* ===== 交易所（BingX 合約） ===== */
const exOpt = {
  enableRateLimit: true,
  apiKey: process.env.API_KEY || undefined,
  secret: process.env.API_SECRET || undefined,
  options: { defaultType: DEFAULT_TYPE }
};
const exchange = new ccxt.bingx(exOpt);

/* ===== 工具 ===== */
const toFixed = (n, p = 4) => (n == null || isNaN(n)) ? '' : Number(n).toFixed(p);

async function fetchTicker(symbol) {
  try { return await exchange.fetchTicker(symbol); } catch (_) {}
  try { return await exchange.fetchTicker(symbol.replace(':USDT','/USDT')); } catch (_) {}
  throw new Error(`Ticker 無法取得 ${symbol}`);
}
async function fetchOHLCV(symbol, tf, limit=300) {
  try { return await exchange.fetchOHLCV(symbol, tf, undefined, limit); } 
  catch (_) { try { return await exchange.fetchOHLCV(symbol.replace(':USDT','/USDT'), tf, undefined, limit); } 
  catch (e) { throw new Error(`OHLCV 無法取得 ${symbol} ${tf}`); } }
}

/* ===== 技術計算 ===== */
function calcATR(c, period=14) {
  if (!c || c.length < period+1) return null;
  const TR = [];
  for (let i=1;i<c.length;i++){
    const h=c[i][2], l=c[i][3], pc=c[i-1][4];
    TR.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return TR.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function swingHigh(c, look=5) {
  const n=c.length;
  for (let i=n-look-2;i>=look;i--){
    const h=c[i][2]; let L=true,R=true;
    for (let k=1;k<=look;k++){ if(c[i-k][2]>=h)L=false; if(c[i+k][2]>=h)R=false; }
    if(L&&R)return{idx:i,price:h};
  }
  return null;
}
function swingLow(c, look=5) {
  const n=c.length;
  for (let i=n-look-2;i>=look;i--){
    const l=c[i][3]; let L=true,R=true;
    for (let k=1;k<=look;k++){ if(c[i-k][3]<=l)L=false; if(c[i+k][3]<=l)R=false; }
    if(L&&R)return{idx:i,price:l};
  }
  return null;
}
function findOB(c,bos,isUp){
  for(let j=bos-1;j>=Math.max(0,bos-50);j--){
    const o=c[j][1],cl=c[j][4],h=c[j][2],l=c[j][3];
    const bear=cl<o, bull=cl>o;
    if(isUp && bear) return OB_USE_WICKS ? { low:l, high:h } : { low:Math.min(o,cl), high:Math.max(o,cl) };
    if(!isUp && bull) return OB_USE_WICKS ? { low:l, high:h } : { low:Math.min(o,cl), high:Math.max(o,cl) };
  }
  return null;
}
function entryFromOB(ob,dir){
  if(ENTRY_MODE==='ob_mid')return(ob.low+ob.high)/2;
  if(ENTRY_MODE==='ob_top')return dir==='LONG'?ob.high:ob.low;
  if(ENTRY_MODE==='ob_bottom')return dir==='LONG'?ob.low:ob.high;
  return (ob.low+ob.high)/2;
}

/* ===== SNR ===== */
// 線性回歸：SNR = |slope| / std(residuals)
function calcSNR(candles, len = 60) {
  if (!candles || candles.length < len) return null;
  const closes = candles.slice(-len).map(r => r[4]);
  const n = closes.length;
  const xs = Array.from({ length: n }, (_, i) => i + 1);
  const mean = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
  const xBar = mean(xs);
  const yBar = mean(closes);
  let num = 0, den = 0;
  for (let i=0;i<n;i++){ num += (xs[i]-xBar)*(closes[i]-yBar); den += (xs[i]-xBar)**2; }
  if (den === 0) return null;
  const slope = num / den;
  const residuals = closes.map((y,i) => (slope*(xs[i]-xBar)+yBar) - y);
  const resStd = Math.sqrt(residuals.reduce((a,b)=>a+b*b,0) / Math.max(1, n-2));
  if (!isFinite(resStd) || resStd === 0) return null;
  return Math.abs(slope) / resStd;
}

/* ===== 訊號生成（僅 OB 內，含 SNR 過濾、依週期 TP 放大） ===== */
function genSignal(c, tf){
  if(!c || c.length < 80) return null;

  const last=c.at(-1), close=last[4];
  const atr=calcATR(c, ATR_PERIOD);
  if(!atr) return null;

  const sh=swingHigh(c, SWING_LOOKBACK);
  const sl=swingLow(c, SWING_LOOKBACK);
  if(!sh||!sl) return null;

  const body=Math.abs(last[4]-last[1]);
  const volOK=body >= ATR_MULT*atr;
  if(!volOK) return null;

  // 預先算 SNR（勝率過濾）
  let snr = null;
  if (SNR_ENABLED) {
    snr = calcSNR(c, SNR_LEN);
    const min = SNR_MIN[tf] ?? 1.0;
    if (snr == null || snr < min) return null;
  }

  // 取該週期 TP 配置
  const RSET = TP_BY_TF[tf] || TP_R_MULTS_DEFAULT;

  // 上破 BOS → 多方 OB
  if (close > sh.price) {
    const bos=c.length-1; const ob=findOB(c, bos, true);
    if(!ob || !(close <= ob.high && close >= ob.low)) return null;
    const entry=entryFromOB(ob,'LONG');
    const stop = ob.low - atr*SL_ATR_PAD;
    const risk = entry - stop;
    const tps = RSET.map(r => entry + r*risk);
    return { dir:'LONG', timeframe:tf, entry, stop, tps, obLow:ob.low, obHigh:ob.high, snr };
  }

  // 下破 BOS → 空方 OB
  if (close < sl.price) {
    const bos=c.length-1; const ob=findOB(c, bos, false);
    if(!ob || !(close <= ob.high && close >= ob.low)) return null;
    const entry=entryFromOB(ob,'SHORT');
    const stop = ob.high + atr*SL_ATR_PAD;
    const risk = stop - entry;
    const tps = RSET.map(r => entry - r*risk);
    return { dir:'SHORT', timeframe:tf, entry, stop, tps, obLow:ob.low, obHigh:ob.high, snr };
  }

  return null;
}

/* ===== 掃描 ===== */
async function analyzeAll(tfs){
  const results=[];
  for(const s of SYMBOLS){
    try{
      const t=await fetchTicker(s);
      let picked=null;
      for(const tf of tfs){
        const c=await fetchOHLCV(s, tf, 300);
        const sig=genSignal(c, tf);
        if(sig){ picked={...sig, symbol:s, price:t.last, pct:t.percentage}; break; }
      }
      if (picked) results.push(picked);
    }catch(e){
      results.push({symbol:s,error:e.message});
    }
  }
  return results;
}

/* ===== 格式化輸出 ===== */
function fmtSignal(rows, tag){
  const ts=nowTW();
  let out = `📡 ${tag}\n🕒 ${ts}\n\n`;
  for (const r of rows) {
    if (r.error) { out += `${r.symbol} 錯誤：${r.error}\n\n`; continue; }
    const icon = r.dir==='LONG' ? '🟢' : '🔴';
    out += `${icon} ${r.symbol} ${r.dir}（${r.timeframe}）\n`;
    out += `現價：${toFixed(r.price,4)}｜漲跌：${toFixed(r.pct??0,2)}%\n`;
    out += `OB：${toFixed(r.obLow)} ~ ${toFixed(r.obHigh)}\n`;
    out += `入場：${toFixed(r.entry)}｜止損：${toFixed(r.stop)}\n`;
    out += `🎯 TP1/2/3：${toFixed(r.tps[0])} / ${toFixed(r.tps[1])} / ${toFixed(r.tps[2])}\n`;
    out += `📈 SNR：${toFixed(r.snr ?? 0, 2)}\n\n`;
  }
  return out.trim();
}

/* ===== Telegram 控制 ===== */
const subscribers = new Set();

bot.start(ctx => ctx.reply('✅ 多層級掃描（高勝率）版已啟動。\n指令：/auto_on /auto_off /status'));
bot.command('auto_on', ctx => { subscribers.add(String(ctx.chat.id)); ctx.reply('🟢 自動推播已開啟'); });
bot.command('auto_off', ctx => { subscribers.delete(String(ctx.chat.id)); ctx.reply('🔴 自動推播已關閉'); });
bot.command('status', ctx => ctx.reply(
  `層級：短(3m)=5m/15m｜中(10m)=30m/1h｜長(30m)=4h/1d/1w
TP 依週期：已啟用｜SNR 過濾：啟用（len=${SNR_LEN}）
訂閱：${subscribers.size} 個
時間：${nowTW()}`));

/* ===== 多層級排程（只推有訊號） ===== */
schedule.scheduleJob('*/3 * * * *', async()=>{
  if(!subscribers.size) return;
  const hits = await analyzeAll(TFS_SHORT);
  if(hits.length) for(const id of subscribers) await bot.telegram.sendMessage(id, fmtSignal(hits,'短線層（每 3 分鐘）'));
});
schedule.scheduleJob('*/10 * * * *', async()=>{
  if(!subscribers.size) return;
  const hits = await analyzeAll(TFS_MID);
  if(hits.length) for(const id of subscribers) await bot.telegram.sendMessage(id, fmtSignal(hits,'中線層（每 10 分鐘）'));
});
schedule.scheduleJob('*/30 * * * *', async()=>{
  if(!subscribers.size) return;
  const hits = await analyzeAll(TFS_LONG);
  if(hits.length) for(const id of subscribers) await bot.telegram.sendMessage(id, fmtSignal(hits,'長線層（每 30 分鐘）'));
});

/* ===== 啟動／收斂 ===== */
process.once('SIGINT', ()=>{ console.log('Bot stopped (SIGINT)'); process.exit(0); });
process.once('SIGTERM', ()=>{ console.log('Bot stopped (SIGTERM)'); process.exit(0); });

(async()=>{
  await bot.telegram.deleteWebhook().catch(()=>{});
  await bot.launch();
  console.log('🤖 Telegram Bot 已啟動｜多層級(3/10/30) + 依週期TP + SNR（高勝率）');
})();
