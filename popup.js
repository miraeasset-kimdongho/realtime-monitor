// 팝업 로직
const statusEl = document.getElementById('status');
const alertsListEl = document.getElementById('alertsList');
const alertCountEl = document.getElementById('alertCount');
const checkBtn = document.getElementById('checkNow');
const enabledEl = document.getElementById('enabled');
const intervalEl = document.getElementById('intervalMin');
const daysEl = document.getElementById('daysAhead');
// GitHub 설정
const ghEnabledEl = document.getElementById('ghEnabled');
const ghSysLogEl = document.getElementById('ghSysLog');
const ghRepoEl = document.getElementById('ghRepo');
const ghBranchEl = document.getElementById('ghBranch');
const ghTokenEl = document.getElementById('ghToken');
// 로그
const logsViewEl = document.getElementById('logsView');

// 현재 설정 캐시 (저장 시 다른 섹션 값이 지워지지 않도록 전체를 유지)
let currentCfg = null;

function fmtTime(ts) {
  if (!ts) return '없음';
  const d = new Date(ts);
  return d.toLocaleString('ko-KR', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
}

function send(msg) {
  return new Promise(r => chrome.runtime.sendMessage(msg, r));
}

async function loadStatus() {
  const d = await chrome.storage.local.get(['lastCheckTime', 'lastCheckType', 'lastSnapshot']);
  let total = 0;
  if (d.lastSnapshot) {
    Object.values(d.lastSnapshot).forEach(byDate => {
      Object.values(byDate).forEach(items => total += items.length);
    });
  }
  statusEl.innerHTML = `
    <div>마지막 조회: <b>${fmtTime(d.lastCheckTime)}</b> (${d.lastCheckType || '없음'})</div>
    <div>수집 타임: <b>${total}건</b></div>
  `;
}

async function loadAlerts() {
  const alerts = await send({type:'getAlerts'});
  const todayStr = new Date().toISOString().substring(0, 10);
  const visible = alerts.filter(a => !a.date || a.date >= todayStr);
  alertCountEl.textContent = `(${visible.length})`;
  if (!visible.length) {
    alertsListEl.innerHTML = '<div class="empty">변동 없음</div>';
    return;
  }
  alertsListEl.innerHTML = visible.slice(0, 30).map(a => {
    const isNew = a.kind === 'new' || a.direction === 'new';
    const direction = a.direction === 'down' ? 'down' : '';
    const diffClass = a.direction === 'down' ? 'diff-down' : 'diff-up';
    const arrow = a.direction === 'down' ? '↓' : '↑';
    const priceHtml = isNew
      ? `<span class="diff-up">신규 ${a.newPrice} ✨</span>`
      : `${a.oldPrice} → <span class="${diffClass}">${a.newPrice} ${arrow}</span>`;
    return `<div class="alert-item ${direction}">
      <span class="ts">${fmtTime(a.ts)}</span>
      <b>${a.club}</b> ${a.date?.substring(5) || ''} ${a.course} ${a.time}<br>
      ${priceHtml}
    </div>`;
  }).join('');
}

async function loadConfig() {
  const cfg = await send({type:'getConfig'});
  currentCfg = cfg;
  enabledEl.checked = cfg.enabled;
  intervalEl.value = cfg.intervalMin;
  daysEl.value = cfg.daysAhead;
  const gh = cfg.github || {};
  ghEnabledEl.checked = gh.pushEnabled !== false;
  ghSysLogEl.checked = gh.systemLogPush !== false;
  ghRepoEl.value = gh.repo || '';
  ghBranchEl.value = gh.branch || 'main';
  // 토큰은 저장돼 있으면 마스킹 표시 (placeholder 유지). 빈 칸이면 미설정.
  ghTokenEl.value = gh.token ? '••••••••••••••••' : '';
  ghTokenEl.dataset.hasToken = gh.token ? '1' : '';
}

async function loadLogs() {
  const logs = await send({type:'getLogs'});
  if (!logs || !logs.length) {
    logsViewEl.innerHTML = '<div class="empty" style="color:#888">로그 없음</div>';
    return;
  }
  // 최신이 위로
  logsViewEl.innerHTML = logs.slice(-80).reverse().map(l => {
    const t = new Date(l.ts).toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    const detail = l.detail != null ? ' ' + (typeof l.detail === 'string' ? l.detail : JSON.stringify(l.detail)) : '';
    const cls = 'log-' + (l.level || 'INFO');
    return `<div class="log-line ${cls}">${t} ${escapeHtml(l.level)} ${escapeHtml(l.event)}${escapeHtml(detail)}</div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

document.getElementById('saveConfig').addEventListener('click', async () => {
  if (!currentCfg) currentCfg = await send({type:'getConfig'});
  currentCfg.enabled = enabledEl.checked;
  currentCfg.intervalMin = parseInt(intervalEl.value);
  currentCfg.daysAhead = parseInt(daysEl.value);
  await send({type:'setConfig', config: currentCfg});
  alert('설정 저장됨');
});

document.getElementById('saveGithub').addEventListener('click', async () => {
  if (!currentCfg) currentCfg = await send({type:'getConfig'});
  const gh = Object.assign({}, currentCfg.github || {});
  gh.pushEnabled = ghEnabledEl.checked;
  gh.systemLogPush = ghSysLogEl.checked;
  gh.repo = ghRepoEl.value.trim();
  gh.branch = ghBranchEl.value.trim() || 'main';
  // 토큰: 마스킹 그대로면 기존 값 유지, 새로 입력했으면 교체
  const tokenInput = ghTokenEl.value;
  if (tokenInput && !/^•+$/.test(tokenInput)) {
    gh.token = tokenInput.trim();
  }
  currentCfg.github = gh;
  await send({type:'setConfig', config: currentCfg});
  ghTokenEl.value = gh.token ? '••••••••••••••••' : '';
  ghTokenEl.dataset.hasToken = gh.token ? '1' : '';
  alert('GitHub 설정 저장됨');
});

checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true;
  checkBtn.innerHTML = '<span class="progress"></span> 조회 중... (약 1분)';
  const result = await send({type:'manualCheck'});
  await loadStatus();
  await loadAlerts();
  await loadLogs();
  checkBtn.disabled = false;
  if (result && result.ok) {
    checkBtn.textContent = `조회 완료! 변동 ${result.result?.changes || 0}건 / 총 ${result.result?.totalSlots || 0} 타임`;
  } else {
    checkBtn.textContent = `조회 실패: ${result?.error || '알 수 없음'} (로그 확인)`;
  }
  setTimeout(() => { checkBtn.textContent = '지금 바로 확인'; }, 6000);
});

document.getElementById('clearAlerts').addEventListener('click', async () => {
  if (!confirm('알림 모두 지울까요?')) return;
  await send({type:'clearAlerts'});
  await loadAlerts();
});

document.getElementById('refreshLogs').addEventListener('click', loadLogs);
document.getElementById('clearLogs').addEventListener('click', async () => {
  if (!confirm('로그 모두 지울까요?')) return;
  await send({type:'clearLogs'});
  await loadLogs();
});

loadStatus();
loadAlerts();
loadConfig();
loadLogs();
