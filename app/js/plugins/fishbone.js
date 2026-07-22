/**
 * fishbone.js — 鱼骨图表单录入与数据管理
 *
 * 职责：5M1E 分类的原因录入、数据持久化、Markdown 导出
 * 依赖：store.js（showToast, esc）
 * fishbone-svg.js（SVG 生成）
 * 被依赖：app.js
 */
(function () {
  'use strict';

  const FB_STORAGE_KEY_BASE = 'qa-fishbone';
  const MAX_TITLE_LEN = 50;
  const TITLE_TRUNCATE_LEN = 30;
  const HIGH_RISK_RATIO = 40;
  const MED_RISK_RATIO = 20;
  const SAVE_DEBOUNCE_MS = 1000;
  let _saveTimer = null;
  let lastAiSummary = '';
  let _fbZoomAbort = null;
  let _fishboneOwnerPid = null;

  /** Fix H2: scope plugin storage key to the active problem */
  function _fbStorageKey(pid) {
    const activePid = pid || (typeof getActiveProblemId === 'function' ? getActiveProblemId() : '');
    return activePid ? FB_STORAGE_KEY_BASE + '-' + activePid : FB_STORAGE_KEY_BASE;
  }

  /** 5M1E 分类定义（从 fishbone-svg.js 获取，消除循环依赖） */
  const CATEGORIES = window.FishboneSVG ? window.FishboneSVG.CATEGORIES : [];

  /** 鱼骨图数据模型 */
  let fishboneData = {
    problem: '',
    phenomenon: '', // 问题现象描述（用于 AI 分析）
    categories: {}, // { [catId]: [{ text, subCauses: [string] }] }
    savedAt: null,
    importedContext: '', // 从问题库导入的背景信息
    theme: 'premium'
  };

  // Initialize categories
  CATEGORIES.forEach((cat) => {
    if (!fishboneData.categories[cat.id]) {
      fishboneData.categories[cat.id] = [];
    }
  });

  /** 渲染 5M1E 分类表单 */
  function renderCategories() {
    const container = document.getElementById('fishboneCategories');
    if (!container) return;

    let html = '';
    CATEGORIES.forEach(({ id, name }) => {
      const causes = fishboneData.categories[id] || [];
      html += `<div class="fishbone-category" data-cat="${id}">`;
      html += `<div class="fishbone-category-header">`;
      html += `<span class="fishbone-category-title">${esc(name)}</span>`;
      html += `<div class="fishbone-category-actions">`;
      html += `<button type="button" class="btn btn-outline btn-sm fishbone-ai-suggest" data-cat="${id}" title="AI 为该维度建议原因" aria-label="AI 为 ${esc(name)} 维度建议原因">AI 建议</button>`;
      html += `<button type="button" class="btn btn-outline btn-sm fishbone-add-cause" data-cat="${id}" aria-label="在 ${esc(name)} 维度添加原因">+ 添加原因</button>`;
      html += `</div></div>`;
      html += `<div class="fishbone-cause-list" id="fb-causes-${id}">`;

      if (causes.length > 0) {
        causes.forEach((cause, ci) => {
          html += renderCauseItem(id, ci, cause);
        });
      }

      html += `</div></div>`;
    });

    container.innerHTML = html;
  }

  /** 渲染单个原因项 */
  function renderCauseItem(catId, causeIdx, cause) {
    const cat = CATEGORIES.find((c) => c.id === catId);
    const catName = cat ? cat.name : catId;
    let html = `<div class="fishbone-cause-item" data-cat="${catId}" data-idx="${causeIdx}">`;
    const causeId = `fb-cause-${catId}-${causeIdx}`;
    html += `<label for="${causeId}" class="sr-only">${esc(catName)} 分类的第 ${causeIdx + 1} 个原因</label>`;
    html += `<input type="text" id="${causeId}" class="input-field fishbone-cause-input" data-cat="${catId}" data-idx="${causeIdx}" `;
    html += `aria-label="${esc(catName)} 分类的第 ${causeIdx + 1} 个原因" `;
    html += `placeholder="原因 ${causeIdx + 1}" value="${esc(cause.text || '')}">`;
    html += `<button type="button" class="btn btn-outline btn-sm fishbone-ai-expand" data-cat="${catId}" data-idx="${causeIdx}" title="AI 展开子原因" aria-label="AI 为 ${esc(catName)} 的第 ${causeIdx + 1} 个原因展开子原因">AI</button>`;
    html += `<button type="button" class="btn btn-outline btn-sm fishbone-add-sub" data-cat="${catId}" data-idx="${causeIdx}" title="添加子原因" aria-label="在 ${esc(catName)} 的第 ${causeIdx + 1} 个原因下添加子原因">↳</button>`;
    html += `<button type="button" class="btn-close fishbone-remove-cause" style="font-size: 20px; line-height: 1; padding: 0 4px;" data-cat="${catId}" data-idx="${causeIdx}" title="删除" aria-label="删除 ${esc(catName)} 的第 ${causeIdx + 1} 个原因">×</button>`;
    html += `</div>`;

    // Sub-causes
    if (cause.subCauses && cause.subCauses.length > 0) {
      html += `<div class="fishbone-sub-causes">`;
      cause.subCauses.forEach((sub, si) => {
        html += `<div class="fishbone-sub-item" data-cat="${catId}" data-ci="${causeIdx}" data-si="${si}">`;
        const subId = `fb-sub-${catId}-${causeIdx}-${si}`;
        html += `<label for="${subId}" class="sr-only">${esc(catName)} 分类原因 ${causeIdx + 1} 的第 ${si + 1} 个子原因</label>`;
        html += `<input type="text" id="${subId}" class="input-field fishbone-sub-input" data-cat="${catId}" data-ci="${causeIdx}" data-si="${si}" `;
        html += `aria-label="${esc(catName)} 分类原因 ${causeIdx + 1} 的第 ${si + 1} 个子原因" `;
        html += `placeholder="子原因" value="${esc(sub)}">`;
        html += `<button type="button" class="btn-close fishbone-remove-sub" style="font-size: 16px; line-height: 1; padding: 0 4px;" data-cat="${catId}" data-ci="${causeIdx}" data-si="${si}" title="删除子原因" aria-label="删除 ${esc(catName)} 分类原因 ${causeIdx + 1} 的第 ${si + 1} 个子原因">×</button>`;
        html += `</div>`;
      });
      html += `</div>`;
    }

    return html;
  }

  /** 获取问题描述 + 导入上下文（供 AI 调用） */
  function getProblemWithContext() {
    // 优先使用现象描述作为分析基础；若无则退化到标题
    const phenomenon = (fishboneData.phenomenon || '').trim();
    const title = (fishboneData.problem || '').trim();
    let statement = phenomenon || title;

    // 若现象描述与标题都有，在开头附上标题以便 AI 了解简明问题名称
    if (phenomenon && title && phenomenon !== title) {
      statement = `【问题标题】${title}\n【现象描述】${phenomenon}`;
    }

    if (fishboneData.importedContext) {
      return statement + '\n\n【背景信息】\n' + fishboneData.importedContext;
    }
    return statement;
  }

  /** 收集表单数据到 fishboneData */
  function collectFormData() {
    fishboneData.problem = (document.getElementById('fishbone-problem')?.value || '').trim();
    fishboneData.phenomenon = (
      document.getElementById('fishbone-phenomenon-ref')?.value || ''
    ).trim();

    const allCauseInputs = Array.from(document.querySelectorAll('.fishbone-cause-input'));
    const allSubInputs = Array.from(document.querySelectorAll('.fishbone-sub-input'));

    const subInputsByCause = {};
    allSubInputs.forEach((sub) => {
      const key = `${sub.dataset.cat}-${sub.dataset.ci}`;
      if (!subInputsByCause[key]) subInputsByCause[key] = [];
      subInputsByCause[key].push(sub);
    });

    CATEGORIES.forEach((cat) => {
      const causes = [];
      const causeInputs = allCauseInputs.filter((input) => input.dataset.cat === cat.id);

      causeInputs.forEach((input, i) => {
        const text = input.value.trim();
        const subCauses = [];
        const subInputs = subInputsByCause[`${cat.id}-${i}`] || [];

        subInputs.forEach((subInput) => {
          const subText = subInput.value.trim();
          if (subText) subCauses.push(subText);
        });
        causes.push({ text, subCauses });
      });
      fishboneData.categories[cat.id] = causes;
    });
  }

  /** 持久化到 IndexedDB */
  async function saveFishboneData(_capturedPid, _capturedData) {
    if (_capturedPid === undefined) {
      _capturedPid =
        typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
    }
    let dataToSave;
    if (_capturedData) {
      // P0-1: 使用 debounce 触发时快照的数据，而非 fire-time 的 DOM（防切问题后 DOM 被清空/覆盖）
      dataToSave = JSON.parse(JSON.stringify(_capturedData));
    } else {
      collectFormData();
      dataToSave = JSON.parse(JSON.stringify(fishboneData));
    }
    if (_capturedPid && typeof window.getProblemById === 'function') {
      const problem = window.getProblemById(_capturedPid);
      if (problem && problem._fromExample) {
        // P1-19: 示例模式下编辑不持久化，通过状态栏提示用户（不弹 toast 避免骚扰）
        if (typeof window.setSaveStatus === 'function') {
          window.setSaveStatus('示例模式：编辑不会保存');
        }
        return;
      }
    }
    dataToSave.savedAt = new Date().toISOString();
    if (!_capturedData) {
      fishboneData.savedAt = dataToSave.savedAt;
    }

    // 1. 持久化到 IndexedDB
    try {
      if (typeof window.pluginSave === 'function') {
        await window.pluginSave(_fbStorageKey(_capturedPid), JSON.parse(JSON.stringify(dataToSave)));
      }
    } catch (e) {
      console.warn('Failed to save fishbone data:', e);
      showToast('保存失败', 'error');
    }

    // 2. 同步到问题库（独立错误边界）
    try {
      syncToProblemLibrary(_capturedPid, dataToSave);
    } catch (e) {
      console.warn('Failed to sync fishbone data to problem library:', e);
    }

    // 4. 更新保存状态指示器
    if (typeof window.setSaveStatus === 'function') {
      window.setSaveStatus('鱼骨图已保存');
    }
  }

  /** 同步鱼骨图数据到问题库 */
  function syncToProblemLibrary(capturedPid, snapshotData) {
    const sourceData = snapshotData || fishboneData;
    const problemText = (sourceData.problem || '').trim();
    const phenomenonText = (sourceData.phenomenon || '').trim();
    if (!problemText) return;

    // P0: 使用调用时捕获的 PID，而非运行时读取（防止 debounce 窗口内切问题导致串号）
    let activeId = capturedPid ||
      (typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null);
    if (!activeId) {
      // 如果当前没有激活的问题，且至少有一个原因数据，才自动创建问题
      let _hasCauses = false;
      Object.values(sourceData.categories || {}).forEach((arr) => {
        if (arr && arr.length > 0) _hasCauses = true;
      });
      if (
        _hasCauses &&
        typeof window.createNewProblem === 'function' &&
        typeof window.setActiveProblemId === 'function'
      ) {
        const title =
          problemText.length > MAX_TITLE_LEN
            ? problemText.slice(0, MAX_TITLE_LEN) + '...'
            : problemText;
        const newProblem = window.createNewProblem({
          title: title,
          status: 'analyzing'
        });
        if (newProblem) {
          activeId = newProblem.id;
          window.setActiveProblemId(activeId);
        }
      }
    }

    if (!activeId || typeof window.updateProblem !== 'function') return;

    const problem =
      typeof window.getProblemById === 'function' ? window.getProblemById(activeId) : null;
    if (!problem) return;

    const snapshot = problem.snapshot || { version: 2 };
    snapshot.fishboneData = JSON.parse(JSON.stringify(sourceData));

    // 只在鱼骨图表单的「问题现象」字段有内容时才同步回问题库
    // 绝不用鱼头标题（problemText）覆盖现象描述字段
    const details = problem.details || {};
    if (phenomenonText) {
      details.phenomenon = phenomenonText;
    }

    // 标记 analyses.fishbone 的状态
    const analyses = problem.analyses || {};
    let hasCauses = false;
    Object.values(sourceData.categories || {}).forEach((arr) => {
      if (arr && arr.length > 0) hasCauses = true;
    });
    // 只在尚未 completed 时才更新状态
    if (!analyses.fishbone || analyses.fishbone.status !== 'completed') {
      analyses.fishbone = {
        status: hasCauses ? 'in_progress' : 'not_started',
        lastUpdated: new Date().toISOString()
      };
    } else {
      // 保持 completed 状态，仅更新时间
      analyses.fishbone.lastUpdated = new Date().toISOString();
    }

    // 只更新标题（标题字段来自 fishbone 鱼头）
    const titleForProblem =
      problemText.length > MAX_TITLE_LEN
        ? problemText.slice(0, MAX_TITLE_LEN) + '...'
        : problemText;

    // 构建 updateProblem 参数：problemStatement 只在 phenomenonText 非空时才更新
    const updatePayload = {
      title: titleForProblem,
      details: details,
      analyses: analyses,
      snapshot: snapshot
    };
    if (phenomenonText) {
      updatePayload.problemStatement = phenomenonText;
    }

    window.updateProblem(activeId, updatePayload);

    // 如果在问题列表/工作台视图，通知刷新
    if (typeof window.renderProblemList === 'function') window.renderProblemList();
    if (typeof window.renderAnalysisHub === 'function') window.renderAnalysisHub();
  }

  /** 从 IndexedDB 加载（含 localStorage 迁移兜底） */
  async function loadFishboneData() {
    const requestedPid =
      typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
    try {
      let data = null;
      const scopedKey = _fbStorageKey(requestedPid);

      // 1. 从 IndexedDB 读取（优先使用 problem-scoped key）
      if (typeof window.pluginLoad === 'function') {
        data = await window.pluginLoad(scopedKey);
      }

      // 2. 降级：未找到 scoped 数据时，尝试从 base key 读取并迁移
      // P0-4: 仅迁移存储，不加载到内存变量（防止旧无 scope 数据污染当前问题）
      if (!data && scopedKey !== FB_STORAGE_KEY_BASE) {
        if (typeof window.pluginLoad === 'function') {
          const baseData = await window.pluginLoad(FB_STORAGE_KEY_BASE);
          if (baseData && typeof window.pluginSave === 'function') {
            await window.pluginSave(scopedKey, JSON.parse(JSON.stringify(baseData)));
            if (typeof window.pluginRemove === 'function') {
              await window.pluginRemove(FB_STORAGE_KEY_BASE);
            }
          }
        }
      }

      // 3. 兜底：从 localStorage 迁移（仅 base key）
      if (!data) {
        const raw = localStorage.getItem(FB_STORAGE_KEY_BASE);
        if (raw) {
          try {
            data = JSON.parse(raw);
            localStorage.removeItem(FB_STORAGE_KEY_BASE);
            if (typeof window.pluginSave === 'function') {
              await window.pluginSave(scopedKey, JSON.parse(JSON.stringify(data)));
            }
          } catch (e) {
            console.warn('Failed to migrate fishbone data from localStorage:', e);
          }
        }
      }

      // 加载期间若已切换问题，丢弃过期结果，避免旧问题数据覆盖新问题表单。
      if (
        typeof window.getActiveProblemId === 'function' &&
        window.getActiveProblemId() !== requestedPid
      ) {
        return;
      }

      if (data) {
        fishboneData = data;
        _fishboneOwnerPid = requestedPid;
        if (!fishboneData.theme) fishboneData.theme = 'premium';
        if (!fishboneData.phenomenon) fishboneData.phenomenon = ''; // 兼容旧数据
        CATEGORIES.forEach((cat) => {
          if (!fishboneData.categories[cat.id]) fishboneData.categories[cat.id] = [];
        });
        const probInput = document.getElementById('fishbone-problem');
        if (probInput && document.activeElement !== probInput) {
          probInput.value = data.problem || '';
        }
        const phenEl = document.getElementById('fishbone-phenomenon-ref');
        if (phenEl && document.activeElement !== phenEl) {
          phenEl.value = data.phenomenon || '';
        }
        renderCategories();
      } else {
        fishboneData = {
          problem: '',
          phenomenon: '',
          categories: {},
          savedAt: null,
          importedContext: '',
          theme: 'premium'
        };
        _fishboneOwnerPid = requestedPid;
        CATEGORIES.forEach((cat) => {
          fishboneData.categories[cat.id] = [];
        });
        const probInput = document.getElementById('fishbone-problem');
        if (probInput && document.activeElement !== probInput) {
          probInput.value = '';
        }
        const phenEl = document.getElementById('fishbone-phenomenon-ref');
        if (phenEl && document.activeElement !== phenEl) {
          phenEl.value = '';
        }
        const ctxRefEl = document.getElementById('fishbone-context-ref');
        if (ctxRefEl && document.activeElement !== ctxRefEl) {
          ctxRefEl.value = '';
        }
        renderCategories();
      }
    } catch (e) {
      console.warn('Failed to load fishbone data:', e);
      if (
        typeof window.getActiveProblemId === 'function' &&
        window.getActiveProblemId() !== requestedPid
      ) {
        return;
      }
      fishboneData = {
        problem: '',
        phenomenon: '',
        categories: {},
        savedAt: null,
        importedContext: '',
        theme: 'premium'
      };
      _fishboneOwnerPid = requestedPid;
      CATEGORIES.forEach((cat) => {
        fishboneData.categories[cat.id] = [];
      });
      const probInput = document.getElementById('fishbone-problem');
      if (probInput && !probInput.value.trim() && document.activeElement !== probInput) {
        probInput.value = '';
      }
      const phenEl = document.getElementById('fishbone-phenomenon-ref');
      if (phenEl && !phenEl.value.trim() && document.activeElement !== phenEl) {
        phenEl.value = '';
      }
      const ctxRefEl = document.getElementById('fishbone-context-ref');
      if (ctxRefEl && !ctxRefEl.value.trim() && document.activeElement !== ctxRefEl) {
        ctxRefEl.value = '';
      }
      renderCategories();
    }
  }

  /** 添加原因到指定分类 */
  function addCause(catId) {
    collectFormData();
    if (!fishboneData.categories[catId]) fishboneData.categories[catId] = [];
    fishboneData.categories[catId].push({ text: '', subCauses: [] });
    renderCategories();
    // Fix M5: save immediately for structural changes (not debounced)
    saveFishboneData();
    // Focus the new input
    const inputs = document.querySelectorAll(`.fishbone-cause-input[data-cat="${catId}"]`);
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  }

  /** 删除原因 */
  async function removeCause(catId, idx) {
    if (!(await showConfirm('确定删除该原因及其所有子原因？', 'danger'))) return;
    collectFormData();
    if (fishboneData.categories[catId]) {
      fishboneData.categories[catId].splice(idx, 1);
    }
    renderCategories();
    // Fix M5: save immediately for structural changes
    saveFishboneData();
  }

  /** 添加子原因 */
  function addSubCause(catId, causeIdx) {
    collectFormData();
    if (fishboneData.categories[catId] && fishboneData.categories[catId][causeIdx]) {
      if (!fishboneData.categories[catId][causeIdx].subCauses) {
        fishboneData.categories[catId][causeIdx].subCauses = [];
      }
      fishboneData.categories[catId][causeIdx].subCauses.push('');
    }
    renderCategories();
    // Fix M5: save immediately for structural changes
    saveFishboneData();
    const inputs = document.querySelectorAll(
      `.fishbone-sub-input[data-cat="${catId}"][data-ci="${causeIdx}"]`
    );
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  }

  /** 删除子原因 */
  async function removeSubCause(catId, causeIdx, subIdx) {
    // P1-18: 加确认（与 removeCause 一致）
    if (!(await showConfirm('确定删除该子原因？', 'danger'))) return;
    collectFormData();
    if (fishboneData.categories[catId]?.[causeIdx]?.subCauses) {
      fishboneData.categories[catId][causeIdx].subCauses.splice(subIdx, 1);
    }
    renderCategories();
    // Fix M5: save immediately for structural changes
    saveFishboneData();
  }

  /** 清空 */
  async function clearFishbone() {
    // P0-5: 捕获当前 PID 用于后续清除和快照更新
    const _clearPid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
    fishboneData = {
      problem: '',
      phenomenon: '',
      categories: {},
      savedAt: null,
      importedContext: '',
      theme: 'premium'
    };
    CATEGORIES.forEach((cat) => {
      fishboneData.categories[cat.id] = [];
    });
    const probInput = document.getElementById('fishbone-problem');
    if (probInput) probInput.value = '';
    const refEl = document.getElementById('fishbone-phenomenon-ref');
    if (refEl) refEl.value = '';
    const ctxRefEl = document.getElementById('fishbone-context-ref');
    if (ctxRefEl) ctxRefEl.value = '';

    renderCategories();

    // 1. 删除 IndexedDB 中的 key（对齐 5 Whys clearSavedAnalysis 做法）
    const _fbKey = _fbStorageKey(_clearPid);
    if (typeof window.pluginRemove === 'function') {
      try {
        const ok = await window.pluginRemove(_fbKey);
        if (ok === false) {
          console.warn('Fishbone clear remove failed: pluginRemove returned false');
          if (typeof showToast === 'function') showToast('清空数据失败，请重试', 'error');
        }
      } catch (e) {
        console.warn('Fishbone clear remove failed:', e);
        if (typeof showToast === 'function') showToast('清空数据失败：' + e.message, 'error');
      }
    }

    // 2. 同步更新快照 & 3. 通知会话改变
    if (typeof window.updatePluginSnapshot === 'function') {
      window.updatePluginSnapshot('fishbone', 'fishboneData', fishboneData, _clearPid);
    }

    // 4. 更新指示器
    if (typeof window.setSaveStatus === 'function') {
      window.setSaveStatus('鱼骨图已重置（不影响已保存的报告）');
    }
  }

  /** 从问题库选择导入问题描述与完整分析数据 */
  function loadFromProblemManager() {
    if (window.openProblemPicker) {
      window.openProblemPicker((problem) => {
        const title = problem.title || '';
        const desc = problem.problemStatement || problem.details?.phenomenon || '';
        const ctx = window.buildProblemContext ? window.buildProblemContext(problem) : '';

        if (window.loadProblemToCurrent && typeof window.loadProblemToCurrent === 'function') {
          // Pass callback to guarantee async IndexedDB read completes before UI sync
          window.loadProblemToCurrent(problem.id, () => {
            const p =
              typeof window.getProblemById === 'function' ? window.getProblemById(problem.id) : null;
            if (p) {
              const analyses = p.analyses || {};
              if (!analyses['fishbone'] || analyses['fishbone'].status === 'not_started') {
                analyses['fishbone'] = {
                  status: 'in_progress',
                  lastUpdated: new Date().toISOString()
                };
                window.updateProblem(problem.id, { analyses: analyses, status: 'analyzing' });
              }
            }
            const probInput = document.getElementById('fishbone-problem');
            if (probInput) {
              probInput.value = title || ''; // 鱼头用标题
            }
            // 填充参考信息与背景
            const refEl = document.getElementById('fishbone-phenomenon-ref');
            if (refEl) refEl.value = desc || '';
            const ctxEl = document.getElementById('fishbone-context-ref');
            if (ctxEl && ctx) ctxEl.value = ctx;
            fishboneData.importedContext = ctx;

            renderCategories();
            if (typeof updateProblemSummaryUI === 'function') {
              updateProblemSummaryUI(problem.id);
            }
            showToast('已从问题库导入', 'success');
          });
        } else {
          const probInput = document.getElementById('fishbone-problem');
          if (probInput) {
            probInput.value = title || desc.slice(0, TITLE_TRUNCATE_LEN) || '';
            probInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const refEl = document.getElementById('fishbone-phenomenon-ref');
          if (refEl) refEl.value = desc || '';
          const ctxEl = document.getElementById('fishbone-context-ref');
          if (ctxEl && ctx) ctxEl.value = ctx;
          fishboneData.importedContext = ctx;
          showToast('已从问题库导入', 'success');
        }
      });
    } else {
      showToast('问题库模块未加载', 'error');
    }
  }

  /** 生成 Markdown 文本 */
  /** 本地结构化报告生成（不依赖 AI） */
  function generateLocalReport(ctx) {
    const problem = ctx ? ctx.problem : fishboneData.problem || '未定义';
    const now = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    let md = `# 鱼骨图问题分析报告\n\n`;

    // 关联问题编号和标题
    const activeId = ctx
      ? ctx.problemId
      : typeof getActiveProblemId === 'function'
        ? getActiveProblemId()
        : '';
    if (activeId && typeof getProblemById === 'function') {
      const p = getProblemById(activeId);
      if (p) {
        if (p.displayId) md += `**问题编号：** ${p.displayId}\n\n`;
        if (p.title) md += `**问题标题：** ${p.title}\n\n`;
      }
    }

    md += `## 1. 问题概述\n\n`;
    md += `**问题现象（鱼头）：** ${problem}\n`;
    md += `**分析时间：** ${now} ${timeStr}\n\n`;

    md += `## 2. 原因分布统计 (5M1E)\n\n`;
    md += `| 维度 | 原因数量 | 末端子原因数 | 占比 | 风险评估建议 |\n`;
    md += `| :--- | :---: | :---: | :---: | :--- |\n`;

    let totalCauses = 0;
    let totalSubCauses = 0;
    const catStats = [];
    const categoriesData = ctx ? ctx.categories : fishboneData.categories;
    const sourceMode = (ctx && ctx.sourceMode) || 'local';

    CATEGORIES.forEach(({ id, name }) => {
      const causes = (categoriesData[id] || []).filter((c) => c.text);
      let subCount = 0;
      causes.forEach((c) => {
        if (c.subCauses) subCount += c.subCauses.length;
      });
      totalCauses += causes.length;
      totalSubCauses += subCount;
      catStats.push({ name, count: causes.length, subCount });
    });

    const ratios = window.ReportContract.allocatePercentages(catStats.map((stat) => stat.count));
    catStats.forEach((stat, index) => {
      const ratio = ratios[index];
      let suggestion = '🟢 风险低';
      if (ratio >= HIGH_RISK_RATIO) suggestion = '🔴 高风险 (核心脆弱维度)';
      else if (ratio >= MED_RISK_RATIO) suggestion = '🟡 中风险 (潜在影响维度)';

      md += `| **${stat.name}** | ${stat.count} | ${stat.subCount} | ${ratio}% | ${suggestion} |\n`;
    });

    md += `| **总计** | **${totalCauses}** | **${totalSubCauses}** | **100%** | — |\n\n`;

    md += `## 3. 因果分析图谱\n\n\`\`\`\n`;
    md += `[鱼头: ${problem}]\n`;
    CATEGORIES.forEach(({ id, name }) => {
      const causes = (categoriesData[id] || []).filter((c) => c.text);
      md += ` ├── 📂 ${name}\n`;
      if (causes.length === 0) {
        md += ` │   └── 📄 (未配置原因)\n`;
      } else {
        causes.forEach((c, idx) => {
          const prefix = idx === causes.length - 1 ? ' └──' : ' ├──';
          md += ` │   ${prefix} 📄 ${c.text}\n`;
          if (c.subCauses && c.subCauses.length > 0) {
            const subPrefix = idx === causes.length - 1 ? '     ' : ' │   ';
            c.subCauses.forEach((sub, subIdx) => {
              const leafPrefix = subIdx === c.subCauses.length - 1 ? '└──' : '├──';
              md += ` ${subPrefix}  ${leafPrefix} 🌿 ${sub}\n`;
            });
          }
        });
      }
    });
    md += `\`\`\`\n\n`;

    md += window.ReportContract.buildCapaSection({
      heading: '## 4. 纠正与预防措施 (CAPA)',
      dueDate: now,
      introduction: '本报告为本地结构化降级报告。请针对高风险维度制定可验证的闭环措施。'
    });
    md += `\n## 5. 后续行动项\n\n`;
    md += window.ReportContract.buildActionItem('确认高风险维度的责任人与验证计划', now);
    md += '\n' + window.ReportContract.buildAnalysisStatistics({
      nodeCount: totalCauses + totalSubCauses,
      sourceMode,
      metrics: [
        ['一级原因数', totalCauses],
        ['末端子原因数', totalSubCauses],
        ['覆盖 5M1E 维度数', catStats.filter((stat) => stat.count > 0).length]
      ]
    });

    const svgEl = document.querySelector('#fishboneSvgWrapper svg');
    if (svgEl) {
      md += `\n## 6. 鱼骨图可视化\n\n`;
      md += `> 鱼骨图详见下方可视化区域。\n\n`;
    }

    const startTime = typeof window !== 'undefined' ? window.analysisStartTime : null;
    const duration = startTime
      ? Math.round((Date.now() - new Date(startTime).getTime()) / 60000)
      : '?';
    md += window.ReportContract.buildMetadata({ sourceMode, durationMinutes: duration });

    return md;
  }

  /** AI 智能综合报告生成 */
  async function generateReport(forceRegenerate = false) {
    // Capture problem ID and fishbone data at call-time (at the very beginning)
    const _fbProblemId = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
    const problem = fishboneData.problem;
    if (!problem) {
      showToast('请先输入问题描述（鱼头）', 'error');
      return '';
    }

    const _importedContext = fishboneData.importedContext || '无';
    const _lastAiSummary = lastAiSummary || '未进行 AI 智能分析，基于用户录入原因生成。';
    const _fishboneDataCopy = JSON.parse(JSON.stringify(fishboneData));
    const _fbReportStart = Date.now();

    // 将 5M1E 分类原因整理成文本
    let catText = '';
    CATEGORIES.forEach(({ id, name }) => {
      const causes = (_fishboneDataCopy.categories[id] || []).filter((c) => c.text);
      if (causes.length > 0) {
        catText += `\n【${name}】\n`;
        causes.forEach((c, i) => {
          catText += `${i + 1}. ${c.text}`;
          if (c.subCauses && c.subCauses.length > 0) {
            catText += '（子原因: ' + c.subCauses.join('；') + '）';
          }
          catText += '\n';
        });
      }
    });

    if (!catText.trim()) {
      showToast('请先添加至少一个原因以生成报告', 'error');
      return '';
    }

    // 用 generateSVG 生成干净 SVG（不含 zoom/pan 包裹，与报告库展示一致）
    // 传递 compact:false 以确保报告中的鱼骨图与 UI 渲染成图一致（container 通常较宽）
    const svgHtml = window.FishboneSVG?.generateSVG(fishboneData, { compact: false }) || '';

    let reportMarkdown = '';
    let reportSourceMode = 'ai';

    try {
      // 流式展示 AI 分析过程
      let _reasoningShown = false;
      const rendered = renderPrompt('fishboneReport', {
        problemStatement: getProblemWithContext(),
        problemContext: _importedContext,
        categoriesText: catText,
        aiAnalysisSummary: _lastAiSummary,
        today: new Date().toISOString().slice(0, 10)
      });

      try {
        if (window.SidebarUI) {
          window.SidebarUI.open('AI 鱼骨图报告');
          window.SidebarUI.showLoading('正在连接 AI 服务...');
        }

        const { text: streamContent, reasoning: streamReasoning } = await callOpenAIStreaming(
          rendered.system,
          rendered.user,
          {
            onReasoning: (_chunk, fullText) => {
              if (!_reasoningShown) {
                _reasoningShown = true;
                if (window.SidebarUI) {
                  window.SidebarUI.showReasoningStream('模型正在生成鱼骨图报告', 'fbReasoningContent');
                }
              }
              window.SidebarUI?.updateReasoningStream('fbReasoningContent', fullText);
            }
          },
          12288,
          false
        );

        reportMarkdown = streamContent;
        if (!reportMarkdown || !reportMarkdown.trim()) {
          throw new Error('AI 返回空内容');
        }
        const streamValidation = window.ReportContract.validateAiReport(reportMarkdown, 'fishbone');
        if (!streamValidation.valid) {
          throw new Error('AI 报告缺少必需章节：' + streamValidation.missing.join('、'));
        }

        if (window.SidebarUI && _reasoningShown) {
          if (typeof _showAiCompletion === 'function') {
            _showAiCompletion(Date.now() - _fbReportStart, window._lastAiUsage);
          }
        }
        // 流式成功路径也附加分析元数据（对齐非流式路径）
        const _fbStreamModel = typeof getActiveModel === 'function' ? getActiveModel() : '';
        const _fbStreamElapsed = ((Date.now() - _fbReportStart) / 1000).toFixed(1);
        const _fbStreamUsage = window._lastAiUsage;
        reportMarkdown += window.ReportContract.buildMetadata({
          sourceMode: 'ai',
          model: _fbStreamModel,
          usage: _fbStreamUsage,
          elapsedSeconds: _fbStreamElapsed
        });
      } catch (streamErr) {
        console.warn('[Fishbone] Streaming failed, falling back:', streamErr.message);
        if (window.SidebarUI) {
          window.SidebarUI.hideLoading();
          window.SidebarUI.showLoading('正在生成鱼骨图分析报告...', [
            '正在整理 5M1E 原因分类...',
            '正在生成分析结论与建议...',
            '即将完成...'
          ]);
        }
        const result = await callAI(rendered.system, rendered.user, false, 12288);
        reportMarkdown = result;
        if (!reportMarkdown || !reportMarkdown.trim()) {
          throw new Error('重试仍返回空内容');
        }
        const retryValidation = window.ReportContract.validateAiReport(reportMarkdown, 'fishbone');
        if (!retryValidation.valid) {
          throw new Error('AI 报告缺少必需章节：' + retryValidation.missing.join('、'));
        }

        const _model = typeof getActiveModel === 'function' ? getActiveModel() : '';
        const elapsedSecs = ((Date.now() - _fbReportStart) / 1000).toFixed(1);
        const usage = window._lastAiUsage;
        reportMarkdown += window.ReportContract.buildMetadata({
          sourceMode: 'ai',
          model: _model,
          usage,
          elapsedSeconds: elapsedSecs
        });

        if (window.SidebarUI) {
          window.SidebarUI.hideLoading();
          if (typeof _showAiCompletion === 'function') {
            _showAiCompletion(Date.now() - _fbReportStart, window._lastAiUsage);
          }
        }
      }
    } catch (err) {
      // 降级为本地结构化报告
      reportSourceMode = 'local';
      reportMarkdown = generateLocalReport({
        problem: problem,
        problemId: _fbProblemId,
        categories: _fishboneDataCopy.categories
      });
      if (window.SidebarUI) {
        window.SidebarUI.hideLoading();
        if (typeof _showAiCompletion === 'function') {
          _showAiCompletion(Date.now() - _fbReportStart, null);
        }
        window.SidebarUI.appendContent(
          '<div class="ai-block is-error"><h4>AI 不可用，已生成本地报告</h4><p>' +
            esc(err.message) +
            '</p><p style="font-size:0.85rem;color:var(--text-muted);margin-top:4px;">' +
            esc((window.getApiErrorHint ? window.getApiErrorHint(err.message) : '') || '') +
            '</p></div>'
        );
      }
      showToast('AI 不可用，已生成本地报告', 'info');
    } finally {
    }

    // 在报告头部插入问题编号和标题（AI 路径不自动包含，本地报告已包含）
    // 使用调用时捕获的 _fbProblemId 而非重新查询，避免 AI 调用期间用户切换问题
    if (!reportMarkdown.includes('**问题编号：**')) {
      if (_fbProblemId && typeof getProblemById === 'function') {
        const _rp = getProblemById(_fbProblemId);
        if (_rp) {
          let hdr = '';
          if (_rp.displayId) hdr += `**问题编号：** ${_rp.displayId}\n\n`;
          if (_rp.title) hdr += `**问题标题：** ${_rp.title}\n\n`;
          if (hdr) reportMarkdown = `${hdr}\n${reportMarkdown}`;
        }
      }
    }

    // Compute fishbone node count from the captured copy (avoids race with live data)
    let _fbNodeCount = 0;
    Object.values(_fishboneDataCopy.categories).forEach((causes) => {
      if (Array.isArray(causes)) {
        causes.forEach((cause) => {
          if (cause.text) {
            _fbNodeCount += 1;
            if (cause.subCauses && Array.isArray(cause.subCauses)) {
              _fbNodeCount += cause.subCauses.length;
            }
          }
        });
      }
    });
    const _fbPrimaryCauseCount = Object.values(_fishboneDataCopy.categories).reduce(
      (count, causes) => count + (Array.isArray(causes) ? causes.filter((cause) => cause.text).length : 0),
      0
    );
    const _fbSubCauseCount = _fbNodeCount - _fbPrimaryCauseCount;
    const _fbCoveredCategoryCount = Object.values(_fishboneDataCopy.categories).filter(
      (causes) => Array.isArray(causes) && causes.some((cause) => cause.text)
    ).length;
    reportMarkdown = window.ReportContract.appendAnalysisStatistics(reportMarkdown, {
      nodeCount: _fbNodeCount,
      sourceMode: reportSourceMode,
      metrics: [
        ['一级原因数', _fbPrimaryCauseCount],
        ['末端子原因数', _fbSubCauseCount],
        ['覆盖 5M1E 维度数', _fbCoveredCategoryCount]
      ]
    });

    // 保存到全局报告库
    if (typeof saveReportToLibrary === 'function') {
      const savedReport = await saveReportToLibrary(reportMarkdown, {
        title: '[鱼骨图] ' + (problem.slice(0, TITLE_TRUNCATE_LEN) || '鱼骨图分析'),
        analysisType: 'fishbone',
        sourceMode: reportSourceMode,
        isRegenerate: forceRegenerate,
        fishboneSvgHtml: svgHtml,
        problemId: _fbProblemId,
        problemStatement: problem,
        nodeCount: _fbNodeCount,
        rootCauseCount: _fbSubCauseCount
      });
      if (typeof markAnalysisCompleted === 'function') {
        markAnalysisCompleted('fishbone', _fbProblemId);
      }
      showToast('报告已生成并保存', 'success');

      // 跳转到报告管理页面并显示报告
      if (typeof navigateTo === 'function') {
        window.scheduleRedirect({
          seconds: 6,
          noCollapse: true,
          onNavigate: function () {
            if (savedReport && typeof showReportDetail === 'function') {
              showReportDetail(savedReport.id);
            }
          }
        });
      }
    }

    return reportMarkdown;
  }

  /** 保持向下兼容 */
  function toMarkdown() {
    return generateLocalReport();
  }

  // ===== AI Functions =====

  /** AI 自动分析 — 为 5M1E 各维度生成原因 */
  async function aiAnalyze() {
    collectFormData();
    const problem = fishboneData.problem;
    if (!problem) {
      showToast('请先输入问题描述（鱼头）', 'error');
      return;
    }

    // Fix H3: capture context before async AI call
    const _aiCtx = captureAiContext();
    if (window.SidebarUI) {
      window.SidebarUI.open('AI 自动分析');
      window.SidebarUI.showLoading('正在分析问题上下文...', [
        '正在识别 5M1E 维度...',
        '正在逐维度生成原因...',
        '正在汇总关键根因...'
      ]);
    }

    let reasoningStreamActive = false;
    try {
      const rendered = renderPrompt('fishboneAnalyze', {
        problemStatement: getProblemWithContext()
      });
      let result;
      try {
        const { text: streamContent } = await callOpenAIStreaming(rendered.system, rendered.user, {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningStreamActive) {
              reasoningStreamActive = true;
              window.SidebarUI?.showReasoningStream('模型推理输出', 'fbAnalyzeReasoningContent');
            }
            window.SidebarUI?.updateReasoningStream('fbAnalyzeReasoningContent', fullText);
          }
        });
        result = parseAIJson(streamContent);
      } catch (streamErr) {
        if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') throw streamErr;
        console.warn('[Fishbone] aiAnalyze streaming failed, falling back:', streamErr.message);
        window.SidebarUI?.hideLoading();
        window.SidebarUI?.showLoading('正在以兼容模式分析...', null, true);
        result = await callAI(rendered.system, rendered.user, true);
      }
      if (!checkAiContext(_aiCtx, 'aiAnalyze-fishbone')) return;

      if (result.categories) {
        collectFormData();
        Object.entries(result.categories).forEach(([catId, causes]) => {
          const target = fishboneData.categories[catId] || [];
          if (!fishboneData.categories[catId]) fishboneData.categories[catId] = target;
          causes.forEach((c) => {
            if (c.text && c.text.trim()) {
              const text = c.text.trim();
              if (!target.some((e) => e.text === text)) {
                target.push({
                  text,
                  subCauses: Array.isArray(c.subCauses) ? c.subCauses.filter(Boolean) : []
                });
              }
            }
          });
        });
        renderCategories();
        await saveFishboneData();
      }

      let html = '';
      if (result.summary) {
        lastAiSummary = result.summary;
        html += `<div class="ai-block"><h4>分析概要</h4><p>${esc(result.summary)}</p></div>`;
      }
      if (result.keyRootCauses && result.keyRootCauses.length > 0) {
        html += `<div class="ai-block"><h4>关键根因</h4>`;
        result.keyRootCauses.forEach((rc) => {
          html += `<div class="ai-suggestion"><div class="text">${esc(rc)}</div></div>`;
        });
        html += `</div>`;
      }

      SidebarUI.openContent(
        'AI 鱼骨图分析',
        window.wrapWithThinking ? window.wrapWithThinking(html) : html
      );
      showToast('AI 分析完成', 'success');
    } catch (err) {
      SidebarUI.openContent(
        'AI 鱼骨图分析',
        `<div class="ai-block is-error"><h4>分析失败</h4><p>${esc(err.message)}</p><p style="font-size:0.85rem;color:var(--text-muted);margin-top:4px;">${esc(window.getApiErrorHint ? window.getApiErrorHint(err.message) : '')}</p></div>`
      );
      showToast('AI 分析失败: ' + err.message, 'error');
    }
  }

  /** AI 为单个维度建议原因 */
  async function aiSuggest(catId) {
    collectFormData();
    const problem = fishboneData.problem;
    if (!problem) {
      showToast('请先输入问题描述（鱼头）', 'error');
      return;
    }

    // Fix H3: capture context before async AI call
    const _aiCtx = captureAiContext();
    const catName = CATEGORIES.find((c) => c.id === catId)?.name || catId;
    if (window.SidebarUI) {
      window.SidebarUI.open('AI 建议 — ' + catName);
      window.SidebarUI.showLoading('正在分析 ' + catName + ' 维度...', [
        '正在识别相关原因...',
        '正在生成子原因...',
        '正在评估合理性...'
      ]);
    }

    let reasoningStreamActive = false;
    try {
      const rendered = renderPrompt('fishboneAnalyze', {
        problemStatement: getProblemWithContext()
      });
      const userPrompt = rendered.user + `\n\n请重点分析「${catName}」维度，生成 2-4 个具体原因。`;
      let result;
      try {
        const { text: streamContent } = await callOpenAIStreaming(rendered.system, userPrompt, {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningStreamActive) {
              reasoningStreamActive = true;
              window.SidebarUI?.showReasoningStream('模型推理输出', 'fbSuggestReasoningContent');
            }
            window.SidebarUI?.updateReasoningStream('fbSuggestReasoningContent', fullText);
          }
        });
        result = parseAIJson(streamContent);
      } catch (streamErr) {
        if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') throw streamErr;
        console.warn('[Fishbone] aiSuggest streaming failed, falling back:', streamErr.message);
        window.SidebarUI?.hideLoading();
        window.SidebarUI?.showLoading('正在以兼容模式分析...', null, true);
        result = await callAI(rendered.system, userPrompt, true);
      }
      if (!checkAiContext(_aiCtx, 'aiSuggest-fishbone')) return;

      const causes = result.categories?.[catId] || [];
      if (causes.length > 0) {
        if (!fishboneData.categories[catId]) fishboneData.categories[catId] = [];
        causes.forEach((c) => {
          if (c.text && c.text.trim()) {
            fishboneData.categories[catId].push({
              text: c.text.trim(),
              subCauses: Array.isArray(c.subCauses) ? c.subCauses.filter((s) => s) : []
            });
          }
        });
        renderCategories();
        await saveFishboneData();
      }

      let html = `<div class="ai-block"><h4>${esc(catName)} — AI 建议原因</h4>`;
      if (causes.length === 0) {
        html += `<p>未生成建议，该维度可能和问题关联度较低。</p>`;
      } else {
        causes.forEach((c) => {
          html += `<div class="ai-suggestion">`;
          html += `<div class="text">${esc(c.text)}</div>`;
          if (c.subCauses && c.subCauses.length > 0) {
            html += `<div class="reason">子原因: ${esc(c.subCauses.join('；'))}</div>`;
          }
          html += `</div>`;
        });
      }
      html += `</div>`;

      SidebarUI.openContent(
        'AI 建议 — ' + catName,
        window.wrapWithThinking ? window.wrapWithThinking(html) : html
      );
      showToast('AI 建议已生成', 'success');
    } catch (err) {
      SidebarUI.openContent(
        'AI 建议',
        `<div class="ai-block is-error"><h4>建议失败</h4><p>${esc(err.message)}</p><p style="font-size:0.85rem;color:var(--text-muted);margin-top:4px;">${esc(window.getApiErrorHint ? window.getApiErrorHint(err.message) : '')}</p></div>`
      );
      showToast('AI 建议失败: ' + err.message, 'error');
    }
  }

  /** AI 展开子原因 */
  async function aiExpand(catId, causeIdx) {
    collectFormData();
    const problem = fishboneData.problem;
    const cause = fishboneData.categories[catId]?.[causeIdx];
    if (!problem) {
      showToast('请先输入问题描述', 'error');
      return;
    }
    if (!cause || !cause.text) {
      showToast('该原因为空，无法展开', 'error');
      return;
    }

    // Fix H3: capture context before async AI call
    const _aiCtx = captureAiContext();
    const catName = CATEGORIES.find((c) => c.id === catId)?.name || catId;
    if (window.SidebarUI) {
      window.SidebarUI.open('AI 展开子原因');
      window.SidebarUI.showLoading('正在分析原因...', [
        '正在查找潜在子原因...',
        '正在评估因果关联...',
        '正在生成具体表现...'
      ]);
    }

    let reasoningStreamActive = false;
    try {
      const rendered = renderPrompt('fishboneExpand', {
        problemStatement: getProblemWithContext(),
        category: catName,
        causeText: cause.text
      });
      let result;
      try {
        const { text: streamContent } = await callOpenAIStreaming(rendered.system, rendered.user, {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningStreamActive) {
              reasoningStreamActive = true;
              window.SidebarUI?.showReasoningStream('模型推理输出', 'fbExpandReasoningContent');
            }
            window.SidebarUI?.updateReasoningStream('fbExpandReasoningContent', fullText);
          }
        });
        result = parseAIJson(streamContent);
      } catch (streamErr) {
        if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') throw streamErr;
        console.warn('[Fishbone] aiExpand streaming failed, falling back:', streamErr.message);
        window.SidebarUI?.hideLoading();
        window.SidebarUI?.showLoading('正在以兼容模式分析...', null, true);
        result = await callAI(rendered.system, rendered.user, true);
      }
      if (!checkAiContext(_aiCtx, 'aiExpand-fishbone')) return;

      const subCauses = result.subCauses || [];
      if (subCauses.length > 0) {
        if (!cause.subCauses) cause.subCauses = [];
        subCauses.forEach((sub) => {
          if (sub && sub.trim()) cause.subCauses.push(sub.trim());
        });
        renderCategories();
        await saveFishboneData();
      }

      let html = `<div class="ai-block"><h4>「${esc(cause.text)}」— 子原因</h4>`;
      if (subCauses.length === 0) {
        html += `<p>该原因已经足够具体，无需进一步展开。</p>`;
      } else {
        subCauses.forEach((sub, i) => {
          html += `<div class="ai-suggestion"><div class="text">${esc(sub)}</div></div>`;
        });
      }
      if (result.note)
        html += `<p style="font-size:0.7rem;color:var(--text-muted);margin-top:8px;">${esc(result.note)}</p>`;
      html += `</div>`;

      SidebarUI.openContent(
        'AI 展开子原因',
        window.wrapWithThinking ? window.wrapWithThinking(html) : html
      );
      showToast('子原因展开完成', 'success');
    } catch (err) {
      SidebarUI.openContent(
        'AI 展开',
        `<div class="ai-block is-error"><h4>展开失败</h4><p>${esc(err.message)}</p><p style="font-size:0.85rem;color:var(--text-muted);margin-top:4px;">${esc(window.getApiErrorHint ? window.getApiErrorHint(err.message) : '')}</p></div>`
      );
      showToast('展开失败: ' + err.message, 'error');
    }
  }

  /** 逻辑校验鱼骨图，并执行结构性修正 */
  async function aiValidate() {
    collectFormData();
    const problem = fishboneData.problem;
    if (!problem) {
      showToast('请先输入问题描述（鱼头）', 'error');
      return;
    }

    // Build categories text for prompt
    let catText = '';
    CATEGORIES.forEach(({ id, name }) => {
      const causes = (fishboneData.categories[id] || []).filter((c) => c.text);
      if (causes.length > 0) {
        catText += `\n【${name}】\n`;
        causes.forEach((c, i) => {
          catText += `${i + 1}. ${c.text}`;
          if (c.subCauses && c.subCauses.length > 0) {
            catText += '（子原因: ' + c.subCauses.join('；') + '）';
          }
          catText += '\n';
        });
      }
    });

    if (!catText.trim()) {
      showToast('请先添加至少一个原因', 'error');
      return;
    }

    // Fix H3: capture context before async AI call
    const _aiCtx = captureAiContext();
    if (window.SidebarUI) {
      window.SidebarUI.open('逻辑校验');
      window.SidebarUI.showLoading('正在验证因果逻辑...', [
        '正在逐条检查因果关系...',
        '正在评估原因分类合理性...',
        '正在检查遗漏维度...'
      ]);
    }

    const _isExample = window.isActiveProblemExample();

    let reasoningStreamActive = false;
    try {
      const rendered = renderPrompt('fishboneValidate', {
        problemStatement: getProblemWithContext(),
        categories: catText
      });
      let result;
      try {
        const { text: streamContent } = await callOpenAIStreaming(rendered.system, rendered.user, {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningStreamActive) {
              reasoningStreamActive = true;
              window.SidebarUI?.showReasoningStream('模型推理输出', 'fbValidateReasoningContent');
            }
            window.SidebarUI?.updateReasoningStream('fbValidateReasoningContent', fullText);
          }
        });
        result = parseAIJson(streamContent);
      } catch (streamErr) {
        if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') throw streamErr;
        console.warn('[Fishbone] aiValidate streaming failed, falling back:', streamErr.message);
        window.SidebarUI?.hideLoading();
        window.SidebarUI?.showLoading('正在以兼容模式验证...', null, true);
        result = await callAI(rendered.system, rendered.user, true);
      }
      if (!checkAiContext(_aiCtx, 'aiValidate-fishbone')) return;

      // ---- Parse corrections (validate but defer mutation) ----
      const corrections = result.corrections;
      let correctionsApplied = false;
      let preSnapshot = null;
      const deferredOps = [];
      const correctionSummary = [];

      if (Array.isArray(corrections) && corrections.length > 0) {
        collectFormData();
        corrections.forEach((c, idx) => {
          const cat = c.category;
          if (!CATEGORIES.some((x) => x.id === cat)) {
            correctionSummary.push({ type: c.type, category: cat, description: '', success: false, reason: '无效维度' });
            return;
          }

          if (c.type === 'add' && Array.isArray(c.causes)) {
            const validCauses = c.causes.filter((cause) => cause.text && cause.text.trim());
            if (validCauses.length === 0) {
              correctionSummary.push({ type: 'add', category: cat, description: '', success: false, reason: '原因为空' });
              return;
            }
            const texts = validCauses.map((cause) => ({
              text: cause.text.trim(),
              subCauses: Array.isArray(cause.subCauses) ? cause.subCauses.filter(Boolean) : []
            }));
            deferredOps.push({ type: 'add', category: cat, items: texts });
            correctionSummary.push({
              type: 'add', category: cat,
              description: texts.map((t) => t.text).join('；'),
              success: true, reason: c.reason
            });
          } else if (c.type === 'replace') {
            const idx = c.index;
            const newText = (c.newText || '').trim();
            if (!newText) {
              correctionSummary.push({ type: 'replace', category: cat, description: '', success: false, reason: 'newText 为空' });
              return;
            }
            deferredOps.push({ type: 'replace', category: cat, index: idx, newText });
            correctionSummary.push({
              type: 'replace', category: cat,
              description: newText, success: true, reason: c.reason
            });
          } else {
            correctionSummary.push({ type: c.type || '未知', category: cat, description: '', success: false, reason: '不支持的修正类型' });
          }
        });
      }

      // ---- Build sidebar ----
      let html = '';

      const pending = correctionSummary.filter((s) => s.success);
      const skipped = correctionSummary.filter((s) => !s.success);

      if (pending.length > 0) {
        const hasReplace = pending.some((s) => s.type === 'replace');
        html += `<div class="ai-block" style="border-color:var(--primary);">`;
        html += `<h4>AI 建议修正 (${pending.length} 项)</h4>`;
        pending.forEach((s) => {
          const icon = s.type === 'add' ? '+' : '↻';
          html += `<div class="ai-suggestion">`;
          html += `<div class="text">${icon} [${s.category}] ${esc(s.description)}</div>`;
          if (s.reason) html += `<div class="reason" style="font-size:0.7rem;color:var(--text-muted);">${esc(s.reason)}</div>`;
          html += `</div>`;
        });
        if (!_isExample) {
          html += `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px;">`;
          html += `<button type="button" class="btn btn-primary btn-sm" id="fbApplyCorrections" style="width:100%;">`;
          html += `✓ 应用以上 ${pending.length} 项修正</button>`;
          html += `</div>`;
        }
        html += `</div>`;

        if (hasReplace) {
          html += `<div class="ai-block" style="font-size:0.75rem;color:var(--text-muted);padding:6px 12px;">`;
          html += `⚠️ 替换操作不可逆。应用后可通过回滚按钮撤销本次全部修正。`;
          html += `</div>`;
        }
      }

      if (skipped.length > 0) {
        html += `<div class="ai-block" style="border-color:var(--text-muted);">`;
        html += `<h4 style="color:var(--text-muted);">跳过 (${skipped.length} 项)</h4>`;
        skipped.forEach((s) => {
          html += `<div class="ai-suggestion" style="opacity:0.6;">`;
          html += `<div class="text">${esc(s.type || '')} — ${esc(s.reason || '')}</div>`;
          html += `</div>`;
        });
        html += `</div>`;
      }

      // Validations (only show if no corrections at all)
      if (pending.length === 0 && result.validations && result.validations.length > 0) {
        html += `<div class="ai-block"><h4>逐项验证</h4>`;
        result.validations.forEach((v) => {
          const causalClass = v.causalValid ? 'pass' : 'fail';
          const catClass = v.categoryValid ? 'pass' : 'fail';
          const specLabel =
            v.specificity === 'high' ? '高' : v.specificity === 'medium' ? '中' : '低';
          html += `<div class="causal-link ${causalClass}" style="margin-bottom:8px;">`;
          html += `<div class="causal-statement"><strong>${esc(v.category)}</strong> — ${esc(v.cause)}</div>`;
          html += `<div class="causal-verdict ${causalClass}">因果: ${v.causalValid ? '成立' : '存疑'}</div>`;
          if (v.causalNote) html += `<div class="causal-ai-note">${esc(v.causalNote)}</div>`;
          html += `<div class="causal-verdict ${catClass}">分类: ${v.categoryValid ? '正确' : '待调整'}</div>`;
          if (v.categoryNote) html += `<div class="causal-ai-note">${esc(v.categoryNote)}</div>`;
          html += `<div style="font-size:0.7rem;color:var(--text-muted);">具体性: ${specLabel}</div>`;
          html += `</div>`;
        });
        html += `</div>`;
      }

      // Missing dimensions
      if (result.missingDimensions && result.missingDimensions.length > 0) {
        html += `<div class="ai-block" style="border-color:var(--orange);"><h4>可能遗漏的维度</h4>`;
        result.missingDimensions.forEach((m) => {
          html += `<div class="ai-suggestion"><div class="text">${esc(m)}</div></div>`;
        });
        html += `</div>`;
      }

      // Missing causes
      if (result.missingCauses && result.missingCauses.length > 0) {
        html += `<div class="ai-block" style="border-color:var(--primary);"><h4>可能遗漏的原因</h4>`;
        result.missingCauses.forEach((m) => {
          html += `<div class="ai-suggestion"><div class="text">${esc(m)}</div></div>`;
        });
        html += `</div>`;
      }

      // Overall assessment
      if (result.overallAssessment) {
        html += `<div class="ai-block" style="border-color:var(--green-border);background:var(--green-lighter);"><h4>整体评价</h4><p>${esc(result.overallAssessment)}</p></div>`;
      }

      // Recommendations
      if (result.recommendations && result.recommendations.length > 0) {
        html += `<div class="ai-block"><h4>改进建议</h4>`;
        result.recommendations.forEach((r) => {
          html += `<div class="ai-suggestion"><div class="text">${esc(r)}</div></div>`;
        });
        html += `</div>`;
      }

      SidebarUI.openContent(
        '逻辑校验',
        window.wrapWithThinking ? window.wrapWithThinking(html) : html
      );

      // Bind apply button
      if (pending.length > 0 && !_isExample) {
        const applyBtn = document.getElementById('fbApplyCorrections');
        if (applyBtn) {
          applyBtn.addEventListener('click', () => {
            if (correctionsApplied) return;
            correctionsApplied = true;
            // Take pre-snapshot
            preSnapshot = {};
            deferredOps.forEach((op) => {
              if (op.category && !preSnapshot[op.category]) {
                preSnapshot[op.category] = JSON.parse(
                  JSON.stringify(fishboneData.categories[op.category] || [])
                );
              }
            });

            // Execute deferred ops
            deferredOps.forEach((op) => {
              if (!fishboneData.categories[op.category]) {
                fishboneData.categories[op.category] = [];
              }
              if (op.type === 'add') {
                op.items.forEach((item) => {
                  fishboneData.categories[op.category].push({
                    text: item.text,
                    subCauses: item.subCauses
                  });
                });
              } else if (op.type === 'replace') {
                const causes = fishboneData.categories[op.category];
                if (op.index >= 0 && op.index < causes.length) {
                  causes[op.index].text = op.newText;
                }
              }
            });

            correctionsApplied = true;
            renderCategories();
            saveFishboneData(undefined, fishboneData);

            // Replace sidebar content with post-apply state
            let postHtml = `<div class="ai-block" style="border-color:var(--green-border);">`;
            postHtml += `<h4>✓ 已应用 (${pending.length} 项)</h4>`;
            pending.forEach((s) => {
              const icon = s.type === 'add' ? '+' : '↻';
              postHtml += `<div class="ai-suggestion" style="border-left:3px solid var(--green);">`;
              postHtml += `<div class="text">${icon} ${esc(s.description)}</div>`;
              if (s.reason) postHtml += `<div class="reason" style="font-size:0.7rem;color:var(--text-muted);">${esc(s.reason)}</div>`;
              postHtml += `</div>`;
            });
            postHtml += `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px;">`;
            postHtml += `<button type="button" class="btn btn-outline btn-sm" id="fbRollbackCorrections" style="width:100%;">↩ 回滚本次全部修正</button>`;
            postHtml += `</div>`;
            postHtml += `<div style="margin-top:8px;font-size:0.7rem;color:var(--text-muted);">💡 请在编辑器中审查 AI 添加/修改的内容</div>`;
            postHtml += `</div>`;

            const existingBlocks = document.querySelectorAll('.sidebar-content .ai-block');
            const firstBlock = existingBlocks[0];
            if (firstBlock) {
              firstBlock.outerHTML = postHtml;
            }

            // Bind rollback
            const rollbackBtn = document.getElementById('fbRollbackCorrections');
            if (rollbackBtn) {
              rollbackBtn.addEventListener('click', () => {
                Object.keys(preSnapshot).forEach((cat) => {
                  fishboneData.categories[cat] = JSON.parse(JSON.stringify(preSnapshot[cat]));
                });
                renderCategories();
                saveFishboneData(undefined, fishboneData);
                rollbackBtn.textContent = '✓ 已回滚';
                rollbackBtn.disabled = true;
                showToast('修正已回滚', 'info');
              });
            }

            showToast(`已应用 ${pending.length} 项修正`, 'success');
          });
        }
      }

      const toastMsg = pending.length > 0
        ? '逻辑校验完成，请审阅 AI 建议的修正'
        : '验证完成';
      showToast(toastMsg, 'success');
    } catch (err) {
      SidebarUI.openContent(
        '逻辑校验',
        `<div class="ai-block is-error"><h4>验证失败</h4><p>${esc(err.message)}</p><p style="font-size:0.85rem;color:var(--text-muted);margin-top:4px;">${esc(window.getApiErrorHint ? window.getApiErrorHint(err.message) : '')}</p></div>`
      );
      showToast('验证失败: ' + err.message, 'error');
    }
  }

  /** 鱼骨图 SVG 缩放/平移（参照 FTA 实现） */
  function _initFbZoomPan() {
    try {
      if (_fbZoomAbort) {
        _fbZoomAbort.abort();
        _fbZoomAbort = null;
      }
      const wrapper = document.getElementById('fishboneSvgWrapper');
      if (!wrapper) return;
      const svg = wrapper.querySelector('svg');
      if (!svg) return;

      // 将现有 SVG 内容包裹到 <g id="fb-zoom-group"> 中
      let g = svg.querySelector('#fb-zoom-group');
      if (!g) {
        g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.id = 'fb-zoom-group';
        Array.from(svg.children).forEach((child) => {
          if (child.tagName === 'defs' || child.tagName === 'style' || child.id === 'fb-zoom-group')
            return;
          g.appendChild(child);
        });
        svg.appendChild(g);
      }

      _fbZoomAbort = new AbortController();
      const sig = _fbZoomAbort.signal;

      let scale = 1,
        panX = 0,
        panY = 0;
      let _initScale = 1; // 存储初始适配缩放比例，供重置按钮使用
      let isDragging = false,
        startX = 0,
        startY = 0;

      const applyTransform = () => {
        g.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`);
      };

      // 默认显示全图（不缩放），用户通过 +/- 或双指手势放大看细节
      _initScale = 1;
      scale = 1;
      applyTransform();

      svg.style.cursor = 'grab';
      svg.addEventListener(
        'mousedown',
        (e) => {
          if (e.target.closest('[data-action="focus-svg-group"]')) return;
          isDragging = true;
          startX = e.clientX - panX;
          startY = e.clientY - panY;
          svg.style.cursor = 'grabbing';
        },
        { signal: sig }
      );

      document.addEventListener(
        'mousemove',
        (e) => {
          if (!isDragging) return;
          panX = e.clientX - startX;
          panY = e.clientY - startY;
          applyTransform();
        },
        { signal: sig }
      );

      document.addEventListener(
        'mouseup',
        () => {
          if (isDragging) {
            isDragging = false;
            svg.style.cursor = 'grab';
          }
        },
        { signal: sig }
      );

      let lastTouchDist = 0;
      // 每次 _initFbZoomPan 调用都会叠加新 touch 监听器（mouse 监听器已传 signal）。
      // 对齐 fta.js _initZoomPan 的正确实现。
      svg.addEventListener(
        'touchstart',
        (e) => {
          if (e.touches.length === 1) {
            isDragging = true;
            startX = e.touches[0].clientX - panX;
            startY = e.touches[0].clientY - panY;
          } else if (e.touches.length === 2) {
            isDragging = false;
            lastTouchDist = Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY
            );
          }
        },
        { passive: true, signal: sig }
      );

      svg.addEventListener(
        'touchmove',
        (e) => {
          if (e.touches.length === 1 && isDragging) {
            panX = e.touches[0].clientX - startX;
            panY = e.touches[0].clientY - startY;
            applyTransform();
          } else if (e.touches.length === 2) {
            const dist = Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY
            );
            if (lastTouchDist > 0) {
              scale = Math.max(0.2, Math.min(5, scale * (dist / lastTouchDist)));
              applyTransform();
            }
            lastTouchDist = dist;
          }
        },
        { passive: true, signal: sig }
      );

      svg.addEventListener(
        'touchend',
        () => {
          isDragging = false;
          lastTouchDist = 0;
        },
        { signal: sig }
      );
      svg.style.cursor = 'grab';

      document.getElementById('fbZoomIn')?.addEventListener(
        'click',
        () => {
          scale = Math.min(5, scale * 1.2);
          applyTransform();
        },
        { signal: sig }
      );

      document.getElementById('fbZoomOut')?.addEventListener(
        'click',
        () => {
          scale = Math.max(0.2, scale * 0.8);
          applyTransform();
        },
        { signal: sig }
      );

      document.getElementById('fbZoomReset')?.addEventListener(
        'click',
        () => {
          scale = _initScale;
          panX = 0;
          panY = 0;
          applyTransform();
        },
        { signal: sig }
      );
    } catch (e) {
      console.warn('[Fishbone] zoom/pan init error:', e);
    }
  }

  /** 点击"查看报告"跳转到报告库 */
  function _viewFishboneReport() {
    const pid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
    const reports = typeof getReportLibrary === 'function' ? getReportLibrary() : [];
    const report = pid
      ? reports.find((r) => r.problemId === pid && r.analysisType === 'fishbone')
      : null;
    if (!report) {
      showToast('暂无鱼骨图报告', 'info');
      return;
    }
    if (typeof navigateTo === 'function') {
      navigateTo('page-report-library');
      setTimeout(() => {
        if (typeof showReportDetail === 'function') showReportDetail(report.id);
      }, 200);
    }
  }

  /** 绑定事件 */
  function bindEvents() {
    const container = document.getElementById('fishboneCategories');
    if (!container) return;

    const panel = document.getElementById('tool-fishbone');
    if (panel) {
      panel.addEventListener('toolpanel:show', async () => {
        const activePid =
          typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
        // 全局内存可能仍属于上一个问题。先按归属清空，再决定是否从当前问题恢复。
        if (_fishboneOwnerPid !== activePid) {
          fishboneData = {
            problem: '',
            phenomenon: '',
            categories: {},
            savedAt: null,
            importedContext: '',
            theme: 'premium'
          };
          CATEGORIES.forEach((cat) => {
            fishboneData.categories[cat.id] = [];
          });
          _fishboneOwnerPid = activePid;

          const probInput = document.getElementById('fishbone-problem');
          if (probInput) probInput.value = '';
          const refEl = document.getElementById('fishbone-phenomenon-ref');
          if (refEl) refEl.value = '';
          const ctxRefEl = document.getElementById('fishbone-context-ref');
          if (ctxRefEl) ctxRefEl.value = '';
          renderCategories();
        }
        const problem =
          activePid && typeof window.getProblemById === 'function'
            ? window.getProblemById(activePid)
            : null;
        if (problem) {
          const analyses = problem.analyses || {};
          const started =
            analyses['fishbone'] &&
            (analyses['fishbone'].status === 'in_progress' ||
              analyses['fishbone'].status === 'completed');
          if (!started) {
            // Clear fishboneData and DOM inputs, do NOT save to DB
            const emptyFb = {
              problem: '',
              phenomenon: '',
              categories: {},
              savedAt: null,
              importedContext: ''
            };
            if (window.Fishbone.CATEGORIES) {
              window.Fishbone.CATEGORIES.forEach((cat) => {
                emptyFb.categories[cat.id] = [];
              });
            }
            fishboneData = emptyFb;
            _fishboneOwnerPid = activePid;

            const probInput = document.getElementById('fishbone-problem');
            if (probInput) probInput.value = '';
            const refEl = document.getElementById('fishbone-phenomenon-ref');
            if (refEl) refEl.value = '';
            const ctxRefEl = document.getElementById('fishbone-context-ref');
            if (ctxRefEl) ctxRefEl.value = '';

            renderCategories();
            return;
          }
        }
        // 如果内存中已有鱼骨图数据（由 loadProblemToCurrent 写入），则直接渲染
        if (
          fishboneData &&
          (fishboneData.problem ||
            Object.values(fishboneData.categories || {}).some((arr) => arr && arr.length > 0))
        ) {
          const probInput = document.getElementById('fishbone-problem');
          if (probInput) {
            probInput.value = fishboneData.problem || '';
          }
          const refEl = document.getElementById('fishbone-phenomenon-ref');
          if (refEl) {
            refEl.value = fishboneData.phenomenon || '';
          }
          const ctxRefEl = document.getElementById('fishbone-context-ref');
          if (ctxRefEl) {
            ctxRefEl.value = fishboneData.importedContext || '';
          }
          renderCategories();
        } else {
          // 否则从 IndexedDB 加载
          await loadFishboneData();
        }

        // 示例加载的问题不自动预填，保持空状态让用户点击"分析"后再进入
        if (problem && problem._fromExample) {
          const emptyFb = {
            problem: '',
            phenomenon: '',
            categories: {},
            savedAt: null,
            importedContext: ''
          };
          if (window.Fishbone.CATEGORIES) {
            window.Fishbone.CATEGORIES.forEach((cat) => {
              emptyFb.categories[cat.id] = [];
            });
          }
          fishboneData = emptyFb;
          _fishboneOwnerPid = activePid;
          const probInput = document.getElementById('fishbone-problem');
          if (probInput) probInput.value = '';
          const refEl = document.getElementById('fishbone-phenomenon-ref');
          if (refEl) refEl.value = '';
          const ctxRefEl = document.getElementById('fishbone-context-ref');
          if (ctxRefEl) ctxRefEl.value = '';
          renderCategories();
          return;
        }

        // 兜底：如果加载后依然没有实质内容，且当前有活跃问题，自动预填
        const hasContent =
          fishboneData &&
          (fishboneData.problem ||
            Object.values(fishboneData.categories || {}).some((arr) => arr && arr.length > 0));
        if (!hasContent && activePid && problem) {
          fishboneData.problem = problem.title || '';
          fishboneData.phenomenon = problem.problemStatement || problem.details?.phenomenon || '';
          fishboneData.importedContext = window.buildProblemContext
            ? window.buildProblemContext(problem)
            : '';

          // 同步更新 DOM
          const probInput = document.getElementById('fishbone-problem');
          if (probInput) probInput.value = fishboneData.problem;
          const refEl = document.getElementById('fishbone-phenomenon-ref');
          if (refEl) refEl.value = fishboneData.phenomenon;
          const ctxRefEl = document.getElementById('fishbone-context-ref');
          if (ctxRefEl) ctxRefEl.value = fishboneData.importedContext;

          renderCategories();
        }

        // 兜底：如果当前处于图形视图模式，需要重新渲染 SVG 以校准排版与大小
        const displayEl = document.getElementById('fishboneDisplay');
        if (displayEl && !displayEl.classList.contains('hidden') && window.FishboneSVG) {
          window.FishboneSVG.render(fishboneData);
          _initFbZoomPan();
        }
      });
    }

    container.addEventListener('click', async (e) => {
      const addBtn = e.target.closest('.fishbone-add-cause');
      if (addBtn) {
        addCause(addBtn.dataset.cat);
        return;
      }

      const removeBtn = e.target.closest('.fishbone-remove-cause');
      if (removeBtn) {
        await removeCause(removeBtn.dataset.cat, parseInt(removeBtn.dataset.idx));
        return;
      }

      const addSubBtn = e.target.closest('.fishbone-add-sub');
      if (addSubBtn) {
        addSubCause(addSubBtn.dataset.cat, parseInt(addSubBtn.dataset.idx));
        return;
      }

      const removeSubBtn = e.target.closest('.fishbone-remove-sub');
      if (removeSubBtn) {
        await removeSubCause(
          removeSubBtn.dataset.cat,
          parseInt(removeSubBtn.dataset.ci),
          parseInt(removeSubBtn.dataset.si)
        );
        return;
      }

      const aiSuggestBtn = e.target.closest('.fishbone-ai-suggest');
      if (aiSuggestBtn) {
        aiSuggest(aiSuggestBtn.dataset.cat);
        return;
      }

      const aiExpandBtn = e.target.closest('.fishbone-ai-expand');
      if (aiExpandBtn) {
        aiExpand(aiExpandBtn.dataset.cat, parseInt(aiExpandBtn.dataset.idx));
        return;
      }
    });

    // Auto-save on input change
    container.addEventListener('input', () => {
      clearTimeout(_saveTimer);
      collectFormData();
      const _capturedPid =
        typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
      _fishboneOwnerPid = _capturedPid;
      const _capturedData = JSON.parse(JSON.stringify(fishboneData));
      _saveTimer = setTimeout(() => saveFishboneData(_capturedPid, _capturedData), SAVE_DEBOUNCE_MS);
    });

    const probInput = document.getElementById('fishbone-problem');
    const phenEl = document.getElementById('fishbone-phenomenon-ref');
    const inputHandler = () => {
      clearTimeout(_saveTimer);
      collectFormData();
      const _capturedPid =
        typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
      _fishboneOwnerPid = _capturedPid;
      const _capturedData = JSON.parse(JSON.stringify(fishboneData));
      _saveTimer = setTimeout(() => saveFishboneData(_capturedPid, _capturedData), SAVE_DEBOUNCE_MS);
    };
    probInput?.addEventListener('input', inputHandler);
    phenEl?.addEventListener('input', inputHandler);

    // AI buttons
    document.getElementById('btnAIFishboneAnalyze')?.addEventListener('click', aiAnalyze);
    document.getElementById('btnAIFishboneValidate')?.addEventListener('click', aiValidate);

    // Generate button
    document.getElementById('btnGenerateFishbone')?.addEventListener('click', async () => {
      const btn = document.getElementById('btnGenerateFishbone');
      btn.disabled = true;
      btn.textContent = '渲染中...';
      try {
        collectFormData();
        if (!fishboneData.problem) {
          showToast('请输入问题描述（鱼头）', 'error');
          return;
        }
        const _clickProblemId =
          typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
        await saveFishboneData();

        // 用户明确渲染成图 = 鱼骨图分析完成，标记为 completed
        if (typeof window.markAnalysisCompleted === 'function') {
          window.markAnalysisCompleted('fishbone', _clickProblemId);
        }
        // Show SVG display (form 保持可见，同屏显示)
        document.getElementById('fishboneDisplay').classList.remove('hidden');
        if (window.FishboneSVG) {
          window.FishboneSVG.render(fishboneData);
          _initFbZoomPan();
        }
      } finally {
        btn.disabled = false;
        btn.textContent = '渲染成图';
      }
    });

    // Load from problem manager
    document
      .getElementById('btnLoadFromProblem')
      ?.addEventListener('click', loadFromProblemManager);

    // Clear
    document.getElementById('btnClearFishbone')?.addEventListener('click', async () => {
      if (await showConfirm('确定清空当前鱼骨图分析吗？将移除原因和本地草稿，不影响问题信息和已保存报告。', 'danger')) {
        await clearFishbone();
        showToast('当前鱼骨图分析已清空（不影响问题信息和已保存报告）', 'info');
      }
    });

    // Export SVG
    document.getElementById('btnExportSVG')?.addEventListener('click', () => {
      if (window.FishboneSVG) window.FishboneSVG.exportSVG();
    });

    // Export PNG
    document.getElementById('btnExportFishbonePNG')?.addEventListener('click', async () => {
      const svgEl = document.querySelector('#fishboneSvgWrapper svg');
      if (svgEl) {
        const problemStatement =
          typeof getActiveProblemStatement === 'function' ? getActiveProblemStatement() : '鱼骨图';
        const safeTitle = problemStatement
          .replace(/[^\w一-龥]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 30);
        const filename = `Fishbone-${safeTitle}-${new Date().toISOString().slice(0, 10)}.png`;
        await window.UIUtils.exportPngFromSvg(svgEl, filename);
      } else {
        showToast('请先生成鱼骨图', 'error');
      }
    });

    // Generate comprehensive report (with overwrite confirm)
    document.getElementById('btnGenerateFishboneReport')?.addEventListener('click', async () => {
      const btn = document.getElementById('btnGenerateFishboneReport');
      btn.disabled = true;
      btn.textContent = '生成中...';
      try {
        const pid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
        if (pid) {
          const reports = typeof getReportLibrary === 'function' ? getReportLibrary() : [];
          const existing = reports.find(
            (r) => r.problemId === pid && r.analysisType === 'fishbone'
          );
          if (existing) {
            const ok = await showConfirm('该问题已有鱼骨图报告，确定覆盖生成？', 'info');
            if (!ok) {
              btn.disabled = false;
              btn.textContent = '生成报告';
              return;
            }
          }
        }
        await generateReport();
      } finally {
        btn.disabled = false;
        btn.textContent = '生成报告';
      }
    });

    // View report
    document
      .getElementById('btnViewFishboneReport')
      ?.addEventListener('click', _viewFishboneReport);
  }

  // ===== Expose API =====
  window.Fishbone = {
    renderFishboneForm: renderCategories,
    renderFishboneSVG: () => {
      if (window.FishboneSVG) {
        window.FishboneSVG.render(fishboneData);
        _initFbZoomPan();
      }
    },
    load: loadFishboneData,
    bindEvents: bindEvents,
    getData: () => {
      collectFormData();
      return fishboneData;
    },
    CATEGORIES: CATEGORIES,
    importFromProblemManager: loadFromProblemManager,
    generateReport: generateReport,
    generateLocalReport: generateLocalReport,
    toMarkdown: generateLocalReport,
    clear: clearFishbone
  };
  Object.defineProperty(window.Fishbone, 'fishboneData', {
    get: () => fishboneData,
    set: (val) => {
      fishboneData = val;
      _fishboneOwnerPid =
        typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
    },
    configurable: true
  });
})();
