'use strict';
/* 漬物シューター: the client's GameBull contract (their docs/INTEGRATION.md, src/gamebull-adapter.js) on the real
 * GameBull Stage Mode API. Loaded before their setup script (a seam in app.html), so their production page finds
 * window.GamebullAdapter, as their integration point asks; their files are unchanged.
 *
 *   their method     GameBull (gamebull-whitelabel ADR-0086, contracts/stage-mode.ts)                Life
 *   getState         GET  /play/games/{gameId}/context?tenantSlug (Bearer bootToken)               —
 *                    -> {lives: lives.count, clearedStages: 1..highestCleared, coupon}
 *   startAttempt     POST /play/plays {bootToken, stage}                                           1 (PAID, the next
 *                    -> {attempt: {id, stage, status:'started'}, state}                            stage); a cleared
 *                                                                                                  stage is FREE_REPLAY
 *                                                                                                  if the admin allows
 *   submitResult     won:  POST /play/stage-clears {sessionToken, playTimeMs} -> {state}           —
 *                    lost: no endpoint; the attempt is closed here (their spec: no refund)
 *   redeemCoupon     the server issues the all-clear voucher itself, in the clear of stage 600 (same
 *                    transaction); this returns what it issued (/context rewardClaimed)            —
 *
 * Lives, progress and the voucher are the server's; nothing is counted in the browser.
 * What the API does not have, and what this file does instead (the other Stage Mode ports' rules):
 *  - idempotent starts: no idempotency key. Their journal re-sends a start with the same requestId after a lost
 *    answer; a requestId this file has an attempt for gets that attempt back (no second Life). A start whose answer
 *    was lost (network / 5xx) is never re-sent on its own: the player is told a Life may have been used, and only
 *    their next try (再試行, or a new start) makes a new entry;
 *  - definitive refusals: their journal drops a start only on code NO_LIVES (their "確定応答"), so every refusal the
 *    server makes for good (no Lives, a locked stage, a cleared stage with replays off, the daily limit, a launch that
 *    is not Stage Mode) is thrown with that code; the message says the real reason. Any other code would make their
 *    journal re-send the refused start before every later start;
 *  - unlimited time: GameBull requires a time per attempt (maxAttemptSeconds, at most 3540 s) and the play token lives
 *    1 h, so an attempt ends at its deadline (gb/ts-hooks.js shows the time left in the last 10 minutes);
 *  - stages in order: the server opens stage n+1 only after n is cleared (gb/ts-hooks.js locks their stage list).
 * Attempts are kept in localStorage per store, game and player (their journal is in localStorage too, and re-sends
 * across a reload); the play token never goes into their storage.
 */
(function () {
  const ENV = window.TS_GB || {};
  const TOTAL = 600; // their page: 600 stages in MARUCHO_DATA.levels (checked at build time), "600" all over their UI
  const log = (...a) => console.log('[TS-GB]', ...a);

  const q = new URLSearchParams(location.search);
  // The GameBull app launches with ?tenantSlug&bootToken&gameId&returnUrl&apiBase (use-launch-game.ts); the other
  // ports' SDK also accepts sessionToken / token, in that order (playbook section 2).
  const token = q.get('bootToken') || q.get('sessionToken') || q.get('token') || '';
  const tenant = q.get('tenantSlug') || '';
  const gameId = q.get('gameId') || ENV.gameId;
  const api = ((ENV.dev && q.get('devApi')) || ENV.apiBase || '').replace(/\/+$/, '');
  const jwtPayload = t => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; } };
  const player = (jwtPayload(token) || {}).globalUserId || 'unknown';
  const KEY = 'ts-gb:v1:' + tenant + ':' + gameId + ':' + player;

  const err = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {});
  // Server codes -> Japanese (the wording of the other Stage Mode screens; their page shows e.message in their panel).
  const MESSAGES = {
    'play.no_lives': 'ライフがありません。GameBullでライフを補充してから、もう一度お試しください。',
    'stage.daily_limit_reached': '本日の挑戦回数の上限に達しました。進行状況はGameBullに保存されています。',
    'stage.stage_not_playable': 'このステージはまだ遊べません。前のステージをクリアすると遊べるようになります。',
    'stage.all_cleared': '全600ステージ達成済みです。特典はGameBullでご確認ください。',
    'stage.stage_required': 'ステージ番号の送信に問題があります。開発者へお問い合わせください。',
    'stage.play_token_required': '参加情報を確認できません。もう一度お試しください。',
    'play.session_token_expired': '参加の有効期限が切れました。GameBullのゲーム画面から開き直してください。',
    'play.session_token_invalid': 'GameBullへの接続に失敗しました。GameBullのゲーム画面から開き直してください。',
    'guest.session_invalid': 'GameBullへの接続に失敗しました。GameBullのゲーム画面から開き直してください。',
    'stage.score_not_accepted': 'クリア報告の設定に問題があります。開発者へお問い合わせください。',
    'play.mode_not_enabled': 'このゲームのステージモードをGameBull側で有効にしてください。'
  };
  const fail = (code, message) => err(code, message || MESSAGES[code] || 'GameBullへの接続に失敗しました。');
  // Answers that will not change on a retry with the same request: their journal must drop the start (see above).
  const TRANSIENT = new Set(['network', 'entry_lost', 'bad_response', 'clear_pending', 'http_429']);
  const definitive = e => !(TRANSIENT.has(e.code) || e.httpStatus >= 500);

  /* ── storage (localStorage, per store / game / player) ── */
  const blank = () => ({ attempts: {}, byRequest: {}, lost: {}, reward: null });
  let store = blank();
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && s.attempts) store = Object.assign(blank(), s); } catch { /* private mode */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* private mode */ } };

  /* ── server ── */
  let n = 0, ctx = null, checking = null;
  async function request(path, { method = 'GET', body, bearer } = {}) {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 15000);
    const headers = { Accept: 'application/json' };
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (body) headers['Content-Type'] = 'application/json';
    // GETs are cache-busted with a unique URL (a cached /context showed lives one play behind, playbook section 3).
    const url = api + path + (method === 'GET' ? (path.includes('?') ? '&' : '?') + '_ts=' + Date.now() + '-' + (++n) : '');
    let response, data;
    try {
      response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: abort.signal,
        cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    } catch { throw fail('network', '通信結果を確認できませんでした。接続を確認して、もう一度お試しください。'); }
    finally { clearTimeout(timeout); }
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      // Codes arrive nested ({error:{code}}) or top-level ({code}) (playbook section 3, error shapes).
      const code = (data && data.error && data.error.code) || (data && typeof data.code === 'string' && data.code) || 'http_' + response.status;
      const e = fail(code, MESSAGES[code] || (response.status >= 500 ? 'GameBullへの接続に失敗しました。時間をおいてお試しください。' : 'GameBullへの接続に失敗しました。'));
      e.httpStatus = response.status; throw e;
    }
    if (!data || typeof data !== 'object') throw fail('bad_response', 'GameBullからの応答を確認できませんでした。');
    return data;
  }

  // One /context at a time: their page and gb/ts-hooks.js both ask at start-up; they share the answer.
  function refresh() {
    if (!checking) checking = fetchContext().finally(() => { checking = null; });
    return checking;
  }
  async function fetchContext() {
    if (!api) throw fail('not_configured', 'GameBullの接続先が未設定です。開発者に接続設定を依頼してください。');
    if (!token || !tenant) throw fail('launch_required', 'GameBullのゲーム画面から開いてください。');
    let data;
    try { data = await request('/play/games/' + encodeURIComponent(gameId) + '/context?tenantSlug=' + encodeURIComponent(tenant), { bearer: token }); }
    catch (e) { dispatchEvent(new CustomEvent('ts-gb:context-error', { detail: e })); throw e; }
    const m = data.stageMode;
    let bad = null;
    // stageMode is sent only for a "Play Stage Mode" launch (boot token mode STAGE_CLEAR); "Game Start" gets null.
    if (!m) bad = fail('stage_mode_required', 'このゲームはステージモードで遊べます。GameBullのゲーム画面の「Play Stage Mode」から開いてください。');
    else {
      const h = m.highestCleared;
      if (m.totalStages !== TOTAL) bad = fail('bad_context', 'GameBullのステージ数が600ではありません（' + m.totalStages + '）。管理者に確認してください。');
      else if (!Number.isInteger(h) || h < 0 || h > TOTAL || (h >= TOTAL ? m.nextStage !== null : m.nextStage !== h + 1) || !(m.maxAttemptSeconds > 0))
        bad = fail('bad_context', 'ステージ情報がゲームと一致しません。管理者に確認してください。');
    }
    if (bad) { dispatchEvent(new CustomEvent('ts-gb:context-error', { detail: bad })); throw bad; }
    const first = !ctx;
    ctx = data;
    if (first) log(`Build v${ENV.build}. /context has stageMode (cleared ${m.highestCleared}/${m.totalStages}, next ${m.nextStage}, ` +
      `${m.maxAttemptSeconds} s per attempt, free replays ${m.freeReplays ? 'on' : 'off'}, daily limit ${m.dailyAttemptLimit ?? 'none'}, ` +
      `reward ${m.reward ? 'set' : 'none'}${m.rewardClaimed ? ' (claimed)' : ''}), ${lives()} Lives.`);
    dispatchEvent(new CustomEvent('ts-gb:context', { detail: data }));
    return data;
  }
  const lives = () => { const c = ctx && ctx.lives && ctx.lives.count; return Number.isInteger(c) && c >= 0 ? c : 0; };
  const sm = () => ctx && ctx.stageMode;

  /* ── their State ── */
  function coupon() {
    const m = sm();
    if (!m || !m.rewardClaimed) return null;
    const r = store.reward, title = (r && r.title) || (m.reward && m.reward.title) || '';
    return { id: (r && r.couponId) || 'gamebull-stage-reward', status: 'issued',
      label: (title ? '「' + title + '」' : '全ステージ達成の特典') + 'はGameBullのクーポン一覧に入っています。' };
  }
  // Their State (docs/INTEGRATION.md): lives, the distinct cleared stages, coupon. GameBull clears stages in order,
  // so its highestCleared h is exactly stages 1..h.
  function state() {
    const m = sm(), h = m ? m.highestCleared : 0;
    return { lives: lives(), clearedStages: Array.from({ length: h }, (_, i) => i + 1), coupon: coupon() };
  }

  /* ── attempts ── */
  function live(a) {
    if (!a || a.ended || a.result || a.clearBody) return false;
    const exp = jwtPayload(a.token);
    return !!exp && exp.exp * 1000 > Date.now() && Date.now() < a.deadline;
  }
  function close(a, why) {
    if (!a || a.ended) return;
    a.ended = true; save(); log(`Attempt ${a.attemptId} (stage ${a.stage}) closed (${why}).`);
  }
  function prune() {
    const ids = Object.keys(store.attempts).sort((x, y) => store.attempts[x].startedAt - store.attempts[y].startedAt);
    for (const id of ids.slice(0, Math.max(0, ids.length - 30))) {
      const a = store.attempts[id];
      if (a.clearBody && !a.result) continue; // a clear still to be confirmed stays
      delete store.attempts[id];
      for (const r of Object.keys(store.byRequest)) if (store.byRequest[r] === id) delete store.byRequest[r];
    }
    const lost = Object.keys(store.lost);
    for (const r of lost.slice(0, Math.max(0, lost.length - 10))) delete store.lost[r];
  }

  // A clear the server has not confirmed yet (lost answer) is sent again before a new start: their page has already
  // shown it as cleared, so the server must catch up first.
  async function settlePendingClears() {
    for (const a of Object.values(store.attempts)) {
      if (!a.clearBody || a.result) continue;
      const r = await sendClear(a);
      if (!r.ok && !r.final) throw fail(r.code || 'clear_pending', 'ステージ' + a.stage + 'のクリア記録をGameBullに送信できませんでした。通信を確認して、もう一度お試しください。');
    }
  }

  const inflight = new Map();
  // One entry per request at a time: a second call with the same requestId while the first is on the wire waits for it.
  function begin(stage, requestId) {
    const k = requestId || 'stage-' + stage;
    if (inflight.has(k)) return inflight.get(k);
    const p = enter(stage, requestId).finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  }

  async function enter(stage, requestId) {
    if (!Number.isInteger(stage) || stage < 1 || stage > TOTAL) throw fail('bad_request', 'ステージ番号が正しくありません。');
    // Their journal re-sends a start whose answer their page did not get: the attempt made for it is handed back.
    const known = requestId && store.attempts[store.byRequest[requestId]];
    if (known && known.stage !== stage) throw fail('CONFLICT', '開始要求の内容が一致しません。');
    await refresh();
    await settlePendingClears();
    if (known && live(known)) { log(`Stage ${stage}: request ${requestId.slice(0, 8)} answered again with attempt ${known.attemptId} (no Life).`); return known; }
    if (requestId && store.lost[requestId]) { delete store.lost[requestId]; save(); log(`Stage ${stage}: the player tries again after a lost answer; new entry.`); }
    const m = sm();
    const replay = m.nextStage === null || stage < m.nextStage;
    if (!replay && stage > m.nextStage) throw fail('stage.stage_not_playable');
    if (replay && !m.freeReplays) throw fail('replay_off', m.nextStage === null ? MESSAGES['stage.all_cleared']
      : 'ステージ' + stage + 'はクリア済みです。GameBullのステージモードでは、クリア済みステージは遊べません。続きのステージ' + m.nextStage + 'へ進んでください。');

    let data;
    try { data = await request('/play/plays', { method: 'POST', body: { bootToken: token, stage } }); }
    catch (e) {
      if (e.code === 'network' || e.httpStatus >= 500) {
        // No idempotency key on this call: an unknown answer is never re-sent. The next try is a new entry.
        if (requestId) { store.lost[requestId] = Date.now(); save(); }
        try { await refresh(); } catch { /* keep the message below */ }
        log(`Stage ${stage} entry answer lost (${e.code}); not re-sent.`);
        throw fail('entry_lost', '開始結果を確認できませんでした。ライフが使われた可能性があります（残りライフ ' + lives() + '）。もう一度始めると、新しい挑戦になります（ライフ1）。');
      }
      if (e.code === 'play.no_lives') { try { await refresh(); } catch { /* shown below */ } }
      log(`Stage ${stage} entry refused: ${e.code}.`);
      throw e;
    }
    const smi = data.stageMode, deadline = Date.parse(smi && smi.deadlineAt), expires = Date.parse(data.expiresAt);
    if (typeof data.playToken !== 'string' || !data.playToken || data.mode !== 'STAGE_CLEAR' || !smi || smi.stage !== stage
      || !['PAID', 'FREE_REPLAY'].includes(smi.kind) || !Number.isFinite(deadline) || !(smi.maxAttemptSeconds > 0))
      throw fail('bad_response', 'GameBullから正しい開始情報を取得できませんでした。');
    const startedAt = Date.now();
    const a = { attemptId: 'gb-' + data.playToken.slice(-12) + '-' + startedAt.toString(36), stage, token: data.playToken, kind: smi.kind,
      startedAt, limitSeconds: smi.maxAttemptSeconds,
      deadline: Math.min(deadline, Number.isFinite(expires) ? expires : Infinity, startedAt + smi.maxAttemptSeconds * 1000),
      ended: false, clearBody: null, result: null };
    // Their spec: a new start is a new attempt (1 Life); an older open attempt of this stage is over.
    for (const o of Object.values(store.attempts)) if (o.stage === stage && !o.clearBody) close(o, 'replaced by a new attempt');
    store.attempts[a.attemptId] = a;
    if (requestId) store.byRequest[requestId] = a.attemptId;
    prune(); save();
    log(`Stage ${stage} entered (${smi.kind}${smi.kind === 'PAID' ? ', 1 Life on the server' : ', free'}), limit ${smi.maxAttemptSeconds} s.`);
    try { await refresh(); } catch { /* the entry stands; lives refresh on the next call */ }
    return a;
  }

  /* ── clear report ── */
  async function sendClear(a) {
    let data;
    try { data = await request('/play/stage-clears', { method: 'POST', body: a.clearBody }); }
    catch (e) {
      // Safe resend: the same play token and playTimeMs (the server answers a repeat with its stored verdict).
      log(`Stage ${a.stage} clear not confirmed (${e.code}); it is sent again with the same report.`);
      if (e.code === 'play.session_token_expired' || e.code === 'stage.play_token_required' || e.code === 'play.session_token_invalid') {
        a.result = { status: 'TOKEN_REFUSED', stage: a.stage }; close(a, 'token refused'); return { ok: false, code: e.code, message: e.message, final: true };
      }
      return { ok: false, code: e.code, message: e.message };
    }
    if (!['CLEARED', 'ALREADY_CLEARED', 'REPLAY', 'TIME_EXCEEDED'].includes(data.status) || data.stage !== a.stage)
      return { ok: false, code: 'bad_response', message: 'クリア判定を確認できませんでした。' };
    a.result = data; close(a, 'clear ' + data.status);
    if (data.reward) {
      const path = /^\/coupons\/[^/?#]+$/.exec((() => { try { return new URL(data.reward.redeemUrl).pathname; } catch { return ''; } })());
      store.reward = Object.assign({}, data.reward, { couponId: path ? path[0].slice(9) : null, at: Date.now() });
      save();
    }
    log(`Stage ${a.stage} clear: ${data.status} (${data.highestCleared}/${data.totalStages} cleared${data.reward ? ', reward ' + data.reward.status : ''}).`);
    try { await refresh(); } catch { /* the clear answer is authoritative */ }
    dispatchEvent(new CustomEvent('ts-gb:clear', { detail: data }));
    return { ok: true, result: data };
  }

  async function completeStage(a) {
    if (a.result) return a.result.status === 'TOKEN_REFUSED' ? { ok: false, final: true, message: MESSAGES['play.session_token_expired'] } : { ok: true, result: a.result };
    if (!a.clearBody) {
      if (a.ended) return { ok: false, final: true, message: 'この挑戦は制限時間で終了しています。' };
      a.clearBody = { sessionToken: a.token, playTimeMs: Math.max(0, Date.now() - a.startedAt) };
      save();
    }
    return sendClear(a);
  }

  // State after a call: the server's when it answered, else what this page last knew (their accept() needs one).
  async function freshState() { try { await refresh(); } catch { /* last known */ } return state(); }

  /* ── their contract (docs/INTEGRATION.md): four async methods; errors carry .code ── */
  const theirs = fn => async function (input) {
    try { return await fn(input || {}); }
    catch (e) {
      dispatchEvent(new CustomEvent('ts-gb:refused', { detail: { code: e.code, message: e.message } }));
      if (definitive(e) && e.code !== 'NO_LIVES') { e.gbCode = e.code; e.code = 'NO_LIVES'; }
      throw e;
    }
  };
  window.GamebullAdapter = {
    getState: async () => { await refresh(); return state(); },
    startAttempt: theirs(async ({ stage, requestId }) => {
      const a = await begin(stage, requestId);
      return { attempt: { id: a.attemptId, stage: a.stage, status: 'started' }, state: state() };
    }),
    submitResult: async ({ attemptId, stage, outcome, requestId }) => {
      const a = store.attempts[attemptId];
      if (!a || a.stage !== stage) {
        // Not an attempt of this player in this browser (their journal is per browser, not per GameBull player):
        // nothing to report. Answering lets their journal drop it instead of blocking every later start.
        log(`Result for unknown attempt ${String(attemptId).slice(0, 24)} (stage ${stage}, ${outcome}) dropped.`);
        return { state: await freshState() };
      }
      if (outcome !== 'won') { if (!a.clearBody) close(a, 'their stage ended: ' + outcome); return { state: await freshState() }; }
      const r = await completeStage(a);
      if (!r.ok && !r.final) throw err(r.code || 'clear_pending', r.message || 'クリア記録をGameBullに送信できませんでした。再試行してください。');
      if (!r.ok) dispatchEvent(new CustomEvent('ts-gb:clear-final', { detail: { stage, message: r.message } }));
      log(`Their result for stage ${stage} (${outcome}, request ${String(requestId).slice(0, 8)}) recorded.`);
      return { state: state() };
    },
    redeemCoupon: theirs(async () => {
      await refresh();
      const m = sm();
      if (m.highestCleared < TOTAL) throw fail('NOT_ELIGIBLE', '全600ステージのクリアが必要です。');
      const c = coupon();
      if (c) return { coupon: c, state: state() };
      if (!m.reward) throw fail('no_reward', 'このお店では、全ステージ達成の特典が設定されていません。');
      throw fail('reward_pending', '特典はまだ受け取られていません（在庫切れなど）。GameBullアプリのゲーム画面から受け取れます。');
    })
  };

  window.TSGB = {
    get context() { return ctx; },
    get lives() { return lives(); },
    get reward() { return store.reward; },
    embedded: window.parent !== window,
    check: refresh,
    // The attempt of this stage that is not over yet, its deadline included (their page holds at most one), or null:
    // the timer must still find it when its time reaches 0.
    attemptFor: stage => Object.values(store.attempts).find(a => a.stage === stage && !a.ended && !a.clearBody && !a.result) || null,
    remainingMs(id) { const a = store.attempts[id]; return a && !a.ended ? Math.max(0, a.deadline - Date.now()) : 0; },
    // Time limit reached on screen: the attempt is over; the next start of this stage is a new entry.
    timeUp(id) { const a = store.attempts[id]; if (a && !a.clearBody) close(a, 'time limit'); },
    settlePendingClears
  };
})();
