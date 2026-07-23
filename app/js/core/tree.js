/**
* tree.js — 树渲染 + 节点操作
*
* 职责：DOM 渲染、树节点 CRUD、权重更新、证据管理
* 依赖：store.js（全局状态、esc/truncate/createNode/autoSave/findNode）
* ai.js（askAIForNode, getCausalKeyForNode, causalValidationResults, toggleCausalDetail）
* 被依赖：app.js
*/

(function () {

let editingNodeId = null;
const collapsedNodeIds = new Set();

function toggleCollapse(nodeId) {
if (collapsedNodeIds.has(nodeId)) {
collapsedNodeIds.delete(nodeId);
} else {
collapsedNodeIds.add(nodeId);
}
renderTree();
}

function countDescendants(node) {
let count = 0;
if (node.children) {
for (const child of node.children) {
count += 1 + countDescendants(child);
}
}
return count;
}

function renderTree() {
const canvas = document.getElementById('treeCanvas');

if (!canvas) return;
if (!tree) {
canvas.innerHTML = '';
return;
}
canvas.innerHTML = renderNode(tree);
}

function _renderNodeCard(node, parentNode) {
const isEditing = !node.text || editingNodeId === node.id;
const rootBadge = node.isRootCause ? ' root-cause' : '';

let html = `<div class="why-node-card${rootBadge}">`;

html += `<div class="why-node-header">`;
html += `<span class="why-level-badge${node.isRootCause ? ' root' : ''}">`;
html += node.isRootCause ? '根因' : node.parentId === null ? '问题' : `Why ${node.level - 1}`;
html += `</span>`;

html += `<div class="why-node-actions">`;
if (node.children.length > 0) {
const isCollapsed = collapsedNodeIds.has(node.id);
html += `<button class="btn btn-ghost btn-sm" data-action="toggle-collapse" data-id="${node.id}" title="${isCollapsed ? '展开' : '收起'}子树">${isCollapsed ? '展开' : '收起'}</button>`;
}
if (node.text && editingNodeId !== node.id && node.parentId !== null) {
html += `<button class="btn btn-ghost btn-sm" data-action="edit-node" data-id="${node.id}" title="编辑">编辑</button>`;
}
if (!node.isRootCause && node.text && node.parentId !== null) {
html += `<button class="btn btn-ghost btn-sm" data-action="mark-root-cause" data-id="${node.id}" title="标记为根因">根因</button>`;
}
if (node.isRootCause && node.parentId !== null) {
html += `<button class="btn btn-ghost btn-sm" data-action="unmark-root-cause" data-id="${node.id}" title="取消根因标记">取消根因</button>`;
}
if (node.parentId !== null) {
const aiLabel = isEditing ? 'AI 填写' : 'AI 改写';
html += `<button class="btn btn-ghost btn-sm" data-action="ask-ai" data-id="${node.id}" title="${aiLabel}当前 Why 原因">${aiLabel}</button>`;
}
if (node.parentId !== null) {
html += `<button class="btn btn-ghost btn-sm" data-action="remove-node" data-id="${node.id}" title="删除">删除</button>`;
}
html += `</div></div>`;

if (isEditing || document.activeElement?.dataset?.nodeId === String(node.id)) {
html += `<textarea class="why-input" data-action="node-textarea" data-node-id="${node.id}"
aria-label="第 ${node.parentId === null ? '问题' : node.level - 1} 层原因内容输入"
placeholder="${node.parentId === null ? '描述问题现象...' : '为什么会发生上一层的问题？输入原因...'}">${esc(node.text)}</textarea>`;
html += `<button class="btn btn-primary btn-sm why-confirm-btn" data-action="confirm-node" data-id="${node.id}">确认</button>`;
} else {
html += `<div class="why-text">${esc(node.text)}</div>`;
}

if (node.text && node.parentId !== null) {
const pn = parentNode;
const pt = pn?.text || problemStatement;
html += `<div class="causal-hint"><span class="arrow-up">\u2191</span> `;
html += `因为\u300C${esc(truncate(node.text, 30))}\u300D\u2192 所以\u300C${esc(truncate(pt, 30))}\u300D</div>`;
}

html += `<div class="evidence-row">`;
node.evidence.forEach((e, i) => {
html += `<span class="evidence-tag">\uD83D\uDCCE ${esc(e)}</span>`;
});
html += `<button class="evidence-add" data-action="add-evidence" data-id="${node.id}">+ 证据</button>`;
html += `</div>`;

const parent = parentNode;
if (parent && parent.children.length > 1) {
html += `<div class="weight-control">`;
html += `<label for="weight-slider-${node.id}" class="weight-label">贡献度</label>`;
html += `<input type="range" class="weight-slider" data-action="update-weight" data-id="${node.id}" min="0" max="100" value="${node.weight}">`;
html += `<span class="weight-value" id="weight-val-${node.id}">${node.weight}%</span>`;
html += `</div>`;
}

if (node.text && node.parentId !== null) {
const vKey = getCausalKeyForNode(node, parentNode);
const v = causalValidationResults[vKey];
if (v) {
const cls = v.valid ? 'causal-badge-pass' : 'causal-badge-fail';
const icon = v.valid ? '\u2705' : '\u274c';
const label = v.valid ? '逻辑成立' : '逻辑存疑';
html += `<div class="causal-badge-inline ${cls}" data-action="toggle-causal-detail" data-id="${node.id}" tabindex="0" role="button">`;
html += `<span>${icon} ${label}</span>`;
html += `</div>`;
html += `<div class="causal-detail-inline" id="causal-detail-${node.id}" style="display:none">`;
html += `<p>${esc(v.reason || '')}</p></div>`;
}
}
html += `</div>`;
return html;
}

function _patchNode(nodeId, parentNode) {
const el = document.querySelector(`.why-node[data-id="${nodeId}"]`);
const node = nodeIndex.get(nodeId);
if (!el || !node) {
renderTree();
return;
}
const newCardHtml = _renderNodeCard(node, parentNode);
const oldCard = el.querySelector('.why-node-card');
if (oldCard) {
oldCard.outerHTML = newCardHtml;
} else {
renderTree();
}
}

function renderNode(node, parentNode = null) {
let html = `<div class="why-node" data-id="${node.id}" data-level="${node.level}">`;
html += _renderNodeCard(node, parentNode);

if (node.children.length > 0 && !collapsedNodeIds.has(node.id)) {
html += `<div class="why-children">`;
node.children.forEach((child) => {
html += renderNode(child, node);
});
html += `</div>`;
} else if (node.children.length > 0 && collapsedNodeIds.has(node.id)) {
const total = countDescendants(node);
html += `<div class="collapsed-hint" data-action="toggle-collapse" data-id="${node.id}" tabindex="0" role="button">▸ 已收起 ${total} 个子节点</div>`;
}

if (node.text && !node.isRootCause) {
const nextWhy = node.parentId === null ? 1 : node.level - 1 + 1;
html += `<button class="btn add-cause-btn" data-action="add-child" data-id="${node.id}">
+ 添加 Why ${nextWhy} 原因
</button>`;
}

html += `</div>`;
return html;
}

function addChild(parentId) {
const child = window.addTreeNode(parentId, '');
if (!child) return;

collapsedNodeIds.delete(parentId);
const parentEl = document.querySelector(`.why-node[data-id="${parentId}"]`);
if (!parentEl) {
renderTree();
return;
}

let childrenContainer = parentEl.querySelector('.why-children');
if (!childrenContainer) {
const hint = parentEl.querySelector('.collapsed-hint');
if (hint) hint.remove();
childrenContainer = document.createElement('div');
childrenContainer.className = 'why-children';
const addBtn = parentEl.querySelector('.add-cause-btn');
if (addBtn) {
addBtn.parentNode.insertBefore(childrenContainer, addBtn);
} else {
parentEl.appendChild(childrenContainer);
}
}

const parentNode = nodeIndex.get(parentId);
const childHtml = renderNode(child, parentNode);
childrenContainer.insertAdjacentHTML('beforeend', childHtml);

_patchNode(parentId, parentNode);

requestAnimationFrame(() => {
const input = document.querySelector(`textarea[data-node-id="${child.id}"]`);
if (input) input.focus({ preventScroll: true });
});
}

function removeNode(nodeId) {
const node = nodeIndex.get(nodeId);
const parentId = node ? node.parentId : null;

collapsedNodeIds.delete(nodeId);
window.removeTreeNode(nodeId);
const el = document.querySelector(`.why-node[data-id="${nodeId}"]`);
if (el) el.remove();
if (parentId) {
const parentNode = nodeIndex.get(parentId);

_patchNode(parentId, parentNode);
if (parentNode && parentNode.children.length === 0) {
const parentEl = document.querySelector(`.why-node[data-id="${parentId}"]`);
if (parentEl) {
const cc = parentEl.querySelector('.why-children');
if (cc) cc.remove();
}
}
}
}

function saveNodeText(nodeId, text) {
if (window.updateTreeNodeText(nodeId, text)) {
editingNodeId = null;
const node = nodeIndex.get(nodeId);
_patchNode(nodeId, node ? nodeIndex.get(node.parentId) : null);

if (node) {
const nodeEl = document.querySelector(`.why-node[data-id="${nodeId}"]`);
if (nodeEl) {
const existingBtn = nodeEl.querySelector('.add-cause-btn');
const shouldShow = node.text && !node.isRootCause;
if (shouldShow && !existingBtn) {
const nextWhy = node.parentId === null ? 1 : node.level - 1 + 1;
const btnHtml = `<button class="btn add-cause-btn" data-action="add-child" data-id="${nodeId}">+ 添加 Why ${nextWhy} 原因</button>`;
nodeEl.insertAdjacentHTML('beforeend', btnHtml);
} else if (!shouldShow && existingBtn) {
existingBtn.remove();
}
}
}
}
}

function editNode(nodeId) {
const node = nodeIndex.get(nodeId);
if (!node || node.parentId === null) return;
editingNodeId = nodeId;
renderTree();
requestAnimationFrame(() => {
const input = document.querySelector(`textarea[data-node-id="${nodeId}"]`);
if (input) {
input.focus({ preventScroll: true });
input.setSelectionRange(input.value.length, input.value.length);
}
});
}

function confirmNode(nodeId) {
const input = document.querySelector(`textarea[data-node-id="${nodeId}"]`);
if (input) {
input.blur();
}
}

function markRootCause(nodeId) {
if (window.setTreeNodeRootCause(nodeId, true)) {
renderTree();
}
}

function unmarkRootCause(nodeId) {
if (window.setTreeNodeRootCause(nodeId, false)) {
renderTree();
}
}

function updateWeight(nodeId, val) {
if (window.updateTreeNodeWeight(nodeId, val)) {
const label = document.getElementById(`weight-val-${nodeId}`);
if (label) label.textContent = val + '%';
}
}

let _currentEvidenceNodeId = null;

function openEvidenceModal(nodeId) {
_currentEvidenceNodeId = nodeId;

const input = document.getElementById('evidenceInput');
const modal = document.getElementById('evidenceModal');
if (!input || !modal) return;
input.value = '';
if (typeof closeAllDialogs === 'function') closeAllDialogs();
modal.showModal();
requestAnimationFrame(() => input.focus({ preventScroll: true }));
}

function closeEvidenceModal() {
_currentEvidenceNodeId = null;
const modal = document.getElementById('evidenceModal');
if (modal) modal.close();
}

function confirmEvidence() {
const input = document.getElementById('evidenceInput');
if (!input) {
closeEvidenceModal();
return;
}
const text = input.value;
if (text && text.trim() && _currentEvidenceNodeId) {
if (window.addTreeNodeEvidence(_currentEvidenceNodeId, text)) {
renderTree();
}
}
closeEvidenceModal();
}

function addEvidence(nodeId) {
openEvidenceModal(nodeId);
}

document.getElementById('btnCloseEvidenceModal')?.addEventListener('click', closeEvidenceModal);
document.getElementById('btnCancelEvidence')?.addEventListener('click', closeEvidenceModal);
document.getElementById('btnConfirmEvidence')?.addEventListener('click', confirmEvidence);
document.getElementById('evidenceInput')?.addEventListener('keydown', (e) => {
if (e.key === 'Enter' && !e.shiftKey) {
e.preventDefault();
confirmEvidence();
}
});
document.getElementById('evidenceModal')?.addEventListener('cancel', () => closeEvidenceModal());

document.getElementById('treeCanvas')?.addEventListener('pointerdown', (e) => {
if (e.target.closest('[data-action="ask-ai"]')) e.preventDefault();
});
document.getElementById('treeCanvas')?.addEventListener('click', handleTreeAction);
document.getElementById('treeCanvas')?.addEventListener('keydown', (e) => {
if (e.key === 'Enter' || e.key === ' ') {
const el = e.target.closest('[data-action]');
if (el) {
e.preventDefault();
handleTreeAction(e);
}
}
});
function handleTreeAction(e) {
const el = e.target.closest('[data-action]');
if (!el) return;
const action = el.dataset.action;
const id = el.dataset.id ? Number(el.dataset.id) : null;

if (id === null || isNaN(id)) return;
switch (action) {
case 'toggle-collapse':
toggleCollapse(id);
break;
case 'edit-node':
editNode(id);
break;
case 'mark-root-cause':
markRootCause(id);
break;
case 'unmark-root-cause':
unmarkRootCause(id);
break;
case 'ask-ai':
{
const draft = document.querySelector(`textarea[data-node-id="${id}"]`);
if (draft) window.updateTreeNodeText(id, draft.value);
}
askAIForNode(id);
break;
case 'remove-node':
removeNode(id);
break;
case 'confirm-node':
confirmNode(id);
break;
case 'add-evidence':
addEvidence(id);
break;
case 'add-child':
addChild(id);
break;
case 'toggle-causal-detail':
toggleCausalDetail(id);
break;
}
}

document.getElementById('treeCanvas')?.addEventListener(
'blur',
(e) => {
const el = e.target.closest('[data-action="node-textarea"]');
if (!el) return;
const nodeId = Number(el.dataset.nodeId);
saveNodeText(nodeId, el.value);
},
true
);

document.getElementById('treeCanvas')?.addEventListener('keydown', (e) => {
const el = e.target.closest('[data-action="node-textarea"]');
if (!el) return;
if (e.key === 'Enter' && !e.shiftKey) {
e.preventDefault();
el.blur();
}
});

document.getElementById('treeCanvas')?.addEventListener('input', (e) => {
const el = e.target.closest('[data-action="update-weight"]');
if (!el) return;
const nodeId = Number(el.dataset.id);
updateWeight(nodeId, el.value);
});

window.renderTree = renderTree;
window.toggleCollapse = toggleCollapse;
window.collapsedNodeIds = collapsedNodeIds;
window.addChild = addChild;
})();
