'use strict';
/**
 * BimmerService Diagnostics - reads the fault memory of every control unit over the head
 * unit's diagnostic transport (TASU, see diag.js), without DTC clearing.
 *
 *   Scan  : UDS 19 02 <mask> to all ECUs (0xDF), like BMW's own teleservice
 *           job READ_PRIMARY_DTCS; optional info memory 19 17 <mask> 01.
 *   Check Control: the active messages from CheckControlMaster, named via the
 *           cluster's KombiInterface_2 lists.
 *
 * Pages: faults (6 per page) -> Check Control -> control units that answered. Where the kit runs the
 * screen, all the faults are on one page and each list scrolls (a finger, or the controller turned on it).
 * Fault codes are BMW hex codes (as BMW's diagnostic tools show them); the head unit has no
 * text database for them, so look them up by code + control unit.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { fitText } = require('./kit/text-layout');
const { diagnosticText } = require('./diagnostic-text');
const { t: translateUI, plural } = require('./kit/i18n');
const { Diag, parseDtcReply, statusInfo, hex, NRC } = require('./kit/diag');
const DEMO = require('./demo');

const W = 1600, H = 520, PER_PAGE = 6;
const GO = '#2fd27a';

// diagnostic addresses -> control unit (unknown ones show as "ECU 0x..")
const { ECU } = require('./kit/ecus');
// Fault texts, first match wins:
//  1. dtc_texts.js   this car's own coding tool export (kit/tools/dtc_texts.py; not in git)
//  2. known_texts.js a few hand-written ones (in git)
//  3. dtc_db/        a fault text database imported with kit/tools/dtc_texts.py --db (not in git: it is
//                    BMW's). Each unit's SGBD index (UDS 22 F1 50, what BMW's diagnostic tools identify it by)
//                    picks its texts: sgbd_index.json "<address> <index>" -> texts/<SGBD>.json;
//                    dtc_texts.json there holds "<address>:<code>" ones; unit_names.json names the unit.
//  4. dtc_db/code_texts.json  a fault code list (kit/tools/dtc_texts.py --codes) for faults with no
//                    text above: "<code>": text (any unit) or { "<address>": text } (those units only).
//  5. dtc_db/tables/ fault text tables (kit/tools/dtc_tables.py; BMW's, not in git), split so only the
//                    units that report faults are read: variant/<sgbd>.json the text for exactly that
//                    unit type, addr/<address>.json the text all types at that address agree on (both
//                    before 3.), codes.json code-only texts and ambiguous.json "<code>": how many
//                    different texts a code has (when nothing else knows it).
// The build packs dtc_db/ into one compressed file, dtc_db.pack (kit/runtime/pack.js): ~19 MB of
// texts take ~3.5 MB, and a lookup inflates only the few KB that hold its code.
const DB = require('./kit/pack').open(path.join(__dirname, 'dtc_db'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const req = (m) => { try { return require(m); } catch (e) { return {}; } };
const OWN = Object.assign({}, req('./known_texts'), req('./dtc_texts'));
const text = (key) => OWN[key] || DB.get('dtc_texts.json', key);
const SGBD = DB.json('sgbd_index.json');
const UNIT_NAMES = DB.json('unit_names.json');
const HAS_DB = Object.keys(SGBD).length > 0;
let ids = {};                     // "12" -> "0F26E8" (unit's SGBD index); '' = asked, gave none
const variant = (a) => {
    const v = ids[hex(a)] ? SGBD[hex(a) + ' ' + ids[hex(a)]] : null;
    return v && /^[A-Za-z0-9_]+$/.test(v) ? v : null;
};
// Normalize legacy German names, but preserve Unicode from translated/OEM text.
const ascii = (s) => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[\x00-\x1f\x7f]/g, '');
// a summary where the texts for a unit family differ in wording but agree on the fault
// (not an exact BMW text)
const FAMILY = {
    '23:D1C604': 'Assist sensors: Unexpected Ethernet communication/link',
    '61:03178A': 'Telematics: Mobile network connection limited',
};
function describe(addr, rawCode) {
    const code = String(rawCode).trim().toUpperCase().replace(/^0X/, '').padStart(6, '0');
    const key = hex(addr) + ':' + code;
    const own = text(key);
    if (own) return ascii(own);
    const v = variant(addr);
    // exactly this unit type's text, else the one all unit types at this address agree on
    const iv = (v && DB.get('tables/variant/' + v.toLowerCase() + '.json', code)) || DB.get('tables/addr/' + hex(addr) + '.json', code);
    if (iv) return ascii(iv);
    const t = (v && DB.get('texts/' + v + '.json', code)) || text('*:' + code);   // "*:<code>": any unit
    if (t) return ascii(t);
    const c = DB.get('code_texts.json', code);
    const ct = (typeof c === 'string' ? c : c && c[hex(addr)]) || DB.get('tables/codes.json', code) || FAMILY[key];
    if (ct) return ascii(ct);
    // several different texts and the unit type unknown: say so rather than guess
    const n = DB.get('tables/ambiguous.json', code);
    return n > 0 ? n + ' possible texts (depends on unit type)' : null;
}
// a unit the database identified is named by what it is (same on every model); else the address table
const ecuName = (a) => {
    const v = variant(a);
    return (v && UNIT_NAMES[v] && ascii(UNIT_NAMES[v])) || ECU[a] || v || ('ECU 0x' + hex(a));
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const diag = new Diag(ctx.signals, log);

        /* ---------- state ---------- */
        const FILE = path.join(ctx.dataDir, 'last_scan.json');
        let scan = null;              // { at, demo, ecus: [{ addr, dtcs: [{code,status,mem}], nrc }] }
        try { scan = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* none yet */ }
        const IDS = path.join(ctx.dataDir, 'ecu_ids.json');
        ids = readJson(IDS);
        let phase = 'idle', msg = '', replies = 0, busy = false, version = 0;
        const changed = () => { version++; loop && loop.kick(); };
        const useDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.available);

        /* ---------- Check Control ---------- */
        const cc = new Map();          // ccmId -> { ecu, reason }
        const ccNames = new Map();     // id -> { name, color }
        const walk = (o, fn) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach((x) => walk(x, fn)); return; }
            fn(o);
            Object.keys(o).forEach((k) => { if (o[k] && typeof o[k] === 'object') walk(o[k], fn); });
        };
        const names = (v) => walk(v, (o) => {
            const id = o.cCIdentifer !== undefined ? o.cCIdentifer : o.cCIdentifier;
            const nm = o.cCShortName || o.cCName;
            if (id !== undefined && nm) { ccNames.set(id, { name: String(nm), color: o.cCColor }); changed(); }
        });
        ctx.signals.watch('de.bmw.infotainment.checkcontrol.CheckControlMaster', '1', {
            basicList: (v) => walk(v, (o) => {
                if (o.ccmId === undefined) return;
                const on = o.activeState === 'AKTIV' || o.activeState === 0;
                if (on) cc.set(o.ccmId, { ecu: o.requestorDiagAddr, reason: String(o.reason) }); else cc.delete(o.ccmId);
                changed();
            }),
        }, log);
        ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', { ccList: names, newCCMessage: names }, log);

        /* ---------- scan / clear ---------- */
        async function doScan() {
            if (busy) return;
            busy = true; phase = 'scanning'; replies = 0; msg = ''; changed();
            ui.text('BTN_SCAN', 'Scanning...');
            try {
                if (useDemo()) {
                    for (let i = 1; i <= DEMO.ecus.length; i++) { await new Promise((r) => setTimeout(r, 180)); replies = i; changed(); }
                    scan = { at: Date.now(), demo: true, ecus: JSON.parse(JSON.stringify(DEMO.ecus)) };
                } else {
                    const mask = settings.get('scope') === 'all' ? 0xFF : 0x0C;
                    const byEcu = new Map();
                    const read = async (params, mem) => {
                        const res = await diag.functional(0x19, params, { onReply: (e, n) => { replies = Math.max(replies, n); changed(); } });
                        res.forEach((uds, addr) => {
                            const p = parseDtcReply(uds, params);
                            const e = byEcu.get(addr) || { addr, dtcs: [], nrc: null };
                            p.dtcs.forEach((d) => e.dtcs.push({ code: d.code, status: d.status, mem }));
                            if (!p.ok && mem === 'fault') e.nrc = p.nrc;
                            byEcu.set(addr, e);
                        });
                    };
                    await read([0x02, mask], 'fault');
                    // the info memory is extra: if it can't be read, keep the fault memory scan
                    let infoFailed = false;
                    if (settings.get('info')) {
                        msg = 'Reading info memory...'; changed();
                        try { await read([0x17, mask, 0x01], 'info'); } catch (e) { infoFailed = true; log.warn('info memory: ' + e); }
                    }
                    scan = { at: Date.now(), demo: false, ecus: Array.from(byEcu.values()), infoFailed };
                    try { fs.writeFileSync(FILE, JSON.stringify(scan)); } catch (e) { log.warn('save scan: ' + e); }
                    await identify(scan.ecus.map((e) => e.addr));
                }
                scan.ecus.sort((a, b) => b.dtcs.length - a.dtcs.length || a.addr - b.addr);
                const n = scan.ecus.reduce((s, e) => s + e.dtcs.length, 0);
                log.info('scan: ' + scan.ecus.length + ' control units, ' + n + ' faults');
                msg = !scan.ecus.length ? 'No control unit answered - ignition on?' : scan.infoFailed ? 'Info memory not read this time (unit busy) - scan again for it' : '';
                phase = 'done';
            } catch (e) {
                log.warn('scan failed: ' + e);
                phase = 'error'; msg = 'Scan failed: ' + e.message;
            }
            busy = false; page = 0;
            ui.text('BTN_SCAN', 'Scan again');
            changed();
        }

        /**
         * Ask every unit that answered the scan for its SGBD index once (22 F1 50), so the database can
         * give its faults a text and the unit its name; kept in data/ecu_ids.json (also the list of this
         * car's unit types). Read-only; a unit that refuses is not asked again, one that stays silent is.
         */
        async function identify(addrs) {
            const todo = HAS_DB ? addrs.filter((a) => ids[hex(a)] === undefined) : [];
            if (!todo.length) return;
            let i = 0;
            for (const a of todo) {
                msg = 'Identifying control units... ' + (++i) + '/' + todo.length; changed();
                try {
                    const r = await diag.physical(a, 0x22, [0xF1, 0x50], 3000,
                        (u) => (u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50) || (u[0] === 0x7F && u[1] === 0x22));
                    if (!r) { log.info('unit ' + hex(a) + ': no answer to 22 F1 50 (asked again next scan)'); continue; }
                    ids[hex(a)] = r[0] === 0x62 && r.length >= 6 ? hex(((r[3] << 16) | (r[4] << 8) | r[5]) >>> 0, 6) : '';
                    log.info('unit ' + hex(a) + ': SGBD index ' + (ids[hex(a)] || 'none') + (variant(a) ? ' -> ' + variant(a) : ''));
                } catch (e) { log.warn('identify ' + hex(a) + ': ' + e); }
            }
            try { fs.writeFileSync(IDS, JSON.stringify(ids)); } catch (e) { log.warn('save ids: ' + e); }
            msg = '';
        }

        /* ---------- drawing ---------- */
        let page = 0;
        let perPage = PER_PAGE;          // faults on a page: one more where the screen has room below the page (render)
        let scrolls = false;             // where the kit runs the screen: one Faults page, each list scrolled (render)
        let gliding = false;             // a list still gliding to where it was scrolled: draw the next frame too
        const scroll = { faults: { y: 0, max: 0 }, cc: { y: 0, max: 0 }, ecus: { y: 0, max: 0 } };
        let only = null;                 // a control unit tapped on the Control units page: the Faults page lists its faults alone
        const faults = () => (scan ? [].concat(...scan.ecus.map((e) => e.dtcs.map((d) => Object.assign({ addr: e.addr }, d)))) : []);
        const listed = () => (only === null ? faults() : faults().filter((d) => d.addr === only));
        const pageCount = () => (scrolls ? 1 : Math.max(1, Math.ceil(listed().length / perPage))) + 2;
        const shownList = () => { const fp = pageCount() - 2; return page < fp ? scroll.faults : page === fp ? scroll.cc : scroll.ecus; };
        // a finger dragged on the page or the controller turned on it (cv.scroll): the list shown moves
        ctx.onScroll((dy) => {
            const s = shownList(), y = G.clamp(s.y + dy, 0, s.max), moved = y !== s.y;
            s.y = y;
            if (moved) changed();
            return moved;
        });
        const showOnly = (addr) => { only = addr; page = 0; scroll.faults.y = 0; changed(); };
        const when = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
        const ccList = () => (scan && scan.demo ? DEMO.cc : Array.from(cc.entries()).map(([id, m]) => Object.assign({ id }, m, ccNames.get(id) || {})));

        /** txt cut with "..." to at most max px wide */
        function fit(cv, txt, size, max, opt) {
            return fitText(cv, txt, size, max, opt);
        }

        /* BimmerService Diagnostics V0.4 KR — custom 1600x520 layout.
           Only presentation logic is replaced; original scan and data parsing are preserved. */
        const BS = {
            bg: '#08111D', surface: '#101F32', surface2: '#172B42',
            blue: '#65C4FC', mint: '#5CDFBD', amber: '#F4BB6A', red: '#FF8388',
            white: '#F4F8FC', dim: '#9AB3CA', line: '#29415A'
        };
        const ink = (cv, txt, x, y, size, color, options) =>
            cv.text(String(txt), x, y, size, color || BS.white, options || {});
        const box = (cv, x, y, w, h, color, radius) =>
            cv.roundRect(x, y, w, h, radius || 12, color);
        const metric = (cv, x, y, title, value, color) => {
            box(cv, x, y, 167, 91, BS.surface2, 11);
            ink(cv, title, x + 15, y + 25, 17, BS.dim, { font: 'label' });
            ink(cv, value, x + 15, y + 70, 42, color, { font: 'num' });
        };
        function drawShell(cv) {
            cv.clear(BS.bg);
            cv.fillRect(0, 0, W, 5, BS.blue);
            ink(cv, 'BimmerService', 28, 67, 43, BS.white, { font: 'bold' });
            ink(cv, 'BMW 전문 진단 시스템', 31, 92, 16, BS.blue, { font: 'label' });
            ink(cv, 'bimmerservice.co.kr', 480, 91, 18, BS.dim);
            const fp = pageCount() - 2;
            const selected = page < fp ? 0 : page === fp ? 1 : 2;
            [
                {name:'고장코드 조회', x:884, w:212},
                {name:'체크컨트롤', x:1106, w:219},
                {name:'ECU 목록', x:1335, w:231}
            ].forEach((b,i) => {
                box(cv, b.x, 22, b.w, 62, selected === i ? BS.surface2 : BS.surface, 10);
                if (selected === i) cv.fillRect(b.x+13, 77, b.w-26, 4, BS.blue);
                ink(cv, b.name, b.x+b.w/2, 61, 18, selected === i ? BS.white : BS.dim,
                    {font:'bold', align:'center'});
                if (cv.own) cv.target(b.x, 22, b.w, 62, () => {
                    if (i === 0) page = 0;
                    else page = pageCount()-2 + (i-1);
                    changed();
                }, 'bs-tab-'+i, 10);
            });
            cv.fillRect(23, 97, 1553, 1, BS.line);
        }
        function drawSummary(cv) {
            const f = faults();
            const active = f.filter(d => d.mem === 'fault' && (d.status & 1)).length;
            const stored = f.filter(d => d.mem === 'fault').length;
            const count = scan ? scan.ecus.length : null;
            const controls = ccList().length;
            box(cv, 23, 112, 386, 389, BS.surface, 14);
            ink(cv, '차량 진단 현황', 43, 146, 23, BS.white, {font:'bold'});
            ink(cv, scan && scan.demo ? '' : phase === 'scanning' ? '진단 중' : scan ? '최근 진단' : '미진단',
                385, 145, 16, phase === 'error' ? BS.red : BS.blue, {font:'label', align:'right'});
            cv.fillRect(43, 159, 345, 1, BS.line);
            ink(cv, 'ECU', 43, 190, 17, BS.dim, {font:'label'});
            ink(cv, phase === 'scanning' ? String(replies) : count === null ? '--' : String(count),
                45, 262, 78, BS.white, {font:'num'});
            ink(cv, '확인된 ECU', 215, 258, 19, BS.blue, {font:'bold'});
            metric(cv, 42, 280, '저장된 고장코드', scan ? String(stored) : '--', stored ? BS.amber : BS.mint);
            metric(cv, 220, 280, '활성화 된 에러', scan ? String(active) : '--', active ? BS.red : BS.mint);
            ink(cv, '체크컨트롤', 43, 406, 19, BS.dim, {font:'label'});
            ink(cv, String(controls), 378, 408, 27, controls ? BS.amber : BS.mint, {font:'bold',align:'right'});
            const btnBusy = phase === 'scanning';
            const b = {label:btnBusy ? '진단 중...' : scan ? '다시 진단' : '진단 시작',
                run:() => doScan(), key:'bs-scan', busy:btnBusy};
            G.button(cv, { ...ctx.theme(), accent: BS.blue }, 44, 429, 0, 46, b.label, b.run, b);
            ink(cv, 'V0.4', 384, 485, 15, BS.mint, {align:'right'});
        }
        function rightPanel(cv, title) {
            box(cv, 424, 112, 1152, 389, BS.surface, 14);
            ink(cv, title, 449, 151, 27, BS.white, {font:'bold'});
            cv.fillRect(449, 164, 1100, 1, BS.line);
            return {x:449, y:175, w:1100, h:305};
        }
        function scrolled(cv, s, key, panel, rowHeight, rowCount, draw) {
            const max = Math.max(0, rowCount * rowHeight - panel.h);
            s.max = scrolls ? max : 0;
            s.y = G.clamp(s.y, 0, s.max);
            const sy = scrolls ? G.smooth('bsScroll:'+key, s.y, 22) : 0;
            if (sy !== s.y) gliding = true;
            cv.clip(panel.x, panel.y, panel.w, panel.h);
            draw(sy, panel.y, panel.y + panel.h);
            cv.noclip();
            if (scrolls && max > 0) {
                const barH = Math.max(42, panel.h * panel.h/(panel.h+max));
                const bar = {x:panel.x + panel.w - 9, y:panel.y+(panel.h-barH)*sy/max,w:5,h:barH};
                box(cv,bar.x,bar.y,bar.w,bar.h,BS.blue,3);
                cv.scroll = {y:panel.y,bar};
            }
        }
        function drawFaults(cv) {
            const f = listed();
            const pages = scrolls ? 1 : Math.max(1,Math.ceil(f.length/perPage));
            const title = only === null ? '고장코드 조회' : 'FAULTS / '+ecuName(only);
            const p = rightPanel(cv,title);
            if (scan && phase !== 'scanning') ink(cv, '최근 진단 '+when(scan.at), 1540, 147, 17, BS.dim, {align:'right'});
            if (phase === 'scanning') {
                ink(cv,'제어기 진단 중...', 470, 224, 25, BS.blue,{font:'bold'});
                ink(cv,'응답한 제어기: '+replies, 470, 266, 22, BS.dim);
                return;
            }
            if (phase === 'error') {
                ink(cv,fit(cv,msg,22,1000),470,231,22,BS.red);
                return;
            }
            if (!scan) {
                ink(cv,'진단 준비 완료', 470, 265, 36, BS.white,{font:'bold'});
                ink(cv,'차량 전원을 켠 후 진단 시작을 선택하세요.',470,314,25,BS.dim);
                ink(cv,'아직 진단 결과가 없습니다.',470,353,21,BS.dim);
                return;
            }
            if (!f.length) {
                ink(cv,scan.ecus.length ? '응답한 제어기에 고장코드 없음' : '제어기 응답 없음',470,264,32,
                    scan.ecus.length ? BS.mint : BS.amber,{font:'bold'});
                ink(cv,scan.ecus.length ? '응답한 제어기만 결과에 포함됩니다.' : '차량 전원과 진단 연결을 확인하세요.',
                    470,310,22,BS.dim);
                return;
            }
            const rows = scrolls ? f : f.slice(page*perPage,page*perPage+perPage);
            const p2 = { ...p, y:179, h:295 };
            scrolled(cv,scroll.faults,'faults',p2,60,rows.length,(sy,from,to) => rows.forEach((d,i) => {
                const y = 180 + i*60 - sy;
                if (y+55 < from || y > to) return;
                box(cv,449,y,1091,54,BS.surface2,8);
                const status = statusInfo(d.status);
                const color = status.sev === 'crit' ? BS.red : status.sev === 'warn' ? BS.amber : BS.blue;
                cv.fillRect(449,y+5,4,44,color);
                ink(cv,d.code,469,y+35,28,BS.white,{font:'bold'});
                ink(cv,fit(cv,ecuName(d.addr),21,215),654,y+33,21,BS.blue);
                const desc = describe(d.addr,d.code);
                const phrase = desc ? diagnosticText(desc) : (d.mem === 'info' ? '정보 메모리' : '고장 설명 없음');
                ink(cv,fit(cv,phrase,20,510,{literal:true}),888,y+33,20,BS.dim,{literal:true});
                ink(cv,fit(cv,({'Test failed':'현재 고장','Confirmed':'확정 고장','Pending':'대기 고장','History':'이력 고장'}[status.label] || status.label),18,125),1527,y+32,18,color,{align:'right'});
            }));
            if (pages > 1) ink(cv, String(page+1)+' / '+String(pages),1532,490,16,BS.dim,{align:'right'});
            if (only !== null && cv.own) {
                ink(cv,'전체 제어기',1415,147,17,BS.blue,{font:'bold'});
                cv.target(1400,118,150,45,()=>showOnly(null),'bs-all',4);
            }
        }
        function drawCC(cv) {
            const p=rightPanel(cv,'체크컨트롤');
            const l=ccList();
            if (!l.length) {
                ink(cv,'현재 체크컨트롤 메시지 없음',475,274,32,BS.mint,{font:'bold'});
                ink(cv,'활성화된 체크컨트롤 메시지가 없습니다.',475,315,22,BS.dim);
                return;
            }
            const rows=scrolls?l:l.slice(0,perPage);
            scrolled(cv,scroll.cc,'cc',{...p,y:179,h:295},60,rows.length,(sy,from,to)=>rows.forEach((m,i)=>{
                const y=180+i*60-sy;
                if (y+55 < from || y > to) return;
                box(cv,449,y,1091,54,BS.surface2,8);
                const color=m.color==='RED'?BS.red:(m.color==='YELLOW'||m.color==='ORANGE')?BS.amber:BS.blue;
                cv.fillRect(449,y+5,4,44,color);
                const title=m.name?diagnosticText(m.name):translateUI('Message ')+m.id;
                ink(cv,fit(cv,title,23,820,{literal:true}),473,y+34,23,BS.white,{literal:true});
                if(m.ecu!==undefined) ink(cv,fit(cv,ecuName(m.ecu),19,240),1525,y+33,19,BS.dim,{align:'right'});
            }));
        }
        function drawEcus(cv) {
            const p=rightPanel(cv,'제어기 응답 목록');
            const l=scan?scan.ecus.slice().sort((a,b)=>a.addr-b.addr):[];
            if(!l.length) {
                ink(cv,scan?'응답한 제어기 없음':'먼저 진단을 시작하세요',475,274,32,BS.amber,{font:'bold'});
                return;
            }
            const rows=scrolls?l:l.slice(0,perPage);
            scrolled(cv,scroll.ecus,'ecus',{...p,y:179,h:295},60,rows.length,(sy,from,to)=>rows.forEach((e,i)=>{
                const y=180+i*60-sy;
                if(y+55<from||y>to)return;
                const n=e.dtcs.length,active=e.dtcs.some(d=>d.status&1);
                const color=e.nrc?BS.amber:active?BS.red:n?BS.amber:BS.mint;
                box(cv,449,y,1091,54,BS.surface2,8);
                cv.fillRect(449,y+5,4,44,color);
                ink(cv,fit(cv,ecuName(e.addr),23,660,{font:'bold'}),474,y+34,23,BS.white,{font:'bold'});
                ink(cv,e.nrc?'NRC '+hex(e.nrc):n?String(n)+' DTC':'고장코드 없음',1525,y+33,21,color,{align:'right',font:'bold'});
                if(cv.own) cv.target(449,y,1091,54,()=>showOnly(e.addr),'bs-ecu-'+e.addr,6);
            }));
        }
        let drawn = -1;
        async function render(force) {
            if (!force && drawn === version && !gliding && phase !== 'scanning' && phase !== 'clearing') return;
            drawn = version;
            gliding = false;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(BS.bg);
            const fp0 = pageCount() - 2;
            scrolls = !!cv.own;
            perPage = 4 + Math.floor(Math.max(0, G.pageBottom(cv) - G.BOTTOM) / 60);     // rows of 47 px (drawCC; drawFaults' are 46)
            const fp = pageCount() - 2;
            // fewer or more fault pages now (the room below the page came or went): Check Control and Control
            // units stay the pages shown
            if (fp !== fp0) page = page >= fp0 ? fp + page - fp0 : Math.min(page, fp - 1);
            page = Math.min(page, pageCount() - 1);
            drawShell(cv);
            drawSummary(cv);
            if (page < fp) drawFaults(cv); else if (page === fp) drawCC(cv); else drawEcus(cv);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_SCAN', () => { doScan(); });
        // on the Faults page where the kit runs the screen
        ctx.hideButton('BTN_SCAN');
        ctx.onLayout(changed);           // (it draws only on changes: a new layout is one)
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % pageCount(); changed(); });
        // tabs: Faults (opened again: its next page of faults), Check Control, Control units
        ctx.onTab((i) => {
            const fp = pageCount() - 2;
            if (i === 0 && page < fp) page = (page + 1) % fp;
            else page = i === 0 ? 0 : fp + i - 1;
            changed();
        });

        var loop = ctx.loop('MAIN', 2, () => render(false));
        let scannedOnOpen = false;
        const maybeAuto = () => {
            if (scannedOnOpen || !settings.get('autoScan')) return;
            scannedOnOpen = true;
            setTimeout(doScan, 1500);       // give TASU's availability a moment
        };
        // back from Settings or an HMI popup: draw again at once, and once more when the renderer's surface
        // is up - this app only draws when something changed, so the screen would otherwise stay empty
        // until the next change (e.g. Next page)
        const redraw = () => { changed(); setTimeout(changed, 600); };
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) { maybeAuto(); redraw(); } });
        if (ui.onFocus) ui.onFocus((name, on) => { if (name === 'MAIN' && on) redraw(); });
        if (ui.isVisible('MAIN')) maybeAuto();
        settings.onChange(() => changed());
        if (scan) ui.text('BTN_SCAN', 'Scan again');
        render(true).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));

        // Initialize diagnostic transport without blocking the first screen.
        diag.init().then(() => {
            log.info('TASU initialization finished');
            changed();
        }).catch((e) => {
            log.warn('TASU initialization failed: ' + e);
            changed();
        });
    },
});
