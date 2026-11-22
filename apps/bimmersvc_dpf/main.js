'use strict';

const mgu = require('./kit/mgu');
const { Diag, replyTo } = require('./kit/diag');
const W = 1600, H = 520;

const C = {
  bg: '#091726',
  panel: '#14283F',
  panel2: '#193650',
  blue: '#62BEF5',
  white: '#EDF5FF',
  muted: '#94AFC8',
  mint: '#6ADDBA',
  amber: '#F6BD67',
  line: '#30465B'
};

mgu.run({
  async start(ctx) {
    const {ui, settings, log} = ctx;
    let ddeStatus = '확인 불가';
    let ddeDetail = '설정에서 DDE 연결 테스트를 켜세요.';
    let ddeBusy = false;
    let probeArmed = false;

    async function probeDde() {
      if (ddeBusy) return;
      ddeBusy = true;
      ddeStatus = 'DDE 연결 중';
      ddeDetail = 'UDS 22 F1 50 읽기 요청';
      await render();

      try {
        const diag = await new Diag(ctx.signals, log).init();
        const req = [0xF1, 0x50];

        // 0x12 is a test address, not yet confirmed
        // for every B47/B57 DDE.
        const u = await diag.physical(
          0x12, 0x22, req, 4000,
          replyTo(0x22, req),
          {hardTimeoutMs:6500, maxRetries:0}
        );

        if (u && u[0] === 0x62 &&
            u[1] === 0xF1 && u[2] === 0x50) {
          const bytes = Array.from(u.slice(3));
          const ascii = bytes.map(b =>
            b >= 32 && b <= 126
              ? String.fromCharCode(b) : ''
          ).join('').trim();

          ddeStatus = 'DDE 응답 확인';
          ddeDetail = '식별값: ' +
            (ascii || bytes.map(b =>
              b.toString(16).padStart(2,'0')
            ).join(' ').toUpperCase()).slice(0, 36);

          log.info('DDE F150 response: ' +
            bytes.map(b =>
              b.toString(16).padStart(2,'0')
            ).join(' '));
        } else if (u && u[0] === 0x7F) {
          ddeStatus = 'DDE 요청 거부';
          ddeDetail = 'NRC: 0x' +
            Number(u[2] || 0).toString(16).toUpperCase();
        } else {
          ddeStatus = 'DDE 응답 없음';
          ddeDetail = 'ECU 주소 또는 통신 상태 확인 필요';
        }
      } catch (e) {
        ddeStatus = 'DDE 연결 오류';
        ddeDetail = String(e).slice(0, 45);
        log.warn('DPF DDE probe: ' + e);
      }

      ddeBusy = false;
      await render();
    }

    function txt(cv, s, x, y, size, color, opts) {
      cv.text(String(s), x, y, size, color,
        Object.assign({font:'bold'}, opts || {}));
    }

    function panel(cv, x, y, w, h) {
      cv.roundRect(x, y, w, h, 15, C.panel);
    }

    function metric(cv, x, y, w, label, value, unit, color) {
      panel(cv, x, y, w, 136);
      txt(cv, label, x + 23, y + 38, 22, C.muted);
      txt(cv, value, x + 23, y + 103, 53, color || C.white);
      txt(cv, unit, x + w - 22, y + 103, 21, C.blue,
        {align:'right'});
    }

    async function render() {
      const cv = ctx.canvas(W, H).clear(C.bg);
      const demo = settings.get('demo') === true;

      const d = demo ? {
        soot:'12.8', ash:'23.4', pressure:'18',
        temp:'325', distance:'286'
      } : {
        soot:'--', ash:'--', pressure:'--',
        temp:'--', distance:'--'
      };

      txt(cv, 'BimmerService', 29, 69, 43, C.white);
      txt(cv, 'BMW DPF MONITOR', 31, 94, 17, C.blue);
      txt(cv, 'bimmerservice.co.kr', 476, 90, 17, C.muted);

      cv.roundRect(1270, 28, 288, 56, 11, C.panel2);
      txt(cv, demo ? 'DEMO / 예시 데이터' : '실차 데이터 미연결',
        1414, 64, 20, demo ? C.amber : C.muted,
        {align:'center'});

      cv.fillRect(25, 110, 1530, 1, C.line);

      metric(cv, 25, 130, 370,
        '매연 포집량', d.soot, 'g', C.blue);

      metric(cv, 415, 130, 370,
        'DPF 차압', d.pressure, 'mbar', C.white);

      metric(cv, 805, 130, 370,
        '배기가스 온도', d.temp, '°C', C.amber);

      metric(cv, 1195, 130, 370,
        '재 포집량', d.ash, 'g', C.white);

      panel(cv, 25, 284, 755, 184);
      txt(cv, 'DPF 재생 상태', 50, 325, 25, C.white);
      txt(cv, ddeStatus, 50, 386, 36, C.muted);
      txt(cv, ddeDetail,
        50, 439, 19, C.muted);

      panel(cv, 800, 284, 765, 184);
      txt(cv, '최근 재생 이후 주행거리', 825, 325, 25, C.white);
      txt(cv, d.distance, 825, 403, 55, C.blue);
      txt(cv, 'km', 1100, 402, 24, C.muted);
      txt(cv, demo ? '예시 값' : '차량 연결 및 DID 검증 필요',
        825, 444, 18, C.muted);

      txt(cv, 'BimmerService DPF Monitor', 28, 505,
        17, C.muted);
      txt(cv, 'V0.1', 1555, 505, 17, C.mint,
        {align:'right'});

      await ui.image('MAIN_GFX', cv);
    }

    ctx.hideButton('BTN_PAGE');
    ctx.onLayout(() => { render(); });
    settings.onChange(() => {
      render();
      const on = settings.get('probeDde') === true;
      if (!on) probeArmed = false;
      if (on && !probeArmed) {
        probeArmed = true;
        probeDde().catch(e =>
          log.warn('DDE test: ' + e));
      }
    });

    const redraw = () => {
      render();
      setTimeout(() => render(), 600);
    };

    ui.onVisible((name, on) => {
      if (name === 'MAIN' && on) redraw();
    });

    if (ui.onFocus) ui.onFocus((name, on) => {
      if (name === 'MAIN' && on) redraw();
    });

    render().catch(e => log.warn('DPF render: ' + e));
    log.info('BimmerService DPF V0.1 started');
  }
});
