/**
 * fta.js — 故障树分析 (FTA) 核心模块
 *
 * 职责：FTA 数据模型、树管理、ASCII/图形渲染、持久化
 * 依赖：ui-utils.js (esc, showToast)
 *       prompts.js (renderPrompt) — Phase 2
 *       ai.js (callAI) — Phase 2
 * 被依赖：app.js
 */
(function () {
  'use strict';

  const FTA_STORAGE_KEY_BASE = 'qa-fta';
  let _ftaNextId = 1;
  const _actionLocks = {};

  /** Fix H2: scope plugin storage key to the active problem */
  function _ftaStorageKey(pid) {
    const activePid = pid || (typeof getActiveProblemId === 'function' ? getActiveProblemId() : '');
    return activePid ? FTA_STORAGE_KEY_BASE + '-' + activePid : FTA_STORAGE_KEY_BASE;
  }

  // ===== Layout Config =====
  const FTA_LAYOUT_CONFIG = {
    colGap: 260,     // 列间距（仅用于 maxCol 估算，布局本身已改为像素驱动）
    rowGap: 210,     // 行间距
    leftOffset: 120, // 左侧边距
    topOffset: 90,   // 顶部边距
    gateOffset: 95,  // 门符号的Y坐标偏移
    edgeOffset: 12,  // 边连线微调距离
    nodeHPad: 24     // 节点水平方向单侧内边距（用于子树宽度计算）
  };

  // ===== 数据模型 =====
  let ftaData = createEmptyFtaData();

  function createEmptyFtaData() {
    return {
      topEvent: { id: null, name: '', boundary: '', assumptions: '', locked: false },
      nodes: {}, // { [id]: ftaNode }
      rootId: null, // 顶事件节点 ID
      settings: { maxDepth: 5, maxNodes: 50 },
      viewMode: 'html', // 'html' | 'graphic'；每次进入工作台默认回到文本视图
      metadata: {
        createdAt: null,
        updatedAt: null,
        nodeCount: 0,
        confirmedCount: 0,
        aiCallCount: 0,
        mode: 'guided', // 'guided' | 'auto'
        problemTitle: '',
        problemContext: ''
      }
    };
  }

  function createFtaNode(opts) {
    const id = opts.id || 'FTA-' + _ftaNextId++;
    return {
      id: id,
      name: opts.name || '',
      description: opts.description || '',
      type: opts.type || 'intermediate', // top | intermediate | basic | undeveloped
      gateType: opts.gateType || null, // AND | OR | null
      gateReason: opts.gateReason || '',
      confidence: opts.confidence != null ? opts.confidence : 1.0,
      status: opts.status || 'manual', // manual | ai-suggested | confirmed | auto-generated
      parentId: opts.parentId || null,
      children: opts.children || []
    };
  }

  function _migrateNode(node) {
    // Use 'in' check so users can intentionally clear description without it being refilled.
    if (!('description' in node)) {
      node.description = node.name || '';
    }
    return node;
  }

  function _migrateNodes(nodes) {
    Object.values(nodes).forEach(_migrateNode);
  }

  // ===== 树操作 =====

  function getNode(id) {
    return ftaData.nodes[id] || null;
  }

  function addNode(parentId, opts) {
    const node = createFtaNode({ ...opts, parentId: parentId });
    ftaData.nodes[node.id] = node;
    if (parentId && ftaData.nodes[parentId]) {
      ftaData.nodes[parentId].children.push(node.id);
    }
    _updateMetadata();
    return node;
  }

  function removeNode(nodeId) {
    const _removeVisited = new Set();
    function _removeRecursive(nid) {
      if (_removeVisited.has(nid)) return;
      _removeVisited.add(nid);
      const node = ftaData.nodes[nid];
      if (!node) return;
      (node.children || []).slice().forEach((cid) => _removeRecursive(cid));
      if (node.parentId && ftaData.nodes[node.parentId]) {
        const parent = ftaData.nodes[node.parentId];
        parent.children = parent.children.filter((c) => c !== nid);
      }
      delete ftaData.nodes[nid];
      if (ftaData.rootId === nid) ftaData.rootId = null;
    }
    _removeRecursive(nodeId);
    _updateMetadata();
  }

  function updateNode(nodeId, updates) {
    const node = ftaData.nodes[nodeId];
    if (!node) return;
    Object.assign(node, updates);
    _updateMetadata();
  }

  function _updateMetadata() {
    const ids = Object.keys(ftaData.nodes);
    ftaData.metadata.nodeCount = ids.length;
    ftaData.metadata.confirmedCount = ids.filter(
      (id) => ftaData.nodes[id].status === 'confirmed'
    ).length;
    ftaData.metadata.updatedAt = new Date().toISOString();
  }

  function _getNodeDepth(nodeId) {
    let depth = 0,
      cur = nodeId;
    const visited = new Set();
    while (cur && ftaData.nodes[cur] && ftaData.nodes[cur].parentId) {
      if (visited.has(cur)) {
        console.warn('Cycle detected in _getNodeDepth for node:', cur);
        break;
      }
      visited.add(cur);
      cur = ftaData.nodes[cur].parentId;
      depth++;
    }
    return depth;
  }

  function _detectCycle(nodeId, nodes) {
    // 三色标记法（white/gray/black）检测循环引用
    // white(0)=未访问, gray(1)=当前路径中, black(2)=已完成
    // P1-14: nodes 参数用于 importData 校验阶段（此时 ftaData 尚未赋值）
    const nodeMap = nodes || ftaData.nodes;
    const color = {};
    function dfs(nid) {
      const node = nodeMap[nid];
      if (!node) return false;
      if (color[nid] === 2) return false; // 已完成，跳过
      if (color[nid] === 1) return true; // 灰色节点再次遇到 → 环
      color[nid] = 1; // 标记为灰色（进入）
      for (const cid of node.children || []) {
        if (dfs(cid)) return true;
      }
      color[nid] = 2; // 标记为黑色（完成）
      return false;
    }
    return dfs(nodeId);
  }

  function isFn(name) {
    return typeof window[name] === 'function';
  }

  // ===== 持久化 =====

  let _ftaSaveTimer = null;
  async function _persistFtaData(capturedPid, capturedState) {
    try {
      // P0: 使用调用时捕获的 PID，而非运行时读取
      const activeId = capturedPid || (typeof getActiveProblemId === 'function' ? getActiveProblemId() : null);
      const dataToSave = capturedState?.data || JSON.parse(JSON.stringify(ftaData));
      const nextIdToSave = capturedState?.nextId || _ftaNextId;
      if (activeId && typeof getProblemById === 'function') {
        const problem = getProblemById(activeId);
        if (problem && problem._fromExample) {
          // 如果是示例，不自动保存或回写快照
          return;
        }
      }
      if (typeof window.pluginSave === 'function') {
        const ok = await window.pluginSave(_ftaStorageKey(activeId), {
          data: JSON.parse(JSON.stringify(dataToSave)),
          nextId: nextIdToSave
        });
        if (ok === false) {
          throw new Error('插件数据写入失败');
        }
      }
      // 同步 FTA 数据到问题库的 snapshot
      if (activeId && typeof getProblemById === 'function' && typeof updateProblem === 'function') {
        const problem = getProblemById(activeId);
        if (problem) {
          const snapshot = problem.snapshot || { version: 2 };
          snapshot.ftaData = JSON.parse(JSON.stringify(dataToSave));
          const analyses = problem.analyses || {};
          // 只在尚未 completed 时才更新状态
          if (!analyses.fta || analyses.fta.status !== 'completed') {
            analyses.fta = {
              status: Object.keys(dataToSave.nodes || {}).length > 1 ? 'in_progress' : 'not_started',
              lastUpdated: new Date().toISOString()
            };
          } else {
            analyses.fta.lastUpdated = new Date().toISOString();
          }
          // Fix 3: write FTA title/context back to problem object
          const ftaTitle = dataToSave.metadata.problemTitle || '';
          const ftaCtx = dataToSave.metadata.problemContext || '';
          const ftaUpdates = { snapshot: snapshot, analyses: analyses };
          if (ftaTitle) ftaUpdates.title = ftaTitle;
          if (ftaCtx) ftaUpdates.problemStatement = ftaCtx;
          const updateOk = await updateProblem(activeId, ftaUpdates);
          if (updateOk === false) {
            throw new Error('问题库数据同步失败');
          }
          if (typeof renderProblemList === 'function') renderProblemList();
          if (typeof renderAnalysisHub === 'function') renderAnalysisHub();
        }
      }
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.message.includes('QuotaExceededError')) {
        showToast('存储空间已满', 'error');
      } else {
        showToast('保存失败: ' + e.message, 'error');
      }
      console.warn('FTA save failed:', e);
      return; // Return early on error, do not show success status
    }
    if (typeof window.setSaveStatus === 'function') {
      window.setSaveStatus('FTA 已保存');
    }
  }

  /** Fix M6: save with optional force (bypass debounce for critical ops) */
  async function saveFtaData(force) {
    // P0: 捕获当前 PID，传给 _persistFtaData（防止 debounce 窗口内切问题导致串号）
    const _capturedPid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
    const _capturedState = {
      data: JSON.parse(JSON.stringify(ftaData)),
      nextId: _ftaNextId
    };
    if (force) {
      if (_ftaSaveTimer) clearTimeout(_ftaSaveTimer);
      await _persistFtaData(_capturedPid, _capturedState);
      return;
    }
    if (_ftaSaveTimer) clearTimeout(_ftaSaveTimer);
    _ftaSaveTimer = setTimeout(() => _persistFtaData(_capturedPid, _capturedState), 300);
  }

  async function loadFtaData() {
    try {
      let parsed = null;
      const scopedKey = _ftaStorageKey();

      // 1. 从 IndexedDB 读取（优先使用 problem-scoped key）
      if (typeof window.pluginLoad === 'function') {
        parsed = await window.pluginLoad(scopedKey);
      }

      // 2. 降级：未找到 scoped 数据时，尝试从 base key 读取并迁移
      // P0-4: 仅迁移存储，不加载到内存变量（防止旧无 scope 数据污染当前问题）
      if (!parsed && scopedKey !== FTA_STORAGE_KEY_BASE) {
        if (typeof window.pluginLoad === 'function') {
          const baseData = await window.pluginLoad(FTA_STORAGE_KEY_BASE);
          if (baseData) {
            if (typeof window.pluginRemove === 'function') {
              await window.pluginRemove(FTA_STORAGE_KEY_BASE);
            }
            if (typeof window.pluginSave === 'function') {
              await window.pluginSave(scopedKey, baseData);
            }
          }
        }
      }

      // 3. 兜底：从 localStorage 迁移（仅 base key）
      if (!parsed) {
        const raw = localStorage.getItem(FTA_STORAGE_KEY_BASE);
        if (raw) {
          try {
            parsed = JSON.parse(raw);
            localStorage.removeItem(FTA_STORAGE_KEY_BASE);
            if (typeof window.pluginSave === 'function') {
              await window.pluginSave(scopedKey, {
                data: parsed.data,
                nextId: parsed.nextId || 1
              });
            }
          } catch (e) {
            console.warn('Failed to migrate FTA data from localStorage:', e);
          }
        }
      }
      if (parsed) {
        const loadedData = parsed.data || createEmptyFtaData();
        _migrateNodes(loadedData.nodes || {});
        // 如果加载的数据是空的（例如 clear() 写入的空数据），且当前内存已有内容（如 syncToolDom 已写入），则不覆盖
        const loadedEmpty = !loadedData.rootId && !loadedData.metadata?.problemTitle && !loadedData.metadata?.problemContext;
        const memoryHasContent = ftaData && (ftaData.rootId || ftaData.metadata?.problemTitle || ftaData.metadata?.problemContext);
        if (loadedEmpty && memoryHasContent) {
          renderAll();
          return true; // 保留内存数据不覆盖
        }
        // 视图模式属于临时 UI 状态，不继承历史保存值；每次进入默认显示文本树。
        loadedData.viewMode = 'html';
        ftaData = loadedData;
        _ftaNextId = parsed.nextId || 1;
        renderAll();
        return true;
      }
    } catch (e) {
      console.warn('FTA load failed:', e);
    }
    renderAll();
    return false;
  }

  async function clearFtaData() {
    // P0-5: 捕获当前 PID 用于后续清除和快照更新
    const _clearPid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
    ftaData = createEmptyFtaData();
    _ftaNextId = 1;

    // 1. 删除 IndexedDB 中的 key（对齐 5 Whys clearSavedAnalysis 做法）
    const _ftaKey = _ftaStorageKey(_clearPid);
    if (isFn('pluginRemove')) {
      try {
        const ok = await window.pluginRemove(_ftaKey);
        if (ok === false) {
          console.warn('FTA clear remove failed: pluginRemove returned false');
          if (typeof showToast === 'function') showToast('清空数据失败，请重试', 'error');
        }
      } catch (e) {
        console.warn('FTA clear remove failed:', e);
        if (typeof showToast === 'function') showToast('清空数据失败：' + e.message, 'error');
      }
    }

    // 2. 同步更新快照 & 3. 通知系统会话改变
    if (isFn('updatePluginSnapshot')) {
      window.updatePluginSnapshot('fta', 'ftaData', ftaData, _clearPid);
    }

    renderAll();
  }

  async function importData(data) {
    // P0-3: 捕获当前 PID 用于写入（防止 async 调用链中 PID 变化）
    const _importCapturedPid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
    if (!data || typeof data !== 'object') {
      console.warn('FTA importData: invalid data');
      if (typeof showToast === 'function') showToast('导入数据格式错误', 'error');
      return false;
    }
    if (!data.nodes || typeof data.nodes !== 'object') {
      console.warn('FTA importData: missing or invalid nodes');
      if (typeof showToast === 'function') showToast('导入数据缺少节点列表', 'error');
      return false;
    }
    if (!data.rootId || !data.nodes[data.rootId]) {
      console.warn('FTA importData: missing or invalid rootId');
      if (typeof showToast === 'function') showToast('导入数据根节点不存在', 'error');
      return false;
    }

    // 验证所有节点及其关联关系
    const nodeIds = Object.keys(data.nodes);
    const validTypes = ['top', 'intermediate', 'basic', 'undeveloped'];

    for (const id of nodeIds) {
      const node = data.nodes[id];
      if (!node || typeof node !== 'object') {
        console.warn(`FTA importData: node ${id} is invalid`);
        if (typeof showToast === 'function') showToast(`节点 ${id} 格式不正确`, 'error');
        return false;
      }
      if (!node.id || node.id !== id) {
        console.warn(`FTA importData: node ${id} has ID mismatch`);
        if (typeof showToast === 'function') showToast(`节点 ${id} 标识不匹配`, 'error');
        return false;
      }
      if (!validTypes.includes(node.type)) {
        console.warn(`FTA importData: node ${id} has invalid type ${node.type}`);
        if (typeof showToast === 'function') showToast(`节点 ${id} 类型错误`, 'error');
        return false;
      }

      // 验证 parentId 指向的节点是否存在
      if (node.parentId && !data.nodes[node.parentId]) {
        console.warn(`FTA importData: node ${id} has dangling parentId ${node.parentId}`);
        if (typeof showToast === 'function') showToast(`节点 ${id} 的父节点引用失效`, 'error');
        return false;
      }

      // 验证 children 中的所有 ID 是否存在，且其 parentId 指向自身
      if (Array.isArray(node.children)) {
        for (const childId of node.children) {
          const childNode = data.nodes[childId];
          if (!childNode) {
            console.warn(`FTA importData: node ${id} has dangling childId ${childId}`);
            if (typeof showToast === 'function') showToast(`节点 ${id} 的子节点引用失效`, 'error');
            return false;
          }
          if (childNode.parentId !== id) {
            console.warn(
              `FTA importData: child ${childId} parentId mismatch (expected ${id}, got ${childNode.parentId})`
            );
            if (typeof showToast === 'function') showToast(`节点层级关系不一致`, 'error');
            return false;
          }
        }
      }
    }

    // P1-14: 环检测 — 含环的导入会通过后续校验，但 computeMinCutSets 的 _expandNode
    // 无 visited set 会无限递归。runAnalysis/generateReport 经 validateTree 守门，
    // 但 problem-manager._generateExampleReport 直接调 computeMinCutSets 绕过。
    if (data.rootId && _detectCycle(data.rootId, data.nodes)) {
      console.warn('FTA importData: cycle detected');
      if (typeof showToast === 'function')
        showToast('导入数据包含循环引用，故障树必须是无环图', 'error');
      return false;
    }

    _migrateNodes(data.nodes);

    // 导入的数据可能来自旧版本并保存了 graphic，统一从可编辑文本视图开始。
    data.viewMode = 'html';
    data.metadata =
      data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
        ? data.metadata
        : {};
    ftaData = data;
    _updateMetadata();
    const ftaIds = Object.keys(data.nodes);
    _ftaNextId =
      ftaIds.reduce((max, id) => {
        const num = parseInt(id.replace('FTA-', ''), 10);
        return !isNaN(num) && num > max ? num : max;
      }, 0) + 1;
    try {
      if (typeof window.pluginSave === 'function') {
        await window.pluginSave(_ftaStorageKey(_importCapturedPid), {
          data: JSON.parse(JSON.stringify(ftaData)),
          nextId: _ftaNextId
        });
      }
      renderAll();
      return true;
    } catch (e) {
      console.warn('FTA importData save failed:', e);
      return false;
    }
  }

  // ===== ASCII 渲染 =====

  function renderAsciiTree() {
    if (!ftaData.rootId) return '（未定义顶事件）';
    return _asciiNode(ftaData.rootId, '', true, false, new Set());
  }

  /** 带节点 ID 的 ASCII 树，供 AI 提示词引用节点 */
  function renderAsciiTreeWithIds() {
    if (!ftaData.rootId) return '';
    let treeText = '当前故障树（节点ID在括号中）：\n\n';
    treeText += _asciiNode(ftaData.rootId, '', true, true, new Set());
    return treeText;
  }

  function _asciiNode(nodeId, prefix, isLast, showId, visited) {
    const node = ftaData.nodes[nodeId];
    if (!node) return '';
    const connector = prefix === '' ? '' : isLast ? '└──' : '├──';
    if (visited.has(nodeId)) {
      return prefix + connector + '[!] 循环引用 ' + (showId ? `(${node.id})` : '');
    }
    visited.add(nodeId);

    const typeTag =
      { top: '[T]', intermediate: '[I]', basic: '[B]', undeveloped: '[?]' }[node.type] || '[?]';
    const statusTag =
      {
        'ai-suggested': ' ← [AI建议]',
        confirmed: ' ← [已确认]',
        'auto-generated': ' ← [AI生成]',
        manual: ''
      }[node.status] || '';
    const idTag = showId ? ` (${node.id})` : '';

    const lines = [];
    lines.push(prefix + connector + typeTag + ' ' + (node.name || '未命名') + idTag + statusTag);

    if (node.gateType && node.children.length > 0) {
      const childPrefix = prefix + (prefix === '' ? '  ' : isLast ? '    ' : '│   ');
      lines.push(childPrefix + '[' + node.gateType + ']');
      node.children.forEach((cid, i) => {
        const last = i === node.children.length - 1;
        lines.push(_asciiNode(cid, childPrefix, last, showId, visited));
      });
    }
    return lines.join('\n');
  }

  /** 生成可点击的 ASCII 树 HTML */
  function renderAsciiTreeHtml() {
    if (!ftaData.rootId)
      return '<p class="form-hint" style="text-align:center;padding:12px;margin:0;">（未定义顶事件）</p>';
    return _asciiNodeHtml(ftaData.rootId, '', true, new Set());
  }

  function _asciiNodeHtml(nodeId, prefix, isLast, visited) {
    const node = ftaData.nodes[nodeId];
    if (!node) return '';
    const connector = prefix === '' ? '' : isLast ? '└──' : '├──';
    const branch = prefix + connector;
    const branchHtml = branch
      ? '<span class="fta-ascii-prefix" aria-hidden="true">' + esc(branch) + '</span>'
      : '';
    if (visited.has(nodeId)) {
      return branchHtml + '<span class="fta-gate-type">[!] 循环引用</span>';
    }
    visited.add(nodeId);

    const typeTag =
      { top: '[T]', intermediate: '[I]', basic: '[B]', undeveloped: '[?]' }[node.type] || '[?]';
    const statusTag =
      {
        'ai-suggested': ' ← [AI建议]',
        confirmed: ' ← [已确认]',
        'auto-generated': ' ← [AI生成]',
        manual: ''
      }[node.status] || '';
    const isSelected = _selectedNodeId === nodeId;

    const lines = [];
    const lineContent = typeTag + ' ' + esc(node.name || '未命名') + statusTag;
    lines.push(
      branchHtml +
        '<span class="fta-ascii-node' +
        (isSelected ? ' selected' : '') +
        '" data-id="' +
        esc(nodeId) +
        '" tabindex="0" role="button">' +
        lineContent +
        '</span>'
    );

    if (node.gateType && node.children.length > 0) {
      const childPrefix = prefix + (prefix === '' ? '  ' : isLast ? '    ' : '│   ');
      lines.push(
        '<span class="fta-ascii-prefix" aria-hidden="true">' +
          esc(childPrefix) +
          '</span><span class="fta-gate-type">[' +
          node.gateType +
          ']</span>'
      );
      node.children.forEach((cid, i) => {
        const last = i === node.children.length - 1;
        lines.push(_asciiNodeHtml(cid, childPrefix, last, visited));
      });
    }
    return lines.join('\n');
  }

  // ===== HTML 文本树渲染 =====

  function renderHtmlTree() {
    if (!ftaData.rootId) {
      return '<p class="fta-html-empty">（未定义顶事件）</p>';
    }
    return `<ul class="fta-html-tree-list fta-html-tree-root" role="tree" aria-label="故障树文本视图">${_htmlTreeNode(ftaData.rootId, 1, new Set())}</ul>`;
  }

  function _htmlTreeNode(nodeId, level, visited) {
    const node = ftaData.nodes[nodeId];
    if (!node || visited.has(nodeId)) return '';
    visited.add(nodeId);

    const typeLabel =
      { top: '顶层', intermediate: '中间', basic: '基本', undeveloped: '待展开' }[node.type] ||
      '待展开';
    const statusLabel =
      {
        'ai-suggested': 'AI 建议',
        confirmed: '已确认',
        'auto-generated': 'AI 生成'
      }[node.status] || '';
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const isSelected = _selectedNodeId === nodeId;
    const gateBadge =
      hasChildren && node.gateType
        ? `<span class="fta-html-gate fta-html-gate-${String(node.gateType).toLowerCase()}" title="${esc(node.gateReason || `${node.gateType} 逻辑门`)}">${esc(node.gateType)}</span>`
        : '';
    const statusBadge = statusLabel
      ? `<span class="fta-html-status fta-html-status-${esc(node.status)}">${statusLabel}</span>`
      : '';
    const childrenHtml = hasChildren
      ? `<ul class="fta-html-tree-list fta-html-tree-children" role="group">${node.children
          .map((childId) => _htmlTreeNode(childId, level + 1, visited))
          .join('')}</ul>`
      : '';
    const hasDescription = node.description && node.description !== node.name;
    return `
      <li class="fta-html-tree-item${node.type === 'top' ? ' is-root' : ''}" role="none" style="--fta-depth:${level}">
        <button type="button" class="fta-html-node fta-html-type-${esc(node.type)}${isSelected ? ' selected' : ''}" data-id="${esc(nodeId)}" role="treeitem" aria-level="${level}" aria-selected="${isSelected ? 'true' : 'false'}"${hasChildren ? ' aria-expanded="true"' : ''}>
          <span class="fta-html-node-main">
            <span class="fta-html-type-badge" title="事件类型：${typeLabel}">${typeLabel}</span>
            <span class="fta-mobile-level-badge">L${level}</span>
            <span class="fta-html-node-name">${esc(node.name || '未命名')}</span>
          </span>
          <span class="fta-html-node-meta">${gateBadge}${statusBadge}${isSelected ? _renderNodeQuickActions(node) : ''}</span>
        </button>
        ${hasDescription ? `<div class="fta-html-node-desc" data-id="${esc(nodeId)}"><span class="fta-desc-toggle" data-id="${esc(nodeId)}">${esc(node.description)}</span></div>` : ''}
        ${childrenHtml}
      </li>`;
  }

  function _renderNodeQuickActions(node) {
    if (!node) return '';
    const depth = _getNodeDepth(node.id);
    const canAddChild =
      depth < ftaData.settings.maxDepth &&
      Object.keys(ftaData.nodes).length < ftaData.settings.maxNodes;
    const canConfirm = node.status === 'ai-suggested' || node.status === 'auto-generated';

    return `
      <span class="fta-inline-actions" data-node-id="${esc(node.id)}">
        ${canConfirm ? `<button type="button" class="fta-inline-btn" data-fta-node-action="confirm" data-node-id="${esc(node.id)}" title="确认">✓</button>` : ''}
        <button type="button" class="fta-inline-btn" data-fta-node-action="edit" data-node-id="${esc(node.id)}" title="编辑">✎</button>
        ${canAddChild ? `<button type="button" class="fta-inline-btn" data-fta-node-action="add" data-node-id="${esc(node.id)}" title="添加子事件">+</button>` : ''}
      </span>`;
  }

  // ===== 图形视图（基础 SVG）=====

  function getNodeDims(type) {
    if (type === 'basic') {
      return { w: 84, h: 84, r: 42, isCircle: true, isDiamond: false };
    }
    if (type === 'top') {
      return { w: 200, h: 80, r: 6, isCircle: false, isDiamond: false };
    }
    if (type === 'undeveloped') {
      return { w: 120, h: 72, r: 6, isCircle: false, isDiamond: true };
    }
    return { w: 180, h: 72, r: 6, isCircle: false, isDiamond: false };
  }

  function renderSvgText(text, x, y, maxWidth, fontSize, fontWeight, maxLines) {
    let lines = [];
    const targetText = text || '未命名';
    let currentLine = '';
    let currentWidth = 0;
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uff00-\uffef]/.test(targetText);
    if (hasCJK) {
      for (const char of targetText) {
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
      const words = targetText.split(/\s+/);
      const spaceW = window.UIUtils.measureTextWidth(' ', fontSize);
      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (word === '') continue;
        const wordW = window.UIUtils.measureTextWidth(word, fontSize);
        if (wordW > maxWidth) {
          let wordPart = '';
          let wordPartW = 0;
          for (let j = 0; j < word.length; j++) {
            const char = word.charAt(j);
            const charW = window.UIUtils.measureTextWidth(char, fontSize);
            const neededSpace = currentLine === '' ? 0 : spaceW;
            if (currentWidth + neededSpace + wordPartW + charW > maxWidth) {
              if (currentLine !== '') {
                if (wordPart !== '') {
                  currentLine += (currentLine === '' ? '' : ' ') + wordPart;
                }
                lines.push(currentLine);
                currentLine = '';
                currentWidth = 0;
                wordPart = char;
                wordPartW = charW;
              } else {
                if (wordPart !== '') {
                  lines.push(wordPart);
                }
                wordPart = char;
                wordPartW = charW;
              }
            } else {
              wordPart += char;
              wordPartW += charW;
            }
          }
          if (wordPart !== '') {
            if (currentLine === '') {
              currentLine = wordPart;
              currentWidth = wordPartW;
            } else {
              currentLine += ' ' + wordPart;
              currentWidth += spaceW + wordPartW;
            }
          }
        } else if (currentLine === '') {
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
    lines = window.UIUtils.preventOrphans(lines);

    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      const lastLine = lines[lines.length - 1];
      if (lastLine.length > 2) {
        lines[lines.length - 1] = lastLine.slice(0, -1) + '...';
      } else {
        lines[lines.length - 1] = lastLine + '...';
      }
    }

    const lh = fontSize + 4;
    const totalH = (lines.length - 1) * lh;
    const startY = y - totalH / 2;

    let textSvg = '';
    lines.forEach((line, idx) => {
      const lineY = startY + idx * lh;
      textSvg += `<text x="${x}" y="${lineY}" text-anchor="middle" dominant-baseline="middle" fill="var(--text)" font-size="${fontSize}" font-weight="${fontWeight}" pointer-events="none">${esc(line)}</text>`;
    });
    return textSvg;
  }

  // ===== 图形视图（基础 SVG）=====

  function renderGraphicTree() {
    const wrapper = document.getElementById('ftaGraphicWrapper');
    if (!wrapper) return;
    if (!ftaData.rootId) {
      wrapper.innerHTML =
        '<p style="text-align:center;color:var(--text-muted);padding:40px;">定义顶事件后，故障树将显示在此处</p>';
      return;
    }

    const layout = _layoutTree(ftaData.rootId, 0, 0);
    const W = layout.totalWidth; // 使用子树实际像素宽度，而非列数估算
    const H = (layout.maxRow + 1) * FTA_LAYOUT_CONFIG.rowGap;

    // 动态画布与居中定位引擎
    const W_canvas = Math.max(800, W);
    const H_canvas = Math.max(400, H);
    const offsetX = (W_canvas - W) / 2;
    const offsetY = Math.max(20, (H_canvas - H) / 2);

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W_canvas} ${H_canvas}" data-fta-w="${W_canvas}" data-fta-h="${H_canvas}" style="font-family:var(--font);font-size:16px;cursor:grab;max-width:100%;height:auto;display:block;">`;
    svg += `<g id="fta-zoom-group">`;
    svg += `<g transform="translate(${offsetX}, ${offsetY})">`;

    // 绘制连线
    layout.edges.forEach((e) => {
      svg += `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="var(--border)" stroke-width="1.5"/>`;
    });

    // 绘制逻辑门（IEC 61025 标准符号）
    layout.gates.forEach((g) => {
      const gx = g.x, gy = g.y;
      if (g.type === 'AND') {
        svg += `<path d="M${gx - 24},${gy + 14} L${gx - 24},${gy - 14} Q${gx},${gy - 28} ${gx + 24},${gy - 14} L${gx + 24},${gy + 14} Z" fill="var(--bg-card)" stroke="var(--primary)" stroke-width="1.5"/>`;
        svg += `<text x="${gx}" y="${gy + 2}" text-anchor="middle" dominant-baseline="middle" fill="var(--primary)" font-weight="700" font-size="13" pointer-events="none">AND</text>`;
      } else {
        // OR gate: standard shield shape — top edge arcs upward, bottom edge arcs downward (IEC 61025)
        svg += `<path d="M${gx - 24},${gy - 14} Q${gx},${gy - 26} ${gx + 24},${gy - 14} L${gx + 24},${gy + 14} Q${gx},${gy + 28} ${gx - 24},${gy + 14} Z" fill="var(--bg-card)" stroke="var(--primary)" stroke-width="1.5"/>`;
        svg += `<text x="${gx}" y="${gy + 2}" text-anchor="middle" dominant-baseline="middle" fill="var(--primary)" font-weight="700" font-size="13" pointer-events="none">OR</text>`;
      }
    });

    // 节点类型编号计数器
    const _typeCounters = { basic: 0, intermediate: 0, undeveloped: 0 };

    // 绘制节点
    layout.items.forEach((item) => {
      const node = ftaData.nodes[item.id];
      if (!node) return;
      const x = item.x, y = item.y;
      const dims = getNodeDims(node.type);
      const w = dims.w, h = dims.h;
      const colors = {
        top: { stroke: 'var(--red)', fill: 'rgba(var(--red-rgb), 0.08)' },
        intermediate: { stroke: 'var(--primary)', fill: 'rgba(var(--primary-rgb), 0.08)' },
        basic: { stroke: 'var(--green)', fill: 'rgba(var(--green-rgb), 0.08)' },
        undeveloped: { stroke: 'var(--orange)', fill: 'rgba(var(--orange-rgb), 0.08)' }
      };
      const color = colors[node.type] || {
        stroke: 'var(--text-muted)',
        fill: 'var(--bg-secondary)'
      };
      const stroke = color.stroke;
      const fill = color.fill;
      const nodeTypeLabel = { top: 'TOP', basic: 'BE', intermediate: 'IE', undeveloped: 'UE' }[node.type] || '?';
      let nodeNumber = '';
      if (node.type !== 'top') {
        _typeCounters[node.type] = (_typeCounters[node.type] || 0) + 1;
        nodeNumber = nodeTypeLabel + '-' + String(_typeCounters[node.type]).padStart(2, '0');
      }

      // tooltip 显示详细描述
      const tooltip = esc(node.description || node.name);

      if (dims.isCircle) {
        svg += `<circle cx="${x}" cy="${y}" r="${dims.r}" fill="${fill}" stroke="${stroke}" stroke-width="2" class="fta-svg-node" data-id="${node.id}"><title>${tooltip}</title></circle>`;
        svg += renderSvgText(node.name, x, y, 64, 16, '500', 2);
      } else if (dims.isDiamond) {
        const hw = w / 2, hh = h / 2;
        svg += `<polygon points="${x},${y - hh} ${x + hw},${y} ${x},${y + hh} ${x - hw},${y}" fill="${fill}" stroke="${stroke}" stroke-width="2" class="fta-svg-node" data-id="${node.id}"><title>${tooltip}</title></polygon>`;
        // Diamond usable width narrows toward corners; tighten to avoid corner overflow
        svg += renderSvgText(node.name, x, y, w - 40, 15, '400', 2);
      } else {
        svg += `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${dims.r}" fill="${fill}" stroke="${stroke}" stroke-width="2" class="fta-svg-node" data-id="${node.id}"><title>${tooltip}</title></rect>`;
        svg += renderSvgText(node.name, x, y, w - 24, 16, node.type === 'top' ? '700' : '400', 2);
      }

      // 节点编号（左上角小字）
      if (nodeNumber) {
        svg += `<text x="${dims.isCircle ? x - dims.r + 6 : x - w / 2 + 6}" y="${dims.isCircle ? y - dims.r + 14 : y - h / 2 + 14}" fill="${stroke}" font-size="10" font-weight="600" opacity="0.7" pointer-events="none">${nodeNumber}</text>`;
      }

      // AI 徽章（右上角）
      if (node.status === 'ai-suggested' || node.status === 'auto-generated') {
        const bx = dims.isCircle ? x + dims.r : x + w / 2;
        const by = dims.isCircle ? y - dims.r : y - h / 2;
        svg += `<rect x="${bx - 22}" y="${by - 2}" width="20" height="14" rx="3" fill="${stroke}" opacity="0.9"/>`;
        svg += `<text x="${bx - 12}" y="${by + 9}" text-anchor="middle" fill="#fff" font-size="9" font-weight="700" pointer-events="none">AI</text>`;
      }
    });

    svg += '</g>'; // 关闭 translate 偏移组
    svg += '</g></svg>'; // 关闭 zoom 组与 svg
    wrapper.innerHTML = svg;

    // SVG 视图只用于展示、缩放、平移和导出，不承载节点编辑入口。
    _initZoomPan(wrapper);
  }

  let _zoomPanAbort = null;

  function _initZoomPan(wrapper) {
    if (_zoomPanAbort) {
      _zoomPanAbort.abort();
      _zoomPanAbort = null;
    }
    _zoomPanAbort = new AbortController();
    const sig = _zoomPanAbort.signal;

    const svg = wrapper.querySelector('svg');
    const g = wrapper.querySelector('#fta-zoom-group');
    if (!svg || !g || typeof svg.getAttribute !== 'function' || typeof svg.setAttribute !== 'function') return;

    const baseViewBox = (svg.getAttribute('viewBox') || '0 0 800 400')
      .split(/\s+/)
      .map(Number);
    // 桌面端与移动端初始均显示完整画布，缩放比例一致
    let initialView = { x: baseViewBox[0], y: baseViewBox[1], w: baseViewBox[2], h: baseViewBox[3] };
    let view = { ...initialView };
    let isDragging = false,
      startX = 0,
      startY = 0;
    let startViewX = view.x,
      startViewY = view.y,
      moved = false;

    function applyTransform() {
      svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    }

    function zoomAt(factor, clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
      const py = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(rect.height, 1)));
      const nextW = Math.max(160, Math.min(baseViewBox[2] * 2, view.w / factor));
      const nextH = Math.max(120, Math.min(baseViewBox[3] * 2, view.h / factor));
      const focusX = view.x + px * view.w;
      const focusY = view.y + py * view.h;
      view.x = focusX - px * nextW;
      view.y = focusY - py * nextH;
      view.w = nextW;
      view.h = nextH;
      applyTransform();
    }

    applyTransform();

    // 拖拽平移
    svg.addEventListener(
      'mousedown',
      (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startViewX = view.x;
        startViewY = view.y;
        moved = false;
        svg.style.cursor = 'grabbing';
      },
      { signal: sig }
    );

    document.addEventListener(
      'mousemove',
      (e) => {
        if (!isDragging) return;
        const rect = svg.getBoundingClientRect();
        const dx = ((e.clientX - startX) * view.w) / Math.max(rect.width, 1);
        const dy = ((e.clientY - startY) * view.h) / Math.max(rect.height, 1);
        moved = moved || Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 5;
        view.x = startViewX - dx;
        view.y = startViewY - dy;
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

    // 触摸支持
    let lastTouchDist = 0;
    let lastTouchMid = null;
    let touchGesture = null;
    svg.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 1) {
          // 单指先等待方向判定：纵向交给页面滚动，横向才接管画布平移。
          touchGesture = 'pending';
          isDragging = false;
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          startViewX = view.x;
          startViewY = view.y;
          moved = false;
        } else if (e.touches.length === 2) {
          e.preventDefault();
          touchGesture = 'pinch';
          isDragging = false;
          lastTouchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          lastTouchMid = {
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2
          };
        }
      },
      { passive: false, signal: sig }
    );

    svg.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length === 1) {
          const screenDx = e.touches[0].clientX - startX;
          const screenDy = e.touches[0].clientY - startY;
          if (touchGesture === 'pending') {
            if (Math.abs(screenDx) + Math.abs(screenDy) <= 6) return;
            if (Math.abs(screenDy) > Math.abs(screenDx)) {
              touchGesture = 'scroll';
              isDragging = false;
              return;
            }
            touchGesture = 'pan';
            isDragging = true;
          }
          if (touchGesture !== 'pan' || !isDragging) return;
          e.preventDefault();
          const rect = svg.getBoundingClientRect();
          const dx = (screenDx * view.w) / Math.max(rect.width, 1);
          const dy = (screenDy * view.h) / Math.max(rect.height, 1);
          moved = true;
          view.x = startViewX - dx;
          view.y = startViewY - dy;
          applyTransform();
        } else if (e.touches.length === 2) {
          e.preventDefault();
          touchGesture = 'pinch';
          const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          if (lastTouchDist > 0) {
            const mid = {
              x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
              y: (e.touches[0].clientY + e.touches[1].clientY) / 2
            };
            zoomAt(dist / lastTouchDist, mid.x, mid.y);
            if (lastTouchMid) {
              const rect = svg.getBoundingClientRect();
              view.x -= ((mid.x - lastTouchMid.x) * view.w) / Math.max(rect.width, 1);
              view.y -= ((mid.y - lastTouchMid.y) * view.h) / Math.max(rect.height, 1);
              applyTransform();
            }
            lastTouchMid = mid;
          }
          lastTouchDist = dist;
        }
      },
      { passive: false, signal: sig }
    );

    const finishTouch = (e) => {
      if (e.touches.length === 1) {
        // 双指缩放后若仍留下一根手指，重新等待方向判定，避免视图跳动。
        touchGesture = 'pending';
        isDragging = false;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startViewX = view.x;
        startViewY = view.y;
      } else {
        touchGesture = null;
        isDragging = false;
      }
      lastTouchDist = 0;
      lastTouchMid = null;
    };

    svg.addEventListener(
      'touchend',
      finishTouch,
      { signal: sig }
    );
    svg.addEventListener(
      'touchcancel',
      finishTouch,
      { signal: sig }
    );
    svg.style.cursor = 'grab';
    svg.addEventListener(
      'click',
      (e) => {
        if (!moved) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        moved = false;
      },
      { capture: true, signal: sig }
    );

    document.getElementById('ftaZoomIn')?.addEventListener(
      'click',
      () => {
        const rect = svg.getBoundingClientRect();
        zoomAt(1.25, rect.left + rect.width / 2, rect.top + rect.height / 2);
      },
      { signal: sig }
    );
    document.getElementById('ftaZoomOut')?.addEventListener(
      'click',
      () => {
        const rect = svg.getBoundingClientRect();
        zoomAt(0.8, rect.left + rect.width / 2, rect.top + rect.height / 2);
      },
      { signal: sig }
    );
    document.getElementById('ftaZoomReset')?.addEventListener(
      'click',
      () => {
        view = { ...initialView };
        applyTransform();
      },
      { signal: sig }
    );
  }

  function _layoutTree(nodeId, row, col) {
    const visited = new Set();
    const items = [], edges = [], gates = [];
    let maxRow = row;
    const cfg = FTA_LAYOUT_CONFIG;

    // ── Phase 1: 自底向上计算每个子树所需的像素宽度 ──────────────────────
    // 叶节点宽度 = 节点视觉宽度 + 两侧 nodeHPad
    // 分支节点宽度 = max(所有子树宽度之和, 自身最小宽度)
    const _stw = {};
    const _stk = new Set();
    function subtreeWidth(nid) {
      if (_stw[nid] !== undefined) return _stw[nid];
      if (_stk.has(nid)) return 0;
      _stk.add(nid);
      const node = ftaData.nodes[nid];
      if (!node) { _stk.delete(nid); return _stw[nid] = getNodeDims('basic').w + cfg.nodeHPad * 2; }
      const ownSlot = getNodeDims(node.type).w + cfg.nodeHPad * 2;
      if (!node.children || node.children.length === 0) {
        _stk.delete(nid);
        return _stw[nid] = ownSlot;
      }
      const childSum = node.children.reduce((s, cid) => s + subtreeWidth(cid), 0);
      _stk.delete(nid);
      return _stw[nid] = Math.max(childSum, ownSlot);
    }

    // ── Phase 2: 自顶向下按像素宽度分配 x 坐标 ──────────────────────────
    function lay(nid, r, centerX) {
      if (visited.has(nid)) return;
      visited.add(nid);
      const node = ftaData.nodes[nid];
      if (!node) return;

      const y = r * cfg.rowGap + cfg.topOffset;
      items.push({ id: nid, x: centerX, y, row: r, col: r });
      if (r > maxRow) maxRow = r;

      if (node.children.length > 0 && node.gateType) {
        const gateY = y + cfg.gateOffset;
        gates.push({ x: centerX, y: gateY, type: node.gateType });

        const dimsParent = getNodeDims(node.type);
        edges.push({ x1: centerX, y1: y + dimsParent.h / 2, x2: centerX, y2: gateY - cfg.edgeOffset });

        // 按各子树宽度比例分配 x，保持紧凑对齐
        const childWidths = node.children.map(cid => subtreeWidth(cid));
        const totalW = childWidths.reduce((s, w) => s + w, 0);
        let cx = centerX - totalW / 2;

        node.children.forEach((cid, i) => {
          const ccx = cx + childWidths[i] / 2;
          const childNode = ftaData.nodes[cid];
          const dimsChild = getNodeDims(childNode ? childNode.type : 'intermediate');
          const childY = (r + 1) * cfg.rowGap + cfg.topOffset;

          edges.push({
            x1: centerX, y1: gateY + cfg.edgeOffset,
            x2: ccx, y2: childY - dimsChild.h / 2
          });
          lay(cid, r + 1, ccx);
          cx += childWidths[i];
        });
      }
    }

    // 将根节点居中于整棵树的像素宽度中央
    subtreeWidth(nodeId); // 预热缓存
    const treeW = _stw[nodeId];
    const totalWidth = treeW + cfg.leftOffset * 2; // 左右各留 leftOffset 作边距
    const rootCenterX = totalWidth / 2;

    lay(nodeId, row, rootCenterX);

    // maxCol 用于向后兼容（W 计算已改用 totalWidth）
    const maxCol = Math.max(0, Math.ceil(treeW / cfg.colGap));
    return { items, edges, gates, maxCol, maxRow, totalWidth };
  }

  // ===== UI 渲染 =====

  function renderAll() {
    _renderTopEventForm();
    _renderTreeView();
    _renderStats();
  }

  function _renderTopEventForm() {
    const form = document.getElementById('ftaTopEventForm');
    if (!form) return;
    const te = ftaData.topEvent;
    const locked = te.locked;

    form.innerHTML = `
      <div class="form-group">
        <label for="fta-problem-title-ref">问题标题</label>
        <input type="text" id="fta-problem-title-ref" class="input-field" placeholder="简明扼要的问题标题" value="${esc(ftaData.metadata.problemTitle || '')}">
      </div>
      <div class="form-group">
        <label for="fta-problem-context">问题现象</label>
        <textarea id="fta-problem-context" class="input-field textarea textarea-sm" placeholder="描述你观察到的异常现象">${esc(ftaData.metadata.problemContext || '')}</textarea>
        <button type="button" class="btn btn-outline btn-sm" id="btnFtaLoadFromPool" style="margin-top: var(--space-2);">从问题库选择</button>
      </div>
      <div class="form-group">
        <div style="display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 4px;">
          <label for="fta-top-event" style="margin-bottom: 0;">顶事件（不期望发生的故障/问题）<span class="required">*</span></label>
          <span style="font-size: var(--fs-caption); color: var(--text-muted);">格式：[对象/系统] 发生 [故障/异常现象]</span>
          <button type="button" class="btn btn-outline btn-sm" id="btnFtaRefTitle" title="引用问题标题作为顶事件" ${locked ? 'disabled' : ''}>引用标题</button>
          ${locked ? '<button type="button" class="btn btn-outline btn-sm fta-inline-check" id="btnFtaAICheck" title="检查顶事件和系统边界是否符合 FTA 建模规范">FTA建模规范检查<span class="fta-ai-corner-badge" aria-hidden="true">AI</span></button>' : ''}
        </div>
        <textarea id="fta-top-event" class="input-field textarea textarea-sm" placeholder="在此输入顶事件" ${locked ? 'disabled' : ''}>${esc(te.name)}</textarea>
      </div>
      <div class="form-group">
        <label for="fta-boundary">系统边界与假设（可选）</label>
        <textarea id="fta-boundary" class="input-field textarea textarea-sm" placeholder="分析范围限定，如：不考虑外部环境因素" ${locked ? 'disabled' : ''}>${esc(te.boundary)}</textarea>
      </div>
      <div class="fta-top-actions">
        ${
          locked
            ? '<button type="button" class="btn btn-outline btn-sm" id="btnFtaUnlock"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>解锁顶事件</button>'
            : '<button type="button" class="btn btn-primary btn-sm" id="btnFtaLockTop"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>确认顶事件</button>'
        }
        ${locked ? '<button type="button" class="btn btn-outline btn-sm" id="btnFtaAutoExpand" title="根据顶事件与系统边界自动生成故障树"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>AI 自动分析</button>' : ''}
        ${locked && ftaData.rootId && Object.keys(ftaData.nodes).length > 1 ? '<button type="button" class="btn btn-outline btn-sm" id="btnFtaGapScan" title="检查已生成故障树的遗漏分支和逻辑门问题"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>AI 查漏补缺</button>' : ''}
        ${locked && ftaData.rootId && Object.keys(ftaData.nodes).length > 2 ? '<button type="button" class="btn btn-primary btn-sm" id="btnFtaAnalyze"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>分析故障树</button>' : ''}
        ${locked && ftaData.rootId && Object.keys(ftaData.nodes).length > 2 ? '<button type="button" class="btn btn-outline btn-sm" id="btnFtaReport"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>生成报告</button>' : ''}
        ${locked && ftaData.rootId && Object.keys(ftaData.nodes).length > 2 ? '<button type="button" class="btn btn-outline btn-sm" id="btnFtaViewReport"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>查看报告</button>' : ''}
        <button type="button" class="btn btn-outline btn-sm btn-danger-text" id="btnFtaClear" title="清空当前 FTA 分析">清空当前分析</button>
      </div>
    `;
  }

  function _renderTreeView() {
    const htmlBox = document.getElementById('ftaHtmlTree');
    const graphicBox = document.getElementById('ftaGraphicWrapper');
    if (!htmlBox || !graphicBox) return;

    const btn = document.getElementById('btnFtaToggleView');
    if (ftaData.viewMode !== 'graphic') {
      htmlBox.parentElement.classList.remove('hidden');
      graphicBox.parentElement.classList.add('hidden');
      htmlBox.innerHTML = renderAsciiTreeHtml();
      // 文本视图是唯一的节点编辑入口。
      htmlBox.querySelectorAll('.fta-ascii-node').forEach((el) => {
        el.addEventListener('click', () => _openNodeEditor(el.dataset.id));
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            _openNodeEditor(el.dataset.id);
          }
        });
      });
      // 默认文本视图下仍生成隐藏 SVG，确保报告和图片导出始终可用。
      renderGraphicTree();
      if (btn) {
        btn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><rect x="9" y="1" width="6" height="5" rx="1"></rect><rect x="1" y="17" width="6" height="5" rx="1"></rect><rect x="17" y="17" width="6" height="5" rx="1"></rect><path d="M12 6v6M12 12H4v5M12 12h8v5"></path></svg>图形视图';
      }
    } else {
      htmlBox.parentElement.classList.add('hidden');
      graphicBox.parentElement.classList.remove('hidden');
      renderGraphicTree();
      if (btn) {
        btn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>文本视图';
      }
    }
  }

  let _selectedNodeId = null;

  function _openNodeEditor(nodeId) {
    _selectedNodeId = nodeId;
    _renderNodeEditor();
    const panel = document.getElementById('ftaNodeEditor');
    panel?.classList.add('is-open');
    window.setTimeout(() => document.getElementById('ftaEditName')?.focus(), 180);
  }

  function _closeNodeEditor() {
    const panel = document.getElementById('ftaNodeEditor');
    panel?.classList.remove('is-open');
  }

  function _renderNodeEditor() {
    const panel = document.getElementById('ftaNodeEditor');
    if (!panel) return;

    if (!_selectedNodeId || !ftaData.nodes[_selectedNodeId]) {
      panel.classList.remove('is-open');
      return;
    }

    const node = ftaData.nodes[_selectedNodeId];
    const depth = _getNodeDepth(_selectedNodeId);
    const canAddChild =
      depth < ftaData.settings.maxDepth &&
      Object.keys(ftaData.nodes).length < ftaData.settings.maxNodes;
    const isTop = node.type === 'top';
    const confClass = node.confidence >= 0.7 ? 'high' : node.confidence >= 0.4 ? 'medium' : 'low';

    panel.innerHTML = `
      <div class="fta-editor-card" onclick="event.stopPropagation()">
        <div class="fta-editor-header">
          <h3 class="fta-editor-heading" style="flex:1;font-size:14px;font-weight:600;margin:0;">${isTop ? '编辑顶事件' : '编辑节点'}</h3>
          <span class="fta-node-type-badge fta-type-${node.type}">${node.type.toUpperCase()}</span>
          <span class="confidence-badge ${confClass}">${Math.round(node.confidence * 100)}%</span>
          <span class="fta-status-tag fta-status-${node.status}">${
            {
              manual: '手动',
              'ai-suggested': 'AI建议',
              confirmed: '已确认',
              'auto-generated': 'AI生成'
            }[node.status] || node.status
          }</span>
          <button type="button" class="btn btn-outline btn-sm" data-fta-node-action="close-editor" aria-label="关闭">✕</button>
        </div>
        <div class="form-group">
          <label for="ftaEditName">事件名称 <span style="font-size:var(--fs-micro);color:var(--text-muted);font-weight:400;">（≤ 30 字，SVG 树图显示）</span></label>
          <input type="text" class="input-field" id="ftaEditName" value="${esc(node.name)}" maxlength="30" ${isTop ? 'disabled' : ''} aria-label="事件名称">
        </div>
        <div class="form-group">
          <label for="ftaEditDesc">详细描述 <span style="font-size:var(--fs-micro);color:var(--text-muted);font-weight:400;">（tooltip/报表显示）</span></label>
          <textarea class="input-field" id="ftaEditDesc" rows="3" style="resize:vertical;min-height:60px;" aria-label="详细描述">${esc(node.description || '')}</textarea>
        </div>
        <div class="form-row">
          <div class="form-group flex-1">
            <label for="ftaEditType">事件类型</label>
            <select class="input-field" id="ftaEditType" ${isTop ? 'disabled' : ''} aria-label="事件类型">
              ${isTop ? '<option value="top" selected>顶事件</option>' : ''}
              <option value="intermediate" ${node.type === 'intermediate' ? 'selected' : ''}>中间事件</option>
              <option value="basic" ${node.type === 'basic' ? 'selected' : ''}>底事件（基本事件）</option>
              <option value="undeveloped" ${node.type === 'undeveloped' ? 'selected' : ''}>待展开</option>
            </select>
          </div>
          <div class="form-group flex-1">
            <label for="ftaEditGate">逻辑门</label>
            <select class="input-field" id="ftaEditGate" aria-label="逻辑门">
              <option value="" ${!node.gateType ? 'selected' : ''}>无</option>
              <option value="OR" ${node.gateType === 'OR' ? 'selected' : ''}>OR（或门）</option>
              <option value="AND" ${node.gateType === 'AND' ? 'selected' : ''}>AND（与门）</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label for="ftaEditGateReason">逻辑门理由</label>
          <input type="text" class="input-field" id="ftaEditGateReason" value="${esc(node.gateReason)}" placeholder="选择 AND/OR 的工程依据" aria-label="逻辑门理由">
        </div>
        <div class="fta-editor-actions">
          <button type="button" class="btn btn-primary btn-sm" id="btnFtaSaveNode" aria-label="保存修改">保存修改</button>
          ${
            node.status === 'ai-suggested' || node.status === 'auto-generated'
              ? '<button type="button" class="btn btn-success btn-sm" id="btnFtaConfirmNode" aria-label="确认节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><polyline points="20 6 9 17 4 12"></polyline></svg>确认</button>'
              : ''
          }
          ${canAddChild ? '<button type="button" class="btn btn-outline btn-sm" id="btnFtaAddChild" aria-label="添加子事件"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>添加子事件</button>' : ''}
          ${canAddChild ? '<button type="button" class="btn btn-outline btn-sm" id="btnFtaAISuggest" aria-label="AI 建议子事件"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4M8 16h.01M16 16h.01"></path></svg>AI 建议子事件</button>' : ''}
          ${!isTop ? '<button type="button" class="btn btn-danger btn-sm" id="btnFtaDeleteNode" aria-label="删除节点">删除</button>' : ''}
        </div>
        <div class="fta-editor-actions" style="margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--border);">
          <button type="button" class="btn btn-outline btn-sm" data-fta-node-action="close-editor">取消</button>
        </div>
      </div>
    `;
  }

  function _renderStats() {
    const el = document.getElementById('ftaStats');
    if (!el) return;
    const m = ftaData.metadata;
    const total = m.nodeCount;
    const confirmed = m.confirmedCount;
    const pct = total > 0 ? Math.round((confirmed / total) * 100) : 0;
    el.innerHTML = `节点: ${total} | 已确认: ${confirmed} (${pct}%) | 模式: ${m.mode === 'auto' ? '自动' : '引导'}`;
  }

  // ===== 事件绑定 =====

  function bindEvents() {
    const container = document.getElementById('tool-fta');
    if (!container) return;

    container.addEventListener('click', async (e) => {
      if (e.target === document.getElementById('ftaNodeEditor')) {
        _closeNodeEditor();
        return;
      }

      const t = e.target.closest('button');
      if (!t) return;

      const nodeAction = t.dataset.ftaNodeAction;
      if (nodeAction) {
        const nodeId = t.dataset.nodeId || t.closest('[data-node-id]')?.dataset.nodeId;
        if (nodeAction === 'close-editor') {
          _closeNodeEditor();
        } else if (nodeId && ftaData.nodes[nodeId]) {
          _selectedNodeId = nodeId;
          if (nodeAction === 'edit') _openNodeEditor(nodeId);
          else if (nodeAction === 'confirm') _confirmNode();
          else if (nodeAction === 'add') {
            _addChildNode();
            _openNodeEditor(_selectedNodeId);
          }
        }
        return;
      }

      if (t.id === 'btnFtaLockTop') _lockTopEvent();
      else if (t.id === 'btnFtaUnlock') _unlockTopEvent();
      else if (t.id === 'btnFtaLoadFromPool') _loadFromProblemPool();
      else if (t.id === 'btnFtaRefTitle') _refTitleToTopEvent();
      else if (t.id === 'btnFtaClear') {
        if (await showConfirm('确定清空当前 FTA 分析吗？将移除节点和本地草稿，不影响问题信息和已保存报告。', 'danger')) {
          await clearFtaData();
          showToast('当前 FTA 分析已清空（不影响问题信息和已保存报告）', 'info');
        }
      } else if (t.id === 'btnFtaSaveNode') _saveNodeEdits();
      else if (t.id === 'btnFtaConfirmNode') _confirmNode();
      else if (t.id === 'btnFtaAddChild') { _addChildNode(); _openNodeEditor(_selectedNodeId); }
      else if (t.id === 'btnFtaDeleteNode') _deleteSelectedNode();
      else if (t.id === 'btnFtaToggleView') _toggleView();
      else if (t.id === 'btnFtaCopyText') await _copyTextTree();
      // AI buttons
      else if (t.id === 'btnFtaAICheck') aiCheckTopEvent();
      else if (t.id === 'btnFtaAISuggest') aiSuggestChildren();
      else if (t.id === 'btnFtaAutoExpand') aiAutoExpand();
      else if (t.id === 'btnFtaGapScan') aiGapScan();
      else if (t.id === 'btnFtaAnalyze') runAnalysis();
      else if (t.id === 'btnFtaReport') {
        const btn = t;
        btn.disabled = true;
        btn.textContent = '生成中...';
        try {
          await generateReport();
        } finally {
          btn.disabled = false;
          btn.textContent = '生成报告';
        }
      } else if (t.id === 'btnFtaViewReport') _viewFtaReport();
      else if (t.id === 'btnExportFtaSVG') {
        const svgEl = document.querySelector('#ftaGraphicWrapper svg');
        if (svgEl) {
          const svgStr = new XMLSerializer().serializeToString(svgEl);
          const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
          const safeTitle = (ftaData.nodes[ftaData.rootId]?.name || '故障树')
            .replace(/[^\w一-龥]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 30);
          window.UIUtils.saveExportBlob(
            blob,
            `FTA-${safeTitle}-${new Date().toISOString().slice(0, 10)}.svg`,
            {
              filterName: 'SVG 图片',
              extensions: ['svg'],
              successMessage: '故障树 SVG 已导出'
            }
          );
        } else {
          showToast('请先创建故障树', 'error');
        }
      } else if (t.id === 'btnExportFtaPNG') {
        const svgEl = document.querySelector('#ftaGraphicWrapper svg');
        if (svgEl) {
          const safeTitle = (ftaData.nodes[ftaData.rootId]?.name || '故障树')
            .replace(/[^\w一-龥]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 30);
          const filename = `FTA-${safeTitle}-${new Date().toISOString().slice(0, 10)}.png`;
          await window.UIUtils.exportPngFromSvg(svgEl, filename);
        } else {
          showToast('请先创建故障树', 'error');
        }
      }
    });

    const panel = document.getElementById('tool-fta');
    if (panel) {
      panel.addEventListener('toolpanel:show', async () => {
        const activePid =
          typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
        const problem =
          activePid && typeof window.getProblemById === 'function'
            ? window.getProblemById(activePid)
            : null;

        if (problem) {
          // 始终尝试先加载已有的 FTA 数据，而不是直接根据 status === 'not_started' 清空数据
          const loaded = await loadFtaData();
          if (loaded) {
            return;
          }

          const analyses = problem.analyses || {};
          const started =
            analyses['fta'] &&
            (analyses['fta'].status === 'in_progress' || analyses['fta'].status === 'completed');
          if (!started) {
            // Clear ftaData and DOM inputs, do NOT save to DB
            ftaData = createEmptyFtaData();
            _ftaNextId = 1;

            const titleRefEl = document.getElementById('fta-problem-title-ref');
            if (titleRefEl) titleRefEl.value = '';
            const ctxEl = document.getElementById('fta-problem-context');
            if (ctxEl) ctxEl.value = '';
            const topEventEl = document.getElementById('fta-top-event');
            if (topEventEl) topEventEl.value = '';
            const boundaryEl = document.getElementById('fta-boundary');
            if (boundaryEl) boundaryEl.value = '';

            renderAll();
            return;
          }

          // started: loadFtaData returned false, but analyses says in_progress.
          // This means syncToolDom may have already set ftaData in-memory.
          // Check if ftaData already has content from a prior syncToolDom call.
          const hasContent =
            ftaData &&
            (ftaData.rootId || ftaData.metadata.problemTitle || ftaData.metadata.problemContext);
          if (hasContent) {
            renderAll();
            return;
          }
        }

        // 示例加载的问题不自动预填，保持空状态
        if (problem && problem._fromExample) {
          ftaData = createEmptyFtaData();
          _ftaNextId = 1;
          const titleRefEl = document.getElementById('fta-problem-title-ref');
          if (titleRefEl) titleRefEl.value = '';
          const ctxEl = document.getElementById('fta-problem-context');
          if (ctxEl) ctxEl.value = '';
          const topEventEl = document.getElementById('fta-top-event');
          if (topEventEl) topEventEl.value = '';
          const boundaryEl = document.getElementById('fta-boundary');
          if (boundaryEl) boundaryEl.value = '';
          renderAll();
          return;
        }

        // 如果当前是空树，且有活跃问题，自动预填顶事件和上下文
        const hasContent =
          ftaData &&
          (ftaData.rootId || ftaData.metadata.problemTitle || ftaData.metadata.problemContext);
        if (!hasContent && activePid && problem) {
          ftaData.metadata.problemTitle = problem.title || '';
          ftaData.metadata.problemContext =
            problem.problemStatement || problem.details?.phenomenon || '';
          if (ftaData.topEvent && !ftaData.topEvent.name) {
            ftaData.topEvent.name = problem.title || '';
          }
        }
        renderAll();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const panel = document.getElementById('ftaNodeEditor');
        if (panel?.classList.contains('is-open')) {
          _closeNodeEditor();
        }
      }
    });
  }

  function _loadFromProblemPool() {
    if (window.openProblemPicker) {
      window.openProblemPicker((problem) => {
        const title = problem.title || '';
        const desc = problem.problemStatement || problem.details?.phenomenon || '';

        if (window.loadProblemToCurrent && typeof window.loadProblemToCurrent === 'function') {
          // Pass callback to guarantee async IndexedDB read completes before UI sync
          window.loadProblemToCurrent(problem.id, () => {
            const p =
              typeof window.getProblemById === 'function' ? window.getProblemById(problem.id) : null;
            if (p) {
              const analyses = p.analyses || {};
              if (!analyses['fta'] || analyses['fta'].status === 'not_started') {
                analyses['fta'] = { status: 'in_progress', lastUpdated: new Date().toISOString() };
                window.updateProblem(problem.id, { analyses: analyses, status: 'analyzing' });
              }
            }

            // Sync the input values from problem metadata
            const titleRefEl = document.getElementById('fta-problem-title-ref');
            if (titleRefEl) titleRefEl.value = title || '';
            ftaData.metadata.problemTitle = title || '';

            const ctxEl = document.getElementById('fta-problem-context');
            if (ctxEl) {
              ctxEl.value = desc || '';
              ftaData.metadata.problemContext = desc || '';
            }

            // 预填顶事件（仅新分析且无顶事件节点时）
            if (title && !ftaData.rootId) {
              const topEventEl = document.getElementById('fta-top-event');
              if (topEventEl && !topEventEl.value.trim()) {
                topEventEl.value = title;
              }
              if (ftaData.topEvent && !ftaData.topEvent.name) {
                ftaData.topEvent.name = title;
              }
            }

            const data = window.FTA.getData();
            const nameEl = document.getElementById('fta-top-event');
            if (nameEl && data && data.topEvent && ftaData.rootId) {
              nameEl.value = data.topEvent.name || '';
            }
            const boundaryEl = document.getElementById('fta-boundary');
            if (boundaryEl && data && data.topEvent) {
              boundaryEl.value = data.topEvent.boundary || '';
            }
            renderAll();
            if (typeof updateProblemSummaryUI === 'function') {
              updateProblemSummaryUI(problem.id);
            }
            showToast('已从问题库导入', 'success');
          });
        } else {
          // Fallback if loadProblemToCurrent is not defined
          const titleRefEl = document.getElementById('fta-problem-title-ref');
          if (titleRefEl) titleRefEl.value = title || '';
          ftaData.metadata.problemTitle = title || '';

          const ctxEl = document.getElementById('fta-problem-context');
          if (ctxEl) {
            ctxEl.value = desc || '';
            ftaData.metadata.problemContext = desc || '';
          }

          if (title && !ftaData.rootId) {
            const topEventEl = document.getElementById('fta-top-event');
            if (topEventEl && !topEventEl.value.trim()) {
              topEventEl.value = title;
            }
            if (ftaData.topEvent && !ftaData.topEvent.name) {
              ftaData.topEvent.name = title;
            }
          }
          renderAll();
          showToast('已从问题库导入', 'success');
        }
      });
    } else {
      showToast('问题库模块未加载', 'error');
    }
  }

  function _refTitleToTopEvent() {
    const titleEl = document.getElementById('fta-problem-title-ref');
    const topEventEl = document.getElementById('fta-top-event');
    if (!titleEl || !topEventEl) return;
    const title = titleEl.value.trim();
    if (!title) {
      showToast('请先填写问题标题', 'error');
      return;
    }
    topEventEl.value = title;
    showToast('已引用问题标题', 'success');
  }

  function _lockTopEvent() {
    const nameEl = document.getElementById('fta-top-event');
    const boundaryEl = document.getElementById('fta-boundary');
    const name = (nameEl ? nameEl.value : '').trim();
    if (!name) {
      showToast('请输入顶事件描述', 'error');
      return;
    }

    ftaData.topEvent.name = name;
    ftaData.topEvent.boundary = boundaryEl ? boundaryEl.value.trim() : '';
    ftaData.topEvent.locked = true;
    ftaData.metadata.createdAt = ftaData.metadata.createdAt || new Date().toISOString();

    // 创建顶事件节点
    if (!ftaData.rootId) {
      const topNode = addNode(null, { name: name, type: 'top', gateType: 'OR', status: 'manual' });
      ftaData.rootId = topNode.id;
      ftaData.topEvent.id = topNode.id;
    } else {
      updateNode(ftaData.rootId, { name: name });
    }

    saveFtaData(true);
    renderAll();
    showToast('顶事件已锁定', 'success');
  }

  function _unlockTopEvent() {
    ftaData.topEvent.locked = false;
    saveFtaData(true);
    renderAll();
  }

  function _saveNodeEdits() {
    if (!_selectedNodeId) return;
    const name = document.getElementById('ftaEditName')?.value.trim();
    const description = document.getElementById('ftaEditDesc')?.value.trim();
    const type = document.getElementById('ftaEditType')?.value;
    const gate = document.getElementById('ftaEditGate')?.value || null;
    const gateReason = document.getElementById('ftaEditGateReason')?.value.trim();

    updateNode(_selectedNodeId, { name, description, type, gateType: gate, gateReason });
    saveFtaData(true);
    renderAll();
    _renderNodeEditor();
    showToast('节点已更新', 'success');
  }

  function _withActionLock(action, fn) {
    if (_actionLocks[action]) return;
    _actionLocks[action] = true;
    try {
      fn();
    } finally {
      setTimeout(() => { delete _actionLocks[action]; }, 300);
    }
  }

  function _confirmNode() {
    if (!_selectedNodeId) return;
    _withActionLock('confirm', () => {
      updateNode(_selectedNodeId, { status: 'confirmed' });
      saveFtaData(true);
      renderAll();
      _renderNodeEditor();
      showToast('节点已确认', 'success');
    });
  }

  function _addChildNode() {
    if (!_selectedNodeId) return;
    _withActionLock('add', () => {
      const parent = ftaData.nodes[_selectedNodeId];
      if (!parent) return;

      // 如果父节点没有逻辑门，默认设为 OR
      if (!parent.gateType) {
        parent.gateType = 'OR';
      }

      const child = addNode(_selectedNodeId, {
        name: '',
        type: 'undeveloped',
        status: 'manual'
      });

      _selectedNodeId = child.id;
      saveFtaData(true);
      renderAll();
    });
  }

  async function _deleteSelectedNode() {
    if (!_selectedNodeId) return;
    const node = ftaData.nodes[_selectedNodeId];
    if (!node || node.type === 'top') {
      showToast('不能删除顶事件', 'error');
      return;
    }
    if (!(await showConfirm('删除此节点及其所有子节点？', 'danger'))) return;

    removeNode(_selectedNodeId);
    _selectedNodeId = null;
    _closeNodeEditor();
    saveFtaData(true);
    renderAll();
    showToast('节点已删除', 'info');
  }

  function _toggleView() {
    ftaData.viewMode = ftaData.viewMode === 'graphic' ? 'html' : 'graphic';
    _renderTreeView();
  }

  async function _copyTextTree() {
    const text = renderAsciiTree();
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('copy command failed');
      }
      showToast('故障树文本已复制', 'success');
    } catch (e) {
      console.warn('FTA text copy failed:', e);
      showToast('复制失败，请重试', 'error');
    }
  }

  // ===== AI 交互函数（Phase 2）=====

  function _showFtaSidebar(title, html) {
    if (window.SidebarUI) {
      window.SidebarUI.openContent(
        title,
        window.wrapWithThinking ? window.wrapWithThinking(html) : html
      );
    }
  }

  function _getTreePath(nodeId) {
    const parts = [];
    let cur = nodeId;
    while (cur && ftaData.nodes[cur]) {
      parts.unshift(ftaData.nodes[cur].name || '未命名');
      cur = ftaData.nodes[cur].parentId;
    }
    return parts.join(' → ');
  }

  /** AI 顶事件规范检查 */
  async function aiCheckTopEvent() {
    if (!ftaData.topEvent.name) {
      showToast('请先输入顶事件', 'error');
      return;
    }
    showToast('AI 顶事件检查中...', 'info');
    if (window.SidebarUI) {
      window.SidebarUI.open('FTA 顶事件检查');
      window.SidebarUI.showLoading('正在分析顶事件规范性...', [
        '正在评估事件描述清晰度...',
        '正在检查边界定义完整性...',
        '正在生成优化建议...'
      ]);
    }
    ftaData.metadata.aiCallCount++;

    let reasoningStreamActive = false;
    try {
      const rendered = renderPrompt('ftaTopEventCheck', {
        topEvent: ftaData.topEvent.name,
        boundary: ftaData.topEvent.boundary || '未声明'
      });
      let result;
      try {
        const { text: streamContent } = await callOpenAIStreaming(rendered.system, rendered.user, {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningStreamActive) {
              reasoningStreamActive = true;
              window.SidebarUI?.showReasoningStream('模型推理输出', 'ftaCheckReasoningContent');
            }
            window.SidebarUI?.updateReasoningStream('ftaCheckReasoningContent', fullText);
          }
        });
        result = parseAIJson(streamContent);
      } catch (streamErr) {
        if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') throw streamErr;
        console.warn('[FTA] aiCheckTopEvent streaming failed, falling back:', streamErr.message);
        window.SidebarUI?.hideLoading();
        window.SidebarUI?.showLoading('正在以兼容模式检查...', null, true);
        result = await callAI(rendered.system, rendered.user, true);
      }

      const _isFtaExample = window.isActiveProblemExample();

      let html = '<div class="ai-block">';
      html += `<h4>规范性评分: ${Math.round((result.score || 0) * 100)}%</h4>`;
      html += `<p>${result.isValid ? '✅ 顶事件定义基本规范' : '⚠️ 顶事件需要改进'}</p>`;

      if (result.issues && result.issues.length > 0) {
        html += '<h4>发现的问题</h4><ul>';
        result.issues.forEach((i) => {
          html += `<li>${esc(i)}</li>`;
        });
        html += '</ul>';
      }

      // correctedTopEvent one-click apply
      if (result.correctedTopEvent && result.correctedTopEvent.trim()) {
        const btnId = 'ftaApplyCorrectedTopEvent';
        html += `<h4>AI 建议顶事件</h4>`;
        html += `<p style="background:var(--bg-hover);padding:6px 8px;border-radius:var(--radius);display:flex;align-items:center;gap:8px;">`;
        html += `<span style="flex:1;">${esc(result.correctedTopEvent.trim())}</span>`;
        html += `<button type="button" class="btn btn-primary btn-sm" id="${btnId}" style="white-space:nowrap;flex-shrink:0;">应用</button></p>`;
        if (!_isFtaExample) {
          html += `<div id="${btnId}Status" style="font-size:0.75rem;color:var(--text-muted);margin-top:-4px;"></div>`;
        }
      }

      // correctedBoundary one-click apply
      if (result.correctedBoundary && result.correctedBoundary.trim()) {
        const btnId = 'ftaApplyCorrectedBoundary';
        html += `<h4>AI 建议边界</h4>`;
        html += `<p style="background:var(--bg-hover);padding:6px 8px;border-radius:var(--radius);display:flex;align-items:center;gap:8px;">`;
        html += `<span style="flex:1;">${esc(result.correctedBoundary.trim())}</span>`;
        html += `<button type="button" class="btn btn-primary btn-sm" id="${btnId}" style="white-space:nowrap;flex-shrink:0;">应用</button></p>`;
        if (!_isFtaExample) {
          html += `<div id="${btnId}Status" style="font-size:0.75rem;color:var(--text-muted);margin-top:-4px;"></div>`;
        }
      }

      if (result.suggestion && !result.correctedTopEvent) {
        html += `<h4>建议改写为</h4><p style="background:var(--bg-hover);padding:8px;border-radius:var(--radius);">${esc(result.suggestion)}</p>`;
      }
      if (result.boundaryCheck && !result.correctedBoundary) {
        html += `<h4>边界评价</h4><p>${esc(result.boundaryCheck)}</p>`;
      }
      html += '</div>';
      _showFtaSidebar('FTA 顶事件检查', html);

      // Bind apply buttons
      if (!_isFtaExample) {
        const applyBtn = document.getElementById('ftaApplyCorrectedTopEvent');
        if (applyBtn) {
          applyBtn.addEventListener('click', () => {
            const val = result.correctedTopEvent.trim();
            const oldEvent = ftaData.topEvent.name;
            ftaData.topEvent.name = val;
            const statusEl = document.getElementById('ftaApplyCorrectedTopEventStatus');
            if (statusEl) {
              statusEl.textContent = `已应用（原: ${esc(oldEvent)}）`;
            }
            applyBtn.disabled = true;
            applyBtn.textContent = '✓ 已应用';
            saveFtaData(true);
            renderAll();
            showToast('顶事件已更新', 'success');
          });
        }
        const boundBtn = document.getElementById('ftaApplyCorrectedBoundary');
        if (boundBtn) {
          boundBtn.addEventListener('click', () => {
            const val = result.correctedBoundary.trim();
            const oldBoundary = ftaData.topEvent.boundary;
            ftaData.topEvent.boundary = val;
            const statusEl = document.getElementById('ftaApplyCorrectedBoundaryStatus');
            if (statusEl) {
              statusEl.textContent = `已应用（原: ${esc(oldBoundary || '（空）')}）`;
            }
            boundBtn.disabled = true;
            boundBtn.textContent = '✓ 已应用';
            saveFtaData(true);
            renderAll();
            showToast('边界已更新', 'success');
          });
        }
      }

      showToast('顶事件检查完成', 'success');
    } catch (err) {
      const hint = esc(getApiErrorHint(err.message));
      _showFtaSidebar(
        'FTA 顶事件检查',
        `<div class="ai-block is-error"><h4>检查失败</h4><p>${esc(err.message)}</p><p style="color:var(--text-muted);font-size:0.75rem;margin-top:8px;">${hint}</p></div>`
      );
      showToast('AI 检查失败: ' + err.message, 'error');
    }
  }

  /** AI 子事件建议（引导模式）*/
  async function aiSuggestChildren() {
    if (!_selectedNodeId || !ftaData.nodes[_selectedNodeId]) {
      showToast('请先选择一个节点', 'error');
      return;
    }
    const node = ftaData.nodes[_selectedNodeId];
    // Fix H3: capture context before async AI call
    const _aiCtx = captureAiContext();
    showToast('AI 子事件建议生成中...', 'info');
    if (window.SidebarUI) {
      window.SidebarUI.open('AI 子事件建议');
      window.SidebarUI.showLoading('正在分析节点上下文...', [
        '正在确定逻辑门类型...',
        '正在生成子事件建议...',
        '正在评估置信度...'
      ]);
    }
    ftaData.metadata.aiCallCount++;

    let reasoningStreamActive = false;
    try {
      const rendered = renderPrompt('ftaNodeSuggestion', {
        topEvent: ftaData.topEvent.name,
        boundary: ftaData.topEvent.boundary || '未声明',
        currentNode: node.name,
        treePath: _getTreePath(_selectedNodeId)
      });
      let result;
      try {
        const { text: streamContent } = await callOpenAIStreaming(rendered.system, rendered.user, {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningStreamActive) {
              reasoningStreamActive = true;
              window.SidebarUI?.showReasoningStream('模型推理输出', 'ftaSuggestReasoningContent');
            }
            window.SidebarUI?.updateReasoningStream('ftaSuggestReasoningContent', fullText);
          }
        });
        result = parseAIJson(streamContent);
      } catch (streamErr) {
        if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') throw streamErr;
        console.warn('[FTA] aiSuggestChildren streaming failed, falling back:', streamErr.message);
        window.SidebarUI?.hideLoading();
        window.SidebarUI?.showLoading('正在以兼容模式生成建议...', null, true);
        result = await callAI(rendered.system, rendered.user, true);
      }
      if (!checkAiContext(_aiCtx, 'aiSuggestChildren-fta')) return;

      // 设置父节点门类型
      if (result.gateType && !node.gateType) {
        updateNode(_selectedNodeId, {
          gateType: result.gateType,
          gateReason: result.gateReason || ''
        });
      }

      // 添加子节点（status = ai-suggested，等待用户确认）
      const children = result.children || [];
      children.forEach((c) => {
        if (c.name && c.name.trim()) {
          addNode(_selectedNodeId, {
            name: c.name.trim(),
            type: c.type || 'intermediate',
            confidence: c.confidence || 0.7,
            status: 'ai-suggested'
          });
        }
      });

      saveFtaData(true);
      renderAll();

      // 侧边栏显示结果
      let html = '<div class="ai-block">';
      html += `<h4>逻辑门: ${esc(result.gateType || 'OR')}</h4>`;
      if (result.gateReason)
        html += `<p style="font-size:0.75rem;color:var(--text-muted);">${esc(result.gateReason)}</p>`;
      html += '<h4>建议的子事件</h4>';
      children.forEach((c) => {
        html += `<div class="ai-suggestion"><div class="text">${esc(c.name)}</div>`;
        if (c.reasoning)
          html += `<div class="reason" style="font-size:0.7rem;color:var(--text-muted);">${esc(c.reasoning)}</div>`;
        html += '</div>';
      });
      html +=
        '<p style="font-size:0.7rem;margin-top:12px;color:var(--text-muted);">💡 请在节点编辑器中逐个确认或删除 AI 建议的节点</p>';
      html += '</div>';
      _showFtaSidebar('AI 子事件建议', html);
      showToast(`已生成 ${children.length} 个子事件建议`, 'success');
    } catch (err) {
      const hint = esc(getApiErrorHint(err.message));
      _showFtaSidebar(
        'AI 子事件建议',
        `<div class="ai-block is-error"><h4>建议失败</h4><p>${esc(err.message)}</p><p style="color:var(--text-muted);font-size:0.75rem;margin-top:8px;">${hint}</p></div>`
      );
      showToast('AI 建议失败: ' + err.message, 'error');
    }
  }

  /** AI 全自动展开（自动驾驶模式）*/
  async function aiAutoExpand() {
    if (!ftaData.topEvent.name) {
      showToast('请先锁定顶事件', 'error');
      return;
    }
    if (Object.keys(ftaData.nodes).length > 1) {
      if (!(await showConfirm('AI 自动分析将替换现有树（顶事件除外），确定继续？', 'danger')))
        return;
      const rootNode = ftaData.nodes[ftaData.rootId];
      if (rootNode) {
        rootNode.children.slice().forEach((cid) => removeNode(cid));
        rootNode.children = [];
      }
    }

    // Fix H3: capture context before async AI call
    const _aiCtx = captureAiContext();
    showToast('AI 自动分析中...', 'info');
    if (window.SidebarUI) {
      window.SidebarUI.open('AI 自动分析');
      window.SidebarUI.showLoading('正在生成故障树...', [
        '正在分析顶事件与边界...',
        '正在递归展开中间事件...',
        '正在验证逻辑门完整性...'
      ]);
    }
    ftaData.metadata.mode = 'auto';
    ftaData.metadata.aiCallCount++;

    let reasoningStreamActive = false;
    try {
      const rendered = renderPrompt('ftaAutoExpand', {
        topEvent: ftaData.topEvent.name,
        boundary: ftaData.topEvent.boundary || '未声明',
        maxDepth: String(Math.min(Math.max(Number(ftaData.settings.maxDepth) || 5, 1), 10)),
        maxNodes: String(Math.min(Math.max(Number(ftaData.settings.maxNodes) || 50, 1), 100))
      });
      if (!rendered) {
        window.SidebarUI.hideLoading();
        showToast('AI 分析失败：prompt 模板 ftaAutoExpand 未找到', 'error');
        return;
      }
      let result;
      try {
        const { text: streamContent } = await callOpenAIStreaming(rendered.system, rendered.user, {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningStreamActive) {
              reasoningStreamActive = true;
              window.SidebarUI?.showReasoningStream('模型推理输出', 'ftaExpandReasoningContent');
            }
            window.SidebarUI?.updateReasoningStream('ftaExpandReasoningContent', fullText);
          }
        });
        result = parseAIJson(streamContent);
      } catch (streamErr) {
        if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') throw streamErr;
        console.warn('[FTA] aiAutoExpand streaming failed, falling back:', streamErr.message);
        window.SidebarUI?.hideLoading();
        window.SidebarUI?.showLoading('正在以兼容模式生成故障树...', null, true);
        result = await callAI(rendered.system, rendered.user, true);
      }
      if (!checkAiContext(_aiCtx, 'aiAutoExpand-fta')) return;

      if (result.tree) {
        // 递归导入 AI 生成的树
        _importAITree(result.tree, ftaData.rootId);
        saveFtaData(true);
        renderAll();
      }

      let html = '<div class="ai-block"><h4>自动生成完成</h4>';
      if (result.summary) html += `<p>${esc(result.summary)}</p>`;
      html += `<p>节点数: ${result.nodeCount || ftaData.metadata.nodeCount} | 最大深度: ${result.maxDepthReached || '?'}</p>`;
      if (result.warnings && result.warnings.length > 0) {
        html += '<h4>⚠️ 注意事项</h4><ul>';
        result.warnings.forEach((w) => {
          html += `<li>${esc(w)}</li>`;
        });
        html += '</ul>';
      }
      html +=
        '<p style="font-size:0.7rem;margin-top:12px;color:var(--text-muted);">💡 所有 AI 生成的节点标记为「AI生成」，请逐一审查确认</p>';
      html += '</div>';
      _showFtaSidebar('AI 自动分析', html);
      showToast('故障树自动生成完成', 'success');
    } catch (err) {
      const hint = esc(getApiErrorHint(err.message));
      _showFtaSidebar(
        'AI 自动分析',
        `<div class="ai-block is-error"><h4>生成失败</h4><p>${esc(err.message)}</p><p style="color:var(--text-muted);font-size:0.75rem;margin-top:8px;">${hint}</p></div>`
      );
      showToast('AI 生成失败: ' + err.message, 'error');
    }
  }

  function _importAITree(aiNode, parentId, level = 1) {
    if (level > 20) {
      console.warn('_importAITree: 导入树深度超过上限，已截断');
      return;
    }
    if (!aiNode || !aiNode.children) return;
    // P2-5: 导入前检查总节点数是否超限，超限则整体拒绝
    const totalPending = _countAINodes(aiNode);
    if (Object.keys(ftaData.nodes).length + totalPending > ftaData.settings.maxNodes) {
      showToast(
        'AI 返回节点数超过上限（' + ftaData.settings.maxNodes + '），已拒绝导入',
        'warning'
      );
      return;
    }
    // 更新父节点门类型
    const parent = ftaData.nodes[parentId];
    if (parent && aiNode.gateType) {
      parent.gateType = aiNode.gateType;
      parent.gateReason = aiNode.gateReason || '';
    }
    // 添加子节点
    aiNode.children.forEach((child) => {
      if (!child.name) return;
      const newNode = addNode(parentId, {
        name: child.name,
        type: child.type || 'intermediate',
        gateType: child.gateType || null,
        gateReason: child.gateReason || '',
        confidence: child.confidence || 0.7,
        status: 'auto-generated'
      });
      // 递归添加子节点
      if (child.children && child.children.length > 0) {
        _importAITree(child, newNode.id, level + 1);
      }
    });
  }

  /** 递归计算 AI 树节点总数 */
  function _countAINodes(aiNode) {
    if (!aiNode || !aiNode.children) return 0;
    let count = aiNode.children.length;
    aiNode.children.forEach((child) => {
      count += _countAINodes(child);
    });
    return count;
  }

  /** AI 查漏补缺扫描 */
  async function aiGapScan() {
    if (!ftaData.rootId || Object.keys(ftaData.nodes).length < 2) {
      showToast('请先构建故障树（至少 2 个节点）', 'error');
      return;
    }
    // Fix H3: capture context before async AI call
    const _aiCtx = captureAiContext();
    showToast('AI 查漏补缺扫描中...', 'info');
    if (window.SidebarUI) {
      window.SidebarUI.open('AI 查漏补缺');
      window.SidebarUI.showLoading('正在扫描故障树完整性...', [
        '正在评估各分支完整度...',
        '正在检查逻辑门...',
        '正在识别共因失效与遗漏...'
      ]);
    }
    ftaData.metadata.aiCallCount++;

    const _isFtaExample = window.isActiveProblemExample();

    let reasoningStreamActive = false;
    try {
      const rendered = renderPrompt('ftaGapScan', {
        topEvent: ftaData.topEvent.name,
        boundary: ftaData.topEvent.boundary || '未声明',
        treeText: renderAsciiTreeWithIds()
      });
      let result;
      try {
        const { text: streamContent } = await callOpenAIStreaming(rendered.system, rendered.user, {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningStreamActive) {
              reasoningStreamActive = true;
              window.SidebarUI?.showReasoningStream('模型推理输出', 'ftaGapReasoningContent');
            }
            window.SidebarUI?.updateReasoningStream('ftaGapReasoningContent', fullText);
          }
        });
        result = parseAIJson(streamContent);
      } catch (streamErr) {
        if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') throw streamErr;
        console.warn('[FTA] aiGapScan streaming failed, falling back:', streamErr.message);
        window.SidebarUI?.hideLoading();
        window.SidebarUI?.showLoading('正在以兼容模式扫描...', null, true);
        result = await callAI(rendered.system, rendered.user, true);
      }
      if (!checkAiContext(_aiCtx, 'aiGapScan-fta')) return;

      // ---- Parse corrections (validate but defer mutation) ----
      const deferredOps = [];
      const correctionSummary = [];

      // missingNodes
      if (Array.isArray(result.missingNodes)) {
        result.missingNodes.forEach((m) => {
          const parentNode = ftaData.nodes[m.parentId];
          if (!parentNode) {
            correctionSummary.push({ type: 'missingNode', name: m.name, success: false, reason: `父节点 ${m.parentId} 不存在` });
            return;
          }
          if (!m.name || !m.name.trim()) {
            correctionSummary.push({ type: 'missingNode', name: '(空)', success: false, reason: '节点名称为空' });
            return;
          }
          deferredOps.push({
            type: 'missingNode',
            parentId: m.parentId,
            name: m.name.trim(),
            nodeType: m.type || 'basic',
            gateType: m.gateType || null
          });
          correctionSummary.push({ type: 'missingNode', name: m.name.trim(), success: true, reason: m.reason });
        });
      }

      // gateCorrections
      if (Array.isArray(result.gateCorrections)) {
        result.gateCorrections.forEach((g) => {
          const node = ftaData.nodes[g.nodeId];
          if (!node) {
            correctionSummary.push({ type: 'gateCorrection', name: g.nodeName || g.nodeId, success: false, reason: `节点 ${g.nodeId} 不存在` });
            return;
          }
          if (node.gateType !== g.currentGate) {
            correctionSummary.push({ type: 'gateCorrection', name: g.nodeName || g.nodeId, success: false, reason: `当前门类型 ${node.gateType} 与预期 ${g.currentGate} 不符` });
            return;
          }
          deferredOps.push({
            type: 'gateCorrection',
            nodeId: g.nodeId,
            suggestedGate: g.suggestedGate
          });
          correctionSummary.push({ type: 'gateCorrection', name: g.nodeName || g.nodeId, success: true, reason: g.reason });
        });
      }

      // ---- Build sidebar ----
      let html = '<div class="ai-block">';

      const pending = correctionSummary.filter((s) => s.success);
      const skipped = correctionSummary.filter((s) => !s.success);

      if (pending.length > 0) {
        html += `<h4>AI 建议以下修正 (${pending.length} 项)</h4>`;
        pending.forEach((s) => {
          const icon = s.type === 'missingNode' ? '+' : '↻';
          const borderColor = s.type === 'missingNode' ? 'var(--primary)' : 'var(--orange)';
          html += `<div class="ai-suggestion" style="border-left:3px solid ${borderColor};">`;
          html += `<div class="text">${icon} ${esc(s.name)}</div>`;
          if (s.reason) html += `<div class="reason" style="font-size:0.7rem;color:var(--text-muted);">${esc(s.reason)}</div>`;
          html += `</div>`;
        });
        if (!_isFtaExample) {
          html += `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px;">`;
          html += `<button type="button" class="btn btn-primary btn-sm" id="ftaApplyCorrections" style="width:100%;">`;
          html += `✓ 应用以上 ${pending.length} 项修正</button>`;
          html += `</div>`;
        }
      }

      if (skipped.length > 0) {
        html += `<h4 style="color:var(--text-muted);margin-top:12px;">跳过 (${skipped.length} 项)</h4>`;
        skipped.forEach((s) => {
          html += `<div class="ai-suggestion" style="opacity:0.6;">`;
          html += `<div class="text">${esc(s.name)} — ${esc(s.reason)}</div>`;
          html += `</div>`;
        });
      }

      // 整体完整度
      if (result.overallCompleteness) {
        const compClass =
          result.overallCompleteness === 'high'
            ? 'high'
            : result.overallCompleteness === 'medium'
              ? 'medium'
              : 'low';
        html += `<h4>整体完整度: <span class="confidence-badge ${compClass}">${Math.round((result.overallScore || 0) * 100)}%</span></h4>`;
      }

      // 分支评估
      if (result.branchAssessments && result.branchAssessments.length > 0) {
        html += '<h4>分支评估</h4>';
        result.branchAssessments.forEach((b) => {
          const bClass =
            b.completeness === 'high' ? 'high' : b.completeness === 'medium' ? 'medium' : 'low';
          html += `<div class="ai-suggestion" style="margin-bottom:8px;"><div class="text"><strong>${esc(b.branchName)}</strong> <span class="confidence-badge ${bClass}">${Math.round((b.score || 0) * 100)}%</span></div>`;
          if (b.missingModes && b.missingModes.length > 0) {
            html +=
              '<div class="reason" style="font-size:0.7rem;color:var(--orange-dark);">遗漏: ' +
              b.missingModes.map((m) => esc(m)).join('、') +
              '</div>';
          }
          if (b.notes)
            html += `<div class="reason" style="font-size:0.7rem;color:var(--text-muted);">${esc(b.notes)}</div>`;
          html += '</div>';
        });
      }

      // 逻辑门问题
      if (result.gateIssues && result.gateIssues.length > 0) {
        html += '<h4>逻辑门问题</h4>';
        result.gateIssues.forEach((g) => {
          html += `<div class="ai-suggestion"><div class="text">${esc(g.node)}: ${esc(g.issue)}</div>`;
          if (g.suggestion)
            html += `<div class="reason" style="font-size:0.7rem;">${esc(g.suggestion)}</div>`;
          html += '</div>';
        });
      }

      // 共因失效
      if (result.commonCauses && result.commonCauses.length > 0) {
        html += '<h4>⚠️ 共因失效风险</h4><ul>';
        result.commonCauses.forEach((c) => {
          html += `<li>${esc(c)}</li>`;
        });
        html += '</ul>';
      }

      // 改进建议
      if (result.recommendations && result.recommendations.length > 0) {
        html += '<h4>改进建议</h4><ul>';
        result.recommendations.forEach((r) => {
          html += `<li>${esc(r)}</li>`;
        });
        html += '</ul>';
      }

      html += '</div>';
      _showFtaSidebar('AI 查漏补缺', html);

      // Bind apply button
      if (pending.length > 0 && !_isFtaExample) {
        const applyBtn = document.getElementById('ftaApplyCorrections');
        if (applyBtn) {
          let correctionsApplied = false;
          applyBtn.addEventListener('click', () => {
            if (correctionsApplied) return;
            correctionsApplied = true;
            applyBtn.disabled = true;
            applyBtn.textContent = '正在应用...';
            const nodesPreSnapshot = JSON.parse(JSON.stringify(ftaData.nodes));

            deferredOps.forEach((op) => {
              if (op.type === 'missingNode') {
                addNode(op.parentId, {
                  name: op.name,
                  type: op.nodeType,
                  gateType: op.gateType,
                  confidence: 0.8,
                  status: 'ai-suggested'
                });
              } else if (op.type === 'gateCorrection') {
                updateNode(op.nodeId, { gateType: op.suggestedGate });
              }
            });

            saveFtaData(true);
            renderAll();

            // Replace sidebar content with post-apply state
            let postHtml = `<div class="ai-block" style="border-color:var(--green-border);">`;
            postHtml += `<h4>✓ 已应用 (${pending.length} 项)</h4>`;
            pending.forEach((s) => {
              const icon = s.type === 'missingNode' ? '+' : '↻';
              postHtml += `<div class="ai-suggestion" style="border-left:3px solid var(--green);">`;
              postHtml += `<div class="text">${icon} ${esc(s.name)}</div>`;
              if (s.reason) postHtml += `<div class="reason" style="font-size:0.7rem;color:var(--text-muted);">${esc(s.reason)}</div>`;
              postHtml += `</div>`;
            });
            postHtml += `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px;">`;
            postHtml += `<button type="button" class="btn btn-outline btn-sm" id="ftaRollbackCorrections" style="width:100%;">↩ 回滚本次全部修正</button>`;
            postHtml += `</div>`;
            postHtml += `<div style="margin-top:8px;font-size:0.7rem;color:var(--text-muted);">💡 请在节点编辑器中审查 AI 添加的节点</div>`;
            postHtml += `</div>`;

            const sidebarContent = document.getElementById('aiContent');
            if (sidebarContent) {
              const existingBlocks = sidebarContent.querySelectorAll('.ai-block');
              if (existingBlocks.length > 0) {
                existingBlocks[0].outerHTML = postHtml;
              }
            }

            // Bind rollback
            const rollbackBtn = document.getElementById('ftaRollbackCorrections');
            if (rollbackBtn) {
              rollbackBtn.addEventListener('click', () => {
                ftaData.nodes = JSON.parse(JSON.stringify(nodesPreSnapshot));
                saveFtaData(true);
                renderAll();
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
        ? '查漏补缺完成，请审阅 AI 建议的修正'
        : '查漏补缺完成';
      showToast(toastMsg, 'success');
    } catch (err) {
      const hint = esc(getApiErrorHint(err.message));
      _showFtaSidebar(
        'AI 查漏补缺',
        `<div class="ai-block is-error"><h4>扫描失败</h4><p>${esc(err.message)}</p><p style="color:var(--text-muted);font-size:0.75rem;margin-top:8px;">${hint}</p></div>`
      );
      showToast('AI 扫描失败: ' + err.message, 'error');
    }
  }

  // ===== 分析引擎（Phase 3）=====

  const CUT_SET_LIMIT = 10000;

  /**
   * MOCUS 最小割集算法
   * 从顶事件开始，通过 AND/OR 门递归展开求所有最小割集
   * @returns {string[][]} 割集数组，每个割集是底事件 ID 数组
   */
  function computeMinCutSets() {
    if (!ftaData.rootId) return [];
    return _expandNode(ftaData.rootId);
  }

  function _expandNode(nodeId) {
    const node = ftaData.nodes[nodeId];
    if (!node) return [[nodeId]];

    // 底事件或无子节点：返回单元素割集
    if (node.children.length === 0 || node.type === 'basic' || node.type === 'undeveloped') {
      return [[nodeId]];
    }

    // 递归展开子节点
    const childSets = node.children.map((cid) => _expandNode(cid));

    if (node.gateType === 'OR') {
      // OR 门：合并所有子节点的割集（并集）
      let result = [];
      childSets.forEach((sets) => {
        result = result.concat(sets);
      });
      if (result.length > CUT_SET_LIMIT) {
        throw new Error(
          `割集数量超过上限 (${CUT_SET_LIMIT})，计算终止以防止浏览器卡死。请检查故障树逻辑结构。`
        );
      }
      return _removeSupersets(result);
    } else if (node.gateType === 'AND') {
      // AND 门：对所有子节点的割集做笛卡尔积
      let result = childSets[0] || [[]];
      for (let i = 1; i < childSets.length; i++) {
        result = _cartesianProduct(result, childSets[i]);
      }
      return _removeSupersets(result);
    }
    // 无门类型，视为单元素
    return [[nodeId]];
  }

  function _cartesianProduct(setsA, setsB) {
    if (setsA.length * setsB.length > CUT_SET_LIMIT) {
      throw new Error(
        `笛卡尔积的可能割集数 (${setsA.length * setsB.length}) 超过安全上限 (${CUT_SET_LIMIT})，计算终止以防止浏览器卡死。`
      );
    }
    const result = [];
    setsA.forEach((a) => {
      setsB.forEach((b) => {
        // 合并并去重
        const merged = [...new Set([...a, ...b])];
        result.push(merged);
      });
    });
    return result;
  }

  function _removeSupersets(sets) {
    const sorted = sets.slice().sort((a, b) => a.length - b.length);
    const minimal = [];
    for (const s of sorted) {
      const isSuperset = minimal.some((m) => m.every((e) => s.includes(e)));
      if (!isSuperset) minimal.push(s);
    }
    return minimal;
  }

  /**
   * IEC 61025 规则校验引擎
   * 检查故障树的结构合规性
   * @returns {{ errors: Array, warnings: Array, score: number }}
   */
  function validateTree() {
    const errors = [];
    const warnings = [];
    const ids = Object.keys(ftaData.nodes);

    if (ids.length === 0) return { errors: ['故障树为空'], warnings: [], score: 0 };

    ids.forEach((id) => {
      const node = ftaData.nodes[id];

      // R1: 中间事件必须有逻辑门
      if (node.type === 'intermediate' && node.children.length > 0 && !node.gateType) {
        errors.push({
          nodeId: id,
          rule: 'R1',
          msg: `中间事件「${node.name}」有子节点但未指定逻辑门(AND/OR)`
        });
      }

      // R2: 逻辑门至少需要 2 个输入
      if (node.gateType && node.children.length < 2) {
        warnings.push({
          nodeId: id,
          rule: 'R2',
          msg: `「${node.name}」的 ${node.gateType} 门只有 ${node.children.length} 个输入（建议≥2）`
        });
      }

      // R3: 底事件不应有子节点
      if (node.type === 'basic' && node.children.length > 0) {
        errors.push({ nodeId: id, rule: 'R3', msg: `底事件「${node.name}」不应有子节点` });
      }

      // R4: 节点必须有名称
      if (!node.name || !node.name.trim()) {
        errors.push({ nodeId: id, rule: 'R4', msg: `节点 ${id} 缺少名称` });
      }

      // R5: 中间事件不应是叶子节点（应进一步分解或标记为 undeveloped）
      if (node.type === 'intermediate' && node.children.length === 0) {
        warnings.push({
          nodeId: id,
          rule: 'R5',
          msg: `中间事件「${node.name}」未展开，建议添加子事件或标记为“待展开”`
        });
      }

      // R6: 深度检查
      const depth = _getNodeDepth(id);
      if (depth > ftaData.settings.maxDepth) {
        warnings.push({
          nodeId: id,
          rule: 'R6',
          msg: `「${node.name}」深度(${depth})超过限制(${ftaData.settings.maxDepth})`
        });
      }
    });

    // R7: 循环检测
    if (ftaData.rootId && _detectCycle(ftaData.rootId)) {
      errors.push({
        nodeId: ftaData.rootId,
        rule: 'R7',
        msg: '检测到循环引用，故障树必须是无环图'
      });
    }

    // 计分：每个 error 扣 15 分，每个 warning 扣 5 分
    const maxScore = 100;
    const score = Math.max(0, maxScore - errors.length * 15 - warnings.length * 5);

    return { errors, warnings, score };
  }

  /**
   * 运行完整分析：最小割集 + 规则校验
   * 结果展示在侧边栏
   */
  function runAnalysis() {
    if (!ftaData.rootId || Object.keys(ftaData.nodes).length < 3) {
      showToast('故障树至少需要 3 个节点才能分析', 'error');
      return;
    }

    // 1. 规则校验
    const validation = validateTree();

    // 2. 最小割集
    let cutSets = [];
    let computationError = null;
    if (validation.errors.length === 0) {
      try {
        cutSets = computeMinCutSets();
      } catch (err) {
        computationError = err.message;
      }
    }

    // 3. 渲染结果
    let html = '<div class="ai-block">';

    // 校验得分
    const scoreClass = validation.score >= 80 ? 'high' : validation.score >= 50 ? 'medium' : 'low';
    html += `<h4>规则校验: <span class="confidence-badge ${scoreClass}">${validation.score}/100</span></h4>`;

    // 错误
    if (validation.errors.length > 0) {
      html +=
        '<div style="margin:8px 0;"><strong style="color:var(--red);">\u274c 错误 (' +
        validation.errors.length +
        ')</strong></div>';
      validation.errors.forEach((e) => {
        html += `<div class="ai-suggestion" style="border-left:3px solid var(--red);margin-bottom:4px;"><div class="text" style="font-size:0.8rem;">[${e.rule}] ${esc(e.msg)}</div></div>`;
      });
    }

    // 警告
    if (validation.warnings.length > 0) {
      html +=
        '<div style="margin:8px 0;"><strong style="color:var(--orange);">\u26a0\ufe0f 警告 (' +
        validation.warnings.length +
        ')</strong></div>';
      validation.warnings.forEach((w) => {
        html += `<div class="ai-suggestion" style="border-left:3px solid var(--orange);margin-bottom:4px;"><div class="text" style="font-size:0.8rem;">[${w.rule}] ${esc(w.msg)}</div></div>`;
      });
    }

    if (validation.errors.length === 0 && validation.warnings.length === 0) {
      html += '<p>\u2705 未发现结构问题</p>';
    }

    // 最小割集
    if (computationError) {
      html += `<h4 style="margin-top:16px;color:var(--red);">最小割集计算中断</h4>`;
      html += `<div style="margin:8px 0;padding:8px;background:var(--red-light);border-left:3px solid var(--red);border-radius:var(--radius);font-size:0.8rem;color:var(--red);">⚠️ ${esc(computationError)}</div>`;
    } else if (cutSets.length > 0) {
      html += `<h4 style="margin-top:16px;">最小割集 (${cutSets.length} 个)</h4>`;
      html +=
        '<p style="font-size:0.7rem;color:var(--text-muted);margin-bottom:8px;">每个割集中的所有底事件同时发生即可导致顶事件</p>';
      cutSets.forEach((cs, i) => {
        const names = cs.map((id) => {
          const n = ftaData.nodes[id];
          return n ? n.name : id;
        });
        const csClass = cs.length === 1 ? 'color:var(--red);font-weight:600;' : '';
        html += `<div class="ai-suggestion" style="margin-bottom:4px;${cs.length === 1 ? 'border-left:3px solid var(--red);' : ''}">`;
        html += `<div class="text" style="font-size:0.8rem;${csClass}">`;
        html += `割集 ${i + 1} (${cs.length} 阶): ${names.map((n) => esc(n)).join(' \u2227 ')}`;
        html += '</div></div>';
      });

      // 关键底事件统计
      const freq = {};
      cutSets.forEach((cs) =>
        cs.forEach((id) => {
          freq[id] = (freq[id] || 0) + 1;
        })
      );
      const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) {
        html += '<h4 style="margin-top:12px;">关键底事件排序</h4>';
        html +=
          '<p style="font-size:0.7rem;color:var(--text-muted);margin-bottom:8px;">出现在越多割集中的底事件越关键</p>';
        sorted.slice(0, 10).forEach(([id, count]) => {
          const n = ftaData.nodes[id];
          const pct = Math.round((count / cutSets.length) * 100);
          html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:0.8rem;">`;
          html += `<span style="min-width:120px;">${esc(n ? n.name : id)}</span>`;
          html += `<div style="flex:1;height:6px;background:var(--bg-hover);border-radius:var(--radius-sm);"><div style="width:${pct}%;height:100%;background:var(--primary);border-radius:var(--radius-sm);"></div></div>`;
          html += `<span style="min-width:50px;text-align:right;">${count}/${cutSets.length}</span>`;
          html += '</div>';
        });
      }

      // 单点故障警告
      const singlePoints = cutSets.filter((cs) => cs.length === 1);
      if (singlePoints.length > 0) {
        html +=
          '<div style="margin-top:12px;padding:8px;background:var(--red-light);border-radius:var(--radius);border-left:3px solid var(--red);">';
        html +=
          '<strong style="color:var(--red);">⚠\ufe0f 单点故障 (' +
          singlePoints.length +
          ' 个)</strong>';
        html +=
          '<p style="font-size:0.75rem;margin-top:4px;">以下底事件单独即可导致顶事件，应优先加固：</p>';
        singlePoints.forEach((cs) => {
          const n = ftaData.nodes[cs[0]];
          html += `<div style="font-size:0.8rem;padding:2px 0;">• ${esc(n ? n.name : cs[0])}</div>`;
        });
        html += '</div>';
      }
    } else if (validation.errors.length > 0) {
      html +=
        '<p style="margin-top:12px;font-size:0.8rem;color:var(--text-muted);">请先修复上述错误后再计算最小割集</p>';
    }

    html += '</div>';
    _showFtaSidebar('故障树分析结果', html);
    showToast('分析完成', 'success');
  }

  // ===== 报告生成（Phase 4）=====

  let _ftaReportMarkdown = '';

  async function generateReport() {
    const _ftaReportStart = Date.now();
    let reportSourceMode = 'ai';
    if (!ftaData.rootId || Object.keys(ftaData.nodes).length < 3) {
      showToast('故障树至少需要 3 个节点才能生成报告', 'error');
      return;
    }

    // Capture context/variables at call-time (the very beginning) to prevent race conditions
    const _ftaPid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
    const _topEventName = ftaData.topEvent.name || '故障树分析';
    const _topEventBoundary = ftaData.topEvent.boundary || '未声明';
    const _asciiTreeText = renderAsciiTree();

    // 捕获 FTA SVG 图形快照（重置 viewBox 至全树视图，恢复后不影响交互缩放）
    let ftaSvgHtml = '';
    const ftaSvgEl = document.querySelector('#ftaGraphicWrapper svg');
    if (ftaSvgEl) {
      const _origViewBox = ftaSvgEl.getAttribute('viewBox');
      const _origStyle = ftaSvgEl.getAttribute('style') || '';
      ftaSvgEl.setAttribute(
        'viewBox',
        '0 0 ' + (ftaSvgEl.getAttribute('data-fta-w') || '800') + ' ' + (ftaSvgEl.getAttribute('data-fta-h') || '400')
      );
      ftaSvgEl.setAttribute(
        'style',
        _origStyle + ';max-width:100%;height:auto;cursor:default;'
      );
      ftaSvgHtml = window.UIUtils.resolveSvgCssVars(
        new XMLSerializer().serializeToString(ftaSvgEl)
      );
      ftaSvgEl.setAttribute('viewBox', _origViewBox);
      ftaSvgEl.setAttribute('style', _origStyle);
    }
    const _allNodes = Object.values(ftaData.nodes || {});
    const _nodeCount = _allNodes.length;
    const _confirmedCount = _allNodes.filter((n) => n.status === 'confirmed').length;
    const _aiCallCount = ftaData.metadata.aiCallCount;
    const _analysisMode = ftaData.metadata.mode;

    const validation = validateTree();
    let cutSets = [];
    let cutSetsText = '无（存在校验错误）';
    let importanceText = '无（存在校验错误）';
    if (validation.errors.length === 0) {
      try {
        cutSets = computeMinCutSets();
        if (cutSets.length > 0) {
          cutSetsText = cutSets
            .map((cs, i) => {
              const names = cs.map((id) => {
                const n = ftaData.nodes[id];
                return n ? n.name : id;
              });
              return `割集${i + 1} (阶数${cs.length}): ${names.join(' AND ')}`;
            })
            .join('\n');
        } else {
          cutSetsText = '未识别到最小割集。';
        }
        importanceText = _buildStructuralImportanceText(cutSets, ftaData.nodes);
      } catch (err) {
        cutSetsText = `计算失败: ${err.message}`;
      }
    }

    // 格式化校验文本
    let validationText = `得分: ${validation.score}/100\n`;
    validationText += `错误: ${validation.errors.length}\n`;
    validationText += `警告: ${validation.warnings.length}`;

    showToast('FTA 报告生成中...', 'info');
    if (window.SidebarUI) {
      window.SidebarUI.open('FTA 报告生成');
      window.SidebarUI.showLoading('正在生成分析报告...', [
        '正在整理故障树结构...',
        '正在计算最小割集...',
        '正在生成分析与建议...'
      ]);
    }

    try {
      const rendered = renderPrompt('ftaReport', {
        topEvent: _topEventName,
        boundary: _topEventBoundary,
        treeText: _asciiTreeText,
        cutSets: cutSetsText,
        importance: importanceText,
        validation: validationText,
        today: new Date().toISOString().slice(0, 10)
      });
      let reasoningShown = false;
      try {
        const streamed = await callOpenAIStreaming(rendered.system, rendered.user, {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningShown && window.SidebarUI) {
              reasoningShown = true;
              window.SidebarUI.showReasoningStream('模型正在生成 FTA 分析报告', 'ftaReportReasoningContent');
            }
            window.SidebarUI?.updateReasoningStream('ftaReportReasoningContent', fullText);
          }
        }, 8192, false);
        _ftaReportMarkdown = streamed.text;
        if (!_ftaReportMarkdown.trim()) throw new Error('流式响应未返回报告正文');
      } catch (streamErr) {
        if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') {
          throw streamErr;
        }
        console.warn('[FTA] Report streaming failed, falling back:', streamErr.message);
        if (window.SidebarUI) {
          window.SidebarUI.showLoading('正在以兼容模式生成 FTA 分析报告...', [
            '正在请求完整报告...',
            '正在校验报告结构...',
            '即将完成...'
          ], true);
        }
        const result = await callAI(rendered.system, rendered.user, false);
        _ftaReportMarkdown = typeof result === 'string' ? result : JSON.stringify(result);
      }
      const reportValidation = window.ReportContract.validateAiReport(_ftaReportMarkdown, 'fta');
      if (!reportValidation.valid) {
        throw new Error('AI 报告缺少必需章节：' + reportValidation.missing.join('、'));
      }

      // Prefix with problem ID and title if exists
      if (_ftaPid && typeof getProblemById === 'function') {
        const p = getProblemById(_ftaPid);
        if (p) {
          let header = '';
          if (p.displayId) header += `**问题编号：** ${p.displayId}\n\n`;
          if (p.title) header += `**问题标题：** ${p.title}\n\n`;
          if (header) _ftaReportMarkdown = `${header}\n${_ftaReportMarkdown}`;
        }
      }

      const _model = typeof getActiveModel === 'function' ? getActiveModel() : '';
      const elapsedSecs = ((Date.now() - _ftaReportStart) / 1000).toFixed(1);
      const usage = window._lastAiUsage;
      _ftaReportMarkdown += window.ReportContract.buildMetadata({
        sourceMode: 'ai',
        model: _model,
        usage,
        elapsedSeconds: elapsedSecs
      });
      _ftaReportMarkdown = window.ReportContract.appendAnalysisStatistics(_ftaReportMarkdown, {
        nodeCount: _nodeCount,
        sourceMode: 'ai',
        metrics: [
          ['已确认节点数', _confirmedCount],
          ['最小割集数', cutSets.length],
          ['规则校验得分', `${validation.score}/100`]
        ]
      });
    } catch (err) {
      if (window.SidebarUI) window.SidebarUI.hideLoading();
      // 降级为本地报告
      reportSourceMode = 'local';
      _ftaReportMarkdown = _generateLocalReport(validation, cutSets, {
        problemId: _ftaPid,
        topEventName: _topEventName,
        topEventBoundary: _topEventBoundary,
        asciiTreeText: _asciiTreeText,
        nodeCount: _nodeCount,
        confirmedCount: _confirmedCount,
        aiCallCount: _aiCallCount,
        analysisMode: _analysisMode,
        nodesMap: JSON.parse(JSON.stringify(ftaData.nodes))
      });
      showToast('AI 不可用，已生成本地报告', 'info');
    }

    // 保存到报告库并获取报告ID
    let savedReport = null;
    if (typeof saveReportToLibrary === 'function') {
      savedReport = await saveReportToLibrary(_ftaReportMarkdown, {
        title: '[FTA] ' + _topEventName,
        analysisType: 'fta',
        sourceMode: reportSourceMode,
        ftaSvgHtml: ftaSvgHtml,
        problemId: _ftaPid,
        problemStatement: _topEventName,
        nodeCount: _nodeCount,
        rootCauseCount: _confirmedCount
      });
      if (typeof markAnalysisCompleted === 'function') markAnalysisCompleted('fta', _ftaPid);
    }

    // 导航到报告管理页面并打开报告
    if (savedReport && savedReport.id) {
      // 刷新报告库页面
      if (typeof renderReportLibrary === 'function') renderReportLibrary();

      if (window.SidebarUI) {
        window.SidebarUI.hideLoading();
        if (typeof _showAiCompletion === 'function') {
          _showAiCompletion(Date.now() - _ftaReportStart, window._lastAiUsage);
        }
      }

      window.scheduleRedirect({
        seconds: 6,
        onNavigate: function () {
          if (window.SidebarUI) window.SidebarUI.close();
          if (typeof showReportDetail === 'function') {
            showReportDetail(savedReport.id);
          }
        }
      });

      showToast('报告已生成并保存到报告库', 'success');
    } else {
      // Fix F: distinguish between missing API and actual save failure
      if (typeof saveReportToLibrary !== 'function') {
        showToast('报告库未加载，无法保存报告', 'error');
      } else {
        showToast('报告保存失败（可能存储空间不足），报告内容已生成，可手动复制', 'error');
        // Surface the raw markdown so user can copy it manually
        console.warn('[FTA] Report save failed. Markdown content:\n', _ftaReportMarkdown);
      }
    }
  }

  function _viewFtaReport() {
    const pid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
    const reports = typeof getReportLibrary === 'function' ? getReportLibrary() : [];
    const report = pid
      ? reports.find((r) => r.problemId === pid && r.analysisType === 'fta')
      : null;
    if (!report) {
      showToast('暂无故障树报告', 'info');
      return;
    }
    if (typeof navigateTo === 'function') {
      navigateTo('page-report-library');
      setTimeout(() => {
        if (typeof showReportDetail === 'function') showReportDetail(report.id);
      }, 200);
    }
  }

  function _buildStructuralImportanceText(cutSets, nodes) {
    if (!Array.isArray(cutSets) || cutSets.length === 0) {
      return '未识别到可用于结构重要度计算的最小割集。';
    }
    const appearances = new Map();
    cutSets.forEach((cutSet) => {
      cutSet.forEach((id) => appearances.set(id, (appearances.get(id) || 0) + 1));
    });
    return [...appearances.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
      .map(([id, count], index) => {
        const node = nodes && nodes[id];
        const ratio = ((count / cutSets.length) * 100).toFixed(1);
        return `${index + 1}. ${node ? node.name : id}: 出现在 ${count}/${cutSets.length} 个最小割集中（${ratio}%）`;
      })
      .join('\n');
  }

  function _generateLocalReport(validation, cutSets, ctx) {
    const now = new Date().toLocaleDateString('zh-CN');
    let md = `# FTA 故障树分析报告\n\n`;

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

    const topEventName = ctx ? ctx.topEventName : ftaData.topEvent.name;
    const topEventBoundary = ctx ? ctx.topEventBoundary : ftaData.topEvent.boundary;
    const asciiTreeText = ctx ? ctx.asciiTreeText : renderAsciiTree();

    md += `**日期**: ${now}\n\n`;
    md += `## 1. 问题概述\n\n`;
    md += `**问题现象：** ${topEventName}\n\n`;
    md += `## 2. 顶事件与系统边界\n\n`;
    md += `**顶事件**: ${topEventName}\n\n`;
    if (topEventBoundary) md += `**系统边界**: ${topEventBoundary}\n\n`;
    md += `## 3. 故障树结构摘要\n\n`;
    md += '```\n' + asciiTreeText + '\n```\n\n';
    md += `### 规则校验\n\n`;
    md += `得分: **${validation.score}/100**\n\n`;
    if (validation.errors.length > 0) {
      md += `### 错误\n`;
      validation.errors.forEach((e) => {
        md += `- [${e.rule}] ${e.msg}\n`;
      });
      md += '\n';
    }
    if (validation.warnings.length > 0) {
      md += `### 警告\n`;
      validation.warnings.forEach((w) => {
        md += `- [${w.rule}] ${w.msg}\n`;
      });
      md += '\n';
    }
    md += `## 4. 最小割集分析\n\n`;
    if (cutSets.length > 0) {
      cutSets.forEach((cs, i) => {
        const names = cs.map((id) => {
          const n = ctx ? ctx.nodesMap[id] : ftaData.nodes[id];
          return n ? n.name : id;
        });
        md +=
          `${i + 1}. ${names.join(' AND ')}` + (cs.length === 1 ? ' **[单点故障]**' : '') + '\n';
      });
      md += '\n';
    } else {
      md += `未识别到最小割集，无法进行割集组合与单点故障分析。\n\n`;
    }

    const nodesMap = ctx ? ctx.nodesMap : ftaData.nodes;
    md += `## 5. 关键底事件重要性排序\n\n`;
    md += _buildStructuralImportanceText(cutSets, nodesMap) + '\n\n';

    const nodeCount = ctx ? ctx.nodeCount : ftaData.metadata.nodeCount;
    const confirmedCount = ctx ? ctx.confirmedCount : ftaData.metadata.confirmedCount;
    const aiCallCount = ctx ? ctx.aiCallCount : ftaData.metadata.aiCallCount;
    const analysisMode = ctx ? ctx.analysisMode : ftaData.metadata.mode;
    const sourceMode = (ctx && ctx.sourceMode) || 'local';

    md += window.ReportContract.buildCapaSection({
      heading: '## 6. 纠正与预防措施 (CAPA)',
      dueDate: now,
      introduction: '本报告为本地结构化降级报告。请针对最小割集和单点故障制定可验证的闭环措施。'
    });
    md += `\n## 7. 后续行动项\n\n`;
    md += window.ReportContract.buildActionItem('确认最小割集的责任人与验证计划', now);

    md += '\n' + window.ReportContract.buildAnalysisStatistics({
      nodeCount,
      sourceMode,
      metrics: [
        ['已确认节点数', confirmedCount],
        ['最小割集数', cutSets.length],
        ['规则校验得分', `${validation.score}/100`],
        ['AI 调用次数', aiCallCount],
        ['分析模式', analysisMode === 'auto' ? '自动' : '引导']
      ]
    });

    const startTime = typeof window !== 'undefined' ? window.analysisStartTime : null;
    const duration = startTime
      ? Math.round((Date.now() - new Date(startTime).getTime()) / 60000)
      : '?';
    md += window.ReportContract.buildMetadata({ sourceMode, durationMinutes: duration });

    return md;
  }

  // ===== 初始化 =====

  function init() {
    loadFtaData().then(() => bindEvents());
  }

  // 注册页面钩子：进入 FTA Tab 时渲染
  if (window.registerPageHook) {
    registerPageHook('page-analysis', () => {
      // 仅当 FTA panel 可见时渲染
      const panel = document.getElementById('tool-fta');
      if (panel && !panel.classList.contains('hidden')) {
        renderAll();
      }
    });
  }

  // ===== 暴露 API =====
  window.FTA = {
    init: init,
    getData: () => ftaData,
    renderAll: renderAll,
    renderAsciiTree: renderAsciiTree,
    renderAsciiTreeHtml: renderAsciiTreeHtml,
    renderHtmlTree: renderHtmlTree,
    addNode: addNode,
    removeNode: removeNode,
    updateNode: updateNode,
    getNode: getNode,
    save: saveFtaData,
    load: loadFtaData,
    clear: clearFtaData,
    importData: importData,
    bindEvents: bindEvents,
    aiCheckTopEvent: aiCheckTopEvent,
    aiSuggestChildren: aiSuggestChildren,
    aiAutoExpand: aiAutoExpand,
    aiGapScan: aiGapScan,
    computeMinCutSets: computeMinCutSets,
    validateTree: validateTree,
    runAnalysis: runAnalysis,
    generateReport: generateReport,
    generateLocalReport: _generateLocalReport
  };
})();
