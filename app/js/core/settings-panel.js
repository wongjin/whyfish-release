/**
* settings-panel.js — 设置面板与 Provider 管理
* 从 app.js 提取（B4 拆分）
*/

document.getElementById('btnSettings')?.addEventListener('click', () => {
document.getElementById('unifiedSettingsModal')?.showModal();
});
document.getElementById('btnCloseUnifiedSettings')?.addEventListener('click', () => {
document.getElementById('unifiedSettingsModal')?.close();
});

document.getElementById('btnSaveSettings')?.addEventListener('click', async () => {
try {
const vals = collectProviderFormValues(getActiveProviderId());
const existing = getActiveConfig();
if (!vals.apiKey && existing.apiKey) {
vals.apiKey = existing.apiKey;
}

await saveActiveProviderConfig(vals);
await loadAllProviderConfigs();
document.getElementById('unifiedSettingsModal')?.close();
const providerName = PROVIDER_DEFS[getActiveProviderId()]?.name || getActiveProviderId();
showToast('已保存 ' + providerName + ' 设置', 'success');
} catch (err) {
console.error(err);
showToast('保存失败: ' + err.message, 'error');
}
});

function _setResultEl(el, state, text) {
if (!el) return;
el.style.display = 'block';
el.className = state ? 'connection-result ' + state : 'connection-result';
el.textContent = text;
}

document.getElementById('providerCards')?.addEventListener('click', handleProviderCardClick);
document.getElementById('providerCards')?.addEventListener('keydown', (e) => {
if (e.key === 'Enter' || e.key === ' ') {
const header = e.target.closest('.provider-card-header');
if (header) {
e.preventDefault();
handleProviderCardClick(e);
}
}
});

async function handleProviderCardClick(e) {
try {
const header = e.target.closest('.provider-card-header');
const testBtn = e.target.closest('.provider-test-btn');
const clearBtn = e.target.closest('.provider-clear-btn');

if (clearBtn) {
const providerId = clearBtn.dataset.provider;
const ok = await showConfirm('确定要清除该 Provider 的 API Key？', 'danger');
if (!ok) return;
const cfg = getProviderConfigs()[providerId] || {};
cfg.apiKey = '';
setProviderConfig(providerId, cfg);
await saveAllProviderConfigs();
if (typeof renderProviderCards === 'function') renderProviderCards();
const input = document.querySelector(`.provider-key-input[data-provider="${providerId}"]`);
if (input) input.value = '';
showToast('API Key 已清除', 'success');
return;
}

if (header) {
const providerId = header.dataset.provider;
if (!providerId) return;

if (getActiveProviderId() && getActiveProviderId() !== providerId) {
const currentVals = collectProviderFormValues(getActiveProviderId());
await saveActiveProviderConfig(currentVals);
}

setActiveProviderId(providerId);

document.querySelectorAll('.provider-card').forEach((card) => {
const isActive = card.dataset.provider === providerId;
card.classList.toggle('active', isActive);
const body = card.querySelector('.provider-card-body');
if (body) body.style.display = isActive ? 'block' : 'none';
});
return;
}

if (testBtn) {
if (testBtn.disabled) return;

const allTestBtns = document.querySelectorAll('.provider-test-btn');
allTestBtns.forEach((b) => {
b.disabled = true;
});
testBtn.textContent = '测试中...';

const providerId = testBtn.dataset.provider;
const resultEl = document.querySelector(
`.provider-test-result[data-provider="${providerId}"]`
);
const vals = collectProviderFormValues(providerId);

if (!vals.apiKey) {
const stored = getProviderConfigs()[providerId];
if (stored && stored.apiKey) {
vals.apiKey = stored.apiKey;
} else {
_setResultEl(resultEl, 'error', '请先输入 API Key');
allTestBtns.forEach((b) => {
b.disabled = false;
});
testBtn.textContent = ' 测试连接';
return;
}
}

_setResultEl(resultEl, '', '正在连接...');

const origProvider = getActiveProviderId();
setActiveProviderId(providerId);
const origConfig = getProviderConfigs()[providerId]
? JSON.parse(JSON.stringify(getProviderConfigs()[providerId]))
: undefined;
setProviderConfig(providerId, vals);

try {
await callAI(PROMPTS.connectionTest.system, PROMPTS.connectionTest.user, false, 100);
setProviderConfig(providerId, vals);
setActiveProviderId(providerId);
await saveAllProviderConfigs();
if (typeof renderProviderCards === 'function') renderProviderCards();
_setResultEl(resultEl, 'success', '连接成功！配置已自动保存。');
} catch (err) {
setActiveProviderId(origProvider);
if (origConfig) setProviderConfig(providerId, origConfig);
_setResultEl(resultEl, 'error', '连接失败: ' + err.message);
} finally {
allTestBtns.forEach((b) => {
b.disabled = false;
});
testBtn.textContent = ' 测试连接';
}
}
} catch (err) {
console.error(err);
showToast('操作失败: ' + err.message, 'error');
}
}
