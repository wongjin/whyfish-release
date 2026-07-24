/**
 * problem-pool.js — 问题库：渲染 + 详情 + 事件
 *
 * 职责：问题库列表渲染、问题详情展示、新建/保存/删除/导出/加载到分析
 * 依赖：store.js (getProblemList/getProblemById/createNewProblem/updateProblem/
 *        deleteProblem/saveCurrentAnalysisToProblem/loadProblemToCurrent),
 *        ui-utils.js (showToast/esc), ProblemManager (load/getData/collect/clear)
 * 暴露：renderProblemList, showProblemDetail, openProblemPicker
 */

(function () {
  'use strict';

  // 动态获取 Labels 避免脚本加载顺序或网络错误导致崩溃
  const Labels = new Proxy(
    {},
    {
      get(target, prop) {
        return (window.Labels && window.Labels[prop]) || {};
      }
    }
  );

  // 封装 getReportLibrary 避免 ReferenceError
  const _getReportLibrary = () => {
    if (typeof window.getReportLibrary === 'function') return window.getReportLibrary();
    if (typeof getReportLibrary === 'function') return getReportLibrary();
    return [];
  };

  // 视图状态
  let _viewMode = 'card';
  let _listFilter = 'all';
  const PROBLEM_MOBILE_QUERY = '(max-width: 1024px)';

  function _isMobileProblemLayout() {
    return typeof window.matchMedia === 'function' && window.matchMedia(PROBLEM_MOBILE_QUERY).matches;
  }

  function waitForElement(selector, callback, maxRetries) {
    if (maxRetries === undefined) maxRetries = 10;
    let retries = 0;
    function check() {
      const el = document.querySelector(selector);
      if (el) {
        callback(el);
      } else if (retries < maxRetries) {
        retries++;
        requestAnimationFrame(check);
      }
    }
    check();
  }

  function collectProblemFormData() {
    if (!window.ProblemManager) return {};
    if (typeof window.ProblemManager.getData === 'function') return window.ProblemManager.getData();
    if (typeof window.ProblemManager.collect === 'function') return window.ProblemManager.collect();
    return {};
  }

  // ===== Problem Pool Functions =====

  function _computeProblemStats() {
    const allProblems = getProblemList();
    const reports = _getReportLibrary();
    let analyzing = 0;
    let completed = 0;
    allProblems.forEach((p) => {
      if (p.status === 'completed') completed++;
      else if (p.status === 'analyzing' || (p.analyses && Object.keys(p.analyses).length > 0))
        analyzing++;
    });
    return {
      total: allProblems.length,
      analyzing: analyzing,
      completed: completed,
      reports: reports.length
    };
  }

  function _isProblemEmpty(p) {
    if (p.title && p.title.trim()) return false;
    if (p.problemStatement && p.problemStatement.trim()) return false;
    const d = p.details;
    if (
      d &&
      (d.phenomenon ||
        d.severity ||
        d.time ||
        d.discoverySource ||
        d.expectedState ||
        d.containment)
    )
      return false;
    return true;
  }

  function _cleanupEmptyProblems() {
    const problems = getProblemList();
    const filtered = problems.filter((p) => !_isProblemEmpty(p));
    if (filtered.length < problems.length) {
      saveProblemList(filtered);
    }
  }

  function renderStatsCard() {
    const stats = _computeProblemStats();
    let html = '<div class="hub-stats-bar">';
    html += '  <div class="hub-stat-card">';
    html += '    <div class="hub-stat-item stat-total">';
    html += '      <span class="hub-stat-num">' + esc(stats.total) + '</span>';
    html += '      <span class="hub-stat-label">问题总数</span>';
    html += '    </div>';
    html += '    <div class="hub-stat-item stat-analyzing">';
    html += '      <span class="hub-stat-num">' + esc(stats.analyzing) + '</span>';
    html += '      <span class="hub-stat-label">分析中</span>';
    html += '    </div>';
    html += '    <div class="hub-stat-item stat-completed">';
    html += '      <span class="hub-stat-num">' + esc(stats.completed) + '</span>';
    html += '      <span class="hub-stat-label">已完成</span>';
    html += '    </div>';
    html += '    <div class="hub-stat-item stat-reports">';
    html += '      <span class="hub-stat-num">' + esc(stats.reports) + '</span>';
    html += '      <span class="hub-stat-label">报告数</span>';
    html += '    </div>';
    html += '  </div>';
    html += '</div>';
    return html;
  }

  function renderEmptyState(container, statsHtml) {
    const btn = document.getElementById('btnCreateNewProblem');
    if (btn) btn.style.display = 'inline-flex';
    const emptyHtml =
      '<div class="empty-state">' +
      '<div class="empty-icon">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:40px;height:40px;">' +
      '<path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z" />' +
      '<circle cx="12" cy="10" r="3" />' +
      '</svg>' +
      '</div>' +
      '<h3>问题库为空</h3>' +
      '<p>您还没有创建任何问题。点击上方"新建问题"按钮，开启您的质量分析之旅。</p>' +
      '</div>';
    container.innerHTML = statsHtml + emptyHtml;
  }

  function renderProblemCards(container, topHtml, problems) {
    const btn = document.getElementById('btnCreateNewProblem');
    if (btn) btn.style.display = 'inline-flex';

    const statusLabels = Labels.status || {};

    const _activeId = window.getActiveProblemId?.();
    let _liveNodeCount = 0,
      _liveRootCauseCount = 0;
    if (_activeId && typeof tree !== 'undefined' && tree && typeof collectAllNodes === 'function') {
      const _liveNodes = collectAllNodes(tree);
      _liveNodeCount = _liveNodes.length;
      _liveRootCauseCount = _liveNodes.filter((n) => n.isRootCause).length;
    }

    let html = topHtml + '<div class="problem-grid">';
    for (const problem of problems) {
      const date = problem.createdAt ? new Date(problem.createdAt) : null;
      const dateStr =
        date && !isNaN(date)
          ? date.toLocaleDateString('zh-CN') +
            ' ' +
            date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
          : '\u2014';

      const isActive = _activeId && problem.id === _activeId;
      const displayNodeCount = isActive ? _liveNodeCount : problem.nodeCount || 0;
      const displayRootCauseCount = isActive ? _liveRootCauseCount : problem.rootCauseCount || 0;

      const allReports = _getReportLibrary();
      const problemReports = allReports.filter((r) => r.problemId === problem.id);
      let reportsHtml = '';
      if (problemReports.length > 0) {
        const toolNames = {
          '5why': '5 Whys',
          fishbone: '鱼骨图',
          fta: '故障树',
          assessment: '问题评估（AI评估）'
        };
        reportsHtml +=
          '<div class="problem-card-reports">' +
          '<div class="problem-card-reports-label">' +
          '<svg class="badge-icon-svg" viewBox="0 0 24 24" style="width:12px;height:12px;margin-right:2px;vertical-align:middle;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          '<span>报告：</span>' +
          '</div>' +
          '<div class="problem-card-reports-list">' +
          problemReports
            .map((r) => {
              const label =
                esc(r.displayId || '报告') + ' (' + (toolNames[r.analysisType] || '分析') + ')';
              return (
                '<span class="problem-card-report-item report-link" data-report-id="' +
                esc(r.id) +
                '" title="查看报告：' +
                esc(r.title) +
                '">' +
                label +
                '</span>'
              );
            })
            .join('') +
          '</div>' +
          '</div>';
      }

      html +=
        '<div class="problem-card" data-problem-id="' +
        esc(problem.id) +
        '" tabindex="0" role="button">' +
        '<div class="problem-card-top-meta">' +
        (problem.displayId
          ? '<span class="problem-card-id">' + esc(problem.displayId) + '</span>'
          : '') +
        '<span class="problem-card-date">' +
        dateStr +
        '</span>' +
        '</div>' +
        '<div class="problem-card-header">' +
        '<div class="problem-card-title">' +
        esc(problem.title || '未命名问题') +
        '</div>' +
        '</div>' +
        '<div class="problem-card-preview">' +
        esc(problem.problemStatement || problem.problemContext || '暂无描述') +
        '</div>' +
        '<div class="problem-card-meta">' +
        '<div class="problem-card-meta-left">' +
        '<span class="problem-meta-badge status-' +
        problem.status +
        '">' +
        (statusLabels[problem.status] || statusLabels.pending) +
        '</span>' +
        '<span class="problem-meta-badge nodes">' +
        '<svg class="badge-icon-svg" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>' +
        '<span>' +
        displayNodeCount +
        ' 个节点</span>' +
        '</span>' +
        (displayRootCauseCount > 0
          ? '<span class="problem-meta-badge root-cause">' +
            '<svg class="badge-icon-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>' +
            '<span>' +
            displayRootCauseCount +
            ' 个根因</span>' +
            '</span>'
          : '') +
        '</div>' +
        '</div>' +
        reportsHtml +
        '</div>';
    }
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.problem-card').forEach((card) => {
      card.addEventListener('click', () => {
        showProblemDetail(card.dataset.problemId);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          showProblemDetail(card.dataset.problemId);
        }
      });
    });

    container.querySelectorAll('.problem-card .report-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        const reportId = link.dataset.reportId;
        if (reportId && typeof showReportDetail === 'function') {
          window.navigateTo('page-report-library');
          waitForElement('#reportDetailView', () => showReportDetail(reportId));
        }
      });
    });
  }

  function renderProblemList() {
    _cleanupEmptyProblems();
    const container = document.getElementById('problemListContainer');
    const detailView = document.getElementById('problemDetailView');
    if (!container || !detailView) return;
    container.classList.remove('hidden');
    detailView.classList.add('hidden');
    const problems = getProblemList();
    const statsHtml = renderStatsCard();
    if (problems.length === 0) {
      renderEmptyState(container, statsHtml);
      return;
    }
    const isMobileLayout = _isMobileProblemLayout();
    const topHtml = statsHtml + _renderViewControls(isMobileLayout);
    if (isMobileLayout) {
      _renderMobileProblemView(container, topHtml, problems);
    } else if (_viewMode === 'table') {
      _renderProblemTableView(container, topHtml, problems);
    } else {
      renderProblemCards(container, topHtml, problems);
    }

    container.querySelectorAll('[data-action="set-view"]').forEach((el) => {
      el.addEventListener('click', () => {
        _setViewMode(el.dataset.view);
      });
    });
  }

  function _renderViewControls(isMobileLayout) {
    let html = '<div class="view-toggle-bar">';
    if (!isMobileLayout) {
      html += '<div class="view-toggle-group" role="group" aria-label="问题展示方式">';
      html +=
        '<button type="button" class="btn btn-sm' +
        (_viewMode === 'card' ? ' btn-primary' : ' btn-outline') +
        '" data-action="set-view" data-view="card" aria-pressed="' +
        (_viewMode === 'card' ? 'true' : 'false') +
        '" title="查看问题摘要">';
      html +=
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>';
      html += ' 概览</button>';
      html +=
        '<button type="button" class="btn btn-sm' +
        (_viewMode === 'table' ? ' btn-primary' : ' btn-outline') +
        '" data-action="set-view" data-view="table" aria-pressed="' +
        (_viewMode === 'table' ? 'true' : 'false') +
        '" title="按分析方法查看进度">';
      html +=
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3z"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>';
      html += ' 分析进度</button>';
      html += '</div>';
      html += '<div class="view-toggle-spacer"></div>';
    }
    if (isMobileLayout || _viewMode === 'table') {
      html += _renderFilterBar();
    }
    html += '</div>';
    return html;
  }

  function _renderFilterBar() {
    const allProblems = getProblemList();
    const analyzing = allProblems.filter((p) => {
      return p.status !== 'completed';
    }).length;
    const completed = allProblems.filter((p) => {
      return p.status === 'completed';
    }).length;
    let html = '<div class="hub-filter-group" role="group" aria-label="问题状态筛选">';
    html +=
      '<button type="button" class="btn ' +
      (_listFilter === 'all' ? 'btn-primary' : 'btn-outline') +
      ' btn-sm" data-action="list-filter" data-filter="all" aria-pressed="' +
      (_listFilter === 'all' ? 'true' : 'false') +
      '">全部 <span class="filter-count">' +
      allProblems.length +
      '</span></button>';
    html +=
      '<button type="button" class="btn ' +
      (_listFilter === 'analyzing' ? 'btn-primary' : 'btn-outline') +
      ' btn-sm" data-action="list-filter" data-filter="analyzing" aria-pressed="' +
      (_listFilter === 'analyzing' ? 'true' : 'false') +
      '">未完成 <span class="filter-count">' +
      analyzing +
      '</span></button>';
    html +=
      '<button type="button" class="btn ' +
      (_listFilter === 'completed' ? 'btn-primary' : 'btn-outline') +
      ' btn-sm" data-action="list-filter" data-filter="completed" aria-pressed="' +
      (_listFilter === 'completed' ? 'true' : 'false') +
      '">已完成 <span class="filter-count">' +
      completed +
      '</span></button>';
    html += '</div>';
    return html;
  }

  function _setViewMode(mode) {
    _viewMode = mode;
    renderProblemList();
  }

  function _setListFilter(filter) {
    _listFilter = filter;
    renderProblemList();
  }

  function _filterAndSortProblems(problems) {
    let filtered = problems.slice();
    if (_listFilter === 'analyzing') {
      filtered = filtered.filter((p) => p.status !== 'completed');
    } else if (_listFilter === 'completed') {
      filtered = filtered.filter((p) => p.status === 'completed');
    }
    filtered.sort((a, b) => {
      const da = a.updatedAt || a.createdAt || '';
      const db = b.updatedAt || b.createdAt || '';
      return db.localeCompare(da);
    });
    return filtered;
  }

  function _renderMobileProblemView(container, topHtml, problems) {
    const filtered = _filterAndSortProblems(problems);
    const statusLabels = Labels.status || {};
    const methods = window.ANALYSIS_METHODS || [];

    let html = topHtml;
    if (filtered.length === 0) {
      html +=
        '<div class="empty-state">' +
        '<div class="empty-icon"><svg class="empty-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:40px;height:40px;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>' +
        '<h3>无符合筛选条件的问题</h3>' +
        '<p>可尝试切换其他筛选标签</p>' +
        '</div>';
      container.innerHTML = html;
      _bindTableEvents(container);
      return;
    }

    html += '<div class="mobile-problem-list">';
    filtered.forEach((problem) => {
      const analyses = problem.analyses || {};
      const reports = _getReportsForProblem(problem.id);
      const dateValue = problem.updatedAt || problem.createdAt;
      const date = dateValue ? new Date(dateValue) : null;
      const dateLabel = date && !isNaN(date) ? date.toLocaleDateString('zh-CN') : '—';
      const status = problem.status || 'pending';
      const statusLabel = statusLabels[status] || statusLabels.pending || '待分析';

      html +=
        '<article class="mobile-problem-card" data-problem-id="' +
        esc(problem.id) +
        '" aria-label="' +
        esc(problem.title || '未命名问题') +
        '">';
      html += '<div class="mobile-problem-card-head">';
      html +=
        '<span class="problem-card-id">' + esc(problem.displayId || '未编号') + '</span>';
      html +=
        '<span class="problem-meta-badge status-' + esc(status) + '">' + esc(statusLabel) + '</span>';
      html += '</div>';
      html +=
        '<button type="button" class="mobile-problem-title" data-action="pool-show-problem" data-problem-id="' +
        esc(problem.id) +
        '">' +
        esc(problem.title || '未命名问题') +
        '</button>';
      html +=
        '<p class="mobile-problem-preview">' +
        esc(problem.problemStatement || problem.problemContext || '暂无问题描述') +
        '</p>';
      html += '<div class="mobile-problem-meta">';
      html += '<span>' + esc(dateLabel) + '更新</span>';
      html += '<span>' + esc(problem.nodeCount || 0) + ' 个节点</span>';
      if ((problem.rootCauseCount || 0) > 0) {
        html += '<span>' + esc(problem.rootCauseCount) + ' 个根因</span>';
      }
      html += '</div>';
      html += '<div class="mobile-analysis-progress" aria-label="分析进度">';
      methods.forEach((method) => {
        const state = analyses[method.key];
        html += _renderMobileMethodButton(
          problem.id,
          method,
          state ? state.status : 'not_started'
        );
      });
      html += '</div>';
      html += '<div class="mobile-problem-footer">';
      if (reports.length > 0) {
        html +=
          '<button type="button" class="mobile-report-link" data-action="pool-view-reports" data-problem-id="' +
          esc(problem.id) +
          '">查看报告 <span>' +
          esc(reports.length) +
          ' 份</span></button>';
      } else {
        html += '<span class="mobile-report-empty">暂无分析报告</span>';
      }
      html +=
        '<button type="button" class="mobile-detail-link" data-action="pool-show-problem" data-problem-id="' +
        esc(problem.id) +
        '">查看详情</button>';
      html += '</div></article>';
    });
    html += '</div>';
    container.innerHTML = html;
    _bindTableEvents(container);
  }

  function _renderMobileMethodButton(problemId, method, status) {
    let label = '未开始';
    let className = 'idle';
    if (status === 'completed') {
      label = '已完成';
      className = 'done';
    } else if (status === 'in_progress') {
      label = '分析中';
      className = 'progress';
    }
    return (
      '<button type="button" class="mobile-method-action ' +
      className +
      '" data-action="pool-launch-analysis" data-problem-id="' +
      esc(problemId) +
      '" data-method-key="' +
      esc(method.key) +
      '" aria-label="' +
      esc(method.name) +
      '：' +
      label +
      '">' +
      method.icon +
      '<span class="mobile-method-name">' +
      esc(method.name) +
      '</span><span class="mobile-method-status">' +
      label +
      '</span></button>'
    );
  }

  function _renderProblemTableView(container, topHtml, problems) {
    const btn = document.getElementById('btnCreateNewProblem');
    if (btn) btn.style.display = 'inline-flex';

    const filtered = _filterAndSortProblems(problems);

    let html = topHtml;

    if (filtered.length === 0) {
      html +=
        '<div class="empty-state">' +
        '<div class="empty-icon"><svg class="empty-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:40px;height:40px;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>' +
        '<h3>无符合筛选条件的问题</h3>' +
        '<p>可尝试切换其他筛选标签</p>' +
        '</div>';
      container.innerHTML = html;
      _bindTableEvents(container);
      return;
    }

    html += '<div class="hub-table-wrapper">';
    html += '<table class="hub-table">';
    html += '<thead><tr>';
    html += '<th class="col-index">#</th>';
    html += '<th class="col-id">问题编号</th>';
    html += '<th class="col-title">问题标题</th>';
    html += '<th class="col-status">状态</th>';
    html += '<th class="col-method">5 Whys</th>';
    html += '<th class="col-method">鱼骨图</th>';
    html += '<th class="col-method">故障树</th>';
    html += '<th class="col-report">报告</th>';
    html += '</tr></thead>';
    html += '<tbody>';
    filtered.forEach((problem, idx) => {
      html += _renderTableRow(problem, idx + 1);
    });
    html += '</tbody></table></div>';

    container.innerHTML = html;

    _bindTableEvents(container);
  }

  function _renderTableRow(problem, idx) {
    const analyses = problem.analyses || {};
    const statusLabels = Labels.status || {};
    const statusClasses = {
      pending: 'status-pending',
      analyzing: 'status-analyzing',
      completed: 'status-completed'
    };
    const statusClass = statusClasses[problem.status] || 'status-analyzing';
    const statusLabel = statusLabels[problem.status] || '分析中';

    let html = '<tr class="hub-table-row" data-problem-id="' + esc(problem.id) + '">';
    html += '<td class="col-index">' + idx + '</td>';
    html +=
      '<td class="col-id"><a class="problem-link" href="#" data-action="pool-show-problem" data-problem-id="' +
      esc(problem.id) +
      '">' +
      esc(problem.displayId || '-') +
      '</a></td>';
    html +=
      '<td class="col-title"><a class="problem-link" href="#" data-action="pool-show-problem" data-problem-id="' +
      esc(problem.id) +
      '">' +
      esc(problem.title || '未命名问题') +
      '</a></td>';
    html +=
      '<td class="col-status"><span class="status-badge ' +
      statusClass +
      '">' +
      statusLabel +
      '</span></td>';

    const methods = window.ANALYSIS_METHODS || [];
    methods.forEach((m) => {
      const state = analyses[m.key];
      const st = state ? state.status : 'not_started';
      html += _renderMethodCell(problem.id, m.key, st);
    });

    const reports = _getReportsForProblem(problem.id);
    html += '<td class="col-report">';
    if (reports.length > 0) {
      html +=
        '<a class="report-link" href="#" data-action="pool-view-reports" data-problem-id="' +
        esc(problem.id) +
        '">' +
        reports.length +
        ' 份</a>';
    } else {
      html += '<span class="no-report">—</span>';
    }
    html += '</td>';
    html += '</tr>';
    return html;
  }

  function _renderMethodCell(problemId, methodKey, status) {
    let label = '';
    let cls = 'idle';
    switch (status) {
      case 'completed':
        label = '\u2705 \u5df2\u5b8c\u6210';
        cls = 'done';
        break;
      case 'in_progress':
        label = '\u23f3 \u5206\u6790\u4e2d';
        cls = 'progress';
        break;
      default:
        label = '\u26aa \u672a\u5f00\u59cb';
        cls = 'idle';
    }
    return (
      '<td class="col-method ' +
      cls +
      '" data-action="pool-launch-analysis" data-problem-id="' +
      esc(problemId) +
      '" data-method-key="' +
      esc(methodKey) +
      '">' +
      '<span class="method-badge ' +
      cls +
      '">' +
      label +
      '</span></td>'
    );
  }

  function _bindTableEvents(container) {
    container.querySelectorAll('[data-action="list-filter"]').forEach((el) => {
      el.addEventListener('click', () => {
        _setListFilter(el.dataset.filter);
      });
    });
    container.querySelectorAll('[data-action="pool-show-problem"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        showProblemDetail(el.dataset.problemId);
      });
    });
    container.querySelectorAll('[data-action="pool-view-reports"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        _viewReportsFromTable(el.dataset.problemId);
      });
    });
    container.querySelectorAll('[data-action="pool-launch-analysis"]').forEach((el) => {
      el.addEventListener('click', () => {
        _launchAnalysisFromTable(el.dataset.problemId, el.dataset.methodKey);
      });
    });
  }

  function _viewReportsFromTable(problemId) {
    if (typeof setReportFilter === 'function') setReportFilter(problemId);
    window.navigateTo('page-report-library');
  }

  function _launchAnalysisFromTable(problemId, methodKey) {
    if (typeof window.launchAnalysisFromCard === 'function') {
      window.launchAnalysisFromCard(problemId, methodKey);
    }
  }

  function _getReportsForProblem(problemId) {
    if (typeof getReportLibrary !== 'function') return [];
    return getReportLibrary().filter((r) => {
      return r.problemId === problemId;
    });
  }

  function showProblemDetail(problemId) {
    const problem = getProblemById(problemId);
    if (!problem) {
      showToast('问题不存在', 'error');
      return;
    }

    setActiveProblemId(problemId);

    const container = document.getElementById('problemListContainer');
    const detailView = document.getElementById('problemDetailView');
    if (container) container.classList.add('hidden');
    if (detailView) {
      detailView.classList.remove('hidden');
      detailView.dataset.problemId = problemId;
    }

    const idDisplay = document.getElementById('problemIdDisplay');
    if (idDisplay) {
      let displayId = problem.displayId;
      if (!displayId) {
        const d = new Date(problem.createdAt);
        const dateStr =
          d.getFullYear().toString() +
          String(d.getMonth() + 1).padStart(2, '0') +
          String(d.getDate()).padStart(2, '0');
        displayId = 'P' + dateStr + '-001';
        if (typeof updateProblem === 'function') {
          updateProblem(problemId, { displayId });
        }
      }
      idDisplay.innerHTML = '<b>问题编号：  </b>' + esc(displayId);
    }

    if (window.ProblemManager) {
      const formData = problem.details ? { ...problem.details } : {};
      if (!formData.title && problem.title) {
        formData.title = problem.title;
      }
      if (!formData.phenomenon && problem.problemStatement) {
        formData.phenomenon = problem.problemStatement;
      }
      if (problem.snapshot && problem.snapshot.details) {
        Object.assign(formData, problem.snapshot.details);
      }
      window.ProblemManager.load(formData);
    }

    // Ensure auto-save is bound when detail view is shown
    bindProblemFormAutoSave();

    // 检查该问题是否有报告，控制查看报告按钮显隐
    const viewBtn = document.getElementById('btnViewReports');
    if (viewBtn) {
      const _reports = _getReportLibrary().filter((r) => r.problemId === problemId);
      viewBtn.style.display = _reports.length ? '' : 'none';
      viewBtn.onclick = () => {
        // P2-8: 每次点击实时查询，避免 closure 捕获的过期空数组导致"暂无报告"误判
        const rpts = _getReportLibrary().filter((r) => r.problemId === problemId);
        if (rpts.length === 0) {
          showToast('暂无报告', 'info');
          return;
        }
        if (rpts.length === 1) {
          window.navigateTo('page-report-library');
          setTimeout(() => {
            if (typeof showReportDetail === 'function') showReportDetail(rpts[0].id);
          }, 100);
          return;
        }
        // 多条报告 → 弹选择列表
        const reportTypeLabels = {
          '5why': '5 Whys 分析报告',
          fishbone: '鱼骨图分析报告',
          fta: '故障树分析报告',
          assessment: 'AI问题评估'
        };
        const listHtml = rpts
          .map(
            (r) =>
              `<button type="button" class="method-picker-btn" data-report-id="${esc(r.id)}">${esc(r.problemDisplayId || '')} - ${esc(reportTypeLabels[r.analysisType] || '报告')}</button>`
          )
          .join('');
        const modal = document.getElementById('analysisMethodPicker');
        const title = document.getElementById('analysisMethodTitle');
        const list = document.getElementById('analysisMethodList');
        if (modal && list) {
          if (title) title.textContent = '选择报告';
          list.innerHTML = listHtml;
          if (typeof closeAllDialogs === 'function') closeAllDialogs();
          modal.showModal();
        }
      };
    }
  }

  // ===== Problem Picker (从问题库选择) =====

  let _pickerCallback = null;

  function _renderPickerList(problems) {
    const container = document.getElementById('problemPickerList');
    const statusLabels = Labels.status || {};
    let html = '';
    for (const p of problems) {
      const date = p.createdAt ? new Date(p.createdAt) : null;
      const dateStr =
        date && !isNaN(date)
          ? date.toLocaleDateString('zh-CN') +
            ' ' +
            date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
          : '—';
      const preview = p.problemStatement || p.details?.phenomenon || p.problemContext || '暂无描述';
      html += `<div class="problem-picker-item" data-id="${esc(p.id)}" tabindex="0" role="button">
      <div class="problem-picker-item-title">${esc(p.title || '未命名问题')}</div>
      <div class="problem-picker-item-meta">
        <span class="picker-status ${p.status}">${statusLabels[p.status] || statusLabels.pending}</span>
        <span>${dateStr}</span>
      </div>
      <div class="problem-picker-item-preview">${esc(preview)}</div>
    </div>`;
    }
    container.innerHTML =
      html || '<div class="problem-picker-empty">问题库为空，请先在"问题管理"中创建问题</div>';

    let selectedId = null;
    const btnConfirm = document.getElementById('btnConfirmProblemPicker');
    container.querySelectorAll('.problem-picker-item').forEach((item) => {
      item.addEventListener('click', () => pickerSelect(item));
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pickerSelect(item);
        }
      });
    });
    function pickerSelect(item) {
      container
        .querySelectorAll('.problem-picker-item')
        .forEach((i) => i.classList.remove('selected'));
      item.classList.add('selected');
      selectedId = item.dataset.id;
      btnConfirm.disabled = false;
    }

    btnConfirm.onclick = () => {
      if (!selectedId) return;
      const problem = problems.find((p) => p.id === selectedId);
      if (problem && _pickerCallback) _pickerCallback(problem);
      _closePicker();
    };
  }

  function _closePicker() {
    document.getElementById('problemPickerModal')?.close();
    _pickerCallback = null;
  }

  function openProblemPicker(callback) {
    const problems = getProblemList();
    _pickerCallback = callback;
    _renderPickerList(problems);
    document.getElementById('problemPickerModal')?.showModal();
  }

  // ===== Problem Pool Events =====

  document.getElementById('btnCreateNewProblem')?.addEventListener('click', () => {
    const newProblem = createNewProblem({ title: '', status: 'pending' });
    if (newProblem && newProblem.id) {
      showProblemDetail(newProblem.id);
    } else {
      if (typeof showToast === 'function') showToast('创建新问题失败', 'error');
    }
  });

  document.getElementById('btnBackToProblemList')?.addEventListener('click', () => {
    // P1-10: 此前仅在 phenomenon/title 非空时才同步保存，导致只填了
    // severity/time/discoverySource 等字段的编辑在快速返回时丢失。
    // 改为调 autoSaveToProblemPool(true) — 它内部用 collectProblemFormData
    // 收集全部字段，并有 hasAnyContent 判断。
    const _detailView = document.getElementById('problemDetailView');
    const _pid = _detailView?.dataset.problemId || getActiveProblemId();
    if (_pid) {
      autoSaveToProblemPool(true);
    }

    // Flush pending autoSave to prevent stale closure data from overwriting
    if (typeof window.flushAutoSave === 'function') window.flushAutoSave();
    setActiveProblemId(null);
    if (_detailView) _detailView.dataset.problemId = '';
    renderProblemList();
  });

  // ===== 分析方法选择弹窗 =====
  const _methodModal = document.getElementById('analysisMethodPicker');

  function _openMethodPicker() {
    const phenomenon = document.getElementById('pm-problem-phenomenon')?.value.trim();
    if (!phenomenon) {
      showToast('请先填写问题现象', 'error');
      document.getElementById('pm-problem-phenomenon')?.focus();
      return;
    }
    if (!_methodModal || !document.getElementById('analysisMethodList')) {
      showToast('页面组件未就绪，请刷新后重试', 'error');
      return;
    }
    const title = document.getElementById('analysisMethodTitle');
    if (title) title.textContent = '选择分析方法';
    const list = document.getElementById('analysisMethodList');

    const methods = window.ANALYSIS_METHODS || [];
    list.innerHTML = methods
      .map(
        (m) =>
          // M1: m.icon 为内联 SVG，不可 esc()，且定义于源码 const 中，无需防注入
          `<button type="button" class="method-picker-btn" data-tool="${esc(m.tool)}" data-page="${esc(m.page)}">${m.icon}${esc(m.name)}</button>`
      )
      .join('');

    if (typeof closeAllDialogs === 'function') closeAllDialogs();
    _methodModal.showModal();
  }

  document
    .getElementById('btnCancelMethodPicker')
    ?.addEventListener('click', () => _methodModal?.close());
  document
    .getElementById('btnCloseMethodPicker')
    ?.addEventListener('click', () => _methodModal?.close());
  _methodModal?.addEventListener('click', (e) => {
    if (e.target === _methodModal) _methodModal.close();
  });
  _methodModal?.addEventListener('cancel', () => _methodModal?.close());

  document.getElementById('analysisMethodList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.method-picker-btn');
    if (!btn) return;
    _methodModal?.close();

    // 报告选择快捷路径
    const reportId = btn.dataset.reportId;
    if (reportId) {
      window.navigateTo('page-report-library');
      setTimeout(() => {
        if (typeof showReportDetail === 'function') showReportDetail(reportId);
      }, 100);
      return;
    }

    const tool = btn.dataset.tool;
    const page = btn.dataset.page;

    // 加载问题 & 导航
    const detailView = document.getElementById('problemDetailView');
    const viewingProblemId = detailView?.dataset.problemId || getActiveProblemId();
    if (!viewingProblemId) return;

    let _targetProblem = getProblemById(viewingProblemId);
    if (window.ProblemManager) {
      const details =
        typeof window.ProblemManager.getData === 'function'
          ? window.ProblemManager.getData()
          : typeof window.ProblemManager.collect === 'function'
            ? window.ProblemManager.collect()
            : {};
      const phenomenon = details.phenomenon || '';
      const title = details.title !== undefined ? details.title : _targetProblem?.title || '';
      if (phenomenon) {
        updateProblem(viewingProblemId, {
          title: title,
          problemStatement: phenomenon,
          details: details
        });
      }
    }

    _targetProblem = getProblemById(viewingProblemId);

    // 用户显式点击"分析"，清除示例标记，后续侧边栏导航将正常加载工具数据
    if (_targetProblem && _targetProblem._fromExample) {
      updateProblem(viewingProblemId, { _fromExample: false });
    }

    const methodKey =
      tool === 'tool-5why'
        ? '5why'
        : tool === 'tool-fishbone'
          ? 'fishbone'
          : tool === 'tool-fta'
            ? 'fta'
            : null;
    if (_targetProblem && methodKey) {
      const analyses = _targetProblem.analyses || {};
      if (!analyses[methodKey] || analyses[methodKey].status === 'not_started') {
        analyses[methodKey] = { status: 'in_progress', lastUpdated: new Date().toISOString() };
        updateProblem(viewingProblemId, { analyses: analyses });
      }
    }

    const hasActiveAnalysis = tree && tree.children && tree.children.length > 0;
    if (hasActiveAnalysis) {
      showToast('当前分析已保存，正在加载新问题...', 'info');
      autoSave();
    }

    setActiveProblemId(viewingProblemId);
    if (
      loadProblemToCurrent(viewingProblemId, () => {
        if (typeof window.syncToolDom === 'function') {
          window.syncToolDom(viewingProblemId, tool);
        }
        window.navigateTo(page, tool);
        const _toolLabels = {
          'tool-5why': '5 Whys 分析',
          'tool-fishbone': '鱼骨图分析',
          'tool-fta': '故障树分析'
        };
        showToast('问题已加载，开始 ' + (_toolLabels[tool] || tool), 'success');
      })
    ) {
      // loadProblemToCurrent returned true
    }
  });

  document.getElementById('btnStartProblemAnalysis')?.addEventListener('click', _openMethodPicker);

  // Auto-save to problem pool on form changes
  let _autoSaveProblemTimer = null;
  // `options.capturePlugins` (e.g. `{ fishbone: false, fta: false }`) is forwarded
  // to saveCurrentAnalysisToProblem to scope which plugin data is written into the
  // snapshot. Used by example loading to avoid cross-tool contamination.
  function autoSaveToProblemPool(immediate = false, options = {}) {
    clearTimeout(_autoSaveProblemTimer);
    const doSave = () => {
      // Use the problem ID from the detail view instead of global activeProblemId
      const detailView = document.getElementById('problemDetailView');
      const targetProblemId = detailView?.dataset.problemId || getActiveProblemId();
      if (!targetProblemId) return;

      const formData = collectProblemFormData();
      const phenomenon = formData.phenomenon || '';
      const title = formData.title !== undefined ? formData.title : null;

      // Fix J: skip full save when form is entirely empty (avoids polluting updatedAt)
      const hasAnyContent =
        phenomenon ||
        (title !== null && title !== '') ||
        formData.severity ||
        formData.time ||
        formData.discoverySource;
      if (!hasAnyContent) return;

      touch({ problemStatement: phenomenon }, 'problemPool');

      const _targetProblem = getProblemById(targetProblemId);
      const resolvedTitle = title !== null ? title : _targetProblem?.title || '';

      const saveOpts =
        options && options.capturePlugins !== undefined
          ? { capturePlugins: options.capturePlugins }
          : { capturePlugins: { fishbone: false, fta: false } };
      if (saveCurrentAnalysisToProblem(targetProblemId, resolvedTitle, true, saveOpts)) {
        // Fix B: determine status from the problem's own analyses field,
        // NOT from the global `tree` which belongs to the analysis tool context
        // and may reflect a completely different problem.
        const _p = getProblemById(targetProblemId);
        if (_p && _p.status !== 'completed') {
          const hasAnalyses = _p.analyses && Object.keys(_p.analyses).length > 0;
          updateProblem(targetProblemId, {
            status: hasAnalyses ? 'analyzing' : 'pending'
          });
        }
      }
    };

    if (immediate === true) {
      doSave();
    } else {
      _autoSaveProblemTimer = setTimeout(doSave, 800);
    }
  }

  // Bind auto-save to problem form inputs (idempotent)
  const _FORM_IDS = [
    'pm-problem-title',
    'pm-problem-phenomenon',
    'pm-severity',
    'pm-problem-time',
    'pm-discovery-source',
    'pm-expected-state',
    'pm-expected-source',
    'pm-expected-detail',
    'pm-trend',
    'pm-containment'
  ];
  let _autoSaveBound = false;
  function bindProblemFormAutoSave() {
    if (_autoSaveBound) return;
    const container = document.getElementById('problemDetailView');
    if (container) {
      const handler = (e) => {
        if (_FORM_IDS.indexOf(e.target.id) !== -1) autoSaveToProblemPool();
      };
      container.addEventListener('input', handler);
      container.addEventListener('change', handler);
    }
    _autoSaveBound = true;
  }
  // Note: bindProblemFormAutoSave() is called from showProblemDetail() when DOM elements exist.
  // Do NOT call it here — form elements don't exist at IIFE load time.

  document.getElementById('btnExportProblem')?.addEventListener('click', () => {
    // Use the problem ID from the detail view instead of global activeProblemId
    const detailView = document.getElementById('problemDetailView');
    const targetProblemId = detailView?.dataset.problemId || getActiveProblemId();
    if (!targetProblemId) return;

    const problem = getProblemById(targetProblemId);
    if (!problem) return;

    // Include associated reports
    const reports = _getReportLibrary().filter((r) => r.problemId === problem.id);
    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      problem: problem,
      reports: reports
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const safeTitle = (problem.title || 'problem')
      .replace(/[^\w一-龥]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
    window.UIUtils.saveExportBlob(
      blob,
      `problem-${safeTitle}-${new Date().toISOString().slice(0, 10)}.json`,
      {
        filterName: 'JSON 文件',
        extensions: ['json'],
        successMessage: '已导出（含 ' + reports.length + ' 份报告）'
      }
    );
  });

  // Import problem from file
  document.getElementById('btnImportProblem')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.position = 'absolute';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    input.style.zIndex = '-1';
    document.body.appendChild(input);
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // M2: 限制导入文件大小，防止超大 JSON 在主线程执行 JSON.parse 时冻结 UI
      const MAX_IMPORT_SIZE = 5 * 1024 * 1024; // 5 MB
      if (file.size > MAX_IMPORT_SIZE) {
        showToast('文件过大（5 MB 上限），请检查是否选择了正确的导入文件', 'error');
        if (input.parentNode) input.parentNode.removeChild(input);
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => {
        showToast('文件读取失败', 'error');
      };
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target.result);

          // Support both old format (just problem) and new format (with reports)
          let problem, reports;
          if (data.problem && data.version) {
            // New format: { version, problem, reports }
            problem = data.problem;
            reports = data.reports || [];
          } else if (data.id && data.createdAt) {
            // Old format: just the problem object
            problem = data;
            reports = [];
          } else {
            throw new Error('无效的文件格式');
          }

          // Validate basic structure
          if (!problem.id || !problem.createdAt) {
            throw new Error('无效的问题文件：缺少必要字段');
          }

          // Check if problem already exists
          let isCopy = false;
          const existing = getProblemById(problem.id);
          if (existing) {
            const importAsCopy = await showConfirm(
              '问题库中已存在相同ID的问题。\n是否作为“新副本”导入？（选择“取消”则可以选择覆盖已有问题或取消导入）',
              'info'
            );
            if (importAsCopy) {
              isCopy = true;
            } else {
              const overwrite = await showConfirm(
                '是否覆盖已有问题？\n（选择“确定”覆盖，选择“取消”将终止导入）',
                'danger'
              );
              if (!overwrite) {
                return; // Abort
              }
            }
          }

          if (isCopy) {
            // Regenerate problem ID and display ID to ensure primary key isolation
            const oldProblemId = problem.id;
            const newProblemId =
              'problem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            problem.id = newProblemId;
            problem.title = (problem.title || '未命名问题') + ' - 副本';

            // Generate new displayId
            const now = new Date();
            const dateStr =
              now.getFullYear().toString() +
              String(now.getMonth() + 1).padStart(2, '0') +
              String(now.getDate()).padStart(2, '0');
            const todayPrefix = 'P' + dateStr + '-';
            const problemsList = getProblemList();
            const todayCount = problemsList.filter(
              (p) => p.displayId && p.displayId.startsWith(todayPrefix)
            ).length;
            problem.displayId = todayPrefix + String(todayCount + 1).padStart(3, '0');

            if (problem.snapshot) {
              problem.snapshot.problemId = newProblemId;
              problem.snapshot.cachedTreeHash = '';
            }

            // Update associated reports to point to the new problem ID
            const reportIdMap = new Map();
            reports.forEach((report) => {
              const previousReportId = report.id;
              report.problemId = newProblemId;
              report.problemDisplayId = problem.displayId;
              report.id =
                'report_' +
                (typeof crypto !== 'undefined' && crypto.randomUUID
                  ? crypto.randomUUID()
                  : Date.now() + '_' + Math.random().toString(36).slice(2, 9));
              if (previousReportId) reportIdMap.set(previousReportId, report.id);
            });
            if (Array.isArray(problem.aiResults)) {
              problem.aiResults = problem.aiResults.map((result) => ({
                ...result,
                problemId: newProblemId,
                reportId: reportIdMap.get(result.reportId) || ''
              }));
            }
          }

          // Fix G: use upsertProblem() to go through the proper store API
          // (triggers quota detection, avoids bypassing saveProblemList directly)
          if (!(await upsertProblem(problem))) {
            throw new Error('写入问题库失败，请检查存储空间');
          }

          // Import associated reports via saveReportList for batch efficiency
          let importedReportCount = 0;
          if (reports.length > 0) {
            const existingReports = _getReportLibrary();
            const now = new Date().toISOString();
            reports.forEach((report) => {
              if (!report.id) return; // skip malformed entries
              const idx = existingReports.findIndex((r) => r.id === report.id);
              if (idx >= 0) {
                existingReports[idx] = { ...existingReports[idx], ...report, updatedAt: now };
              } else {
                existingReports.push({ ...report, updatedAt: now });
              }
              importedReportCount++;
            });
            // Batch write reports (saveReportList is the only API for bulk report writes)
            saveReportList(existingReports);
          }

          const msg =
            importedReportCount > 0
              ? `问题导入成功（含 ${importedReportCount} 份报告）`
              : '问题导入成功';
          showToast(msg, 'success');
          renderProblemList();
        } catch (err) {
          showToast('导入失败：' + err.message, 'error');
          console.error('Import error:', err);
        }
      };
      reader.readAsText(file);
      // 读取后清理临时 input，避免 DOM 污染
      if (input.parentNode) input.parentNode.removeChild(input);
    };
    input.oncancel = () => {
      if (input.parentNode) input.parentNode.removeChild(input);
    };
    input.click();
  });

  document.getElementById('btnDeleteProblem')?.addEventListener('click', async () => {
    // Use the problem ID from the detail view instead of global activeProblemId
    const detailView = document.getElementById('problemDetailView');
    const targetProblemId = detailView?.dataset.problemId || getActiveProblemId();
    if (!targetProblemId) return;

    const confirmed = await showConfirm('确定要删除这个问题吗？此操作不可撤销。', 'danger');
    if (confirmed) {
      if (await deleteProblem(targetProblemId)) {
        // 清除该问题的 IndexedDB 插件数据
        if (typeof pluginRemove === 'function') {
          await pluginRemove('qa-5why-data-' + targetProblemId);
          await pluginRemove('qa-fishbone-' + targetProblemId);
          await pluginRemove('qa-fta-' + targetProblemId);
        }
        // 若正是当前活跃问题，重置分析工具内存状态
        if (getActiveProblemId() === targetProblemId) {
          if (window.FiveWhys && typeof window.FiveWhys.clear === 'function') {
            window.FiveWhys.clear();
          } else if (typeof window.clearSavedAnalysis === 'function') {
            await window.clearSavedAnalysis();
          }
          if (window.Fishbone && typeof window.Fishbone.clear === 'function') {
            // P1-2: await clearFishbone — 已改 async，未 await 会导致清空写与后续操作竞态
            await window.Fishbone.clear();
          } else if (window.Fishbone) {
            window.Fishbone.fishboneData = null;
          }
          if (window.FTA && typeof window.FTA.clear === 'function') {
            await window.FTA.clear();
          }
        }
        setActiveProblemId(null);
        detailView.dataset.problemId = '';
        renderProblemList();
      }
    }
  });

  // Fix A: btnSaveProblem serves as an emergency manual fallback only.
  // Auto-save (autoSaveToProblemPool) handles all normal persistence.
  // If auto-save is working correctly, users should never need to click this.
  document.getElementById('btnSaveProblem')?.addEventListener('click', () => {
    // Use the problem ID from the detail view instead of global activeProblemId
    const detailView = document.getElementById('problemDetailView');
    const targetProblemId = detailView?.dataset.problemId || getActiveProblemId();
    if (!targetProblemId) return;

    const details = collectProblemFormData();

    const phenomenon = details.phenomenon || '';
    const _targetProblem = getProblemById(targetProblemId);
    const title = details.title !== undefined ? details.title : _targetProblem?.title || '';

    // Assemble problem context from form fields so it flows into downstream analysis
    if (window.ProblemManager && typeof window.ProblemManager.getProblemContext === 'function') {
      const assembledCtx = window.ProblemManager.getProblemContext();
      if (assembledCtx) {
        const _activePid = getActiveProblemId();
        if (!_activePid || _activePid === targetProblemId) {
          problemContext = assembledCtx;
        }
      }
    }

    // Sync phenomenon to global store before saving (auto-save does this via touch,
    // but manual save must too — otherwise a stale Store.problemStatement can persist)
    touch({ problemStatement: phenomenon }, 'problemPool');

    // Use the same save path as auto-save for consistency (with silent=false to show toast)
    if (!saveCurrentAnalysisToProblem(targetProblemId, title, false, {
      capturePlugins: { fishbone: false, fta: false }
    })) {
      // Fallback: direct update if saveCurrentAnalysisToProblem fails
      updateProblem(targetProblemId, { title, problemStatement: phenomenon, details });
      showToast('问题已保存', 'success');
    }
  });

  document.getElementById('btnClearProblem')?.addEventListener('click', async () => {
    const confirmed = await showConfirm(
      '确定清空问题表单吗？将清除问题字段，不影响已有分析和已保存报告。',
      'danger'
    );
    if (confirmed) {
      clearTimeout(_autoSaveProblemTimer);
      window.ProblemManager.clear();
      const detailView = document.getElementById('problemDetailView');
      const targetProblemId = detailView?.dataset.problemId || getActiveProblemId();
      const problem = targetProblemId ? getProblemById(targetProblemId) : null;
      if (problem) {
        const details = window.ProblemManager.getData();
        const snapshot = JSON.parse(JSON.stringify(problem.snapshot || { version: 2 }));
        snapshot.problemStatement = '';
        snapshot.problemContext = '';
        snapshot.details = details;
        const activeId = getActiveProblemId();
        if (!activeId || activeId === targetProblemId) {
          touchMany({ problemStatement: '', problemContext: '' }, 'clearProblemForm');
        }
        const saved = await updateProblem(targetProblemId, {
          title: '',
          problemStatement: '',
          problemContext: '',
          details,
          snapshot
        });
        if (saved === false) {
          showToast('表单已清空，但保存失败；刷新后可能恢复旧内容', 'warning');
          return;
        }
      }
      showToast('问题表单已清空（不影响已有分析和报告）', 'info');
    }
  });

  // Close/cancel picker
  document.getElementById('btnCloseProblemPicker')?.addEventListener('click', _closePicker);
  document.getElementById('btnCancelProblemPicker')?.addEventListener('click', _closePicker);
  document.getElementById('problemPickerModal')?.addEventListener('click', (e) => {
    if (e.target.tagName === 'DIALOG') _closePicker();
  });
  document.getElementById('problemPickerModal')?.addEventListener('cancel', () => _closePicker());

  // Re-render only when crossing the desktop/mobile layout boundary. This keeps
  // resize handling cheap while ensuring a rotated tablet never retains table markup.
  const problemLayoutMedia =
    typeof window.matchMedia === 'function' ? window.matchMedia(PROBLEM_MOBILE_QUERY) : null;
  const handleProblemLayoutChange = () => {
    const page = document.getElementById('page-problem');
    const list = document.getElementById('problemListContainer');
    if (page && list && !page.classList.contains('hidden') && !list.classList.contains('hidden')) {
      renderProblemList();
    }
  };
  if (problemLayoutMedia) {
    if (typeof problemLayoutMedia.addEventListener === 'function') {
      problemLayoutMedia.addEventListener('change', handleProblemLayoutChange);
    } else if (typeof problemLayoutMedia.addListener === 'function') {
      problemLayoutMedia.addListener(handleProblemLayoutChange);
    }
  }

  // ===== 暴露 =====
  window.renderProblemList = renderProblemList;
  window.showProblemDetail = showProblemDetail;
  window.openProblemPicker = openProblemPicker;
  window.autoSaveToProblemPool = autoSaveToProblemPool;

  if (typeof window.on === 'function') {
    window.on('reports:changed', () => {
      const detailView = document.getElementById('problemDetailView');
      const problemId = detailView?.dataset.problemId;
      const viewBtn = document.getElementById('btnViewReports');
      if (!problemId || !viewBtn) return;
      viewBtn.style.display = _getReportLibrary().some((report) => report.problemId === problemId)
        ? ''
        : 'none';
    });
  }
})();
