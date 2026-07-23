/**
* knowledge.js — WhyFish 方法知识库页面渲染
*
* 依赖：tool-knowledge.js（window.QualityToolKB）
* 全局暴露：window.KnowledgeBase
*/
(function () {
'use strict';

const esc = window.esc;
if (typeof esc !== 'function') {
throw new Error('[knowledge.js] window.esc 未加载，请检查 ui-utils.js 加载顺序');
}

const CATEGORY_ORDER = ['define', 'explore', 'analyze', 'verify'];
let containerEl = null;
let currentView = 'list';
let currentToolId = null;

function getCategoryName(categoryId) {
const category = window.QualityToolKB.TOOL_CATEGORIES[categoryId];
return category ? category.name : categoryId;
}

function renderList(items, className) {
return (
'<ul class="kb-list ' +
esc(className || '') +
'">' +
items.map((item) => '<li>' + esc(item) + '</li>').join('') +
'</ul>'
);
}

function renderSection(title, content) {
return (
'<div class="kb-section">' +
'<h3 class="kb-section-title">' +
esc(title) +
'</h3>' +
'<div class="kb-section-body">' +
content +
'</div>' +
'</div>'
);
}

function renderToolCard(tool) {
const tagsHtml = tool.tags
.slice(0, 3)
.map((tag) => '<span class="kb-tag">' + esc(tag) + '</span>')
.join('');

return (
'<div class="kb-tool-card" data-tool="' +
esc(tool.id) +
'" tabindex="0" role="button" aria-label="查看' +
esc(tool.name) +
'详情">' +
'<div class="kb-tool-header"><div class="kb-tool-title">' +
'<h3>' +
esc(tool.name) +
'</h3>' +
'<span class="kb-tool-category">' +
esc(getCategoryName(tool.category)) +
'</span>' +
'</div></div>' +
'<p class="kb-tool-desc">' +
esc(tool.description) +
'</p>' +
'<div class="kb-tool-tags">' +
tagsHtml +
'</div>' +
'<div class="kb-tool-hint">点击查看详情 →</div>' +
'</div>'
);
}

function renderUsageNoticeCard() {
return (
'<aside class="kb-info-card" aria-labelledby="usageInformationTitle">' +
'<div class="kb-tool-header"><div class="kb-tool-title">' +
'<h3 id="usageInformationTitle">WhyFish 使用声明</h3>' +
'</div></div>' +
'<p class="kb-info-desc">WhyFish 用于辅助问题分析，不替代专业人员的调查、判断和批准。' +
'AI 生成内容可能存在遗漏、错误或不合理推断，请结合客观证据和适用程序复核。</p>' +
'</aside>'
);
}

function renderListView() {
currentView = 'list';
currentToolId = null;
if (!containerEl) return;

const orderedTools = CATEGORY_ORDER.flatMap((categoryId) => {
return window.QualityToolKB.getToolsByCategory(categoryId);
});
const html =
'<div class="kb-category-group">' +
'<div class="kb-category-header">' +
'<h2 class="kb-cat-title">WhyFish 方法路径</h2>' +
'<span class="kb-cat-desc">从问题定义到原因验证，按当前任务选择方法</span>' +
'</div>' +
'<div class="kb-tools-grid">' +
orderedTools.map(renderToolCard).join('') +
renderUsageNoticeCard() +
'</div>' +
'</div>';

containerEl.innerHTML = html || '<div class="kb-empty">暂无方法数据</div>';
containerEl.scrollTop = 0;
}

function renderRelationships(relationships) {
return (
'<div class="kb-combo-list">' +
relationships
.map((relationship) => {
const relatedTool = window.QualityToolKB.getToolById(relationship.tool);
const relatedName = relatedTool ? relatedTool.name : relationship.tool;
return (
'<div class="kb-combo-item">' +
'<span class="kb-combo-relation">' +
esc(relationship.label) +
'</span>' +
'<strong>' +
esc(relatedName) +
'</strong>' +
'<span class="kb-combo-desc">' +
esc(relationship.description) +
'</span>' +
'</div>'
);
})
.join('') +
'</div>'
);
}

function renderUseButton(tool) {
if (!tool.toolPage || !tool.toolPanel) return '';
return (
'<div class="kb-use-tool">' +
'<button class="btn btn-primary kb-use-btn" data-page="' +
esc(tool.toolPage) +
'" data-tool="' +
esc(tool.toolPanel) +
'">使用' +
esc(tool.name) +
'</button>' +
'</div>'
);
}

function renderDetailView(toolId) {
const tool = window.QualityToolKB.getToolById(toolId);
if (!tool) {
renderListView();
return;
}

currentView = 'detail';
currentToolId = toolId;
if (!containerEl) return;

const html =
'<button class="btn btn-outline btn-sm kb-back-btn" id="kbBackBtn">← 返回</button>' +
'<div class="kb-detail-header"><div class="kb-detail-info">' +
'<h2 class="kb-detail-title">' +
esc(tool.name) +
'</h2>' +
'<span class="kb-detail-cat">' +
esc(getCategoryName(tool.category)) +
'</span>' +
'</div></div>' +
renderSection(
'方法说明',
'<p>' + esc(tool.description) + '</p><p class="kb-source">' + esc(tool.source) + '</p>'
) +
renderSection('适合使用', renderList(tool.whenToUse)) +
renderSection('不适合单独使用', renderList(tool.notFor, 'kb-limitation')) +
renderSection('正确使用要点', renderList(tool.keyPoints)) +
renderSection('常见误区', renderList(tool.pitfalls, 'kb-limitation')) +
renderSection('与其他方法配合', renderRelationships(tool.relationships)) +
renderUseButton(tool);

containerEl.innerHTML = html;
containerEl.scrollTop = 0;
document.getElementById('kbBackBtn')?.addEventListener('click', renderListView);
}

function navigateToToolPage(pageId, toolPanelId) {
window.navigateTo(pageId, toolPanelId);
}

function handleKnowledgeAction(target) {
const useButton = target.closest('.kb-use-btn');
if (useButton) {
navigateToToolPage(useButton.dataset.page, useButton.dataset.tool);
return;
}

const card = target.closest('.kb-tool-card');
if (card && currentView === 'list' && card.dataset.tool) {
renderDetailView(card.dataset.tool);
}
}

function bindEvents() {
if (!containerEl) return;
containerEl.addEventListener('click', (event) => handleKnowledgeAction(event.target));
containerEl.addEventListener('keydown', (event) => {
if (event.key !== 'Enter' && event.key !== ' ') return;
const actionTarget = event.target.closest('.kb-tool-card, .kb-use-btn');
if (!actionTarget) return;
event.preventDefault();
handleKnowledgeAction(actionTarget);
});
}

function init() {
if (
!window.QualityToolKB ||
typeof window.QualityToolKB.getToolById !== 'function' ||
typeof window.QualityToolKB.getToolsByCategory !== 'function' ||
!window.QualityToolKB.TOOL_CATEGORIES
) {
console.error('[KnowledgeBase] 依赖模块未加载：tool-knowledge.js');
return;
}
containerEl = document.getElementById('knowledgeContent');
bindEvents();
renderListView();
}

if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', init);
} else {
init();
}

window.KnowledgeBase = {
renderList: renderListView,
renderDetail: renderDetailView,
getCurrentView: () => currentView,
getCurrentToolId: () => currentToolId
};
})();
