export function selectPluginInstallation(installed, version) {
  const candidates = (Array.isArray(installed) ? installed : []).filter(
    (plugin) =>
      plugin?.name === "codex-tps-plus" && plugin?.installed === true && plugin?.enabled === true
  );
  const exact = candidates.find((plugin) => plugin.version === version);
  if (exact) return exact;
  const versionCore = typeof version === "string" ? version.split("+", 1)[0] : null;
  return (
    candidates.find(
      (plugin) =>
        typeof plugin.version === "string" && plugin.version.split("+", 1)[0] === versionCore
    ) || null
  );
}

export function assessOtelExporter(config, receiver) {
  const configured = config?.metricsExporter === "otlp-http";
  const logsConfigured = config?.exporter === "otlp-http";
  let matchesReceiver = false;
  let logsMatchReceiver = false;
  try {
    const configuredUrl = new URL(config?.metricsEndpoint || "");
    const receiverUrl = new URL(receiver?.endpoint || "");
    matchesReceiver =
      configured &&
      config?.metricsEndpointLoopback === true &&
      configuredUrl.hostname === receiverUrl.hostname &&
      configuredUrl.port === receiverUrl.port &&
      configuredUrl.pathname === "/v1/metrics";
    const logsUrl = new URL(config?.exporterEndpoint || "");
    logsMatchReceiver =
      logsConfigured &&
      config?.exporterEndpointLoopback === true &&
      logsUrl.hostname === receiverUrl.hostname &&
      logsUrl.port === receiverUrl.port &&
      logsUrl.pathname === "/v1/logs";
  } catch {}
  return {
    configured,
    loopback: config?.metricsEndpointLoopback === true,
    matchesReceiver,
    logsConfigured,
    logsMatchReceiver,
  };
}

export function assessOtelCaptureIsolation(report) {
  const receiverExclusive =
    report?.receiver?.active === true && report?.receiver?.receiverIdCount === 1;
  const concurrentContamination =
    report?.captureIsolation?.level === "concurrent-conversations-observed" ||
    Number(report?.captureIsolation?.distinctConversationCount) > 1 ||
    Number(report?.receiver?.receiverIdCount) > 1;
  return {
    receiverExclusive,
    concurrentContamination,
    conversationIsolation: report?.captureIsolation?.level || "unknown",
    singleTurnCandidateEligible:
      !concurrentContamination && report?.captureIsolation?.singleTurnCandidateEligible === true,
  };
}
