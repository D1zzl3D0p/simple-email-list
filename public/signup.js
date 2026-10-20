// Choose a widget that fits before Turnstile initializes on narrow screens.
const challenge = document.querySelector(".cf-turnstile");
if (challenge && challenge.clientWidth < 300) {
  challenge.dataset.size = "compact";
}

document.querySelector("form")?.addEventListener("submit", function () {
  const button = this.querySelector("button");
  button.textContent = "Signing you up…";
});
