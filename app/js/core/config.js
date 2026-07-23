/**
* config.js — 模型配置管理（Provider 隔离架构）
*
* 设计原则：
* - 每个 Provider 独立配置（API Key、模型、端点）
* - 同一时刻只有一个 Provider 处于激活状态
* - 所有配置持久化到 localStorage，互相不干扰
* - 连接测试基于当前选中 Provider 的配置
*
* 依赖：store.js（showToast, esc 全局函数）
* 被依赖：ai.js, app.js
*/

const PROVIDER_DEFS = {
deepseek: {
name: 'DeepSeek',
type: 'openai',
baseUrl: 'https://api.deepseek.com/chat/completions',
keyLabel: 'DeepSeek API Key',
keyPlaceholder: 'sk-...',
keyLink: 'https://platform.deepseek.com/api_keys',
keyLinkText: '获取 Key →',
models: [
{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }
],
defaultModel: 'deepseek-v4-flash',
needsEndpointId: false
},
custom: {
name: '自定义',
type: 'openai',
keyLabel: 'API Key',
keyPlaceholder: '输入 API Key...',
keyLink: '',
keyLinkText: '',
models: [],
defaultModel: '',
needsEndpointId: false
}
};

const VISIBLE_PROVIDERS = ['deepseek', 'custom'];

let activeProviderId = 'deepseek';

let providerConfigs = {};

function getActiveProviderId() {
return activeProviderId;
}
function setActiveProviderId(id) {
activeProviderId = id;
}
function getProviderConfigs() {
return { ...providerConfigs };
}
function setProviderConfig(id, cfg) {
providerConfigs[id] = cfg;
}

/** 获取当前激活 provider 的配置 */
function getActiveConfig() {
return { ...(providerConfigs[activeProviderId] || {}) };
}

/** 获取当前 API Key */
function getActiveApiKey() {
return getActiveConfig().apiKey || '';
}

/** 获取当前模型名 */
function getActiveModel() {
const cfg = getActiveConfig();
const def = PROVIDER_DEFS[activeProviderId];
if (activeProviderId === 'custom') return cfg.customModel || '';
const storedModel = cfg.model || def?.defaultModel || '';

const validModels = def?.models?.map((m) => m.id) || [];
if (validModels.includes(storedModel)) {
return storedModel;
}

return def?.defaultModel || '';
}

/** 获取当前 API 端点 URL */
function getActiveEndpoint() {
const def = PROVIDER_DEFS[activeProviderId];
if (activeProviderId === 'custom') {
return getActiveConfig().customEndpoint || '';
}
return def?.baseUrl || '';
}

const CONFIG_STORAGE_KEY = 'qa-provider-configs';

async function loadAllProviderConfigs() {
try {
let raw = null;
if (typeof window.pluginLoad === 'function') {
raw = await window.pluginLoad(CONFIG_STORAGE_KEY);
}

if (raw) {
if (raw._activeProviderId) {
activeProviderId = raw._activeProviderId;
delete raw._activeProviderId;
}
providerConfigs = raw;
} else {
providerConfigs = {};
}

if (
!activeProviderId ||
!PROVIDER_DEFS[activeProviderId] ||
!VISIBLE_PROVIDERS.includes(activeProviderId)
) {
activeProviderId = VISIBLE_PROVIDERS[0] || 'deepseek';
}
} catch (e) {
console.error('Failed to load provider configs:', e);
throw e;
}
}

async function saveAllProviderConfigs() {
try {
const toStore = JSON.parse(JSON.stringify(providerConfigs));
toStore._activeProviderId = activeProviderId;
if (typeof window.pluginSave === 'function') {
await window.pluginSave(CONFIG_STORAGE_KEY, toStore);
}
} catch (e) {
console.warn('Failed to save provider configs:', e);
}
}

async function saveActiveProviderConfig(cfg) {
const existing = getActiveConfig();
const merged = { ...existing, ...cfg };

if (cfg.apiKey === '' && existing.apiKey) {
merged.apiKey = existing.apiKey;
}
if (cfg.customEndpoint === '' && existing.customEndpoint) {
merged.customEndpoint = existing.customEndpoint;
}
if (cfg.customModel === '' && existing.customModel) {
merged.customModel = existing.customModel;
}

if (activeProviderId === 'custom' && merged.customEndpoint) {
const ep = merged.customEndpoint.trim();
if (!/^https?:\/\//i.test(ep)) {
if (typeof showToast === 'function') {
showToast('端点 URL 必须以 http:// 或 https:// 开头', 'error');
}
return;
}
}
providerConfigs[activeProviderId] = merged;
await saveAllProviderConfigs();
}

/** 渲染 settings modal 中的 provider 卡片列表 */

function renderProviderCards() {
const container = document.getElementById('providerCards');
if (!container) return;

let html = '';
Object.entries(PROVIDER_DEFS).forEach(([id, def]) => {
if (!VISIBLE_PROVIDERS.includes(id)) return;
const cfg = providerConfigs[id] || {};
const isActive = id === activeProviderId;
const hasKey = !!cfg.apiKey;
const model = id === 'custom' ? cfg.customModel || '未设置' : cfg.model || def.defaultModel;

html += `<div class="provider-card ${isActive ? 'active' : ''}" data-provider="${id}">`;
html += `<div class="provider-card-header" data-provider="${id}" tabindex="0" role="button">`;
html += `<div class="provider-card-info">`;
html += `<span class="provider-card-name">${esc(def.name)}</span>`;
html += `<span class="provider-card-meta">${esc(model)}</span>`;
html += `</div>`;
html += `<div class="provider-card-status">`;
if (isActive) html += `<span class="provider-badge active">当前</span>`;
if (hasKey) html += `<span class="provider-badge configured">✓</span>`;
else html += `<span class="provider-badge unconfigured">未配置</span>`;
html += `</div>`;
html += `</div>`;

html += `<div class="provider-card-body" id="providerBody-${id}" style="display:${isActive ? 'block' : 'none'}">`;
html += renderProviderConfigForm(id, def, cfg);
html += `</div>`;
html += `</div>`;
});

container.innerHTML = html;

}

/** 渲染单个 provider 的配置表单 */
function renderProviderConfigForm(id, def, cfg) {
let html = '';

html += `<div class="form-group">`;
html += `<label for="provider-key-${id}">${esc(def.keyLabel)}</label>`;
html += `<input type="password" id="provider-key-${id}" class="input-field provider-key-input" data-provider="${id}" `;
html += `placeholder="${cfg.apiKey ? '已配置（输入新值可替换，清空不会删除）' : esc(def.keyPlaceholder || '输入 API Key...')}" value="">`;
if (def.keyLink) {
html += `<p class="form-hint">仅存储在本地应用。<a href="${esc(def.keyLink)}" target="_blank">${esc(def.keyLinkText)}</a></p>`;
} else {
html += `<p class="form-hint">仅存储在本地应用。清空输入框不会删除已配置的 Key，请点击"清除 Key"按钮</p>`;
}
html += `<p class="form-hint form-hint-warning">⚠ Key 以明文存储在本地应用中，请勿在公共设备上保存。</p>`;
html += `</div>`;

if (id === 'custom') {
html += `<div class="form-group">`;
html += `<label for="provider-endpoint-${id}">API 端点 URL</label>`;
html += `<input type="text" id="provider-endpoint-${id}" class="input-field provider-endpoint-input" data-provider="${id}" `;
html += `placeholder="https://your-api.com/v1/chat/completions" value="${esc(cfg.customEndpoint || '')}">`;
html += `<p class="form-hint">需兼容 OpenAI Chat Completions 格式</p>`;
html += `</div>`;
html += `<div class="form-group">`;
html += `<label for="provider-custom-model-${id}">模型名称</label>`;
html += `<input type="text" id="provider-custom-model-${id}" class="input-field provider-custom-model-input" data-provider="${id}" `;
html += `placeholder="gpt-5.5, claude-sonnet-4-6..." value="${esc(cfg.customModel || '')}">`;
html += `</div>`;
} else {

html += `<div class="form-group">`;
html += `<label for="provider-model-select-${id}">模型</label>`;
html += `<select id="provider-model-select-${id}" class="input-field provider-model-select" data-provider="${id}">`;
def.models.forEach((m) => {
const selected = (cfg.model || def.defaultModel) === m.id ? ' selected' : '';
html += `<option value="${esc(m.id)}"${selected}>${esc(m.name)}</option>`;
});
html += `</select>`;
html += `</div>`;
}

html += `<div class="provider-actions">`;
html += `<button type="button" class="btn btn-outline btn-sm flex-1 provider-test-btn" data-provider="${id}">测试连接</button>`;
html += `<button type="button" class="btn btn-danger btn-sm flex-0 provider-clear-btn" data-provider="${id}">清除 Key</button>`;
html += `</div>`;
html += `<div class="connection-result provider-test-result" data-provider="${id}" style="display:none"></div>`;

return html;
}

/** 收集指定 provider 表单中的配置值 */
function collectProviderFormValues(providerId) {
const result = {};
const container = document.getElementById('providerBody-' + providerId);
if (!container) return result;

const keyInput = container.querySelector('.provider-key-input');
if (keyInput) result.apiKey = keyInput.value.trim();

const modelSelect = container.querySelector('.provider-model-select');
if (modelSelect) result.model = modelSelect.value;

const endpointInput = container.querySelector('.provider-endpoint-input');
if (endpointInput) result.customEndpoint = endpointInput.value.trim();

const customModelInput = container.querySelector('.provider-custom-model-input');
if (customModelInput) result.customModel = customModelInput.value.trim();

return result;
}

window.PROVIDER_DEFS = PROVIDER_DEFS;
window.getActiveProviderId = getActiveProviderId;
window.setActiveProviderId = setActiveProviderId;
window.getProviderConfigs = getProviderConfigs;
window.setProviderConfig = setProviderConfig;
window.renderProviderCards = renderProviderCards;

async function loadSettings() {

try {
await loadAllProviderConfigs();
} catch (e) {
console.error('[loadSettings] Failed to load provider configs, using defaults:', e);
providerConfigs = {};
activeProviderId = VISIBLE_PROVIDERS[0] || 'deepseek';
if (typeof showToast === 'function') {
showToast('配置加载失败，已重置为默认设置', 'warning');
}
}
renderProviderCards();
}
