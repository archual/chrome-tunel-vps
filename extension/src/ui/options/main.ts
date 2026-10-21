import "../base.css";

const versionElement = document.querySelector<HTMLParagraphElement>("#version");

if (versionElement) {
  versionElement.textContent = `v${chrome.runtime.getManifest().version}`;
}
