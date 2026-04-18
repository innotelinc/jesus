(function () {
  try {
    var stored = localStorage.getItem('theme-storage');
    var theme = stored ? JSON.parse(stored).state.theme : 'system';
    var systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var resolved = theme === 'system' ? systemTheme : theme;
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(resolved);
  } catch (e) {
    document.documentElement.classList.add('light');
  }
})();
