/* リングタイマー — Boxing Timer G 風インターバルタイマー
 * iOS 12 (iPhone 6) の Safari で動くよう ES5 中心で書いている。
 * ?. ?? Promise版decodeAudioData などの新しい機能は使わない。
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var STORE_KEY = 'ringtimer.cfg.v1';

  /* ================================================================
   * 調整しやすい定数 (ここをいじれば挙動が変わる)
   * ================================================================ */
  var CONFIG = {
    startStrikes: 1,                              // ラウンド開始時に鳴らす回数
    endStrikes: 3,                                // ラウンド終了時に鳴らす回数
    gap: { gong: 0.75, taiko: 0.45, both: 0.75 }, // 連打の間隔(秒)
    callLead: 3,                                  // 「ラウンド○」を言い始める、休憩終了の何秒前か
    fightDelay: 0.6,                              // ゴングの何秒後に「ファイト」を言うか
    tickMs: 50
  };

  /* 録音ファイルを audio/ に置くと、合成音/TTS の代わりに自動で使われる
   *   audio/gong.mp3 taiko.mp3 clap.mp3
   *   audio/r1.mp3 ... r12.mp3 (ラウンドコール) final.mp3 (ファイナルラウンド)
   *   audio/fight.mp3 box.mp3 hajime.mp3 yame.mp3
   */
  var AUDIO_KEYS = ['gong', 'taiko', 'clap', 'final', 'fight', 'box', 'hajime', 'yame'];
  (function () { for (var n = 1; n <= 12; n++) { AUDIO_KEYS.push('r' + n); } })();

  var SHOUTS = {
    none:   { label: 'なし' },
    fight:  { label: 'ファイト', text: 'ファイト', key: 'fight' },
    box:    { label: 'ボックス', text: 'ボックス', key: 'box' },
    hajime: { label: '始め/やめ', text: '始め', key: 'hajime', endText: 'やめ', endKey: 'yame' }
  };

  var PRESETS = [
    { name: 'ボクシング 3分×3',   prepare: 30, rounds: 3, round: 180, rest: 60 },
    { name: 'キック 3分×5',       prepare: 30, rounds: 5, round: 180, rest: 60 },
    { name: 'MMA 5分×3',          prepare: 30, rounds: 3, round: 300, rest: 60 },
    { name: '空手 2分×3',         prepare: 10, rounds: 3, round: 120, rest: 30 },
    { name: 'サンドバッグ 3分×6', prepare: 10, rounds: 6, round: 180, rest: 30 },
    { name: 'タバタ 20秒×8',      prepare: 10, rounds: 8, round: 20,  rest: 10 }
  ];

  var DEFAULTS = {
    prepare: 30, rounds: 3, round: 180, rest: 60,
    warn: 10,          // 拍子木を鳴らす残り秒数 (0でOFF)
    beep3: true,       // ラスト3秒のピッ
    sound: 'gong',     // gong / taiko / both
    voice: true,       // ラウンドコール
    shout: 'fight',    // none / fight / box / hajime
    vol: 0.9
  };

  /* ================================================================
   * ユーティリティ
   * ================================================================ */
  function $(id) { return document.getElementById(id); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + pad2(s);
  }
  function trace(s) {
    if (window.__RT_TEST && window.__RT_TEST.log) { window.__RT_TEST.log(s); }
  }

  /* ================================================================
   * 設定の保存/読み込み
   * ================================================================ */
  function sanitize(c) {
    c.prepare = clamp(Math.round(c.prepare), 0, 300);
    c.rounds  = clamp(Math.round(c.rounds), 1, 99);
    c.round   = clamp(Math.round(c.round), 5, 599);
    c.rest    = clamp(Math.round(c.rest), 0, 599);
    c.warn    = clamp(Math.round(c.warn), 0, 60);
    c.vol     = clamp(Number(c.vol), 0, 1);
    if (!/^(gong|taiko|both)$/.test(c.sound)) { c.sound = 'gong'; }
    if (!SHOUTS[c.shout]) { c.shout = 'fight'; }
    return c;
  }

  function loadCfg() {
    var c = {}, k;
    for (k in DEFAULTS) { if (DEFAULTS.hasOwnProperty(k)) { c[k] = DEFAULTS[k]; } }
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && typeof s === 'object') {
        for (k in DEFAULTS) {
          if (DEFAULTS.hasOwnProperty(k) && s.hasOwnProperty(k) && typeof s[k] === typeof DEFAULTS[k]) {
            c[k] = s[k];
          }
        }
      }
    } catch (e) {}
    return sanitize(c);
  }

  function saveCfg() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  var cfg = loadCfg();

  /* ================================================================
   * 音: Web Audio の合成音 + 録音ファイル(あれば優先) + TTS(声の仮置き)
   * ================================================================ */
  var AudioEngine = (function () {
    var ctx = null, master = null, noise = null;
    var raw = {}, buffers = {};

    function ensure() {
      if (ctx) { return ctx; }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { return null; }
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = cfg.vol;
        master.connect(ctx.destination);
        noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        var d = noise.getChannelData(0);
        for (var i = 0; i < d.length; i++) { d[i] = Math.random() * 2 - 1; }
        for (var k in raw) { if (raw.hasOwnProperty(k)) { decode(k); } }
      } catch (e) { ctx = null; }
      return ctx;
    }

    /* iOS は最初のタップ内で音を鳴らさないと以後ずっと無音になる */
    function unlock() {
      var c = ensure();
      if (c) {
        try {
          if (c.state === 'suspended' && c.resume) { c.resume(); }
          var b = c.createBuffer(1, 1, 22050);
          var s = c.createBufferSource();
          s.buffer = b;
          s.connect(c.destination);
          if (s.start) { s.start(0); } else { s.noteOn(0); }
        } catch (e) {}
      }
      try {
        if (window.speechSynthesis && !unlock.spoke) {
          unlock.spoke = true;
          var u = new SpeechSynthesisUtterance(' ');
          u.volume = 0;
          window.speechSynthesis.speak(u);
        }
      } catch (e2) {}
    }

    function resumeCtx() {
      if (ctx && ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch (e) {} }
    }

    function setVol(v) { if (master) { master.gain.value = v; } }

    /* --- 録音ファイルの先読み(無ければ何もしない) --- */
    function fetchRaw(key) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', 'audio/' + key + '.mp3', true);
        x.responseType = 'arraybuffer';
        x.onload = function () {
          if (x.status === 200 && x.response && x.response.byteLength > 500) {
            raw[key] = x.response;
            decode(key);
          }
        };
        x.send();
      } catch (e) {}
    }

    function decode(key) {
      if (!ctx || !raw[key]) { return; }
      var data = raw[key];
      raw[key] = null;
      delete raw[key];
      try {
        /* iOS12 の webkitAudioContext は Promise 版が無いのでコールバック版を使う */
        ctx.decodeAudioData(data, function (b) { buffers[key] = b; }, function () {});
      } catch (e) {}
    }

    function preload() {
      for (var i = 0; i < AUDIO_KEYS.length; i++) { fetchRaw(AUDIO_KEYS[i]); }
    }

    function playBuf(key, t, gain) {
      var b = buffers[key];
      if (!b || !ctx) { return false; }
      var s = ctx.createBufferSource();
      s.buffer = b;
      var g = ctx.createGain();
      g.gain.value = gain || 1;
      s.connect(g);
      g.connect(master);
      if (s.start) { s.start(t); } else { s.noteOn(t); }
      return true;
    }

    /* --- 合成音の部品 --- */
    function tone(f, t, dur, type, vol, f2) {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      if (f2) { o.frequency.exponentialRampToValueAtTime(f2, t + dur * 0.35); }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    function noiseBurst(t, dur, ftype, freq, q, vol) {
      var s = ctx.createBufferSource();
      s.buffer = noise;
      var f = ctx.createBiquadFilter();
      f.type = ftype;
      f.frequency.value = freq;
      f.Q.value = q;
      var g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f);
      f.connect(g);
      g.connect(master);
      s.start(t);
      s.stop(t + dur + 0.05);
    }

    /* ゴング: 鐘っぽい非整数倍音を重ねる */
    function gongSynth(t) {
      var base = 820;
      var parts = [[1, 0.50, 2.4], [2.0, 0.28, 1.6], [2.76, 0.30, 1.4],
                   [4.07, 0.16, 0.9], [5.4, 0.12, 0.6], [8.93, 0.06, 0.3]];
      for (var i = 0; i < parts.length; i++) {
        tone(base * parts[i][0], t, parts[i][2], 'sine', parts[i][1] * 0.8);
      }
      noiseBurst(t, 0.03, 'highpass', 3000, 0.7, 0.5);
    }

    /* 太鼓: 低音のピッチ下降 + 皮を叩く打撃音 */
    function taikoSynth(t) {
      tone(150, t, 0.9, 'sine', 1.0, 45);
      tone(95, t, 0.7, 'triangle', 0.5, 50);
      tone(260, t, 0.12, 'sine', 0.35, 120);
      noiseBurst(t, 0.09, 'lowpass', 2200, 0.7, 0.55);
    }

    /* 拍子木: 乾いたカンカン */
    function clapSynth(t) {
      for (var k = 0; k < 2; k++) {
        var tt = t + k * 0.14;
        noiseBurst(tt, 0.06, 'bandpass', 2600, 2.5, 1.0);
        tone(1900, tt, 0.05, 'square', 0.18, 1100);
      }
    }

    function hit(kind, off) {
      trace('hit:' + kind + '@' + off.toFixed(2));
      var c = ensure();
      if (!c) { return; }
      var t = c.currentTime + off + 0.02;
      if (buffers[kind]) { playBuf(kind, t, 1); }
      else if (kind === 'gong') { gongSynth(t); }
      else { taikoSynth(t); }
    }

    /* n回連打 (設定が「両方」ならゴングと太鼓を同時に) */
    function pattern(n) {
      var kinds = cfg.sound === 'both' ? ['gong', 'taiko'] : [cfg.sound];
      var gap = CONFIG.gap[cfg.sound];
      for (var i = 0; i < n; i++) {
        for (var j = 0; j < kinds.length; j++) { hit(kinds[j], i * gap); }
      }
    }

    function clap() {
      trace('clap');
      var c = ensure();
      if (!c) { return; }
      var t = c.currentTime + 0.02;
      if (!playBuf('clap', t, 1)) { clapSynth(t); }
    }

    function beep() {
      trace('beep');
      var c = ensure();
      if (!c) { return; }
      tone(1000, c.currentTime + 0.02, 0.1, 'sine', 0.35);
    }

    /* --- 声: 録音ファイルがあればそれ、無ければ TTS --- */
    function tts(text) {
      try {
        if (!window.speechSynthesis) { return; }
        var u = new SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP';
        u.rate = 0.9;
        u.pitch = 0.6;
        u.volume = cfg.vol;
        window.speechSynthesis.speak(u);
      } catch (e) {}
    }

    function say(key, text) {
      trace('say:' + text);
      var c = ensure();
      if (c && buffers[key]) { playBuf(key, c.currentTime + 0.02, 1); return; }
      tts(text);
    }

    function cancelSpeech() {
      try { if (window.speechSynthesis) { window.speechSynthesis.cancel(); } } catch (e) {}
    }

    return {
      unlock: unlock, resumeCtx: resumeCtx, setVol: setVol, preload: preload,
      pattern: pattern, hit: hit, clap: clap, beep: beep, say: say, cancelSpeech: cancelSpeech
    };
  })();

  /* ================================================================
   * 7セグ表示 (SVG)
   * ================================================================ */
  var SEG_ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  var SEG_POLY = {
    a: [[10, 6], [14, 2], [36, 2], [40, 6], [36, 10], [14, 10]],
    g: [[10, 50], [14, 46], [36, 46], [40, 50], [36, 54], [14, 54]],
    d: [[10, 94], [14, 90], [36, 90], [40, 94], [36, 98], [14, 98]],
    f: [[6, 7], [10, 11], [10, 45], [6, 49], [2, 45], [2, 11]],
    b: [[44, 7], [48, 11], [48, 45], [44, 49], [40, 45], [40, 11]],
    e: [[6, 51], [10, 55], [10, 89], [6, 93], [2, 89], [2, 55]],
    c: [[44, 51], [48, 55], [48, 89], [44, 93], [40, 89], [40, 55]]
  };
  var DIGITS = {
    '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
    '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg'
  };

  function pts(arr, dx) {
    var out = [];
    for (var i = 0; i < arr.length; i++) { out.push((arr[i][0] + dx) + ',' + arr[i][1]); }
    return out.join(' ');
  }

  function segSVG(str) {
    var x = 0, body = '', i, j, c;
    for (i = 0; i < str.length; i++) {
      c = str.charAt(i);
      if (c >= '0' && c <= '9') {
        for (j = 0; j < SEG_ORDER.length; j++) {
          var s = SEG_ORDER[j];
          body += '<polygon class="' + (DIGITS[c].indexOf(s) >= 0 ? 'on' : 'off') +
                  '" points="' + pts(SEG_POLY[s], x) + '"/>';
        }
        x += 58;
      } else if (c === ':') {
        body += '<rect class="on" x="' + (x + 6) + '" y="30" width="10" height="10"/>' +
                '<rect class="on" x="' + (x + 6) + '" y="62" width="10" height="10"/>';
        x += 24;
      } else if (c === '/') {
        body += '<polygon class="on" points="' + (x + 22) + ',6 ' + (x + 29) + ',6 ' +
                (x + 8) + ',94 ' + (x + 1) + ',94"/>';
        x += 34;
      } else {
        x += 30;
      }
    }
    var w = Math.max(20, x - 8) + 12;
    return '<svg viewBox="0 0 ' + w + ' 100" preserveAspectRatio="xMidYMid meet">' +
           '<g transform="translate(10,0) skewX(-6)">' + body + '</g></svg>';
  }

  /* ================================================================
   * タイマー本体
   * ================================================================ */
  function buildSegments(c) {
    var s = [], r;
    if (c.prepare > 0) { s.push({ type: 'prepare', dur: c.prepare, round: 1 }); }
    for (r = 1; r <= c.rounds; r++) {
      s.push({ type: 'round', dur: c.round, round: r });
      if (r < c.rounds && c.rest > 0) { s.push({ type: 'rest', dur: c.rest, round: r }); }
    }
    return s;
  }

  var segs = buildSegments(cfg);
  var run = { status: 'idle', i: 0, segStart: 0, pausedAt: 0, flags: {}, token: 0 };
  var timerId = null;
  var wakeLock = null;

  var elApp, elPhase, elRoundSeg, elTimeSeg, elInfo, elBtnStart, elBtnReset, elBtnSettings;

  function startTimer() {
    if (timerId === null) { timerId = setInterval(tick, CONFIG.tickMs); }
  }
  function stopTimer() {
    if (timerId !== null) { clearInterval(timerId); timerId = null; }
  }

  function requestWake() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }, function () {});
      }
    } catch (e) {}
  }
  function releaseWake() {
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
  }

  function roundCallText(n) {
    if (n === cfg.rounds && n > 1) { return { key: 'final', text: 'ファイナルラウンド' }; }
    return { key: 'r' + n, text: 'ラウンド' + n };
  }

  function shoutStart() {
    var s = SHOUTS[cfg.shout];
    if (s && s.text) { AudioEngine.say(s.key, s.text); }
  }

  function shoutEnd() {
    var s = SHOUTS[cfg.shout];
    if (s && s.endText) {
      var tk = run.token;
      setTimeout(function () {
        if (run.token === tk) { AudioEngine.say(s.endKey, s.endText); }
      }, 700);
    }
  }

  /* セグメントに入った瞬間の音 */
  function enterSound(seg) {
    if (seg.type === 'round') {
      AudioEngine.pattern(CONFIG.startStrikes);
    } else if (seg.type === 'rest') {
      AudioEngine.pattern(CONFIG.endStrikes);
      shoutEnd();
    }
  }

  /* セグメント内で時間経過に応じて鳴らす音 */
  function events(seg, elapsed) {
    var f = run.flags;
    var remaining = seg.dur - elapsed;

    if (cfg.voice && (seg.type === 'prepare' || seg.type === 'rest') &&
        !f.call && remaining <= CONFIG.callLead) {
      f.call = true;
      var n = seg.type === 'prepare' ? 1 : seg.round + 1;
      var rc = roundCallText(n);
      AudioEngine.say(rc.key, rc.text);
    }

    if (seg.type === 'round') {
      if (!f.shout && elapsed >= CONFIG.fightDelay) {
        f.shout = true;
        shoutStart();
      }
      if (cfg.warn > 0 && seg.dur > cfg.warn && !f.clap && remaining <= cfg.warn) {
        f.clap = true;
        AudioEngine.clap();
      }
      if (cfg.beep3 && seg.dur > 5) {
        var k = Math.ceil(remaining);
        if (k >= 1 && k <= 3 && (f.b === undefined || k < f.b)) {
          f.b = k;
          AudioEngine.beep();
        }
      }
    }
  }

  function finishRun(playSound) {
    run.status = 'done';
    stopTimer();
    releaseWake();
    if (playSound) {
      AudioEngine.pattern(CONFIG.endStrikes);
      shoutEnd();
    }
    render();
    updateButtons();
  }

  function tick() {
    if (run.status !== 'running') { return; }
    var now = Date.now();
    var seg = segs[run.i];
    var elapsed = (now - run.segStart) / 1000;
    var entered = false;

    /* 端末がスリープ等で複数セグメント分ずれていても追いつく */
    while (elapsed >= seg.dur) {
      var endAt = run.segStart + seg.dur * 1000;
      run.i++;
      if (run.i >= segs.length) {
        finishRun((now - endAt) / 1000 < 3);
        return;
      }
      run.segStart = endAt;
      run.flags = {};
      seg = segs[run.i];
      elapsed = (now - run.segStart) / 1000;
      entered = true;
    }
    if (entered && elapsed < 1.5) { enterSound(seg); }
    events(seg, elapsed);
    render();
  }

  function begin() {
    segs = buildSegments(cfg);
    run.token++;
    run.status = 'running';
    run.i = 0;
    run.segStart = Date.now();
    run.pausedAt = 0;
    run.flags = {};
    enterSound(segs[0]);
    startTimer();
    tick();
    updateButtons();
  }

  function pause() {
    run.status = 'paused';
    run.pausedAt = Date.now();
    stopTimer();
    AudioEngine.cancelSpeech();
    render();
    updateButtons();
  }

  function resume() {
    run.segStart += Date.now() - run.pausedAt;
    run.status = 'running';
    startTimer();
    tick();
    updateButtons();
  }

  function resetRun() {
    stopTimer();
    releaseWake();
    AudioEngine.cancelSpeech();
    run.token++;
    run.status = 'idle';
    run.i = 0;
    run.flags = {};
    segs = buildSegments(cfg);
    render();
    updateButtons();
  }

  function onStartPressed() {
    AudioEngine.unlock();
    if (run.status === 'idle') {
      requestWake();
      begin();
    } else if (run.status === 'done') {
      resetRun();
      requestWake();
      begin();
    } else if (run.status === 'running') {
      pause();
    } else if (run.status === 'paused') {
      requestWake();
      resume();
    }
  }

  function onResetPressed() {
    if (run.status === 'paused' || run.status === 'done') { resetRun(); }
  }

  /* ================================================================
   * 描画
   * ================================================================ */
  var lastKey = '';

  function infoText() {
    return fmt(cfg.round) + ' × ' + cfg.rounds + 'R　REST ' + fmt(cfg.rest) +
           '　PREP ' + fmt(cfg.prepare);
  }

  function render() {
    var type, secs, round, warn = false, elapsed = 0, seg;

    if (run.status === 'idle') {
      seg = segs[0];
      type = 'idle';
      secs = seg ? seg.dur : 0;
      round = 1;
    } else if (run.status === 'done') {
      type = 'done';
      secs = 0;
      round = cfg.rounds;
    } else {
      seg = segs[run.i];
      type = seg.type;
      round = seg.round;
      var t = run.status === 'paused' ? run.pausedAt : Date.now();
      elapsed = (t - run.segStart) / 1000;
      var remaining = seg.dur - elapsed;
      secs = Math.max(0, Math.ceil(remaining - 0.0001));
      warn = type === 'round' && cfg.warn > 0 && seg.dur > cfg.warn && remaining <= cfg.warn;
    }

    var key = [type, round, secs, warn ? 1 : 0, run.status, cfg.rounds, cfg.round].join('|');
    if (key === lastKey) { return; }
    lastKey = key;

    var labels = { idle: 'READY', prepare: 'PREPARE', round: 'ROUND', rest: 'REST', done: 'FINISH' };
    elPhase.textContent = labels[type];
    elRoundSeg.innerHTML = segSVG(pad2(round) + '/' + pad2(cfg.rounds));
    elTimeSeg.innerHTML = segSVG(fmt(secs));
    elInfo.textContent = infoText();
    elApp.className = 'ph-' + type + (warn ? ' warn' : '') + (run.status === 'paused' ? ' paused' : '');
  }

  function updateButtons() {
    var st = run.status;
    elBtnStart.textContent = st === 'idle' ? 'スタート' :
                             st === 'running' ? '一時停止' :
                             st === 'paused' ? '再開' : 'もう一度';
    elBtnStart.className = 'btn primary' + (st === 'running' ? ' running' : '');
    elBtnReset.disabled = !(st === 'paused' || st === 'done');
    elBtnSettings.disabled = !(st === 'idle' || st === 'done');
  }

  function onCfgChanged() {
    sanitize(cfg);
    saveCfg();
    AudioEngine.setVol(cfg.vol);
    if (run.status === 'idle' || run.status === 'done') {
      if (run.status === 'done') { run.status = 'idle'; }
      segs = buildSegments(cfg);
      lastKey = '';
      render();
      updateButtons();
    }
  }

  /* ================================================================
   * 設定画面
   * ================================================================ */
  var ROWS = [
    { k: 'prepare', label: '準備時間',       kind: 'time', min: 0,  max: 300, step: 5 },
    { k: 'rounds',  label: 'ラウンド数',     kind: 'int',  min: 1,  max: 99,  step: 1 },
    { k: 'round',   label: 'ラウンド時間',   kind: 'time', min: 5,  max: 599, step: 5 },
    { k: 'rest',    label: '休憩時間',       kind: 'time', min: 0,  max: 599, step: 5 },
    { k: 'warn',    label: '拍子木(残り秒)', kind: 'sec',  min: 0,  max: 60,  step: 5 },
    { k: 'beep3',   label: 'ラスト3秒ピッ',  kind: 'toggle' },
    { k: 'sound',   label: '合図の音',       kind: 'seg',
      opts: [['gong', 'ゴング'], ['taiko', '太鼓'], ['both', '両方']] },
    { k: 'voice',   label: 'ラウンドコール', kind: 'toggle' },
    { k: 'shout',   label: 'かけ声',         kind: 'seg', stack: true,
      opts: [['none', 'なし'], ['fight', 'ファイト'], ['box', 'ボックス'], ['hajime', '始め/やめ']] },
    { k: 'vol',     label: '音量',           kind: 'range' }
  ];
  var updaters = [];

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }

  /* 長押しで連続変更 */
  function holdable(btn, fn) {
    var t1 = null, t2 = null;
    function stop() {
      if (t1) { clearTimeout(t1); t1 = null; }
      if (t2) { clearInterval(t2); t2 = null; }
    }
    function start(e) {
      if (e && e.preventDefault) { e.preventDefault(); }
      stop();
      fn();
      t1 = setTimeout(function () { t2 = setInterval(fn, 90); }, 450);
    }
    btn.addEventListener('touchstart', start, false);
    btn.addEventListener('touchend', stop, false);
    btn.addEventListener('touchcancel', stop, false);
    btn.addEventListener('mousedown', start, false);
    btn.addEventListener('mouseup', stop, false);
    btn.addEventListener('mouseleave', stop, false);
  }

  function valueText(row, v) {
    if (row.kind === 'time') { return fmt(v); }
    if (row.kind === 'int') { return v + 'R'; }
    return v === 0 ? 'OFF' : v + '秒';
  }

  function buildRow(row) {
    var wrap = h('div', row.stack ? 'row stack' : 'row');
    wrap.appendChild(h('span', 'lbl', row.label));
    var ctl = h('div', 'ctl');
    wrap.appendChild(ctl);

    if (row.kind === 'time' || row.kind === 'int' || row.kind === 'sec') {
      var minus = h('button', 'step', '−');
      var val = h('span', 'val', '');
      var plus = h('button', 'step', '+');
      var change = function (dir) {
        cfg[row.k] = clamp(cfg[row.k] + dir * row.step, row.min, row.max);
        onCfgChanged();
        refreshSheet();
      };
      holdable(minus, function () { change(-1); });
      holdable(plus, function () { change(1); });
      ctl.appendChild(minus);
      ctl.appendChild(val);
      ctl.appendChild(plus);
      updaters.push(function () { val.textContent = valueText(row, cfg[row.k]); });
    } else if (row.kind === 'toggle') {
      var tg = h('button', 'toggle', '');
      tg.addEventListener('click', function () {
        cfg[row.k] = !cfg[row.k];
        onCfgChanged();
        refreshSheet();
      }, false);
      ctl.appendChild(tg);
      updaters.push(function () {
        tg.textContent = cfg[row.k] ? 'ON' : 'OFF';
        tg.className = 'toggle' + (cfg[row.k] ? ' on' : '');
      });
    } else if (row.kind === 'seg') {
      var btns = [];
      row.opts.forEach(function (o) {
        var b = h('button', 'segopt', o[1]);
        b.addEventListener('click', function () {
          cfg[row.k] = o[0];
          onCfgChanged();
          refreshSheet();
        }, false);
        ctl.appendChild(b);
        btns.push([o[0], b]);
      });
      updaters.push(function () {
        btns.forEach(function (p) {
          p[1].className = 'segopt' + (cfg[row.k] === p[0] ? ' sel' : '');
        });
      });
    } else if (row.kind === 'range') {
      var inp = document.createElement('input');
      inp.type = 'range';
      inp.min = 0;
      inp.max = 100;
      inp.addEventListener('input', function () {
        cfg.vol = Number(inp.value) / 100;
        onCfgChanged();
      }, false);
      ctl.appendChild(inp);
      updaters.push(function () { inp.value = Math.round(cfg.vol * 100); });
    }
    return wrap;
  }

  function refreshSheet() {
    for (var i = 0; i < updaters.length; i++) { updaters[i](); }
  }

  function buildSheet() {
    var host = $('sheetBody');
    host.innerHTML = '';
    updaters = [];

    host.appendChild(h('div', 'sec-title', 'プリセット'));
    var pr = h('div', 'presets');
    PRESETS.forEach(function (p) {
      var b = h('button', 'chip', p.name);
      b.addEventListener('click', function () {
        cfg.prepare = p.prepare;
        cfg.rounds = p.rounds;
        cfg.round = p.round;
        cfg.rest = p.rest;
        onCfgChanged();
        refreshSheet();
      }, false);
      pr.appendChild(b);
    });
    host.appendChild(pr);

    host.appendChild(h('div', 'sec-title', 'タイマー'));
    ROWS.forEach(function (row, idx) {
      if (idx === 5) { host.appendChild(h('div', 'sec-title', '音・声')); }
      host.appendChild(buildRow(row));
    });

    host.appendChild(h('div', 'sec-title', '音を試す'));
    var tests = h('div', 'tests');
    [
      ['ゴング', function () { AudioEngine.hit('gong', 0); }],
      ['太鼓', function () { AudioEngine.hit('taiko', 0); }],
      ['拍子木', function () { AudioEngine.clap(); }],
      ['ラウンドコール', function () { AudioEngine.say('r1', 'ラウンド1'); }],
      ['かけ声', function () { shoutStart(); }]
    ].forEach(function (t) {
      var b = h('button', 'chip', t[0]);
      b.addEventListener('click', function () { AudioEngine.unlock(); t[1](); }, false);
      tests.appendChild(b);
    });
    host.appendChild(tests);

    host.appendChild(h('div', 'note',
      'Ver ' + VERSION + '\n' +
      '・音が出ないときは、iPhone横の消音スイッチをOFFにしてください。\n' +
      '・使用中は 設定 > 画面表示と明るさ > 自動ロック を「しない」にしてください。\n' +
      '・録音した声や音は audio フォルダに置くと自動で使われます。'));
    host.lastChild.style.whiteSpace = 'pre-line';

    refreshSheet();
  }

  function openSheet() {
    AudioEngine.unlock();
    buildSheet();
    $('sheet').hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; }

  /* ================================================================
   * 起動
   * ================================================================ */
  function init() {
    elApp = $('app');
    elPhase = $('phase');
    elRoundSeg = $('roundSeg');
    elTimeSeg = $('timeSeg');
    elInfo = $('info');
    elBtnStart = $('btnStart');
    elBtnReset = $('btnReset');
    elBtnSettings = $('btnSettings');

    elBtnStart.addEventListener('click', onStartPressed, false);
    elBtnReset.addEventListener('click', onResetPressed, false);
    elBtnSettings.addEventListener('click', openSheet, false);
    $('btnClose').addEventListener('click', closeSheet, false);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        AudioEngine.resumeCtx();
        if (run.status === 'running') { requestWake(); tick(); }
      }
    }, false);

    /* 画面のダブルタップ拡大を防ぐ */
    var lastTouch = 0;
    document.addEventListener('touchend', function (e) {
      var n = Date.now();
      if (n - lastTouch < 350 && e.cancelable) { e.preventDefault(); }
      lastTouch = n;
    }, false);

    AudioEngine.preload();
    render();
    updateButtons();

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function () {}, function () {});
      });
    }
  }

  /* テスト用フック (通常は何もしない) */
  if (window.__RT_TEST) {
    window.__RT_TEST.api = {
      init: init,
      pressStart: onStartPressed,
      pressReset: onResetPressed,
      getRun: function () { return run; },
      getSegs: function () { return segs; },
      setCfg: function (o) { for (var k in o) { if (o.hasOwnProperty(k)) { cfg[k] = o[k]; } } onCfgChanged(); },
      buildSegments: buildSegments,
      segSVG: segSVG,
      tick: tick
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, false);
  } else {
    init();
  }
})();
