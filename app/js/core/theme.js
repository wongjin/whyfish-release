/**
 * theme.js — 首帧主题恢复、即时切换与本机持久化
 * 必须在主样式表之前同步加载，避免页面先显示默认色再闪烁。
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'whyfish-ui-theme';
  const DEFAULT_THEME = 'emerald';
  const THEMES = Object.freeze({
    emerald: { label: '翠绿' },
    rose: { label: '莓红' },
    indigo: { label: '靛蓝' },
    mist: { label: '雾蓝' }
  });

  function normalizeTheme(theme) {
    return Object.prototype.hasOwnProperty.call(THEMES, theme) ? theme : DEFAULT_THEME;
  }

  function readStoredTheme() {
    try {
      return normalizeTheme(localStorage.getItem(STORAGE_KEY));
    } catch (_) {
      return DEFAULT_THEME;
    }
  }

  function syncControls(theme, announce) {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('input[name="ui-theme"]').forEach((input) => {
      input.checked = input.value === theme;
    });
    if (announce) {
      const status = document.getElementById('themeStatus');
      if (status) status.textContent = `已切换为${THEMES[theme].label}主题`;
    }
  }

  function applyTheme(theme, options) {
    const normalized = normalizeTheme(theme);
    const opts = options || {};
    document.documentElement.dataset.theme = normalized;
    if (opts.persist !== false) {
      try {
        localStorage.setItem(STORAGE_KEY, normalized);
      } catch (_) {
        // 隐私模式或存储被禁用时，仍保留当前会话的主题。
      }
    }
    syncControls(normalized, opts.announce === true);
    if (opts.notify !== false) {
      window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: normalized } }));
    }
    return normalized;
  }

  function initThemeControls() {
    syncControls(getTheme(), false);
    document.querySelector('.theme-options')?.addEventListener('change', (event) => {
      const input = event.target.closest('input[name="ui-theme"]');
      if (input) applyTheme(input.value, { announce: true });
    });
  }

  function getTheme() {
    return normalizeTheme(document.documentElement.dataset.theme);
  }

  window.ThemeManager = Object.freeze({
    STORAGE_KEY,
    DEFAULT_THEME,
    THEMES,
    applyTheme,
    getTheme
  });

  applyTheme(readStoredTheme(), { persist: false, notify: false });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initThemeControls, { once: true });
  } else {
    initThemeControls();
  }
})();
