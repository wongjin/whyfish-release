/**
 * ai.js — 所有 AI 相关功能
 *
 * 职责：AI API 调用层、自动分析、因果链提取与验证、根因归并、AI 建议与交互
 * 依赖：store.js（全局状态、esc/showToast/repairTruncatedJSON/createNode/findNode等）
 * config.js（getActiveApiKey/getActiveModel/activeProviderId/PROVIDER_DEFS）
 * prompts.js（PROMPTS 全局变量）
 * 被依赖：app.js
 *
 * P1-4 修复说明：
 * 本文件属于 "AI 调用层"，但由于历史原因直接操作了 DOM。
 * 当前通过 `SidebarUI` 对象将 DOM 操作集中管理，便于未来彻底剥离。
 */

// ===== UI 辅助对象（P1-4: DOM 操作集中管理）=====

// P0-2 修复：reasoning 作用域化为 { problemId, text }，防止跨问题泄漏。
// 写入时绑定捕获时的 problemId；读取时若当前 active problemId 不匹配则视作空。
// _reasoningPid 由 callAI / callAIWithThinking / callOpenAIStreaming 入口处捕获。
// window._lastReasoningContent 作为向后兼容镜像（测试/外部读取），核心读取走 _getReasoning。
let _reasoningPid = null;
let _lastReasoning = { problemId: null, text: '' };
function _setReasoningPid(val) {
  _reasoningPid = val;
}
function _setReasoning(text) {
  _lastReasoning = { problemId: _reasoningPid, text: text || '' };
  if (typeof window !== 'undefined') {
    window._lastReasoningContent = _lastReasoning.text;
  }
}
function _getReasoning() {
  const curPid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
  if (_lastReasoning.problemId && _lastReasoning.problemId !== curPid) {
    return ''; // 当前问题与 reasoning 捕获时不一致，丢弃
  }
  return _lastReasoning.text;
}

// AI 请求全局控制器，负责流控与取消
window.AICtrl = {
  controller: null,
  isRequestInFlight: false,
  _inflightBtnIds: ['btnAutoAnalyze', 'btnVerifyCausality', 'btnConsolidate'],
  _setButtonsDisabled: function (disabled) {
    this._inflightBtnIds.forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = disabled;
    });
    document.querySelectorAll('[data-action="ask-ai"]').forEach((btn) => {
      btn.disabled = disabled;
    });
  },
  start: function () {
    if (this.isRequestInFlight) {
      showToast('AI 分析仍在进行中，请等待或取消', 'warning');
      throw new Error('ALREADY_IN_FLIGHT');
    }
    // 立即设置标志 + 禁用按钮，缩小 TOCTOU 窗口
    this.isRequestInFlight = true;
    this._setButtonsDisabled(true);
    this.controller = new AbortController();
    document.body.classList.add('ai-inflight');
    return this.controller;
  },
  abort: function () {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    this.isRequestInFlight = false;
    document.body.classList.remove('ai-inflight');
    this._setButtonsDisabled(false);
    if (window.SidebarUI?.completeTask) {
      window.SidebarUI.completeTask({ status: 'error', message: '请求已取消' });
    } else if (window.SidebarUI) {
      window.SidebarUI.hideLoading();
    }
    showToast('AI 请求已取消', 'warning');
  },
  finish: function () {
    this.controller = null;
    this.isRequestInFlight = false;
    document.body.classList.remove('ai-inflight');
    this._setButtonsDisabled(false);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const btnCancelAi = document.getElementById('btnCancelAi');
  if (btnCancelAi) {
    btnCancelAi.addEventListener('click', () => {
      window.AICtrl.abort();
    });
  }

  // 移动端「返回」按钮：关闭侧边栏
  const btnSidebarBack = document.getElementById('btnSidebarBack');
  if (btnSidebarBack) {
    btnSidebarBack.addEventListener('click', () => {
      window.SidebarUI && window.SidebarUI.close();
    });
  }

  document.getElementById('btnAiResultLauncher')?.addEventListener('click', () => {
    window.SidebarUI?.openLatestResult();
  });
  document.getElementById('btnAiHistory')?.addEventListener('click', () => {
    window.SidebarUI?.showHistory();
  });

  const aiContent = document.getElementById('aiContent');
  if (aiContent) {
    aiContent.addEventListener('click', handleAiContentClick);
    aiContent.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const el = e.target.closest('.ai-suggestion, .thinking-toggle, [data-action]');
        if (el) {
          e.preventDefault();
          handleAiContentClick(e);
        }
      }
    });
    function handleAiContentClick(e) {
      const reportLink = e.target.closest('[data-ai-report-id]');
      if (reportLink) {
        e.preventDefault();
        const reportId = reportLink.dataset.aiReportId;
        if (typeof window.getReportById === 'function' && window.getReportById(reportId)) {
          window.SidebarUI?.close();
          window.navigateTo?.('page-report-library');
          window.showReportDetail?.(reportId);
        } else {
          showToast('关联报告已被删除', 'warning');
        }
        return;
      }

      const storedResult = e.target.closest('[data-ai-result-id]');
      if (storedResult) {
        e.preventDefault();
        window.SidebarUI?.openStoredResultById(storedResult.dataset.aiResultId);
        return;
      }

      // 1. toggleThinking
      const thinkingToggleBtn = e.target.closest('.thinking-toggle');
      if (thinkingToggleBtn) {
        e.preventDefault();
        toggleThinking(thinkingToggleBtn);
        return;
      }

      // 2. applyAutoTree
      const applyAutoTreeBtn = e.target.closest('[data-action="apply-auto-tree"]');
      if (applyAutoTreeBtn) {
        e.preventDefault();
        applyAutoTree();
        return;
      }

      // 3. applySuggestion
      const suggestionEl = e.target.closest('.ai-suggestion');
      if (suggestionEl) {
        e.preventDefault();
        const nodeId = +suggestionEl.dataset.nodeId;
        const index = +suggestionEl.dataset.index;
        applySuggestion(nodeId, index);
        return;
      }

      // 4. runAICausalValidation
      const runCausalBtn = e.target.closest('[data-action="run-causal-validation"]');
      if (runCausalBtn) {
        e.preventDefault();
        runAICausalValidation();
        return;
      }
    }
  }
  if (typeof window.on === 'function') {
    window.on('ai-results:changed', () => window.SidebarUI?.refreshResultLauncher());
    window.on('session:changed', () => window.SidebarUI?.refreshResultLauncher());
  }
  window.SidebarUI?.refreshResultLauncher();
});
const PHASE_INTERVAL = 8000;

function _makeSuggestionsFocusable(container) {
  container.querySelectorAll('.ai-suggestion, .thinking-toggle, [data-action]').forEach((el) => {
    if (!el.getAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.getAttribute('role')) el.setAttribute('role', 'button');
  });
}

function _getActiveAiUiContext() {
  const problemId = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
  const activeTool = document.querySelector('.tool-panel:not(.hidden)')?.id || '';
  const visiblePage = document.querySelector('.page-content:not(.hidden)')?.id || '';
  let tool = 'problem';
  if (visiblePage === 'page-analysis') {
    if (activeTool === 'tool-5why') tool = '5why';
    else if (activeTool === 'tool-fishbone') tool = 'fishbone';
    else if (activeTool === 'tool-fta') tool = 'fta';
  } else if (visiblePage === 'page-report-library') {
    tool = 'report';
  }
  return { problemId, tool };
}

function _aiActionFromTitle(title) {
  return String(title || 'analysis')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'analysis';
}

function _getCurrentAiInputHash(tool) {
  try {
    let payload = null;
    if (tool === '5why' && typeof calculateTreeHash === 'function') {
      return calculateTreeHash();
    }
    if (tool === 'fishbone' && window.Fishbone?.getData) {
      payload = JSON.parse(JSON.stringify(window.Fishbone.getData()));
      delete payload.savedAt;
      delete payload.theme;
    } else if (tool === 'fta' && window.FTA?.getData) {
      payload = JSON.parse(JSON.stringify(window.FTA.getData()));
      delete payload.viewMode;
      if (payload.metadata) {
        delete payload.metadata.createdAt;
        delete payload.metadata.updatedAt;
        delete payload.metadata.aiCallCount;
      }
    } else if (tool === 'problem' && window.ProblemManager?.getData) {
      payload = { ...window.ProblemManager.getData() };
      delete payload.assessment;
      delete payload.savedAt;
    }
    return payload && typeof simpleHashCode === 'function'
      ? simpleHashCode(JSON.stringify(payload))
      : '';
  } catch (_) {
    return '';
  }
}

function _collectAiResultBlocks(container) {
  if (!container) return [];
  const blocks = [];
  Array.from(container.children).forEach((node) => {
    if (
      node.classList.contains('reasoning-stream') ||
      node.classList.contains('ai-completion-bar') ||
      node.classList.contains('ai-loading')
    ) {
      return;
    }
    const clone = node.cloneNode(true);
    clone
      .querySelectorAll('button, input, select, textarea, [data-action], .thinking-content')
      .forEach((interactive) => interactive.remove());
    const heading = clone.querySelector('h1, h2, h3, h4');
    const title = heading ? (heading.textContent || '').trim().slice(0, 240) : '';
    if (heading) heading.remove();
    const text = (clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
    if (!text) return;
    let kind = 'default';
    if (node.classList.contains('is-success')) kind = 'success';
    else if (node.classList.contains('is-warning')) kind = 'warning';
    else if (node.classList.contains('is-error')) kind = 'error';
    blocks.push({
      kind,
      title,
      text
    });
  });
  if (!blocks.length) {
    const text = (container.textContent || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
    if (text) blocks.push({ kind: 'default', title: '', text });
  }
  return blocks.slice(0, 24);
}

const SidebarUI = {
  _task: null,
  _reasoningTimer: null,
  _liveResultId: null,
  _liveContextKey: '',
  _unreadResultId: null,
  getElements() {
    return {
      sidebar: document.getElementById('aiSidebar'),
      content: document.getElementById('aiContent'),
      loading: document.getElementById('aiLoading'),
      headerTitle:
        document.getElementById('sidebarTitle') || document.querySelector('.sidebar-header h3'),
      footer: document.getElementById('sidebarFooter'),
      launcher: document.getElementById('btnAiResultLauncher'),
      historyButton: document.getElementById('btnAiHistory'),
      historyCount: document.getElementById('aiHistoryCount')
    };
  },
  /** 判断是否处于移动端（宽度 <= 1024px） */
  isMobile() {
    return window.matchMedia('(max-width: 1024px)').matches;
  },
  open(title) {
    const { sidebar, headerTitle, launcher } = this.getElements();
    if (sidebar) sidebar.classList.add('open');
    if (headerTitle) headerTitle.textContent = title || '';
    if (launcher) {
      launcher.classList.add('hidden');
      launcher.setAttribute('aria-expanded', 'true');
    }
    document.body.classList.add('ai-sidebar-open');
    this._syncFooterButtons();
    this._refreshHistoryButton();
    // 移动端：弹出后自动滚回内容顶部
    if (this.isMobile()) {
      const body = sidebar && sidebar.querySelector('.sidebar-body');
      if (body) body.scrollTop = 0;
    }
  },
  close() {
    const { sidebar, footer } = this.getElements();
    if (sidebar) {
      sidebar.classList.remove('open');
      sidebar.classList.remove('has-footer');
    }
    // 清空移动端底部操作栏
    if (footer) footer.innerHTML = '';
    document.body.classList.remove('ai-sidebar-open');
    this._clearReasoningTimer();
    this.refreshResultLauncher();
  },
  showLoading(initialText, phases, skipContentClear) {
    initialText = initialText || 'AI 正在分析...';
    const el = this.getElements();
    const loadingTextNode = document.getElementById('aiLoadingText');
    const elapsedEl = document.getElementById('aiLoadingElapsed');

    const taskTitle = el.headerTitle ? el.headerTitle.textContent : '';
    if (!this._task || this._task.settled) {
      const context = _getActiveAiUiContext();
      this._task = {
        title: taskTitle,
        action: _aiActionFromTitle(taskTitle),
        problemId: context.problemId,
        tool: context.tool,
        inputHash: _getCurrentAiInputHash(context.tool),
        startedAt: Date.now(),
        settled: false
      };
      this._liveResultId = null;
      this._liveContextKey = context.problemId + ':' + context.tool;
    }

    if (loadingTextNode) {
      loadingTextNode.textContent = initialText;
      this._clearPhaseTimer();
      if (phases && phases.length > 0) {
        let phaseIdx = 0;
        window._aiLoadingPhaseTimer = setInterval(() => {
          phaseIdx = (phaseIdx + 1) % phases.length;
          if (loadingTextNode) loadingTextNode.textContent = phases[phaseIdx];
        }, PHASE_INTERVAL);
      }
    }

    // 经过时间计数器
    if (elapsedEl) {
      elapsedEl.textContent = '';
      this._clearElapsedTimer();
      const t0 = this._task.startedAt;
      window._aiElapsedInterval = setInterval(() => {
        const secs = Math.floor((Date.now() - t0) / 1000);
        elapsedEl.textContent = 'AI 已分析 ' + secs + ' 秒';
      }, 1000);
    }

    if (el.loading) {
      el.loading.classList.remove('hidden');
      el.loading.style.display = 'flex';
    }
    if (!skipContentClear && el.content) el.content.innerHTML = '';
    if (!skipContentClear && el.footer) el.footer.innerHTML = '';
    const sidebar = document.getElementById('aiSidebar');
    if (sidebar) sidebar.classList.remove('has-footer');
  },
  hideLoading() {
    const { loading } = this.getElements();
    this._clearPhaseTimer();
    this._clearElapsedTimer();
    const elapsedEl = document.getElementById('aiLoadingElapsed');
    if (elapsedEl) elapsedEl.textContent = '';
    if (loading) {
      loading.classList.add('hidden');
      loading.style.display = 'none';
    }
  },
  showReasoningStream(label, contentId) {
    const id = contentId || 'aiReasoningContent';
    const safeLabel = esc(label || '模型推理输出');
    this.hideLoading();
    this.setContent(
      '<div class="reasoning-stream">' +
        '<div class="reasoning-stream-header">' +
        '<span class="reasoning-stream-dot"></span>' +
        safeLabel +
        '<span class="reasoning-stream-timer" data-role="reasoning-timer">⏱ 0s</span>' +
        '</div>' +
        '<div class="reasoning-stream-note">模型提供的实时推理输出，仅供辅助判断，不作为事实依据。</div>' +
        '<div class="reasoning-stream-content" id="' + esc(id) + '"></div>' +
        '</div>'
    );
    this._clearReasoningTimer();
    const updateTimer = () => {
      const timer = document.querySelector('[data-role="reasoning-timer"]');
      if (timer && this._task) {
        timer.textContent = '⏱ ' + Math.floor((Date.now() - this._task.startedAt) / 1000) + 's';
      }
    };
    updateTimer();
    this._reasoningTimer = setInterval(updateTimer, 1000);
  },
  updateReasoningStream(contentId, fullText) {
    const el = document.getElementById(contentId || 'aiReasoningContent');
    if (el) {
      el.textContent = fullText || '';
      el.scrollTop = el.scrollHeight;
    }
    const body = document.querySelector('.sidebar-body');
    if (body) body.scrollTop = body.scrollHeight;
  },
  completeTask(options = {}) {
    const task = this._task;
    if (!task || task.settled) return;
    if (options.title) task.title = String(options.title).slice(0, 240);
    if (options.reportId) task.reportId = String(options.reportId).slice(0, 160);
    this.hideLoading();
    this._clearReasoningTimer();
    const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(1);
    const status = options.status || 'success';
    const statusText =
      status === 'fallback' ? '已使用本地结构化结果' : status === 'error' ? 'AI 任务未完成' : 'AI 任务完成';
    let tokenInfo = '';
    if (options.usage && options.usage.total) {
      tokenInfo = ' &nbsp;&middot;&nbsp; 消耗 <strong>' + options.usage.total.toLocaleString() + '</strong> tokens';
    }
    const message = options.message ? '<span class="ai-completion-message">' + esc(options.message) + '</span>' : '';
    this.appendContent(
      '<div class="ai-completion-bar is-' + status + '"><strong>' + statusText + '</strong>' +
        message +
        '<span>⏱ 耗时 <strong>' + elapsed + 's</strong>' + tokenInfo + '</span></div>'
    );
    task.settled = true;
    if (status !== 'error' && options.persist !== false) this._persistTaskResult(task, status);
  },
  async _persistTaskResult(task, status) {
    if (!task?.problemId || typeof window.saveAIResult !== 'function') return;
    const { content } = this.getElements();
    const blocks = _collectAiResultBlocks(content);
    if (!blocks.length) return;
    const currentContext = _getActiveAiUiContext();
    const canReadCurrentInput =
      currentContext.problemId === task.problemId && currentContext.tool === task.tool;
    const saved = await window.saveAIResult({
      problemId: task.problemId,
      tool: task.tool,
      action: task.action,
      title: task.title || 'AI 分析结果',
      status,
      createdAt: new Date().toISOString(),
      model: typeof getActiveModel === 'function' ? getActiveModel() : '',
      inputHash:
        (canReadCurrentInput ? _getCurrentAiInputHash(task.tool) : '') || task.inputHash || '',
      reportId: task.reportId || '',
      blocks
    });
    if (!saved) return;
    this._liveResultId = saved.id;
    this._liveContextKey = saved.problemId + ':' + saved.tool;
    this._unreadResultId = saved.id;
    this.refreshResultLauncher();
    this._refreshHistoryButton();
  },
  _clearPhaseTimer() {
    if (window._aiLoadingPhaseTimer) {
      clearInterval(window._aiLoadingPhaseTimer);
      window._aiLoadingPhaseTimer = null;
    }
  },
  _clearElapsedTimer() {
    if (window._aiElapsedInterval) {
      clearInterval(window._aiElapsedInterval);
      window._aiElapsedInterval = null;
    }
  },
  _clearReasoningTimer() {
    if (this._reasoningTimer) {
      clearInterval(this._reasoningTimer);
      this._reasoningTimer = null;
    }
  },
  /** 移动端将侧边栏主要操作按钮克隆到 footer 常驻展示。 */
  _syncFooterButtons() {
    const { content, footer, sidebar } = this.getElements();
    if (!footer || !content) return;
    if (!this.isMobile()) return; // 桌面端不需要

    // 查找内容区中的主要操作按钮
    const applyBtn = content.querySelector(
      '[data-sidebar-primary="true"], [data-action="apply-auto-tree"]'
    );
    if (applyBtn) {
      // 克隆到 footer，内容区展示原定位的按钮隐藏
      applyBtn.style.display = 'none';
      const footerBtn = applyBtn.cloneNode(true);
      footerBtn.style.display = '';
      footerBtn.style.margin = '0';
      footer.innerHTML = '';
      footer.appendChild(footerBtn);
      if (sidebar) sidebar.classList.add('has-footer');
    } else {
      footer.innerHTML = '';
      if (sidebar) sidebar.classList.remove('has-footer');
    }
  },
  setContent(html) {
    const { content } = this.getElements();
    if (content) {
      content.innerHTML = safeSanitize(html);
      _makeSuggestionsFocusable(content);
    }
    this._syncFooterButtons();
  },
  appendContent(html) {
    const { content } = this.getElements();
    if (content) {
      content.insertAdjacentHTML('beforeend', safeSanitize(html));
      _makeSuggestionsFocusable(content);
    }
    this._syncFooterButtons();
  },
  /** 便捷：打开 + 显示 loading */
  openLoading(title) {
    this.open(title);
    this.showLoading();
  },
  /** 便捷：打开 + 隐藏 loading + 设置内容 */
  openContent(title, html, taskOptions) {
    const shouldComplete = this._task && !this._task.settled;
    this.open(title);
    this.hideLoading();
    this.setContent(html);
    if (shouldComplete) {
      const isError = /\bis-error\b/.test(html || '');
      this.completeTask({
        status: isError ? 'error' : 'success',
        usage: isError ? null : window._lastAiUsage,
        ...(taskOptions || {})
      });
    }
  },
  _getContextResults() {
    const context = _getActiveAiUiContext();
    if (!context.problemId || typeof window.getAIResults !== 'function') return [];
    return window.getAIResults(context.problemId, { tool: context.tool });
  },
  _refreshHistoryButton() {
    const { historyButton, historyCount } = this.getElements();
    if (!historyButton) return;
    const results = this._getContextResults();
    historyButton.classList.toggle('hidden', results.length === 0);
    if (historyCount) historyCount.textContent = results.length ? String(results.length) : '';
  },
  refreshResultLauncher() {
    const { sidebar, launcher } = this.getElements();
    if (!launcher) return;
    const latest = this._getContextResults()[0];
    const isOpen = Boolean(sidebar?.classList.contains('open'));
    launcher.classList.toggle('hidden', !latest || isOpen);
    launcher.classList.toggle('is-read', !latest || latest.id !== this._unreadResultId);
    launcher.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    launcher.setAttribute(
      'aria-label',
      latest ? '打开最近的 AI 结果：' + latest.title : '打开 AI 结果'
    );
    this._refreshHistoryButton();
  },
  openLatestResult() {
    const context = _getActiveAiUiContext();
    const latest = this._getContextResults()[0];
    if (!latest) return false;
    const contextKey = context.problemId + ':' + context.tool;
    if (this._liveResultId === latest.id && this._liveContextKey === contextKey) {
      this.open(latest.title);
      this._syncFooterButtons();
    } else {
      this.renderStoredResult(latest);
    }
    this._unreadResultId = null;
    this.refreshResultLauncher();
    return true;
  },
  renderStoredResult(result) {
    if (!result) return;
    const blocks = (result.blocks || [])
      .map((block) => {
        const tone = ['success', 'warning', 'error'].includes(block.kind)
          ? ' is-' + block.kind
          : '';
        const heading = block.title ? '<h4>' + esc(block.title) + '</h4>' : '';
        return (
          '<div class="ai-block ai-result-block' +
          tone +
          '">' +
          heading +
          '<p>' +
          esc(block.text) +
          '</p></div>'
        );
      })
      .join('');
    this.open(result.title);
    this.hideLoading();
    const currentHash = _getCurrentAiInputHash(result.tool);
    const isStale = Boolean(result.inputHash && currentHash && result.inputHash !== currentHash);
    const linkedReport =
      result.reportId && typeof window.getReportById === 'function'
        ? window.getReportById(result.reportId)
        : null;
    const reportLink = linkedReport
      ? '<button type="button" class="btn btn-outline btn-sm ai-result-report-link" data-ai-report-id="' +
        esc(result.reportId) +
        '">查看关联报告</button>'
      : result.reportId
        ? '<span class="ai-result-missing-report">关联报告已删除</span>'
        : '';
    this.setContent(
      '<div class="ai-result-archive-note">' +
        (isStale
          ? '当前分析数据已发生变化，这份历史结果可能已经过期，请重新运行校验。'
          : '这是已保存的 AI 结果快照，仅供追溯；不包含模型推理过程。') +
        '</div>' +
        blocks +
        reportLink
    );
    this._liveResultId = result.id;
    this._liveContextKey = result.problemId + ':' + result.tool;
  },
  showHistory() {
    const results = this._getContextResults();
    if (!results.length) return;
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    const items = results
      .map((result) => {
        const summary = result.blocks?.[0]?.text || '';
        return (
          '<button type="button" class="ai-history-item" data-ai-result-id="' +
          esc(result.id) +
          '"><span class="ai-history-item-head"><span class="ai-history-item-title">' +
          esc(result.title) +
          '</span><span class="ai-history-item-time">' +
          esc(formatter.format(new Date(result.createdAt))) +
          '</span></span><span class="ai-history-item-summary">' +
          esc(summary.slice(0, 140)) +
          '</span></button>'
        );
      })
      .join('');
    this.open('AI 结果记录');
    this.hideLoading();
    this.setContent(
      '<div class="ai-history-intro">保存最终分析结果，不保存模型推理过程。每类操作最多保留 5 条。</div><div class="ai-history-list">' +
        items +
        '</div>'
    );
  },
  openStoredResultById(resultId) {
    const result = this._getContextResults().find((item) => item.id === resultId);
    if (!result) return false;
    this.renderStoredResult(result);
    return true;
  }
};

// ===== Build tree context for AI =====
function buildTreeContext(node, indent = '') {
  if (!node) return '';
  let text = '';
  if (node.text) {
    const rc = node.isRootCause ? ' ← 【根因】' : '';
    const w = node.weight < 100 ? ` (贡献度 ${node.weight}%)` : '';
    text += `${indent}Why ${node.level}: ${node.text}${w}${rc}\n`;
    if (node.evidence.length > 0) {
      text += `${indent} 证据: ${node.evidence.join('；')}\n`;
    }
  }
  for (const child of node.children) {
    text += buildTreeContext(child, indent + ' ');
  }
  return text;
}

// ===== Unified AI Call Layer =====

/** Route API calls through local CORS proxy when needed */
function getProxyUrl(targetUrl) {
  // External HTTPS APIs (DeepSeek, etc.): direct request. CSP allows connect-src https:,
  // and these providers accept CORS. No local proxy needed.
  if (targetUrl.startsWith('https://')) {
    return targetUrl;
  }
  // http:// endpoints: blocked by CSP in browser, no proxy endpoint on static server.
  // Let aiFetch throw a clear error before the fetch attempt.
  return targetUrl;
}

/** Fetch with AI proxy support: Tauri IPC, browser proxy, or direct */
async function aiFetch(url, options = {}) {
  // Unencrypted http:// endpoints: blocked by CSP in browser (connect-src 'self' https:);
  // no /api/proxy endpoint on static server either. Desktop Tauri IPC handles it, but
  // for consistency and security, reject early with a clear message.
  if (url.startsWith('http://')) {
    const err = new Error('不支持的协议：自定义端点必须使用 https://（安全加密连接）');
    return {
      ok: false,
      status: 400,
      statusText: err.message,
      json: () => Promise.resolve({ error: { message: err.message } }),
      text: () => Promise.resolve(err.message),
      headers: new Headers()
    };
  }
  // Tauri native: use IPC command (no CORS issues)
  if (window.__TAURI__?.core?.invoke) {
    const { invoke } = window.__TAURI__.core;
    const headers = options.headers || {};
    const body = options.body || '';
    let abortHandler;
    try {
      const invokePromise = invoke('proxy_call', {
        args: {
          url: url,
          body: typeof body === 'string' ? body : JSON.stringify(body),
          authorization: headers['Authorization'] || null,
          x_api_key: headers['x-api-key'] || null,
          anthropic_version: headers['anthropic-version'] || null
        }
      });

      const abortPromise = new Promise((_, reject) => {
        if (options.signal) {
          if (options.signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
          abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
          options.signal.addEventListener('abort', abortHandler);
        }
      });

      const result = await Promise.race([invokePromise, abortPromise]);

      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => JSON.parse(result),
        text: () => result,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(result));
            controller.close();
          }
        })
      };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw err; // throw raw DOMException for outer block to catch
      }
      const msg = typeof err === 'string' ? err : err.message || 'Unknown error';
      return {
        ok: false,
        status: 502,
        statusText: msg,
        json: () => Promise.resolve({ error: { message: msg } }),
        text: () => Promise.resolve(msg),
        headers: new Headers()
      };
    } finally {
      if (options.signal && abortHandler) {
        options.signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  // Browser: use CORS proxy
  const proxyUrl = getProxyUrl(url);
  return fetch(proxyUrl, options);
}

// Fetch with 180s timeout handling
async function fetchWithTimeout(url, options, providerName = '', timeoutMs = 180000) {
  const ctrl = window.AICtrl?.controller;
  const signal = ctrl?.signal;
  let timeoutId;
  if (ctrl) {
    timeoutId = setTimeout(() => {
      if (ctrl && !ctrl.signal.aborted) ctrl.abort('timeout');
    }, timeoutMs);
  }
  try {
    return await aiFetch(url, { ...options, signal });
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') {
      if (signal && signal.reason === 'timeout') {
        throw new Error('API请求超时 (180s): 模型响应过慢，请稍后重试或切换模型');
      }
      throw new Error('AI 分析已取消');
    }
    const prefix = providerName ? ` (${providerName})` : '';
    throw new Error(`网络请求失败${prefix}: ` + fetchErr.message);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Call OpenAI-compatible API (DeepSeek, Custom)
async function callOpenAICompatible(systemInstruction, userPrompt, json = true, maxTokens = 8192) {
  const cfg = PROVIDER_DEFS[activeProviderId];
  const curApiKey = getActiveApiKey();
  let url;
  let modelName;

  if (activeProviderId === 'custom') {
    url = getActiveEndpoint();
    modelName = getActiveModel();
    if (!url) throw new Error('请设置自定义 API 端点 URL');
    if (!modelName) throw new Error('请设置自定义模型名称');
  } else {
    url = cfg.baseUrl;
    modelName = getActiveModel();
  }

  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: maxTokens
  };
  if (json) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${curApiKey}`
      },
      body: JSON.stringify(body)
    },
    cfg?.name || activeProviderId
  );

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    let errMsg = errData?.error?.message || errData?.message || res.statusText;
    // H1: Sanitize API key from error messages before surfacing to UI
    errMsg = errMsg.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer sk-***')
                   .replace(/sk-[A-Za-z0-9\-._~+/]+/g, 'sk-***');
    if (res.status === 404) {
      errMsg += ' (如遇 model not found，请在设置中手动修改模型名)';
    }
    throw new Error(`API ${res.status}: ${errMsg}`);
  }

  const data = await res.json();
  if (!data || typeof data !== 'object') {
    throw new Error('Empty AI response');
  }
  const choices = data.choices;
  if (!choices || !Array.isArray(choices) || choices.length === 0) {
    throw new Error('Empty AI response');
  }
  const message = choices[0]?.message;
  if (!message || typeof message !== 'object') {
    throw new Error('Empty AI response');
  }
  const text = message.content || '';
  const reasoning = message.reasoning_content || '';
  if (!text && !reasoning) {
    throw new Error('Empty AI response');
  }
  // 提取 token 使用量
  const usage = data.usage
    ? {
        prompt: data.usage.prompt_tokens || 0,
        completion: data.usage.completion_tokens || 0,
        total: data.usage.total_tokens || 0
      }
    : null;
  return { text: text || reasoning, reasoning, usage };
}

/** Clean and parse JSON from AI response text */
function parseAIJson(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('AI returned empty or null response');
  }
  let cleaned = text.trim();

  // Find all thinking ranges to ignore them during JSON candidate extraction
  const thinkingRanges = [];
  const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;
  let match;
  while ((match = thinkingRegex.exec(text)) !== null) {
    thinkingRanges.push({ start: match.index, end: thinkingRegex.lastIndex });
  }

  // Find all candidate JSON/Array start indices outside thinking ranges
  const indices = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && inString) {
      i++;
      continue;
    }
    if (text[i] === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (text[i] === '{' || text[i] === '[') {
      const insideThinking = thinkingRanges.some(r => i >= r.start && i < r.end);
      if (!insideThinking) {
        indices.push(i);
      }
    }
  }

  let parsed = null;
  let jsonStartIdx = -1;

  // Helper for reasoning extraction
  const extractReasoning = (prefix) => {
    let parts = [];
    const rx = /<thinking>([\s\S]*?)<\/thinking>/gi;
    let m;
    let lastIdx = 0;
    while ((m = rx.exec(prefix)) !== null) {
      parts.push(m[1].trim());
      lastIdx = rx.lastIndex;
    }
    const remaining = prefix.slice(lastIdx);
    const openIdx = remaining.toLowerCase().indexOf('<thinking>');
    if (openIdx >= 0) {
      const extracted = remaining.slice(openIdx + 10).trim();
      if (extracted) {
        parts.push(extracted);
      }
    }
    return parts.join('\n\n');
  };

  // Iterate to find the actual JSON payload
  for (let i = 0; i < indices.length; i++) {
    const startIdx = indices[i];
    let candidate = text.slice(startIdx).trim();

    // Strip markdown codeblock formatting if present in candidate
    candidate = candidate
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?\s*```\s*$/i, '')
      .trim();

    // Extract JSON substring by bracket/brace match count
    let candInString = false;
    let braceCount = 0;
    let bracketCount = 0;
    let endIdx = -1;
    for (let j = 0; j < candidate.length; j++) {
      if (candidate[j] === '\\' && candInString) {
        j++;
        continue;
      }
      if (candidate[j] === '"') {
        candInString = !candInString;
        continue;
      }
      if (candInString) continue;
      if (candidate[j] === '{') braceCount++;
      else if (candidate[j] === '}') {
        braceCount--;
        if (braceCount === 0 && bracketCount === 0) {
          endIdx = j;
          break;
        }
      }
      else if (candidate[j] === '[') bracketCount++;
      else if (candidate[j] === ']') {
        bracketCount--;
        if (braceCount === 0 && bracketCount === 0) {
          endIdx = j;
          break;
        }
      }
    }
    if (endIdx >= 0) {
      candidate = candidate.slice(0, endIdx + 1);
    }

    // Apply escape repair
    candidate = candidate.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');

    try {
      parsed = JSON.parse(candidate);
      jsonStartIdx = startIdx;
      cleaned = candidate;
      break;
    } catch (e) {
      const repaired = repairTruncatedJSON(candidate);
      if (repaired) {
        parsed = repaired;
        jsonStartIdx = startIdx;
        cleaned = candidate;
        break;
      }
    }
  }

  // If we found a JSON block, the text before it might contain thinking tags
  if (jsonStartIdx >= 0) {
    const prefix = cleaned === text.trim() ? '' : text.slice(0, jsonStartIdx).trim();
    const reasoningText = extractReasoning(prefix);
    if (reasoningText && !(typeof window !== 'undefined' && window._lastReasoningContent)) {
      _setReasoning(reasoningText);
    }
  } else {
    // If no JSON block found at all, check if the whole response is reasoning/thinking
    const reasoningText = extractReasoning(cleaned);
    if (reasoningText && !(typeof window !== 'undefined' && window._lastReasoningContent)) {
      _setReasoning(reasoningText);
    }
    throw new Error('AI returned invalid JSON. First 100 chars: ' + text.trim().slice(0, 100));
  }

  // Unbox array to object if the response returned array instead of object
  if (Array.isArray(parsed)) {
    parsed = parsed[0] || {};
  }
  return parsed;
}

// ===== 前置检查：在任何 loading UI 出现前验证 API Key =====
function assertApiReady() {
  if (!getActiveApiKey()) {
    showToast('请先在右上角设置中配置 API Key', 'error');
    return false;
  }
  return true;
}

// ===== 完成摘要：将耗时和 token 用量追加到侧边栏底部 =====
function _showAiCompletion(elapsedMs, usage) {
  if (window.SidebarUI?.completeTask) {
    window.SidebarUI.completeTask({ usage });
  }
}

// Unified AI call function - routes to correct provider
async function callAI(systemInstruction, userPrompt, json = true, maxTokens = 8192) {
  if (!getActiveApiKey()) {
    showToast('未检测到 API Key，请点击右上角“设置”进行配置。', 'error');
    throw new Error('No API key');
  }
  // P0-2: 捕获当前 problemId，绑定 reasoning 作用域
  _reasoningPid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
  // M3: start() 必须在 try 外部调用：若 start() 抛出 ALREADY_IN_FLIGHT，
  // 则 _started 为 false，finally 不会调用 finish() 清除正在飞行中请求的流控状态。
  let _started = false;
  try {
    window.AICtrl.start();
    _started = true;
    const result = await callOpenAICompatible(systemInstruction, userPrompt, json, maxTokens);
    window._lastAiUsage = result.usage || null;
    addTokenUsage(result.usage);
    _setReasoning(result.reasoning || '');
    if (json) return parseAIJson(result.text);
    return result.text;
  } finally {
    if (_started) window.AICtrl.finish();
  }
}

// Call AI with Thinking (CoT) enabled - returns { thinking, result }
// Supports reasoning_content from OpenAI compatible APIs (e.g. reasoning models)
async function callAIWithThinking(systemInstruction, userPrompt) {
  if (!getActiveApiKey()) {
    showToast('未检测到 API Key，请点击右上角“设置”进行配置。', 'error');
    throw new Error('No API key');
  }
  // P0-2: 捕获 problemId，作用域化 reasoning
  _reasoningPid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
  _setReasoning('');
  const result = await callAI(systemInstruction, userPrompt, true, 8192);
  const thinking = _getReasoning() || '（当前模型不支持或未输出思维链，已直接返回结果）';
  return { thinking, result };
}

// ===== Streaming API (SSE) for real-time reasoning display =====

async function callOpenAIStreaming(systemInstruction, userPrompt, callbacks, maxTokens = 8192, json = true) {
  if (!getActiveApiKey()) {
    showToast('未检测到 API Key，请点击右上角"设置"进行配置。', 'error');
    throw new Error('No API key');
  }
  // P0-2: 捕获 problemId，作用域化 reasoning
  _reasoningPid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
  // P0-3: 与 callAI 对齐的流控入口，防止并发 AI 请求
  window.AICtrl.start();
  try {
    return await _callOpenAIStreamingInner(systemInstruction, userPrompt, callbacks, maxTokens, json);
  } finally {
    window.AICtrl.finish();
  }
}

async function _callOpenAIStreamingInner(systemInstruction, userPrompt, callbacks, maxTokens, json = true) {
  const { onReasoning } = callbacks || {};
  const cfg = PROVIDER_DEFS[activeProviderId];
  const curApiKey = getActiveApiKey();
  let url, modelName;

  if (activeProviderId === 'custom') {
    url = getActiveEndpoint();
    modelName = getActiveModel();
    if (!url) throw new Error('请设置自定义 API 端点 URL');
    if (!modelName) throw new Error('请设置自定义模型名称');
  } else {
    url = cfg.baseUrl;
    modelName = getActiveModel();
  }

  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: maxTokens,
    stream: true
  };
  if (json) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${curApiKey}`
      },
      body: JSON.stringify(body)
    },
    cfg?.name || activeProviderId,
    300000 // Connection timeout: 300s
  );

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    let errMsg = errData?.error?.message || errData?.message || res.statusText;
    errMsg = errMsg.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer sk-***')
                   .replace(/sk-[A-Za-z0-9\-._~+/]+/g, 'sk-***');
    if (res.status === 404) {
      errMsg += ' (如遇 model not found，请在设置中手动修改模型名)';
    }
    throw new Error(`API ${res.status}: ${errMsg}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let fullReasoning = '';
  let usage = null;
  // H2: Guard against unbounded buffer growth from malicious/abnormal SSE endpoints
  const MAX_SSE_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

  // P0-2: 通过 _setReasoning 重置（绑定当前 _reasoningPid）
  _setReasoning('');

  let firstChunkReceived = false;
  let streamDone = false;
  while (!streamDone) {
    let readTimeoutId;
    const timeoutMs = firstChunkReceived ? 60000 : 300000;
    const readTimeoutPromise = new Promise((_, reject) => {
      readTimeoutId = setTimeout(() => {
        const type = firstChunkReceived ? '流式传输中无新数据(60s)' : '流传输开始前超时(300s)';
        reject(new Error(`${type}: 模型响应过慢，请稍后重试或切换模型`));
      }, timeoutMs);
    });

    let done, value;
    try {
      const readPromise = reader.read();
      const result = await Promise.race([readPromise, readTimeoutPromise]);
      done = result.done;
      value = result.value;
      if (value && value.length > 0) {
        firstChunkReceived = true;
      }
    } catch (err) {
      try { reader.cancel(); } catch (_) {}
      throw err;
    } finally {
      clearTimeout(readTimeoutId);
    }

    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // H2: Abort stream if buffer exceeds safety limit (after adding, stream non-terminal)
    if (buffer.length > MAX_SSE_BUFFER_BYTES) {
      reader.cancel();
      throw new Error('SSE 流数据超过 10MB 安全限制，已中止（服务器响应异常）');
    }

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta || {};
        if (delta.reasoning_content) {
          fullReasoning += delta.reasoning_content;
          // P0-2: 写入时绑定 _reasoningPid，读取方比对当前 problemId
          _setReasoning(fullReasoning);
          onReasoning?.(delta.reasoning_content, fullReasoning);
        }
        if (delta.content) {
          fullContent += delta.content;
        }
        if (parsed.usage) {
          usage = {
            prompt: parsed.usage.prompt_tokens || 0,
            completion: parsed.usage.completion_tokens || 0,
            total: parsed.usage.total_tokens || 0
          };
        }
        if (parsed.choices?.[0]?.finish_reason === 'stop') {
          streamDone = true;
          break;
        }
      } catch (e) {
        console.warn('[SSE] malformed line skipped:', data.substring(0, 80), e.message);
      }
    }
  }

  if (usage) addTokenUsage(usage);
  window._lastAiUsage = usage;
  return { text: fullContent, reasoning: fullReasoning, usage };
}

// ===== Auto-Analysis with CoT =====

async function autoAnalyze() {
  if (!assertApiReady()) return;
  const _aiCtx = captureAiContext();
  SidebarUI.open('AI 自动分析');
  SidebarUI.showLoading('正在连接 AI 服务...', [
    '正在连接 AI 服务...',
    '正在分析问题上下文...',
    '正在推演因果链...',
    '正在生成分析结果...'
  ]);
  const _t0 = Date.now();

  const existingCtx = tree ? buildTreeContext(tree) : '';
  const classification = window.ProblemManager?.getClassification?.() || '';
  const rendered = renderPrompt('autoAnalyze', {
    problemStatement: problemStatement,
    problemContext: problemContext || 'Not provided',
    existingAnalysis: existingCtx ? '\nExisting analysis (for reference):\n' + existingCtx : '',
    problemClassification: classification ? '问题分类（来自评估）：' + classification : ''
  });
  if (!rendered) {
    showToast('AI 分析失败：prompt 模板 autoAnalyze 未找到', 'error');
    SidebarUI.hideLoading();
    return;
  }
  const sys = rendered.system;
  const prompt = rendered.user;

  try {
    let reasoningStreamActive = false;
    let result, thinking;

    try {
      const { text: streamContent, reasoning: streamReasoning } = await callOpenAIStreaming(
        sys,
        prompt,
        {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningStreamActive) {
              reasoningStreamActive = true;
              SidebarUI.showReasoningStream('模型推理输出', 'reasoningContent');
            }
            SidebarUI.updateReasoningStream('reasoningContent', fullText);
          }
        }
      );

      result = parseAIJson(streamContent);
      // P0-2: 通过 _getReasoning 比对 problemId，跨问题切换时返回空
      thinking = streamReasoning || _getReasoning() || '';
    } catch (streamErr) {
      if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') {
        throw streamErr;
      }
      console.warn('[AI] Streaming failed, falling back:', streamErr.message);
      SidebarUI.hideLoading();
      SidebarUI.showLoading('正在分析问题上下文...', null, true);
      const fb = await callAIWithThinking(sys, prompt);
      result = fb.result;
      thinking = fb.thinking;
    }

    SidebarUI.hideLoading();

    if (!checkAiContext(_aiCtx, 'autoAnalyze')) return;

    let html = '';

    if (thinking) {
      html += '<div class="thinking-block">';
      html +=
        '<button class="thinking-toggle open" data-action="toggle-thinking" aria-expanded="true">';
      html += '<span class="chevron">\u25B6</span> AI 思考过程（点击收起）</button>';
      html += '<div class="thinking-content open">' + esc(thinking) + '</div>';
      html += '</div>';
    }

    if (result.error) {
      html += '<div class="ai-block is-warning">';
      html += '<h4>⚠️ 无法分析</h4><p>' + esc(result.error) + '</p></div>';
      SidebarUI.setContent(html);
      return;
    }
    if (result.summary) {
      html += '<div class="ai-block"><h4>分析概要</h4>';
      html += '<p>' + esc(result.summary) + '</p>';
      if (result.rootCauseCount) {
        html +=
          '<p style="font-size:0.7rem;color:var(--text-muted);">分析深度: ' +
          (result.maxDepthReached || result.stoppedAtLevel || '?') +
          ' 层 | 识别根因: ' +
          result.rootCauseCount +
          ' 个</p>';
      }
      html += '</div>';
    }

    if (result.tree) {
      html += '<div class="ai-block"><h4>推演结果预览</h4>';
      html += renderAutoTreePreview(result.tree, 0);
      html += '</div>';

      html +=
        '<button class="btn btn-primary btn-block" data-action="apply-auto-tree" style="margin-top:8px;">';
      html += '应用到分析树</button>';
      html +=
        '<p style="font-size:0.65rem;color:var(--text-muted);text-align:center;margin-top:4px;">';
      html += '应用后你可以自由编辑、添加分支或修改根因标记</p>';

      window._autoTreeData = result.tree;
      window._autoTreeProblemId = _aiCtx.problemId;
    }

    SidebarUI.setContent(html);
    _showAiCompletion(Date.now() - _t0, window._lastAiUsage);
    showToast('AI 推演完成', 'success');
  } catch (err) {
    SidebarUI.hideLoading();
    const hint = getApiErrorHint(err.message);
    if (getActiveProblemId() === _aiCtx.problemId) {
      SidebarUI.setContent(
        '<div class="ai-block is-error">' +
          '<h4>推演失败</h4><p>' +
          esc(err.message) +
          '</p>' +
          '<p>' +
          esc(hint) +
          '</p></div>'
      );
    }
  }
}

function renderAutoTreePreview(node, depth) {
  if (depth > 20) {
    return (
      '<div class="auto-tree-indent" style="margin-left:' +
      depth * 20 +
      'px;">（层级超限已截断）</div>'
    );
  }
  if (!node || !node.text) return '';
  let html = '<div class="auto-tree-indent" style="margin-left:' + depth * 20 + 'px;">';
  html += '<div class="auto-tree-node">';
  const levelClass = node.isRootCause ? ' root-cause' : '';
  const label = node.isRootCause ? '\uD83C\uDFAF 根因' : 'Why ' + (depth + 1);
  html += '<span class="node-level' + levelClass + '">' + label + '</span>';
  html += '<span>' + esc(node.text) + '</span>';
  html += '</div></div>';
  if (node.children && node.children.length > 0) {
    node.children.forEach((child) => {
      html += renderAutoTreePreview(child, depth + 1);
    });
  }
  return html;
}

function applyAutoTree() {
  if (window._autoTreeProblemId && getActiveProblemId() !== window._autoTreeProblemId) {
    showToast('AI 推演结果与当前问题不匹配，无法应用', 'warning');
    return;
  }
  const data = window._autoTreeData;
  if (!data) return;

  // Preserve original problem statement before rebuilding
  const originalProblemText = tree ? tree.text : '';

  // Back up original state for rollback on validation failure
  const prevTree = tree;
  const prevNextId = nextId;

  // Rebuild the tree from AI data
  nextId = 1;
  const tempTree = buildNodeFromAI(data, null, 1);

  // Restore original problem text so the problem statement is not overwritten
  if (originalProblemText && tempTree) {
    tempTree.text = originalProblemText;
  }

  // Validate tree structure before applying (consistent with importSnapshot)
  try {
    validateTree(tempTree);
    tree = tempTree;
  } catch (err) {
    showToast('AI 生成的树结构异常: ' + err.message, 'error');
    tree = prevTree;
    nextId = prevNextId;
    // L3: Rebuild nodeIndex to remove contaminated AI nodes created during failed buildNodeFromAI
    if (typeof rebuildNodeIndex === 'function') rebuildNodeIndex();
    return;
  }

  window._autoTreeData = null; // 清理临时状态
  window._autoTreeProblemId = null;
  renderTree();
  autoSave();
  if (window.emit)
    window.emit('session:changed', { fields: ['tree', 'nextId'], source: 'applyAutoTree' });
  SidebarUI.close();
  showToast('已应用 AI 推演结果，可自由编辑', 'success');
}

const MAX_AI_TREE_DEPTH = 20;

function buildNodeFromAI(aiNode, parentId, level) {
  if (level > MAX_AI_TREE_DEPTH) {
    console.warn('buildNodeFromAI: 树深度超过上限（' + MAX_AI_TREE_DEPTH + '），已截断');
    return null;
  }
  const node = createNode(aiNode.text || '', parentId, level);
  node.isRootCause = aiNode.isRootCause || false;
  if (typeof aiNode.weight === 'number') node.weight = aiNode.weight;
  // P1-4: 严格验证 children 类型，防止 AI 返回 null/string 时崩溃
  const children = Array.isArray(aiNode.children) ? aiNode.children : [];
  if (children.length > 0) {
    children.forEach((child) => {
      if (child && typeof child === 'object') {
        const childNode = buildNodeFromAI(child, node.id, level + 1);
        if (childNode) node.children.push(childNode);
      }
    });
    // 归一化兄弟节点的权重为百分比
    normalizeWeights(node.children);
  }
  return node;
}

/**
 * 将兄弟节点的 1-10 评分归一化为 0-100% 百分比
 */
function normalizeWeights(siblings) {
  if (!siblings || siblings.length <= 1) return;
  const total = siblings.reduce((sum, n) => {
    return sum + (n.weight || 5);
  }, 0);
  // total 永不为 0（fallback 5 保证），直接归一化
  siblings.forEach((n) => {
    n.weight = Math.round(((n.weight || 5) / total) * 100);
  });

  // 修正舍入误差：将差值加到权重最大的节点上
  const sum = siblings.reduce((s, n) => {
    return s + n.weight;
  }, 0);
  if (sum !== 100 && siblings.length > 0) {
    const maxNode = siblings.reduce((a, b) => {
      return a.weight >= b.weight ? a : b;
    });
    maxNode.weight += 100 - sum;
  }
}

function toggleThinking(btn) {
  const isOpen = btn.classList.toggle('open');
  btn.setAttribute('aria-expanded', isOpen.toString());
  const content = btn.nextElementSibling;
  content.classList.toggle('open');
}

// ===== AI Skills =====

async function getAISuggestions(nodeId, onReasoning) {
  const node = nodeIndex.get(nodeId);
  const parentNode = node?.parentId != null ? nodeIndex.get(node.parentId) : null;
  const ctx = buildTreeContext(tree);

  const rendered = renderPrompt('suggest', {
    problemStatement: problemStatement,
    problemContext: problemContext || '无',
    treeContext: ctx || '尚未开始',
    whyLevel: node?.parentId === null ? 1 : Math.max(1, (node?.level || 2) - 1),
    parentContext: parentNode?.text ? `(上层问题或原因: "${parentNode.text}")` : ''
  });
  if (!rendered) {
    showToast('AI 分析失败：prompt 模板 suggest 未找到', 'error');
    return;
  }
  const sys = rendered.system;
  const prompt = rendered.user;

  try {
    const { text: streamContent, reasoning: streamReasoning } = await callOpenAIStreaming(
      sys, prompt, { onReasoning }
    );
    const result = parseAIJson(streamContent);
    if (result.error) throw new Error(result.error);
    return result;
  } catch (streamErr) {
    if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') {
      throw streamErr;
    }
    console.warn('[AI] getAISuggestions streaming failed, falling back:', streamErr.message);
    return await callAI(sys, prompt, true);
  }
}

// ===== 报告缓存机制 =====
// cachedReport/cachedTreeHash 已移至 store.js

// 简单的字符串哈希函数，用于比较树结构是否变化
function simpleHashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString();
}

// 计算树结构的哈希（用于判断是否需要重新生成报告）
function calculateTreeHash() {
  const treeJson = JSON.stringify({
    problem: problemStatement,
    context: problemContext,
    tree: tree,
    consolidated: window.consolidatedRootCauses
  });
  return simpleHashCode(treeJson);
}

/** 本地报告生成（不依赖 AI） */
function generateLocalReport(opts) {
  const t = (opts && opts.tree) || tree;
  const stmt = (opts && opts.problemStatement) || problemStatement;
  const ctx = (opts && opts.problemContext) || problemContext;
  const reportProblemId = (opts && opts.problemId) || getActiveProblemId();
  const sourceMode = (opts && opts.sourceMode) || 'local';
  const allNodes = collectAllNodes(t);
  const filled = allNodes.filter((n) => n.text);
  const rootCauses = allNodes.filter((n) => n.isRootCause);
  const startTime = typeof window !== 'undefined' ? window.analysisStartTime : null;
  const duration = startTime
    ? Math.round((Date.now() - new Date(startTime).getTime()) / 60000)
    : '?';

  // 因果链路径
  function getPaths(node, path, paths) {
    if (!node.text) {
      if (path.length > 0) paths.push([...path]);
      return;
    }
    path.push(node);
    if (node.children.length === 0) {
      paths.push([...path]);
    } else {
      node.children.forEach((c) => getPaths(c, path, paths));
    }
    path.pop();
  }
  const paths = [];
  getPaths(t, [], paths);

  let md = `# 5 Whys 问题分析报告\n\n`;

  // 报告关联的问题编号和标题
  if (reportProblemId) {
    const _rp = getProblemById(reportProblemId);
    if (_rp) {
      if (_rp.displayId) md += `**问题编号：** ${_rp.displayId}\n\n`;
      if (_rp.title) md += `**问题标题：** ${_rp.title}\n\n`;
    }
  }

  md += `## 1. 问题描述\n\n`;
  md += `**问题现象：** ${stmt}\n\n`;
  if (ctx) md += `**背景信息：** ${ctx}\n\n`;

  md += `## 2. 因果链分析\n\n`;
  md += `共 ${filled.length} 个节点，${paths.length} 条因果路径。\n\n`;
  paths.forEach((p, i) => {
    const chain = p.map((n) => `**Why ${n.level}** ${n.text}`).join(' → ');
    md += `**路径 ${i + 1}：** ${chain}\n\n`;
  });

  md += `## 3. 完整分析树\n\n`;
  md += '```\n' + buildTreeContext(t) + '```\n\n';

  if (rootCauses.length > 0) {
    md += `## 4. 根因分析\n\n`;
    md += `共识别 ${rootCauses.length} 个根因：\n\n`;
    rootCauses.forEach((rc, i) => {
      md += `### 根因 ${i + 1}：${rc.text}\n\n`;
      md += `- **层级：** Why ${rc.level}\n`;
      md += `- **贡献度：** ${rc.weight}%\n`;
      if (rc.evidence.length > 0) {
        md += `- **证据：** ${rc.evidence.join('；')}\n`;
      }
      md += '\n';
    });
  }

  md += window.ReportContract.buildAnalysisStatistics({
    nodeCount: filled.length,
    sourceMode,
    metrics: [['因果路径数', paths.length], ['根因数量', rootCauses.length]]
  });

  const now = new Date().toLocaleDateString('zh-CN');
  md += window.ReportContract.buildCapaSection({
    heading: '## 6. 纠正与预防措施 (CAPA)',
    dueDate: now,
    introduction: '本报告为本地结构化降级报告。请针对识别出的根本原因制定可验证的闭环措施。'
  });
  md += `\n## 7. 后续行动项\n\n`;
  md += window.ReportContract.buildActionItem('确认 CAPA 责任人与验证计划', now);
  md += window.ReportContract.buildMetadata({ sourceMode, durationMinutes: duration });

  if (!opts || !opts.tree) {
    setCachedReport(md);
    setCachedTreeHash(calculateTreeHash());
  }
  return md;
}

async function generateReport(forceRegenerate = false) {
  const _reportStart = Date.now();
  // Capture problem ID and tree hash at call-time (the very beginning) to prevent race conditions
  const _capturedProblemId = getActiveProblemId();
  const _capturedHash = calculateTreeHash();

  // 如果不是强制重新生成，且有缓存，且树结构没变，直接返回缓存
  if (!forceRegenerate && cachedReport) {
    if (_capturedHash === cachedTreeHash) {
      console.log('[AI] 树结构未变化，直接返回缓存的报告');
      return cachedReport;
    }
  }

  const ctx = buildTreeContext(tree);
  const allNodes = collectAllNodes(tree);
  const rootCauses = allNodes.filter((n) => n.isRootCause);

  // Deduplicate root causes before sending to AI
  const uniqueRoots = [];
  const seenTexts = new Set();
  rootCauses.forEach((n) => {
    const key = n.text.trim();
    if (!seenTexts.has(key)) {
      seenTexts.add(key);
      uniqueRoots.push(n);
    }
  });

  const rootCauseList =
    uniqueRoots.map((n) => `- Why ${n.level}: ${n.text} (同级分支贡献度 ${n.weight}%)`).join('\n') ||
    '用户未明确标记根因，请根据分析树判断';
  const consolidatedClusters = window.consolidatedRootCauses?.clusters;
  const consolidatedInfo = Array.isArray(consolidatedClusters) && consolidatedClusters.length > 0
    ? `\n【已归并的系统性根因】（优先使用此版本）：\n${consolidatedClusters.map((c) => `- [${c.priority}] ${c.name} (贡献 ${c.contribution}%, ${c.sourceIndices?.length || 0}条路径指向)\n 建议CAPA: ${c.capa}`).join('\n')}\n`
    : '';

  const rendered = renderPrompt('report', {
    today: new Date().toISOString().slice(0, 10),
    problemStatement: problemStatement,
    problemContext: problemContext || '无',
    treeContext: ctx,
    uniqueCount: uniqueRoots.length,
    totalCount: rootCauses.length,
    rootCauseList: rootCauseList,
    consolidatedInfo: consolidatedInfo
  });
  if (!rendered) {
    showToast('AI 分析失败：prompt 模板 report 未找到', 'error');
    return;
  }
  const sys = rendered.system;
  const prompt = rendered.user;

  let report = '';
  let reasoningShown = false;
  try {
    const streamed = await callOpenAIStreaming(
      sys,
      prompt,
      {
        onReasoning: (_chunk, fullText) => {
          if (!reasoningShown && window.SidebarUI) {
            reasoningShown = true;
            window.SidebarUI.showReasoningStream('模型正在生成 5 Whys 分析报告', 'reportReasoningContent');
          }
          window.SidebarUI?.updateReasoningStream('reportReasoningContent', fullText);
        }
      },
      12288,
      false
    );
    report = streamed.text;
    if (!report.trim()) throw new Error('流式响应未返回报告正文');
  } catch (streamErr) {
    if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') {
      throw streamErr;
    }
    console.warn('[AI] Report streaming failed, falling back:', streamErr.message);
    if (window.SidebarUI) {
      window.SidebarUI.showLoading('正在以兼容模式生成分析报告...', [
        '正在请求完整报告...',
        '正在校验报告结构...',
        '即将完成...'
      ], true);
    }
    report = await callAI(sys, prompt, false, 12288);
  }
  const reportValidation = window.ReportContract.validateAiReport(report, '5why');
  if (!reportValidation.valid) {
    throw new Error('AI 报告缺少必需章节：' + reportValidation.missing.join('、'));
  }

  // Post-processing: detect and truncate runaway repetitive output
  if (report && report.length > 15000) {
    const lines = report.split('\n');
    // If any single line is absurdly long (>2000 chars), it's a repetition loop
    const cleaned = lines.filter((line) => line.length < 2000);
    if (cleaned.length < lines.length) {
      report = cleaned.join('\n');
      console.warn(
        'Report post-processing: removed',
        lines.length - cleaned.length,
        'abnormally long lines'
      );
    }
  }

  // 在报告头部插入问题编号和标题
  if (_capturedProblemId) {
    const _rp = getProblemById(_capturedProblemId);
    if (_rp) {
      let header = '';
      if (_rp.displayId) header += `**问题编号：** ${_rp.displayId}\n\n`;
      if (_rp.title) header += `**问题标题：** ${_rp.title}\n\n`;
      if (header) report = `${header}\n${report}`;
    }
  }

  // 底部：附加审计元数据
  const _model = typeof getActiveModel === 'function' ? getActiveModel() : '';
  const elapsedSecs = ((Date.now() - _reportStart) / 1000).toFixed(1);
  const usage = window._lastAiUsage;
  report += window.ReportContract.buildMetadata({
    sourceMode: 'ai',
    model: _model,
    usage,
    elapsedSeconds: elapsedSecs
  });
  report = window.ReportContract.appendAnalysisStatistics(report, {
    nodeCount: allNodes.filter((node) => node.text).length,
    sourceMode: 'ai',
    metrics: [['根因数量', rootCauses.length], ['分析树节点总数', allNodes.length]]
  });

  // 仅当当前活跃问题仍然是调用时的那个问题时，才缓存结果
  if (getActiveProblemId() === _capturedProblemId) {
    setCachedReport(report);
    setCachedTreeHash(_capturedHash);
  }

  return report;
}

// ===== AI Interaction =====
async function askAIForNode(nodeId) {
  if (!assertApiReady()) return;
  const node = nodeIndex.get(nodeId);
  // Fix: capture context before async call
  const _aiCtx = captureAiContext();
  SidebarUI.open('');
  SidebarUI.showLoading('正在分析当前节点上下文...', [
    '正在分析当前节点上下文...',
    '正在识别分析方向...',
    '正在生成追问建议...'
  ]);

  let reasoningStreamActive = false;
  try {
    const result = await getAISuggestions(nodeId, (_chunk, fullText) => {
      if (!reasoningStreamActive) {
        reasoningStreamActive = true;
        SidebarUI.showReasoningStream('模型推理输出', 'reasoningContent');
      }
      SidebarUI.updateReasoningStream('reasoningContent', fullText);
    });
    SidebarUI.hideLoading();

    if (!checkAiContext(_aiCtx, 'askAIForNode')) return;

    let html = '';

    // Depth note
    if (result.depthNote) {
      html += `<div class="ai-block"><h4>深度评估</h4><p>${esc(result.depthNote)}</p></div>`;
    }

    // Stop advice
    if (result.stopAdvice) {
      html += `<div class="ai-block" style="border-color: var(--green-border); background: var(--green-lighter);">
        <h4>建议停止分析</h4><p>${esc(result.stopReason || '已接近可操作的根本原因。')}</p>
      </div>`;
    }

    // Suggestions
    if (result.suggestions?.length > 0) {
      const levelLabel = !node || node.parentId === null ? '问题' : `Why ${node.level - 1}`;
      html += `<div class="ai-block"><h4>建议的 ${levelLabel} 原因</h4>
        <p style="font-size:0.68rem;color:var(--text-muted);margin-bottom:8px;">点击可填入当前节点</p>`;
      window._currentSuggestions = result.suggestions;
      window._currentSuggestionsProblemId = _aiCtx.problemId;
      result.suggestions.forEach((s, i) => {
        html += `<div class="ai-suggestion" data-node-id="${nodeId}" data-index="${i}">
          <span class="cat">${esc(s.category)}</span>
          <div class="text">${esc(s.text)}</div>
          <div class="reason">${esc(s.reasoning)}</div>
        </div>`;
      });
      html += `</div>`;
    }

    SidebarUI.setContent(html);
  } catch (err) {
    SidebarUI.hideLoading();
    if (getActiveProblemId() === _aiCtx.problemId) {
      SidebarUI.setContent(`<div class="ai-block is-error">
        <h4>加载失败</h4><p>${esc(err.message)}</p>
        <p>你仍可手动输入原因。</p>
      </div>`);
    }
  }
}

function applySuggestion(nodeId, suggestionIndex) {
  const currentId = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
  if (window._currentSuggestionsProblemId && currentId !== window._currentSuggestionsProblemId) {
    showToast('建议与当前问题不匹配，无法应用', 'warning');
    return;
  }
  const suggestions = window._currentSuggestions;
  if (!suggestions || !suggestions[suggestionIndex]) return;
  if (window.updateTreeNodeText(nodeId, suggestions[suggestionIndex].text)) {
    renderTree();
    window._currentSuggestions = null;
    window._currentSuggestionsProblemId = null;
  }
}

// ===== Causal Chain Extraction =====

// Extract all cause-effect pairs from the tree
function extractCausalLinks() {
  const links = [];
  function walk(node, parentNode = null) {
    if (!node || !node.text) return;
    // ⚡ Bolt: Performance Optimization - Use passed parentNode instead of O(N) findNode
    const parent = parentNode;
    const effectText = parent?.text || problemStatement;
    const effectLabel = parent?.text ? 'Why ' + parent.level : 'Problem';
    links.push({
      causeId: node.id,
      causeText: node.text,
      causeLevel: 'Why ' + node.level,
      effectText: effectText,
      effectLabel: effectLabel,
      weight: node.weight
    });
    for (const child of node.children) walk(child, node);
  }
  walk(tree);
  return links;
}

// ===== Causality Verification =====

// causalValidationResults is declared in store.js

// Get the causal validation key for a node (matching the key format used in extractUniqueCausalLinks)
function getCausalKeyForNode(node, parentNode = null) {
  if (!node || !node.text || node.parentId === null) return null;
  const parent = parentNode || nodeIndex.get(node.parentId);
  const effectText = parent?.text || problemStatement;
  return node.text.trim() + '|||' + effectText.trim().slice(0, 50);
}

function toggleCausalDetail(nodeId) {
  const el = document.getElementById('causal-detail-' + nodeId);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// Extract UNIQUE causal links (deduplicated), skip self-referencing top level
function extractUniqueCausalLinks() {
  const links = [];
  const seen = new Set();
  function walk(node, parentNode = null) {
    if (!node || !node.text) return;
    // ⚡ Bolt: Performance Optimization - Use passed parentNode instead of O(N) findNode
    const parent = parentNode;
    const effectText = parent?.text || problemStatement;
    // Skip if cause and effect are essentially the same (top level self-reference)
    if (node.text.trim() === effectText.trim()) {
      for (const child of node.children) walk(child, node);
      return;
    }
    // Skip if cause text is contained in effect (problem restated as Why1)
    if (effectText.length > 100 && effectText.includes(node.text.trim())) {
      for (const child of node.children) walk(child, node);
      return;
    }
    const key = node.text.trim() + '|||' + effectText.trim().slice(0, 50);
    if (!seen.has(key)) {
      seen.add(key);
      links.push({
        causeId: node.id,
        causeText: node.text,
        causeLevel: node.level,
        effectText: effectText,
        effectLevel: parent?.level || 0,
        key: key
      });
    }
    for (const child of node.children) walk(child, node);
  }
  walk(tree);
  return links;
}

function showCausalVerification() {
  const links = extractUniqueCausalLinks();
  if (links.length === 0) {
    showToast('请至少填写一个原因', 'error');
    return;
  }

  SidebarUI.open('因果链验证');
  SidebarUI.hideLoading();

  let html = '<div style="margin-bottom:12px;">';
  html += '<p style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">';
  html += '因果判断：' + links.length + ' 对唯一因果关系（已去重）</p>';
  html +=
    '<button class="btn btn-primary btn-sm" data-action="run-causal-validation" style="margin-bottom:8px;">';
  html += '逻辑校验全部因果链</button></div>';

  links.forEach((link, i) => {
    const validation = causalValidationResults[link.key];
    const stateClass = validation ? (validation.valid ? 'valid' : 'invalid') : 'unverified';

    html += '<div class="causal-link ' + stateClass + '">';
    html += '<div class="causal-statement">';
    html +=
      '<span style="font-size:0.6rem;color:var(--text-muted);margin-right:4px;">#' +
      (i + 1) +
      '</span>';
    html += '因为 <span class="cause">「' + esc(truncate(link.causeText, 60)) + '」</span>';
    html += '<span class="arrow">→ 所以</span>';
    html += '<span class="effect">「' + esc(truncate(link.effectText, 60)) + '」</span>';
    html += '</div>';

    if (validation) {
      const verdictClass = validation.valid ? 'pass' : 'fail';
      const icon = validation.valid ? '✅' : '❌';
      html +=
        '<div class="causal-verdict ' +
        verdictClass +
        '">' +
        icon +
        ' ' +
        (validation.valid ? '逻辑成立' : '逻辑存疑') +
        '</div>';
      if (validation.reason) {
        html += '<div class="causal-ai-note">' + esc(validation.reason) + '</div>';
      }
    } else {
      html += '<div class="causal-verdict pending"> 待验证</div>';
    }
    html += '</div>';
  });

  SidebarUI.setContent(html);
}

async function runAICausalValidation() {
  if (!assertApiReady()) return;
  const links = extractUniqueCausalLinks();
  if (links.length === 0) return;

  // Fix: capture context before async call
  const _aiCtx = captureAiContext();

  SidebarUI.showLoading('正在验证 ' + links.length + ' 对因果关系的逻辑成立性...', [
    '正在逐对验证 ' + links.length + ' 组因果关系...',
    '正在检查逻辑一致性...',
    '正在生成验证结果...'
  ]);
  const _tc0 = Date.now();

  const linksDesc = links
    .map((l, i) => {
      return (
        i +
        '. Because "' +
        truncate(l.causeText, 80) +
        '" -> therefore "' +
        truncate(l.effectText, 80) +
        '"'
      );
    })
    .join('\n');

  const rendered = renderPrompt('causalValidation', {
    problemStatement: truncate(problemStatement, 100),
    linkCount: links.length,
    linksDescription: linksDesc
  });
  if (!rendered) {
    showToast('AI 分析失败：prompt 模板 causalValidation 未找到', 'error');
    SidebarUI.hideLoading();
    return;
  }
  const sys = rendered.system;
  const prompt = rendered.user;

  let reasoningStreamActive = false;
  try {
    let result;
    try {
      const { text: streamContent } = await callOpenAIStreaming(sys, prompt, {
        onReasoning: (_chunk, fullText) => {
          if (!reasoningStreamActive) {
            reasoningStreamActive = true;
            SidebarUI.showReasoningStream('模型推理输出', 'reasoningContent');
          }
          SidebarUI.updateReasoningStream('reasoningContent', fullText);
        }
      });
      result = parseAIJson(streamContent);
    } catch (streamErr) {
      if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') {
        throw streamErr;
      }
      console.warn('[AI] Causal validation streaming failed, falling back:', streamErr.message);
      SidebarUI.hideLoading();
      SidebarUI.showLoading('正在验证 ' + links.length + ' 对因果关系的逻辑成立性...', null, true);
      result = await callAI(sys, prompt, true);
    }
    SidebarUI.hideLoading();

    // Check context
    if (!checkAiContext(_aiCtx, 'causalValidation')) return;

    if (result.validations) {
      // P1-7: 创建新引用触发 autoSave，而非就地修改
      const updatedResults = { ...causalValidationResults };
      result.validations.forEach((v) => {
        if (links[v.index]) {
          updatedResults[links[v.index].key] = {
            valid: v.valid,
            reason: v.reason
          };
        }
      });
      touch({ causalValidationResults: updatedResults }, 'causalValidation');
    }

    showCausalVerification();

    if (result.overallAssessment) {
      SidebarUI.appendContent(
        '<div class="ai-block" style="border-color:var(--primary);border-left:3px solid var(--primary);margin-top:12px;">' +
          '<h4> 整体评价</h4>' +
          '<p>' +
          esc(result.overallAssessment) +
          '</p></div>'
      );
    }

    _showAiCompletion(Date.now() - _tc0, window._lastAiUsage);
    showToast('因果链验证完成', 'success');
  } catch (err) {
    SidebarUI.hideLoading();
    if (getActiveProblemId() === _aiCtx.problemId) {
      SidebarUI.setContent(
        '<div class="ai-block is-error"><h4>验证失败</h4><p>' +
          esc(err.message) +
          '</p><p style="font-size:0.7rem;color:var(--text-muted);">请检查网络和模型配置后重试。因果链列表仍可手动审查。</p></div>'
      );
    }
    showToast('因果链验证失败', 'error');
  }
}

// ===== Root Cause Consolidation (Step 2: Convergence) =====
// consolidatedRootCauses is hosted on window.Store via store.js proxy

async function consolidateRootCauses() {
  if (!assertApiReady()) return;
  const allNodes = collectAllNodes(tree);
  const rootCauses = allNodes.filter((n) => n.isRootCause && n.text);

  if (rootCauses.length === 0) {
    showToast('请先标记至少一个根因', 'error');
    return;
  }
  renderTree(); // Refresh inline validation badges

  // Fix: capture context before async call
  const _aiCtx = captureAiContext();

  SidebarUI.open('根因归并');
  SidebarUI.showLoading('正在分析 ' + rootCauses.length + ' 个根因的模式...', [
    '正在分析 ' + rootCauses.length + ' 个根因的模式...',
    '正在归并相似根因...',
    '正在生成归并报告...'
  ]);
  const _tr0 = Date.now();

  // Build root cause list with path context
  const rcList = rootCauses.map((n) => {
    const path = [];
    let cur = n;
    while (cur) {
      if (cur.text) path.unshift('Why ' + cur.level + ': ' + cur.text);
      cur = cur.parentId != null ? nodeIndex.get(cur.parentId) : null;
    }
    return {
      text: n.text,
      level: n.level,
      weight: n.weight,
      path: path.join(' -> ')
    };
  });

  const rcDesc = rcList
    .map((r, i) => {
      return i + '. [Why ' + r.level + '] ' + r.text + '\n Path: ' + r.path;
    })
    .join('\n');

  const rendered = renderPrompt('consolidation', {
    problemStatement: problemStatement,
    rootCauseCount: rcList.length,
    rootCauseDescription: rcDesc
  });
  if (!rendered) {
    showToast('AI 分析失败：prompt 模板 consolidation 未找到', 'error');
    SidebarUI.hideLoading();
    return;
  }
  const sys = rendered.system;
  const prompt = rendered.user;

  let reasoningStreamActive = false;
  try {
    let result;
    try {
      const { text: streamContent } = await callOpenAIStreaming(sys, prompt, {
        onReasoning: (_chunk, fullText) => {
          if (!reasoningStreamActive) {
            reasoningStreamActive = true;
            SidebarUI.showReasoningStream('模型推理输出', 'reasoningContent');
          }
          SidebarUI.updateReasoningStream('reasoningContent', fullText);
        }
      });
      result = parseAIJson(streamContent);
    } catch (streamErr) {
      if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') {
        throw streamErr;
      }
      console.warn('[AI] Consolidation streaming failed, falling back:', streamErr.message);
      SidebarUI.hideLoading();
      SidebarUI.showLoading('正在分析 ' + rootCauses.length + ' 个根因的模式...', null, true);
      result = await callAI(sys, prompt, true);
    }
    SidebarUI.hideLoading();

    if (!checkAiContext(_aiCtx, 'consolidateRootCauses')) return;

    touch({ consolidatedRootCauses: result }, 'consolidateRootCauses');

    let html = '';

    // Summary
    if (result.summary) {
      html += '<div class="consolidation-summary">' + esc(result.summary) + '</div>';
    }

    // Clusters
    if (result.clusters && result.clusters.length > 0) {
      html +=
        '<div style="margin-bottom:6px;font-size:0.7rem;color:var(--text-muted);">' +
        rcList.length +
        ' 个原始根因 → ' +
        result.clusters.length +
        ' 个系统性根因</div>';

      result.clusters.forEach((c, ci) => {
        const pClass = c.priority === 'high' ? 'high' : c.priority === 'medium' ? 'medium' : 'low';
        const pLabel = c.priority === 'high' ? '高' : c.priority === 'medium' ? '中' : '低';
        const pathCount = c.sourceIndices ? c.sourceIndices.length : 0;

        html += '<div class="consolidated-card priority-' + pClass + '">';
        html += '<div class="consolidated-header">';
        html += '<span class="priority-badge ' + pClass + '">' + pLabel + '</span>';
        html += '<span class="path-count">' + pathCount + ' 条路径指向</span>';
        if (c.contribution) {
          html +=
            '<span style="font-size:0.65rem;font-weight:700;color:var(--primary);margin-left:auto;">' +
            c.contribution +
            '%</span>';
        }
        html += '</div>';
        html += '<div class="consolidated-title">' + esc(c.name) + '</div>';

        // Source root causes
        if (c.sourceIndices && c.sourceIndices.length > 0) {
          html += '<div class="consolidated-sources">';
          c.sourceIndices.forEach((idx) => {
            if (rcList[idx]) {
              html += '<div class="source-item">' + esc(rcList[idx].text) + '</div>';
            }
          });
          html += '</div>';
        }

        // CAPA
        if (c.capa) {
          html += '<div class="consolidated-capa"> ' + esc(c.capa) + '</div>';
        }

        html += '</div>';
      });
    }

    SidebarUI.setContent(html);
    _showAiCompletion(Date.now() - _tr0, window._lastAiUsage);
    showToast('根因归并完成', 'success');
  } catch (err) {
    SidebarUI.hideLoading();
    if (getActiveProblemId() === _aiCtx.problemId) {
      SidebarUI.setContent(
        '<div class="ai-block is-error">' +
          '<h4>归并失败</h4><p>' +
          esc(err.message) +
          '</p></div>'
      );
    }
  }
}
window.SidebarUI = SidebarUI;
/** 在侧边栏内容后追加 AI 思考过程折叠块（如存在） */
window.wrapWithThinking = function (html) {
  // P0-2: 通过 _getReasoning 比对 problemId，跨问题切换时不渲染陈旧 reasoning
  const thinking = _getReasoning();
  if (thinking && thinking.trim()) {
    html +=
      '<div class="thinking-block"><button class="thinking-toggle open" data-action="toggle-thinking" aria-expanded="true"><span class="chevron">▶</span> AI 思考过程（点击收起）</button><div class="thinking-content open">' +
      window.esc(thinking) +
      '</div></div>';
  }
  return html;
};
window.generateLocalReport = generateLocalReport;
window.getAISuggestions = getAISuggestions;
window.callAI = callAI;
window.assertApiReady = assertApiReady;

if (typeof module !== 'undefined' && module.exports)
  module.exports = {
    extractCausalLinks,
    buildTreeContext,
    normalizeWeights,
    parseAIJson,
    getProxyUrl,
    simpleHashCode,
    calculateTreeHash,
    getCausalKeyForNode,
    extractUniqueCausalLinks,
    _setReasoning,
    _getReasoning,
    wrapWithThinking,
    _setReasoningPid,
    SidebarUI,
    callOpenAIStreaming,
    getAISuggestions,
    callOpenAICompatible
  };
