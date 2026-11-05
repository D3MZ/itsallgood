(() => {
  const handle = document.getElementById("resize-popup");
  const desktop = matchMedia("(hover: hover) and (pointer: fine)");
  const minimum = { width: 360, height: 340 };
  const maximum = { width: 800, height: 600 };
  let drag;
  let changed = false;
  let pendingSave = Promise.resolve();

  function setSize(width, height) {
    const maxWidth = Math.max(minimum.width, Math.min(maximum.width, screen.availWidth || maximum.width));
    const maxHeight = Math.max(minimum.height, Math.min(maximum.height, screen.availHeight || maximum.height));
    const size = {
      width: Math.round(Math.max(minimum.width, Math.min(maxWidth, width))),
      height: Math.round(Math.max(minimum.height, Math.min(maxHeight, height)))
    };
    document.body.style.width = `${size.width}px`;
    document.body.style.height = `${size.height}px`;
    return size;
  }

  function currentSize() {
    const { width, height } = document.body.getBoundingClientRect();
    return { width, height };
  }

  function saveSize() {
    const popupSize = currentSize();
    pendingSave = pendingSave.then(() => browser.storage.local.set({ popupSize })).catch(() => {
      console.warn("Could not save panel size.");
    });
  }

  if (desktop.matches) {
    browser.storage.local.get("popupSize").then(({ popupSize }) => {
      if (!changed && popupSize && Number.isFinite(popupSize.width) && Number.isFinite(popupSize.height)) {
        setSize(popupSize.width, popupSize.height);
      }
    }).catch(() => {});
  }

  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !desktop.matches) return;
    event.preventDefault();
    changed = true;
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY, ...currentSize() };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!(event.buttons & 1)) { finishDrag(event); return; }
    setSize(drag.width + event.screenX - drag.x, drag.height + event.screenY - drag.y);
  });
  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    saveSize();
  }
  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", finishDrag);
  handle.addEventListener("lostpointercapture", finishDrag);
  handle.addEventListener("keydown", event => {
    const step = event.shiftKey ? 40 : 10;
    const delta = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, -step], ArrowDown: [0, step]
    }[event.key];
    if (!delta || !desktop.matches) return;
    event.preventDefault();
    changed = true;
    const size = currentSize();
    setSize(size.width + delta[0], size.height + delta[1]);
    saveSize();
  });
})();
