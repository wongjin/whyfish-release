/**
 * problem-manager.js — 问题管理模块（v3.0）
 *
 * 职责：问题描述、状态 Gap、AI 评估、工具推荐
 * 依赖：store.js, config.js, ai.js
 * 被依赖：app.js
 *
 * v3.0 变更：
 * - 移除内部 localStorage 自动持久化，数据管理统一由 store.js 负责
 * - 新增 Facade 接口：load(data), getData(), getAssessment()
 * - evaluate() 不再自动保存，改为返回评估结果
 */
(function () {
  'use strict';

  // C-08: 动态获取 Labels 避免脚本加载顺序或网络错误导致崩溃
  const Labels = new Proxy(
    {},
    {
      get(target, prop) {
        return (window.Labels && window.Labels[prop]) || {};
      }
    }
  );

  // C-09: 动态检测并安全调用 callAI 和 assertApiReady
  const _callAI = (sys, user, json, maxTokens) => {
    if (typeof window.callAI === 'function') {
      return window.callAI(sys, user, json, maxTokens);
    }
    if (typeof callAI === 'function') {
      return callAI(sys, user, json, maxTokens);
    }
    throw new Error('AI API 调用模块未就绪，请稍后重试');
  };

  const _assertApiReady = () => {
    if (typeof window.assertApiReady === 'function') {
      return window.assertApiReady();
    }
    if (typeof assertApiReady === 'function') {
      return assertApiReady();
    }
    return true;
  };

  /** 当前评估结果（不持久化，由调用方决定是否保存） */
  let _assessment = null;
  let _reportVisible = false;
  let _pendingAssessmentReview = null;
  let _lastAssessmentApplication = null;

  let isEvaluating = false;

  const ASSESSMENT_METHODS = ['5-why', 'fishbone', 'fta', 'none'];
  const ASSESSMENT_SUPPLEMENTARY_TOOLS = [
    '5w2h',
    'cause-verification'
  ];
  const ASSESSMENT_FORM_FIELDS = {
    title: { id: 'pm-problem-title', label: '问题标题' },
    severity: { id: 'pm-severity', label: '严重度', values: ['minor', 'major', 'critical'] },
    time: { id: 'pm-problem-time', label: '发生时间' },
    discoverySource: {
      id: 'pm-discovery-source',
      label: '发现方式',
      values: [
        'customer-complaint',
        'incoming-inspection',
        'in-process',
        'final-inspection',
        'internal-audit',
        'external-audit',
        'other'
      ]
    },
    expectedState: { id: 'pm-expected-state', label: '期望值' },
    expectedSource: {
      id: 'pm-expected-source',
      label: '期望值来源',
      values: ['regulation', 'customer', 'internal', 'design', 'historical', 'benchmark', 'other']
    },
    expectedDetail: { id: 'pm-expected-detail', label: '来源详情' },
    trend: { id: 'pm-trend', label: '问题趋势', values: ['sudden', 'gradual', 'intermittent'] },
    containment: { id: 'pm-containment', label: '临时措施' }
  };

  function _score(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 1;
  }

  function _text(value, fallback = '') {
    return typeof value === 'string' ? value.trim() : fallback;
  }

  function _list(value, max = 20) {
    return Array.isArray(value) ? value.slice(0, max) : [];
  }

  function _reasonIncorrectlyClaimsMissingTitle(reason) {
    return /(?:原|当前|问题)?标题.{0,8}(?:为空|空白|缺失|未填|未提供)/.test(_text(reason));
  }

  function _normalizeScoreItem(value) {
    const item = value && typeof value === 'object' ? value : {};
    return {
      score: _score(item.score),
      reason: _text(item.reason || item.note, '未提供评分依据'),
      improvement: _text(item.improvement)
    };
  }

  function _legacyClassificationLabel(classification) {
    if (!classification) return '';
    if (typeof classification === 'string') return classification;
    const labels = {
      occurrencePattern: {
        sporadic: '偶发',
        recurrent: '反复发生',
        systemic: '系统性',
        unknown: '待确认'
      },
      problemNature: {
        execution: '执行',
        process: '流程',
        design: '设计',
        equipment: '设备',
        material: '物料',
        measurement: '测量',
        statistical: '统计波动',
        compliance: '合规',
        unknown: '待确认'
      },
      causalStructure: {
        linear: '线性单链',
        'multi-branch': '多分支',
        'logical-combination': '逻辑组合',
        statistical: '统计型',
        unknown: '待确认'
      },
      informationState: {
        sufficient: '信息充分',
        partial: '信息部分充分',
        insufficient: '信息不足'
      }
    };
    return ['occurrencePattern', 'problemNature', 'causalStructure', 'informationState']
      .map((key) => labels[key][classification[key]] || classification[key])
      .filter(Boolean)
      .join(' / ');
  }

  /** Normalize and validate AI output before it reaches persistence or rendering. */
  function normalizeAssessment(raw, formData = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const sourceCorpus = Object.values(formData || {})
      .filter((value) => typeof value === 'string')
      .join('\n');
    const legacyCompleteness = input.completeness || {};
    const rawDefinition = input.problemDefinition || {};
    const rawQuality = input.quality || {};
    const quality = {
      clarity: _normalizeScoreItem(rawQuality.clarity),
      measurability: _normalizeScoreItem(rawQuality.measurability),
      scope: _normalizeScoreItem(rawQuality.scope),
      evidence: _normalizeScoreItem(rawQuality.evidence),
      investigability: _normalizeScoreItem(rawQuality.investigability || rawQuality.actionability)
    };
    quality.overall = Number(
      (
        Object.values(quality).reduce((sum, item) => sum + item.score, 0) /
        Object.keys(quality).length
      ).toFixed(1)
    );

    const facts = _list(rawDefinition.facts)
      .map((item) => ({
        field: _text(item?.field, 'phenomenon'),
        value: _text(item?.value),
        sourceEvidence: _text(item?.sourceEvidence),
        confidence: ['high', 'medium', 'low'].includes(item?.confidence) ? item.confidence : 'low',
        evidenceVerified: Boolean(
          _text(item?.sourceEvidence) && sourceCorpus.includes(_text(item?.sourceEvidence))
        )
      }))
      .filter((item) => item.value);
    if (!facts.length) {
      _list(legacyCompleteness.existing).forEach((value) => {
        if (_text(value))
          facts.push({
            field: 'phenomenon',
            value: _text(value),
            sourceEvidence: '',
            confidence: 'medium'
          });
      });
    }

    const missingInformation = _list(rawDefinition.missingInformation)
      .map((item) => ({
        field: _text(item?.field, 'other'),
        question: _text(item?.question),
        reason: _text(item?.reason),
        evidenceRequired: _text(item?.evidenceRequired),
        priority: ['high', 'medium', 'low'].includes(item?.priority) ? item.priority : 'medium'
      }))
      .filter((item) => item.question);
    if (!missingInformation.length) {
      _list(legacyCompleteness.missing).forEach((value) => {
        if (_text(value))
          missingInformation.push({
            field: 'other',
            question: _text(value),
            reason: '',
            evidenceRequired: '',
            priority: 'medium'
          });
      });
    }

    const priorityInput = input.priority || {};
    const priority = {
      severity: _normalizeScoreItem(priorityInput.severity || {}),
      urgency: _normalizeScoreItem(priorityInput.urgency || input.urgency || {}),
      impact: _normalizeScoreItem(priorityInput.impact || input.impact || {})
    };
    const classification =
      input.classification && typeof input.classification === 'object'
        ? {
            occurrencePattern: ['sporadic', 'recurrent', 'systemic', 'unknown'].includes(
              input.classification.occurrencePattern
            )
              ? input.classification.occurrencePattern
              : 'unknown',
            problemNature: [
              'execution',
              'process',
              'design',
              'equipment',
              'material',
              'measurement',
              'statistical',
              'compliance',
              'unknown'
            ].includes(input.classification.problemNature)
              ? input.classification.problemNature
              : 'unknown',
            causalStructure: [
              'linear',
              'multi-branch',
              'logical-combination',
              'statistical',
              'unknown'
            ].includes(input.classification.causalStructure)
              ? input.classification.causalStructure
              : 'unknown',
            informationState: ['sufficient', 'partial', 'insufficient'].includes(
              input.classification.informationState
            )
              ? input.classification.informationState
              : 'insufficient'
          }
        : {
            occurrencePattern: 'unknown',
            problemNature: 'unknown',
            causalStructure: 'unknown',
            informationState: 'insufficient',
            legacyLabel: _text(input.classification)
          };

    const rawRecommendation = input.recommendedAnalysis || {};
    const legacyMethod =
      input.recommendedDepth === 'standard'
        ? '5-why'
        : input.recommendedDepth === 'deep'
          ? 'fishbone'
          : 'none';
    const primaryMethod = ASSESSMENT_METHODS.includes(rawRecommendation.primaryMethod)
      ? rawRecommendation.primaryMethod
      : legacyMethod;
    const secondaryMethods = _list(rawRecommendation.secondaryMethods, 2)
      .map((item) => ({
        toolId:
          ASSESSMENT_METHODS.includes(item?.toolId) && item.toolId !== 'none' ? item.toolId : '',
        triggerCondition: _text(item?.triggerCondition),
        purpose: _text(item?.purpose)
      }))
      .filter((item) => item.toolId && item.toolId !== primaryMethod);
    const supplementaryTools = _list(rawRecommendation.supplementaryTools, 5)
      .map((item) => ({
        toolId: ASSESSMENT_SUPPLEMENTARY_TOOLS.includes(item?.toolId) ? item.toolId : '',
        reason: _text(item?.reason),
        dataRequirements: _list(item?.dataRequirements, 5)
          .map((value) => _text(value))
          .filter(Boolean)
      }))
      .filter((item) => item.toolId);
    const notRecommended = _list(rawRecommendation.notRecommended, 3)
      .map((item) => ({
        toolId:
          ASSESSMENT_METHODS.includes(item?.toolId) && item.toolId !== 'none' ? item.toolId : '',
        reason: _text(item?.reason)
      }))
      .filter((item) => item.toolId);

    const currentTitle = _text(formData.title);
    const suggestedTitle = _text(input.suggestedTitle).slice(0, 30);
    const formSuggestions = _list(input.formSuggestions, 12)
      .map((item) => {
        const field = _text(item?.field);
        const config = ASSESSMENT_FORM_FIELDS[field];
        const suggestedValue = _text(item?.suggestedValue);
        const sourceEvidence = _text(item?.sourceEvidence);
        const reason = _text(item?.reason);
        const confidence = ['high', 'medium', 'low'].includes(item?.confidence)
          ? item.confidence
          : 'low';
        const evidenceMatchesInput = Boolean(
          sourceEvidence && sourceCorpus.includes(sourceEvidence)
        );
        const enumValid = !config?.values || config.values.includes(suggestedValue);
        const timeValid =
          field !== 'time' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(suggestedValue);
        return {
          field,
          suggestedValue,
          sourceEvidence,
          reason,
          confidence,
          reviewStatus: ['pending', 'accepted', 'rejected', 'conflict', 'not_applicable'].includes(
            item?.reviewStatus
          )
            ? item.reviewStatus
            : 'pending',
          reviewedAt: item?.reviewedAt || null,
          safeToApply: Boolean(
            item?.safeToApply &&
            config &&
            enumValid &&
            timeValid &&
            confidence === 'high' &&
            (field === 'title' || evidenceMatchesInput)
          )
        };
      })
      .filter((item) => ASSESSMENT_FORM_FIELDS[item.field] && item.suggestedValue)
      .filter(
        (item) =>
          !(
            item.field === 'title' &&
            currentTitle &&
            _reasonIncorrectlyClaimsMissingTitle(item.reason)
          )
      );
    if (
      !currentTitle &&
      suggestedTitle &&
      !formSuggestions.some((item) => item.field === 'title')
    ) {
      formSuggestions.unshift({
        field: 'title',
        suggestedValue: suggestedTitle,
        sourceEvidence: '根据问题现象压缩生成',
        reason: '将问题现象压缩为便于识别和检索的问题标题',
        confidence: 'high',
        reviewStatus: 'pending',
        reviewedAt: null,
        safeToApply: true
      });
    }

    const normalized = {
      schemaVersion: '2.0',
      suggestedTitle,
      problemDefinition: {
        refinedStatement: _text(rawDefinition.refinedStatement),
        facts,
        missingInformation
      },
      quality,
      priority,
      classification,
      recommendedAnalysis: {
        primaryMethod,
        reason: _text(rawRecommendation.reason || input.recommendation),
        prerequisites: _list(rawRecommendation.prerequisites, 10)
          .map((value) => _text(value))
          .filter(Boolean),
        secondaryMethods,
        supplementaryTools,
        notRecommended
      },
      formSuggestions,
      nextActions: _list(input.nextActions, 10)
        .map((item, index) => ({
          priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : index + 1,
          action: _text(item?.action),
          purpose: _text(item?.purpose),
          targetField: _text(item?.targetField),
          evidenceRequired: _text(item?.evidenceRequired),
          ownerRole: _text(item?.ownerRole)
        }))
        .filter((item) => item.action),
      savedAt: input.savedAt || new Date().toISOString(),
      reviewStatus: ['pending', 'applied', 'skipped', 'no_changes'].includes(input.reviewStatus)
        ? input.reviewStatus
        : 'pending',
      reviewedAt: input.reviewedAt || null,
      reportSavedAt: input.reportSavedAt || null
    };

    // Compatibility aliases for previously persisted reports and downstream consumers.
    normalized.completeness = {
      existing: facts.map((item) => item.value),
      missing: missingInformation.map((item) => item.question),
      confidence: facts.some((item) => item.confidence === 'high')
        ? 'high'
        : facts.length
          ? 'medium'
          : 'low'
    };
    normalized.urgency = priority.urgency;
    normalized.impact = priority.impact;
    normalized.recommendedDepth =
      primaryMethod === 'none' ? 'quick' : primaryMethod === '5-why' ? 'standard' : 'deep';
    normalized.recommendation = normalized.recommendedAnalysis.reason;
    normalized.classificationLabel =
      classification.legacyLabel || _legacyClassificationLabel(classification);
    return normalized;
  }

  function collectFormData() {
    const getVal = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };
    return {
      title: getVal('pm-problem-title'),
      phenomenon: getVal('pm-problem-phenomenon'),
      severity: getVal('pm-severity'),
      time: getVal('pm-problem-time'),
      discoverySource: getVal('pm-discovery-source'),

      expectedState: getVal('pm-expected-state'),
      expectedSource: getVal('pm-expected-source'),
      expectedDetail: getVal('pm-expected-detail'),
      trend: getVal('pm-trend'),
      containment: getVal('pm-containment')
    };
  }

  /** 将数据填充到表单 */
  function fillForm(data) {
    if (!data) return;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val || '';
    };
    setVal('pm-problem-title', data.title);
    setVal('pm-problem-phenomenon', data.phenomenon);
    setVal('pm-severity', data.severity);
    setVal('pm-problem-time', data.time);
    setVal('pm-discovery-source', data.discoverySource);

    setVal('pm-expected-state', data.expectedState);
    setVal('pm-expected-source', data.expectedSource);
    setVal('pm-expected-detail', data.expectedDetail);
    setVal('pm-trend', data.trend);
    setVal('pm-containment', data.containment);
    // Restore assessment if exists; clear if not (prevent cross-problem bleed)
    if (data.assessment) {
      _assessment = normalizeAssessment(data.assessment, data);
      _reportVisible = false;
      if (!_assessment.savedAt && data.updatedAt) {
        _assessment.savedAt = data.updatedAt;
      } else if (!_assessment.savedAt) {
        _assessment.savedAt = new Date().toISOString();
      }
      _showCollapsedAssessment();
    } else if (_assessment) {
      _assessment = null;
      _reportVisible = false;
      _assessStart = 0;
      _resetAssessmentUi();
    }
  }

  /** 清空表单 */
  function clearProblemForm() {
    // P1-17: 若存在未持久化的评估，记录 warn 让"静默丢弃"可观测。
    // 显式清空（btnClearProblem）已有 showConfirm；此处的丢失败是
    // load(null) 切换问题的副作用，加确认会破坏切换 UX。
    if (_assessment) {
      console.warn('[ProblemManager] clearProblemForm 丢弃未保存的 assessment:', _assessment);
    }
    const inputs = document.querySelectorAll(
      '#problemMgmtSection input, #problemMgmtSection textarea, #problemMgmtSection select'
    );
    inputs.forEach((el) => {
      if (el.type === 'checkbox') el.checked = false;
      else el.value = '';
    });
    _assessment = null;
    _reportVisible = false;
    _resetAssessmentUi();
  }

  /** 获取问题描述文本 */
  function getProblemDescription() {
    return collectFormData().phenomenon || '';
  }

  /** 获取完整问题上下文 */
  function getProblemContext(data) {
    const d = data || collectFormData();
    let ctx = '';
    if (d.title) ctx += '问题标题：' + d.title + '\n';
    if (d.phenomenon) ctx += '问题现象：' + d.phenomenon + '\n';
    if (d.severity) {
      const severityLabels = Labels.severity;
      ctx += '严重度：' + (severityLabels[d.severity] || d.severity) + '\n';
    }
    if (d.time) ctx += '发生时间：' + d.time + '\n';
    if (d.discoverySource) {
      const sourceLabels = Labels.source;
      ctx += '发现方式：' + (sourceLabels[d.discoverySource] || d.discoverySource) + '\n';
    }

    if (d.expectedState) ctx += '期望值：' + d.expectedState + '\n';
    if (d.trend) {
      const trendLabels = { sudden: '突发', gradual: '渐变', intermittent: '间歇' };
      ctx += '趋势：' + (trendLabels[d.trend] || d.trend) + '\n';
    }
    if (d.containment) ctx += '临时措施：' + d.containment + '\n';
    return ctx.trim();
  }

  // ===== Facade 接口 =====

  /**
   * 加载数据到表单（Facade 接口）
   * @param {Object|null} data - 问题数据对象，null 则清空表单
   */
  function load(data) {
    if (!data) {
      // P1-17-2nd: 切换问题前保存未持久化的评估，防止静默丢弃
      if (_assessment && typeof window.updateProblem === 'function') {
        const activePid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : null;
        if (activePid) {
          const details = getData();
          window.updateProblem(activePid, { details });
        }
      }
      clearProblemForm();
      return;
    }
    fillForm(data);
  }

  /**
   * 获取当前表单数据（Facade 接口）
   * @returns {Object} 表单数据 + 当前评估结果
   */
  function getData() {
    const data = collectFormData();
    data.savedAt = new Date().toISOString();
    data.assessment = _assessment;
    return data;
  }

  /**
   * 获取当前评估结果（Facade 接口）
   * @returns {Object|null}
   */
  function getAssessment() {
    return _assessment;
  }

  let _assessStart = 0;

  // ===== AI 评估 =====

  async function evaluate() {
    if (isEvaluating) return null;
    _assessStart = Date.now();
    // 已有评估结果，询问是否重新评估
    if (_assessment) {
      const reRun = await showConfirm(
        '该问题已有 AI 评估报告，是否重新评估？\n\n点击"确定"重新评估并覆盖现有报告；\n点击"取消"查看现有评估结果。',
        'info'
      );
      if (!reRun) {
        return _assessment;
      }
    }
    const _activeId = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
    const d = collectFormData();
    if (!d.phenomenon) {
      showToast('请先填写问题现象', 'error');
      return null;
    }

    const btn = document.getElementById('btnAIAssess');
    const resultEl = document.getElementById('pmAssessmentResult');
    if (!resultEl) return null;

    isEvaluating = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '评估中...';
    }
    resultEl.innerHTML =
      '<div class="pm-assessment-loading"><div class="spinner"></div><p>AI 正在分析问题...</p></div>';
    if (window.SidebarUI) {
      window.SidebarUI.open('问题评估');
      window.SidebarUI.showLoading('正在评估问题信息...', [
        '正在分析现象与上下文...',
        '正在评估质量维度...',
        '正在生成建议与标题...'
      ]);
    }

    try {
      // Build context（复用 getProblemContext 的逻辑 + 额外字段）
      const ctx =
        getProblemContext() +
        (d.expectedSource ? '\n期望值来源：' + d.expectedSource : '') +
        (d.expectedDetail ? '\n来源详情：' + d.expectedDetail : '');

      const rendered = renderPrompt('problemAssessment', {
        problemStatement: d.phenomenon,
        problemContext: ctx || '未提供'
      });
      const sysPrompt = rendered.system;
      const userPrompt = rendered.user;

      // Call AI
      let raw;
      let reasoningStreamActive = false;
      try {
        const { text: streamContent } = await callOpenAIStreaming(sysPrompt, userPrompt, {
          onReasoning: (_chunk, fullText) => {
            if (!reasoningStreamActive) {
              reasoningStreamActive = true;
              window.SidebarUI?.showReasoningStream('模型推理输出', 'pmAssessmentReasoningContent');
            }
            window.SidebarUI?.updateReasoningStream('pmAssessmentReasoningContent', fullText);
          }
        });
        raw = parseAIJson(streamContent);
      } catch (streamErr) {
        if (streamErr.message === 'AI 分析已取消' || streamErr.message === 'ALREADY_IN_FLIGHT') {
          throw streamErr;
        }
        console.warn('[PM] evaluate streaming failed, falling back:', streamErr.message);
        window.SidebarUI?.hideLoading();
        window.SidebarUI?.showLoading('正在以兼容模式评估...', null, true);
        raw = await _callAI(sysPrompt, userPrompt, true);
      }

      // 校验活跃问题上下文，防止切换问题导致的张冠李戴
      if (typeof getActiveProblemId === 'function' && getActiveProblemId() !== _activeId) {
        showToast('AI 评估返回时问题已切换，已忽略该评估结果', 'warning');
        return null;
      }

      let assessment;
      if (raw && typeof raw === 'object') {
        assessment = raw;
      } else {
        try {
          // Strip markdown code block if present
          const cleaned = String(raw || '')
            .replace(/```json?\s*/g, '')
            .replace(/```\s*/g, '')
            .trim();
          assessment = JSON.parse(cleaned);
        } catch (parseErr) {
          // Try to extract JSON from the response (C-10: greedy match to support nested objects)
          const jsonMatch = String(raw || '').match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            assessment = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('AI 返回格式无法解析');
          }
        }
      }

      // Schema normalization is the trust boundary between model output and application state.
      assessment = normalizeAssessment(assessment, d);
      _assessment = assessment;

      // 立即持久化到问题库中，防止页面跳转后数据丢失
      if (typeof getActiveProblemId === 'function' && typeof window.updateProblem === 'function') {
        const activePid = getActiveProblemId();
        if (activePid) {
          const details = getData();
          window.updateProblem(activePid, { details });
        }
      }

      // Render
      _reportVisible = true;
      renderAssessment(assessment);
      const viewBtn = document.getElementById('btnViewAssessment');
      if (viewBtn) viewBtn.style.display = 'none';

      // 先审查表单差异，再基于用户确认后的最终表单生成正式报告。
      const changes = _getAssessmentFieldChanges(assessment, d);
      if (!changes.length) {
        assessment.reviewStatus = 'no_changes';
        assessment.reviewedAt = new Date().toISOString();
        _persistAssessmentState();
        try {
          await _saveAssessmentReport();
        } catch (e) {
          console.warn('Auto-save assessment report failed:', e);
          showToast('自动保存评估报告失败', 'error');
        }
      }
      _openAssessmentReviewSidebar(assessment);

      showToast('AI 评估完成', 'success');
      return assessment;
    } catch (err) {
      resultEl.innerHTML =
        '<div class="pm-assessment-error"><span>❌</span><p class="error-message"></p></div>';
      resultEl.querySelector('.error-message').textContent = '评估失败：' + err.message;
      // 在侧边栏展示思考过程（如存在）
      if (window.SidebarUI) {
        const errHtml = window.wrapWithThinking ? window.wrapWithThinking('') : '';
        if (errHtml) {
          window.SidebarUI.openContent('问题评估', errHtml);
        }
      }
      showToast('评估失败: ' + err.message, 'error');
      return null;
    } finally {
      if (window.SidebarUI?.hideLoading) window.SidebarUI.hideLoading();
      isEvaluating = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'AI 评估';
      }
    }
  }

  // ===== 渲染评估结果 =====

  function generateAssessmentHtml(r, formData) {
    if (!r) return '';
    const d = formData || collectFormData();
    const md = generateAssessmentMarkdown(r, d);
    let html = '<div class="markdown-content report-content">';
    html += window.UIUtils.mdToHtml(md);
    html += '</div>';
    return html;
  }

  function _getApplicableFormSuggestions(r) {
    return _list(r?.formSuggestions, 20).filter((suggestion) => {
      if (!suggestion.safeToApply || suggestion.confidence !== 'high') return false;
      if (!['pending', 'conflict'].includes(suggestion.reviewStatus || 'pending')) return false;
      const config = ASSESSMENT_FORM_FIELDS[suggestion.field];
      const el = config ? document.getElementById(config.id) : null;
      return Boolean(el && !String(el.value || '').trim() && suggestion.suggestedValue);
    });
  }

  function _formatAssessmentFieldValue(field, value) {
    if (!value) return '（空白）';
    const maps = {
      severity: Labels.severity || {},
      discoverySource: Labels.source || {},
      expectedSource: {
        regulation: '法规/标准',
        customer: '客户要求',
        internal: '内部规范',
        design: '设计要求',
        historical: '历史基准',
        benchmark: '对标基准',
        other: '其他'
      },
      trend: { sudden: '突发', gradual: '渐变', intermittent: '间歇' }
    };
    return maps[field]?.[value] || value;
  }

  function _getAssessmentFieldChanges(r, formData) {
    const d = formData || collectFormData();
    return _list(r?.formSuggestions, 20)
      .map((suggestion, suggestionIndex) => {
        const config = ASSESSMENT_FORM_FIELDS[suggestion.field];
        const currentValue = _text(d[suggestion.field]);
        const suggestedValue = _text(suggestion.suggestedValue);
        const reviewStatus = suggestion.reviewStatus || 'pending';
        if (
          !config ||
          !suggestion.safeToApply ||
          suggestion.confidence !== 'high' ||
          !suggestedValue ||
          currentValue === suggestedValue ||
          !['pending', 'conflict'].includes(reviewStatus)
        ) {
          return null;
        }
        return {
          suggestionIndex,
          field: suggestion.field,
          label: config.label,
          elementId: config.id,
          currentValue,
          suggestedValue,
          sourceEvidence: _text(suggestion.sourceEvidence),
          reason: _text(suggestion.reason),
          changeType: currentValue ? 'replace' : 'fill',
          defaultSelected: !currentValue
        };
      })
      .filter(Boolean);
  }

  function _assessmentSummaryHtml(r) {
    const method = ({'5-why': '5 Whys', fishbone: '鱼骨图', fta: '故障树', none: ''})[r?.recommendedAnalysis?.primaryMethod] || '暂不开始根因分析';
    const missingCount = r?.problemDefinition?.missingInformation?.length || 0;
    return `<div class="ai-block pm-assessment-review-summary">
      <h4>评估摘要</h4>
      <p>问题定义质量：<strong>${Number(r?.quality?.overall || 0).toFixed(1)}/5</strong></p>
      <p>建议分析方法：<strong>${esc(method)}</strong></p>
      <p>待补充信息：<strong>${missingCount} 项</strong></p>
    </div>`;
  }

  function _assessmentReviewHtml(r, changes) {
    let html = _assessmentSummaryHtml(r);
    if (changes.length) {
      html += `<div class="ai-block"><h4>建议修改问题管理表 (${changes.length} 项)</h4>`;
      html += '<p class="pm-assessment-review-hint">空白字段默认勾选；修改已有内容需主动勾选。请逐项确认后再应用。</p>';
      changes.forEach((change) => {
        const typeLabel = change.changeType === 'fill' ? '补充空白' : '建议修改';
        html += `<label class="pm-assessment-change ${change.changeType}">
          <span class="pm-assessment-change-head">
            <input type="checkbox" data-assessment-change-index="${change.suggestionIndex}"${change.defaultSelected ? ' checked' : ''}>
            <strong>${esc(change.label)}</strong>
            <span class="pm-assessment-change-type">${typeLabel}</span>
          </span>
          <span class="pm-assessment-change-values">
            <span><small>修改前</small>${esc(_formatAssessmentFieldValue(change.field, change.currentValue))}</span>
            <span class="pm-assessment-change-arrow">→</span>
            <span><small>修改后</small>${esc(_formatAssessmentFieldValue(change.field, change.suggestedValue))}</span>
          </span>
          ${change.reason ? `<span class="pm-assessment-change-note"><strong>理由：</strong>${esc(change.reason)}</span>` : ''}
          ${change.sourceEvidence ? `<span class="pm-assessment-change-note"><strong>依据：</strong>“${esc(change.sourceEvidence)}”</span>` : ''}
        </label>`;
      });
      html += `<button type="button" class="btn btn-primary btn-block" data-action="apply-assessment-changes" data-sidebar-primary="true">应用选中的修改</button>`;
      html += `<button type="button" class="btn btn-outline btn-block" data-action="skip-assessment-changes">保持原内容并生成报告</button>`;
      html += '</div>';
    } else {
      html += `<div class="ai-block is-success"><h4>无需修改问题表单</h4><p>现有内容与可安全采纳的评估建议一致，评估报告已基于当前表单生成。</p></div>`;
    }
    return html;
  }

  function _bindAssessmentSidebarActions() {
    document.querySelectorAll('[data-action="apply-assessment-changes"]').forEach((btn) => {
      btn.addEventListener('click', _applyAssessmentChangesFromSidebar);
    });
    document.querySelectorAll('[data-action="skip-assessment-changes"]').forEach((btn) => {
      btn.addEventListener('click', _skipAssessmentChanges);
    });
    document.querySelectorAll('[data-action="rollback-assessment-changes"]').forEach((btn) => {
      btn.addEventListener('click', _rollbackAssessmentChanges);
    });
  }

  function _openAssessmentReviewSidebar(r) {
    if (!window.SidebarUI || !r) return;
    const changes = _getAssessmentFieldChanges(r);
    _pendingAssessmentReview = {
      problemId: typeof getActiveProblemId === 'function' ? getActiveProblemId() : '',
      changes
    };
    window.SidebarUI.openContent('问题评估', _assessmentReviewHtml(r, changes));
    _bindAssessmentSidebarActions();
    return changes;
  }

  function _persistAssessmentState() {
    if (typeof getActiveProblemId !== 'function' || typeof window.updateProblem !== 'function') return;
    const activePid = getActiveProblemId();
    if (activePid) window.updateProblem(activePid, { details: getData() });
  }

  function _dispatchAssessmentFieldEvents(el) {
    if (!el || typeof el.dispatchEvent !== 'function' || typeof Event !== 'function') return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function _saveAssessmentReport() {
    if (!_assessment || typeof saveReportToLibrary !== 'function') return null;
    const d = collectFormData();
    const pid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
    if (!pid) return null;
    const md = generateAssessmentMarkdown(_assessment, d);
    const saved = await saveReportToLibrary(md, {
      title: `问题定义评估 - ${d.title || _assessment.suggestedTitle || '未命名问题'}`,
      problemId: pid,
      problemTitle: d.title,
      problemStatement: d.phenomenon,
      analysisType: 'assessment',
      sourceMode: 'ai',
      nodeCount: 0,
      rootCauseCount: 0,
      isRegenerate: Boolean(_assessment.reportSavedAt)
    });
    if (saved) {
      _assessment.reportSavedAt = new Date().toISOString();
      _persistAssessmentState();
      renderAssessment(_assessment);
    }
    return saved;
  }

  async function _applyAssessmentChangesFromSidebar() {
    if (!_assessment || !_pendingAssessmentReview) return false;
    const activePid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
    if (_pendingAssessmentReview.problemId && activePid !== _pendingAssessmentReview.problemId) {
      showToast('评估结果与当前问题不匹配，无法应用', 'warning');
      return false;
    }
    const selected = new Set(
      Array.from(
        document.querySelectorAll(
          '#aiContent [data-assessment-change-index]:checked'
        )
      ).map((el) => Number(el.dataset.assessmentChangeIndex))
    );
    if (!selected.size) {
      showToast('请至少选择一项修改，或选择保持原内容', 'info');
      return false;
    }

    const assessmentBefore = JSON.parse(JSON.stringify(_assessment));
    const fieldSnapshot = {};
    const applied = [];
    const conflicts = [];
    const now = new Date().toISOString();

    _pendingAssessmentReview.changes.forEach((change) => {
      const suggestion = _assessment.formSuggestions[change.suggestionIndex];
      if (!suggestion) return;
      if (!selected.has(change.suggestionIndex)) {
        suggestion.reviewStatus = 'rejected';
        suggestion.reviewedAt = now;
        return;
      }
      const el = document.getElementById(change.elementId);
      if (!el || String(el.value || '').trim() !== change.currentValue) {
        suggestion.reviewStatus = 'conflict';
        suggestion.reviewedAt = now;
        conflicts.push(change.label);
        return;
      }
      fieldSnapshot[change.field] = change.currentValue;
      el.value = change.suggestedValue;
      _dispatchAssessmentFieldEvents(el);
      suggestion.reviewStatus = 'accepted';
      suggestion.reviewedAt = now;
      applied.push(change);
    });

    if (!applied.length) {
      showToast(conflicts.length ? '字段内容已变化，请重新评估修改建议' : '没有应用任何修改', 'warning');
      return false;
    }

    _assessment.reviewStatus = 'applied';
    _assessment.reviewedAt = now;
    _lastAssessmentApplication = { problemId: activePid, fieldSnapshot, assessmentBefore };
    if (typeof window.autoSaveToProblemPool === 'function') window.autoSaveToProblemPool(true);
    _persistAssessmentState();
    await _saveAssessmentReport();

    let html = _assessmentSummaryHtml(_assessment);
    html += `<div class="ai-block is-success"><h4>✓ 已应用 ${applied.length} 项修改</h4>`;
    applied.forEach((change) => {
      html += `<div class="ai-suggestion"><div class="text">${esc(change.label)}：${esc(_formatAssessmentFieldValue(change.field, change.suggestedValue))}</div></div>`;
    });
    if (conflicts.length) html += `<p class="pm-assessment-review-hint">因字段已变化跳过：${esc(conflicts.join('、'))}</p>`;
    html += `<button type="button" class="btn btn-outline btn-block" data-action="rollback-assessment-changes">撤销本次应用</button></div>`;
    window.SidebarUI?.openContent('问题评估', html);
    _bindAssessmentSidebarActions();
    showToast(`已应用 ${applied.length} 项修改并更新评估报告`, 'success');
    return true;
  }

  async function _skipAssessmentChanges() {
    if (!_assessment) return false;
    const now = new Date().toISOString();
    _assessment.formSuggestions.forEach((item) => {
      if (['pending', 'conflict'].includes(item.reviewStatus || 'pending')) {
        item.reviewStatus = 'rejected';
        item.reviewedAt = now;
      }
    });
    _assessment.reviewStatus = 'skipped';
    _assessment.reviewedAt = now;
    _persistAssessmentState();
    await _saveAssessmentReport();
    window.SidebarUI?.openContent(
      '问题评估',
      _assessmentSummaryHtml(_assessment) +
        '<div class="ai-block is-success"><h4>已保留原表单内容</h4><p>评估报告已基于当前问题表单生成。</p></div>'
    );
    showToast('已保留原内容并生成评估报告', 'success');
    return true;
  }

  async function _rollbackAssessmentChanges() {
    const snapshot = _lastAssessmentApplication;
    const activePid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
    if (!snapshot || snapshot.problemId !== activePid) {
      showToast('没有可撤销的本次修改', 'info');
      return false;
    }
    Object.keys(snapshot.fieldSnapshot).forEach((field) => {
      const config = ASSESSMENT_FORM_FIELDS[field];
      const el = config && document.getElementById(config.id);
      if (!el) return;
      el.value = snapshot.fieldSnapshot[field];
      _dispatchAssessmentFieldEvents(el);
    });
    _assessment = normalizeAssessment(snapshot.assessmentBefore, collectFormData());
    const now = new Date().toISOString();
    _assessment.formSuggestions.forEach((item) => {
      if (item.reviewStatus === 'pending') {
        item.reviewStatus = 'rejected';
        item.reviewedAt = now;
      }
    });
    _assessment.reviewStatus = 'skipped';
    _assessment.reviewedAt = now;
    _lastAssessmentApplication = null;
    if (typeof window.autoSaveToProblemPool === 'function') window.autoSaveToProblemPool(true);
    _persistAssessmentState();
    await _saveAssessmentReport();
    window.SidebarUI?.openContent(
      '问题评估',
      _assessmentSummaryHtml(_assessment) +
        '<div class="ai-block is-success"><h4>已撤销本次应用</h4><p>问题表单和评估报告已恢复为应用前内容。</p></div>'
    );
    showToast('已撤销本次表单修改', 'success');
    return true;
  }

  async function applyAssessmentSuggestions() {
    if (!_assessment) return false;
    const suggestions = _getApplicableFormSuggestions(_assessment);
    if (!suggestions.length) {
      showToast('没有可安全采纳的空字段建议', 'info');
      return false;
    }
    const preview = suggestions
      .map((item) => `${ASSESSMENT_FORM_FIELDS[item.field].label}：${item.suggestedValue}`)
      .join('\n');
    const confirmed = await showConfirm(
      `以下高置信建议将填入当前空字段，不会覆盖已有内容：\n\n${preview}\n\n确定采纳？`,
      'info'
    );
    if (!confirmed) return false;

    const applied = [];
    suggestions.forEach((item) => {
      const config = ASSESSMENT_FORM_FIELDS[item.field];
      const el = config && document.getElementById(config.id);
      if (!el || String(el.value || '').trim()) return;
      el.value = item.suggestedValue;
      if (typeof el.dispatchEvent === 'function' && typeof Event === 'function') {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      applied.push(config.label);
    });
    if (applied.length && typeof window.autoSaveToProblemPool === 'function') {
      window.autoSaveToProblemPool(true);
    }
    showToast(`已采纳 ${applied.length} 项表单建议`, applied.length ? 'success' : 'info');
    return applied.length > 0;
  }

  function renderAssessment(r) {
    const resultEl = document.getElementById('pmAssessmentResult');
    if (!resultEl || !r) return;

    const reviewComplete = ['applied', 'skipped', 'no_changes'].includes(r.reviewStatus);
    const exportBtn = document.getElementById('btnExportAssessment');
    if (exportBtn) exportBtn.style.display = reviewComplete ? 'inline-block' : 'none';
    const exportWordBtn = document.getElementById('btnExportAssessmentWord');
    if (exportWordBtn) exportWordBtn.style.display = reviewComplete ? 'inline-block' : 'none';

    resultEl.innerHTML = generateAssessmentHtml(r);
  }

  function _showCollapsedAssessment() {
    const resultEl = document.getElementById('pmAssessmentResult');
    if (resultEl)
      resultEl.innerHTML =
        '<div class="pm-assessment-placeholder"><p>该问题已有 AI 评估，点击上方"查看评估"继续审查</p></div>';
    const viewBtn = document.getElementById('btnViewAssessment');
    if (viewBtn) viewBtn.style.display = 'inline-block';
    const exportBtn = document.getElementById('btnExportAssessment');
    if (exportBtn) exportBtn.style.display = 'none';
    const exportWordBtn = document.getElementById('btnExportAssessmentWord');
    if (exportWordBtn) exportWordBtn.style.display = 'none';
  }

  function _resetAssessmentUi() {
    const resultEl = document.getElementById('pmAssessmentResult');
    if (resultEl)
      resultEl.innerHTML =
        '<div class="pm-assessment-placeholder"><p>填写上方信息后，点击上方按钮进行 AI 评估</p></div>';
    const viewBtn = document.getElementById('btnViewAssessment');
    if (viewBtn) viewBtn.style.display = 'none';
    const exportBtn = document.getElementById('btnExportAssessment');
    if (exportBtn) exportBtn.style.display = 'none';
    const exportWordBtn = document.getElementById('btnExportAssessmentWord');
    if (exportWordBtn) exportWordBtn.style.display = 'none';
  }

  /** 导出问题为 JSON 文件 */
  function exportProblem() {
    const data = collectFormData();
    if (!data.phenomenon) {
      showToast('请先填写问题描述', 'error');
      return;
    }
    const exportData = {
      _format: 'tool-problem-analysis/v1',
      _exportedAt: new Date().toISOString(),
      ...data
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (data.phenomenon || 'unnamed').slice(0, 20).replace(/[/\\:*?"<>|]/g, '_');
    a.download = `问题_${safeName}_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('问题已导出', 'success');
  }

  /** 从 JSON 文件导入问题 */
  async function importProblem(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.phenomenon && !data._format) {
          showToast('文件格式不正确', 'error');
          return;
        }
        // 创建新问题而非覆盖当前表单，避免污染现有问题
        if (
          typeof window.createNewProblem === 'function' &&
          typeof window.showProblemDetail === 'function'
        ) {
          const newProblem = window.createNewProblem({
            title: data.title || '',
            status: 'pending'
          });
          if (newProblem && newProblem.id) {
            fillForm(data);
            window.showProblemDetail(newProblem.id);
            showToast('问题已导入', 'success');
          }
        }
      } catch (err) {
        showToast('导入失败：' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  /** 加载示例问题 */
  function showExampleMenu() {
    const existing = document.getElementById('exampleMenu');
    if (existing) {
      if (existing._closeHandler) {
        document.removeEventListener('click', existing._closeHandler);
      }
      existing.remove();
      return;
    }

    const btn = document.getElementById('btnLoadExample');
    if (!btn) return;

    const menu = document.createElement('div');
    menu.id = 'exampleMenu';
    menu.className = 'example-menu';

    let closeMenuHandler = null;

    const closeDropdown = () => {
      menu.classList.remove('show');
      setTimeout(() => {
        if (menu.parentNode) {
          menu.remove();
        }
      }, 150);
      if (closeMenuHandler) {
        document.removeEventListener('click', closeMenuHandler);
      }
    };

    if (typeof window.EXAMPLES_DATA === 'object') {
      Object.entries(window.EXAMPLES_DATA).forEach(([file, data]) => {
        if (!data.menuLabel) return;
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = data.menuLabel;
        item.className = 'example-menu-item';
        item.addEventListener('click', async () => {
          await loadExample(file);
          closeDropdown();
        });
        menu.appendChild(item);
      });
    }

    // 挂载至 document.body，防止祖先定位剪裁或局部排列挤压
    document.body.appendChild(menu);

    const btnRect = btn.getBoundingClientRect();
    const menuWidth = 260; // 对应 CSS min-width

    const pageScrollY = window.scrollY || window.pageYOffset || 0;
    const pageScrollX = window.scrollX || window.pageXOffset || 0;

    const top = btnRect.bottom + pageScrollY + 6;
    // 默认右侧对齐按钮右侧
    let left = btnRect.right + pageScrollX - menuWidth;

    // 越界保护机制
    const viewportWidth = window.innerWidth;
    if (left < 12) {
      left = 12;
    }
    if (left + menuWidth > viewportWidth - 12) {
      left = viewportWidth - menuWidth - 12;
    }

    menu.style.position = 'absolute';
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.right = 'auto';

    // Trigger smooth fade-in and scale animation
    requestAnimationFrame(() => {
      menu.classList.add('show');
    });

    // Close on outside click
    closeMenuHandler = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== btn) {
        closeDropdown();
      }
    };

    menu._closeHandler = closeMenuHandler;

    setTimeout(() => {
      document.addEventListener('click', closeMenuHandler);
    }, 0);
  }

  /**
   * 将示例数据应用到当前问题（表单 + 分析快照）
   * @param {Object} data - 示例数据对象
   */
  async function _generateExampleReport(type, data, pid, exampleSource) {
    const reportOpts = {
      title: '',
      problemId: pid,
      problemStatement: data.phenomenon || '',
      analysisType: type,
      sourceMode: 'example',
      nodeCount: 0,
      rootCauseCount: 0,
      exampleSource: exampleSource || ''
    };

    if (type === '5why' && data.tree && typeof window.generateLocalReport === 'function') {
      const report = window.generateLocalReport({
        tree: data.tree,
        problemStatement: data.phenomenon || '',
        problemId: pid,
        sourceMode: 'example'
      });
      reportOpts.title = '[5 Whys] ' + (data.title || '问题分析报告');
      await window.saveReportToLibrary(report, reportOpts);
      window.updateProblem(pid, {
        analyses: { '5why': { status: 'completed', lastUpdated: new Date().toISOString() } }
      });
      return;
    }
    if (
      type === 'fishbone' &&
      data.fishboneData &&
      window.Fishbone &&
      typeof window.Fishbone.generateLocalReport === 'function'
    ) {
      const report = window.Fishbone.generateLocalReport({
        problem: data.title || data.phenomenon || '',
        problemId: pid,
        categories: data.fishboneData.categories,
        sourceMode: 'example'
      });
      reportOpts.title = '[鱼骨图] ' + (data.title || '问题分析报告');
      // 捕获鱼骨图 SVG 快照（对齐 FTA 路径），确保查看报告时能渲染分支内容
      if (window.FishboneSVG && typeof window.FishboneSVG.generateSVG === 'function') {
        reportOpts.fishboneSvgHtml = window.FishboneSVG.generateSVG(data.fishboneData);
      }
      await window.saveReportToLibrary(report, reportOpts);
      window.updateProblem(pid, {
        analyses: { fishbone: { status: 'completed', lastUpdated: new Date().toISOString() } }
      });
      return;
    }
    if (
      type === 'fta' &&
      data.ftaData &&
      window.FTA &&
      typeof window.FTA.validateTree === 'function' &&
      typeof window.FTA.computeMinCutSets === 'function' &&
      typeof window.FTA.generateLocalReport === 'function'
    ) {
      const reviewedAiReport =
        typeof data.reportMarkdown === 'string' && data.reportMarkdown.trim()
          ? data.reportMarkdown.trim()
          : '';
      const ftaClone = JSON.parse(JSON.stringify(data.ftaData));
      const savedFtaData = JSON.parse(JSON.stringify(window.FTA.getData()));
      // P1-3: await importData — 此前未 await，示例数据可能未完全导入就读取
      await window.FTA.importData(ftaClone);
      const ftaDataObj = window.FTA.getData();
      const validation = window.FTA.validateTree();
      // P1-14: validateTree 失败时（含循环引用等）绝不能调 computeMinCutSets —
      // _expandNode 无 visited set 会无限递归挂起标签页。runAnalysis/generateReport
      // 经 validateTree 守门，此处示例报告生成须对齐。
      const hasErrors = validation && validation.errors && validation.errors.length > 0;
      const cutSets = hasErrors ? [] : window.FTA.computeMinCutSets();
      const ctx = {
        problemId: pid,
        topEventName: ftaDataObj.topEvent.name || '故障树分析',
        topEventBoundary: ftaDataObj.topEvent.boundary || '',
        asciiTreeText: window.FTA.renderAsciiTree(),
        nodeCount: Object.keys(ftaDataObj.nodes || {}).length,
        confirmedCount: Object.values(ftaDataObj.nodes || {}).filter(
          (n) => n.status === 'confirmed'
        ).length,
        aiCallCount: ftaDataObj.metadata?.aiCallCount || 0,
        analysisMode: ftaDataObj.metadata?.mode || 'auto',
        sourceMode: 'example',
        nodesMap: JSON.parse(JSON.stringify(ftaDataObj.nodes))
      };
      const report = reviewedAiReport || window.FTA.generateLocalReport(validation, cutSets, ctx);
      // 捕获 FTA SVG 快照（在还原数据之前）
      const ftaSvgEl = document.querySelector('#ftaGraphicWrapper svg');
      if (ftaSvgEl) {
        reportOpts.ftaSvgHtml = window.UIUtils.resolveSvgCssVars(
          new XMLSerializer().serializeToString(ftaSvgEl)
        );
      }
      // P1-3: 还原原 FTA 数据。若原数据为空（rootId 不存在），显式 clear，
      // 否则示例 FTA 数据残留在 window.FTA 中被持久化到当前问题。
      if (savedFtaData && savedFtaData.rootId) {
        await window.FTA.importData(savedFtaData);
      } else if (typeof window.FTA.clear === 'function') {
        await window.FTA.clear();
      }
      reportOpts.title = '[FTA] ' + (data.title || '问题分析报告');
      await window.saveReportToLibrary(report, reportOpts);
      window.updateProblem(pid, {
        analyses: { fta: { status: 'completed', lastUpdated: new Date().toISOString() } }
      });
    }
  }

  async function _restoreExampleToTools(exampleSource) {
    const data = window.EXAMPLES_DATA && window.EXAMPLES_DATA[exampleSource];
    if (!data) return false;
    const hasTree = !!data.tree;
    const hasFb = !!data.fishboneData;
    const hasFta = !!data.ftaData;

    // 检查当前工具状态是否已有分析数据，防止覆盖用户实时分析
    const hasLiveAnalysis =
      (window.tree && window.tree.children && window.tree.children.length > 0) ||
      (window.Fishbone &&
        window.Fishbone.fishboneData &&
        window.Fishbone.fishboneData.categories &&
        Object.values(window.Fishbone.fishboneData.categories).some((c) => c && c.length > 0)) ||
      (window.FTA && typeof window.FTA.getData === 'function' && window.FTA.getData().rootId);
    if (hasLiveAnalysis) {
      const ok = await showConfirm(
        '当前分析会话已有数据，恢复示例数据将覆盖现有分析。\n确定继续？',
        'danger'
      );
      if (!ok) return false;
    }

    if (hasTree && typeof window.touchMany === 'function') {
      const treeClone = JSON.parse(JSON.stringify(data.tree));
      let nextId = data.nextId;
      if (!nextId && typeof treeClone.id === 'number') {
        const maxId = (function _m(n, m) {
          if (!n) return m;
          if (n.id > m) m = n.id;
          if (n.children)
            n.children.forEach((c) => {
              m = _m(c, m);
            });
          return m;
        })(treeClone, 0);
        nextId = maxId + 1;
      }
      window.touchMany(
        {
          tree: treeClone,
          nextId: nextId || 1,
          problemStatement: data.phenomenon || '',
          causalValidationResults: data.causalValidationResults || {}
        },
        'restoreExample'
      );
      if (typeof window.rebuildNodeIndex === 'function') window.rebuildNodeIndex();
    }
    if (hasFb && window.Fishbone) {
      const fbClone = JSON.parse(JSON.stringify(data.fishboneData));
      if (window.Fishbone.CATEGORIES) {
        window.Fishbone.CATEGORIES.forEach((cat) => {
          if (!fbClone.categories[cat.id]) fbClone.categories[cat.id] = [];
        });
      }
      window.Fishbone.fishboneData = fbClone;
      if (typeof window.Fishbone.renderFishboneForm === 'function')
        window.Fishbone.renderFishboneForm();
    }
    if (hasFta && window.FTA && typeof window.FTA.importData === 'function') {
      window.FTA.importData(JSON.parse(JSON.stringify(data.ftaData)));
    }
    return true;
  }

  async function applyExampleData(data) {
    // 1. 填充问题定义表单
    fillForm(data);

    const hasTree = !!data.tree;
    const hasFb = !!data.fishboneData;
    const hasFta = !!data.ftaData;
    const _activePid =
      typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;

    // 2. 构造快照数据
    let treeClone = null;
    let nextId = 1;
    if (hasTree) {
      treeClone = JSON.parse(JSON.stringify(data.tree));
      nextId = data.nextId;
      if (!nextId && typeof treeClone.id === 'number') {
        const maxId = (function _m(n, m) {
          if (!n) return m;
          if (n.id > m) m = n.id;
          if (n.children)
            n.children.forEach((c) => {
              m = _m(c, m);
            });
          return m;
        })(treeClone, 0);
        nextId = maxId + 1;
      }
    }

    const snapshot = {
      version: 2,
      exportedAt: new Date().toISOString(),
      problemStatement: data.phenomenon || '',
      problemContext: window.buildProblemContext
        ? window.buildProblemContext({
            title: data.title || '',
            problemStatement: data.phenomenon || '',
            details: data
          })
        : data.phenomenon || '',
      details: JSON.parse(JSON.stringify(data)),
      tree: treeClone,
      nextId: nextId || 1,
      causalValidationResults: data.causalValidationResults || {},
      analysisStartTime: new Date().toISOString(),
      reportMarkdown: '',
      cachedReport: '',
      cachedTreeHash: '',
      fishboneData: hasFb ? JSON.parse(JSON.stringify(data.fishboneData)) : null,
      ftaData: hasFta ? JSON.parse(JSON.stringify(data.ftaData)) : null
    };

    // 3.1 5 Whys
    if (typeof window.touchMany === 'function') {
      window.touchMany(
        { tree: null, nextId: 1, problemStatement: '', causalValidationResults: {} },
        'loadExample'
      );
      if (typeof window.rebuildNodeIndex === 'function') window.rebuildNodeIndex();
      if (typeof window.renderTree === 'function') window.renderTree();
    }
    if (_activePid && typeof window.pluginRemove === 'function') {
      window.pluginRemove('qa-5why-data-' + _activePid);
    }

    // 3.2 鱼骨图
    if (window.Fishbone) {
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
      window.Fishbone.fishboneData = emptyFb;
      if (typeof window.Fishbone.renderFishboneForm === 'function') {
        window.Fishbone.renderFishboneForm();
      }
      if (_activePid && typeof window.pluginRemove === 'function') {
        window.pluginRemove('qa-fishbone-' + _activePid);
      }
    }

    // 3.3 故障树 (FTA)
    if (window.FTA) {
      if (typeof window.FTA.clear === 'function') {
        // P2-7: await FTA.clear() — clearFtaData 已是 async，未 await 会导致清空写与
        // 后续 pluginRemove 竞态。
        await window.FTA.clear();
      }
      if (_activePid && typeof window.pluginRemove === 'function') {
        window.pluginRemove('qa-fta-' + _activePid);
      }
    }

    // 4. 从示例数据直接生成本地报告（不进工具状态）
    const type = hasTree ? '5why' : hasFb ? 'fishbone' : hasFta ? 'fta' : null;
    const pid =
      type && typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
    if (
      type &&
      pid &&
      typeof window.saveReportToLibrary === 'function' &&
      typeof window.updateProblem === 'function'
    ) {
      // P1-3: await _generateExampleReport — 内部 importData/saveReportToLibrary 均需 await
      await _generateExampleReport(type, data, pid, data._exampleSource);
    }

    // 5. 写入问题列表，附带快照和 _fromExample 标志，确保 nodeCount/rootCauseCount 被同步
    if (_activePid && typeof window.updateProblem === 'function') {
      window.updateProblem(_activePid, {
        title: data.title || '',
        problemStatement: data.phenomenon || '',
        details: JSON.parse(JSON.stringify(data)),
        snapshot: snapshot,
        _fromExample: true
      });
    }

    let hint = '已加载示例：' + (data.title || '未命名');
    hint += '\n→ 前往「报告」查看分析内容';
    showToast(hint, 'success');
  }

  async function loadExample(filename) {
    // 确保有活跃问题并已显示详情界面。如果没有，先创建一个新问题。
    const activeId =
      typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
    const detailView = document.getElementById('problemDetailView');
    const isDetailHidden = !detailView || detailView.classList.contains('hidden');

    let targetId = activeId;
    if (!targetId || isDetailHidden) {
      // 检查当前活跃问题是否为空，若是则复用，否则创建新问题
      let isBlank = false;
      if (activeId && typeof window.getProblemById === 'function') {
        const p = window.getProblemById(activeId);
        if (p && !p.title?.trim() && !p.details?.phenomenon?.trim()) {
          isBlank = true;
        }
      }

      if (isBlank) {
        targetId = activeId;
        if (typeof window.showProblemDetail === 'function') {
          window.showProblemDetail(targetId);
        }
      } else {
        await _ensureNewProblem();
      }
    } else if (targetId) {
      // 用户正在查看/编辑已有问题，检查是否有内容
      const p =
        typeof window.getProblemById === 'function' ? window.getProblemById(targetId) : null;
      if (p && (p.title?.trim() || p.details?.phenomenon?.trim())) {
        const overwrite = await showConfirm(
          '当前问题已有内容，加载示例将覆盖现有数据（表单 + 报告）。\n确定覆盖当前问题？选择“取消”将创建新问题来加载示例。',
          'warning'
        );
        if (!overwrite) {
          await _ensureNewProblem();
        }
      }
    }

    async function _ensureNewProblem() {
      if (
        typeof window.createNewProblem === 'function' &&
        typeof window.showProblemDetail === 'function'
      ) {
        const newProblem = window.createNewProblem({ title: '', status: 'pending' });
        if (newProblem && newProblem.id) {
          targetId = newProblem.id;
          window.showProblemDetail(targetId);
        }
      }
    }

    const data = window.EXAMPLES_DATA?.[filename];
    if (data) {
      data._exampleSource = filename;
      // P1-3: await applyExampleData — 内部 _generateExampleReport 链已改 async
      await applyExampleData(data);

      // 刷新"查看报告"按钮：applyExampleData 生成的报告此时已落盘，
      // 但 showProblemDetail 在之前执行时报告还不存在，按钮被隐藏。
      if (targetId) {
        const reports = (
          typeof window.getReportLibrary === 'function' ? window.getReportLibrary() : []
        ).filter((r) => r.problemId === targetId);
        const viewBtn = document.getElementById('btnViewReports');
        if (viewBtn) {
          viewBtn.style.display = reports.length ? '' : 'none';
        }
      }
    } else {
      showToast('示例数据未找到，请确认 examples-data.js 已加载', 'error');
    }
  }

  /** AI 根据问题现象生成标题 */
  async function generateTitle(titleInputId, btnId) {
    const phenomenonEl =
      document.getElementById('pm-problem-phenomenon') ||
      document.getElementById('problemStatement');
    const phenomenon = phenomenonEl ? phenomenonEl.value.trim() : '';
    if (!phenomenon) {
      showToast('请先填写问题现象', 'error');
      return;
    }
    const titleEl = document.getElementById(titleInputId);
    if (!titleEl) return;
    if (titleEl.value.trim()) {
      const ok = await showConfirm('问题标题已有内容，确定要覆盖吗？');
      if (!ok) return;
    }
    if (!_assertApiReady()) return;

    const btn = document.getElementById(btnId);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '生成中...';
    }

    try {
      const rendered = renderPrompt('generateTitle', { problemStatement: phenomenon });
      const result = await _callAI(rendered.system, rendered.user, false, 512);
      const title = (result || '').trim().replace(/^["']|["']$/g, '');
      if (title && titleEl) {
        titleEl.value = title;
        showToast('标题已生成：' + title, 'success');
      }
    } catch (err) {
      showToast('标题生成失败：' + err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'AI 生成';
      }
    }
  }

  /** 导航到指定工具页面 */
  function navigateToTool(toolId) {
    // 清除示例标记：用户显式点击"分析"即视为开始正式分析
    const activePid =
      typeof window.getActiveProblemId === 'function' ? window.getActiveProblemId() : null;
    if (
      activePid &&
      typeof window.getProblemById === 'function' &&
      typeof window.updateProblem === 'function'
    ) {
      const p = window.getProblemById(activePid);
      if (p && p._fromExample) {
        window.updateProblem(activePid, { _fromExample: false });
      }
    }

    const toolMap = {
      '5-why': 'tool-5why',
      fishbone: 'tool-fishbone',
      fta: 'tool-fta'
    };
    const panelId = toolMap[toolId];
    if (!panelId) {
      showToast('该工具页面暂未实现', 'info');
      return;
    }

    // Validate title is not empty
    const d = collectFormData();
    if (!d.title) {
      showToast('请先填写或 AI 生成问题标题', 'error');
      return;
    }

    // Transfer problem data
    const desc = getProblemDescription();
    if (desc) {
      if (toolId === '5-why') {
        const titleEl = document.getElementById('analysisProblemTitle');
        if (titleEl) titleEl.value = d.title;
        const stmtEl = document.getElementById('problemStatement');
        if (stmtEl) stmtEl.value = desc;
        const ctx = getProblemContext();
        const ctxEl = document.getElementById('problemContext');
        if (ctxEl && ctx) ctxEl.value = ctx;
      } else if (toolId === 'fishbone') {
        const probInput = document.getElementById('fishbone-problem');
        if (probInput) {
          probInput.value = d.title;
          probInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const refEl = document.getElementById('fishbone-phenomenon-ref');
        if (refEl) refEl.value = desc || '';
        const ctx = getProblemContext();
        const ctxEl = document.getElementById('fishbone-context-ref');
        if (ctxEl && ctx) ctxEl.value = ctx;
      } else if (toolId === 'fta') {
        if (window.FTA) {
          const ftd = window.FTA.getData();
          const titleRefEl = document.getElementById('fta-problem-title-ref');
          if (titleRefEl) titleRefEl.value = d.title;
          ftd.metadata.problemTitle = d.title;
          const ctxEl = document.getElementById('fta-problem-context');
          if (ctxEl) {
            ctxEl.value = desc || '';
            ftd.metadata.problemContext = desc || '';
          }
          if (!ftd.rootId) {
            const topEventEl = document.getElementById('fta-top-event');
            if (topEventEl && !topEventEl.value.trim()) topEventEl.value = d.title;
            if (!ftd.topEvent.name) ftd.topEvent.name = d.title;
          }
        }
      }
    }

    // Mark analysis as in_progress so tool panels with auto-fill logic (e.g. FTA) work correctly
    if (
      activePid &&
      typeof window.getProblemById === 'function' &&
      typeof window.updateProblem === 'function'
    ) {
      const _p = window.getProblemById(activePid);
      if (_p) {
        const _analyses = _p.analyses || {};
        const methodKey =
          toolId === '5-why'
            ? '5why'
            : toolId === 'fta'
              ? 'fta'
              : toolId === 'fishbone'
                ? 'fishbone'
                : null;
        if (methodKey && (!_analyses[methodKey] || _analyses[methodKey].status === 'not_started')) {
          _analyses[methodKey] = { status: 'in_progress', lastUpdated: new Date().toISOString() };
          window.updateProblem(activePid, { analyses: _analyses, status: 'analyzing' });
        }
      }
    }

    // Switch to analysis page and activate tool tab
    window.navigateTo('page-analysis', panelId);

    const toolNames = { '5-why': '5 Whys 分析', fishbone: '鱼骨图', fta: '故障树分析' };

    showToast('问题已转入 ' + (toolNames[toolId] || toolId), 'success');
  }

  // ===== Expose API =====
  window.ProblemManager = {
    // v3.0 Facade 接口
    load: load, // load(data) — 加载数据到表单，null 则清空
    getData: getData, // getData() — 返回当前表单数据 + 评估结果
    getAssessment: getAssessment, // getAssessment() — 返回当前评估结果
    evaluate: evaluate, // evaluate() — AI 评估，返回 assessment 对象
    viewAssessment: async function () {
      if (!_assessment || _reportVisible) return;
      _reportVisible = true;
      renderAssessment(_assessment);
      const viewBtn = document.getElementById('btnViewAssessment');
      if (viewBtn) viewBtn.style.display = 'none';
      const changes = _getAssessmentFieldChanges(_assessment);
      if (!changes.length && !_assessment.reportSavedAt) {
        _assessment.reviewStatus = 'no_changes';
        _assessment.reviewedAt = new Date().toISOString();
        await _saveAssessmentReport();
      }
      _openAssessmentReviewSidebar(_assessment);
    },
    clear: clearProblemForm, // clear() — 清空表单和评估

    // 保留的接口（兼容性）
    fillFormData: fillForm, // fillFormData(data) — 填充表单（不含清空）
    collect: collectFormData, // collect() — 仅表单数据（不含评估）
    getProblemDescription: getProblemDescription,
    getProblemContext: getProblemContext,
    getClassification: function () {
      return (
        _assessment?.classificationLabel || _legacyClassificationLabel(_assessment?.classification)
      );
    },
    normalizeAssessment: normalizeAssessment,
    applyAssessmentSuggestions: applyAssessmentSuggestions,
    generateAssessmentMarkdown: generateAssessmentMarkdown,
    generateAssessmentHtml: generateAssessmentHtml,
    navigateToTool: navigateToTool,
    exportProblem: exportProblem,
    importProblem: importProblem,
    generateTitle: generateTitle,
    restoreExampleToTools: _restoreExampleToTools
  };

  // ===== Generate Markdown for AI Assessment =====
  function generateAssessmentMarkdown(r, d) {
    if (!r) return '';
    r = normalizeAssessment(r, d);
    d = d || collectFormData();
    const now = r.savedAt || new Date().toISOString();
    const severityLabels = Labels.severity || {};
    const sourceLabels = Labels.source || {};
    const expectedSourceLabels = {
      regulation: '法规/标准',
      customer: '客户要求',
      internal: '内部规范',
      design: '设计要求',
      historical: '历史基准',
      benchmark: '对标基准',
      other: '其他'
    };
    const trendLabels = { sudden: '突发', gradual: '渐变', intermittent: '间歇' };
    const classificationLabels = {
      occurrencePattern: {
        sporadic: '偶发',
        recurrent: '重复发生',
        systemic: '系统性',
        unknown: '待确认'
      },
      problemNature: {
        execution: '执行',
        process: '过程',
        design: '设计',
        equipment: '设备',
        material: '物料',
        measurement: '测量',
        statistical: '统计波动',
        compliance: '合规',
        unknown: '待确认'
      },
      causalStructure: {
        linear: '线性因果链',
        'multi-branch': '多分支原因',
        'logical-combination': '逻辑组合失效',
        statistical: '统计关系',
        unknown: '待确认'
      },
      informationState: {
        sufficient: '信息较充分',
        partial: '信息部分充分',
        insufficient: '信息不足'
      }
    };
    const reviewLabels = {
      applied: '已审查并应用选定修改',
      skipped: '已审查并保留原表单内容',
      no_changes: '未发现需要修改的安全建议',
      pending: '尚未完成人工审查'
    };

    let md = `# 问题定义与分析方法评估报告\n\n`;

    const _pid = typeof getActiveProblemId === 'function' ? getActiveProblemId() : '';
    if (_pid && typeof getProblemById === 'function') {
      const _rp = getProblemById(_pid);
      if (_rp) {
        if (_rp.displayId) md += `**问题编号：** ${_rp.displayId}\n\n`;
      }
    }
    md += `**问题标题：** ${d.title || '未填写'}\n\n`;
    md += `**评估时间：** ${new Date(now).toLocaleString()}\n\n`;
    md += `**表单审查状态：** ${reviewLabels[r.reviewStatus] || reviewLabels.pending}\n\n`;

    md += `## 1. 问题基本信息\n\n`;
    md += `- **问题现象：** ${d.phenomenon || d.problemStatement || '未填写'}\n`;
    md += `- **严重度：** ${severityLabels[d.severity] || d.severity || '未填写'}\n`;
    md += `- **发生时间：** ${d.time || '未填写'}\n`;
    md += `- **发现方式：** ${sourceLabels[d.discoverySource] || d.discoverySource || '未填写'}\n`;
    md += `- **期望状态：** ${d.expectedState || '未填写'}\n`;
    md += `- **期望值来源：** ${expectedSourceLabels[d.expectedSource] || d.expectedSource || '未填写'}\n`;
    if (d.expectedDetail) md += `- **来源详情：** ${d.expectedDetail}\n`;
    md += `- **问题趋势：** ${trendLabels[d.trend] || d.trend || '未填写'}\n`;
    md += `- **当前临时措施：** ${d.containment || '未填写'}\n\n`;

    md += `## 2. 评估范围与使用限制\n\n`;
    md += `本报告仅依据评估时提供的问题表单信息，对问题定义质量、分析方法适用性进行初步评估。报告不确认根因，不替代正式风险评估、偏差调查、CAPA 审批或质量决策。\n\n`;

    const definition = r.problemDefinition;
    if (definition.refinedStatement) {
      md += `**结构化问题表述建议（需人工确认）：** ${definition.refinedStatement}\n\n`;
    }

    const q = r.quality;
    md += `## 3. 问题定义质量评估 (${q.overall.toFixed(1)}/5)\n\n`;
    [
      { key: 'clarity', label: '清晰度' },
      { key: 'measurability', label: '可测量性' },
      { key: 'scope', label: '范围定义' },
      { key: 'evidence', label: '证据支撑' },
      { key: 'investigability', label: '可调查性' }
    ].forEach((dimInfo) => {
      const dim = q[dimInfo.key];
      md += `- **${dimInfo.label}**：${dim.score}/5 — ${dim.reason}`;
      if (dim.improvement) md += `；补充方式：${dim.improvement}`;
      md += `\n`;
    });
    md += `\n`;

    md += `## 4. 初步优先级判断\n\n`;
    md += `以下评分仅用于确定调查响应顺序，不等同于正式风险分级。\n\n`;
    const priorityLabels = { severity: '严重度', urgency: '紧急度', impact: '影响范围' };
    Object.keys(priorityLabels).forEach((key) => {
      const item = r.priority[key];
      md += `- **${priorityLabels[key]}：** ${item.score}/5 — ${item.reason}\n`;
    });
    md += `\n`;

    md += `## 5. 初步问题分类\n\n`;
    if (r.classification.legacyLabel) md += `- **原分类：** ${r.classification.legacyLabel}\n`;
    md += `- **发生模式：** ${classificationLabels.occurrencePattern[r.classification.occurrencePattern] || '待确认'}\n`;
    md += `- **问题性质：** ${classificationLabels.problemNature[r.classification.problemNature] || '待确认'}\n`;
    md += `- **因果结构：** ${classificationLabels.causalStructure[r.classification.causalStructure] || '待确认'}\n`;
    md += `- **信息状态：** ${classificationLabels.informationState[r.classification.informationState] || '待确认'}\n\n`;

    const recommendation = r.recommendedAnalysis;
    md += `## 6. 分析方法建议\n\n`;
    md += `- **首选方法：** ${{'5-why': '5 Whys', fishbone: '鱼骨图', fta: '故障树', none: ''}[recommendation.primaryMethod] || '暂不开始根因分析'}\n`;
    if (recommendation.reason) md += `- **推荐理由：** ${recommendation.reason}\n`;
    if (recommendation.prerequisites.length)
      md += `- **启动前提：** ${recommendation.prerequisites.join('；')}\n`;
    recommendation.secondaryMethods.forEach((item) => {
      md += `- **后续方法：** ${{'5-why': '5 Whys', fishbone: '鱼骨图', fta: '故障树', none: ''}[item.toolId] || '待确认'}；触发条件：${item.triggerCondition || '待确认'}；用途：${item.purpose || '待确认'}\n`;
    });
    recommendation.supplementaryTools.forEach((item) => {
      const tool = window.QualityToolKB?.getToolById?.(item.toolId);
      md += `- **辅助工具：** ${tool?.name || item.toolId}；${item.reason || '无补充理由'}`;
      if (item.dataRequirements.length) md += `；数据要求：${item.dataRequirements.join('；')}`;
      md += `\n`;
    });
    recommendation.notRecommended.forEach((item) => {
      md += `- **当前不推荐：** ${{'5-why': '5 Whys', fishbone: '鱼骨图', fta: '故障树', none: ''}[item.toolId] || '待确认'} — ${item.reason || '证据不足'}\n`;
    });
    md += `\n`;

    md += `## 7. 下一步调查建议\n\n`;
    if (r.nextActions.length) {
      r.nextActions
        .sort((a, b) => a.priority - b.priority)
        .forEach((item) => {
          md += `${item.priority}. **${item.action}**`;
          if (item.purpose) md += ` — ${item.purpose}`;
          if (item.evidenceRequired) md += `；证据：${item.evidenceRequired}`;
          if (item.ownerRole) md += `；建议角色：${item.ownerRole}`;
          md += `\n`;
        });
      md += `\n`;
    } else {
      md += `暂无结构化调查建议。\n\n`;
    }

    md += `> 说明：以上内容为调查准备建议，不代表已经批准的行动计划、纠正措施或预防措施。\n\n`;

    md += `## 10. 生成与审查信息\n\n`;
    const _model = typeof getActiveModel === 'function' ? getActiveModel() : '未知模型';
    const _usage = window._lastAiUsage;
    const _elapsed = _assessStart ? ((Date.now() - _assessStart) / 1000).toFixed(1) : '?';
    md += window.ReportContract.buildMetadata({
      sourceMode: 'ai',
      model: _model,
      usage: _usage,
      elapsedSeconds: _elapsed,
      generatedAt: now
    });

    return md;
  }

  // ===== Export AI Assessment Report =====
  function exportAssessmentReport() {
    if (!_assessment) {
      showToast('没有可导出的评估数据，请先进行 AI 评估', 'error');
      return;
    }
    if (!['applied', 'skipped', 'no_changes'].includes(_assessment.reviewStatus)) {
      showToast('请先在 AI 侧边栏审查并应用或跳过表单修改', 'warning');
      return;
    }
    const d = collectFormData();
    const md = generateAssessmentMarkdown(_assessment, d);

    const now = new Date().toISOString();

    const safeTitle = (d.title || d.phenomenon || 'AI评估报告')
      .replace(/[^\w一-龥]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
    window.UIUtils.downloadMarkdown(md, `AI-Assessment-${safeTitle}-${now.slice(0, 10)}.md`);
    showToast('AI 评估报告已导出为 Markdown', 'success');
  }

  function exportAssessmentReportWord() {
    if (!_assessment) {
      showToast('没有可导出的评估数据，请先进行 AI 评估', 'error');
      return;
    }
    if (!['applied', 'skipped', 'no_changes'].includes(_assessment.reviewStatus)) {
      showToast('请先在 AI 侧边栏审查并应用或跳过表单修改', 'warning');
      return;
    }
    const d = collectFormData();
    const md = generateAssessmentMarkdown(_assessment, d);
    const now = new Date().toISOString();

    const safeTitle = (d.title || d.phenomenon || 'AI评估报告')
      .replace(/[^\w一-龥]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
    const filename = `AI-Assessment-${safeTitle}-${now.slice(0, 10)}.docx`;

    const htmlBody = window.UIUtils.mdToHtml(md);
    window.UIUtils.downloadDocx(htmlBody, filename);
  }

  // ===== Event Bindings =====
  document.getElementById('btnLoadExample')?.addEventListener('click', showExampleMenu);
  document.getElementById('btnExportAssessment')?.addEventListener('click', exportAssessmentReport);
  document
    .getElementById('btnExportAssessmentWord')
    ?.addEventListener('click', exportAssessmentReportWord);
  document
    .getElementById('btnGenerateTitle')
    ?.addEventListener('click', () => generateTitle('pm-problem-title', 'btnGenerateTitle'));
})();
