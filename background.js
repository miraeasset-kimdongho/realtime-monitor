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
    pushEnabled: true
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

    // Chrome 알림
    try {
      chrome.notifications.create('priceChange-' + Date.now(), {
        type: 'basic',
        iconUrl: 'icon.png',
        title: `💰 가격 변동 ${changes.length}건 감지!`,
        message: changes.slice(0, 3).map(c => `${c.club} ${c.date.substring(5)} ${c.time} ${c.oldPrice}→${c.newPrice}`).join('\n'),
        priority: 2
      });
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
    for (const [date, items] of Object.entries(byDate)) {
      const oldItems = oldData[clubId]?.[date] || [];
      // 시간+코스를 키로
      const oldMap = {};
      oldItems.forEach(o => oldMap[`${o.course}|${o.time}`] = o.price);
      items.forEach(n => {
        const k = `${n.course}|${n.time}`;
        const oldPrice = oldMap[k];
        if (oldPrice && oldPrice !== n.price) {
          changes.push({
            club, date, course: n.course, time: n.time,
            oldPrice, newPrice: n.price,
            direction: parsePrice(n.price) < parsePrice(oldPrice) ? 'down' : 'up'
          });
        }
      });
    }
  }
  return changes;
}

function parsePrice(s) {
  const m = String(s).match(/([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, '')) : 0;
}

// ===================== #2: GitHub Contents API 로 로그 커밋 =====================
// 변동 감지 시점에 logs/YYYY-MM-DD.jsonl 파일에 append 하여 커밋한다.
function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
}

// UTF-8 안전 base64 (한글 깨짐 방지)
function utf8ToB64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
}

async function pushChangesToGitHub(changes, cfg, triggerType) {
  const gh = cfg.github || {};
  if (!gh.pushEnabled) { await logEvent('INFO', 'gh_push_disabled', null); return; }
  if (!gh.token || !gh.repo) {
    await logEvent('WARN', 'gh_push_skip', { reason: '토큰 또는 저장소 미설정. 팝업 설정에서 입력하세요.', tokenSet: !!gh.token, repo: gh.repo });
    return;
  }

  const dateStr = new Date().toISOString().substring(0, 10);
  const path = `logs/${dateStr}.jsonl`;
  const branch = gh.branch || 'main';
  const apiUrl = `https://api.github.com/repos/${gh.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;

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
      await logEvent('INFO', 'gh_new_logfile', { path });
    } else if (r.status === 401 || r.status === 403) {
      await logEvent('ERROR', 'gh_auth_fail', { status: r.status, hint: '토큰 권한(Contents read/write) 또는 만료 확인' });
      return;
    } else {
      await logEvent('ERROR', 'gh_get_fail', { status: r.status });
      return;
    }
  } catch (e) {
    await logEvent('ERROR', 'gh_get_exc', e?.message);
    return;
  }

  // 2) 변동분 append
  const now = Date.now();
  const lines = changes.map(c => JSON.stringify({
    ts: now, trigger: triggerType,
    club: c.club, date: c.date, course: c.course, time: c.time,
    oldPrice: c.oldPrice, newPrice: c.newPrice, direction: c.direction
  })).join('\n') + '\n';
  const newContent = prevContent + lines;

  const body = {
    message: `log: ${dateStr} ${changes.length}건 변동 (${triggerType}) @ ${new Date(now).toISOString()}`,
    content: utf8ToB64(newContent),
    branch
  };
  if (sha) body.sha = sha;

  // 3) PUT 커밋
  try {
    const r = await fetch(apiUrl, { method: 'PUT', headers: ghHeaders(gh.token), body: JSON.stringify(body) });
    if (r.ok) {
      const j = await r.json();
      await logEvent('INFO', 'gh_push_ok', { path, count: changes.length, commit: j.commit?.sha?.substring(0, 7) });
    } else {
      const text = await r.text().catch(() => '');
      // 409 = sha 충돌(동시 커밋). 한 번 재시도.
      if (r.status === 409) {
        await logEvent('WARN', 'gh_conflict_retry', { path });
        return pushChangesToGitHub(changes, cfg, triggerType);
      }
      await logEvent('ERROR', 'gh_push_fail', { status: r.status, body: text.slice(0, 300) });
    }
  } catch (e) {
    await logEvent('ERROR', 'gh_push_exc', e?.message);
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
