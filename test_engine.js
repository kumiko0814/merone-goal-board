/* engine.js 単体テスト（SPEC §7）: node test_engine.js */
'use strict';
var path = require('path');
var fs = require('fs');
var E = require(path.join(__dirname, 'engine.js'));
var MOCK = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock_stat.json'), 'utf8'));
var D1110 = new Date(2026, 10, 10);

var fails = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('PASS  ' + name); }
  else { fails++; console.log('FAIL  ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}
function near(a, b, eps) { return typeof a === 'number' && Math.abs(a - b) <= (eps || 1e-6); }
function nov(extra) {
  var s = E.defaults('2026-11');
  s.seminars = [
    { id: 's1', alliance: 'famm', date: '2026-11-18', attend: null, note: '' },
    { id: 's2', alliance: 'famm', date: '2026-11-28', attend: null, note: '' },
    { id: 's3', alliance: 'ABCash', date: '2026-11-21', attend: null, note: '' }
  ];
  if (extra) extra(s);
  return s;
}
var EXP = MOCK.expense; // 経費シートのサンプル（支払 20,663,752・他収入 6,500,000）
// 旧テストと同じ「必要45」になる入力: 支払いを自分で入れる・シート外/広告費/他収入なし
function cash45(s, spendOv) { s.cash.balanceStart = 5000000; s.cash.spendOverride = spendOv == null ? 24500000 : spendOv; s.cash.extraSpend = 0; s.cash.addAdBudget = false; s.cash.otherIncomeOverride = 0; }
function emptyStat() { return { paidMainCount: 0, paidMainByVia: {}, pipeline: [], upcoming: [], resched: 0 }; }

// ① 入力空 → need null・次の一手は入力案内
(function () {
  var r = E.compute(E.defaults('2026-11'), MOCK, null, D1110);
  check('①-1 入力空なら need は null', r.need === null, r.need);
  check('①-2 次の一手は入力案内（月初の口座残高）', r.nextMove === '月初の口座残高を入れると必要数が出ます', r.nextMove);
  var rx = E.compute(E.defaults('2026-11'), MOCK, null, D1110, { expense: EXP });
  check('①-4 経費シートが読めても残高が空なら need null・同じ案内', rx.need === null && rx.spend === 20663752 && rx.spendSource === 'sheet' && rx.nextMove === '月初の口座残高を入れると必要数が出ます', [rx.need, rx.spend, rx.nextMove]);
  var r0 = E.compute(null, null, null, D1110);
  check('①-3 設定・実績が全部 null でも落ちない', r0 && r0.need === null && r0.mid >= 0 && r0.paid === 0, { mid: r0.mid, paid: r0.paid });
})();

// ② 11/10 サンプル → mid 33〜37・low<mid<high
(function () {
  var r = E.compute(nov(), MOCK, null, D1110);
  check('②-1 入金済み10', r.paid === 10, r.paid);
  check('②-2 口頭合意4（うちローン1）', r.l1.verbalN + r.l1.loanN === 4 && r.l1.loanN === 1, r.l1);
  check('②-3 判断待ち 8/4/3', r.l1.judge7N === 8 && r.l1.judge21N === 4 && r.l1.judgeOverN === 3, [r.l1.judge7N, r.l1.judge21N, r.l1.judgeOverN]);
  check('②-4 面談予定27・うち月末3日が3', r.l1.upN === 27 && r.l1.upLateN === 3, [r.l1.upN, r.l1.upLateN]);
  check('②-5 リスケ3', r.l1.reschedN === 3, r.l1.reschedN);
  // 広告の面談リードタイム12日を入れたので、spec当初の33〜37から約2件下がる（広告 4.99 → 2.96）
  check('②-6 mid が 31〜33（広告リードタイム込み）', r.mid >= 31 && r.mid <= 33, r.mid);
  check('②-6b 広告の成約 = 20人 × 間に合う9日 × 4.3% × 45% × 85%', near(r.ad.deals, 20 * 9 * 0.043 * 0.45 * 0.85, 1e-9) && r.ad.effectiveDays === 9, [r.ad.deals, r.ad.effectiveDays]);
  check('②-7 low < mid < high', r.low < r.mid && r.mid < r.high, [r.low, r.mid, r.high]);
  check('②-8 経路別の入金 広告3・BUCKET4・SHE2・famm1', r.paidByVia['広告'] === 3 && r.paidByVia.BUCKET === 4 && r.paidByVia.SHE === 2 && r.paidByVia.famm === 1, r.paidByVia);
  check('②-9 仕入れコースは別枠2', r.shiire === 2, r.shiire);
  check('②-10 約束 = round((low+mid)/2)', r.promise === Math.round((r.low + r.mid) / 2), [r.low, r.mid, r.promise]);
  check('②-11 日付の線 11/21(土)・11/27(金)・11/29(日)', r.dates.book === '11/21(土)' && r.dates.safe === '11/27(金)' && r.dates.limit === '11/29(日)', r.dates);
  check('②-12 残り日数21', r.remainDays === 21, r.remainDays);
  var keys = ['need', 'mid', 'range', 'promise', 'paid', 'verbal', 'judge', 'upcoming', 'resched', 'ad', 'guard', 'bucket', 'other'];
  check('②-13 主要な数字に why がある', keys.every(function (k) { return typeof r.why[k] === 'string' && r.why[k].length > 0; }), keys.filter(function (k) { return !r.why[k]; }));
})();

// ③ 必要数の検算（新しいお金の形: 月の合計・入金済みは足さない）
(function () {
  var EXP2 = { ok: true, spendTotal: 22120453, otherIncome: 6500000, items: [] };
  function c(fn) { return nov(function (s) { s.cash.balanceStart = 5000000; if (fn) fn(s); }); }
  var r = E.compute(c(), MOCK, null, D1110, { expense: EXP2 });
  check('③-1 支払2,212万＋シート外910万＋広告377万−他収入650万＋残す300万−月初500万 = 2,649万 → 53件', r.needCash === 26490453 && r.need === 53, [r.needCash, r.need]);
  check('③-2 損益分岐（残す0） = ceil(2,349万/50万) = 47件', r.breakEven === 47, r.breakEven);
  var rOff = E.compute(c(function (s) { s.cash.addAdBudget = false; }), MOCK, null, D1110, { expense: EXP2 });
  check('③-3 広告費をシート外に入れない → ceil(2,272万/50万) = 46件', rOff.needCash === 22720453 && rOff.need === 46 && rOff.adSpend === 0, [rOff.needCash, rOff.need]);
  var rm = E.compute(c(), MOCK, null, D1110, { expense: EXP });
  check('③-4 サンプル経費（2,066万）・広告あり → 51件・損益分岐45件', rm.need === 51 && rm.breakEven === 45, [rm.need, rm.breakEven]);
  var rm2 = E.compute(c(function (s) { s.cash.addAdBudget = false; }), MOCK, null, D1110, { expense: EXP });
  check('③-5 サンプル経費・広告なし → ceil(2,126万/50万) = 43件・損益分岐37件', rm2.need === 43 && rm2.breakEven === 37, [rm2.need, rm2.breakEven]);
  var st0 = emptyStat(); st0.paidMainCount = 0;
  var rp = E.compute(c(), st0, null, D1110, { expense: EXP });
  check('③-6 必要は月の合計（入金済みを足さない）', rp.need === rm.need, [rp.need, rm.need]);
  var w = r.why.need;
  check('③-7 why に実際の数字', /支払2,212万/.test(w) && /シート外910万/.test(w) && /広告費（カード・シート外）377万/.test(w) && /他収入650万/.test(w) && /残す300万/.test(w) && /月初残高500万/.test(w) && /1件50万/.test(w) && /53件/.test(w), w);
  check('③-8 広告なしの why に広告費が出ない', !/広告費/.test(rOff.why.need), rOff.why.need);
  var rErr = E.compute(c(), MOCK, null, D1110, { expense: { ok: false, error: '11月の列がありません' } });
  check('③-9 経費シートが読めない・自分で入れていない → need null・専用の案内', rErr.need === null && rErr.spendMissing && rErr.expenseState === 'error' && rErr.nextMove === '経費シートが読めません。支払い合計を自分で入れてください', rErr.nextMove);
  var rOv = E.compute(c(function (s) { s.cash.spendOverride = 20000000; }), MOCK, null, D1110, { expense: { ok: false, error: 'x' } });
  check('③-10 読めなくても自分で入れた支払いで計算（他収入は0）', rOv.need === Math.ceil((20000000 + 9100000 + 3770000 - 0 + 3000000 - 5000000) / 500000) && rOv.spendSource === 'manual' && rOv.otherIncome === 0, rOv.need);
  var rOv2 = E.compute(c(function (s) { s.cash.spendOverride = 21000000; s.cash.otherIncomeOverride = 1000000; }), MOCK, null, D1110, { expense: EXP });
  check('③-11 自分で入れた値がシートより優先', rOv2.spend === 21000000 && rOv2.otherIncome === 1000000 && rOv2.otherSource === 'manual', [rOv2.spend, rOv2.otherIncome]);
  check('③-12 シート外の支払いの既定: 11月は910万（税金）・12月は0', E.defaults('2026-11').cash.extraSpend === 9100000 && E.defaults('2026-11').cash.extraSpendNote === '税金' && E.defaults('2026-12').cash.extraSpend === 0);
  var rNeg = E.compute(c(function (s) { s.cash.balanceStart = 90000000; }), MOCK, null, D1110, { expense: EXP });
  check('③-13 need は0未満にならない', rNeg.need === 0 && rNeg.breakEven === 0, [rNeg.need, rNeg.breakEven]);
  var r45 = E.compute(nov(function (s) { cash45(s); }), MOCK, null, D1110);
  check('③-14 旧テストと同じ入力で need 45', r45.need === 45, r45.need);
  var rReach = E.compute(nov(function (s) { cash45(s); s.promiseManual = 50; }), MOCK, null, D1110);
  check('③-15 約束 ≥ 必要 → 「約束で足りる月」', /^約束で足りる月。守るのは面談の実施率（今の予定 27 件）$/.test(rReach.nextMove), rReach.nextMove);
  check('③-16 お声がけ候補は「n人への個別のお声がけ」・決め切りは使わない', /^いちばん効くのは口頭合意と判断待ち 19人への個別のお声がけ（\+[\d.]+件）$/.test(r45.nextMove) && !/決め切り/.test(r45.nextMove), r45.nextMove);
  var up = 0.5 * (3 * 0.69 + 1 * 0.5 + 8 * 0.65 + 4 * 0.85 + 3 * 0.95);
  check('③-17 お声がけの上積み = 残りの人 ×（1−今の率）× 0.5', r45.nextMove.indexOf('+' + (Math.round(up * 10) / 10) + '件') > 0, r45.nextMove);
  var r0 = E.compute(nov(function (s) { cash45(s); s.cash.unitCash = 0; }), MOCK, null, D1110);
  check('③-18 1件あたり着金額0 → 専用の案内・need null', r0.need === null && r0.unitMissing && r0.nextMove === '1件あたり着金額を入れてください', r0.nextMove);
  check('③-19 E.VERSION がある', typeof E.VERSION === 'string' && E.VERSION.length > 0);
  var mir = E.mirrorCash(c());
  check('③-20 保存用に cashByMonth[ym] へ写す', JSON.stringify(mir.cashByMonth['2026-11']) === JSON.stringify(mir.cash) && mir.cashByMonth['2026-11'].balanceStart === 5000000);
})();

// ④ 勉強会の needRate > 0.75 → verdict と needAttend
(function () {
  var r = E.compute(nov(function (s) { cash45(s); }), MOCK, null, D1110);
  var s1 = r.seminars[0];
  check('④-1 needRate > 0.75', s1.needRate > 0.75, s1.needRate);
  check('④-2 verdict = 過去最高75%を超える', s1.verdict === '過去最高75%を超える' && s1.verdictKind === 'pink', s1.verdict);
  var per = 0.25 * 0.8 * 0.35 * 0.75;
  check('④-3 needAttend = ceil(needDeals / (book×show×byVia×payRate))', s1.needAttend === Math.ceil(s1.needDeals / per), [s1.needAttend, s1.needDeals]);
  var sum = r.seminars.reduce(function (a, s) { return a + (s.needDeals || 0); }, 0);
  check('④-4 勉強会の needDeals 合計 ＋ 広告の adNeed = gap（二重に数えない）', near(sum + r.ad.need, r.gap, 1e-9), [sum, r.ad.need, r.gap]);
  check('④-4b gap = need − paid − 見えている分 − BUCKET − その他', near(r.gap, Math.max(0, r.need - r.paid - r.l1.total - r.bucket - r.other), 1e-9), r.gap);
  var all = r.semTotal + r.ad.deals;
  check('④-4c 勉強会1回目の割合 = thisMonth / (勉強会合計 ＋ 広告)', near(s1.needDeals, r.gap * s1.thisMonth / all, 1e-9));
  check('④-5 needRate = needDeals / (面談 × 入金率)', near(s1.needRate, s1.needDeals / (s1.mtgs * s1.payRate), 1e-9));
  var small = E.compute(nov(function (s) { cash45(s, 12000000); }), MOCK, null, D1110);
  check('④-6 足りない分0 → 届く範囲・needAttend なし', small.seminars[0].verdict === '届く範囲' && small.seminars[0].needAttend === null, small.seminars[0]);
  var past = E.compute(nov(function (s) { s.seminars.push({ id: 's0', alliance: 'SHE', date: '2026-11-05', attend: 40 }); }), MOCK, null, D1110);
  var p = past.seminars[3];
  check('④-7 開催済みの回は今月見込み0（実績に移行）', p.past === true && p.thisMonth === 0 && p.needDeals === null, p);
  var fm = E.compute(nov(), MOCK, null, D1110).seminars[0];
  check('④-8 famm 11/18 参加空欄 → 中央値29・前半75%', fm.attend === 29 && fm.attendIsMedian && fm.payRate === 0.75 && near(fm.thisMonth, 29 * 0.25 * 0.8 * 0.35 * 0.75), fm);
  var sm = E.compute(nov(), MOCK, null, D1110).seminars[1];
  check('④-9 famm 11/28 は予約ラインより後 → 15%', sm.payRate === 0.15 && sm.firstHalf === false, sm.payRate);
})();

// ⑤ 広告 guardCpl の式
(function () {
  var r = E.compute(nov(function (s) { cash45(s); }), MOCK, null, D1110);
  var A = E.defaults('2026-11').ads, ad = r.ad;
  check('⑤-1 adNeed = gap × 広告 / (勉強会合計 ＋ 広告)', near(ad.need, r.gap * ad.deals / (r.semTotal + ad.deals), 1e-9), [ad.need, r.gap, ad.deals, r.semTotal]);
  check('⑤-2 needOpt = adNeed / 成約 / 面談化', near(ad.needOpt, ad.need / A.mtgToPaid / A.optToMtg, 1e-9));
  check('⑤-3 allowSpend = adNeed × 25万', near(ad.allowSpend, ad.need * 250000, 1e-6));
  check('⑤-4 guardCpl = allowSpend / needOpt = 25万×45%×4.3% = 4,837.5円', near(ad.guardCpl, ad.allowSpend / ad.needOpt, 1e-6) && near(ad.guardCpl, 4837.5, 1e-6), ad.guardCpl);
  check('⑤-5 今月の死守CPL = min(式, 5,500)', ad.guardMonth === Math.min(ad.guardCpl, 5500), ad.guardMonth);
  var meta = { ok: true, spend: 1100000, regs: 220, cpl: 5000 };
  var rm = E.compute(nov(), MOCK, meta, D1110);
  var opd = (3770000 / 30) / 5000;
  check('⑤-6 Meta の CPL 5,000円 → 1日オプト = 予算/30/CPL', near(rm.ad.optPerDay, opd, 1e-9) && rm.ad.cplSource === 'auto', rm.ad.optPerDay);
  check('⑤-7 広告の成約 = opt × (残り21日 − 12日) × 面談化 × 成約 × 85%', near(rm.ad.deals, opd * 9 * 0.043 * 0.45 * 0.85, 1e-9), rm.ad.deals);
  var rt = E.compute(nov(), MOCK, meta, D1110, { cplTry: 2500 });
  check('⑤-8 CPLスライダー（試し値）で広告の成約が増える', rt.ad.deals > rm.ad.deals && rt.mid >= rm.mid && rt.ad.cplTry === 2500, [rt.ad.deals, rm.ad.deals]);
  var noGap = E.compute(nov(function (s) { cash45(s, 1000000); s.cash.balanceStart = 50000000; }), MOCK, null, D1110);
  check('⑤-9 足りない分0 → 「足りる」・adNeed 0・CPLの線は定数のまま', noGap.ad.enough === true && noGap.ad.need === 0 && near(noGap.ad.guardCpl, 4837.5, 1e-6) && near(noGap.ad.guardMonth, 4837.5, 1e-6), noGap.ad);
  var g2 = E.compute(nov(function (s) { s.ads.maxCostPerDeal = 400000; }), MOCK, null, D1110);
  check('⑤-10 線が5,500円を超える時は 今月の死守CPL = ガード5,500円', near(g2.ad.guardCpl, 400000 * 0.45 * 0.043, 1e-6) && g2.ad.guardMonth === 5500, [g2.ad.guardCpl, g2.ad.guardMonth]);
  check('⑤-11 予算でまかなえるか = 広告の成約 ≥ adNeed', ad.budgetCovers === (ad.deals >= ad.need) && near(ad.budgetShort, Math.max(0, ad.need - ad.deals), 1e-9) && near(ad.budgetOpts, ad.optPerDay * ad.effectiveDays, 1e-9), [ad.budgetCovers, ad.budgetShort]);
})();

// ⑥ 月末3日の面談は lateMonthPay
(function () {
  function one(plan, status) {
    var st = emptyStat(); st.upcoming = [{ via: '広告', plan: plan, status: status || '面談前' }];
    return E.compute(E.defaults('2026-11'), st, null, D1110).l1;
  }
  check('⑥-1 11/27 は着金安全〆まで → 0.8×0.45×0.85', near(one('11/27').upE, 0.8 * 0.45 * 0.85));
  check('⑥-2 11/28 は lateMonthPay → 0.8×0.45×0.30', near(one('11/28').upE, 0.8 * 0.45 * 0.3) && one('11/28').upLateN === 1);
  check('⑥-3 11/30 も lateMonthPay', near(one('11/30').upE, 0.8 * 0.45 * 0.3));
  check('⑥-4 リスケ中は実施50%', near(one('11/20', 'リスケ').upE, 0.5 * 0.45 * 0.85));
  var st = emptyStat(); st.upcoming = [{ via: 'BUCKET LIST', plan: '11/12', status: '面談前' }];
  check('⑥-5 経由 BUCKET LIST は BUCKET の率47%', near(E.compute(E.defaults('2026-11'), st, null, D1110).l1.upE, 0.8 * 0.47 * 0.85));
})();

// 広告のリードタイム（友だち追加→面談 12日）
(function () {
  var r19 = E.compute(nov(), MOCK, null, new Date(2026, 10, 19));
  check('⑦-1 残り12日（= adLagDays）なら広告の今月成約は0', r19.remainDays === 12 && r19.ad.effectiveDays === 0 && r19.ad.deals === 0, [r19.remainDays, r19.ad.deals]);
  var r25 = E.compute(nov(), MOCK, { ok: true, cpl: 3000 }, new Date(2026, 10, 25));
  check('⑦-2 残り6日（< adLagDays）でも0（CPLが安くても）', r25.ad.deals === 0, r25.ad.deals);
  var r18 = E.compute(nov(), MOCK, null, new Date(2026, 10, 18));
  check('⑦-3 残り13日なら間に合うのは1日分', r18.ad.effectiveDays === 1 && near(r18.ad.deals, 20 * 1 * 0.043 * 0.45 * 0.85, 1e-9), r18.ad.deals);
  var r0 = E.compute(nov(function (s) { s.rates.adLagDays = 0; }), MOCK, null, D1110);
  check('⑦-4 adLagDays を0にすると残り21日ぜんぶ使う', r0.ad.effectiveDays === 21, r0.ad.effectiveDays);
  check('⑦-5 既定の adLagDays は12', E.defaults('2026-11').rates.adLagDays === 12);
  var old = E.normalize({ ym: '2026-11', rates: { verbal: 0.31 } }, '2026-11');
  check('⑦-6 古い保存データにも adLagDays 12 が補われる', old.rates.adLagDays === 12);
})();

// その他（表示・月替わり）
(function () {
  check('表示-1 377万円', E.fmtMan(3770000) === '377万円', E.fmtMan(3770000));
  check('表示-2 1,250.5万円', E.fmtMan(12505000) === '1,250.5万円', E.fmtMan(12505000));
  check('表示-3 5,500円', E.fmtYen(5500) === '5,500円');
  check('表示-4 M/d(曜)', E.fmtMD(2026, 11, 18) === '11/18(水)');
  var old = nov(function (s) { s.ym = '2026-10'; s.cash.balanceStart = 1; s.cash.balanceDate = '2026-10-01'; s.cash.extraSpend = 777; s.cash.spendOverride = 5; s.cash.otherIncomeOverride = 6; s.cash.keep = 4000000; s.rates.verbal = 0.4; s.snapshots['2026-10'] = { date: '2026-10-01', need: 40 }; s._health = 123; });
  var n = E.normalize(old, '2026-11');
  var nDec = E.normalize(nov(function (s) { s.cash.balanceStart = 1; s.cash.extraSpend = 9100000; s.cash.spendOverride = 5; }), '2026-12');
  check('月替わり-0 11月→12月: シート外は0・月初残高は空・自分で入れた値は null', nDec.cash.extraSpend === 0 && nDec.cash.balanceStart === null && nDec.cash.spendOverride === null && nDec.cashByMonth['2026-11'].extraSpend === 9100000, nDec.cash);
  check('月替わり-1 10月→11月: 月初残高・入力日は空・シート外は11月の既定（税金910万）・自分で入れた値は null・勉強会は空', n.cash.extraSpend === 9100000 && n.cash.balanceStart === null && n.cash.balanceDate === '' && n.cash.spendOverride === null && n.cash.otherIncomeOverride === null && n.seminars.length === 0, n.cash);
  check('月替わり-1b 先月の入力は cashByMonth に残る・残す額は引き継ぐ', n.cashByMonth['2026-10'] && n.cashByMonth['2026-10'].balanceStart === 1 && n.cashByMonth['2026-10'].extraSpend === 777 && n.cash.keep === 4000000, n.cashByMonth);
  var legacy = E.normalize({ ym: '2026-11', cash: { balance: 1, spendRemain: 2, otherIncome: 3, paidAtBalance: 4 } }, '2026-11');
  check('月替わり-1c 旧モデルの項目（今日の残高・paidAtBalance など）は消える', !('balance' in legacy.cash) && !('spendRemain' in legacy.cash) && !('otherIncome' in legacy.cash) && !('paidAtBalance' in legacy.cash) && legacy.cash.extraSpend === 9100000, legacy.cash);
  check('月替わり-2 率とスナップショットは引き継ぐ', n.rates.verbal === 0.4 && n.snapshots['2026-10'].need === 40 && n.ym === '2026-11');
  check('月替わり-3 _health は残らない', !('_health' in n));
  var part = E.normalize({ ym: '2026-11', rates: { byVia: { famm: 0.3 } } }, '2026-11');
  check('補完-1 足りない既定値は補われる', part.rates.byVia.famm === 0.3 && part.rates.byVia.SHE === 0.5 && part.ads.cplGuard === 5500);
  check('経由-1 名寄せ', E.viaKey('BUCKET LIST') === 'BUCKET' && E.viaKey('Famm') === 'famm' && E.viaKey('ABCASH') === 'ABCash' && E.viaKey('LiLi') === 'LiLI' && E.viaKey('Li-Li') === 'LiLI' && E.viaKey('広告') === '広告' && E.viaKey('SHE') === 'SHE' && E.viaKey('') === 'その他');
  check('経由-2 スマセル・シンママ・その他は「その他」', E.viaKey('スマセル') === 'その他' && E.viaKey('シンママ') === 'その他' && E.viaKey('その他') === 'その他' && E.viaKey('（空欄）') === 'その他');
  var rawSt = emptyStat(); rawSt.paidMainCount = 5; rawSt.paidMainByVia = { 'BUCKET LIST': 3, 'Li-Li': 1, 'スマセル': 1 };
  var rr = E.compute(E.defaults('2026-11'), rawSt, null, D1110);
  check('経由-3 チップ用は元のラベル・率は名寄せ後', rr.paidByViaRaw['BUCKET LIST'] === 3 && rr.paidByViaRaw['Li-Li'] === 1 && rr.paidByVia.BUCKET === 3 && rr.paidByVia.LiLI === 1 && rr.paidByVia['その他'] === 1, [rr.paidByViaRaw, rr.paidByVia]);
  var rs = emptyStat(); rs.resched = 171; rs.reschedRecent = 3;
  var rsr = E.compute(E.defaults('2026-11'), rs, null, D1110);
  check('リスケ-1 reschedRecent(3) を使い、全期間の resched(171) は使わない', rsr.l1.reschedN === 3 && near(rsr.l1.reschedE, 3 * 0.1 * 0.45) && rsr.l1.reschedRecentUsed, rsr.l1.reschedN);
  var rs2 = emptyStat(); rs2.resched = 3;
  check('リスケ-2 reschedRecent が無い時だけ resched', E.compute(E.defaults('2026-11'), rs2, null, D1110).l1.reschedN === 3);
  var ls = emptyStat(); ls.pipeline = [
    { cat: '失注', via: '広告', days: 3, status: '失注' },
    { cat: '口頭合意', via: '広告', days: 3, status: '失注（音信不通）' },
    { cat: '口頭合意', via: 'famm', days: 2, status: 'ローン申請中' },
    { cat: '判断待ち', via: 'SHE', days: 10, status: '判断前' },
    { cat: '長期戦', via: 'SHE', days: 50, status: '長期戦' }];
  var lr = E.compute(E.defaults('2026-11'), ls, null, D1110).l1;
  check('失注-1 失注の行は数えない・ローン申請中は loan', lr.verbalN === 0 && lr.loanN === 1 && near(lr.verbalE, 0.5), lr);
  check('判断-1 判断待ち10日→judge21・長期戦→judgeOver', lr.judge21N === 1 && lr.judgeOverN === 1 && near(lr.judgeE, 0.15 + 0.05), lr);
  var mm = E.compute(nov(), MOCK, { ok: false, error: 'token未設定' }, D1110);
  check('Meta-1 token未設定 → 自動CPLなし・既定のオプトで計算', mm.ad.cplSource === null && mm.ad.cplNow === null && near(mm.ad.optPerDay, 20), mm.ad);
  var mm2 = E.compute(nov(function (s) { s.ads.cplManual = 5200; }), MOCK, { ok: false, error: 'token未設定' }, D1110);
  check('Meta-2 token未設定でも手入力CPLが使われる', mm2.ad.cplSource === 'manual' && mm2.ad.cplNow === 5200, mm2.ad.cplNow);
  var sres = E.compute(nov(), MOCK, null, D1110), snap = E.makeSnapshot(sres, '2026-11-10');
  check('スナップショット-1 形', snap.date === '2026-11-10' && 'need' in snap && snap.mid === sres.mid && snap.low === sres.low && snap.high === sres.high && snap.promise === sres.promise, snap);
  var pv = E.compute(nov(function (s) { s.manual.paidOverride = 12; }), MOCK, null, D1110);
  check('手入力-1 入金済みの上書き', pv.paid === 12 && pv.paidOverridden);
  var r = E.compute(nov(), MOCK, null, D1110);
  var txt = JSON.stringify(r);
  check('個人名-1 結果に name/closer が出ない', !/"name"|"closer"/.test(txt));
})();

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
