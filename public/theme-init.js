(function () {
  try {
    var theme = localStorage.getItem("uranus.theme") || "system";
    var dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (_) {
    // Theme initialization must never block the application shell.
  }
})();
