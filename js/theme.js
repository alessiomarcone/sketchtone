// Runs before the page paints: light by default, dark if you chose it (no flash).
try { document.documentElement.dataset.theme = localStorage.getItem('sketchtone.theme') || 'light'; } catch (e) { document.documentElement.dataset.theme = 'light'; }
