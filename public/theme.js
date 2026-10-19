// A new preference defaults existing installations to the requested system mode.
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let themeMode = localStorage.getItem('horizon:theme-mode') || 'auto';
if (!['auto', 'light', 'dark'].includes(themeMode)) themeMode = 'auto';
let themeButton;
function applyTheme() {
  const theme = themeMode === 'auto' ? (systemTheme.matches ? 'dark' : 'light') : themeMode;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.append(meta); }
  meta.content = theme === 'dark' ? '#191a18' : '#ffffff';
  if (themeButton) {
    themeButton.innerHTML = themeMode === 'auto'
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none"/></svg>'
      : {light:'☀', dark:'☾'}[themeMode];
    const label = `Theme: ${themeMode}. Switch to ${{auto:'light', light:'dark', dark:'auto'}[themeMode]}`;
    themeButton.setAttribute('aria-label', label); themeButton.title = label;
  }
}
applyTheme();
systemTheme.addEventListener('change', applyTheme);
document.addEventListener('DOMContentLoaded', () => {
  themeButton = document.createElement('button'); themeButton.id = 'theme-toggle'; themeButton.className = 'icon-button';
  themeButton.onclick = () => {
    themeMode = {auto:'light', light:'dark', dark:'auto'}[themeMode];
    localStorage.setItem('horizon:theme-mode', themeMode); applyTheme();
  };
  applyTheme(); document.querySelector('.topbar-tools')?.prepend(themeButton);
});
