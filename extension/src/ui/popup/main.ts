import "../base.css";

const versionElement = document.querySelector<HTMLParagraphElement>("#version");
const optionsButton = document.querySelector<HTMLButtonElement>("#open-options");

if (versionElement) {
  versionElement.textContent = `v${chrome.runtime.getManifest().version}`;
}

optionsButton?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});
