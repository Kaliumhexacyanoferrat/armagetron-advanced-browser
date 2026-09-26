// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Menus by keyboard, like the original's (src/ui/uMenu.cpp): up and down move
// between the items and wrap around, left and right change the value of the
// item (a choice, a slider, a colour), Enter or Space selects, Escape leaves
// (the dialog or the caller handles that).

const ITEMS = 'button, input, select, a[href], [data-nav]';

function usable(el) {
  return !el.disabled && el.tabIndex !== -1 && el.getClientRects().length > 0 && !el.closest('[hidden]');
}

function typing(el) {
  return el?.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(el.type);
}

// Up or down from el: the same column of a grid of items (data-row, data-col),
// otherwise the next item in document order.
function vertical(list, el, d) {
  if (el?.dataset.row !== undefined) {
    const row = Number(el.dataset.row) + d, col = el.dataset.col;
    const same = list.find((x) => x.dataset.row === String(row) && x.dataset.col === col);
    if (same) return same;
  }
  const n = list.length;
  const i = list.indexOf(el);
  if (i < 0) return list[d > 0 ? 0 : n - 1];
  if (el?.dataset.row !== undefined) {
    // leaving the grid: past its first or last row
    let j = i;
    while (j >= 0 && j < n && list[j].dataset.row === el.dataset.row) j += d;
    return list[(j + n) % n];
  }
  return list[(i + d + n) % n];
}

/**
 * Handles one key for the menu in root. Returns true if the key was used.
 * onLeftRight(el, d) may change the value of an item and return true.
 */
export function navigate(root, e, { onLeftRight } = {}) {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  const el = root.contains(document.activeElement) ? document.activeElement : null;
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowDown': {
      const list = [...root.querySelectorAll(ITEMS)].filter(usable);
      if (!list.length) return false;
      vertical(list, el, e.key === 'ArrowDown' ? 1 : -1)?.focus();
      break;
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (!el) return false;
      const d = e.key === 'ArrowRight' ? 1 : -1;
      if (typing(el) || el.type === 'range') return false;       // the caret, the slider's own step
      if (onLeftRight?.(el, d)) break;
      if (el.tagName === 'SELECT') {
        const i = Math.max(0, Math.min(el.length - 1, el.selectedIndex + d));
        if (i === el.selectedIndex) break;
        el.selectedIndex = i;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
      if (el.type === 'checkbox') {
        if (el.checked !== d > 0) el.click();
        break;
      }
      // a row of buttons (key slots, colour presets, kick/ban): along the row
      let siblings;
      if (el.dataset.row !== undefined) {
        siblings = [...root.querySelectorAll(`[data-row="${el.dataset.row}"]`)].filter(usable);
      } else {
        const row = el.closest('tr, .presets, .actions');
        siblings = row ? [...row.querySelectorAll(ITEMS)].filter(usable) : [];
      }
      const k = siblings.indexOf(el);
      if (k < 0 || !siblings[k + d]) return false;
      siblings[k + d].focus();
      break;
    }
    case 'Enter':
      if (typing(el) || el?.tagName === 'SELECT') return false;   // a form submits, a list opens
      if (!el?.matches('[data-nav]')) return false;               // buttons click by themselves
      el.click();
      break;
    default:
      return false;
  }
  e.preventDefault();
  e.stopPropagation();
  return true;
}
