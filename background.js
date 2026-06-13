// 실시간 가격 모니터 - 백그라운드 서비스 워커
const COURSES = [
  {id: '400', name: '양지파인'},
  {id: '1187', name: '한림용인'},
  {id: '353', name: '포웰안성'},
  {id: '9', name: '파인스톤'}
];

const REGION = '11112'; // 경기남부

// 설정 기본값
const DEFAULTS = {
  intervalMin: 10,
  daysAhead: 3,   // 오늘 + 3일 (총 4일)
  enabled: true,
  // GitHub 로그 푸시 설정 (토큰은 사용자가 팝업에서 직접 입력)
  github: {
    repo: 'miraeasset-kimdongho/realtime-monitor', // owner/name
    branch: 'main',
    token: '',         // fine-grained PAT (Contents: read/write). 절대 코드/저장소에 커밋하지 말 것
    pushEnabled: true,        // 변동 로그(logs/changes/) 커밋
    systemLogPush: true,      // 시스템 진단 로그(logs/system/) 커밋
    sysPushIntervalMin: 60    // 시스템 로그 최소 푸시 간격(분). 변동/오류 발생 시엔 이와 무관하게 즉시 푸시
  }
};

// ===================== 로깅 계층 =====================
// 모든 로그는 (1) 콘솔 출력 + (2) chrome.storage.local 링버퍼에 적재된다.
// 변동 감지/오류 시점에 진단할 수 있도록 구조적으로 남긴다.
const LOG_KEY = 'logs';
const LOG_MAX = 500;

async function logEvent(level, event, detail) {
  const entry = { ts: Date.now(), level, event, detail: detail ?? null };
  const line = `[${new Date(entry.ts).toISOString()}] ${level} ${event}` +
    (detail !== undefined ? ' ' + safeStringify(detail) : '');
  try {
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
  } catch (_) { /* 콘솔 실패는 무시 */ }

  try {
    const d = await chrome.storage.local.get(LOG_KEY);
    const arr = d[LOG_KEY] || [];
    arr.push(entry);
    if (arr.length > LOG_MAX) arr.splice(0, arr.length - LOG_MAX);
    await chrome.storage.local.set({ [LOG_KEY]: arr });
  } catch (e) {
    // 저장 실패까지 콘솔로만 남김 (재귀 방지 위해 logEvent 호출 안 함)
    try { console.error('[logEvent] persist fail:', e?.message); } catch (_) {}
  }
  return entry;
}

function safeStringify(obj) {
  try { return typeof obj === 'string' ? obj : JSON.stringify(obj); }
  catch (_) { return String(obj); }
}

// 서비스 워커 전역 오류 포착 (오작동 조기 감지)
self.addEventListener('error', (e) => {
  logEvent('ERROR', 'sw_global_error', { msg: e?.message, file: e?.filename, line: e?.lineno });
});
self.addEventListener('unhandledrejection', (e) => {
  logEvent('ERROR', 'sw_unhandled_rejection', { reason: String(e?.reason?.message || e?.reason) });
});

// ===================== 라이프사이클 / 알람 =====================
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const cfg = await getConfig();
    await logEvent('INFO', 'onInstalled', { enabled: cfg.enabled, intervalMin: cfg.intervalMin });
    if (cfg.enabled) {
      chrome.alarms.create('priceCheck', { periodInMinutes: cfg.intervalMin });
    }
  } catch (e) {
    await logEvent('ERROR', 'onInstalled_fail', e?.message);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    const cfg = await getConfig();
    await logEvent('INFO', 'onStartup', { enabled: cfg.enabled, intervalMin: cfg.intervalMin });
    if (cfg.enabled) {
      chrome.alarms.create('priceCheck', { periodInMinutes: cfg.intervalMin });
    }
  } catch (e) {
    await logEvent('ERROR', 'onStartup_fail', e?.message);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'priceCheck') {
    try {
      await runCheck('자동');
    } catch (e) {
      await logEvent('ERROR', 'alarm_runCheck_fail', e?.message);
    }
  }
});

// ===================== 메시지 핸들러 =====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'manualCheck') {
    runCheck('수동')
      .then(result => sendResponse({ ok: true, result }))
      .catch(async (e) => {
        await logEvent('ERROR', 'manualCheck_fail', e?.message);
        sendResponse({ ok: false, error: e?.message });
      });
    return true; // async response
  }
  if (msg.type === 'getConfig') {
    getConfig().then(cfg => sendResponse(cfg)).catch(() => sendResponse(DEFAULTS));
    return true;
  }
  if (msg.type === 'setConfig') {
    setConfig(msg.config).then(() => sendResponse({ ok: true }))
      .catch(async (e) => { await logEvent('ERROR', 'setConfig_fail', e?.message); sendResponse({ ok: false }); });
    return true;
  }
  if (msg.type === 'getAlerts') {
    chrome.storage.local.get('alerts').then(d => sendResponse(d.alerts || [])).catch(() => sendResponse([]));
    return true;
  }
  if (msg.type === 'clearAlerts') {
    chrome.storage.local.set({ alerts: [] }).then(() => {
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'getLogs') {
    chrome.storage.local.get(LOG_KEY).then(d => sendResponse(d[LOG_KEY] || [])).catch(() => sendResponse([]));
    return true;
  }
  if (msg.type === 'clearLogs') {
    chrome.storage.local.set({ [LOG_KEY]: [] }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

async function getConfig() {
  const d = await chrome.storage.local.get('config');
  const cfg = Object.assign({}, DEFAULTS, d.config || {});
  // github 서브객체는 깊은 병합 (기존 사용자가 일부만 저장했을 수 있음)
  cfg.github = Object.assign({}, DEFAULTS.github, (d.config && d.config.github) || {});
  return cfg;
}

async function setConfig(c) {
  await chrome.storage.local.set({ config: c });
  await logEvent('INFO', 'config_updated', {
    enabled: c.enabled, intervalMin: c.intervalMin, daysAhead: c.daysAhead,
    github: { repo: c.github?.repo, branch: c.github?.branch, pushEnabled: c.github?.pushEnabled, tokenSet: !!c.github?.token }
  });
  // 알람 재설정
  await chrome.alarms.clear('priceCheck');
  if (c.enabled) {
    chrome.alarms.create('priceCheck', { periodInMinutes: c.intervalMin });
  }
}

// ===================== 핵심: 한번 체크 실행 =====================
async function runCheck(triggerType) {
  const t0 = Date.now();
  const cfg = await getConfig();
  const dates = [];
  const today = new Date();
  for (let i = 0; i <= cfg.daysAhead; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().substring(0, 10)); // YYYY-MM-DD
  }
  await logEvent('INFO', 'runCheck_start', { trigger: triggerType, dates, courses: COURSES.map(c => c.name) });

  // 새 데이터 수집
  const newData = {};  // {clubId: {date: [{course, time, price}]}}
  let fetchFailCount = 0;
  for (const co of COURSES) {
    newData[co.id] = {};
    for (const date of dates) {
      try {
        const items = await fetchTimeSlots(co.id, co.name, date);
        newData[co.id][date] = items;
        if (items.length === 0) {
          await logEvent('WARN', 'empty_slots', { club: co.name, date });
        }
      } catch (e) {
        fetchFailCount++;
        newData[co.id][date] = [];
        await logEvent('ERROR', 'fetch_fail', { club: co.name, date, error: e?.message });
      }
    }
  }

  const totalSlots = countSlots(newData);
  // 전부 0건이면 로그인 만료 / 사이트 구조 변경 가능성 → 강한 경고
  if (totalSlots === 0) {
    await logEvent('ERROR', 'all_empty', {
      hint: '로그인 만료 또는 사이트 구조 변경 가능성. ownergolf 로그인 상태를 확인하세요.',
      fetchFailCount
    });
  }

  // 이전 데이터와 비교
  const oldData = (await chrome.storage.local.get('lastSnapshot')).lastSnapshot || {};
  const hadOldData = Object.keys(oldData).length > 0;
  const changes = detectChanges(oldData, newData);
  await logEvent('INFO', 'detect_done', { changes: changes.length, totalSlots, hadOldData });

  // 저장
  await chrome.storage.local.set({
    lastSnapshot: newData,
    lastCheckTime: Date.now(),
    lastCheckType: triggerType
  });

  // 변동 처리
  if (changes.length > 0) {
    const alerts = (await chrome.storage.local.get('alerts')).alerts || [];
    const newAlerts = changes.map(c => ({ ...c, ts: Date.now() }));
    const updated = [...newAlerts, ...alerts].slice(0, 100);
    await chrome.storage.local.set({ alerts: updated });

    // Chrome 알림 (변동 감지 시점)
    try {
      const newCnt = changes.filter(c => c.kind === 'new').length;
      const priceCnt = changes.length - newCnt;
      const titleParts = [];
      if (priceCnt) titleParts.push(`가격변동 ${priceCnt}`);
      if (newCnt) titleParts.push(`신규 ${newCnt}`);
      chrome.notifications.create('priceChange-' + Date.now(), {
        type: 'basic',
        iconUrl: 'icon.png',
        title: `💰 ${titleParts.join(' · ')} 감지!`,
        message: changes.slice(0, 5).map(fmtChangeLine).join('\n'),
        priority: 2,
        requireInteraction: true // 사용자가 닫을 때까지 유지 (놓치지 않도록)
      });
      await logEvent('INFO', 'notify_sent', { total: changes.length, priceCnt, newCnt });
    } catch (e) {
      await logEvent('WARN', 'notification_fail', e?.message);
    }

    // 뱃지
    try {
      chrome.action.setBadgeText({ text: String(updated.length) });
      chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
    } catch (e) {
      await logEvent('WARN', 'badge_fail', e?.message);
    }

    // === #2: 변동 감지 시점에 GitHub /logs 로 커밋 ===
    await pushChangesToGitHub(changes, cfg, triggerType);
  }

  const elapsed = Date.now() - t0;
  await logEvent('INFO', 'runCheck_done', { trigger: triggerType, changes: changes.length, totalSlots, elapsedMs: elapsed });
  // 시스템(진단) 로그 분리 푸시 (조건 충족 시)
  await maybePushSystemLogs(cfg, { changed: changes.length > 0 });
  return { changes: changes.length, totalSlots, trigger: triggerType };
}

function countSlots(data) {
  let n = 0;
  Object.values(data).forEach(byDate => Object.values(byDate).forEach(items => n += items.length));
  return n;
}

function detectChanges(oldData, newData) {
  const changes = [];
  for (const [clubId, byDate] of Object.entries(newData)) {
    const club = COURSES.find(c => c.id === clubId)?.name || clubId;
    const oldByDate = oldData[clubId] || {};
    for (const [date, items] of Object.entries(byDate)) {
      const oldItems = oldByDate[date] || [];
      // 이 (클럽,날짜)를 이전에 "수집"한 적 있는지 (빈 배열이어도 키가 있으면 true).
      // 0건이었다가 타임이 열린 경우(가장 가치 있는 알림)를 잡기 위함.
      const seenBefore = Object.prototype.hasOwnProperty.call(oldByDate, date);
      // 시간+코스를 키로
      const oldMap = {};
      oldItems.forEach(o => oldMap[`${o.course}|${o.time}`] = o.price);
      items.forEach(n => {
        const k = `${n.course}|${n.time}`;
        const oldPrice = oldMap[k];
        if (oldPrice === undefined) {
          // 신규 타임 — 단, 이전 스냅샷이 있을 때만 알림 (최초 실행 폭주 방지)
          if (seenBefore) {
            changes.push({
              kind: 'new', club, date, course: n.course, time: n.time,
              oldPrice: null, newPrice: n.price, direction: 'new'
            });
          }
        } else if (oldPrice !== n.price) {
          changes.push({
            kind: 'price', club, date, course: n.course, time: n.time,
            oldPrice, newPrice: n.price,
            direction: parsePrice(n.price) < parsePrice(oldPrice) ? 'down' : 'up'
          });
        }
      });
    }
  }
  return changes;
}

// 알림/로그 표시용 한 줄 포맷
function fmtChangeLine(c) {
  const d = c.date ? c.date.substring(5) : '';
  if (c.kind === 'new' || c.direction === 'new') {
    return `${c.club} ${d} ${c.time} 신규 ${c.newPrice}`;
  }
  return `${c.club} ${d} ${c.time} ${c.oldPrice}→${c.newPrice}`;
}

function parsePrice(s) {
  const m = String(s).match(/([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, '')) : 0;
}

// ===================== GitHub Contents API 로 로그 커밋 =====================
// 변동 로그(logs/changes/)와 시스템 진단 로그(logs/system/)를 폴더 분리해 append-커밋한다.
function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
}

// UTF-8 안전 base64 (한글 깨짐 방지)
function utf8ToB64(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64ToUtf8(b64) { return decodeURIComponent(escape(atob(b64.replace(/\n/g, '')))); }

function ghReady(gh) {
  return !!(gh && gh.pushEnabled && gh.token && gh.repo);
}

// 공통 헬퍼: 지정 경로 파일에 줄(jsonl)을 append 하여 1커밋. 성공 시 true.
async function appendLinesToGitHub(gh, path, linesText, commitMessage, _retry = 0) {
  const branch = gh.branch || 'main';
  const apiUrl = `https://api.github.com/repos/${gh.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

  // 1) 기존 파일 sha / 내용 조회 (append 위함)
  let sha = undefined;
  let prevContent = '';
  try {
    const r = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(gh.token) });
    if (r.status === 200) {
      const j = await r.json();
      sha = j.sha;
      if (j.content) prevContent = b64ToUtf8(j.content);
    } else if (r.status === 404) {
      // 신규 파일 — 정상
    } else if (r.status === 401 || r.status === 403) {
      await logEvent('ERROR', 'gh_auth_fail', { path, status: r.status, hint: '토큰 권한(Contents read/write) 또는 만료 확인' });
      return false;
    } else {
      await logEvent('ERROR', 'gh_get_fail', { path, status: r.status });
      return false;
    }
  } catch (e) {
    await logEvent('ERROR', 'gh_get_exc', { path, error: e?.message });
    return false;
  }

  // 2) append 후 PUT 커밋
  const body = { message: commitMessage, content: utf8ToB64(prevContent + linesText), branch };
  if (sha) body.sha = sha;
  try {
    const r = await fetch(apiUrl, { method: 'PUT', headers: ghHeaders(gh.token), body: JSON.stringify(body) });
    if (r.ok) {
      const j = await r.json();
      await logEvent('INFO', 'gh_push_ok', { path, commit: j.commit?.sha?.substring(0, 7) });
      return true;
    }
    const text = await r.text().catch(() => '');
    if (r.status === 409 && _retry < 2) {
      // sha 충돌(동시 커밋) → 재조회 후 재시도
      await logEvent('WARN', 'gh_conflict_retry', { path, retry: _retry + 1 });
      return appendLinesToGitHub(gh, path, linesText, commitMessage, _retry + 1);
    }
    await logEvent('ERROR', 'gh_push_fail', { path, status: r.status, body: text.slice(0, 300) });
    return false;
  } catch (e) {
    await logEvent('ERROR', 'gh_push_exc', { path, error: e?.message });
    return false;
  }
}

// (a) 변동(가격/신규) 로그 — 감지 즉시 logs/changes/ 에 커밋
async function pushChangesToGitHub(changes, cfg, triggerType) {
  const gh = cfg.github || {};
  if (!gh.pushEnabled) { await logEvent('INFO', 'gh_push_disabled', null); return; }
  if (!gh.token || !gh.repo) {
    await logEvent('WARN', 'gh_push_skip', { reason: '토큰 또는 저장소 미설정. 팝업 설정에서 입력하세요.', tokenSet: !!gh.token, repo: gh.repo });
    return;
  }
  const dateStr = new Date().toISOString().substring(0, 10);
  const now = Date.now();
  const linesText = changes.map(c => JSON.stringify({
    ts: now, trigger: triggerType, kind: c.kind || 'price',
    club: c.club, date: c.date, course: c.course, time: c.time,
    oldPrice: c.oldPrice, newPrice: c.newPrice, direction: c.direction
  })).join('\n') + '\n';
  await appendLinesToGitHub(gh, `logs/changes/${dateStr}.jsonl`,
    linesText, `changes: ${dateStr} ${changes.length}건 (${triggerType})`);
}

// (b) 시스템(진단) 로그 — 변동 로그와 분리해 logs/system/ 에 커밋
// 과도한 커밋 방지: '변동 발생' 또는 'WARN/ERROR 존재' 또는 '마지막 푸시 후 sysPushIntervalMin 경과' 중
// 하나라도 참일 때만, 아직 안 올린 항목을 모아 1커밋으로 올린다.
async function maybePushSystemLogs(cfg, opts) {
  const gh = cfg.github || {};
  if (!ghReady(gh) || gh.systemLogPush === false) return;

  const d = await chrome.storage.local.get([LOG_KEY, 'sysLogPushedTs', 'sysLogPushedAt']);
  const all = d[LOG_KEY] || [];
  const marker = d.sysLogPushedTs || 0;
  const unpushed = all.filter(l => l.ts > marker);
  if (unpushed.length === 0) return;

  const hasProblem = unpushed.some(l => l.level === 'WARN' || l.level === 'ERROR');
  const intervalMs = (gh.sysPushIntervalMin || 60) * 60000;
  const dueByTime = (Date.now() - (d.sysLogPushedAt || 0)) >= intervalMs;
  if (!(opts?.changed || hasProblem || dueByTime)) return;

  const dateStr = new Date().toISOString().substring(0, 10);
  const maxTs = unpushed[unpushed.length - 1].ts;
  const linesText = unpushed.map(l => JSON.stringify(l)).join('\n') + '\n';
  const ok = await appendLinesToGitHub(gh, `logs/system/${dateStr}.jsonl`,
    linesText, `system: ${dateStr} ${unpushed.length}건 (problem=${hasProblem})`);
  if (ok) {
    await chrome.storage.local.set({ sysLogPushedTs: maxTs, sysLogPushedAt: Date.now() });
  }
}

// ===================== 데이터 fetch: 백그라운드 탭으로 =====================
async function fetchTimeSlots(clubId, clubName, date) {
  // 1. booking.php 메뉴 페이지 열기
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: `https://www.ownergolf.com/web/booking.php?clubRegion=${REGION}`,
      active: false
    });
  } catch (e) {
    await logEvent('ERROR', 'tab_create_fail', { club: clubName, date, error: e?.message });
    throw e;
  }

  // 2. 페이지 로드 대기
  await waitForTabComplete(tab.id, 8000);

  try {
    // 3. 스크립트 주입: iframe form submit + scrape
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: scrapeFn,
      args: [clubId, date]
    });
    const result = injection && injection[0] ? injection[0].result : null;

    if (result && result.error) {
      await logEvent('WARN', 'scrape_issue', {
        club: clubName, date, error: result.error, loginHint: result.loginHint || false
      });
      return [];
    }
    return Array.isArray(result) ? result : [];
  } catch (e) {
    await logEvent('ERROR', 'inject_fail', { club: clubName, date, error: e?.message });
    return [];
  } finally {
    try { await chrome.tabs.remove(tab.id); }
    catch (e) { await logEvent('WARN', 'tab_remove_fail', { tabId: tab?.id, error: e?.message }); }
  }
}

// 페이지(MAIN world)에 주입되는 함수 — 여기서는 chrome.* / logEvent 사용 불가
function scrapeFn(clubId, date) {
  return new Promise((resolve) => {
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.name = 'monitorFrame_' + Date.now();
      document.body.appendChild(iframe);

      const f = document.createElement('form');
      f.method = 'POST';
      f.action = 'https://www.ownergolf.com/web/bookingTime.php';
      f.target = iframe.name;
      [['page','1'],['clubId', clubId],['clubRegion','11112'],['bookingDate', date]].forEach(([n,v]) => {
        const i = document.createElement('input');
        i.type = 'hidden'; i.name = n; i.value = v;
        f.appendChild(i);
      });
      document.body.appendChild(f);
      f.submit();

      setTimeout(() => {
        try {
          const doc = iframe.contentDocument;
          if (!doc) { resolve({ error: 'no contentDocument (cross-origin?)' }); return; }

          const bodyText = (doc.body && doc.body.innerText) ? doc.body.innerText : '';
          // 로그인 만료 추정: 가격표가 없는데 로그인 관련 문구가 보이면 힌트
          const loginHint = /로그인|login|아이디|비밀번호/i.test(bodyText);

          let rt = null;
          doc.querySelectorAll('table').forEach(t => {
            const h = Array.from(t.querySelectorAll('tr:first-child th, tr:first-child td')).map(c => c.innerText.trim());
            if (h.includes('1인그린피')) rt = t;
          });
          if (!rt) {
            // 가격표 못 찾음 — 구조 변경 또는 로그인 문제 진단 힌트 반환
            resolve({ error: '가격표(1인그린피) 미발견', loginHint });
            return;
          }
          const items = [];
          rt.querySelectorAll('tr').forEach((tr, i) => {
            if (i === 0) return;
            const tds = tr.querySelectorAll('td');
            if (tds.length < 7) return;
            items.push({
              course: tds[4]?.innerText.trim(),
              time: tds[5]?.innerText.trim(),
              price: tds[6]?.innerText.trim()
            });
          });
          // cleanup
          iframe.remove(); f.remove();
          resolve(items);
        } catch (e) {
          resolve({ error: 'scrape exception: ' + e.message });
        }
      }, 4500);
    } catch (e) {
      resolve({ error: 'setup exception: ' + e.message });
    }
  });
}

function waitForTabComplete(tabId, maxMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (!done) { done = true; resolve(); }
    };
    const timer = setTimeout(cleanup, maxMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        setTimeout(cleanup, 1500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
