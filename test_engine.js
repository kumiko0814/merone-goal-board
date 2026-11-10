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
function emptyStat() { return { paidMainCount: 0, paidMainByVia: {}, pipeline: [], upcoming: [], resched: 0 }; }

// ① 入力空 → need null・次の一手は入力案内
(function () {
  var r = E.compute(E.defaults('2026-11'), MOCK, null, D1110);
  check('①-1 入力空なら need は null', r.need === null, r.need);
  check('①-2 次の一手は入力案内', r.nextMove === '残高・残りの支払い・残す額の3つを入れると必要数が出ます', r.nextMove);
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

// ③ 必要数の検算
(function () {
  var r = E.compute(nov(function (s) { s.cash.balance = 5000000; s.cash.spendRemain = 25000000; s.cash.keep = 3000000; s.cash.unitCash = 500000; }), MOCK, null, D1110);
  check('③-1 needCash 2,300万 → needAdd 46', r.needCash === 23000000 && r.needAdd === 46, [r.needCash, r.needAdd]);
  check('③-2 need = paid10 + 46 = 56', r.need === 56, r.need);
  check('③-3 損益分岐 = 10 + ceil(2,000万/50万) = 50', r.breakEven === 50, r.breakEven);
  var r45 = E.compute(nov(function (s) { s.cash.balance = 5000000; s.cash.spendRemain = 19500000; }), MOCK, null, D1110);
  check('③-4 残高500万・残り支払い1,950万・残す300万 → need 45', r45.need === 45 && r45.needAdd === 35, [r45.need, r45.needAdd]);
  var rOther = E.compute(nov(function (s) { s.cash.balance = 5000000; s.cash.spendRemain = 19500000; s.cash.otherIncome = 1000000; }), MOCK, null, D1110);
  check('③-5 売上以外の入金100万で need が2減る', rOther.need === 43, rOther.need);
  var rNeg = E.compute(nov(function (s) { s.cash.balance = 90000000; s.cash.spendRemain = 1000000; }), MOCK, null, D1110);
  check('③-6 needAdd は0未満にならない', rNeg.needAdd === 0 && rNeg.need === 10, [rNeg.needAdd, rNeg.need]);
  var rBase = E.compute(nov(function (s) { s.cash.balance = 5000000; s.cash.spendRemain = 19500000; s.cash.paidAtBalance = 0; }), MOCK, null, D1110);
  check('③-7 残高を入れた時点の入金済み(0)を基準にすると need = 35', rBase.need === 35, rBase.need);
  var rReach = E.compute(nov(function (s) { s.cash.balance = 5000000; s.cash.spendRemain = 19500000; s.promiseManual = 50; }), MOCK, null, D1110);
  check('③-8 約束 ≥ 必要 → 「約束で足りる月」', /^約束で足りる月。守るのは面談の実施率（今の予定 27 件）$/.test(rReach.nextMove), rReach.nextMove);
  check('③-9 約束が足りない時は「いちばん効くのは…（+x件）」', /^いちばん効くのは.+（\+[\d.]+件）$/.test(r45.nextMove), r45.nextMove);
  check('③-10 お声がけ候補は「n人への個別のお声がけ」・決め切りは使わない', /^いちばん効くのは口頭合意と判断待ち 19人への個別のお声がけ（\+[\d.]+件）$/.test(r45.nextMove) && !/決め切り/.test(r45.nextMove), r45.nextMove);
  var up = 0.5 * (3 * 0.69 + 1 * 0.5 + 8 * 0.65 + 4 * 0.85 + 3 * 0.95);
  check('③-11 お声がけの上積み = 残りの人 ×（1−今の率）× 0.5 = ' + up.toFixed(2), r45.nextMove.indexOf('+' + (Math.round(up * 10) / 10) + '件') > 0, r45.nextMove);
  var r0 = E.compute(nov(function (s) { s.cash.balance = 5000000; s.cash.spendRemain = 19500000; s.cash.unitCash = 0; }), MOCK, null, D1110);
  check('③-12 1件あたり着金額0 → 専用の案内・need null', r0.need === null && r0.unitMissing && r0.nextMove === '1件あたり着金額を入れてください', r0.nextMove);
  check('③-13 E.VERSION がある', typeof E.VERSION === 'string' && E.VERSION.length > 0);
})();

// ④ 勉強会の needRate > 0.75 → verdict と needAttend
(function () {
  var r = E.compute(nov(function (s) { s.cash.balance = 5000000; s.cash.spendRemain = 19500000; }), MOCK, null, D1110);
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
  var small = E.compute(nov(function (s) { s.cash.balance = 5000000; s.cash.spendRemain = 7000000; }), MOCK, null, D1110);
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
  var r = E.compute(nov(function (s) { s.cash.balance = 5000000; s.cash.spendRemain = 19500000; }), MOCK, null, D1110);
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
  var noGap = E.compute(nov(function (s) { s.cash.balance = 50000000; s.cash.spendRemain = 1000000; }), MOCK, null, D1110);
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
  var old = nov(function (s) { s.ym = '2026-10'; s.cash.balance = 1; s.cash.spendRemain = 2; s.rates.verbal = 0.4; s.snapshots['2026-10'] = { date: '2026-10-01', need: 40 }; s._health = 123; });
  var n = E.normalize(old, '2026-11');
  check('月替わり-1 残高・支払い・勉強会は空に戻る', n.cash.balance === null && n.cash.spendRemain === null && n.seminars.length === 0, n.cash);
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
