/**
* ui-utils.js — 通用 UI 工具函数
*
* 职责：DOM 转义、消息提示、状态更新、文本处理、页面导航
* 依赖：无
*
* 设计决策（2026-05-18 评审重构）：
* - UI_CONFIG 集中管理硬编码常量
* - navigateTo 拆分为配置表+子函数，业务回调通过 registerPageHook() 注册
* - showToast 限制最大 3 条，自动创建容器，定时器可追踪
* - truncate 增强类型安全和多字节字符支持
* - 双暴露：window.UIUtils 命名空间 + 向后兼容的 window 全局函数
*/

const UI_CONFIG = Object.freeze({

PAGE_SUBTITLES: Object.freeze({
'page-problem': '问题管理',
'page-analysis': 'WhyFish 问题分析与解决',
'page-knowledge': '知识库',
'page-report-library': '报告管理'
}),

TOAST_MAX: 3,
TOAST_DURATION: { error: 6000, warning: 4500, info: 3500, success: 3500 },
TOAST_ICONS: Object.freeze({
success:
'<svg class="toast-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></svg>',
error:
'<svg class="toast-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></svg>',
info:
'<svg class="toast-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
warning:
'<svg class="toast-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 4.7 3.2 17a2 2 0 0 0 1.7 3h14.2a2 2 0 0 0 1.7-3L13.7 4.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 3h.01"/></svg>'
}),

MOBILE_BREAKPOINT: 1024
});

const _pageHooks = {};

/**
* 注册页面进入钩子
* @param {string} pageId - 页面 ID
* @param {Function} callback - 回调函数
*/
function registerPageHook(pageId, callback) {
if (!_pageHooks[pageId]) _pageHooks[pageId] = [];
_pageHooks[pageId].push(callback);
}

const _toastTimers = [];

/**
* HTML 转义，防止 XSS
* @param {*} s - 任意值
* @returns {string}
*/
function esc(s) {
if (s === null || s === undefined) return '';
return String(s)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');
}

/**
* 显示吐司提示（最多 3 条，超出移除最旧的）
* @param {string} msg - 消息文本
* @param {'info'|'success'|'error'|'warning'} type - 类型
*/
function showToast(msg, type) {

if (msg && (msg.includes('No API key') || msg.includes('No API Key'))) {
return;
}
type = type in UI_CONFIG.TOAST_DURATION ? type : 'info';

let c = document.getElementById('toastContainer');
if (!c) {
c = document.createElement('div');
c.id = 'toastContainer';
c.style.cssText =
'position:fixed;top:var(--space-5);left:50%;transform:translateX(-50%);z-index:var(--z-toast,2000);display:flex;flex-direction:column;align-items:center;gap:var(--space-2);';
document.body.appendChild(c);
}

while ((c.children?.length || 0) >= UI_CONFIG.TOAST_MAX && c.firstElementChild) {
c.firstElementChild.remove();
}

const t = document.createElement('div');
t.className = 'toast ' + type;
const icon = UI_CONFIG.TOAST_ICONS[type] || UI_CONFIG.TOAST_ICONS.info;
t.innerHTML = icon + '<span class="toast-message">' + esc(msg) + '</span>';
c.appendChild(t);

const duration = UI_CONFIG.TOAST_DURATION[type];
const timer = setTimeout(() => {
t.style.animation = 'slideOut 0.3s forwards';
const removeTimer = setTimeout(() => {
t.remove();
_spliceTimer(removeTimer);
}, 300);
_toastTimers.push(removeTimer);
_spliceTimer(timer);
}, duration);
_toastTimers.push(timer);
}

function _spliceTimer(id) {
const idx = _toastTimers.indexOf(id);
if (idx !== -1) _toastTimers.splice(idx, 1);
}

/**
* 显示确认对话框
* @param {string} message - 确认消息
* @param {'primary'|'danger'|'warning'} type - 确认按钮类型（默认 primary）
* @returns {Promise<boolean>} 用户选择结果
*/
function showConfirm(message, type = 'primary') {
return new Promise((resolve) => {

const overlay = document.createElement('div');
overlay.className = 'confirm-overlay';

const dialog = document.createElement('div');
dialog.className = 'confirm-dialog';

const btnClass =
type === 'danger' ? 'btn-danger' : type === 'warning' ? 'btn-warning' : 'btn-primary';

dialog.innerHTML = `
<p style="margin:0 0 20px;font-size:0.95rem;line-height:1.5;color:var(--text);">${esc(message)}</p>
<div style="display:flex;gap:12px;justify-content:flex-end;">
<button class="btn btn-outline confirm-cancel" style="min-width:80px;">取消</button>
<button class="btn ${btnClass} confirm-ok" style="min-width:80px;">确认</button>
</div>
`;

overlay.appendChild(dialog);

const openDialog = document.querySelector('dialog[open]');
(openDialog || document.body).appendChild(overlay);

const cancelBtn = dialog.querySelector('.confirm-cancel');
const okBtn = dialog.querySelector('.confirm-ok');

const cleanup = (result) => {
document.removeEventListener('keydown', handleEsc);
overlay.remove();
resolve(result);
};

cancelBtn.addEventListener('click', () => cleanup(false));
okBtn.addEventListener('click', () => cleanup(true));
overlay.addEventListener('click', (e) => {
if (e.target === overlay) cleanup(false);
});

const handleEsc = (e) => {
if (e.key === 'Escape') {
document.removeEventListener('keydown', handleEsc);
cleanup(false);
}
};
document.addEventListener('keydown', handleEsc);

if (type === 'danger') {
cancelBtn.focus();
} else {
okBtn.focus();
}
});
}

/**
* 带复选框选项的确认对话框
* @param {string} message - 确认消息
* @param {'primary'|'danger'|'warning'} type - 确认按钮类型
* @param {string} checkboxLabel - 复选框标签（为空则不显示）
* @returns {Promise<{confirmed: boolean, checked: boolean}>}
*/
function showConfirmWithOption(message, type = 'primary', checkboxLabel = '') {
return new Promise((resolve) => {
const overlay = document.createElement('div');
overlay.className = 'confirm-overlay';
const dialog = document.createElement('div');
dialog.className = 'confirm-dialog';
const btnClass =
type === 'danger' ? 'btn-danger' : type === 'warning' ? 'btn-warning' : 'btn-primary';

const checkboxId = checkboxLabel ? 'confirmOptionCheckbox_' + Date.now() : '';
dialog.innerHTML = `
<p style="margin:0 0 16px;font-size:0.95rem;line-height:1.5;color:var(--text);">${esc(message)}</p>
${checkboxLabel ? `<label style="display:flex;align-items:center;gap:8px;margin-bottom:16px;padding:8px 12px;border-radius:var(--radius-sm);background:var(--bg-secondary);font-size:0.85rem;color:var(--text-secondary);cursor:pointer;"><input type="checkbox" id="${checkboxId}" checked>${esc(checkboxLabel)}</label>` : ''}
<div style="display:flex;gap:12px;justify-content:flex-end;">
<button class="btn btn-outline confirm-cancel" style="min-width:80px;">取消</button>
<button class="btn ${btnClass} confirm-ok" style="min-width:80px;">确认</button>
</div>
`;
overlay.appendChild(dialog);

const openDialog = document.querySelector('dialog[open]');
(openDialog || document.body).appendChild(overlay);
const cancelBtn = dialog.querySelector('.confirm-cancel');
const okBtn = dialog.querySelector('.confirm-ok');

const checkbox = checkboxId ? dialog.querySelector('#' + checkboxId) : null;
const cleanup = (confirmed) => {
document.removeEventListener('keydown', handleEsc);
overlay.remove();
resolve({ confirmed, checked: checkbox ? checkbox.checked : false });
};
cancelBtn.addEventListener('click', () => cleanup(false));
okBtn.addEventListener('click', () => cleanup(true));
overlay.addEventListener('click', (e) => {
if (e.target === overlay) cleanup(false);
});
const handleEsc = (e) => {
if (e.key === 'Escape') {
document.removeEventListener('keydown', handleEsc);
cleanup(false);
}
};
document.addEventListener('keydown', handleEsc);

if (type === 'danger') {
cancelBtn.focus();
} else {
okBtn.focus();
}
});
}

/**
* 文本截断（支持多字节字符）
* @param {*} s - 输入值
* @param {number} max - 最大字符数
* @returns {string}
*/
function truncate(s, max) {
if (s === null || s === undefined || s === false) return '';
s = String(s);
max = Number(max);
if (!max || max <= 0) return s;
if ([...s].length <= max) return s;
return [...s].slice(0, max).join('') + '...';
}

/**
* 更新侧边栏按钮高亮
*/
function _updateSidebarActive(pageId, toolPanelId) {
document.querySelectorAll('.sidebar-btn').forEach((b) => {
b.classList.remove('active');
});

if (toolPanelId) {
const safeToolId = CSS.escape ? CSS.escape(toolPanelId) : toolPanelId;
const btn = document.querySelector(`.sidebar-btn[data-tool="${safeToolId}"]`);
if (btn) btn.classList.add('active');
} else if (pageId) {
const safeId = CSS.escape ? CSS.escape(pageId) : pageId;
const btn = document.querySelector(`.sidebar-btn[data-page="${safeId}"]:not([data-tool])`);
if (btn) btn.classList.add('active');
}
}

/**
* 切换页面可见性
*/
function _switchPage(pageId) {
document.querySelectorAll('.page-content').forEach((p) => {
p.classList.add('hidden');
});
const target = document.getElementById(pageId);
if (target) target.classList.remove('hidden');
}

/**
* 切换工具面板
*/
function _switchToolPanel(toolPanelId) {
if (!toolPanelId) return;

const subBtns = document.querySelectorAll('.sidebar-sub-btn');
const toolPanels = document.querySelectorAll('.tool-panel');
subBtns.forEach((t) => t.classList.remove('active'));

const safeId = CSS.escape ? CSS.escape(toolPanelId) : toolPanelId;
const btn = document.querySelector(`.sidebar-sub-btn[data-tool="${safeId}"]`);
if (btn) btn.classList.add('active');

toolPanels.forEach((p) => p.classList.add('hidden'));

const panel = document.getElementById(toolPanelId);
if (panel) {
panel.classList.remove('hidden');
panel.dispatchEvent(new CustomEvent('toolpanel:show'));
}
}

/**
* 更新页面副标题
*/
function _updateSubtitle(pageId) {
const subtitleEl = document.querySelector('.header-subtitle');
if (subtitleEl && UI_CONFIG.PAGE_SUBTITLES[pageId]) {
subtitleEl.textContent = UI_CONFIG.PAGE_SUBTITLES[pageId];
}
}

/**
* 移动端自动关闭侧边栏
*/
function _closeMobileSidebar() {
if (!window.matchMedia(`(max-width: ${UI_CONFIG.MOBILE_BREAKPOINT}px)`).matches) return;
const sidebar = document.getElementById('sidebarNav');
if (sidebar) sidebar.classList.remove('mobile-open');
const backdrop = document.getElementById('sidebarBackdrop');
if (backdrop) backdrop.classList.remove('visible');
const btn = document.getElementById('mobileMenuBtn');
if (btn) btn.setAttribute('aria-expanded', 'false');
}

/**
* 统一页面导航
* @param {string} pageId - 目标页面 ID（如 'page-analysis'）
* @param {string} [toolPanelId] - 可选的工具面板 ID（如 'tool-5why'）
* @param {boolean} [keepMobileOpen] - 如果为 true，则在移动端导航时不自动收起侧边栏
*/
function navigateTo(pageId, toolPanelId, keepMobileOpen) {
if (!window.__scheduledRedirectNavigating && typeof window.cancelScheduledRedirect === 'function') {
window.cancelScheduledRedirect();
}
const mainContent = document.querySelector('.main-content');

_updateSidebarActive(pageId, toolPanelId);
_switchPage(pageId);
_switchToolPanel(toolPanelId);
_updateSubtitle(pageId);

const hooks = _pageHooks[pageId];
if (hooks) {
hooks.forEach((fn) => {
try {
fn();
} catch (e) {
console.error('[navigateTo] hook error:', pageId, e);
}
});
}

requestAnimationFrame(() => {
if (document.scrollingElement) {
document.scrollingElement.scrollTop = 0;
}
window.scrollTo({ top: 0, behavior: 'auto' });
});
if (!keepMobileOpen) {
_closeMobileSidebar();
}
if (window.SidebarUI?.refreshResultLauncher) {
window.SidebarUI.refreshResultLauncher();
}
}

if (typeof marked !== 'undefined') {

const _safeUrlRe = /^\s*(https?|mailto|tel|#|\/)/i;
const _sanitizeUrl = function (url) {
if (!url) return '';
return _safeUrlRe.test(url) ? url : '';
};
marked.use({
renderer: {
html(token) {
return token.raw
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');
},
link({ href, title, text }) {
const safeHref = _sanitizeUrl(href);
const titleAttr = title ? ' title="' + title.replace(/"/g, '&quot;') + '"' : '';
return (
'<a href="' + safeHref.replace(/"/g, '&quot;') + '"' + titleAttr + '>' + text + '</a>'
);
},
image({ href, title, text }) {
const safeHref = _sanitizeUrl(href);
const titleAttr = title ? ' title="' + title.replace(/"/g, '&quot;') + '"' : '';
return (
'<img src="' +
safeHref.replace(/"/g, '&quot;') +
'" alt="' +
(text || '').replace(/"/g, '&quot;') +
'"' +
titleAttr +
'>'
);
}
}
});
}

function safeSanitize(html) {
if (typeof DOMPurify !== 'undefined') {
return DOMPurify.sanitize(html);
}

console.error(
'[safeSanitize] DOMPurify 未加载，已退化为 HTML 转义（内容不会被消毒，仅转义特殊字符）'
);
return esc(html);
}

function closeAllDialogs() {
document.querySelectorAll('dialog[open]').forEach((d) => d.close());
}

function mdToHtml(md) {
if (!md) return '';

if (typeof marked === 'undefined' || !marked || typeof marked.parse !== 'function') {
const lines = esc(md).split('\n');
return '<p>' + lines.filter(Boolean).join('</p><p>') + '</p>';
}
const rawHtml = marked.parse(md);
return safeSanitize(rawHtml);
}

/**
* 渲染 AI 错误块 HTML
* 集中管理避免在 ai.js/fta.js/fishbone.js 中重复 15+ 次
*/
function renderAiErrorBlock(title, errMsg) {
const hint = getApiErrorHint(errMsg);
return `<div class="ai-block is-error"><h4>${esc(title)}</h4><p>${esc(errMsg)}</p><p style="font-size:0.85rem;color:var(--text-muted);margin-top:4px;">${hint}</p></div>`;
}

/**
* 根据错误消息返回 API 错误提示文本
* 集中管理避免在 ai.js/fta.js/fishbone.js 中重复 17 次同样的 if/else 链
*/
function getApiErrorHint(msg) {
if (!msg) return '请检查网络连接和模型配置，或尝试切换其他模型。';
if (msg.includes('400')) {
return '请求参数错误，请检查模型参数或更换模型试用。';
}
if (msg.includes('401') || msg.includes('403') || msg.includes('API Key')) {
return '请检查 API Key 和模型配置是否正确。';
}
if (msg.includes('404')) {
return '模型或 API 端点未找到，请检查端点 URL 和模型名称配置。';
}
if (msg.includes('408')) {
return '请求超时，请稍后重试或切换模型。';
}
if (msg.includes('409')) {
return '请求冲突，请重试。';
}
if (msg.includes('429')) {
return '请求频率过高，请稍后再试。';
}
if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
return '模型服务端异常，请稍后重试或切换其他模型。';
}
if (msg.includes('504') || msg.includes('timeout') || msg.includes('超时')) {
return 'API 请求超时，请稍后重试或切换模型。';
}
return '请检查网络连接和模型配置，或尝试切换其他模型。';
}

function _isTauriDesktop() {
return typeof window !== 'undefined' && typeof window.__TAURI__?.core?.invoke === 'function';
}

function _exportFileOptions(filename, options = {}) {
const extensionMatch = String(filename || '').match(/\.([^.]+)$/);
const extension = extensionMatch ? extensionMatch[1].toLowerCase() : '';
const filterNames = {
docx: 'Word 文档',
json: 'JSON 文件',
md: 'Markdown 文档',
png: 'PNG 图片',
svg: 'SVG 图片'
};
return {
filterName: options.filterName || filterNames[extension] || 'WhyFish 文件',
extensions: options.extensions || (extension ? [extension] : []),
successMessage: options.successMessage || '文件已保存'
};
}

function _browserDownloadHref(href, filename, revokeAfterDownload = false) {
const a = document.createElement('a');
a.href = href;
a.download = filename;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
if (revokeAfterDownload) URL.revokeObjectURL(href);
}

function _invokeNativeFileSave(base64Data, filename, options = {}) {
const resolved = _exportFileOptions(filename, options);
showToast('请选择文件保存位置', 'info');
return window.__TAURI__.core
.invoke('save_file_local', {
args: {
filename: filename,
base64_data: base64Data,
filter_name: resolved.filterName,
extensions: resolved.extensions
}
})
.then((result) => {
if (result === 'Success') {
showToast(resolved.successMessage, 'success');
} else if (result === 'Cancelled') {
showToast('导出已取消', 'info');
}
return result;
})
.catch((err) => {
console.error('Tauri file export error:', err);
showToast(`文件保存失败: ${err}`, 'error');
return 'Error';
});
}

function _blobToDataUrl(blob) {
return new Promise((resolve, reject) => {
const reader = new FileReader();
reader.onloadend = () => resolve(reader.result);
reader.onerror = () => reject(reader.error || new Error('文件转码失败'));
reader.readAsDataURL(blob);
});
}

function saveExportBlob(blob, filename, options = {}) {
const resolved = _exportFileOptions(filename, options);
if (!_isTauriDesktop()) {
const url = URL.createObjectURL(blob);
_browserDownloadHref(url, filename, true);
showToast(resolved.successMessage, 'success');
return Promise.resolve('Success');
}

return _blobToDataUrl(blob)
.then((base64Data) => _invokeNativeFileSave(base64Data, filename, resolved))
.catch((err) => {
console.error('FileReader error:', err);
showToast('文件转码失败', 'error');
return 'Error';
});
}

function saveExportDataUrl(dataUrl, filename, options = {}) {
const resolved = _exportFileOptions(filename, options);
if (!_isTauriDesktop()) {
_browserDownloadHref(dataUrl, filename);
showToast(resolved.successMessage, 'success');
return Promise.resolve('Success');
}
return _invokeNativeFileSave(dataUrl, filename, resolved);
}

window.UIUtils = {
config: UI_CONFIG,
registerPageHook: registerPageHook,
esc: esc,
showToast: showToast,
showConfirm: showConfirm,
showConfirmWithOption: showConfirmWithOption,
truncate: truncate,
navigateTo: navigateTo,
mdToHtml: mdToHtml,
safeSanitize: safeSanitize,
closeAllDialogs: closeAllDialogs,
getApiErrorHint: getApiErrorHint,
renderAiErrorBlock: renderAiErrorBlock,
measureTextWidth: function (text, fontSize) {
if (!text) return 0;
if (typeof document !== 'undefined' && document.createElement) {
const canvas = document.createElement('canvas');
if (canvas && typeof canvas.getContext === 'function') {
const ctx = canvas.getContext('2d');
if (ctx && typeof ctx.measureText === 'function') {
ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
return ctx.measureText(text).width;
}
}
}

let width = 0;
const cjkFs = fontSize || 11;
for (let i = 0; i < text.length; i++) {
const code = text.charCodeAt(i);
if (code >= 0 && code <= 127) {
const char = text.charAt(i);
if (/[0-9]/.test(char)) {
width += cjkFs * 0.56;
} else if (/[a-z]/.test(char)) {
width += cjkFs * 0.52;
} else if (/[A-Z]/.test(char)) {
width += cjkFs * 0.68;
} else if (char === ' ') {
width += cjkFs * 0.32;
} else {
width += cjkFs * 0.58;
}
} else {
width += cjkFs;
}
}
return Math.ceil(width);
},
preventOrphans: function (linesOrText) {
if (Array.isArray(linesOrText)) {
const lines = linesOrText;
if (lines.length <= 1) return lines;
const lastLine = lines[lines.length - 1].trim();
const prevLine = lines[lines.length - 2].trim();
if (lastLine.length === 1 && prevLine.length > 1) {
const lastCharOfPrev = prevLine.charAt(prevLine.length - 1);
lines[lines.length - 2] = prevLine.slice(0, -1).trim();
lines[lines.length - 1] = `${lastCharOfPrev}${lastLine}`;
return lines;
}
const wordsInLast = lastLine.split(/\s+/);
if (wordsInLast.length === 1 && wordsInLast[0] !== '') {
const wordsInPrev = prevLine.split(/\s+/);
if (wordsInPrev.length > 1) {
const lastWordOfPrev = wordsInPrev[wordsInPrev.length - 1];
lines[lines.length - 2] = wordsInPrev.slice(0, -1).join(' ');
lines[lines.length - 1] = `${lastWordOfPrev} ${lastLine}`;
}
}
return lines;
} else if (typeof linesOrText === 'string') {
const text = linesOrText;
const words = text.split(/\s+/);
if (words.length === 1) return text;
for (let i = words.length - 2; i >= 0; i--) {
if (words[i].length <= 2 && words[i + 1].length <= 4) {
words[i] = `${words[i]}\u00A0${words[i + 1]}`;
words.splice(i + 1, 1);
}
}
return words.join(' ');
} else {
return linesOrText;
}
},
wrapTextByWidth: function (text, maxWidth, fontSize) {
if (!text) return [''];
const lines = [];
let currentLine = '';
let currentWidth = 0;
const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uff00-\uffef]/.test(text);
if (hasCJK) {
for (let i = 0; i < text.length; i++) {
const char = text.charAt(i);
const charW = window.UIUtils.measureTextWidth(char, fontSize);
if (currentWidth + charW > maxWidth && currentLine !== '') {
lines.push(currentLine);
currentLine = char;
currentWidth = charW;
} else {
currentLine += char;
currentWidth += charW;
}
}
if (currentLine !== '') {
lines.push(currentLine);
}
} else {
const words = text.split(/\s+/);
const spaceW = window.UIUtils.measureTextWidth(' ', fontSize);
for (let i = 0; i < words.length; i++) {
const word = words[i];
if (word === '') continue;
const wordW = window.UIUtils.measureTextWidth(word, fontSize);
if (currentLine === '') {
currentLine = word;
currentWidth = wordW;
} else if (currentWidth + spaceW + wordW > maxWidth) {
lines.push(currentLine);
currentLine = word;
currentWidth = wordW;
} else {
currentLine += ' ' + word;
currentWidth += spaceW + wordW;
}
}
if (currentLine !== '') {
lines.push(currentLine);
}
}
return window.UIUtils.preventOrphans(lines);
},
downloadMarkdown: function (content, filename) {
const markdownContent = typeof content === 'function' ? content() : content;
const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' });
return saveExportBlob(blob, filename, {
filterName: 'Markdown 文档',
extensions: ['md'],
successMessage: 'Markdown 报告已导出'
});
},
saveExportBlob: saveExportBlob,
saveExportDataUrl: saveExportDataUrl,
sanitizeFilenameBase: function (value, maxLength = 30, fallback = 'report') {
const cleaned = String(value || '')
.normalize('NFC')
.replace(/[^\p{L}\p{N}_-]+/gu, '-')
.replace(/-+/g, '-')
.replace(/^-|-$/g, '');
const truncated = Array.from(cleaned).slice(0, Math.max(1, Number(maxLength) || 30)).join('');
return truncated || fallback;
},
downloadDocx: function (htmlContent, filename) {

const safeContent = safeSanitize(htmlContent);
const rootStyles = getComputedStyle(document.documentElement);
const readThemeColor = (token, fallback) => {
const value = rootStyles.getPropertyValue(token).trim();
return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
};
const reportPrimary = readThemeColor('--primary', '#008066');
const reportPrimaryDark = readThemeColor('--primary-dark', '#006b50');
const convertedHtml = `
<!DOCTYPE html>
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
<meta charset="utf-8">
<title>Export Docx</title>
<style>
body { font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; line-height: 1.5; color: #333; text-align: left; }
h1 { color: ${reportPrimary}; font-size: 22pt; border-bottom: 2px solid ${reportPrimary}; padding-bottom: 5px; }
h2 { color: ${reportPrimaryDark}; font-size: 16pt; margin-top: 20px; }
h3 { color: #333333; font-size: 13pt; }
p { font-size: 10.5pt; text-align: left; }
li { font-size: 10.5pt; text-align: left; }
table { border-collapse: collapse; width: 100%; margin: 15px 0; }
th, td { border: 1px solid #ddd; padding: 8px; font-size: 10pt; }
th { background-color: #f2f2f2; font-weight: bold; }
blockquote { border-left: 3px solid ${reportPrimary}; padding-left: 10px; color: #666; margin: 10px 0; }
img { max-width: 100%; height: auto; }
</style>
</head>
<body>
${safeContent}
</body>
</html>
`;

if (typeof htmlDocx !== 'undefined' && typeof htmlDocx.asBlob === 'function') {
const blob = htmlDocx.asBlob(convertedHtml);
return saveExportBlob(blob, filename, {
filterName: 'Word 文档',
extensions: ['docx'],
successMessage: 'Word 报告已导出'
});
} else {
console.error('htmlDocx library not loaded.');
if (typeof showToast === 'function') {
showToast('Word 导出模块 htmlDocx 加载失败，请刷新页面重试', 'error');
} else {
alert('Word 导出模块 htmlDocx 加载失败，请刷新页面重试');
}
}
},
resolveSvgCssVars: function (svgStr) {
const cs = getComputedStyle(document.documentElement);
let resolved = svgStr;
let prev;
const defaults = {
'--font': "'PingFang SC', 'Microsoft YaHei', sans-serif",
'--ff': "'PingFang SC', 'Microsoft YaHei', sans-serif",
'--text': '#111827',
'--border': '#e5e7eb',
'--bg-card': '#ffffff',
'--primary': '#008066',
'--primary-rgb': '0, 128, 102',
'--red': '#dc2626',
'--red-rgb': '220, 38, 38',
'--green': '#059669',
'--green-rgb': '5, 150, 105',
'--orange': '#b45309',
'--orange-rgb': '180, 83, 9'
};
do {
prev = resolved;
resolved = resolved.replace(
/var\(\s*(--[^),]+?)\s*(?:,\s*([^)]+?)\s*)?\)/g,
(match, varName, fallback) => {
const val = cs.getPropertyValue(varName).trim();
if (val) return val;
if (fallback) return fallback.trim();
return defaults[varName] || match;
}
);
} while (resolved !== prev);
return resolved;
},
embedSvgForDocument: async function (
svgElement,
{
title = '',
alt = '',
width = 600,
defaultWidth = 800,
defaultHeight = 450,
progressMessage = ''
} = {}
) {
if (!svgElement) return '';

let vbWidth = defaultWidth;
let vbHeight = defaultHeight;
const viewBox = svgElement.getAttribute('viewBox');
if (viewBox) {
const parts = viewBox.trim().split(/[\s,]+/);
if (parts.length === 4) {
vbWidth = parseFloat(parts[2]) || defaultWidth;
vbHeight = parseFloat(parts[3]) || defaultHeight;
}
}
const imageWidth = Math.max(1, Number(width) || 600);
const imageHeight = Math.round(imageWidth * (vbHeight / vbWidth));
let imageSource = '';

if (progressMessage && typeof showToast === 'function') {
showToast(progressMessage, 'info');
}
try {
imageSource = await window.UIUtils.svgToPngBase64(svgElement);
} catch (err) {
console.warn('SVG-to-PNG failed, falling back to inline SVG:', err);
}
if (!imageSource) {
const svgHtml = window.UIUtils.resolveSvgCssVars(
new XMLSerializer().serializeToString(svgElement)
);
imageSource = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgHtml)))}`;
}

const safeTitle = window.UIUtils.esc(title);
const safeAlt = window.UIUtils.esc(alt || title);
return `<h2>${safeTitle}</h2><p><img src="${imageSource}" width="${imageWidth}" height="${imageHeight}" alt="${safeAlt}" style="width:100%; max-width:${imageWidth}px; height:auto;"/></p>`;
},

svgToPngBase64: function (svgElement) {
return new Promise((resolve, reject) => {
try {
const clone = svgElement.cloneNode(true);
const viewBox = svgElement.getAttribute('viewBox');
let minX = 0;
let minY = 0;
let vbWidth = null;
let vbHeight = null;
if (viewBox) {
const parts = viewBox.trim().split(/[\s,]+/);
if (parts.length === 4) {
minX = parseFloat(parts[0]) || 0;
minY = parseFloat(parts[1]) || 0;
vbWidth = parseFloat(parts[2]) || null;
vbHeight = parseFloat(parts[3]) || null;
}
}

const width =
vbWidth || svgElement.clientWidth || svgElement.getBoundingClientRect().width || 800;
const height =
vbHeight || svgElement.clientHeight || svgElement.getBoundingClientRect().height || 450;

clone.setAttribute('width', width.toString());
clone.setAttribute('height', height.toString());

let svgString = new XMLSerializer().serializeToString(clone);
svgString = window.UIUtils.resolveSvgCssVars(svgString);

const applyTransform = (transformStr, ctx) => {
const regex = /(\w+)\(([^)]+)\)/g;
let match;
while ((match = regex.exec(transformStr)) !== null) {
const type = match[1].toLowerCase();
const args = match[2]
.trim()
.split(/[\s,]+/)
.map(parseFloat);
if (type === 'translate') {
ctx.translate(args[0] || 0, args[1] || 0);
} else if (type === 'scale') {
const sx = args[0] || 1;
const sy = args.length > 1 ? args[1] : sx;
ctx.scale(sx, sy);
} else if (type === 'rotate') {
const angle = args[0] || 0;
const rad = (angle * Math.PI) / 180;
if (args.length === 3) {
ctx.translate(args[1], args[2]);
ctx.rotate(rad);
ctx.translate(-args[1], -args[2]);
} else {
ctx.rotate(rad);
}
} else if (type === 'matrix' && args.length === 6) {
ctx.transform(args[0], args[1], args[2], args[3], args[4], args[5]);
}
}
};

const drawPath = (d, ctx) => {
ctx.beginPath();
const pathRegex = /([a-df-z])|(-?\d*\.?\d+(?:[eE][+-]?\d+)?)/gi;
let match;
const tokens = [];
while ((match = pathRegex.exec(d)) !== null) {
if (match[1]) {
tokens.push(match[1]);
} else {
tokens.push(parseFloat(match[2]));
}
}

let i = 0;
let curX = 0;
let curY = 0;
let startX = 0;
let startY = 0;
let lastCmd = '';
let _prevCpx = 0;
let _prevCpy = 0;

while (i < tokens.length) {
const token = tokens[i];
let cmd = lastCmd;
if (typeof token === 'string') {
cmd = token;
i++;
}

const upperCmd = cmd.toUpperCase();

if (upperCmd === 'M') {
const x = tokens[i++];
const y = tokens[i++];
if (cmd === 'm') {
curX += x;
curY += y;
} else {
curX = x;
curY = y;
}
ctx.moveTo(curX, curY);
startX = curX;
startY = curY;
_prevCpx = curX;
_prevCpy = curY;
lastCmd = cmd === 'm' ? 'l' : 'L';
} else if (upperCmd === 'L') {
const x = tokens[i++];
const y = tokens[i++];
if (cmd === 'l') {
curX += x;
curY += y;
} else {
curX = x;
curY = y;
}
ctx.lineTo(curX, curY);
lastCmd = cmd;
} else if (upperCmd === 'H') {
const x = tokens[i++];
if (cmd === 'h') {
curX += x;
} else {
curX = x;
}
ctx.lineTo(curX, curY);
lastCmd = cmd;
} else if (upperCmd === 'V') {
const y = tokens[i++];
if (cmd === 'v') {
curY += y;
} else {
curY = y;
}
ctx.lineTo(curX, curY);
lastCmd = cmd;
} else if (upperCmd === 'C') {
const cp1x = tokens[i++];
const cp1y = tokens[i++];
const cp2x = tokens[i++];
const cp2y = tokens[i++];
const x = tokens[i++];
const y = tokens[i++];
if (cmd === 'c') {
ctx.bezierCurveTo(
curX + cp1x,
curY + cp1y,
curX + cp2x,
curY + cp2y,
curX + x,
curY + y
);
_prevCpx = curX + cp2x;
_prevCpy = curY + cp2y;
curX += x;
curY += y;
} else {
ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
_prevCpx = cp2x;
_prevCpy = cp2y;
curX = x;
curY = y;
}
lastCmd = cmd;
} else if (upperCmd === 'S') {
const cp2x = tokens[i++];
const cp2y = tokens[i++];
const x = tokens[i++];
const y = tokens[i++];
const cp1x = 2 * curX - _prevCpx;
const cp1y = 2 * curY - _prevCpy;
if (cmd === 's') {
ctx.bezierCurveTo(cp1x, cp1y, curX + cp2x, curY + cp2y, curX + x, curY + y);
_prevCpx = curX + cp2x;
_prevCpy = curY + cp2y;
curX += x;
curY += y;
} else {
ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
_prevCpx = cp2x;
_prevCpy = cp2y;
curX = x;
curY = y;
}
lastCmd = cmd;
} else if (upperCmd === 'Q') {
const cpx = tokens[i++];
const cpy = tokens[i++];
const x = tokens[i++];
const y = tokens[i++];
if (cmd === 'q') {
ctx.quadraticCurveTo(curX + cpx, curY + cpy, curX + x, curY + y);
_prevCpx = curX + cpx;
_prevCpy = curY + cpy;
curX += x;
curY += y;
} else {
ctx.quadraticCurveTo(cpx, cpy, x, y);
_prevCpx = cpx;
_prevCpy = cpy;
curX = x;
curY = y;
}
lastCmd = cmd;
} else if (upperCmd === 'T') {
const x = tokens[i++];
const y = tokens[i++];
const refX = 2 * curX - _prevCpx;
const refY = 2 * curY - _prevCpy;
if (cmd === 't') {
ctx.quadraticCurveTo(refX, refY, curX + x, curY + y);
_prevCpx = refX;
_prevCpy = refY;
curX += x;
curY += y;
} else {
ctx.quadraticCurveTo(refX, refY, x, y);
_prevCpx = refX;
_prevCpy = refY;
curX = x;
curY = y;
}
lastCmd = cmd;
} else if (upperCmd === 'A') {
const rx = tokens[i++];
const ry = tokens[i++];
const xRot = tokens[i++];
const largeArc = tokens[i++];
const sweep = tokens[i++];
const x = tokens[i++];
const y = tokens[i++];
const endX = cmd === 'a' ? curX + x : x;
const endY = cmd === 'a' ? curY + y : y;
if (rx > 0 && ry > 0) {
ctx.ellipse(
curX,
curY,
Math.abs(rx),
Math.abs(ry),
(xRot * Math.PI) / 180,
0,
Math.PI * 2
);
}
ctx.lineTo(endX, endY);
curX = endX;
curY = endY;
lastCmd = cmd;
} else if (upperCmd === 'Z') {
ctx.closePath();
curX = startX;
curY = startY;
lastCmd = cmd;
} else {
i++;
}
}
};

const drawSvgNode = (node, ctx) => {
if (node.nodeType !== 1) return;

ctx.save();

const opacity = parseFloat(node.getAttribute('opacity') || '1');
if (opacity < 1) {
ctx.globalAlpha *= opacity;
}

const transform = node.getAttribute('transform');
if (transform) {
applyTransform(transform, ctx);
}

const fillVal = node.getAttribute('fill') || node.style.fill;
const strokeVal = node.getAttribute('stroke') || node.style.stroke;
const strokeWidthVal = node.getAttribute('stroke-width') || node.style.strokeWidth || '1';
const strokeDashArray =
node.getAttribute('stroke-dasharray') || node.style.strokeDasharray;

function setFill() {
if (fillVal && fillVal !== 'none') {
ctx.fillStyle = fillVal;
return true;
}
if (!fillVal) {
ctx.fillStyle = '#000000';
return true;
}
return false;
}

function setStroke() {
if (strokeVal && strokeVal !== 'none') {
ctx.strokeStyle = strokeVal;
ctx.lineWidth = parseFloat(strokeWidthVal);
if (strokeDashArray) {
const dashes = strokeDashArray.split(/[\s,]+/).map(parseFloat);
ctx.setLineDash(dashes);
} else {
ctx.setLineDash([]);
}
return true;
}
return false;
}

const tag = node.nodeName.toLowerCase();

if (tag === 'svg' || tag === 'g') {
for (let j = 0; j < node.childNodes.length; j++) {
drawSvgNode(node.childNodes[j], ctx);
}
} else if (tag === 'line') {
const x1 = parseFloat(node.getAttribute('x1') || '0');
const y1 = parseFloat(node.getAttribute('y1') || '0');
const x2 = parseFloat(node.getAttribute('x2') || '0');
const y2 = parseFloat(node.getAttribute('y2') || '0');

ctx.beginPath();
ctx.moveTo(x1, y1);
ctx.lineTo(x2, y2);
if (setStroke()) ctx.stroke();
} else if (tag === 'rect') {
const x = parseFloat(node.getAttribute('x') || '0');
const y = parseFloat(node.getAttribute('y') || '0');
const w = parseFloat(node.getAttribute('width') || '0');
const h = parseFloat(node.getAttribute('height') || '0');
const rx = parseFloat(node.getAttribute('rx') || '0');
const ry = parseFloat(node.getAttribute('ry') || '0');

ctx.beginPath();
if (rx > 0 || ry > 0) {
if (typeof ctx.roundRect === 'function') {
ctx.roundRect(x, y, w, h, [rx, ry]);
} else {
const r = Math.min(rx || ry, w / 2, h / 2);
ctx.moveTo(x + r, y);
ctx.lineTo(x + w - r, y);
ctx.arcTo(x + w, y, x + w, y + h, r);
ctx.lineTo(x + w, y + h - r);
ctx.arcTo(x + w, y + h, x, y + h, r);
ctx.lineTo(x + r, y + h);
ctx.arcTo(x, y + h, x, y, r);
ctx.lineTo(x, y + r);
ctx.arcTo(x, y, x + w, y, r);
ctx.closePath();
}
} else {
ctx.rect(x, y, w, h);
}

if (setFill()) ctx.fill();
if (setStroke()) ctx.stroke();
} else if (tag === 'circle') {
const cx = parseFloat(node.getAttribute('cx') || '0');
const cy = parseFloat(node.getAttribute('cy') || '0');
const r = parseFloat(node.getAttribute('r') || '0');

ctx.beginPath();
ctx.arc(cx, cy, r, 0, 2 * Math.PI);

if (setFill()) ctx.fill();
if (setStroke()) ctx.stroke();
} else if (tag === 'polygon') {
const pointsStr = node.getAttribute('points');
if (pointsStr) {
const coords = pointsStr
.trim()
.split(/[\s,]+/)
.map(parseFloat);
if (coords.length >= 4 && coords.length % 2 === 0) {
ctx.beginPath();
ctx.moveTo(coords[0], coords[1]);
for (let k = 2; k < coords.length; k += 2) {
ctx.lineTo(coords[k], coords[k + 1]);
}
ctx.closePath();
if (setFill()) ctx.fill();
if (setStroke()) ctx.stroke();
}
}
} else if (tag === 'path') {
const d = node.getAttribute('d');
if (d) {
drawPath(d, ctx);
if (setFill()) ctx.fill();
if (setStroke()) ctx.stroke();
}
} else if (tag === 'text') {
const x = parseFloat(node.getAttribute('x') || '0');
const y = parseFloat(node.getAttribute('y') || '0');
const text = node.textContent || '';

const fontStyle = node.getAttribute('font-style') || node.style.fontStyle || '';
const fontWeight =
node.getAttribute('font-weight') || node.style.fontWeight || 'normal';
const fontSize = node.getAttribute('font-size') || node.style.fontSize || '12px';
const fontFamily =
node.getAttribute('font-family') || node.style.fontFamily || 'sans-serif';

ctx.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`
.trim()
.replace(/\s+/g, ' ');

const anchor = node.getAttribute('text-anchor') || node.style.textAnchor || 'start';
if (anchor === 'middle') ctx.textAlign = 'center';
else if (anchor === 'end') ctx.textAlign = 'right';
else ctx.textAlign = 'left';

const baseline =
node.getAttribute('dominant-baseline') || node.style.dominantBaseline || '';
if (baseline === 'middle' || baseline === 'central') ctx.textBaseline = 'middle';
else ctx.textBaseline = 'alphabetic';

if (setFill()) ctx.fillText(text, x, y);
if (setStroke()) ctx.strokeText(text, x, y);
}

ctx.restore();
};

const parser = new DOMParser();
const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');
const svgRoot = svgDoc.documentElement;

const canvas = document.createElement('canvas');
canvas.width = width * 2;
canvas.height = height * 2;

const context = canvas.getContext('2d');

const bgVal = svgRoot.style.backgroundColor || '#ffffff';
context.fillStyle = bgVal === 'transparent' ? '#ffffff' : bgVal;
context.fillRect(0, 0, canvas.width, canvas.height);

context.scale(2, 2);
context.translate(-minX, -minY);

drawSvgNode(svgRoot, context);

const pngBase64 = canvas.toDataURL('image/png');
resolve(pngBase64);
} catch (e) {
reject(e);
}
});
},
exportPngFromSvg: async function (svgElement, defaultFilename) {
if (!svgElement) {
if (window.showToast) window.showToast('找不到导出的图形', 'error');
return;
}
try {
if (window.showToast) window.showToast('正在转换为高分辨率 PNG...', 'info');
const pngBase64 = await window.UIUtils.svgToPngBase64(svgElement);
if (pngBase64) {
await saveExportDataUrl(pngBase64, defaultFilename, {
filterName: 'PNG 图片',
extensions: ['png'],
successMessage: 'PNG 已成功导出'
});
} else {
throw new Error('Canvas conversion returned empty base64');
}
} catch (e) {
console.error(e);
if (window.showToast) window.showToast('导出 PNG 失败: ' + e.message, 'error');
}
}
};

var _scheduledRedirectTimer = null;
var _scheduledRedirectNode = null;

window.cancelScheduledRedirect = function () {
if (_scheduledRedirectTimer) clearInterval(_scheduledRedirectTimer);
_scheduledRedirectTimer = null;
if (_scheduledRedirectNode) _scheduledRedirectNode.remove();
_scheduledRedirectNode = null;
};

window.scheduleRedirect = function (options) {
window.cancelScheduledRedirect();

var seconds = Number(options && options.seconds);
if (!Number.isFinite(seconds) || seconds <= 0) seconds = 3;
var collapse = !(options && options.noCollapse);
var target = (options && options.target) || 'page-report-library';
var onNavigate = options && options.onNavigate;
var container = document.getElementById('aiContent');

if (container) {
_scheduledRedirectNode = document.createElement('div');
_scheduledRedirectNode.className = 'ai-block report-redirect-countdown';
_scheduledRedirectNode.style.borderColor = 'var(--green-border)';
var heading = document.createElement('h4');
heading.textContent = '报告生成完成';
_scheduledRedirectNode.appendChild(heading);
container.appendChild(_scheduledRedirectNode);
}

function updateCountdown(remaining) {}

function finishRedirect() {
window.cancelScheduledRedirect();
if (collapse && window.collapseSidebar) window.collapseSidebar();
window.__scheduledRedirectNavigating = true;
try {
window.navigateTo(target);
} finally {
window.__scheduledRedirectNavigating = false;
}
if (onNavigate) setTimeout(onNavigate, 200);
}

var remaining = seconds;
updateCountdown(remaining);
_scheduledRedirectTimer = setInterval(function () {
remaining--;
if (remaining > 0) {
updateCountdown(remaining);
} else {
finishRedirect();
}
}, 1000);

return window.cancelScheduledRedirect;
};

window.esc = esc;
window.showToast = showToast;
window.showConfirm = showConfirm;
window.showConfirmWithOption = showConfirmWithOption;
window.truncate = truncate;
window.navigateTo = navigateTo;
window.registerPageHook = registerPageHook;
window.mdToHtml = mdToHtml;
window.safeSanitize = safeSanitize;
window.closeAllDialogs = closeAllDialogs;
window.getApiErrorHint = getApiErrorHint;
window.renderAiErrorBlock = renderAiErrorBlock;
