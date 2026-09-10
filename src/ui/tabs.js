/** Apply the WAI-ARIA tabs keyboard/focus contract to the app navigation. */
export function initTabs({ root = document, activate }) {
  const tabs = () => [...root.querySelectorAll('[role="tab"]')].filter(tab => !tab.hidden);
  const select = (tab, focus = false) => {
    activate(tab.dataset.view);
    if (focus) tab.focus();
  };
  for (const tab of tabs()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const visible = tabs();
      const index = visible.indexOf(tab);
      let next;
      if (event.key === 'ArrowRight') next = visible[(index + 1) % visible.length];
      if (event.key === 'ArrowLeft') next = visible[(index - 1 + visible.length) % visible.length];
      if (event.key === 'Home') next = visible[0];
      if (event.key === 'End') next = visible.at(-1);
      if (!next) return;
      event.preventDefault();
      select(next, true);
    });
  }
}

export function syncTabs(root, activeView, pinnedQueue) {
  for (const tab of root.querySelectorAll('[role="tab"]')) {
    const selected = tab.dataset.view === activeView;
    tab.hidden = pinnedQueue && tab.dataset.view === 'queue';
    tab.setAttribute('aria-selected', String(selected));
    tab.setAttribute('tabindex', selected ? '0' : '-1');
  }
}
