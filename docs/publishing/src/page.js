// Runs inside every cover / carousel template.
//
// 1. Fills <div class="shot" data-shot="deck" data-crop="x,y,w,h" data-scale="1"> with the screenshot
//    docs/screenshots/<name>.png. Crop and size are in logical UI pixels (the plugin window is 1000×640);
//    2x screenshots (≥ 1600 px wide) are drawn at half size, so a later re-render with retina
//    screenshots gets sharper without touching the templates. render.mjs passes the list of
//    available screenshots as window.__SHOTS__; opened directly in a browser, the relative path is used.
// 2. Adds the brand footer to <footer class="brand">.
// 3. Sets window.__READY__ once fonts and images are loaded.
(function () {
  const SHOTS = window.__SHOTS__ || null;

  for (const el of document.querySelectorAll('[data-shot]')) {
    const name = el.dataset.shot;
    const info = SHOTS ? SHOTS[name] : { url: `../../screenshots/${name}.png`, w: 1000, h: 640 };
    const dpr = info && info.w >= 1600 ? 2 : 1;
    const lw = info ? info.w / dpr : 1000;
    const lh = info ? info.h / dpr : 640;
    const [x, y, w, h] = (el.dataset.crop || `0,0,${lw},${lh}`).split(',').map(Number);
    const scale = Number(el.dataset.scale || 1);
    el.style.width = `${w * scale}px`;
    el.style.height = `${h * scale}px`;
    if (!info) {
      el.classList.add('missing');
      el.textContent = `missing: docs/screenshots/${name}.png`;
      continue;
    }
    const img = new Image();
    img.alt = '';
    img.style.left = `${-x * scale}px`;
    img.style.top = `${-y * scale}px`;
    img.style.width = `${lw * scale}px`;
    img.style.height = `${lh * scale}px`;
    img.src = info.url;
    el.appendChild(img);
  }

  for (const footer of document.querySelectorAll('footer.brand')) {
    footer.innerHTML =
      '<img src="icon.svg" alt=""><span>Ewento Slides</span><span class="dot">·</span>' +
      '<span class="note">100% local · no network · free</span>';
  }

  const images = [...document.images].map((img) => img.decode().catch(() => undefined));
  Promise.all([document.fonts.ready, ...images]).then(() => {
    window.__READY__ = true;
  });
})();
