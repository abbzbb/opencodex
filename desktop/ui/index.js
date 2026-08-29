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
