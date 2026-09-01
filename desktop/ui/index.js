const params = new URLSearchParams(location.search);
const state = params.get("state");
const detail = params.get("detail");
const title = document.getElementById("title");
const message = document.getElementById("message");
const detailEl = document.getElementById("detail");

if (state === "error") {
  title.textContent = "OpenCodex could not start";
  message.textContent =
    "The desktop shell could not attach to a ready local proxy. The app stays open so the error remains visible.";
} else if (state === "quit-failed") {
  title.textContent = "Quit did not finish";
  message.textContent =
    "The stop transaction failed or could not be confirmed. The app stays open and has not exited.";
} else if (state === "stopped") {
  title.textContent = "Proxy stopped";
  message.textContent =
    "The dashboard is no longer available. Use the tray to open, check status, or quit.";
}

if (detail) {
  detailEl.textContent = detail;
}

window.__ocxApplyAndAckShell = function ocxApplyAndAckShell(
  titleText,
  messageText,
  detailText,
  marker,
  epoch,
  attempt
) {
  if (!title || !message || !detailEl) return false;
  if (typeof marker !== "string" || typeof attempt !== "string" || !marker || !attempt) {
    return false;
  }
  title.textContent = titleText;
  message.textContent = messageText;
  detailEl.textContent = detailText;
  if (
    title.textContent !== titleText
    || message.textContent !== messageText
    || detailEl.textContent !== detailText
  ) {
    return false;
  }
  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (typeof invoke !== "function") return false;
  invoke("ack_shell_render", { marker, epoch, attempt });
  return true;
};
