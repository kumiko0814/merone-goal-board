/* 今月の数字 コックピット — 計算エンジン（純粋関数・DOMなし）
 * ブラウザ: window.CockpitEngine ／ node: module.exports
 * 仕様: SPEC.md §3（設定JSON）・§5（計算） */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CockpitEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '20261113a'; // index.html の BUILD と一致させる
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  var RESCHED_SHOW = 0.10, RESCHED_PAID = 0.45; // 日付なしリスケ（§5 層1）
  var STRONG_RATE = 0.6, RATE_CEIL = 0.75;      // 次の一手の上積み試算・過去最高の成約率
  var DIRECT_CEIL = 0.30;                        // 直接決済型（広告の勉強会）の決済率の上限目安（11/11 参加40→決済5＋意思12 から）

  function defaults(ym) {
    return {
      v: 1,
      ym: ym || '',
      // 支払い合計と売上以外の入金は経費シートから自動（override が null の時）。シート外の支払い（税金など）は手入力
      cash: {
        balanceStart: null, balanceDate: '', spendOverride: null,
        extraSpend: ym === '2026-11' ? 9100000 : 0, extraSpendNote: ym === '2026-11' ? '税金' : '',
        otherIncomeOverride: null, addAdBudget: true, keep: 3000000, unitCash: 500000
      },
      cashByMonth: {},
      expense: { tab: '' },
      seminars: [],
      ads: { monthlyBudget: 3770000, cplManual: null, optPerDay: 20, optToMtg: 0.043, mtgToPaid: 0.45, maxCostPerDeal: 250000, cplGuard: 5500 },
      rates: {
        verbal: 0.31, loan: 0.5, judge7: 0.35, judge21: 0.15, judgeOver: 0.05,
        show: 0.8, reschedShow: 0.5, sameMonthPay: 0.85, lateMonthPay: 0.3,
        semAttendRate: 0.67, semIntent: 0.35, // 希望者→参加（11/11 60→40）／勉強会の決済待ち（意思あり・未決済）→入金
        byVia: { famm: 0.35, ABCash: 0.65, SHE: 0.5, BUCKET: 0.47, '広告': 0.45, LiLI: 0.5, 'その他': 0.5 },
        seminar: {
          famm: { attendMedian: 29, attendMax: 34, book: 0.25, firstHalfPay: 0.75, secondHalfPay: 0.15 },
          ABCash: { attendMedian: 18, attendMax: null, book: 0.15, firstHalfPay: 0.70, secondHalfPay: 0.25 },
          SHE: { attendMedian: 30, attendMax: null, book: 0.20, firstHalfPay: 0.79, secondHalfPay: 0.04 },
          LiLI: { attendMedian: 25, attendMax: null, book: 0.10, firstHalfPay: 0.70, secondHalfPay: 0.20 },
          // 広告LINEの勉強会は面談を挟まず、その場で決済（direct = 参加→決済の率。11/11: 参加40・翌日まで決済5・意思12 → 見立て22%）
          '広告': { attendMedian: 40, attendMax: 40, book: null, direct: 0.22, firstHalfPay: 0.90, secondHalfPay: 0.50 }
        },
        bucketNewPerMonth: 4, otherPerMonth: 1.5,
        lowFactorNew: 0.7, highFactorNew: 1.3,
        adLagDays: 12
      },
      manual: { paidOverride: null, adSpendManual: null, adRegsManual: null },
      promiseManual: null,
      snapshots: {}
    };
  }

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function deepMerge(base, over) {
    var out = clone(base);
    if (!isObj(over)) return out;
    Object.keys(over).forEach(function (k) {
      var v = over[k];
      if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
      else if (v !== undefined) out[k] = clone(v);
    });
    return out;
  }

  /** 保存済み設定を既定値で補い、月が変わっていれば月ごとの入力だけ空に戻す（率・スナップショットは引き継ぐ） */
  function normalize(saved, ym) {
    var d = defaults(ym);
    if (!isObj(saved)) return d;
    var s = deepMerge(d, saved);
    delete s._health;
    if (!Array.isArray(s.seminars)) s.seminars = [];
    // 勉強会の項目をそろえる: 希望者 applied・参加 attend・決済 paid・意思あり未決済 intent・履歴 history（2026-11-13）
    s.seminars = s.seminars.filter(isObj).map(function (x) {
      var o = clone(x);
      ['applied', 'attend', 'paid', 'intent'].forEach(function (k) { if (num(o[k]) == null) o[k] = null; });
      if (!Array.isArray(o.history)) o.history = [];
      o.note = o.note == null ? '' : String(o.note);
      return o;
    });
    if (!isObj(s.snapshots)) s.snapshots = {};
    if (!isObj(s.cashByMonth)) s.cashByMonth = {};
    if (!isObj(s.expense)) s.expense = { tab: '' };
    ['balance', 'spendRemain', 'otherIncome', 'paidAtBalance'].forEach(function (k) { delete s.cash[k]; }); // 旧モデルの項目
    if (ym && saved.ym && saved.ym !== ym) {
      s.cashByMonth[saved.ym] = clone(s.cash); // 先月の入力は月別に残す
      var nc = d.cash;
      nc.keep = s.cash.keep; nc.unitCash = s.cash.unitCash; nc.addAdBudget = s.cash.addAdBudget;
      s.cash = nc;
      s.seminars = []; s.manual = d.manual; s.promiseManual = null; s.ads.cplManual = null;
    }
    if (ym) s.ym = ym;
    return s;
  }

  /** 保存用: 今月の cash を cashByMonth[ym] にも写す */
  function mirrorCash(settings) {
    var s = clone(settings);
    if (!isObj(s.cashByMonth)) s.cashByMonth = {};
    if (s.ym) s.cashByMonth[s.ym] = clone(s.cash);
    return s;
  }
  function manS(yen) { return fmtMan(yen).replace('万円', '万'); }

  function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
  function nz(x) { var n = num(x); return n == null ? 0 : n; }
  function cnt(x) { return Array.isArray(x) ? x.length : nz(x); }
  function r1(x) { return Math.round(x * 10) / 10; }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function f1(x) { var v = r1(x); return (v === Math.round(v) ? String(v) : v.toFixed(1)); }

  function viaKey(v) {
    var s = String(v == null ? '' : v);
    if (/famm/i.test(s)) return 'famm';
    if (/abc/i.test(s)) return 'ABCash';
    if (/bucket|バケット/i.test(s)) return 'BUCKET';
    if (/she/i.test(s)) return 'SHE';
    if (/li-?li/i.test(s)) return 'LiLI';
    if (/広告/.test(s)) return '広告';
    return 'その他'; // スマセル・シンママ・空欄など
  }
  function viaRate(rates, key) {
    var b = rates.byVia || {};
    var v = num(b[key]);
    if (v == null) v = num(b['その他']);
    return v == null ? 0.5 : v;
  }

  function fmtMD(y, m, d) {
    var dt = new Date(y, m - 1, d);
    return m + '/' + d + '(' + WD[dt.getDay()] + ')';
  }
  /** 円 → 「377万円」「1,250.5万円」 */
  function fmtMan(yen) {
    var n = num(yen);
    if (n == null) return '—';
    var v = Math.round(n / 1000) / 10;
    var neg = v < 0; v = Math.abs(v);
    var ip = Math.floor(v), dp = Math.round((v - ip) * 10);
    if (dp === 10) { ip += 1; dp = 0; }
    var s = String(ip).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dp ? '.' + dp : '');
    return (neg ? '−' : '') + s + '万円';
  }
  function fmtYen(yen) {
    var n = num(yen);
    if (n == null) return '—';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
  }

  function parseYm(ym, today) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    if (m) return { y: +m[1], m: +m[2] };
    return { y: today.getFullYear(), m: today.getMonth() + 1 };
  }
  /** "M/d" or "YYYY-MM-DD" → 当月なら日、他の月なら null */
  function dayInMonth(str, y, m) {
    var s = String(str == null ? '' : str), a;
    if ((a = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return (+a[1] === y && +a[2] === m) ? +a[3] : null;
    if ((a = /^(\d{1,2})\/(\d{1,2})/.exec(s))) return +a[1] === m ? +a[2] : null;
    return null;
  }
  function dateKey(str) {
    var a = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(str || ''));
    return a ? (+a[1]) * 10000 + (+a[2]) * 100 + (+a[3]) : null;
  }

  /** メイン計算。opts.cplTry = CPLスライダーの試し値（保存しない） */
  function compute(settingsIn, statIn, metaIn, todayIn, opts) {
    opts = opts || {};
    var today = todayIn instanceof Date ? todayIn : new Date();
    var S = normalize(settingsIn, settingsIn && settingsIn.ym ? settingsIn.ym : '');
    var stat = isObj(statIn) && !statIn.error ? statIn : {};
    var meta = isObj(metaIn) ? metaIn : {};
    var R = S.rates, A = S.ads, C = S.cash;
    var ym = S.ym || (stat.ym || '');
    var P = parseYm(ym, today), y = P.y, m = P.m;
    ym = y + '-' + (m < 10 ? '0' : '') + m;
    var last = new Date(y, m, 0).getDate();
    var tKey = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    var mKey = y * 100 + m, tmKey = today.getFullYear() * 100 + today.getMonth() + 1;
    var tday = tmKey === mKey ? today.getDate() : (tmKey < mKey ? 1 : last + 1);
    var remainDays = Math.max(0, last - tday + 1);
    var bookLine = last - 9, safeLine = last - 3, doLimit = last - 1;
    var why = {};

    // ---- 入金済み ----
    var paidAuto = nz(stat.paidMainCount);
    var paidOv = num(S.manual.paidOverride);
    var paid = paidOv != null ? paidOv : paidAuto;
    var paidByVia = {}, paidByViaRaw = {};
    var pv = isObj(stat.paidMainByVia) ? stat.paidMainByVia : {};
    Object.keys(pv).forEach(function (k) { var key = viaKey(k); paidByVia[key] = (paidByVia[key] || 0) + nz(pv[k]); paidByViaRaw[k] = nz(pv[k]); });
    var shiire = num(stat.paidShiireCount) != null ? stat.paidShiireCount : cnt(stat.paidShiire);
    why.paid = paidOv != null ? '入金済み = 手で直した数（自動の値は ' + paidAuto + '件）'
      : '入金済み = セールス管理シートで今月入金の人数（仕入れコースは別枠' + shiire + '件）';

    // ---- 層1 見えている分 ----
    var pipe = Array.isArray(stat.pipeline) ? stat.pipeline : [];
    var verbalN = 0, loanN = 0, j7 = 0, j21 = 0, jOver = 0, longN = 0;
    pipe.forEach(function (p) {
      var cat = String(p && p.cat || '').trim(), st = String(p && p.status || '').trim(), d = num(p && p.days);
      if (/^失注/.test(cat) || /^失注/.test(st)) return;
      if (/口頭合意|ローン/.test(cat)) { if (/ローン/.test(cat + st)) loanN++; else verbalN++; }
      else if (/迷い中|判断待ち|判断前/.test(cat)) { if (d == null) j21++; else if (d <= 7) j7++; else if (d <= 21) j21++; else jOver++; }
      else if (/長期戦/.test(cat)) { jOver++; longN++; }
    });
    var verbalE = verbalN * R.verbal + loanN * R.loan;
    var judgeN = j7 + j21 + jOver;
    var judgeE = j7 * R.judge7 + j21 * R.judge21 + jOver * R.judgeOver;
    why.verbal = '口頭合意' + verbalN + '件 × ' + pct(R.verbal) + (loanN ? ' ＋ ローン' + loanN + '件 × ' + pct(R.loan) : '') + ' = ' + f1(verbalE);
    why.judge = '7日以内' + j7 + '×' + pct(R.judge7) + ' ＋ 8〜21日' + j21 + '×' + pct(R.judge21) + ' ＋ 22日超' + jOver + '×' + pct(R.judgeOver) + (longN ? '（長期戦' + longN + '件を含む）' : '') + ' = ' + f1(judgeE);

    var ups = Array.isArray(stat.upcoming) ? stat.upcoming : [];
    var upE = 0, upLateN = 0, upReschN = 0, upLow = 0, upStrong = 0;
    ups.forEach(function (u) {
      var d = dayInMonth(u && u.plan, y, m);
      var late = d != null && d > safeLine;
      if (late) upLateN++;
      var resch = /リスケ|日程調整/.test(String(u && u.status || ''));
      if (resch) upReschN++;
      var show = resch ? R.reschedShow : R.show;
      var pay = late ? R.lateMonthPay : R.sameMonthPay;
      var v = viaRate(R, viaKey(u && u.via));
      upE += show * v * pay;
      if (v < STRONG_RATE) upStrong += show * (STRONG_RATE - v) * pay;
    });
    upLow = upE * 0.8;
    why.upcoming = '面談予定' + ups.length + '件 × 実施' + pct(R.show) + '（リスケ中は' + pct(R.reschedShow) + '）× 経路別の成約率 × 入金率（' + fmtMD(y, m, safeLine) + 'まで' + pct(R.sameMonthPay) + '・それ以降' + pct(R.lateMonthPay) + '） = ' + f1(upE);

    // 日付なしリスケは直近45日分（reschedRecent）を使う。無い時だけ resched
    var reschedRecentUsed = stat.reschedRecent != null;
    var reschedN = reschedRecentUsed ? cnt(stat.reschedRecent) : cnt(stat.resched);
    var reschedE = reschedN * RESCHED_SHOW * RESCHED_PAID;
    why.resched = '日付の決まっていないリスケ' + (reschedRecentUsed ? '（最後の面談が45日以内）' : '') + reschedN + '件 × ' + pct(RESCHED_SHOW) + ' × ' + pct(RESCHED_PAID) + ' = ' + f1(reschedE);

    // ---- 勉強会（開催前は層2の新規、開催済みは実績: 決済は入金済みに入っているので足さず、意思あり・未決済だけ層1へ） ----
    var attendRate = num(R.semAttendRate) != null ? R.semAttendRate : 0.67;
    var intentRate = num(R.semIntent) != null ? R.semIntent : 0.35;
    var seminars = (S.seminars || []).map(function (s) {
      var a = viaKey(s.alliance), sr = (R.seminar || {})[a] || null;
      var direct = !!(sr && num(sr.direct) != null);            // 直接決済型（勉強会の場で決済。面談を挟まない）
      var d = dayInMonth(s.date, y, m), k = dateKey(s.date);
      var past = k != null && k < tKey;
      var outOfMonth = d == null;
      var median = sr ? nz(sr.attendMedian) : 0;
      var applied = num(s.applied);
      var attendSet = num(s.attend);
      var attendFrom = attendSet != null ? 'set' : (applied != null ? 'applied' : 'median');
      var attend = attendFrom === 'set' ? attendSet : (attendFrom === 'applied' ? applied * attendRate : median);
      var book = sr && !direct ? nz(sr.book) : 0, v = direct ? nz(sr.direct) : viaRate(R, a);
      var mtgs = direct ? null : attend * book * R.show;
      var deals = direct ? attend * v : mtgs * v;
      var first = d != null && d <= bookLine;
      var payRate = sr ? (first ? nz(sr.firstHalfPay) : nz(sr.secondHalfPay)) : 0;
      var active = !past && !outOfMonth && !!sr;
      var thisMonth = active ? deals * payRate : 0;
      var paidN = num(s.paid), intentN = num(s.intent);
      var intentE = past && intentN != null ? intentN * intentRate : 0;
      var attendRateActual = past && applied != null && applied > 0 && attendSet != null ? attendSet / applied : null;
      var payRateActual = past && attendSet != null && attendSet > 0 && paidN != null ? paidN / attendSet : null;
      var o = {
        id: s.id, alliance: a, date: s.date, dateLabel: d != null ? fmtMD(y, m, d) : String(s.date || ''),
        past: past, outOfMonth: outOfMonth, hasRates: !!sr, active: active, direct: direct,
        applied: applied, attend: attend, attendFrom: attendFrom, attendIsMedian: attendFrom === 'median', attendRate: attendRate, median: median, attendMax: sr ? num(sr.attendMax) : null,
        book: book, rate: v, mtgs: mtgs, deals: deals, payRate: payRate, firstHalf: first, thisMonth: thisMonth,
        paid: paidN, intent: intentN, intentE: intentE, intentRate: intentRate, attendRateActual: attendRateActual, payRateActual: payRateActual,
        history: Array.isArray(s.history) ? clone(s.history) : [], note: s.note == null ? '' : String(s.note),
        needDeals: null, needRate: null, verdict: null, verdictKind: null, needAttend: null
      };
      var attendTx = '参加' + f1(attend) + (attendFrom === 'median' ? '（中央値）' : attendFrom === 'applied' ? '（希望者' + f1(applied) + ' × 参加率' + pct(attendRate) + '）' : '');
      var lineTx = '（' + (first ? '予約ラインより前' : '予約ラインより後') + '）';
      why['sem_' + s.id] = past
        ? ('開催済み' + (applied != null ? '。希望者' + f1(applied) : '') + (attendSet != null ? (applied != null ? ' → ' : '。') + '参加' + f1(attendSet) + (attendRateActual != null ? '（参加率' + pct(attendRateActual) + '）' : '') : '')
          + (paidN != null ? '。決済' + f1(paidN) + '件' + (payRateActual != null ? '（参加の' + pct(payRateActual) + '）' : '') + 'は「入金済み」に入っています' : '')
          + (intentN != null ? '。意思あり・未決済' + f1(intentN) + '人 × ' + pct(intentRate) + ' = ' + f1(intentE) + ' を「見えている分」に足しています'
            : (direct ? '。決済・意思の数を入れると見込みに足します' : '。面談に進んだ分は「見えている分」（面談予定・判断待ち）に入っています')))
        : outOfMonth ? 'この回は今月の外なので、今月の見込みには入れていません'
        : !sr ? 'この経路の率が未設定なので 0 として計算しています'
        : direct ? attendTx + ' × 直接決済' + pct(v) + ' = ' + f1(deals) + ' → × 今月入金' + pct(payRate) + lineTx + ' = ' + f1(thisMonth)
        : attendTx + ' × 予約' + pct(book) + ' × 実施' + pct(R.show) + ' = 面談' + f1(mtgs) + ' → × 成約' + pct(v) + ' = ' + f1(deals) + ' → × 今月入金' + pct(payRate) + lineTx + ' = ' + f1(thisMonth);
      return o;
    });
    var semTotal = seminars.reduce(function (a, s) { return a + s.thisMonth; }, 0);
    var semIntentE = seminars.reduce(function (a, s) { return a + s.intentE; }, 0);
    var semIntentN = seminars.reduce(function (a, s) { return a + (s.past && s.intent != null ? s.intent : 0); }, 0);
    why.semIntent = '勉強会の決済待ち（意思あり・未決済）' + f1(semIntentN) + '人 × ' + pct(intentRate) + ' = ' + f1(semIntentE) + '。決済ずみの人は「入金済み」に入っています';

    var l1 = verbalE + judgeE + upE + reschedE + semIntentE;
    var l1Low = 0 + judgeE * 0.5 + upLow + reschedE + semIntentE * 0.5;
    var l1High = (verbalN + loanN) + judgeE * 1.5 + upE + reschedE + semIntentN;
    why.l1 = '見えている分 = 口頭合意' + f1(verbalE) + ' ＋ 判断待ち' + f1(judgeE) + ' ＋ 面談予定' + f1(upE) + ' ＋ リスケ' + f1(reschedE) + (semIntentN ? ' ＋ 勉強会の決済待ち' + f1(semIntentE) : '') + ' = ' + f1(l1);

    // ---- 層2 これからの新規 ----

    // 広告
    var cplTry = num(opts.cplTry);
    var cplAuto = meta.ok && num(meta.cpl) != null && meta.cpl > 0 ? meta.cpl : null;
    var cplMan = num(A.cplManual) != null && A.cplManual > 0 ? A.cplManual : null;
    var spM = num(S.manual.adSpendManual), rgM = num(S.manual.adRegsManual);
    var cplFromManual = spM != null && rgM ? spM / rgM : null;
    var cplNow = cplAuto != null ? cplAuto : (cplMan != null ? cplMan : cplFromManual);
    var cplSource = cplAuto != null ? 'auto' : (cplMan != null || cplFromManual != null ? 'manual' : null);
    var cpl = cplTry != null && cplTry > 0 ? cplTry : cplNow;
    // 友だち追加→面談まで adLagDays かかるので、月末まで adLagDays 以上残っている日のオプトだけが今月の成約になる
    var adLag = Math.max(0, nz(R.adLagDays));
    var effectiveDays = Math.max(0, remainDays - adLag);
    function optPerDayFor(c) { return c ? (A.monthlyBudget / last) / c : A.optPerDay; }
    function adDealsFor(opd) { return opd * effectiveDays * A.optToMtg * A.mtgToPaid * R.sameMonthPay; }
    var optPerDay = optPerDayFor(cpl);
    var adDeals = adDealsFor(optPerDay);
    var impliedCpl = cpl || (A.optPerDay > 0 ? (A.monthlyBudget / last) / A.optPerDay : null);
    why.ad = '1日のオプト' + f1(optPerDay) + (cpl ? '（予算' + fmtMan(A.monthlyBudget) + '÷' + last + '日÷CPL' + fmtYen(cpl) + '）' : '（CPL未入力なので既定' + A.optPerDay + '人）') + ' × 間に合う日数' + effectiveDays + '日（残り' + remainDays + '日 − 友だち追加から面談まで' + adLag + '日） × 面談化' + (Math.round(A.optToMtg * 1000) / 10) + '% × 成約' + pct(A.mtgToPaid) + ' × 今月入金' + pct(R.sameMonthPay) + ' = ' + f1(adDeals);

    var bucket = R.bucketNewPerMonth * remainDays / last;
    var other = R.otherPerMonth * remainDays / last;
    why.bucket = 'BUCKET新規 月' + R.bucketNewPerMonth + '件 × 残り' + remainDays + '日/' + last + '日 = ' + f1(bucket);
    why.other = 'その他 月' + R.otherPerMonth + '件 × 残り' + remainDays + '日/' + last + '日 = ' + f1(other);

    var l2 = semTotal + adDeals + bucket + other;
    why.l2 = 'これからの新規 = 勉強会' + f1(semTotal) + ' ＋ 広告' + f1(adDeals) + ' ＋ BUCKET' + f1(bucket) + ' ＋ その他' + f1(other) + ' = ' + f1(l2);

    // ---- 見込み ----
    var midRaw = paid + l1 + l2;
    var lowRaw = paid + l1Low + l2 * R.lowFactorNew;
    var highRaw = paid + l1High + l2 * R.highFactorNew;
    var mid = Math.round(midRaw), low = Math.round(lowRaw), high = Math.round(highRaw);
    if (low > mid) low = mid;
    if (high < mid) high = mid;
    why.mid = '見込み = 入金済み' + paid + ' ＋ 見えている分' + f1(l1) + ' ＋ これからの新規' + f1(l2) + ' = ' + f1(midRaw);
    why.range = '下' + low + ' = 口頭合意0・判断待ち半分・面談予定×0.8・新規×' + R.lowFactorNew + '／上' + high + ' = 口頭合意ぜんぶ・判断待ち×1.5・新規×' + R.highFactorNew;

    // ---- 必要（月の合計。入金済みは足さない） ----
    var X = isObj(opts.expense) ? opts.expense : null;
    var expenseOk = !!(X && X.ok && num(X.spendTotal) != null);
    var expenseState = !X ? 'none' : (expenseOk ? 'ok' : 'error');
    var spendOv = num(C.spendOverride), othOv = num(C.otherIncomeOverride);
    var spend = spendOv != null ? spendOv : (expenseOk ? X.spendTotal : null);
    var spendSource = spendOv != null ? 'manual' : (expenseOk ? 'sheet' : null);
    var oth = othOv != null ? othOv : (expenseOk && num(X.otherIncome) != null ? X.otherIncome : 0);
    var othSource = othOv != null ? 'manual' : (expenseOk && num(X.otherIncome) != null ? 'sheet' : 'none');
    var extra = nz(C.extraSpend);
    var adSpend = C.addAdBudget !== false ? nz(A.monthlyBudget) : 0;
    var bal = num(C.balanceStart), keep = nz(C.keep), unit = num(C.unitCash);
    var unitMissing = bal != null && spend != null && !(unit != null && unit > 0);
    var inputsReady = bal != null && spend != null && unit != null && unit > 0;
    var need = null, needAdd = null, needCash = null, breakEven = null;
    if (inputsReady) {
      needCash = spend + extra + adSpend - oth + keep - bal;
      need = Math.max(0, Math.ceil(needCash / unit - 1e-9));
      needAdd = need;
      breakEven = Math.max(0, Math.ceil((needCash - keep) / unit - 1e-9));
      why.need = '必要 = (支払' + manS(spend) + ' ＋ シート外' + manS(extra) + (adSpend ? ' ＋ 広告費（カード・シート外）' + manS(adSpend) : '') + ' − 他収入' + manS(oth) + ' ＋ 残す' + manS(keep) + ' − 月初残高' + manS(bal) + ') = ' + manS(needCash) + ' ÷ 1件' + manS(unit) + ' → ' + need + '件（切り上げ）。残す額0なら' + breakEven + '件';
    } else if (spend == null && expenseState === 'error') {
      why.need = '経費シートが読めません。支払い合計を自分で入れると、必要数が出ます';
    } else {
      why.need = '月初の口座残高を入れると、今月の支払い（経費シート）から必要数が出ます';
    }

    // ---- 約束 ----
    var pm = num(S.promiseManual);
    var promise = pm != null ? pm : Math.round((low + mid) / 2);
    why.promise = pm != null ? '約束 = 手で決めた数字' : '約束 = (下' + low + ' ＋ 見込み' + mid + ') ÷ 2 を四捨五入';

    // ---- 足りない分と配分（勉強会と広告で、今月入金の見込みの比で分け合う） ----
    var gap = null;
    if (need != null) {
      gap = Math.max(0, need - paid - l1 - bucket - other);
      why.gap = '足りない分 = 必要' + need + ' − 入金済み' + paid + ' − 見えている分' + f1(l1) + ' − BUCKET' + f1(bucket) + ' − その他' + f1(other) + ' = ' + f1(gap) + '（勉強会と広告で、見込みの比で分け合う）';
    }
    var actives = seminars.filter(function (s) { return s.active; });
    var allSum = semTotal + adDeals;
    var adShare = allSum > 0 ? adDeals / allSum : 0;
    if (gap != null) {
      actives.forEach(function (s) {
        var share = allSum > 0 ? s.thisMonth / allSum : 1 / actives.length;
        s.needDeals = gap * share;
        var perUnit = (s.direct ? s.attend : s.mtgs) * s.payRate;   // 直接決済型は参加1人あたり、面談型は面談1件あたり
        var rateName = s.direct ? '決済率' : '成約率', ceil = s.direct ? DIRECT_CEIL : RATE_CEIL;
        s.needRate = perUnit > 0 ? s.needDeals / perUnit : (s.needDeals > 0 ? Infinity : 0);
        if (s.needRate <= s.rate) { s.verdict = '届く範囲'; s.verdictKind = 'blue'; }
        else if (s.needRate <= ceil) { s.verdict = rateName + 'を上げれば'; s.verdictKind = 'lav'; }
        else {
          s.verdict = s.direct ? '直接決済' + pct(DIRECT_CEIL) + 'を超える' : '過去最高75%を超える'; s.verdictKind = 'pink';
          var per = (s.direct ? s.rate : s.book * R.show * s.rate) * s.payRate;
          s.needAttend = per > 0 ? Math.ceil(s.needDeals / per) : null;
        }
        why['semNeed_' + s.id] = '必要 = 足りない分' + f1(gap) + ' × この回の割合' + pct(share) + '（勉強会と広告の見込みの比） = ' + f1(s.needDeals) + '件 → ÷（' + (s.direct ? '参加' + f1(s.attend) : '面談' + f1(s.mtgs)) + ' × 今月入金' + pct(s.payRate) + '） = ' + rateName + (isFinite(s.needRate) ? pct(s.needRate) : '—') + (s.needAttend ? '。' + rateName + pct(s.rate) + 'のままなら参加' + s.needAttend + '人' : '');
      });
    }

    // 広告の必要量・死守CPL
    var adNeed = gap != null ? gap * adShare : null;
    var needMtg = adNeed != null ? adNeed / A.mtgToPaid : null;
    var needOpt = needMtg != null ? needMtg / A.optToMtg : null;
    var allowSpend = adNeed != null ? adNeed * A.maxCostPerDeal : null;
    var guardCpl = A.maxCostPerDeal * A.mtgToPaid * A.optToMtg; // 1件の広告費を上限以内にするCPL（定数）
    var guardMonth = guardCpl > 0 ? Math.min(guardCpl, A.cplGuard) : A.cplGuard;
    var adEnough = gap != null && gap <= 0;
    var budgetOpts = optPerDay * effectiveDays;
    var budgetCovers = adNeed != null ? adDeals >= adNeed - 1e-9 : null;
    var budgetShort = adNeed != null ? Math.max(0, adNeed - adDeals) : null;
    why.guard = '1件の広告費を' + fmtMan(A.maxCostPerDeal).replace('万円', '万') + '以内にする線 = ' + fmtMan(A.maxCostPerDeal) + ' × 成約' + pct(A.mtgToPaid) + ' × 面談化' + (Math.round(A.optToMtg * 1000) / 10) + '% = ' + fmtYen(guardCpl) + '。CPLガード' + fmtYen(A.cplGuard) + 'と比べて小さい方 = 今月の死守CPL ' + fmtYen(guardMonth);
    why.allowSpend = adNeed != null ? '許容広告費 = 広告に頼る成約' + f1(adNeed) + '件（足りない分' + f1(gap) + ' × 広告の割合' + pct(adShare) + '） × ' + fmtMan(A.maxCostPerDeal) + ' = ' + fmtMan(allowSpend) : '必要数が出ると計算できます';
    why.needOpt = needOpt != null ? '必要オプト = ' + f1(adNeed) + '件 ÷ 成約' + pct(A.mtgToPaid) + ' ÷ 面談化' + (Math.round(A.optToMtg * 1000) / 10) + '% = ' + Math.ceil(needOpt) + '人（間に合う日数' + effectiveDays + '日）' : '必要数が出ると計算できます';
    why.budget = '今の予算で今月に間に合うオプト ' + Math.round(budgetOpts) + '人 → 成約' + f1(adDeals) + '件' + (adNeed != null ? '（広告に頼る分 ' + f1(adNeed) + '件' + (budgetCovers ? 'をまかなえる）' : 'まで あと' + f1(budgetShort) + '件ぶん）') : '');
    why.cpl = cplTry != null ? '試しに動かしているCPL（保存されません）' : cplSource === 'auto' ? 'Metaから自動で読んだ今月のCPL（広告費 ÷ 登録数）' : cplSource === 'manual' ? '手で入れたCPL' : 'まだCPLがありません。1日' + A.optPerDay + '人として計算しています';

    // ---- 日付の線 ----
    why.bookLine = '予約ライン = 月末−9日。これより後の勉強会は、同月入金の率が下がります';
    why.safeLine = '着金安全〆 = 月末−3日。これより後の面談は、今月入金の率を' + pct(R.lateMonthPay) + 'で見ています';
    why.doLimit = '実施限界 = 月末−1日。今月の面談として数えられる最後の日';

    // ---- 次の一手 ----
    var nextMove, nextKind;
    if (spend == null && expenseState === 'error') { nextMove = '経費シートが読めません。支払い合計を自分で入れてください'; nextKind = 'input'; }
    else if (bal == null) { nextMove = '月初の口座残高を入れると必要数が出ます'; nextKind = 'input'; }
    else if (spend == null) { nextMove = '経費シートを読み込むと必要数が出ます'; nextKind = 'input'; }
    else if (unitMissing) { nextMove = '1件あたり着金額を入れてください'; nextKind = 'input'; }
    else if (!inputsReady) { nextMove = '月初の口座残高を入れると必要数が出ます'; nextKind = 'input'; }
    else if (promise >= need) { nextMove = '約束で足りる月。守るのは面談の実施率（今の予定 ' + ups.length + ' 件）'; nextKind = 'ok'; }
    else {
      var cands = [];
      // 現実的な上積み = 残りの人 ×（1 − 今の率）× 0.5
      var pipeN = verbalN + loanN + judgeN + semIntentN;
      var pipeUp = 0.5 * (verbalN * (1 - R.verbal) + loanN * (1 - R.loan) + j7 * (1 - R.judge7) + j21 * (1 - R.judge21) + jOver * (1 - R.judgeOver) + semIntentN * (1 - intentRate));
      cands.push({ k: 'pipe', label: '口頭合意と判断待ち ' + pipeN + '人' + (semIntentN ? '（勉強会の決済待ち' + f1(semIntentN) + '人を含む）' : '') + 'への個別のお声がけ', x: pipeUp });
      cands.push({ k: 'upcoming', label: '面談予定の成約率を6割へ', x: upStrong });
      var semUp = 0;
      seminars.forEach(function (s) {
        if (s.active && s.attendMax != null && s.attendMax > s.attend) semUp += (s.attendMax - s.attend) * (s.direct ? s.rate : s.book * R.show * s.rate) * s.payRate;
      });
      cands.push({ k: 'seminar', label: '勉強会の参加を直近最大へ', x: semUp });
      var adUp = 0;
      if (impliedCpl != null && impliedCpl > guardMonth) adUp = adDealsFor(optPerDayFor(guardMonth)) - adDeals;
      cands.push({ k: 'ad', label: '広告CPLを死守ラインへ', x: adUp });
      cands.sort(function (a, b) { return b.x - a.x; });
      if (cands[0].x >= 0.05) { nextMove = 'いちばん効くのは' + cands[0].label + '（+' + f1(cands[0].x) + '件）'; nextKind = cands[0].k; }
      else { nextMove = 'あと' + f1(Math.max(0, need - promise)) + '件。勉強会と広告のスライダーで動かして試せます'; nextKind = 'try'; }
      why.next = cands.map(function (c) { return c.label + ' +' + f1(c.x); }).join('／');
    }

    var snap = isObj(S.snapshots) ? S.snapshots[ym] || null : null;

    return {
      ym: ym, y: y, m: m, last: last, today: tday, remainDays: remainDays,
      bookLine: bookLine, safeLine: safeLine, doLimit: doLimit,
      dates: { book: fmtMD(y, m, bookLine), safe: fmtMD(y, m, safeLine), limit: fmtMD(y, m, doLimit) },
      inputsReady: inputsReady, unitMissing: unitMissing,
      spend: spend, spendSource: spendSource, spendMissing: spend == null, otherIncome: oth, otherSource: othSource,
      extraSpend: extra, adSpend: adSpend, balanceStart: bal, expense: X, expenseState: expenseState,
      paid: paid, paidAuto: paidAuto, paidOverridden: paidOv != null, paidByVia: paidByVia, paidByViaRaw: paidByViaRaw, shiire: shiire,
      mtgDone: nz(stat.mtgDone), lostInMonth: cnt(stat.lostInMonth),
      l1: {
        verbalN: verbalN, loanN: loanN, verbalE: verbalE,
        judge7N: j7, judge21N: j21, judgeOverN: jOver, longN: longN, judgeN: judgeN, judgeE: judgeE,
        upN: ups.length, upLateN: upLateN, upReschN: upReschN, upE: upE,
        reschedN: reschedN, reschedRecentUsed: reschedRecentUsed, reschedAll: cnt(stat.resched), reschedE: reschedE,
        semIntentN: semIntentN, semIntentE: semIntentE, total: l1, low: l1Low, high: l1High
      },
      seminars: seminars, semTotal: semTotal,
      ad: {
        cpl: cpl, cplNow: cplNow, cplSource: cplSource, cplTry: cplTry, impliedCpl: impliedCpl,
        optPerDay: optPerDay, deals: adDeals, need: adNeed, needMtg: needMtg, needOpt: needOpt,
        allowSpend: allowSpend, guardCpl: guardCpl, guardRule: A.cplGuard, guardMonth: guardMonth,
        lagDays: adLag, effectiveDays: effectiveDays, share: adShare, enough: adEnough,
        budgetOpts: budgetOpts, budgetCovers: budgetCovers, budgetShort: budgetShort, meta: meta
      },
      bucket: bucket, other: other, l2: l2,
      low: low, mid: mid, high: high, midRaw: midRaw,
      need: need, needAdd: needAdd, needCash: needCash, breakEven: breakEven,
      promise: promise, promiseIsManual: pm != null, gap: gap,
      keep: keep,
      nextMove: nextMove, nextKind: nextKind,
      snapshot: snap,
      why: why
    };
  }

  /** 月初の原文として残す形（§3 snapshots） */
  function makeSnapshot(res, todayIso, note) {
    return { date: todayIso, need: res.need, low: res.low, mid: res.mid, high: res.high, promise: res.promise, note: note || '' };
  }

  return {
    VERSION: VERSION,
    defaults: defaults, normalize: normalize, compute: compute, makeSnapshot: makeSnapshot, mirrorCash: mirrorCash,
    viaKey: viaKey, fmtMan: fmtMan, fmtYen: fmtYen, fmtMD: fmtMD, f1: f1, pct: pct,
    RATE_CEIL: RATE_CEIL, DIRECT_CEIL: DIRECT_CEIL
  };
});
