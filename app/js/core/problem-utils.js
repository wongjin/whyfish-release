/**
* problem-utils.js — 跨插件共享的问题管理工具
* 依赖：store.js (getActiveProblemId, getProblemById, updateProblem)
*/
(function () {
const SNAPSHOT_VERSION = 2;

window.updatePluginSnapshot = function (pluginName, snapshotKey, snapshotData, capturedPid) {

const activeId = capturedPid || (typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null);
if (!activeId) {
console.warn('updatePluginSnapshot: no active problem ID');
return false;
}
if (typeof window.getProblemById !== 'function' || typeof window.updateProblem !== 'function') {
console.warn('updatePluginSnapshot: required store functions not available');
return false;
}
let problem = window.getProblemById(activeId);
if (!problem) {
console.warn('updatePluginSnapshot: problem not found for ID', activeId);
return false;
}
problem = JSON.parse(JSON.stringify(problem));
const snapshot = problem.snapshot || { version: SNAPSHOT_VERSION };
snapshot[snapshotKey] = snapshotData;
const analyses = problem.analyses || {};
if (
!analyses[pluginName] ||
!['in_progress', 'completed'].includes(analyses[pluginName].status)
) {
analyses[pluginName] = analyses[pluginName] || {};
analyses[pluginName].status = 'not_started';
}
analyses[pluginName].lastUpdated = new Date().toISOString();
window.updateProblem(activeId, { analyses, snapshot });
return true;
};

/**
* isActiveProblemExample — 当前激活的问题是否来自示例数据。
* 示例模式下 AI 修正在内存中生效但不持久化（避免污染存储）。
* 依赖：getActiveProblemId, getProblemById（store.js）。
*/
window.isActiveProblemExample = function () {
if (
typeof window.getActiveProblemId !== 'function' ||
typeof window.getProblemById !== 'function'
) {
return false;
}
const pid = window.getActiveProblemId();
if (!pid) return false;
const p = window.getProblemById(pid);
return !!(p && p._fromExample);
};
})();
