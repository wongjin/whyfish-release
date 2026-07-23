/**
* analysis-hub.js — 问题分析与解决：分析管理页面
*
* 职责：卡片列表展示分析中的问题，方法状态追踪，根因摘要，方法入口
* 依赖：store.js (getProblemList/getProblemById/updateProblem/getReportLibrary),
*        ui-utils.js (esc/showToast/navigateTo)
* 暴露：renderAnalysisHub, markAnalysisCompleted
*/

let _hubFilter = 'all';

function renderAnalysisHub() {
const container = document.getElementById('analysisHubContent');
if (!container) return;

const allProblems = getProblemList();

let filtered = allProblems;
if (_hubFilter === 'analyzing') {
filtered = allProblems.filter((p) => {
return p.status !== 'completed';
});
} else if (_hubFilter === 'completed') {
filtered = allProblems.filter((p) => {
return p.status === 'completed';
});
}

filtered.sort((a, b) => {
const da = a.updatedAt || a.createdAt || '';
const db = b.updatedAt || b.createdAt || '';
return db.localeCompare(da);
});

let html = '';

html += '<section class="page-section">';
html += '<div class="page-card">';
html += '<div class="page-header">';
html += '  <div>';
html += '    <h2 class="card-title">WhyFish 问题分析与解决</h2>';
html += '    <p class="card-desc">用系统化方法分析原因</p>';
html += '  </div>';
html += '</div>';

if (allProblems.length > 0) {

html += '<div class="hub-session-header">';
html += '  <span class="hub-session-title">';
html +=
'    <svg class="hub-session-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
html +=
'      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>';
html += '    </svg>';
html += '    分析会话';
html += '  </span>';
html += '  <div class="hub-session-actions">';
html += '    <div class="hub-filter-group">';
html +=
'      <button class="btn ' +
(_hubFilter === 'all' ? 'btn-primary' : 'btn-outline') +
' btn-sm" data-action="hub-filter" data-filter="all">全部 <span class="filter-count">' +
allProblems.length +
'</span></button>';
html +=
'      <button class="btn ' +
(_hubFilter === 'analyzing' ? 'btn-primary' : 'btn-outline') +
' btn-sm" data-action="hub-filter" data-filter="analyzing">分析中 <span class="filter-count">' +
allProblems.filter((p) => {
return p.status !== 'completed';
}).length +
'</span></button>';
html +=
'      <button class="btn ' +
(_hubFilter === 'completed' ? 'btn-primary' : 'btn-outline') +
' btn-sm" data-action="hub-filter" data-filter="completed">已完成 <span class="filter-count">' +
allProblems.filter((p) => {
return p.status === 'completed';
}).length +
'</span></button>';
html += '    </div>';
html += '  </div>';
html += '</div>';
}

if (allProblems.length === 0) {
html += '<div class="empty-state">';
html += '  <div class="empty-icon">';
html +=
'    <svg class="empty-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 40px; height: 40px; color: var(--text-muted); opacity: 0.8; margin-bottom: 8px; display: inline-block;">';
html += '      <circle cx="12" cy="12" r="10" />';
html += '      <path d="M12 6v6l4 2" />';
html += '    </svg>';
html += '  </div>';
html += '  <h3>暂无分析项目</h3>';
html += '  <p>您还没有创建任何问题。请先在问题管理中创建问题，然后开始分析。</p>';
html +=
'  <div class="hub-empty-actions" style="display: flex; justify-content: center; gap: 12px; margin-top: 12px;">';
html += '    <button class="btn btn-primary" data-action="hub-new-problem">新建问题</button>';
html += '  </div>';
html += '</div>';
} else if (filtered.length === 0) {
html += '<div class="empty-state">';
html +=
'  <div class="empty-icon"><svg class="empty-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 40px; height: 40px;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>';
html += '  <h3>无符合筛选条件的问题</h3>';
html += '  <p>可尝试切换其他筛选标签</p>';
html += '</div>';
} else {
html += '<div class="hub-table-wrapper">';
html += '<table class="hub-table">';
html += '<thead><tr>';
html += '<th class="col-index">#</th>';
html += '<th class="col-id">问题编号</th>';
html += '<th class="col-title">问题标题</th>';
html += '<th class="col-status">状态</th>';
html += '<th class="col-method">5 Whys</th>';
html += '<th class="col-method">鱼骨图</th>';
html += '<th class="col-method">故障树</th>';
html += '<th class="col-report">报告</th>';
html += '</tr></thead>';
html += '<tbody>';
filtered.forEach((problem, idx) => {
html += _renderAnalysisRow(problem, idx + 1);
});
html += '</tbody></table></div>';
}

html += '</div>';
html += '</section>';

container.innerHTML = html;

container.querySelectorAll('[data-action="hub-filter"]').forEach((el) => {
el.addEventListener('click', () => {
_setHubFilter(el.dataset.filter);
});
});
container.querySelectorAll('[data-action="hub-new-problem"]').forEach((el) => {
el.addEventListener('click', () => {
window.navigateTo('page-problem');
setTimeout(() => {
document.getElementById('btnCreateNewProblem')?.click();
}, 100);
});
});
container.querySelectorAll('[data-action="hub-show-problem"]').forEach((el) => {
el.addEventListener('click', (e) => {
e.preventDefault();
window.navigateTo('page-problem');
setTimeout(() => {
showProblemDetail(el.dataset.problemId);
}, 100);
});
});
container.querySelectorAll('[data-action="hub-view-reports"]').forEach((el) => {
el.addEventListener('click', (e) => {
e.preventDefault();
_viewReports(el.dataset.problemId);
});
});
container.querySelectorAll('[data-action="hub-launch-analysis"]').forEach((el) => {
el.addEventListener('click', () => {
_launchAnalysisFromCard(el.dataset.problemId, el.dataset.methodKey);
});
});
}

function _renderAnalysisRow(problem, idx) {
const analyses = problem.analyses || {};
const statusLabels = window.Labels?.status || { pending: '待分析', analyzing: '分析中', completed: '已完成' };
const statusClasses = {
pending: 'status-pending',
analyzing: 'status-analyzing',
completed: 'status-completed'
};
const statusClass = statusClasses[problem.status] || 'status-analyzing';
const statusLabel = statusLabels[problem.status] || '分析中';

let html = '';
html += '<tr class="hub-table-row" data-problem-id="' + esc(problem.id) + '">';

html += '<td class="col-index">' + idx + '</td>';

html +=
'<td class="col-id"><span class="id-badge">' + esc(problem.displayId || '-') + '</span></td>';

html +=
'<td class="col-title"><a class="problem-link" href="#" data-action="hub-show-problem" data-problem-id="' +
esc(problem.id) +
'">' +
esc(problem.title || '未命名问题') +
'</a></td>';

html +=
'<td class="col-status"><span class="status-badge ' +
statusClass +
'">' +
statusLabel +
'</span></td>';

ANALYSIS_METHODS.forEach((m) => {
const state = analyses[m.key];
const st = state ? state.status : 'not_started';
html += _renderMethodCell(problem.id, m.key, st);
});

const reports = _getReportsForProblem(problem.id);
html += '<td class="col-report">';
if (reports.length > 0) {
html +=
'<a class="report-link" href="#" data-action="hub-view-reports" data-problem-id="' +
esc(problem.id) +
'">' +
reports.length +
' 份</a>';
} else {
html += '<span class="no-report">—</span>';
}
html += '</td>';

html += '</tr>';
return html;
}

function _renderMethodCell(problemId, methodKey, status) {
let label = '';
let cls = 'idle';
switch (status) {
case 'completed':
label = '✅ 已完成';
cls = 'done';
break;
case 'in_progress':
label = '⏳ 分析中';
cls = 'progress';
break;
default:
label = '⚪ 未开始';
cls = 'idle';
}
return (
'<td class="col-method ' +
cls +
'" data-action="hub-launch-analysis" data-problem-id="' +
esc(problemId) +
'" data-method-key="' +
esc(methodKey) +
'">' +
'<span class="method-badge ' +
cls +
'">' +
label +
'</span>' +
'</td>'
);
}

function _getReportsForProblem(problemId) {
if (typeof getReportLibrary !== 'function') return [];
return getReportLibrary().filter((r) => {
return r.problemId === problemId;
});
}

function _setHubFilter(filter) {
_hubFilter = filter;
renderAnalysisHub();
}

/**
* 同步工具 DOM：将问题数据填入当前工具的输入字段。
* 共享 helper，被 _launchAnalysisFromCard 和 problem-pool.js 复用。
*/
function syncToolDom(problemId, methodKey) {
const problem = getProblemById(problemId);
if (!problem) return;
const _stmt = problem.problemStatement || (problem.details && problem.details.phenomenon) || '';
const _title = problem.title || '';
const _ctx =
problem.problemContext ||
(typeof window.buildProblemContext === 'function' ? window.buildProblemContext(problem) : '');

if (methodKey === '5why' || methodKey === 'tool-5why') {
const _stmtEl = document.getElementById('problemStatement');
if (_stmtEl && _stmt) _stmtEl.value = _stmt;
const _ctxEl = document.getElementById('problemContext');
if (_ctxEl && _ctx) _ctxEl.value = _ctx;
const _titleEl = document.getElementById('analysisProblemTitle');
if (_titleEl) _titleEl.value = _title || '';
if (typeof updateProblemSummaryUI === 'function') {
updateProblemSummaryUI(problemId);
}
} else if (methodKey === 'fishbone' || methodKey === 'tool-fishbone') {
const probInput = document.getElementById('fishbone-problem');
if (probInput) {
probInput.value = _title || _stmt.slice(0, 30) || '';
}
const refEl = document.getElementById('fishbone-phenomenon-ref');
if (refEl) refEl.value = _stmt || '';
const ctxRefEl = document.getElementById('fishbone-context-ref');
if (ctxRefEl && _ctx) ctxRefEl.value = _ctx;

if (probInput) probInput.dispatchEvent(new Event('input', { bubbles: true }));
} else if (methodKey === 'fta' || methodKey === 'tool-fta') {
const titleRefEl = document.getElementById('fta-problem-title-ref');
if (titleRefEl) titleRefEl.value = _title || '';
if (window.FTA) {
const ftd = window.FTA.getData();
ftd.metadata.problemTitle = _title;
ftd.metadata.problemContext = _stmt;
const ctxEl = document.getElementById('fta-problem-context');
if (ctxEl) ctxEl.value = _stmt || '';
if (!ftd.rootId) {
const topEventEl = document.getElementById('fta-top-event');
if (topEventEl && !topEventEl.value.trim()) topEventEl.value = _title || '';
if (!ftd.topEvent.name) ftd.topEvent.name = _title || '';
}
}
}
}

function _launchAnalysisFromCard(problemId, methodKey) {
setActiveProblemId(problemId);
const method = ANALYSIS_METHODS.find((m) => {
return m.key === methodKey;
});
if (!method) return;

const problem = getProblemById(problemId);
if (!problem) return;

const analyses = problem.analyses || {};
if (!analyses[methodKey] || analyses[methodKey].status === 'not_started') {
analyses[methodKey] = { status: 'in_progress', lastUpdated: new Date().toISOString() };
updateProblem(problemId, { analyses: analyses, status: 'analyzing' });
}

if (typeof loadProblemToCurrent === 'function') {
loadProblemToCurrent(problemId, () => {
syncToolDom(problemId, methodKey);
window.navigateTo(method.page, method.tool);
if (typeof updateProblemSummaryUI === 'function') {
updateProblemSummaryUI(problemId);
}
});
}
}

function _viewReports(problemId) {
if (typeof setReportFilter === 'function') setReportFilter(problemId);
window.navigateTo('page-report-library');
}

window.renderAnalysisHub = renderAnalysisHub;
window.syncToolDom = syncToolDom;
window.launchAnalysisFromCard = _launchAnalysisFromCard;
