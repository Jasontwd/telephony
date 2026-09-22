// Only dimensions are shared with the two approved Formtech storefront origins.
(() => {
  if (window.parent === window) return;
  let last = 0;
  const notify = () => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    for (const origin of ['https://formtech.co.nz', 'https://www.formtech.co.nz']) {
      window.parent.postMessage({type:'formtech:resize',height}, origin);
    }
  };
  new ResizeObserver(notify).observe(document.body);
  window.addEventListener('load', notify);
  notify();
})();
