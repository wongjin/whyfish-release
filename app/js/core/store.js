/**
* store.js — 数据模型 + 持久化 + 通用工具函数
*
* 职责：全局状态变量、localStorage 持久化、通用 DOM 工具
* 依赖：prompts.js（PROMPTS 全局变量，仅 exportSnapshot/importSnapshot 间歇引用）
* 被依赖：所有其他模块
*/

window.Store = {
tree: null,
nextId: 1,
nodeIndex: new Map(),
problemStatement: '',
problemContext: '',
reportMarkdown: '',
cachedReport: null,
cachedTreeHash: '',
_reportDirty: false,
analysisStartTime: null,
causalValidationResults: {},
consolidatedRootCauses: [],
_activeProblemId:
(typeof localStorage !== 'undefined' ? localStorage.getItem('active_problem_id') : null) ||
null,
totalTokensUsed: { prompt: 0, completion: 0, total: 0, calls: 0 },
_autoSaveTimer: null,
_db: null,
_dbReady: null,
_problemsCache: [],
_reportsCache: [],
_activeStateCache: null,
_saveGeneration: 0,
_pendingAIReportLinks: {}
};

const _globalsToProxy = [
'tree',
'nextId',
'nodeIndex',
'problemStatement',
'problemContext',
'reportMarkdown',
'cachedReport',
'cachedTreeHash',
'_reportDirty',
'analysisStartTime',
'causalValidationResults',
'consolidatedRootCauses',
'_activeProblemId',
'totalTokensUsed',
'_autoSaveTimer',
'_db',
'_dbReady',
'_problemsCache',
'_reportsCache',
'_activeStateCache',
'_saveGeneration'
];

_globalsToProxy.forEach((key) => {
Object.defineProperty(window, key, {
get: () => window.Store[key],
set: (v) => {
window.Store[key] = v;
},
configurable: true
});
});

function setReportMarkdown(v) {
touch({ reportMarkdown: v }, 'setter');
}
function setCachedReport(v) {
touch({ cachedReport: v }, 'setter');
}
function setCachedTreeHash(v) {
touch({ cachedTreeHash: v }, 'setter');
}
function isReportDirty() {
return _reportDirty;
}
function setReportDirty(v) {
_reportDirty = v;
}

function captureAiContext() {
return { problemId: getActiveProblemId() };
}
function checkAiContext(ctx, actionName) {
if (!ctx || !ctx.problemId) return true;
const currentId = getActiveProblemId();
if (currentId !== ctx.problemId) {
showToast('AI 结果与当前问题不匹配，已忽略', 'warning');
return false;
}
return true;
}

function onBeforeUnload(e) {
e.preventDefault();
e.returnValue = '';
}

const _listeners = {};

function on(event, fn) {
(_listeners[event] = _listeners[event] || []).push(fn);
}

function emit(event, data) {
(_listeners[event] || []).forEach((fn) => {
try {
fn(data);
} catch (e) {
console.error('[EventBus]', event, e);
}
});
}

function _setSavePending() {
const dot = document.getElementById('saveStatusDot');
const txt = document.getElementById('saveStatusText');
if (!dot || !txt) return;
dot.style.background = 'var(--orange, #b45309)';
txt.textContent = '保存中...';
}

function _setSaveDone(label) {
const dot = document.getElementById('saveStatusDot');
const txt = document.getElementById('saveStatusText');
if (!dot || !txt) return;
dot.style.background = 'var(--analysis-accent, #008066)';
txt.textContent = label || '5Whys 已保存';
}

/** 取消待处理的 autoSave，防止切换问题时写入过时数据 */
window.flushAutoSave = function () {
clearTimeout(_autoSaveTimer);
window.Store._saveGeneration++;
};

window.setSaveStatus = function (label) {
const dot = document.getElementById('saveStatusDot');
const txt = document.getElementById('saveStatusText');
if (!dot || !txt) return;
dot.style.background = 'var(--analysis-accent, #008066)';
txt.textContent = label || '已保存';
};

function touch(changes, source) {
_setSavePending();
window.Store._saveGeneration++;
for (const [key, val] of Object.entries(changes)) {
if (key in window.Store) window.Store[key] = val;
}
if (Object.keys(changes).length === 1 && '_activeProblemId' in changes) {
emit('session:changed', { fields: Object.keys(changes), source });
return;
}
autoSave();
emit('session:changed', { fields: Object.keys(changes), source });
}

function touchMany(stateObj, source) {
window.Store._saveGeneration++;
const fields = [];
for (const [key, val] of Object.entries(stateObj)) {
if (key in window.Store) {
window.Store[key] = val;
fields.push(key);
}
}
autoSave();
emit('session:changed', { fields, source });
}

const ANALYSIS_METHODS = [
{
key: '5why',
icon: '<svg class="badge-icon-svg" viewBox="0 0 40 40" style="width:14px;height:14px;" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><text x="2" y="38" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="900" fill="currentColor" stroke="none">5</text><g transform="translate(-19.5, -3.5) scale(1.75)"><path d="M20 24 C20 20, 22 15, 24 10" stroke="currentColor" stroke-width="1.8" fill="none" /><path d="M23 13 Q18 8, 14 5 Q17 10, 23 13Z" fill="currentColor" opacity="0.9" stroke="none" /><path d="M24 10 Q23 4, 22 1 Q25 5, 24 10Z" fill="currentColor" opacity="0.85" stroke="none" /><path d="M24 11 Q29 6, 35 5 Q30 9, 24 11Z" fill="currentColor" opacity="0.8" stroke="none" /><path d="M23 16 Q29 12, 35 12 Q29 15, 23 16Z" fill="currentColor" opacity="0.6" stroke="none" /><path d="M22 17 Q17 13, 13 12 Q17 15, 22 17Z" fill="currentColor" opacity="0.55" stroke="none" /><path d="M23.5 12 Q20 7, 17 6 Q20 9, 23.5 12Z" fill="currentColor" opacity="0.5" stroke="none" /></g></svg>',
name: '5 Whys',
tool: 'tool-5why',
page: 'page-analysis'
},
{
key: 'fishbone',
icon: '<svg class="badge-icon-svg" viewBox="0 0 24 24" style="width:14px;height:14px;stroke-width:2.2px;"><path stroke-linecap="round" stroke-linejoin="round" d="M22 12H2 M18 8l4 4-4 4 M6 6l5 6 M12 6l5 6 M6 18l5-6 M12 18l5-6 M2 9v6l3-3-3-3z"/></svg>',
name: '鱼骨图',
tool: 'tool-fishbone',
page: 'page-analysis'
},
{
key: 'fta',
icon: '<svg class="badge-icon-svg" viewBox="0 0 24 24" style="width:14px;height:14px;stroke-width:2.2px;"><rect x="9" y="1" width="6" height="5" rx="1"/><rect x="1" y="17" width="6" height="5" rx="1"/><rect x="17" y="17" width="6" height="5" rx="1"/><path d="M12 6v6M12 12H4v5M12 12h8v5"/></svg>',
name: '故障树',
tool: 'tool-fta',
page: 'page-analysis'
}
];

function getActiveProblemId() {
return _activeProblemId;
}
function setActiveProblemId(id) {
touch({ _activeProblemId: id }, 'setter');
if (typeof localStorage !== 'undefined') {
if (id) {
localStorage.setItem('active_problem_id', id);
} else {
localStorage.removeItem('active_problem_id');
}
}
}

function markAnalysisCompleted(methodKey, problemId) {
const targetId = problemId || _activeProblemId;
if (!targetId) return;
const problem = getProblemById(targetId);
if (!problem) return;
const analyses = problem.analyses || {};
analyses[methodKey] = { status: 'completed', lastUpdated: new Date().toISOString() };
updateProblem(targetId, {
analyses: analyses,
status: 'analyzing'
});
}

function addTokenUsage(usage) {
if (!usage) return;
totalTokensUsed.prompt += usage.prompt || 0;
totalTokensUsed.completion += usage.completion || 0;
totalTokensUsed.total += usage.total || 0;
totalTokensUsed.calls += 1;
}

function resetTokenUsage() {
totalTokensUsed = { prompt: 0, completion: 0, total: 0, calls: 0 };
}

function getTokenUsage() {
return totalTokensUsed;
}

const SCHEMA_VERSION = 2;
const AI_RESULT_SCHEMA_VERSION = 1;
const AI_RESULT_MAX_PER_PROBLEM = 20;
const AI_RESULT_MAX_PER_CONTEXT = 5;
const AI_RESULT_MAX_BLOCKS = 24;
const AI_RESULT_MAX_BLOCK_TEXT = 6000;

function _boundedAiText(value, maxLength) {
return String(value == null ? '' : value).slice(0, maxLength);
}

function normalizeAIResult(record, problemId) {
if (!record || typeof record !== 'object') return null;
const blocks = Array.isArray(record.blocks)
? record.blocks
.slice(0, AI_RESULT_MAX_BLOCKS)
.map((block) => {
if (!block || typeof block !== 'object') return null;
const text = _boundedAiText(block.text, AI_RESULT_MAX_BLOCK_TEXT).trim();
if (!text) return null;
return {
kind: _boundedAiText(block.kind || 'default', 32),
title: _boundedAiText(block.title, 240),
text
};
})
.filter(Boolean)
: [];
if (!blocks.length) return null;

const createdAt = !isNaN(Date.parse(record.createdAt))
? new Date(record.createdAt).toISOString()
: new Date().toISOString();
return {
schemaVersion: AI_RESULT_SCHEMA_VERSION,
id:
_boundedAiText(record.id, 120) ||
'ai_result_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
problemId: _boundedAiText(problemId || record.problemId, 160),
tool: _boundedAiText(record.tool || 'problem', 40),
action: _boundedAiText(record.action || 'analysis', 80),
title: _boundedAiText(record.title || 'AI 分析结果', 240),
status: record.status === 'fallback' ? 'fallback' : 'success',
createdAt,
model: _boundedAiText(record.model, 160),
inputHash: _boundedAiText(record.inputHash, 160),
reportId: _boundedAiText(record.reportId, 160),
appliedAt: !isNaN(Date.parse(record.appliedAt))
? new Date(record.appliedAt).toISOString()
: null,
blocks
};
}

function normalizeAIResults(records, problemId) {
if (!Array.isArray(records)) return [];
const contextCounts = new Map();
const seenIds = new Set();
return records
.map((record) => normalizeAIResult(record, problemId))
.filter(Boolean)
.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
.filter((record) => {
if (seenIds.has(record.id)) return false;
seenIds.add(record.id);
const key = record.tool + ':' + record.action;
const count = contextCounts.get(key) || 0;
if (count >= AI_RESULT_MAX_PER_CONTEXT) return false;
contextCounts.set(key, count + 1);
return true;
})
.slice(0, AI_RESULT_MAX_PER_PROBLEM);
}

async function saveAIResult(record) {
const problemId = record?.problemId || getActiveProblemId();
if (!problemId) return null;
const problem = getProblemById(problemId);
if (!problem || problem._fromExample) return null;
const normalized = normalizeAIResult(record, problemId);
if (!normalized) return null;
if (!normalized.reportId && /报告/.test(normalized.title)) {
const pending = window.Store._pendingAIReportLinks[problemId];
if (pending) {
normalized.reportId = _boundedAiText(pending.reportId, 160);
normalized.tool = _boundedAiText(pending.tool || normalized.tool, 40);
delete window.Store._pendingAIReportLinks[problemId];
}
}
const existing = Array.isArray(problem.aiResults) ? problem.aiResults : [];
const next = normalizeAIResults(
[normalized, ...existing.filter((item) => item && item.id !== normalized.id)],
problemId
);
const saved = await updateProblem(problemId, { aiResults: next });
if (saved === false) return null;
if (typeof emit === 'function') emit('ai-results:changed', { problemId, result: normalized });
return normalized;
}

function getAIResults(problemId, options = {}) {
const pid = problemId || getActiveProblemId();
const problem = pid ? getProblemById(pid) : null;
if (!problem) return [];
return normalizeAIResults(problem.aiResults, pid).filter((record) => {
if (options.tool && record.tool !== options.tool) return false;
if (options.action && record.action !== options.action) return false;
return true;
});
}

function getLatestAIResult(problemId, options = {}) {
return getAIResults(problemId, options)[0] || null;
}

async function linkLatestAIResultToReport(options = {}) {
const problemId = options.problemId || getActiveProblemId();
if (!problemId || !options.reportId) return null;
const problem = getProblemById(problemId);
if (!problem) return null;
const records = normalizeAIResults(problem.aiResults, problemId);
const tool = options.tool || '';
const target = records.find(
(record) =>
!record.reportId &&
/报告/.test(record.title) &&
(!tool || record.tool === tool || record.tool === 'report') &&
Math.abs(Date.now() - Date.parse(record.createdAt)) < 10 * 60 * 1000
);
if (!target) {
window.Store._pendingAIReportLinks[problemId] = {
reportId: _boundedAiText(options.reportId, 160),
tool: _boundedAiText(tool, 40)
};
return null;
}
target.reportId = _boundedAiText(options.reportId, 160);
if (tool) target.tool = _boundedAiText(tool, 40);
const saved = await updateProblem(problemId, { aiResults: records });
return saved === false ? null : target;
}

const DB_NAME = 'TPA_Offline_DB';
const DB_VERSION = 2;
const STORE_PROBLEMS = 'problems';
const STORE_REPORTS = 'reports';
const STORE_PLUGIN_DATA = 'plugin_data';

const _tabChannel =
typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tpa-db-sync') : null;
if (_tabChannel) {
_tabChannel.onmessage = (e) => {
if (e.data?.type === 'db-updated') {
if (document.hidden) return;
console.log('[DB] Cross-tab update detected, reloading cache');
_loadCache()
.then(() => {
if (typeof renderAnalysisHub === 'function') renderAnalysisHub();
if (typeof renderProblemList === 'function') renderProblemList();
})
.catch((err) => {
console.error('[DB] Failed to reload cache on cross-tab update:', err);
});
}
};
}

function _broadcastDbUpdate() {
if (_tabChannel) _tabChannel.postMessage({ type: 'db-updated', ts: Date.now() });
}

function initDB() {
_dbReady = new Promise((resolve) => {
if (typeof indexedDB === 'undefined') {
console.warn(
'[DB] IndexedDB is not supported by this browser. Falling back to in-memory only.'
);
resolve();
return;
}

const request = indexedDB.open(DB_NAME, DB_VERSION);

request.onerror = (e) => {
console.error('[DB] Failed to open IndexedDB:', e);
resolve();
};

request.onsuccess = (e) => {
_db = e.target.result;
console.log('[DB] IndexedDB opened successfully.');

_db.onversionchange = () => {
_db.close();
_db = null;
_dbReady = null;
console.warn(
'[DB] Database version change requested. Reopening connection...'
);

getDbReady().then(() => {
console.log('[DB] Reopened database connection on versionchange.');
});
};

_loadCache()
.then(resolve)
.catch((err) => {
console.error('[DB] Cache loading failed:', err);
resolve();
});
};

request.onblocked = () => {
console.warn(
'[DB] IndexedDB open blocked — another tab holds an older version. Falling back to in-memory.'
);
resolve();
};

request.onupgradeneeded = (e) => {
const db = e.target.result;
if (!db.objectStoreNames.contains(STORE_PROBLEMS)) {
db.createObjectStore(STORE_PROBLEMS, { keyPath: 'id' });
}
if (!db.objectStoreNames.contains(STORE_REPORTS)) {
db.createObjectStore(STORE_REPORTS, { keyPath: 'id' });
}
if (!db.objectStoreNames.contains(STORE_PLUGIN_DATA)) {
db.createObjectStore(STORE_PLUGIN_DATA);
}
console.log('[DB] Database stores initialized.');
};
});
return _dbReady;
}

async function getDbReady() {
if (!_dbReady) {
initDB();
}
return _dbReady;
}

async function dbPut(storeName, value, key = null) {
if (!_db) await getDbReady();
return new Promise((resolve) => {
if (!_db) {
resolve(false);
return;
}
try {
const tx = _db.transaction(storeName, 'readwrite');
const store = tx.objectStore(storeName);
const request = key ? store.put(value, key) : store.put(value);

tx.oncomplete = () => resolve(true);

tx.onerror = (evt) => {
const error = tx.error || evt.target.error;
console.warn(`[DB] Transaction error putting to ${storeName}:`, error);
if (
error &&
(error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
) {
if (typeof emit === 'function') emit('storage:quota_exceeded');
}
resolve(false);
};

tx.onabort = (evt) => {
const error = tx.error || evt.target.error;
console.warn(`[DB] Transaction abort putting to ${storeName}:`, error);
resolve(false);
};

request.onerror = (err) => {
console.warn(`[DB] Request error putting to ${storeName}:`, err);
};
} catch (e) {
console.warn('[DB] DB Transaction failed:', e);
resolve(false);
}
});
}

async function dbGetAll(storeName) {
if (!_db) await getDbReady();
return new Promise((resolve) => {
if (!_db) {
resolve([]);
return;
}
try {
const tx = _db.transaction(storeName, 'readonly');
const store = tx.objectStore(storeName);
const request = store.getAll();
request.onsuccess = () => resolve(request.result || []);
request.onerror = () => resolve([]);
} catch (e) {
console.warn('[DB] dbGetAll failed:', e);
resolve([]);
}
});
}

async function dbGet(storeName, key) {
if (!_db) await getDbReady();
return new Promise((resolve) => {
if (!_db) {
resolve(null);
return;
}
try {
const tx = _db.transaction(storeName, 'readonly');
const store = tx.objectStore(storeName);
const request = store.get(key);
request.onsuccess = () => resolve(request.result || null);
request.onerror = () => resolve(null);
} catch (e) {
console.warn('[DB] dbGet failed:', e);
resolve(null);
}
});
}

async function _loadCache() {
_problemsCache = await dbGetAll(STORE_PROBLEMS);
_reportsCache = await dbGetAll(STORE_REPORTS);

console.log(
`[DB] Caches loaded. Problems: ${_problemsCache.length}, Reports: ${_reportsCache.length}`
);
}

function pluginSave(key, data) {
return dbPut(STORE_PLUGIN_DATA, data, key);
}

function pluginLoad(key) {
return dbGet(STORE_PLUGIN_DATA, key);
}

async function pluginRemove(key) {
if (!_db) await getDbReady();
if (!_db) return false;
return new Promise((resolve) => {
try {
const tx = _db.transaction(STORE_PLUGIN_DATA, 'readwrite');
const store = tx.objectStore(STORE_PLUGIN_DATA);
const request = store.delete(key);

tx.oncomplete = () => resolve(true);

tx.onerror = (evt) => {
const error = tx.error || evt.target.error;
console.warn('[DB] pluginRemove transaction error:', error);
resolve(false);
};

tx.onabort = () => resolve(false);

request.onerror = () => resolve(false);
} catch (e) {
console.warn('[DB] pluginRemove failed:', e);
resolve(false);
}
});
}

/** 获取当前 LocalStorage 使用状况 */
function getStorageUsage() {
let total = 0;
try {
for (const x in localStorage) {
if (Object.prototype.hasOwnProperty.call(localStorage, x)) {
total += localStorage[x].length * 2;
}
}
} catch (e) {
console.warn('Get storage usage failed:', e);
}
return {
usedBytes: total,
usedMB: (total / (1024 * 1024)).toFixed(2),
percent: Math.min(100, (total / (5 * 1024 * 1024)) * 100)
};
}

function autoSave() {
clearTimeout(_autoSaveTimer);

const savedAtPid = _activeProblemId;
const capturedTree = tree ? JSON.parse(JSON.stringify(tree)) : null;
const capturedNextId = nextId;
const capturedStmt = problemStatement;
const capturedCtx = problemContext;
const capturedValidation = causalValidationResults
? JSON.parse(JSON.stringify(causalValidationResults))
: {};
const capturedRootCauses = consolidatedRootCauses
? JSON.parse(JSON.stringify(consolidatedRootCauses))
: null;
const capturedStartTime = analysisStartTime;

const currentGen = ++window.Store._saveGeneration;

_autoSaveTimer = setTimeout(async () => {
if (currentGen !== window.Store._saveGeneration) {
console.log('[autoSave] Cancelled because of new generation');
return;
}
if (!capturedTree) return;

if (!savedAtPid) return;

const problems = getProblemList();
const p = problems.find((p) => p.id === savedAtPid);
if (!p) return;
if (p._fromExample) return;

const activeState = {
version: SCHEMA_VERSION,
tree: capturedTree,
nextId: capturedNextId,
problemStatement: capturedStmt,
problemContext: capturedCtx,
causalValidationResults: capturedValidation,
consolidatedRootCauses: capturedRootCauses,
analysisStartTime: capturedStartTime,
savedAt: new Date().toISOString()
};
if (currentGen !== window.Store._saveGeneration) return;
_activeStateCache = activeState;
const key = 'qa-5why-data-' + savedAtPid;

const saveOk = await pluginSave(key, activeState);
if (saveOk === false) {
console.warn('[autoSave] pluginSave failed — skipping problem list update');
_setSaveDone((_getActiveToolLabel() || '5Whys') + ' 保存失败');
return;
}

if (savedAtPid) {

const problems = getProblemList();
const index = problems.findIndex((p) => p.id === savedAtPid);
if (index >= 0) {
const snap = problems[index].snapshot || {};
problems[index].snapshot = {
...snap,
version: SCHEMA_VERSION,
tree: capturedTree,
nextId: capturedNextId,
causalValidationResults: capturedValidation,
consolidatedRootCauses: capturedRootCauses,
analysisStartTime: capturedStartTime,
problemStatement: capturedStmt,
problemContext: capturedCtx,
exportedAt: new Date().toISOString()
};
const counts = calculateCountsFromSnapshot(problems[index].snapshot);
problems[index].nodeCount = counts.nodeCount;
problems[index].rootCauseCount = counts.rootCauseCount;
await saveProblemList(problems);
}
}

_setSaveDone((_getActiveToolLabel() || '5Whys') + ' 已保存');
}, 300);
}

function _getActiveToolLabel() {
const activeTool = document.querySelector('.tool-panel:not(.hidden)')?.id;
if (activeTool === 'tool-fishbone') return '鱼骨图';
if (activeTool === 'tool-fta') return 'FTA';
if (activeTool === 'tool-5why') return '5Whys';
return null;
}

function autoRestore() {
try {
const state = _activeStateCache;
if (!state) return false;

if (state.version && state.version > SCHEMA_VERSION) {
console.warn('[Store] 数据版本', state.version, '高于当前版本', SCHEMA_VERSION, '，已忽略');
return false;
}
if (!state.tree) return false;
tree = state.tree;
nextId = state.nextId || 1;
problemStatement = state.problemStatement || '';
problemContext = state.problemContext || '';
causalValidationResults = state.causalValidationResults || {};
consolidatedRootCauses = state.consolidatedRootCauses || null;
analysisStartTime = state.analysisStartTime || null;
rebuildNodeIndex();
return true;
} catch (e) {
console.warn('AutoRestore failed:', e);
return false;
}
}

async function clearSavedAnalysis(problemId = _activeProblemId) {
_activeStateCache = null;
const key = problemId ? 'qa-5why-data-' + problemId : 'qa-5why-data';

const ok = await pluginRemove(key);
nodeIndex.clear();
return ok;
}

window.FiveWhys = {
async init() {
await this.load();
this.bindEvents();
},

async load() {
try {
const key = _activeProblemId ? 'qa-5why-data-' + _activeProblemId : 'qa-5why-data';
_activeStateCache = await pluginLoad(key);

if (!_activeStateCache && _activeProblemId) {
const baseData = await pluginLoad('qa-5why-data');
if (baseData) {
await pluginSave(key, baseData);
await pluginRemove('qa-5why-data');
}
}
autoRestore();
} catch (e) {
console.warn('[FiveWhys] load failed:', e);
}
},

bindEvents() {
const panel = document.getElementById('tool-5why');
if (!panel) return;
panel.addEventListener('toolpanel:show', () => {
const activePid =
typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
if (activePid) {
const problem =
typeof window.getProblemById === 'function' ? window.getProblemById(activePid) : null;
if (problem) {

if (!tree || !tree.children || tree.children.length === 0) {
const hasTreeData =
problem.snapshot?.tree &&
problem.snapshot.tree.children &&
problem.snapshot.tree.children.length > 0;
if (!hasTreeData) {
tree = null;
nextId = 1;
problemStatement = '';
problemContext = '';
causalValidationResults = {};
consolidatedRootCauses = null;
}
}
}
}
if (tree) renderTree();

const hasTree =
tree && tree.children && Array.isArray(tree.children) && tree.children.length > 0;
const problemSection = document.getElementById('problemSection');
const workspaceSection = document.getElementById('workspaceSection');
if (hasTree) {
if (problemSection) problemSection.classList.add('hidden');
if (workspaceSection) workspaceSection.classList.remove('hidden');
if (typeof window.updateProblemSummaryUI === 'function') {
const activePid =
typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
if (activePid) window.updateProblemSummaryUI(activePid);
}
} else if (typeof window.navigateToStep === 'function') {
window.navigateToStep('problem');
}
});
},

clear() {
touchMany(
{
tree: null,
nextId: 1,
problemStatement: '',
problemContext: '',
reportMarkdown: '',
cachedReport: null,
cachedTreeHash: '',
analysisStartTime: null,
causalValidationResults: {},
consolidatedRootCauses: null
},
'clear'
);
const titleEl = document.getElementById('analysisProblemTitle');
if (titleEl) titleEl.value = '';
const stmtEl = document.getElementById('problemStatement');
if (stmtEl) stmtEl.value = '';
const ctxEl = document.getElementById('problemContext');
if (ctxEl) ctxEl.value = '';
if (typeof renderTree === 'function') renderTree();
}
};

/** Collect plugin module data (fishbone, FTA) */
function collectPluginData() {

if (
typeof window.isActiveProblemExample === 'function' &&
window.isActiveProblemExample()
) {
return {};
}
const data = {};
if (window.Fishbone && window.Fishbone.fishboneData != null) {
data.fishboneData = window.Fishbone.fishboneData;
}
if (window.FTA && typeof window.FTA.getData === 'function') {
data.ftaData = window.FTA.getData() || null;
}
return data;
}

function exportSnapshot(exportType = 'full') {
if (!tree) return '没有可导出的分析数据';

const baseState = {
version: SCHEMA_VERSION,
exportedAt: new Date().toISOString(),
exportType,
problemStatement,
problemContext,
tree,
nextId,
analysisStartTime,
causalValidationResults
};

let state = { ...baseState };

if (exportType === 'full' || exportType === 'withReport') {

state = {
...state,
reportMarkdown: reportMarkdown || '',
cachedReport: cachedReport || '',
cachedTreeHash: cachedTreeHash || ''
};
}

const activeProblemId = getActiveProblemId();
if (activeProblemId) {
state.aiResults = getAIResults(activeProblemId);
}

if (exportType === 'full' || exportType === 'withFishbone') {
Object.assign(state, collectPluginData());
}

const _allNodes = collectAllNodes(tree);
state.meta = {
nodeCount: _allNodes.length,
rootCauseCount: _allNodes.filter((n) => n.isRootCause).length,
hasReport: !!(reportMarkdown || cachedReport),
hasFishbone: !!window.Fishbone?.fishboneData?.problem,
hasFta: !!(window.FTA && window.FTA.getData().rootId)
};

const jsonStr = JSON.stringify(state, null, 2);
const filename = `snapshot-${problemStatement
.slice(0, 20)
.replace(/[^\w\u4e00-\u9fff]/g, '-')
.replace(/-+/g, '-')
.replace(/^-|-$/g, '')}-${new Date().toISOString().slice(0, 10)}.json`;

if (navigator.share && navigator.canShare) {
const file = new File([jsonStr], filename, { type: 'application/json' });
if (navigator.canShare({ files: [file] })) {
navigator.share({ files: [file], title: '分析数据快照' }).catch(() => {});
return null;
}
}

const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
window.UIUtils.saveExportBlob(blob, filename, {
filterName: 'JSON 文件',
extensions: ['json'],
successMessage: '分析数据已导出'
});
return null;
}

function validateTree(node, visited = new Set(), depth = 0) {
if (depth > 100) throw new Error('树结构过深（可能存在循环引用）');
if (!node || typeof node !== 'object') throw new Error('无效的节点结构');
if (visited.has(node.id)) throw new Error('重复的节点 ID: ' + node.id);

visited.add(node.id);

if (typeof node.id !== 'number') throw new Error('节点 ID 必须是数字');
if (!Array.isArray(node.children)) throw new Error('节点 children 必须是数组');

for (const child of node.children) {
validateTree(child, visited, depth + 1);
}
return true;
}

/** 浅层校验 fishboneData 结构，避免恶意/损坏 JSON 写入插件态 */
function _isValidFishboneData(d) {
if (typeof d !== 'object' || d === null) return false;

if (typeof d.categories !== 'object' || d.categories === null) return false;

if (
d.metadata &&
d.metadata.mainCategories != null &&
!Array.isArray(d.metadata.mainCategories)
) {
return false;
}
return true;
}

/** 浅层校验 ftaData 结构 */
function _isValidFtaData(d) {
if (typeof d !== 'object' || d === null) return false;

if (d.rootId != null && typeof d.rootId !== 'string') return false;

if (typeof d.nodes !== 'object' || d.nodes === null) return false;

if (typeof d.topEvent !== 'object' || d.topEvent === null) return false;
if (typeof d.topEvent.name !== 'string') return false;
return true;
}

function restorePlugins(state, version) {

void version;
if (state.fishboneData && window.Fishbone) {
if (!_isValidFishboneData(state.fishboneData)) {
console.warn('[Import] 跳过 fishboneData：结构校验不通过');
} else {
window.Fishbone.fishboneData = state.fishboneData;
if (typeof window.Fishbone.renderFishboneForm === 'function') {
window.Fishbone.renderFishboneForm();
}
if (typeof window.Fishbone.renderFishboneSVG === 'function') {
window.Fishbone.renderFishboneSVG();
}
}
}

if (state.ftaData && window.FTA) {
if (!_isValidFtaData(state.ftaData)) {
console.warn('[Import] 跳过 ftaData：结构校验不通过');
} else {
try {
if (typeof window.FTA.importData === 'function') {

const _r = window.FTA.importData(state.ftaData);
if (_r && typeof _r.catch === 'function') {
_r.catch((ftaErr) => console.warn('FTA importData failed:', ftaErr));
}
}
window.FTA.load();
} catch (ftaErr) {
console.warn('FTA 数据恢复失败:', ftaErr);
}
}
}
}

function importSnapshot(file, callback) {
const reader = new FileReader();
reader.onload = (e) => {
try {
const state = JSON.parse(e.target.result);
if (!state.tree) throw new Error('无效的快照文件：缺少 tree 字段');

const version = state.version || 1;
console.log(`[Import] 导入 v${version} 格式快照`);

validateTree(state.tree);

if (typeof state.nextId !== 'number' || state.nextId < 1) {
throw new Error('无效的 nextId');
}
if (state.problemStatement != null && typeof state.problemStatement !== 'string') {
throw new Error('problemStatement 必须是字符串');
}
if (
state.causalValidationResults != null &&
typeof state.causalValidationResults !== 'object'
) {
throw new Error('causalValidationResults 格式无效');
}
if (state.aiResults != null && !Array.isArray(state.aiResults)) {
throw new Error('aiResults 格式无效');
}

touchMany(
{
tree: state.tree,
nextId: state.nextId || 1,
problemStatement: state.problemStatement || '',
problemContext: state.problemContext || '',
causalValidationResults: state.causalValidationResults || {},
analysisStartTime: state.analysisStartTime || null,
reportMarkdown: version >= 2 && state.reportMarkdown ? state.reportMarkdown : '',
cachedReport: version >= 2 && state.cachedReport ? state.cachedReport : null,
cachedTreeHash: version >= 2 && state.cachedTreeHash ? state.cachedTreeHash : ''
},
'importSnapshot'
);

rebuildNodeIndex();

restorePlugins(state, version);

const activeProblemId = getActiveProblemId();
if (activeProblemId && Array.isArray(state.aiResults)) {
updateProblem(activeProblemId, {
aiResults: normalizeAIResults(state.aiResults, activeProblemId)
});
}

if (callback) callback(state, null);
} catch (err) {
if (callback) callback(null, err);
}
};
reader.readAsText(file);
}

function createNode(text = '', parentId = null, level = 1) {
const node = {
id: nextId++,
parentId,
level,
text,
evidence: [],
weight: 100,
isRootCause: false,
children: []
};
nodeIndex.set(node.id, node);
return node;
}

function rebuildNodeIndex() {
nodeIndex.clear();
if (!tree) return;
const stack = [tree];
while (stack.length) {
const n = stack.pop();
nodeIndex.set(n.id, n);
if (n.children) {
for (const c of n.children) stack.push(c);
}
}
}

function findNode(node, id) {
if (!node) return null;
if (node.id === id) return node;
if (!node.children) return null;
for (const child of node.children) {
const found = findNode(child, id);
if (found) return found;
}
return null;
}

function collectAllNodes(node, list = []) {
if (!node) return list;
list.push(node);
if (node.children) {
for (const child of node.children) collectAllNodes(child, list);
}
return list;
}

/**
* 计算快照中的节点数和根因数（支持 5 Whys, 鱼骨图, FTA）
* @param {Object} snapshot 快照对象
* @returns {Object} { nodeCount, rootCauseCount }
*/
function calculateCountsFromSnapshot(snapshot) {
if (!snapshot) return { nodeCount: 0, rootCauseCount: 0 };

let maxNodeCount = 0;
let associatedRootCauseCount = 0;

if (snapshot.tree) {

let treeNodeCount = 0;
let treeRootCauseCount = 0;

const traverse = function (node) {
if (!node) return;
treeNodeCount++;
if (node.isRootCause) treeRootCauseCount++;
if (node.children) {
for (const child of node.children) traverse(child);
}
};

traverse(snapshot.tree);

const isTreeEmpty =
treeNodeCount === 1 && (!snapshot.tree.text || snapshot.tree.text.trim() === '');
const finalTreeNodeCount = isTreeEmpty ? 0 : treeNodeCount;

if (finalTreeNodeCount > maxNodeCount) {
maxNodeCount = finalTreeNodeCount;
associatedRootCauseCount = treeRootCauseCount;
}
}

if (snapshot.fishboneData && snapshot.fishboneData.categories) {
let fbNodeCount = 0;
Object.values(snapshot.fishboneData.categories).forEach((causes) => {
if (Array.isArray(causes)) {
causes.forEach((cause) => {
if (cause.text) {
fbNodeCount += 1;
if (cause.subCauses && Array.isArray(cause.subCauses)) {
fbNodeCount += cause.subCauses.length;
}
}
});
}
});
if (fbNodeCount > maxNodeCount) {
maxNodeCount = fbNodeCount;
associatedRootCauseCount = 0;
}
}

if (snapshot.ftaData && snapshot.ftaData.nodes) {
const ftaNodeCount = Object.keys(snapshot.ftaData.nodes).length;
const ftaRootCauseCount = Object.values(snapshot.ftaData.nodes).filter(
(n) => n.status === 'confirmed'
).length;
if (ftaNodeCount > maxNodeCount) {
maxNodeCount = ftaNodeCount;
associatedRootCauseCount = ftaRootCauseCount;
}
}

return {
nodeCount: maxNodeCount,
rootCauseCount: associatedRootCauseCount
};
}

function removeFromTree(targetId) {
const target = nodeIndex.get(targetId);
if (!target || !target.parentId) return false;
const parent = nodeIndex.get(target.parentId);
if (!parent || !parent.children) return false;
const idx = parent.children.findIndex((c) => c.id === targetId);
if (idx === -1) return false;
parent.children.splice(idx, 1);
_removeFromIndex(target);
return true;
}

function _removeFromIndex(node) {
nodeIndex.delete(node.id);
if (node.children) {
for (const c of node.children) _removeFromIndex(c);
}
}

let _syncNodeCountTimer = null;
function syncActiveProblemNodeCount() {
const targetPid = _activeProblemId;
if (!targetPid) return;
clearTimeout(_syncNodeCountTimer);
_syncNodeCountTimer = setTimeout(() => {
if (getActiveProblemId() !== targetPid) return;
const allNodes = collectAllNodes(tree);
updateProblem(targetPid, {
nodeCount: allNodes.length,
rootCauseCount: allNodes.filter((n) => n.isRootCause).length
});
}, 300);
}

function addTreeNode(parentId, text = '') {
const parent = nodeIndex.get(parentId);
if (!parent) return null;
const child = createNode(text, parentId, parent.level + 1);
parent.children.push(child);
touch({ tree }, 'addTreeNode');
syncActiveProblemNodeCount();
return child;
}

function addBulkTreeNodes(parentId, texts) {
const parent = nodeIndex.get(parentId);
if (!parent || !Array.isArray(texts)) return 0;
let count = 0;
for (const text of texts) {
const t = (text || '').trim();
if (!t) continue;
const child = createNode(t, parentId, parent.level + 1);
parent.children.push(child);
count++;
}
if (count > 0) {
touch({ tree }, 'addBulkTreeNodes');
syncActiveProblemNodeCount();
}
return count;
}

function removeTreeNode(nodeId) {
const target = nodeIndex.get(nodeId);
const wasRootCause = target && target.isRootCause;
const success = removeFromTree(nodeId);
if (success) {
touch({ tree }, 'removeTreeNode');
syncActiveProblemNodeCount();

if (wasRootCause && consolidatedRootCauses) {
touch({ consolidatedRootCauses: null }, 'removeTreeNode');
}
}
return success;
}

function updateTreeNodeText(nodeId, text) {
const node = nodeIndex.get(nodeId);
if (node) {
node.text = (text || '').trim();
touch({ tree }, 'updateTreeNodeText');

if (node.parentId === null && _activeProblemId) {
const problem = getProblemById(_activeProblemId);
if (problem) {
updateProblem(_activeProblemId, {
problemStatement: node.text,
title: node.text.slice(0, 50) || problem.title
});
}
}

return true;
}
return false;
}

function updateTreeNodeWeight(nodeId, weight) {
const node = nodeIndex.get(nodeId);
if (node) {
node.weight = parseInt(weight) || 0;
touch({ tree }, 'updateTreeNodeWeight');
return true;
}
return false;
}

function setTreeNodeRootCause(nodeId, isRootCause) {
const node = nodeIndex.get(nodeId);
if (node && node.parentId !== null) {
node.isRootCause = !!isRootCause;
touch({ tree }, 'setTreeNodeRootCause');
syncActiveProblemNodeCount();
return true;
}
return false;
}

function addTreeNodeEvidence(nodeId, evidenceText) {
const node = nodeIndex.get(nodeId);
if (node && evidenceText && evidenceText.trim()) {
node.evidence.push(evidenceText.trim());
touch({ tree }, 'addTreeNodeEvidence');
return true;
}
return false;
}

function repairTruncatedJSON(str) {
try {
let s = str;

let inString = false;
for (let i = 0; i < s.length; i++) {
if (s[i] === '\\' && inString) {
i++;
continue;
}
if (s[i] === '"') inString = !inString;
}

if (inString) {

for (let i = s.length - 1; i >= 0; i--) {
if (s[i] === '"') {
let backslashCount = 0;
for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) backslashCount++;
if (backslashCount % 2 === 0) {
s = s.slice(0, i);
break;
}
}
}
}

s = s.replace(/,\s*$/, '').replace(/:\s*$/, ': null');

const stack = [];
inString = false;
for (let i = 0; i < s.length; i++) {
if (s[i] === '\\' && inString) {
i++;
continue;
}
if (s[i] === '"') {
inString = !inString;
continue;
}
if (inString) continue;
if (s[i] === '{') stack.push('}');
else if (s[i] === '[') stack.push(']');
else if (s[i] === '}' || s[i] === ']') stack.pop();
}

while (stack.length > 0) s += stack.pop();

const parsed = JSON.parse(s);

if (parsed && parsed.tree) _validateRepairedTree(parsed.tree);
return parsed;
} catch (e) {
return null;
}
}

function _validateRepairedTree(node) {
if (!node || typeof node !== 'object') return;
if (!Array.isArray(node.children)) node.children = [];
for (const child of node.children) _validateRepairedTree(child);
}

/**
* 获取所有报告
* @returns {Array} 报告列表
*/
function getReportLibrary() {
return _reportsCache || [];
}

function nextReportVersion(currentVersion, isRegenerate = false) {
if (!currentVersion) return 'v1.0.0';
const match = currentVersion.match(/^v(\d+)\.(\d+)\.(\d+)$/);
if (!match) return 'v1.0.0';
const major = parseInt(match[1]);
let minor = parseInt(match[2]);
let patch = parseInt(match[3]);
if (isRegenerate) {
minor += 1;
patch = 0;
} else {
patch += 1;
}
return `v${major}.${minor}.${patch}`;
}

/**
* 保存报告到报告库
* @param {string} reportContent - 报告Markdown内容
* @param {object} options - 附加选项 { title, snapshotId, isRegenerate }
* @returns {object} 保存的报告对象
*/
async function saveReportToLibrary(reportContent, options = {}) {
try {
const reports = getReportLibrary();
const now = new Date().toISOString();
const hasOption = (key) => Object.prototype.hasOwnProperty.call(options, key);

const analysisType = options.analysisType || '5why';

const problemId = options.problemId || getActiveProblemId() || '';
const nodeCount = options.nodeCount != null ? options.nodeCount : 0;
const rootCauseCount = options.rootCauseCount != null ? options.rootCauseCount : 0;

let problemDisplayId = '';
if (problemId) {
const p = getProblemById(problemId);
if (p) problemDisplayId = p.displayId || '';
}

const existingIdx = problemId
? reports.findIndex((r) => r.problemId === problemId && r.analysisType === analysisType)
: -1;

let version = 'v1.0.0';
if (existingIdx >= 0) {
const oldVersion = reports[existingIdx].version || 'v1.0.0';
version = nextReportVersion(oldVersion, options.isRegenerate);
}

const dateStr = now.slice(0, 10).replace(/-/g, '');
const todayReportPrefix = 'R' + dateStr + '-';
const todayReports = reports.filter(
(r) => r.displayId && r.displayId.startsWith(todayReportPrefix)
);
const todayReportNums = todayReports
.map((r) => parseInt(r.displayId.slice(todayReportPrefix.length), 10))
.filter((n) => !isNaN(n));
const reportNum =
existingIdx >= 0
? reports[existingIdx].displayId || ''
: todayReportPrefix + String((todayReportNums.length > 0 ? Math.max(...todayReportNums) : 0) + 1).padStart(3, '0');

let versions = [];
if (existingIdx >= 0 && reports[existingIdx].versions) {
versions = [...reports[existingIdx].versions];
}

if (existingIdx >= 0) {
const old = reports[existingIdx];
versions.unshift({
version: old.version || 'v0.0.0',
content: old.content,
treeHash: old.treeHash || '',
createdAt: old.createdAt,
savedAt: old.updatedAt || old.createdAt,
schemaVersion: old.schemaVersion || 1,
problemSnapshot: old.problemSnapshot || null,
generation: old.generation || null,
fishboneSvgHtml: old.fishboneSvgHtml || '',
ftaSvgHtml: old.ftaSvgHtml || '',
nodeCount: old.nodeCount || 0,
rootCauseCount: old.rootCauseCount || 0
});

if (versions.length > 10) versions = versions.slice(0, 10);
}

const existingReport = existingIdx >= 0 ? reports[existingIdx] : null;
const fishboneSvgHtml = hasOption('fishboneSvgHtml')
? options.fishboneSvgHtml || ''
: existingReport?.fishboneSvgHtml || '';
const ftaSvgHtml = hasOption('ftaSvgHtml')
? options.ftaSvgHtml || ''
: existingReport?.ftaSvgHtml || '';
const problemSnapshot = hasOption('problemSnapshot')
? options.problemSnapshot
: {
displayId: problemDisplayId,
title: options.problemTitle || (problemId && getProblemById(problemId)?.title) || '',
statement: options.problemStatement || problemStatement || ''
};
const sourceMode = options.sourceMode || 'unknown';
const generation = {
sourceMode,
generatedAt: options.generatedAt || now,
model: options.model || (sourceMode === 'ai' && typeof getActiveModel === 'function' ? getActiveModel() : ''),
inputSnapshotHash: options.treeHash || ''
};
const report = {
id: existingReport
? existingReport.id
: 'report_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
displayId: reportNum,
title:
options.title ||
(existingReport ? existingReport.title : '') ||
options.problemStatement ||
problemStatement ||
'未命名报告',
problemId: problemId,
problemDisplayId: problemDisplayId,
problemStatement:
options.problemStatement ||
(existingReport ? existingReport.problemStatement : '') ||
problemStatement ||
'',
analysisType: analysisType,
content: reportContent,
schemaVersion: 2,
problemSnapshot: problemSnapshot,
generation: generation,
version: version,
versions: versions,
snapshotId: options.snapshotId || (existingReport ? existingReport.snapshotId : null),
treeHash:
options.treeHash || (existingReport ? existingReport.treeHash : '') || cachedTreeHash || '',
fishboneSvgHtml: fishboneSvgHtml,
ftaSvgHtml: ftaSvgHtml,
nodeCount: nodeCount,
rootCauseCount: rootCauseCount,
createdAt: existingReport ? existingReport.createdAt : now,
updatedAt: now
};

if (existingIdx >= 0) {
reports[existingIdx] = report;
} else {
reports.unshift(report);
}

const saveOk = await saveReportList(reports);
if (saveOk === false) {
showToast('报告保存失败（存储空间不足或数据库不可用）', 'error');
return null;
}
if (problemId) {
updateProblem(problemId, { status: 'completed' });
}
if (sourceMode === 'ai') {
await linkLatestAIResultToReport({
problemId,
reportId: report.id,
tool: analysisType === 'assessment' ? 'problem' : analysisType
});
}
showToast('报告已保存到报告库 (版本 ' + version + ')', 'success');
return report;
} catch (e) {
console.warn('Save report failed:', e);
showToast('保存报告失败: ' + e.message, 'error');
return null;
}
}

/** 批量保存报告列表（原子事务）
*  Cache 同步突变以支持紧接的同步读取；事务失败时回滚 cache 到调用前状态，
*  防止内存与 IDB 不一致导致下次 reload 数据丢失（P1-16）。 */
function saveReportList(reports) {
const prevCache = _reportsCache;
_reportsCache = reports;
return new Promise((resolve) => {
if (!_db) {
resolve(false);
return;
}
try {
const tx = _db.transaction(STORE_REPORTS, 'readwrite');
const store = tx.objectStore(STORE_REPORTS);
store.clear();
for (const rep of reports) {
if (rep && rep.id) store.put(rep);
}
tx.oncomplete = () => {
_broadcastDbUpdate();
if (typeof emit === 'function') emit('reports:changed', { reports: _reportsCache });
resolve(true);
};
tx.onerror = (evt) => {
const error = tx.error || evt.target.error;
console.warn('saveReportList transaction error:', error);
_reportsCache = prevCache;
if (
error &&
(error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
) {
if (typeof emit === 'function') emit('storage:quota_exceeded');
}
resolve(false);
};
tx.onabort = () => {
_reportsCache = prevCache;
resolve(false);
};
} catch (e) {
console.warn('saveReportList failed:', e);
_reportsCache = prevCache;
resolve(false);
}
});
}

function _aiResultsAfterAnalysisClear(problem, analysisType) {
const records = Array.isArray(problem?.aiResults) ? problem.aiResults : [];
return records.filter((record) => {
if (analysisType === 'assessment') {
return !(
record?.tool === 'problem' &&
(/评估/.test(record.title || '') || /评估/.test(record.action || ''))
);
}
return record?.tool !== analysisType;
});
}

async function _clearPluginAnalysisFromReport(options) {
const { pid, analysisType, snapshotKey, storageKey, api, label } = options;
if (getActiveProblemId() === pid && typeof api?.clear === 'function') {
await api.clear();
}

const problem = getProblemById(pid);
let snapshotOk = true;
if (problem) {
const snapshot = JSON.parse(
JSON.stringify(problem.snapshot || { version: SCHEMA_VERSION })
);
snapshot[snapshotKey] = null;
const analyses = JSON.parse(JSON.stringify(problem.analyses || {}));
analyses[analysisType] = {
...(analyses[analysisType] || {}),
status: 'not_started',
lastUpdated: new Date().toISOString()
};
snapshotOk = await updateProblem(pid, {
snapshot,
analyses,
aiResults: _aiResultsAfterAnalysisClear(problem, analysisType)
});
}

const pluginOk = await pluginRemove(storageKey);
if (snapshotOk === false || pluginOk === false) {
throw new Error('关联的' + label + '分析数据未能完全清除');
}
}

/**
* 从报告库删除报告
* @param {string} reportId - 报告ID
* @param {Object} [options] - 可选参数
* @param {boolean} [options.clearRelatedAnalysis] - 同时清理关联的分析数据
* @returns {Promise<boolean>} 是否成功（await IDB 事务提交后 resolve）
*/
async function deleteReportFromLibrary(reportId, options = {}) {
try {
const target = getReportById(reportId);
let reports = getReportLibrary();
reports = reports.filter((r) => r.id !== reportId);
const ok = await saveReportList(reports);
if (!ok) {
showToast('删除报告失败：写入数据库未成功，请重试', 'error');
return false;
}
if (target && target.problemId) {
const pendingLink = window.Store._pendingAIReportLinks[target.problemId];
if (pendingLink?.reportId === target.id) {
delete window.Store._pendingAIReportLinks[target.problemId];
}
const remaining = reports.filter((r) => r.problemId === target.problemId);
if (remaining.length === 0) {
await updateProblem(target.problemId, { status: 'analyzing' });
}
if (options.clearRelatedAnalysis) {
const pid = target.problemId;
if (target.analysisType === 'assessment') {
const problem = getProblemById(pid);
if (problem) {
const analyses = JSON.parse(JSON.stringify(problem.analyses || {}));
analyses.assessment = {
...(analyses.assessment || {}),
status: 'not_started',
lastUpdated: new Date().toISOString()
};
const updates = {
analyses,
aiResults: _aiResultsAfterAnalysisClear(problem, 'assessment')
};
if (problem.details && problem.details.assessment) {
const details = { ...problem.details };
delete details.assessment;
updates.details = details;
}
if (problem.snapshot && problem.snapshot.details && problem.snapshot.details.assessment) {
const snapshot = JSON.parse(JSON.stringify(problem.snapshot));
if (snapshot.details) delete snapshot.details.assessment;
updates.snapshot = snapshot;
}
if (getActiveProblemId() === pid && typeof window.ProblemManager?.load === 'function') {
window.ProblemManager.load(updates.details || problem.details || {});
}
const assessmentOk = await updateProblem(pid, updates);
if (assessmentOk === false) {
throw new Error('关联的问题评估数据未能完全清除');
}
}
} else if (target.analysisType === '5why') {

const problem = getProblemById(pid);
let snapshotOk = true;
if (problem) {
const snapshot = JSON.parse(JSON.stringify(problem.snapshot || { version: SCHEMA_VERSION }));
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
snapshotOk = await updateProblem(pid, {
snapshot,
analyses,
aiResults: _aiResultsAfterAnalysisClear(problem, '5why')
});
}
const pluginOk = await pluginRemove('qa-5why-data-' + pid);
if (getActiveProblemId() === pid) {
window.flushAutoSave?.();
window.FiveWhys?.clear?.();
_activeStateCache = null;
nodeIndex.clear();
}
if (snapshotOk === false || pluginOk === false) {
throw new Error('关联的 5 Whys 分析数据未能完全清除');
}
} else if (target.analysisType === 'fishbone') {
await _clearPluginAnalysisFromReport({
pid,
analysisType: 'fishbone',
snapshotKey: 'fishboneData',
storageKey: 'qa-fishbone-' + pid,
api: window.Fishbone,
label: '鱼骨图'
});
} else if (target.analysisType === 'fta') {
await _clearPluginAnalysisFromReport({
pid,
analysisType: 'fta',
snapshotKey: 'ftaData',
storageKey: 'qa-fta-' + pid,
api: window.FTA,
label: '故障树'
});
}
}
}
showToast('报告已删除', 'success');
return true;
} catch (e) {
console.warn('Delete report failed:', e);
showToast('删除报告失败: ' + e.message, 'error');
return false;
}
}

/**
* 获取单个报告
* @param {string} reportId - 报告ID
* @returns {object|null} 报告对象
*/
function getReportById(reportId) {
const reports = getReportLibrary();
return reports.find((r) => r.id === reportId) || null;
}

/**
* 获取所有问题列表
* @returns {Array} 问题列表
*/
function getProblemList() {
return _problemsCache || [];
}

/**
* 保存问题列表
*  Cache 同步突变以支持紧接的同步读取（如 createNewProblem 返回后立即
*  showProblemDetail → getProblemById）；事务失败时回滚 cache 到调用前
*  状态，防止内存与 IDB 不一致导致下次 reload 数据丢失（P1-16）。
* @param {Array} problems - 问题列表
*/
function saveProblemList(problems) {
const prevCache = _problemsCache;
_problemsCache = problems;
return new Promise((resolve) => {
if (!_db) {
getDbReady().then(() => {
if (!_db) { resolve(false); return; }
_doSaveProblemList(resolve, prevCache, problems);
}).catch(() => resolve(false));
return;
}
_doSaveProblemList(resolve, prevCache, problems);
});
}

function _doSaveProblemList(resolve, prevCache, problems) {
try {
const tx = _db.transaction(STORE_PROBLEMS, 'readwrite');
const store = tx.objectStore(STORE_PROBLEMS);
store.clear();
for (const prob of problems) {
if (prob && prob.id) store.put(prob);
}
tx.oncomplete = () => {
_broadcastDbUpdate();
resolve(true);
};
tx.onerror = (evt) => {
const error = tx.error || evt.target.error;
console.warn('Save problem list transaction error:', error);
_problemsCache = prevCache;
if (
error &&
(error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
) {
if (typeof emit === 'function') emit('storage:quota_exceeded');
}
resolve(false);
};
tx.onabort = () => {
_problemsCache = prevCache;
resolve(false);
};
} catch (e) {
console.warn('Save problem list failed:', e);
_problemsCache = prevCache;
resolve(false);
}
}

/**
* 创建新问题
* @param {Object} options - 问题选项 { title, status }
* @returns {Object} 新创建的问题对象
*/
function createNewProblem(options = {}) {
const problems = getProblemList();
const now = new Date();
const nowISO = now.toISOString();

const dateStr =
now.getFullYear().toString() +
String(now.getMonth() + 1).padStart(2, '0') +
String(now.getDate()).padStart(2, '0');
const todayPrefix = 'P' + dateStr + '-';
const todayNums = problems
.filter((p) => p.displayId && p.displayId.startsWith(todayPrefix))
.map((p) => parseInt(p.displayId.slice(todayPrefix.length), 10))
.filter((n) => !isNaN(n));
const displayId = todayPrefix + String((todayNums.length > 0 ? Math.max(...todayNums) : 0) + 1).padStart(3, '0');

const problem = {
id: 'problem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
displayId: displayId,
title: options.title !== undefined ? options.title : '',
status: options.status || 'pending',
problemStatement: '',
problemContext: '',
nodeCount: 0,
rootCauseCount: 0,
aiResults: [],
createdAt: nowISO,
updatedAt: nowISO,
snapshot: null
};

problems.unshift(problem);
saveProblemList(problems).then((ok) => {
if (ok === false) {
showToast('问题持久化失败（存储空间不足或数据库不可用），刷新后数据可能丢失', 'warning');
}
});
return problem;
}

/**
* 更新问题
* @param {String} problemId - 问题ID
* @param {Object} updates - 更新字段
* @returns {Boolean} 是否成功
*/
function updateProblem(problemId, updates) {
const problems = getProblemList();
const index = problems.findIndex((p) => p.id === problemId);
if (index === -1) return Promise.resolve(false);

const safeUpdates = { ...updates };
if (Object.prototype.hasOwnProperty.call(safeUpdates, 'aiResults')) {
safeUpdates.aiResults = normalizeAIResults(safeUpdates.aiResults, problemId);
}
const merged = {
...problems[index],
...safeUpdates,
updatedAt: new Date().toISOString()
};

if (safeUpdates.snapshot) {
const counts = calculateCountsFromSnapshot(safeUpdates.snapshot);
merged.nodeCount = counts.nodeCount;
merged.rootCauseCount = counts.rootCauseCount;
}

problems[index] = merged;
return saveProblemList(problems);
}

/**
* 导入/覆写问题（insert-or-update）
* 与 createNewProblem/updateProblem 不同，此函数用于从外部 file 导入问题：
* - 若已存在同 ID 问题则覆写，保留导入数据中的所有字段。
* - 若不存在则追加到列表末尾（不置顶，保持导入顺序语义）。
* - 通过 saveProblemList 走统一存储路径，触发配额检测等防护逻辑。
* @param {Object} problem - 完整的问题对象（必须含 id 和 createdAt）
* @returns {Promise<boolean>} 是否成功
*/
function upsertProblem(problem) {
if (!problem || !problem.id || !problem.createdAt) return Promise.resolve(false);
problem = {
...problem,
aiResults: normalizeAIResults(problem.aiResults, problem.id)
};
const problems = getProblemList();
const index = problems.findIndex((p) => p.id === problem.id);
const now = new Date().toISOString();
if (index >= 0) {
problems[index] = { ...problems[index], ...problem, updatedAt: now };
} else {
problems.push({ ...problem, updatedAt: now });
}
return saveProblemList(problems);
}

/**
* 删除问题
* @param {String} problemId - 问题ID
* @returns {Promise<Boolean>} 是否成功
*/
async function deleteProblem(problemId) {

const reports = getReportLibrary();
const filteredReports = reports.filter((r) => r.problemId !== problemId);
if (filteredReports.length < reports.length) {
const reportOk = await saveReportList(filteredReports);
if (!reportOk) return false;
}

let problems = getProblemList();
const originalLength = problems.length;
problems = problems.filter((p) => p.id !== problemId);
const problemSaveOk = await saveProblemList(problems);
if (!problemSaveOk) return false;

return problems.length < originalLength;
}

/**
* 获取单个问题
* @param {String} problemId - 问题ID
* @returns {Object|null} 问题对象
*/
function getProblemById(problemId) {
const problems = getProblemList();
return problems.find((p) => p.id === problemId) || null;
}

/**
* 保存当前分析到问题
* @param {String} problemId - 问题ID
* @param {String} title - 问题标题
*/
function saveCurrentAnalysisToProblem(problemId, title, silent = false, options = {}) {
const problems = getProblemList();
const index = problems.findIndex((p) => p.id === problemId);
if (index === -1) return false;

let details = {};
if (window.ProblemManager && typeof window.ProblemManager.getData === 'function') {
details = window.ProblemManager.getData();
} else if (window.ProblemManager && typeof window.ProblemManager.collect === 'function') {
details = window.ProblemManager.collect();
}

let formCtx = '';
if (window.ProblemManager && typeof window.ProblemManager.getProblemContext === 'function') {
formCtx = window.ProblemManager.getProblemContext();
}

const _activePid = getActiveProblemId();
const isActiveMatch = !_activePid || _activePid === problemId;
const existingSnapshot = problems[index].snapshot || {};
const isFromExample = !!problems[index]._fromExample;

const snapshot = {
version: SCHEMA_VERSION,
exportedAt: new Date().toISOString(),
problemStatement:
isActiveMatch && !isFromExample ? problemStatement : existingSnapshot.problemStatement || '',
problemContext:
isActiveMatch && !isFromExample
? problemContext || formCtx
: formCtx || existingSnapshot.problemContext || '',
details: details,
tree: isActiveMatch && !isFromExample ? tree : existingSnapshot.tree || null,
nextId: isActiveMatch && !isFromExample ? nextId : existingSnapshot.nextId || 1,
causalValidationResults:
isActiveMatch && !isFromExample
? causalValidationResults
: existingSnapshot.causalValidationResults || {},
analysisStartTime:
isActiveMatch && !isFromExample
? analysisStartTime
: existingSnapshot.analysisStartTime || null,
reportMarkdown: existingSnapshot.reportMarkdown || '',
cachedReport: existingSnapshot.cachedReport || '',
cachedTreeHash:
isActiveMatch && !isFromExample ? cachedTreeHash || '' : existingSnapshot.cachedTreeHash || ''
};

const capturePlugins = options.capturePlugins || {};
const shouldCaptureFishbone = capturePlugins.fishbone === true;
const shouldCaptureFta = capturePlugins.fta === true;
const captured =
isActiveMatch && !isFromExample && (shouldCaptureFishbone || shouldCaptureFta)
? collectPluginData()
: {};
const copyPluginSnapshot = (key, shouldCapture) => {
const source = shouldCapture && captured[key] != null ? captured[key] : existingSnapshot[key];
if (source != null) snapshot[key] = JSON.parse(JSON.stringify(source));
};
copyPluginSnapshot('fishboneData', shouldCaptureFishbone);
copyPluginSnapshot('ftaData', shouldCaptureFta);

const counts = calculateCountsFromSnapshot(snapshot);

problems[index] = {
...problems[index],
title: title !== undefined && title !== null ? title : problems[index].title,
problemStatement: isActiveMatch ? problemStatement : problems[index].problemStatement || '',
problemContext: isActiveMatch
? problemContext || formCtx
: formCtx || problems[index].problemContext || '',
details: details,
nodeCount: counts.nodeCount,
rootCauseCount: counts.rootCauseCount,
snapshot,
updatedAt: new Date().toISOString()
};

saveProblemList(problems).then((ok) => {
if (ok === false) {
showToast('分析数据持久化失败（存储空间不足或数据库不可用），刷新后数据可能丢失', 'warning');
}
});
if (!silent) {
showToast('分析已保存到问题库', 'success');
}
return true;
}

/**
* 加载问题到当前分析
* @param {String} problemId - 问题ID
* @returns {Boolean} 是否成功
*/
function loadProblemToCurrent(problemId, onLoaded) {
const problem = getProblemById(problemId);
if (!problem) return false;

if (problem._fromExample) {
updateProblem(problemId, { _fromExample: false });
}

const snapshot = problem.snapshot || {};

const currentStmt = problem.problemStatement || snapshot.problemStatement || '';
if (snapshot.tree && snapshot.tree.text !== currentStmt) {
snapshot.tree.text = currentStmt;
}

if (snapshot.tree) {
touchMany(
{
problemStatement: currentStmt,
problemContext: problem.problemContext || snapshot.problemContext || '',
tree: snapshot.tree,
nextId: snapshot.nextId || 1,
causalValidationResults: snapshot.causalValidationResults || {},
consolidatedRootCauses: snapshot.consolidatedRootCauses || null,
analysisStartTime: snapshot.analysisStartTime || null,
reportMarkdown: snapshot.reportMarkdown || '',
cachedReport: snapshot.cachedReport || null,
cachedTreeHash: snapshot.cachedTreeHash || ''
},
'loadProblem'
);
rebuildNodeIndex();
} else {

touchMany(
{
problemStatement: currentStmt,
problemContext: problem.problemContext || ''
},
'loadProblem'
);
tree = createNode(currentStmt, null, 1);
tree.parentId = null;
nextId = 2;
}

if (snapshot.details && window.ProblemManager) {
window.ProblemManager.load(snapshot.details);
} else if (problem.details && window.ProblemManager) {
window.ProblemManager.load(problem.details);
} else if (window.ProblemManager) {
window.ProblemManager.load(null);
}

let _loadPending = 0;
let _loadedCalled = false;
const _callOnLoaded = () => {
if (_loadedCalled) return;
_loadedCalled = true;
if (typeof onLoaded === 'function') onLoaded(problemId);
};

if (window.Fishbone) {
const _fbKey = problemId ? 'qa-fishbone-' + problemId : 'qa-fishbone';
if (snapshot.fishboneData) {
window.Fishbone.fishboneData = snapshot.fishboneData;

if (window.Fishbone.fishboneData && !window.Fishbone.fishboneData.problem) {
window.Fishbone.fishboneData.problem = problem.title || '';
}

if (window.Fishbone.fishboneData && !window.Fishbone.fishboneData.phenomenon) {
window.Fishbone.fishboneData.phenomenon =
problem.problemStatement || problem.details?.phenomenon || '';
}
window.Fishbone.fishboneData.importedContext = buildProblemContext(problem);
pluginSave(_fbKey, JSON.parse(JSON.stringify(window.Fishbone.fishboneData)));
} else {

_loadPending++;
pluginLoad(_fbKey)
.then((dbFb) => {

if (getActiveProblemId() !== problemId) return;

if (dbFb && window.Fishbone) {
window.Fishbone.fishboneData = dbFb;
if (!window.Fishbone.fishboneData.problem) {
window.Fishbone.fishboneData.problem = problem.title || '';
}
if (!window.Fishbone.fishboneData.phenomenon) {
window.Fishbone.fishboneData.phenomenon =
problem.problemStatement || problem.details?.phenomenon || '';
}
window.Fishbone.fishboneData.importedContext = buildProblemContext(problem);

const problems = getProblemList();
const idx = problems.findIndex((p) => p.id === problemId);
if (idx !== -1) {
problems[idx].snapshot = problems[idx].snapshot || { version: SCHEMA_VERSION };
problems[idx].snapshot.fishboneData = JSON.parse(JSON.stringify(dbFb));
saveProblemList(problems);
}
} else if (window.Fishbone) {
const emptyFb = {
problem: '',
phenomenon: '',
categories: {},
savedAt: null,
importedContext: buildProblemContext(problem)
};
window.Fishbone.CATEGORIES.forEach((cat) => {
emptyFb.categories[cat.id] = [];
});
window.Fishbone.fishboneData = emptyFb;
pluginSave(_fbKey, JSON.parse(JSON.stringify(window.Fishbone.fishboneData)));
}
_callOnLoaded();
})
.catch((e) => {
console.warn('[IDB] pluginLoad for Fishbone failed:', e);
_callOnLoaded();
});
}
}

if (window.FTA) {
if (
snapshot.ftaData &&
snapshot.ftaData.rootId &&
typeof window.FTA.importData === 'function'
) {
const ftaClone = JSON.parse(JSON.stringify(snapshot.ftaData));
ftaClone.metadata = ftaClone.metadata || {};
ftaClone.metadata.problemTitle = problem.title || '';
ftaClone.metadata.problemContext =
problem.problemStatement || problem.details?.phenomenon || '';
if (ftaClone.topEvent && !ftaClone.topEvent.name) {
ftaClone.topEvent.name = problem.title || '';
}

_loadPending++;
const _r1 = window.FTA.importData(ftaClone);
if (_r1 && typeof _r1.then === 'function') {
_r1.then(() => _callOnLoaded())
.catch((e) => {
console.warn('FTA importData failed during loadProblemToCurrent:', e);
_callOnLoaded();
});
} else {
_loadPending--;
}
} else {

if (window.FTA && typeof window.FTA.clear === 'function') {

const _r2 = window.FTA.clear();
if (_r2 && typeof _r2.catch === 'function') {
_r2.catch((e) => console.warn('FTA clear failed during loadProblemToCurrent:', e));
}
}

const _ftaKey = problemId ? 'qa-fta-' + problemId : 'qa-fta';
_loadPending++;
pluginLoad(_ftaKey)
.then(async (dbFta) => {

if (getActiveProblemId() !== problemId) return;
if (
dbFta &&
dbFta.data &&
dbFta.data.rootId &&
window.FTA &&
typeof window.FTA.importData === 'function'
) {
const ftaClone = JSON.parse(JSON.stringify(dbFta.data));
ftaClone.metadata = ftaClone.metadata || {};
ftaClone.metadata.problemTitle = problem.title || '';
ftaClone.metadata.problemContext =
problem.problemStatement || problem.details?.phenomenon || '';
if (ftaClone.topEvent && !ftaClone.topEvent.name) {
ftaClone.topEvent.name = problem.title || '';
}

await window.FTA.importData(ftaClone);

const problems = getProblemList();
const index = problems.findIndex((p) => p.id === problemId);
if (index !== -1) {
problems[index].snapshot = problems[index].snapshot || { version: SCHEMA_VERSION };
problems[index].snapshot.ftaData = ftaClone;
saveProblemList(problems);
}
}
_callOnLoaded();
})
.catch((e) => {
console.warn('[IDB] pluginLoad for FTA failed:', e);
_callOnLoaded();
});
}
}

const _p = getProblemById(problemId);
if (_p && _p.status !== 'completed') {
const _analyses = _p.analyses || {};
const _methods = window.ANALYSIS_METHODS || [];
const _allCompleted =
_methods.length > 0 &&
_methods.every((m) => {
const a = _analyses[m.key];
return a && a.status === 'completed';
});
if (!_allCompleted) {
updateProblem(problemId, { status: 'analyzing' });
}
}

syncActiveProblemNodeCount();

if (_loadPending === 0) _callOnLoaded();
return true;
}

/** 从问题对象组装上下文字符串（通用状态层） */
function buildProblemContext(problem) {
if (!problem || !problem.details) return '';
const d = problem.details;
const Labels = window.Labels || {};
const severityLabels = Labels.severity || {};
const sourceLabels = Labels.source || {};
let ctx = '';
if (problem.displayId) ctx += '问题编号：' + problem.displayId + '\n';
if (d.severity) ctx += '严重度：' + (severityLabels[d.severity] || d.severity) + '\n';
if (d.time) ctx += '发生时间：' + d.time + '\n';
if (d.discoverySource)
ctx += '发现方式：' + (sourceLabels[d.discoverySource] || d.discoverySource) + '\n';

if (d.expectedState) ctx += '期望值：' + d.expectedState + '\n';
if (d.containment) ctx += '临时措施：' + d.containment + '\n';
return ctx.trim();
}

const storeExports = {
ANALYSIS_METHODS,
normalizeAIResult,
normalizeAIResults,
saveAIResult,
getAIResults,
getLatestAIResult,
linkLatestAIResultToReport,
markAnalysisCompleted,
getActiveProblemId,
setActiveProblemId,
captureAiContext,
checkAiContext,
setReportMarkdown,
setCachedReport,
setCachedTreeHash,
isReportDirty,
setReportDirty,
onBeforeUnload,
getTokenUsage,
on,
emit,
touch,
touchMany,
calculateCountsFromSnapshot,
saveReportToLibrary,
saveReportList,
getReportLibrary,
getReportById,
deleteReportFromLibrary,
getProblemList,
getProblemById,
createNewProblem,
updateProblem,
upsertProblem,
deleteProblem,
saveCurrentAnalysisToProblem,
loadProblemToCurrent,
autoSave,
getStorageUsage,
autoRestore,
clearSavedAnalysis,
exportSnapshot,
importSnapshot,
createNode,
findNode,
collectAllNodes,
removeFromTree,
rebuildNodeIndex,
repairTruncatedJSON,
addTokenUsage,
resetTokenUsage,
buildProblemContext,
addTreeNode,
addBulkTreeNodes,
removeTreeNode,
updateTreeNodeText,
updateTreeNodeWeight,
setTreeNodeRootCause,
addTreeNodeEvidence,
syncActiveProblemNodeCount,
initDB,
pluginSave,
pluginLoad,
pluginRemove
};

Object.assign(window, storeExports);
