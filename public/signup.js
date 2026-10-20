document.querySelector("form")?.addEventListener("submit", function () {
  const button = this.querySelector("button");
  button.textContent = "Saving your signup…";
});
