/**
* app.js — 入口文件：初始化 + 事件绑定 + 报告展示 + 导航
*
* 职责：DOMContentLoaded 初始化、核心 UI 事件监听、报告渲染、步骤导航
* 依赖：store.js, config.js, ai.js, tree.js, prompts.js, ui-utils.js（全部已加载）
*       report-library.js, problem-pool.js, prompt-editor.js（已拆分为独立模块）
*
* 拆分历史:
*   2026-05-03  从单文件拆分为 core/plugins 结构
*   2026-05-21  拆分 report-library / problem-pool / prompt-editor 为独立模块
*/
if (window.__appInitialized) {
/* skip — already loaded */
} else {
window.__appInitialized = true;

window.onerror = function (msg, url, line) {
if (msg) {
if (msg.includes('ResizeObserver') || msg.includes('Script error')) {
console.warn('[ignored global error]', msg, url, line);
return true;
}
if (msg.includes('AbortError') || msg.includes('The user aborted') || msg.includes('Request was cancelled')) {
showToast('AI 请求已取消', 'warning');
return true;
}
if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) {
showToast('网络连接失败，请检查网络并重试', 'error');
return true;
}
if (msg.includes('SyntaxError') || msg.includes('JSON') || msg.includes('parse')) {
showToast('AI 响应格式解析失败，请重试或更换模型', 'error');
return true;
}
}
showToast('应用出错：请刷新页面重试', 'error');
console.error('Global error:', msg, url, line);
return false;
};

window.addEventListener('unhandledrejection', (event) => {
const msg = event.reason?.message || String(event.reason);
if (msg) {
if (msg.includes('AbortError') || msg.includes('The user aborted') || msg.includes('Request was cancelled')) {
showToast('AI 请求已取消', 'warning');
return;
}
if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) {
showToast('网络连接失败，请检查网络并重试', 'error');
return;
}
if (msg.includes('SyntaxError') || msg.includes('JSON') || msg.includes('parse')) {
showToast('AI 响应格式解析失败，请重试或更换模型', 'error');
return;
}
if (msg.includes('ALREADY_IN_FLIGHT')) {
return;
}
}
showToast('操作失败：请重试或刷新页面', 'error');
console.error('Unhandled rejection:', event.reason);
});

let currentStep = 'problem';

const updateActiveStep = function (step) {
currentStep = step;
const steps = ['problem', 'why1', 'why2', 'why3', 'why4', 'why5', 'report'];
const idx = steps.indexOf(step);
document.querySelectorAll('.step-btn').forEach((btn) => {
const s = btn.dataset.step;
btn.classList.toggle('active', s === step);
btn.classList.toggle('completed', steps.indexOf(s) < idx);
});
};

const navigateToStep = function (step) {
updateActiveStep(step);

if (step === 'problem') {
document.getElementById('workspaceSection').classList.add('hidden');
document.getElementById('problemSection').classList.remove('hidden');
return;
}

if (step === 'report') {
if (typeof getReportLibrary === 'function' && typeof getActiveProblemId === 'function') {
const _pid = getActiveProblemId();
if (_pid) {
const _reports = getReportLibrary().filter((r) => {
return r.problemId === _pid && r.analysisType === '5why';
});
if (_reports.length > 0) {
const report = _reports[_reports.length - 1];
reportMarkdown = report.content;
cachedReport = report.content;
window.navigateTo('page-report-library');
setTimeout(() => {
showReportDetail(report.id);
}, 50);
return;
}
}
}
showToast('请先生成报告', 'info');
updateActiveStep(currentStep);
return;
}

document.getElementById('problemSection').classList.add('hidden');
document.getElementById('workspaceSection').classList.remove('hidden');

const level = parseInt(step.replace('why', '')) + 1;
highlightLevel(level);
};

requestAnimationFrame(() => {
const visibleSection = document.querySelector('.page-section:not(.hidden)');
const heading = visibleSection?.querySelector('h2, h3, .section-title, .step-navigation');
if (heading) {
heading.setAttribute('tabindex', '-1');
heading.classList.add('focus-sr-only');
heading.focus({ preventScroll: true });
}
});

const highlightLevel = function (level) {
const allNodes = document.querySelectorAll('.why-node');
const levelNodes = [];

allNodes.forEach((node) => {
if (node.dataset.level === String(level)) {
node.classList.add('highlighted-level');
levelNodes.push(node);
} else {
node.classList.remove('highlighted-level');
}
});

if (levelNodes.length > 0) {
levelNodes[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
if (level === 1) {
showToast('已定位到问题节点', 'info');
} else {
showToast('已定位到 Why ' + (level - 1) + ' 层级', 'info');
}
} else {
showToast('该层级尚无节点，请先添加分析', 'info');
}
};

const updateProblemSummaryUI = function (problemId) {
const el = document.getElementById('problemSummary');
if (!el) return;

const id = problemId || getActiveProblemId();
let titleStr = '';
let displayId = '';
let severity = '';

if (id) {
const p = getProblemById(id);
if (p) {
displayId = p.displayId || '';
severity = p.details?.severity || '';
titleStr = p.title || '';
}
}

if (!titleStr && typeof problemStatement !== 'undefined' && problemStatement) {
titleStr = truncate(problemStatement, 40);
}

if (!titleStr) {
titleStr = '当前问题分析';
}

const sevBadges = { minor: '🟢 轻微', major: '🟡 一般', critical: '🔴 严重' };
let html = '';
if (displayId) {
html += '<span style="opacity:0.7;margin-right:6px;">' + esc(displayId) + '</span>';
}
html += esc(titleStr);
if (severity) {
html += '<span style="margin-left:8px;">' + (sevBadges[severity] || '') + '</span>';
}
el.innerHTML = html;

el.title = titleStr;
el.style.cursor = 'help';
};
window.updateProblemSummaryUI = updateProblemSummaryUI;

document.getElementById('btnReset')?.addEventListener('click', async () => {
if (
tree &&
!(await showConfirm(
'确定清空当前 5 Whys 分析吗？将移除分析进度和本地草稿，不影响问题信息、其他分析和已保存报告。',
'danger'
))
)
return;

const clearedProblemId =
typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
const problem =
clearedProblemId && typeof getProblemById === 'function'
? getProblemById(clearedProblemId)
: null;
if (problem && typeof updateProblem === 'function') {
const snapshot = JSON.parse(JSON.stringify(problem.snapshot || { version: 2 }));
snapshot.tree = null;
snapshot.nextId = 1;
snapshot.reportMarkdown = '';
snapshot.cachedReport = null;
snapshot.cachedTreeHash = '';
snapshot.analysisStartTime = null;
snapshot.causalValidationResults = {};
snapshot.consolidatedRootCauses = null;
const analyses = JSON.parse(JSON.stringify(problem.analyses || {}));
analyses['5why'] = {
...(analyses['5why'] || {}),
status: 'not_started',
lastUpdated: new Date().toISOString()
};
const snapshotSaved = await updateProblem(clearedProblemId, { snapshot, analyses });
if (snapshotSaved === false) {
showToast('清空分析快照失败；刷新后可能恢复旧进度', 'warning');
return;
}
}

touchMany(
{
tree: null,
nextId: 1,
reportMarkdown: '',
cachedReport: null,
cachedTreeHash: '',
analysisStartTime: null,
causalValidationResults: {}
},
'clear5WhyAnalysis'
);
if (isReportDirty()) {
setReportDirty(false);
window.removeEventListener('beforeunload', onBeforeUnload);
}
const clearOk = await clearSavedAnalysis(clearedProblemId);
resetTokenUsage();
const psecEl = document.getElementById('problemSection');
if (psecEl) psecEl.classList.remove('hidden');
const wsecEl = document.getElementById('workspaceSection');
if (wsecEl) wsecEl.classList.add('hidden');
renderTree();
if (clearOk === false) {
showToast('内存已重置，但清理持久化数据失败；下次进入该问题可能恢复旧数据', 'warning');
} else {
showToast('当前 5 Whys 分析已清空（不影响问题信息和已保存报告）', 'info');
}
});

document.getElementById('btnLoadFromProblem5Why')?.addEventListener('click', () => {
openProblemPicker((problem) => {
if (window.loadProblemToCurrent && typeof window.loadProblemToCurrent === 'function') {
window.loadProblemToCurrent(problem.id);
}

const titleEl = document.getElementById('analysisProblemTitle');
if (titleEl) titleEl.value = problem.title || '';

const stmt = problem.problemStatement || problem.details?.phenomenon || '';
if (stmt) {
document.getElementById('problemStatement').value = stmt;
}

const ctx =
problem.problemContext ||
(window.buildProblemContext ? window.buildProblemContext(problem) : '');
const ctxEl = document.getElementById('problemContext');
if (ctxEl) {
ctxEl.value = ctx;
}

if (problem.id) {
setActiveProblemId(problem.id);
const p =
typeof window.getProblemById === 'function' ? window.getProblemById(problem.id) : null;
if (p) {
const analyses = p.analyses || {};
if (!analyses['5why'] || analyses['5why'].status === 'not_started') {
analyses['5why'] = { status: 'in_progress', lastUpdated: new Date().toISOString() };
window.updateProblem(problem.id, { analyses: analyses, status: 'analyzing' });
}
}
}

if (
window.Store.tree &&
window.Store.tree.children &&
window.Store.tree.children.length > 0
) {
document.getElementById('problemSection').classList.add('hidden');
document.getElementById('workspaceSection').classList.remove('hidden');
if (typeof renderTree === 'function') renderTree();
updateProblemSummaryUI(problem.id);
} else {
document.getElementById('problemSection').classList.remove('hidden');
document.getElementById('workspaceSection').classList.add('hidden');
}

showToast('已从问题库导入', 'success');
});
});

document.getElementById('btnStartAnalysis')?.addEventListener('click', async () => {
const stmt = document.getElementById('problemStatement').value.trim();
if (!stmt) {
showToast('请输入问题描述', 'error');
return;
}

if (tree && tree.children && tree.children.length > 0 && tree.text !== stmt) {
if (!(await showConfirm('当前分析将被重置，确定要重新开始吗？'))) return;
}

const title =
document.getElementById('analysisProblemTitle')?.value?.trim() || stmt.slice(0, 30);
const context = document.getElementById('problemContext').value.trim();

touchMany(
{
problemStatement: stmt,
problemContext: context,
analysisStartTime: new Date().toISOString()
},
'startAnalysis'
);

const activeId = getActiveProblemId();
if (!activeId) {
const newProblem = createNewProblem({ title: title, status: 'analyzing' });
if (newProblem) {
setActiveProblemId(newProblem.id);
const analyses = {
'5why': { status: 'in_progress', lastUpdated: new Date().toISOString() }
};
updateProblem(newProblem.id, {
title: title,
problemStatement: stmt,
problemContext: context,
analyses: analyses
});
}
} else {

const p = getProblemById(activeId);
if (p) {
const analyses = p.analyses || {};
if (!analyses['5why'] || analyses['5why'].status === 'not_started') {
analyses['5why'] = { status: 'in_progress', lastUpdated: new Date().toISOString() };
}
updateProblem(activeId, { title: title, analyses: analyses, status: 'analyzing' });
}
}

if (tree && tree.text === stmt && tree.children && tree.children.length > 0) {

} else {
tree = createNode(stmt, null, 1);
tree.parentId = null;
}

if (typeof syncActiveProblemNodeCount === 'function') syncActiveProblemNodeCount();

document.getElementById('problemSection').classList.add('hidden');
document.getElementById('workspaceSection').classList.remove('hidden');

updateProblemSummaryUI();

updateActiveStep('why1');

renderTree();
autoSave();
emit('session:changed', { fields: ['tree', 'nextId'], source: 'startAnalysis' });

setTimeout(() => {
const input = document.querySelector('.why-input');
if (input) input.focus({ preventScroll: true });
}, 100);
});

document.getElementById('btnCloseSidebar')?.addEventListener('click', () => {
if (window.SidebarUI) {
window.SidebarUI.close();
} else {
document.getElementById('aiSidebar')?.classList.remove('open');
}

const h3 = document.querySelector('.sidebar-header h3');
if (h3) h3.textContent = 'AI 助手';
});

document.getElementById('btnVerifyCausality')?.addEventListener('click', () => {
showCausalVerification();
});

document.getElementById('btnConsolidate')?.addEventListener('click', () => {
consolidateRootCauses();
});

document.getElementById('btnAutoAnalyze')?.addEventListener('click', async () => {
try {
await autoAnalyze();
} finally {
renderTree();
}
});

const logo = document.getElementById('headerLogo');
logo?.addEventListener('click', () => location.reload());
logo?.addEventListener('keydown', (e) => {
if (e.key === 'Enter' || e.key === ' ') {
e.preventDefault();
location.reload();
}
});

window.navigateToStep = navigateToStep;

document.querySelector('.step-navigation')?.addEventListener('click', (e) => {
const btn = e.target.closest('.step-btn');
if (btn && btn.dataset.step) {
navigateToStep(btn.dataset.step);
}
});

const initializeApp = async () => {

if (window.initDB) {
await window.initDB();
}

await loadSettings();

if (window.QualityToolKB && typeof window.QualityToolKB.validate === 'function') {
if (
typeof location !== 'undefined' &&
(location.hostname === 'localhost' || location.hostname === '127.0.0.1')
) {
window.QualityToolKB.validate();
}
}

bootstrapApp();
};

if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', initializeApp);
} else {
initializeApp();
}

const bootstrapApp = async function () {
if (window.ProblemManager) {
document.getElementById('btnAIAssess')?.addEventListener('click', () => {
window.ProblemManager.evaluate();
});
document.getElementById('btnViewAssessment')?.addEventListener('click', () => {
window.ProblemManager.viewAssessment();
});
}

const pluginLoads = [];

if (window.Fishbone) {
pluginLoads.push(
window.Fishbone.load().then(() => {
window.Fishbone.bindEvents();
})
);
}

if (window.FTA) {
window.FTA.init();
}

if (window.FiveWhys) {
pluginLoads.push(window.FiveWhys.init());
}

const settled = await Promise.allSettled(pluginLoads);
settled.forEach((r) => {
if (r.status === 'rejected') {
console.error('[bootstrapApp] plugin load failed:', r.reason);
}
});

initSidebar();
initStorageObserver();

if (typeof emit === 'function') {
emit('session:restored');
}
window.__bootstrapCompleted = true;
};

const initSidebar = function () {
if (
typeof document === 'undefined' ||
typeof localStorage === 'undefined' ||
typeof localStorage.getItem !== 'function'
)
return;
const sidebar = document.getElementById('sidebarNav');
const toggleBtn = document.getElementById('sidebarToggle');
const sidebarBtns = document.querySelectorAll('.sidebar-btn');
const mainContent = document.querySelector('.main-content');

function setSidebarExpanded(expanded) {
if (!sidebar) return;
if (expanded) {
sidebar.classList.add('expanded');
if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
if (mainContent) document.body.classList.add('sidebar-expanded');
} else {
sidebar.classList.remove('expanded');
if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
if (mainContent) document.body.classList.remove('sidebar-expanded');
}
localStorage.setItem('sidebar-expanded', String(expanded));
}

if (toggleBtn && sidebar) {
toggleBtn.addEventListener('click', () => {
setSidebarExpanded(!sidebar.classList.contains('expanded'));
});
}

if (sidebar) {
const saved = localStorage.getItem('sidebar-expanded');
if (saved === 'false') {
sidebar.classList.remove('expanded');
if (mainContent) document.body.classList.remove('sidebar-expanded');
if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
} else {
sidebar.classList.add('expanded');
if (mainContent) document.body.classList.add('sidebar-expanded');
if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
}
}

sidebarBtns.forEach((btn) => {
btn.addEventListener('click', () => {
const pageId = btn.dataset.page;
const toolId = btn.dataset.tool;
if (pageId) {
if (toolId) {

if (typeof autoSave === 'function') autoSave();
const pid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
if (pid && typeof loadProblemToCurrent === 'function') {

const problem = typeof getProblemById === 'function' ? getProblemById(pid) : null;
if (!problem || !problem._fromExample) {
loadProblemToCurrent(pid);
}
}
}
window.navigateTo(pageId, toolId);
}
});
});

const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const backdrop = document.getElementById('sidebarBackdrop');
if (mobileMenuBtn && sidebar) {
mobileMenuBtn.addEventListener('click', () => {
const isOpen = sidebar.classList.toggle('mobile-open');
mobileMenuBtn.setAttribute('aria-expanded', isOpen.toString());
backdrop?.classList.toggle('visible', isOpen);
});
document.addEventListener('click', (e) => {
if (
window.matchMedia('(max-width: ' + UI_CONFIG.MOBILE_BREAKPOINT + 'px)').matches &&
sidebar.classList.contains('mobile-open')
) {
if (!sidebar.contains(e.target) && !mobileMenuBtn.contains(e.target)) {
sidebar.classList.remove('mobile-open');
backdrop?.classList.remove('visible');
mobileMenuBtn.setAttribute('aria-expanded', 'false');
}
}
});
}

if (typeof renderProblemList === 'function')
registerPageHook('page-problem', renderProblemList);
if (typeof renderReportLibrary === 'function')
registerPageHook('page-report-library', renderReportLibrary);

if (typeof renderProblemList === 'function') renderProblemList();
};

const initStorageObserver = function () {
if (typeof on !== 'function') return;

on('storage:quota_exceeded', () => {
showToast('⚠️ 存储空间已满！数据无法自动保存', 'error');
if (document.getElementById('storageQuotaModal')) return;

const modal = document.createElement('dialog');
modal.id = 'storageQuotaModal';
modal.className = 'modal-overlay';

const box = document.createElement('div');
box.className = 'modal';
box.style.maxWidth = '480px';
box.innerHTML = `
<h3 style="margin-top:0;color:var(--red);display:flex;align-items:center;gap:var(--space-2);">
<svg viewBox="0 0 24 24" style="width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
存储空间已满
</h3>
<p style="font-size:0.9rem;line-height:1.6;margin:var(--space-3) 0;">本地存储已满。为了防止您当前的研究成果丢失，<strong>请立即导出完整的 JSON 快照备份</strong>，或者去"问题管理"中清理不用的旧问题。</p>
<div style="margin-top:var(--space-5);display:flex;justify-content:flex-end;gap:var(--space-3);">
<button class="btn btn-outline btn-sm" id="quotaDismissBtn">暂时忽略</button>
<button class="btn btn-primary btn-sm" id="quotaExportBtn">立即导出快照 (JSON)</button>
</div>
`;
modal.appendChild(box);
document.body.appendChild(modal);
modal.showModal();
modal.addEventListener('close', () => modal.remove());

document.getElementById('quotaDismissBtn')?.addEventListener('click', () => modal.close());
document.getElementById('quotaExportBtn')?.addEventListener('click', () => {
if (typeof exportSnapshot === 'function') {
exportSnapshot('full');
showToast('已导出紧急备份', 'success');
modal.close();
}
});
});

function checkQuotaAndAlert() {
if (typeof getStorageUsage !== 'function') return;
const usage = getStorageUsage();
let alertBar = document.getElementById('storageQuotaAlertBar');

if (usage.percent >= 80) {
if (!alertBar) {
alertBar = document.createElement('div');
alertBar.id = 'storageQuotaAlertBar';
alertBar.style.cssText =
'background:var(--red-light);border-bottom:1px solid var(--red);color:var(--red-dark);padding:var(--space-2) var(--space-4);font-size:0.8rem;text-align:center;font-weight:600;display:flex;align-items:center;justify-content:center;gap:var(--space-3);z-index:var(--z-dropdown,110);position:relative;';
const mainEl = document.getElementById('main');
if (mainEl) mainEl.prepend(alertBar);
}

let msgSpan = alertBar.querySelector('#storageQuotaAlertMsg');
if (!msgSpan) {
msgSpan = document.createElement('span');
msgSpan.id = 'storageQuotaAlertMsg';
alertBar.appendChild(msgSpan);
}
msgSpan.textContent = `⚠️ 本地存储已占用 ${usage.percent.toFixed(0)}% (${usage.usedMB} MB / 5.00 MB)，请及时清理旧问题或导出快照，防止自动保存失败。`;

if (!alertBar.querySelector('#storageQuotaAlertExportBtn')) {
const exportBtn = document.createElement('button');
exportBtn.id = 'storageQuotaAlertExportBtn';
exportBtn.className = 'btn btn-xs btn-primary';
exportBtn.style.cssText = 'padding:2px 8px;font-size:10px;margin-left:8px;';
exportBtn.textContent = '立即导出';
exportBtn.addEventListener('click', () => {
if (typeof exportSnapshot === 'function') exportSnapshot('full');
});
alertBar.appendChild(exportBtn);
}
} else {
alertBar?.remove();
}
}

on('session:changed', checkQuotaAndAlert);
on('session:restored', checkQuotaAndAlert);

setTimeout(checkQuotaAndAlert, 1000);

let _saveToProblemTimer = null;
on('session:changed', (data) => {
const fields = data && data.fields ? data.fields : [];
if (fields.indexOf('tree') === -1) return;
const activeId = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
if (!activeId) return;
clearTimeout(_saveToProblemTimer);
_saveToProblemTimer = setTimeout(() => {
const p = typeof getProblemById === 'function' ? getProblemById(activeId) : null;
const title = p ? p.title : '';
if (typeof saveCurrentAnalysisToProblem === 'function') {
saveCurrentAnalysisToProblem(activeId, title, true, {
capturePlugins: { fishbone: false, fta: false }
});
}
}, 800);
});
};

window.collapseSidebar = function () {
var sidebar = document.getElementById('sidebarNav');
var toggleBtn = document.getElementById('sidebarToggle');
if (!sidebar) return;
sidebar.classList.remove('expanded');
if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
document.body.classList.remove('sidebar-expanded');
localStorage.setItem('sidebar-expanded', 'false');
};

if (typeof module !== 'undefined' && module.exports) {
module.exports = {};
}
} /* end __appInitialized guard */
