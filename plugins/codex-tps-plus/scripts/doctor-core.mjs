export function selectPluginInstallation(installed, version) {
  const candidates = (Array.isArray(installed) ? installed : []).filter(
    (plugin) =>
      plugin?.name === "codex-tps-plus" && plugin?.installed === true && plugin?.enabled === true
  );
  return candidates.find((plugin) => plugin.version === version) || candidates[0] || null;
}
