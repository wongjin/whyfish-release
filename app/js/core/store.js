/**
 * store.js — 数据模型 + 持久化 + 通用工具函数
 *
 * 职责：全局状态变量、localStorage 持久化、通用 DOM 工具
 * 依赖：prompts.js（PROMPTS 全局变量，仅 exportSnapshot/importSnapshot 间歇引用）
 * 被依赖：所有其他模块
 */

// ===== Data Model =====
// ===== Global State Consolidation (Stage 3) =====
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

// Fix H3: capture and check AI request context to prevent cross-problem writes
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

// ===== EventBus =====
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

// ===== Unified State Mutation =====

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

// ===== Active Problem Session =====
// _activeProblemId is now in window.Store
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

// ===== Token 使用统计 =====
// totalTokensUsed is now in window.Store

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

// ===== Persistence Layer =====
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
// _autoSaveTimer is now in window.Store

// ===== IndexedDB Base Engine =====
const DB_NAME = 'TPA_Offline_DB';
const DB_VERSION = 2;
const STORE_PROBLEMS = 'problems';
const STORE_REPORTS = 'reports';
const STORE_PLUGIN_DATA = 'plugin_data';

// _db, _dbReady, _problemsCache, _reportsCache, _activeStateCache are now in window.Store

// R1: BroadcastChannel for cross-tab IndexedDB coordination
const _tabChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tpa-db-sync') : null;
if (_tabChannel) {
  _tabChannel.onmessage = (e) => {
    if (e.data?.type === 'db-updated') {
      if (document.hidden) return; // 后台 tab 不刷新，避免打断编辑
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
      resolve(); // Fallback gracefully to run in memory
    };

    request.onsuccess = (e) => {
      _db = e.target.result;
      console.log('[DB] IndexedDB opened successfully.');

      // 监听 versionchange，防止多 tab 升级死锁
      _db.onversionchange = () => {
        _db.close();
        _db = null;
        _dbReady = null;
        console.warn(
          '[DB] Database version change requested. Reopening connection...'
        );
        // 自动重新连接，避免后续操作因 _db 关闭而静默失败
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
  // 5 Whys 数据由 FiveWhys.load() 按需加载，不在此预取
  console.log(
    `[DB] Caches loaded. Problems: ${_problemsCache.length}, Reports: ${_reportsCache.length}`
  );
}

// ===== Plugin Data Helpers (通用持久化，用于鱼骨图、FTA、配置等) =====

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

  // Capture current problem ID and deep copies of state variables to prevent cross-contamination
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
    // P1-4: 没有活动问题时，不写入 base key，避免污染降级迁移路径
    if (!savedAtPid) return;

    // Check if the problem still exists in the list (guard against deleted problems re-creating IDB/snapshot records)
    const problems = getProblemList();
    const p = problems.find((p) => p.id === savedAtPid);
    if (!p) return;
    if (p._fromExample) return; // Guard: do not auto-save tree to active DB or snapshot for example problems

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

    // P1-5: 先写 plugin 数据，成功后再更新问题列表快照
    // 即使此时 gen 已被后续 autoSave 递增，也只改当前 savedAtPid 的条目，
    // 不影响最新问题的状态。保留 saveOk 错误检查即可。
    const saveOk = await pluginSave(key, activeState);
    if (saveOk === false) {
      console.warn('[autoSave] pluginSave failed — skipping problem list update');
      _setSaveDone((_getActiveToolLabel() || '5Whys') + ' 保存失败');
      return;
    }
    // saveOk === undefined 时表示 DB 未初始化（离线首屏），仍继续同步问题列表

    // 同步将当前分析树更新到问题库的 snapshot 中，防止跨问题切换时数据丢失
    if (savedAtPid) {
      // P0-1 修复：pluginSave 已落盘后，snapshot 必须配对写入。
      // 此前 557/562 行的 generation bail 会在用户切换问题时跳过 snapshot 写入，
      // 导致 plugin 数据比 snapshot 新（fishbone 无 heal 路径，下次加载时数据不一致）。
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
    // Version check: future-proof data migration
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
  // P1-21: 返回 pluginRemove 结果，让调用方能在失败时提示用户
  // 失败时旧 snapshot 残留 IDB，重访该问题会复活已重置的数据
  const ok = await pluginRemove(key);
  nodeIndex.clear();
  return ok;
}

// ===== FiveWhys Plugin Facade (统一插件模式，与 Fishbone/FTA 对齐) =====

window.FiveWhys = {
  async init() {
    await this.load();
    this.bindEvents();
  },

  async load() {
    try {
      const key = _activeProblemId ? 'qa-5why-data-' + _activeProblemId : 'qa-5why-data';
      _activeStateCache = await pluginLoad(key);
      // 降级：scoped key 无数据时尝试从 base key 读取并迁移
      // P0-4: 仅迁移存储，不加载到内存（防止旧无 scope 数据污染当前问题）
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
          // P2-9: 清除 tree 的条件：问题没有实质树数据（根节点无子节点即为空），
          // 不依赖 analyses['5why'] 状态（该方法选择器可能在 bindEvents 之前设了 in_progress）。
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
      // 根据已加载的 tree 是否有子节点，决定显示工作区还是问题表单。
      // 之前无条件 navigateToStep('problem') 会隐藏工作区，导致"从报告继续分析"
      // 等路径加载了 tree 数据却只显示空白表单（数据进内存但 DOM 不显示）。
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
  // P1-9: 示例模式下不收集插件数据，防止上层调用意外持久化
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

  // 基础数据（所有导出类型都包含）
  const baseState = {
    version: SCHEMA_VERSION, // v2 格式：支持完整分析导入/导出
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

  // 根据导出类型扩展数据
  if (exportType === 'full' || exportType === 'withReport') {
    // 包含报告数据
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

  // 分析状态元数据
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

  // Mobile: try Web Share API first
  if (navigator.share && navigator.canShare) {
    const file = new File([jsonStr], filename, { type: 'application/json' });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: '分析数据快照' }).catch(() => {});
      return null;
    }
  }

  // Desktop fallback: download via blob URL
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
  window.UIUtils.saveExportBlob(blob, filename, {
    filterName: 'JSON 文件',
    extensions: ['json'],
    successMessage: '分析数据已导出'
  });
  return null;
}

// ===== 导入数据验证 =====
function validateTree(node, visited = new Set(), depth = 0) {
  if (depth > 100) throw new Error('树结构过深（可能存在循环引用）');
  if (!node || typeof node !== 'object') throw new Error('无效的节点结构');
  if (visited.has(node.id)) throw new Error('重复的节点 ID: ' + node.id);

  visited.add(node.id);

  // 必填字段
  if (typeof node.id !== 'number') throw new Error('节点 ID 必须是数字');
  if (!Array.isArray(node.children)) throw new Error('节点 children 必须是数组');

  // 递归验证子节点
  for (const child of node.children) {
    validateTree(child, visited, depth + 1);
  }
  return true;
}

// ===== 插件数据恢复（辅助函数）=====

/** 浅层校验 fishboneData 结构，避免恶意/损坏 JSON 写入插件态 */
function _isValidFishboneData(d) {
  if (typeof d !== 'object' || d === null) return false;
  // 必须有关键字段：categories（对象）、origCategories（可选对象）、metadata（可选对象）
  if (typeof d.categories !== 'object' || d.categories === null) return false;
  // metadata.mainCategories 须是数组（如果存在）
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
  // rootId 必须是字符串或 null
  if (d.rootId != null && typeof d.rootId !== 'string') return false;
  // nodes 必须是对象
  if (typeof d.nodes !== 'object' || d.nodes === null) return false;
  // topEvent 必须是对象（含 name）
  if (typeof d.topEvent !== 'object' || d.topEvent === null) return false;
  if (typeof d.topEvent.name !== 'string') return false;
  return true;
}

function restorePlugins(state, version) {
  // 不设版本门控——只要快照中存在对应字段就恢复，与 SCHEMA_VERSION 无关。
  void version; // 保留参数以便未来扩展兼容逻辑时使用
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
          // P1-4: importData 是 async，try/catch 无法捕获 Promise rejection，用 .catch 兜底
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

      // ===== 版本兼容处理 =====
      const version = state.version || 1;
      console.log(`[Import] 导入 v${version} 格式快照`);

      // 数据验证
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

      // ===== 核心状态恢复（通过 touchMany 保证持久化 + 通知）=====
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

      // P2-6: Rebuild node index on the newly loaded tree!
      rebuildNodeIndex();

      // ===== 插件数据恢复 =====
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

// ===== Node Factory =====
// Note: parent relationship is maintained BOTH via tree structure (children[])
// and via the parentId field on each node. parentId enables efficient parent
// lookup without tree traversal; children[] enables rendering and traversal.
// This redundancy is intentional — do not remove either.

function createNode(text = '', parentId = null, level = 1) {
  const node = {
    id: nextId++,
    parentId,
    level, // Why level (1-N)
    text, // The "because..." answer
    evidence: [], // Optional evidence strings
    weight: 100, // Contribution weight (0-100)
    isRootCause: false,
    children: [] // Child why-nodes (branches)
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

// ===== Tree Data Operations =====

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

  // 1. 5 Whys Tree
  if (snapshot.tree) {
    // 优化：直接递归计数，避免collectAllNodes数组分配和.filter()
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

    // 空树检查
    const isTreeEmpty =
      treeNodeCount === 1 && (!snapshot.tree.text || snapshot.tree.text.trim() === '');
    const finalTreeNodeCount = isTreeEmpty ? 0 : treeNodeCount;

    if (finalTreeNodeCount > maxNodeCount) {
      maxNodeCount = finalTreeNodeCount;
      associatedRootCauseCount = treeRootCauseCount;
    }
  }

  // 2. 鱼骨图 (Fishbone)
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

  // 3. FTA (故障树)
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

// ===== Unified Tree Mutation APIs =====

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
    // Fix M1: invalidate consolidated root causes when a root cause node is deleted
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

    // Sync root node edit back to problem library
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

// ===== Utils =====

// Repair JSON truncated by token limit
function repairTruncatedJSON(str) {
  try {
    let s = str;

    // If we're mid-string, close it
    let inString = false;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && inString) {
        i++;
        continue;
      }
      if (s[i] === '"') inString = !inString;
    }

    // If stuck inside a string, close it
    if (inString) {
      // 从末尾向前找第一个未转义的引号（即当前未闭合字符串的开始引号）
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

    // Trim trailing comma or colon (incomplete next value)
    s = s.replace(/,\s*$/, '').replace(/:\s*$/, ': null');

    // Close unclosed brackets/braces
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

    // Append closing brackets in reverse order
    while (stack.length > 0) s += stack.pop();

    const parsed = JSON.parse(s);
    // P0-1: 结构完整性验证——截断修复后补全缺失的 children 数组
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

// ===== Report Library (报告库) =====

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

    // Fix H4: accept explicit problemId and counts from caller (captured at
    // generation time) instead of reading global state at save time.
    const problemId = options.problemId || getActiveProblemId() || '';
    const nodeCount = options.nodeCount != null ? options.nodeCount : 0;
    const rootCauseCount = options.rootCauseCount != null ? options.rootCauseCount : 0;

    let problemDisplayId = '';
    if (problemId) {
      const p = getProblemById(problemId);
      if (p) problemDisplayId = p.displayId || '';
    }

    // 同一问题 + 同一分析方法（5why），覆盖更新而非新建
    const existingIdx = problemId
      ? reports.findIndex((r) => r.problemId === problemId && r.analysisType === analysisType)
      : -1;

    // 计算版本号
    let version = 'v1.0.0';
    if (existingIdx >= 0) {
      const oldVersion = reports[existingIdx].version || 'v1.0.0';
      version = nextReportVersion(oldVersion, options.isRegenerate);
    }

    // 生成报告编号：RYYYYMMDD-NNN（使用 max+1 策略，避免删除后编号冲突）
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

    // Keep an immutable version package: text, evidence attachments, and provenance.
    let versions = [];
    if (existingIdx >= 0 && reports[existingIdx].versions) {
      versions = [...reports[existingIdx].versions];
    }
    // Archive current content before overwriting
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
      // Cap at 10 versions to avoid unbounded growth
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
    // P1-1: await saveReportList — 此前 fire-and-forget，IDB 写入失败时 toast 已显示成功
    // 但报告未落盘，刷新后丢失。失败时不标记 completed、不跳转。
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
        _reportsCache = prevCache; // 回滚：事务失败，恢复调用前 cache
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
      _reportsCache = prevCache; // 同步异常也回滚
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
          // 5 Whys is persisted twice: as plugin data and in the problem snapshot.
          // Removing only the plugin key lets loadProblemToCurrent restore the old tree.
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

// ===== Problem Pool (问题库) =====

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
        _problemsCache = prevCache; // 回滚：事务失败，恢复调用前 cache
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
      _problemsCache = prevCache; // 同步异常也回滚
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

  // Generate display ID: PYYYYMMDD-NNN
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
    status: options.status || 'pending', // pending | analyzing | completed
    problemStatement: '',
    problemContext: '',
    nodeCount: 0,
    rootCauseCount: 0,
    aiResults: [],
    createdAt: nowISO,
    updatedAt: nowISO,
    snapshot: null // 完整的分析快照
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

  // 如果更新中包含快照，自动重新计算 nodeCount 和 rootCauseCount 确保列表数据与快照同步
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
  // 先删关联报告（可能失败），成功后才删问题，避免问题已删但报告成孤儿
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

  // Collect problem manager details for current snapshot
  let details = {};
  if (window.ProblemManager && typeof window.ProblemManager.getData === 'function') {
    details = window.ProblemManager.getData();
  } else if (window.ProblemManager && typeof window.ProblemManager.collect === 'function') {
    details = window.ProblemManager.collect();
  }

  // Compile context from current form fields (useful when target problem is not active match)
  let formCtx = '';
  if (window.ProblemManager && typeof window.ProblemManager.getProblemContext === 'function') {
    formCtx = window.ProblemManager.getProblemContext();
  }

  // Fix H1: only capture global analysis data when the target problem
  // matches the currently active problem. Otherwise, only persist the
  // form metadata (details) — never write Problem A's tree into B.
  // If no active problem is set, default to capturing (backward compat).
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

  // 插件数据只能由显式调用方采集。问题表单和 5 Whys 的保存不能读取
  // 鱼骨图/FTA 的全局内存，因为切换问题期间该内存可能仍属于前一个问题。
  // 未显式采集时保留旧快照，避免普通表单保存意外删除插件分析结果。
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

  // 统一计算快照中的节点数 and 根因数
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

  // 用户启动/继续分析此问题，清除示例标记，转为普通分析会话
  if (problem._fromExample) {
    updateProblem(problemId, { _fromExample: false });
  }

  const snapshot = problem.snapshot || {};

  // 以当前问题描述为准（快照时的 problemStatement 可能已过时）
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
    // 没有 tree 快照时，只恢复描述并创建根节点
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

  // P0-1-2nd: 异步加载完成回调 — 让 _launchAnalysisFromCard 等调用方可等 IDB 恢复完再同步 DOM
  //
  // _loadPending / _callOnLoaded 协定:
  // - 每个需要异步恢复的插件区块，走异步分支时 ++_loadPending，
  //   在回调中必须调 _callOnLoaded()（成功/失败路径都需要）。
  // - 走同步分支（有快照数据但无需 IDB 读取）不碰 _loadPending，
  //   也不调 _callOnLoaded（让后续区块或底部 L2110 兜底调一次）。
  // - _loadedCalled 守卫确保最多只调一次回调。
  // - 新增异步插件必须遵循此协定，否则 onLoaded 可能永不触发。
  let _loadPending = 0;
  let _loadedCalled = false;
  const _callOnLoaded = () => {
    if (_loadedCalled) return;
    _loadedCalled = true;
    if (typeof onLoaded === 'function') onLoaded(problemId);
  };

  // 恢复鱼骨图数据
  if (window.Fishbone) {
    const _fbKey = problemId ? 'qa-fishbone-' + problemId : 'qa-fishbone';
    if (snapshot.fishboneData) {
      window.Fishbone.fishboneData = snapshot.fishboneData;
      // Sync the problem title to fishboneData if it's empty
      if (window.Fishbone.fishboneData && !window.Fishbone.fishboneData.problem) {
        window.Fishbone.fishboneData.problem = problem.title || '';
      }
      // 兼容旧快照：如果旧快照没有 phenomenon 字段，用问题库现象描述回填
      if (window.Fishbone.fishboneData && !window.Fishbone.fishboneData.phenomenon) {
        window.Fishbone.fishboneData.phenomenon =
          problem.problemStatement || problem.details?.phenomenon || '';
      }
      window.Fishbone.fishboneData.importedContext = buildProblemContext(problem);
      pluginSave(_fbKey, JSON.parse(JSON.stringify(window.Fishbone.fishboneData)));
    } else {
      // 异步检测 IDB：不先同步设置空数据，避免 async callback 覆盖用户在此期间的编辑
      _loadPending++;
      pluginLoad(_fbKey)
        .then((dbFb) => {
          // P1-2: 异步回调守卫——如果用户已切换到其他问题，不覆盖数据
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
            // P0-1-2nd: 自动修复快照中的缺失引用 (heal)，与 FTA heal 路径对齐
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

  // 恢复 FTA 数据
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
      // P1-4: importData 是 async，loadProblemToCurrent 是 sync 函数无法 await，增加 _loadPending 回调控制避免竞态条件
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
      // 立即清空内存数据，防止旧数据残留
      if (window.FTA && typeof window.FTA.clear === 'function') {
        // P1-4: clear 是 async，用 .catch 兜底
        const _r2 = window.FTA.clear();
        if (_r2 && typeof _r2.catch === 'function') {
          _r2.catch((e) => console.warn('FTA clear failed during loadProblemToCurrent:', e));
        }
      }
      // 异步检测 IDB，以防数据被误删
      const _ftaKey = problemId ? 'qa-fta-' + problemId : 'qa-fta';
      _loadPending++;
      pluginLoad(_ftaKey)
        .then(async (dbFta) => {
          // P1-2: 异步回调守卫——如果用户已切换到其他问题，不覆盖数据
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
            // P1-4: .then 回调改 async，await importData
            await window.FTA.importData(ftaClone);

            // 自动修复快照中的缺失引用 (heal)
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

  // 更新问题状态：尊重已完成的状态
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

  // 同步节点数（快照恢复时 stored nodeCount 可能为 0）
  syncActiveProblemNodeCount();

  // 没有异步加载时立即回调
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
