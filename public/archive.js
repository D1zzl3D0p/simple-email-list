(() => {
  const index = document.querySelector(".archive-index");
  const toggle = document.querySelector(".archive-timeline-toggle");
  if (!index || !toggle) return;
  const yearGroups = [...index.querySelectorAll(".archive-year")];
  const monthGroups = [...index.querySelectorAll(".archive-month-group")];
  const selected = index.querySelector('[aria-current="page"]');
  const initialMonth =
    selected?.closest(".archive-month-group") || monthGroups[0];
  if (!initialMonth) return;
  let year = initialMonth.dataset.year;
  let month = initialMonth.dataset.month;
  const controls = index.querySelector(".archive-index-controls");
  const years = index.querySelector(".archive-years");
  const months = index.querySelector(".archive-months");
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  let open = false;
  function choice(label, value, selectedValue, select) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "archive-index-choice";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(value === selectedValue));
    button.addEventListener("click", () => select(value));
    return button;
  }
  function positionTimeline() {
    if (!open) return;
    const anchor = toggle.getBoundingClientRect();
    const toolbar = toggle.parentElement.getBoundingClientRect();
    const container = index.offsetParent.getBoundingClientRect();
    const width = index.getBoundingClientRect().width;
    const rightLimit = document.documentElement.clientWidth - 16 - width;
    const left = Math.max(16, Math.min(anchor.left, rightLimit));
    index.style.left = `${left - container.left}px`;
    index.style.top = `${Math.max(anchor.bottom, toolbar.bottom) - container.top + 8}px`;
  }
  window.addEventListener("resize", positionTimeline);
  function render() {
    index.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    years.replaceChildren(
      ...yearGroups.map((group) =>
        choice(group.dataset.year, group.dataset.year, year, (value) => {
          year = value;
          const available = monthGroups.filter(
            (group) => group.dataset.year === year,
          );
          if (!available.some((group) => group.dataset.month === month))
            month = available[0].dataset.month;
          render();
        }),
      ),
    );
    months.replaceChildren(
      ...monthNames.map((name) => {
        const button = choice(name.slice(0, 3), name, month, (value) => {
          month = value;
          render();
        });
        button.setAttribute("aria-label", name + " " + year);
        button.disabled = !monthGroups.some(
          (group) =>
            group.dataset.year === year && group.dataset.month === name,
        );
        return button;
      }),
    );
    for (const group of yearGroups) group.hidden = group.dataset.year !== year;
    for (const group of monthGroups)
      group.hidden =
        group.dataset.year !== year || group.dataset.month !== month;
    positionTimeline();
  }
  // Keep keyboard focus on the same choice after rebuilding the controls.
  controls.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const inYears = button.parentElement === years;
      const label = button.textContent;
      requestAnimationFrame(() => {
        if (!open) return;
        const container = inYears ? years : months;
        [...container.querySelectorAll("button")]
          .find((candidate) => candidate.textContent === label)
          ?.focus({ preventScroll: true });
      });
    },
    true,
  );
  function closeTimeline(restoreFocus = false) {
    if (!open) return;
    const focusWasInside = index.contains(document.activeElement);
    open = false;
    render();
    if (restoreFocus || focusWasInside) toggle.focus({ preventScroll: true });
    // A pointer's default action may blur the restored focus on plain text.
    if (focusWasInside)
      requestAnimationFrame(() => {
        if (!open && document.activeElement === document.body)
          toggle.focus({ preventScroll: true });
      });
  }
  toggle.addEventListener("click", () => {
    open = !open;
    render();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!index.contains(event.target) && !toggle.contains(event.target))
      closeTimeline();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeTimeline(true);
    }
  });
  index.classList.add("is-enhanced");
  controls.hidden = false;
  toggle.hidden = false;
  render();
})();
