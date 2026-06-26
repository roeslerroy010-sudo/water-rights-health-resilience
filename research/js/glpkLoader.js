// glpkLoader.js
// Loads the local browser GLPK adapter so ResearchNetworkModel can use its LP path.

window.glpkReady = (async function loadGlpk() {
  try {
    const module = await import('../vendor/glpk.js/dist/index.js');
    const createGlpk = module.default;
    const glpk = await createGlpk();
    window.glpk = glpk;
    return glpk;
  } catch (error) {
    window.glpkLoadError = error;
    console.warn('GLPK browser adapter failed to load; heuristic fallback remains available.', error);
    return null;
  }
})();
