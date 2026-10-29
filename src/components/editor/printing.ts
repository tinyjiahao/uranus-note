export function installPrintImages(root: HTMLElement) {
  const original = new Map<HTMLImageElement, string | null>();
  const images = () => root.querySelectorAll<HTMLImageElement>("img[data-attachment-id]");
  const before = () => { images().forEach(image => { if (!original.has(image)) original.set(image, image.getAttribute("loading")); image.loading = "eager"; }); };
  const after = () => { original.forEach((value, image) => value === null ? image.removeAttribute("loading") : image.setAttribute("loading", value)); original.clear(); };
  window.addEventListener("beforeprint", before); window.addEventListener("afterprint", after);
  return { cleanup: () => { after(); window.removeEventListener("beforeprint", before); window.removeEventListener("afterprint", after); },
    print: async () => { before(); try { await Promise.all([...images()].map(image => image.decode())); window.print(); } finally { after(); } },
  };
}
