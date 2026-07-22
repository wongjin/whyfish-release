/**
 * report-library.js — 报告库：渲染 + 详情 + 事件
 *
 * 职责：报告库列表渲染、报告详情展示、导出/删除/清空操作
 * 依赖：store.js (getReportLibrary/getReportById/deleteReportFromLibrary),
 *        ui-utils.js (showToast/esc/mdToHtml)
 * 暴露：renderReportLibrary, showReportDetail
 */

// ===== Report Library Functions =====
let currentViewingReportId = null;
let _filterProblemId = null;
let _filterPending = false;
let _reportBackNav = null; // D3: { page, tool } to navigate back to calling tool context

function setReportFilter(problemId) {
  _filterProblemId = problemId;
  _filterPending = true;
}

function renderReportLibrary() {
  const container = document.getElementById('reportLibraryContainer');
  const detailView = document.getElementById('reportDetailView');
  if (!container || !detailView) return;
  container.classList.remove('hidden');
  detailView.classList.add('hidden');
  currentViewingReportId = null;
  if (!_filterPending) _filterProblemId = null;
  _filterPending = false;
  _reportBackNav = null;

  let reports = getReportLibrary();
  let filterLabel = '';

  // 按问题筛选
  if (_filterProblemId) {
    const filtered = reports.filter((r) => {
      return r.problemId === _filterProblemId;
    });
    if (filtered.length > 0) {
      reports = filtered;
      const p = typeof getProblemById === 'function' ? getProblemById(_filterProblemId) : null;
      filterLabel = p ? esc(p.displayId || p.title || '') : _filterProblemId;
    }
  }

  if (reports.length === 0) {
    let emptyHtml = '';
    if (_filterProblemId) {
      emptyHtml = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg class="empty-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 40px; height: 40px;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </div>
        <h3>该问题暂无报告</h3>
        <p>完成分析后生成报告即可在此查看</p>
        <button class="btn btn-outline btn-sm" data-action="clear-filter" style="margin-top:8px;">显示全部报告</button>
      </div>`;
    } else {
      emptyHtml = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg class="empty-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 40px; height: 40px;"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
        </div>
        <h3>报告库为空</h3>
        <p>暂无任何分析报告。在 5 Whys、鱼骨图或故障树分析完成后点击“生成报告”即可保存至此。</p>
      </div>`;
    }
    container.innerHTML = emptyHtml;
    _filterProblemId = null;
    return;
  }

  // Group reports by problemId
  const problemGroupMap = {};
  const ungrouped = [];

  reports.forEach((report) => {
    const pid = report.problemId;
    if (pid) {
      if (!problemGroupMap[pid]) {
        problemGroupMap[pid] = [];
      }
      problemGroupMap[pid].push(report);
    } else {
      ungrouped.push(report);
    }
  });

  const problemIds = Object.keys(problemGroupMap);
  const groups = problemIds.map((pid) => {
    const groupReports = problemGroupMap[pid];
    // Sort reports in group by createdAt descending
    groupReports.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const latestReport = groupReports[0];
    const problem = typeof getProblemById === 'function' ? getProblemById(pid) : null;

    const title = problem ? problem.title || '未命名问题' : latestReport.title || '未命名问题';
    const displayId = problem ? problem.displayId : latestReport.problemDisplayId;
    const problemStatement = problem
      ? problem.problemStatement || problem.problemContext || ''
      : latestReport.problemStatement || '';

    const date =
      problem && problem.createdAt
        ? new Date(problem.createdAt)
        : new Date(latestReport.createdAt || 0);
    const dateStr =
      date && !isNaN(date)
        ? date.toLocaleDateString('zh-CN') +
          ' ' +
          date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : '—';

    const status = problem ? problem.status : 'pending';
    const nodeCount = problem ? problem.nodeCount || 0 : latestReport.nodeCount || 0;
    const rootCauseCount = problem ? problem.rootCauseCount || 0 : latestReport.rootCauseCount || 0;

    return {
      problemId: pid,
      title: title,
      displayId: displayId,
      problemStatement: problemStatement,
      dateStr: dateStr,
      status: status,
      nodeCount: nodeCount,
      rootCauseCount: rootCauseCount,
      reports: groupReports,
      latestDate: new Date(latestReport.createdAt || 0)
    };
  });

  groups.sort((a, b) => b.latestDate - a.latestDate);

  let html = '';
  if (_filterProblemId) {
    html +=
      '<div style="padding:12px 0 8px;display:flex;align-items:center;gap:8px;font-size:0.82rem;">';
    html += '  <span style="color:var(--text-secondary);">筛选：</span>';
    html += '  <span class="id-badge" style="font-size:0.78rem;">' + filterLabel + '</span>';
    html +=
      '  <button class="btn btn-outline btn-sm" data-action="clear-filter" style="margin-left:auto;">显示全部报告</button>';
    html += '</div>';
    _filterProblemId = null;
  }
  html += '<div class="report-list">';

  const statusLabels = window.Labels.status || {
    pending: '待处理',
    analyzing: '分析中',
    completed: '已完成'
  };
  const toolNames = {
    '5why': '5 Whys',
    fishbone: '鱼骨图',
    fta: '故障树',
    assessment: '问题评估（AI评估）'
  };

  for (const group of groups) {
    const reportsHtml = group.reports
      .map((r) => {
        const label = `${esc(r.displayId || '报告')} (${toolNames[r.analysisType] || '分析'})`;
        return `<span class="problem-card-report-item report-link" data-report-id="${esc(r.id)}" title="查看报告：${esc(r.title)}">${label}</span>`;
      })
      .join('');

    html += `
      <div class="report-group-card problem-card" data-problem-id="${esc(group.problemId)}" tabindex="0" role="button">
        <div class="problem-card-top-meta">
          ${group.displayId ? `<span class="problem-card-id">${esc(group.displayId)}</span>` : ''}
          <span class="problem-card-date">${group.dateStr}</span>
        </div>
        <div class="problem-card-header">
          <div class="problem-card-title">${esc(group.title)}</div>
        </div>
        <div class="problem-card-preview">${esc(group.problemStatement || '暂无描述')}</div>
        <div class="problem-card-meta">
          <div class="problem-card-meta-left">
            <span class="problem-meta-badge status-${group.status}">${statusLabels[group.status] || statusLabels.pending}</span>
            <span class="problem-meta-badge nodes">
              <svg class="badge-icon-svg" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
              <span>${group.nodeCount} 个节点</span>
            </span>
            ${
              group.rootCauseCount > 0
                ? `
            <span class="problem-meta-badge root-cause">
              <svg class="badge-icon-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
              <span>${group.rootCauseCount} 个根因</span>
            </span>`
                : ''
            }
          </div>
        </div>
        <div class="problem-card-reports">
          <div class="problem-card-reports-label">
            <svg class="badge-icon-svg" viewBox="0 0 24 24" style="width:12px;height:12px;margin-right:2px;vertical-align:middle;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span>报告：</span>
          </div>
          <div class="problem-card-reports-list">
            ${reportsHtml}
          </div>
        </div>
      </div>
    `;
  }

  if (ungrouped.length > 0) {
    const reportsHtml = ungrouped
      .map((r) => {
        const label = `${esc(r.displayId || '报告')} (${toolNames[r.analysisType] || '分析'})`;
        return `<span class="problem-card-report-item report-link" data-report-id="${esc(r.id)}" title="查看报告：${esc(r.title)}">${label}</span>`;
      })
      .join('');

    html += `
      <div class="report-group-card problem-card" data-problem-id="" tabindex="0" role="button">
        <div class="problem-card-top-meta">
          <span class="problem-card-id">OTHER</span>
        </div>
        <div class="problem-card-header">
          <div class="problem-card-title">未关联问题的报告</div>
        </div>
        <div class="problem-card-preview">这些报告未关联任何具体问题。</div>
        <div class="problem-card-reports">
          <div class="problem-card-reports-label">
            <svg class="badge-icon-svg" viewBox="0 0 24 24" style="width:12px;height:12px;margin-right:2px;vertical-align:middle;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span>报告：</span>
          </div>
          <div class="problem-card-reports-list">
            ${reportsHtml}
          </div>
        </div>
      </div>
    `;
  }

  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('[data-action="clear-filter"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setReportFilter(null);
      renderReportLibrary();
    });
  });

  // 点击卡片本体跳转至问题管理详情
  container.querySelectorAll('.report-group-card').forEach((card) => {
    card.addEventListener('click', () => {
      navigateToProblemDetail(card);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigateToProblemDetail(card);
      }
    });
    function navigateToProblemDetail(card) {
      const pid = card.dataset.problemId;
      if (pid && typeof showProblemDetail === 'function') {
        window.navigateTo('page-problem');
        setTimeout(() => showProblemDetail(pid), 100);
      }
    }
  });

  // 点击具体报告链接查看报告详情
  container.querySelectorAll('.report-group-card .report-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const rid = link.dataset.reportId;
      if (rid) {
        showReportDetail(rid);
      }
    });
    link.style.cursor = 'pointer';
  });
}

function showReportDetail(reportId) {
  const report = getReportById(reportId);
  if (!report) {
    showToast('报告不存在', 'error');
    return;
  }

  currentViewingReportId = reportId;

  // D3: remember calling context for back navigation
  const activePanel = document.querySelector('.tool-panel:not(.hidden)');
  const activeTool = activePanel?.id || null;
  const currentPage = document.querySelector('.page-content:not(.hidden)');
  const currentPageId = currentPage?.id || '';
  if (currentPageId === 'page-report-library') {
    _reportBackNav = null;
  } else if (currentPageId === 'page-problem') {
    _reportBackNav = { page: currentPageId, tool: null };
  } else {
    _reportBackNav = { page: 'page-analysis', tool: activeTool };
  }

  const container = document.getElementById('reportLibraryContainer');
  const detailView = document.getElementById('reportDetailView');
  const detailContent = document.getElementById('reportDetailContent');

  container.classList.add('hidden');
  detailView.classList.remove('hidden');

  const _toolMap = { '5why': 'tool-5why', fishbone: 'tool-fishbone', fta: 'tool-fta' };
  const _toolName = window.Labels.tool;
  const _type = report.analysisType || '5why';
  const showContinueBtn = _type !== 'assessment';

  // A report detail must render its saved version, never mutable current problem data.
  const contentHtml = `<div class="markdown-content report-content">${mdToHtml(report.content)}</div>`;

  detailContent.innerHTML = `
    <div class="report-detail-nav">
      ${report.problemId ? `<button class="btn btn-outline btn-sm" data-action="view-problem" data-problem-id="${esc(report.problemId)}"><svg viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>查看问题 ${esc(report.problemDisplayId || '')}</button>` : ''}
      ${showContinueBtn ? `<button class="btn btn-outline btn-sm" data-action="continue-analysis" data-tool="${esc(_toolMap[_type] || 'tool-5why')}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M16.2 7.8l-2 5.6-5.6 2 2-5.6 5.6-2z"/></svg>继续${esc(_toolName[_type] || '分析')}</button>` : ''}
      ${report.version ? `<span class="report-version-badge" style="margin-left:auto;font-size:0.75rem;padding:4px 8px;border-radius:var(--radius-sm);background:var(--primary-light);color:var(--primary-dark);font-weight:600;display:inline-flex;align-items:center;gap:4px;"><svg viewBox="0 0 24 24"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>版本：${esc(report.version)}</span>` : ''}
    </div>
    ${contentHtml}
    ${_type === 'fishbone' ? '<div id="fishboneSvgInReport" style="margin-top:24px;padding:16px;background:var(--bg-secondary);border-radius:var(--radius);overflow-x:auto;"></div>' : ''}
    ${_type === 'fta' ? '<div id="ftaSvgInReport" style="margin-top:24px;padding:16px;background:var(--bg-secondary);border-radius:var(--radius);overflow-x:auto;"></div>' : ''}
  `;

  detailContent.querySelectorAll('[data-action="view-problem"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.problemId;
      window.navigateTo('page-problem');
      setTimeout(() => showProblemDetail(pid), 100);
    });
  });

  detailContent.querySelectorAll('[data-action="continue-analysis"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const _reportId = currentViewingReportId;
      const _tool = btn.dataset.tool; // 'tool-5why' | 'tool-fishbone' | 'tool-fta'
      if (_reportId) {
        const _r = getReportById(_reportId);
        if (_r && _r.problemId && typeof loadProblemToCurrent === 'function') {
          loadProblemToCurrent(_r.problemId);
          setActiveProblemId(_r.problemId);
          // 如果报告来自示例，从 EXAMPLES_DATA 恢复工具数据（覆盖快照的空状态）
          if (
            _r.exampleSource &&
            typeof window.ProblemManager?.restoreExampleToTools === 'function'
          ) {
            const restored = await window.ProblemManager.restoreExampleToTools(_r.exampleSource);
            if (!restored) return; // 用户取消覆盖，停止导航
          }
          // 回填输入框（问题陈述 / 上下文 / 标题）。
          // 工作区可见性由 store.js 的 toolpanel:show 监听器根据 tree 是否有子节点决定。
          if (typeof window.syncToolDom === 'function') {
            window.syncToolDom(_r.problemId, _tool);
          }
          if (typeof window.updateProblemSummaryUI === 'function') {
            window.updateProblemSummaryUI(_r.problemId);
          }
        }
      }
      window.navigateTo('page-analysis', _tool);
    });
  });

  // 如果是鱼骨图报告，渲染 SVG
  if (_type === 'fishbone') {
    const svgContainer = document.getElementById('fishboneSvgInReport');
    if (svgContainer) {
      if (report.fishboneSvgHtml) {
        // 优先使用保存在报告中的 SVG 快照（经 DOMPurify 清洗，防 XSS）
        svgContainer.innerHTML = safeSanitize(report.fishboneSvgHtml);
      } else if (window.FishboneSVG && window.Fishbone && window.Fishbone.fishboneData) {
        // 降级：使用当前实时数据（旧报告兼容）
        window.FishboneSVG.render(window.Fishbone.fishboneData, svgContainer);
      }
    }
  }

  // 如果是 FTA 报告，渲染 SVG
  if (_type === 'fta') {
    const ftaContainer = document.getElementById('ftaSvgInReport');
    if (ftaContainer && report.ftaSvgHtml) {
      ftaContainer.innerHTML = safeSanitize(report.ftaSvgHtml);
    }
  }
}

// ===== Report Library Events =====

document.getElementById('btnBackToReportList')?.addEventListener('click', () => {
  if (_reportBackNav && _reportBackNav.tool) {
    window.navigateTo(_reportBackNav.page, _reportBackNav.tool);
    _reportBackNav = null;
  } else {
    renderReportLibrary();
  }
});

document.getElementById('btnExportReportDetail')?.addEventListener('click', async () => {
  if (!currentViewingReportId) return;

  const report = getReportById(currentViewingReportId);
  if (!report) return;

  let exportContent = report.content;

  // 如果是鱼骨图报告，将页面中渲染的 SVG 一并导出，并在末尾添加两个空行避开光标和鼠标
  if (report.analysisType === 'fishbone') {
    const svgContainer = document.getElementById('fishboneSvgInReport');
    if (svgContainer && svgContainer.innerHTML.trim()) {
      exportContent += '\n\n---\n\n' + safeSanitize(svgContainer.innerHTML.trim()) + '\n\n';
    }
  }

  // 如果是 FTA 报告，将页面中渲染的 SVG 一并导出
  if (report.analysisType === 'fta') {
    const ftaContainer = document.getElementById('ftaSvgInReport');
    if (ftaContainer && ftaContainer.innerHTML.trim()) {
      exportContent += '\n\n---\n\n' + safeSanitize(ftaContainer.innerHTML.trim()) + '\n\n';
    }
  }

  const blob = new Blob([exportContent], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeTitle = window.UIUtils.sanitizeFilenameBase(report.title);
  a.download = `${safeTitle}-${new Date(report.createdAt).toISOString().slice(0, 10)}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('报告已成功下载', 'success');
});

document.getElementById('btnExportReportWord')?.addEventListener('click', async () => {
  if (!currentViewingReportId) return;

  const report = getReportById(currentViewingReportId);
  if (!report) return;

  const exportMarkdown = report.content;
  // Handle fishbone SVG — embed in Word as PNG or raw SVG
  let fishboneImageHtml = '';
  if (report.analysisType === 'fishbone') {
    const svgElement = document.querySelector('#fishboneSvgInReport svg');
    if (svgElement) {
      fishboneImageHtml = await window.UIUtils.embedSvgForDocument(svgElement, {
        title: '问题分析鱼骨图',
        alt: '鱼骨图',
        defaultHeight: 450,
        progressMessage: '正在将鱼骨图转换为图片...'
      });
    }
    if (!fishboneImageHtml) {
      showToast('无法嵌入鱼骨图到 Word 文档', 'warning');
    }
  }

  // Handle FTA SVG — embed in Word as PNG or raw SVG
  let ftaImageHtml = '';
  if (report.analysisType === 'fta') {
    const svgElement = document.querySelector('#ftaSvgInReport svg');
    if (svgElement) {
      ftaImageHtml = await window.UIUtils.embedSvgForDocument(svgElement, {
        title: '故障树图快照',
        alt: '故障树图',
        defaultHeight: 600,
        progressMessage: '正在将故障树图转换为图片...'
      });
    }
    if (!ftaImageHtml) {
      showToast('无法嵌入故障树图到 Word 文档', 'warning');
    }
  }

  const safeTitle = window.UIUtils.sanitizeFilenameBase(report.title);
  const dateStr = new Date(report.createdAt).toISOString().slice(0, 10);
  const filename = `${safeTitle}-${dateStr}.docx`;

  let htmlBody = window.UIUtils.mdToHtml(exportMarkdown);
  htmlBody += fishboneImageHtml;
  htmlBody += ftaImageHtml;
  window.UIUtils.downloadDocx(htmlBody, filename);
});

document.getElementById('btnDeleteReport')?.addEventListener('click', async () => {
  if (!currentViewingReportId) return;

  const report = getReportById(currentViewingReportId);
  let checkboxLabel = '';
  if (report) {
    const typeLabels = {
      assessment: '同时清除问题中的 AI 评估数据（保留报告库其他报告）',
      '5why': '同时清除 5 Whys 分析树数据（保留报告库其他报告）',
      fishbone: '同时清除鱼骨图分析数据（保留报告库其他报告）',
      fta: '同时清除故障树分析数据（保留报告库其他报告）'
    };
    checkboxLabel = typeLabels[report.analysisType] || '';
  }

  const { confirmed, checked } = typeof showConfirmWithOption === 'function'
    ? await showConfirmWithOption('确定要删除这份报告吗？此操作不可撤销。', 'danger', checkboxLabel)
    : { confirmed: await showConfirm('确定要删除这份报告吗？此操作不可撤销。', 'danger'), checked: false };

  if (confirmed) {
    if (await deleteReportFromLibrary(currentViewingReportId, { clearRelatedAnalysis: checked })) {
      renderReportLibrary();
    }
  }
});

// ===== 暴露 =====
window.renderReportLibrary = renderReportLibrary;
window.showReportDetail = showReportDetail;
window.setReportFilter = setReportFilter;

// ===== 报告操作（从 report-actions.js 合并） =====

document.getElementById('btnFinish')?.addEventListener('click', async () => {
  const filled = (function collectFilled(n, list = []) {
    if (!n) return list;
    if (n.text) list.push(n);
    if (n.children) for (const child of n.children) collectFilled(child, list);
    return list;
  })(tree);
  if (filled.length === 0) {
    showToast('请至少填写一个原因', 'error');
    return;
  }
  const btn = document.getElementById('btnFinish');
  btn.disabled = true;
  btn.textContent = '生成中...';

  const problemId = getActiveProblemId();
  const reports = typeof getReportLibrary === 'function' ? getReportLibrary() : [];
  const existingReport = problemId
    ? reports.find((r) => r.problemId === problemId && r.analysisType === '5why')
    : null;

  if (existingReport || cachedReport) {
    if (
      !(await showConfirm(
        '该问题已生成过分析报告，是否重新生成？点击【取消】将直接查看已有报告，点击【确定】将重新生成报告并覆盖。'
      ))
    ) {
      if (existingReport) {
        if (!cachedReport || cachedReport !== existingReport.content) {
          setReportMarkdown(existingReport.content);
          if (typeof setCachedReport === 'function') setCachedReport(existingReport.content);
        }
        if (typeof showReportDetail === 'function') {
          window.navigateTo('page-report-library');
          setTimeout(() => {
            showReportDetail(existingReport.id);
          }, 50);
        }
      } else {
        showToast('请先生成报告', 'info');
      }
      btn.disabled = false;
      btn.textContent = '生成报告';
      return;
    }
  }

  // 打开侧边栏，显示语义化进度提示
  if (window.SidebarUI) {
    window.SidebarUI.open('生成分析报告');
    window.SidebarUI.showLoading('正在分析...', [
      '正在分析...',
      '正在生成报告内容...',
      '正在格式化报告...'
    ]);
  }
  const _rpt0 = Date.now();

  const isRegen = !!existingReport;
  // Fix H4: capture snapshot at generation time, not at save time
  const _snapshotPid = problemId;
  const _snapshotStmt = problemStatement;
  const _snapshotHash = cachedTreeHash;
  let _nodeCount = 0;
  let _rootCauseCount = 0;
  if (tree) {
    (function walk(n) {
      if (!n) return;
      _nodeCount++;
      if (n.isRootCause) _rootCauseCount++;
      if (n.children) for (const child of n.children) walk(child);
    })(tree);
  }

  try {
    setReportMarkdown(await generateReport(true));
    if (window.SidebarUI) {
      window.SidebarUI.hideLoading();
      if (typeof _showAiCompletion === 'function')
        _showAiCompletion(Date.now() - _rpt0, window._lastAiUsage);
    }
    const saved = await saveReportToLibrary(reportMarkdown, {
      isRegenerate: isRegen,
      sourceMode: 'ai',
      problemId: _snapshotPid,
      problemStatement: _snapshotStmt,
      treeHash: _snapshotHash,
      nodeCount: _nodeCount,
      rootCauseCount: _rootCauseCount
    });
    if (typeof markAnalysisCompleted === 'function') markAnalysisCompleted('5why', _snapshotPid);
    if (saved && typeof showReportDetail === 'function') {
      window.scheduleRedirect({
        seconds: 6,
        onNavigate: function () {
          showReportDetail(saved.id);
          if (window.SidebarUI) window.SidebarUI.close();
        }
      });
    }
  } catch (err) {
    if (window.SidebarUI) {
      window.SidebarUI.hideLoading();
      window.SidebarUI.setContent(
        '<div class="ai-block is-error"><h4>AI 报告生成失败，使用本地报告</h4><p>' +
          esc(err.message) +
          '</p><p style="font-size:0.7rem;color:var(--text-muted);">已自动切换到本地结构化报告，报告内容完整但无 AI 摘要分析。</p></div>'
      );
    }
    try {
      setReportMarkdown(generateLocalReport());
      const savedFallback = await saveReportToLibrary(reportMarkdown, {
        isRegenerate: isRegen,
        sourceMode: 'local',
        problemId: _snapshotPid,
        problemStatement: _snapshotStmt,
        treeHash: _snapshotHash,
        nodeCount: _nodeCount,
        rootCauseCount: _rootCauseCount
      });
      // P1-5: fallback 也传 _snapshotPid，与主路径一致；否则用户切换问题后标记到错误问题
      if (typeof markAnalysisCompleted === 'function') markAnalysisCompleted('5why', _snapshotPid);
      if (savedFallback && typeof showReportDetail === 'function') {
        window.scheduleRedirect({
          seconds: 6,
          onNavigate: function () {
            showReportDetail(savedFallback.id);
            if (window.SidebarUI) window.SidebarUI.close();
          }
        });
      }
    } catch (localErr) {
      showToast('报告生成失败: ' + localErr.message, 'error');
    }
  }
  btn.disabled = false;
  btn.textContent = '生成报告';
});
