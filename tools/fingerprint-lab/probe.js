// The server hashes actual browser output. Labels, cookies, IPs and timestamps
// are deliberately excluded from the fingerprint identity.
globalThis.collectFingerprint = async function () {
  const safe = async fn => {
    try {
      return await fn();
    } catch (error) {
      return { unavailable: error.name };
    }
  };
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(50,100,150)';
  ctx.fillRect(0, 0, 128, 32);
  ctx.fillStyle = 'rgb(120,40,20)';
  ctx.fillRect(6, 3, 24, 10);
  ctx.font = '14px Arial';
  ctx.fillStyle = '#edec57';
  ctx.fillText('Browser 0123 Ω 中文', 4, 25);
  const exported = canvas.toDataURL();
  const repeated = canvas.toDataURL();
  const pixels = Array.from(ctx.getImageData(0, 0, 128, 32).data);
  const audio = await safe(async () => {
    const context = new OfflineAudioContext(1, 1024, 44100);
    const oscillator = context.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 1000;
    oscillator.connect(context.destination);
    oscillator.start();
    const result = await context.startRendering();
    return Array.from(result.getChannelData(0));
  });
  const webgl = await safe(() =>
    ['webgl', 'webgl2'].map(kind => {
      const gl = document.createElement('canvas').getContext(kind);
      if (!gl) return { kind, available: false };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gl.clearColor(0.25, 0.5, 0.75, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const bytes = new Uint8Array(16);
      gl.readPixels(0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return {
        kind,
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '',
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '',
        pixels: [...bytes],
      };
    })
  );
  const element = document.createElement('div');
  element.style.cssText =
    'position:absolute;left:10px;top:20px;width:100px;height:30px;visibility:hidden';
  document.body.append(element);
  const rect = element.getBoundingClientRect();
  const geometry = [rect.x, rect.y, rect.width, rect.height];
  element.remove();
  const identity = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: [...navigator.languages],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: [screen.width, screen.height, screen.colorDepth],
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    doNotTrack: navigator.doNotTrack,
    uaData: navigator.userAgentData
      ? {
          platform: navigator.userAgentData.platform,
          mobile: navigator.userAgentData.mobile,
          brands: navigator.userAgentData.brands,
        }
      : null,
  };
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.append(iframe);
  const frame = iframe.contentWindow;
  const iframeIdentity = {
    userAgent: frame.navigator.userAgent,
    platform: frame.navigator.platform,
    language: frame.navigator.language,
    hardwareConcurrency: frame.navigator.hardwareConcurrency,
  };
  const frameCanvas = frame.document.createElement('canvas');
  frameCanvas.width = 128;
  frameCanvas.height = 32;
  const frameCtx = frameCanvas.getContext('2d');
  frameCtx.fillStyle = 'rgb(50,100,150)';
  frameCtx.fillRect(0, 0, 128, 32);
  frameCtx.fillStyle = 'rgb(120,40,20)';
  frameCtx.fillRect(6, 3, 24, 10);
  frameCtx.font = '14px Arial';
  frameCtx.fillStyle = '#edec57';
  frameCtx.fillText('Browser 0123 Ω 中文', 4, 25);
  const iframeCanvas = frameCanvas.toDataURL();
  iframe.remove();
  const readWorker = async type =>
    safe(
      () =>
        new Promise((resolve, reject) => {
          const code = `onmessage=()=>{const c=new OffscreenCanvas(128,32);const x=c.getContext('2d');x.fillStyle='rgb(50,100,150)';x.fillRect(0,0,128,32);postMessage({userAgent:navigator.userAgent,platform:navigator.platform,language:navigator.language,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory,pixels:Array.from(x.getImageData(0,0,2,2).data)});};`;
          const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          const w = new Worker(url, { type });
          const finish = () => {
            clearTimeout(timer);
            w.terminate();
            URL.revokeObjectURL(url);
          };
          const timer = setTimeout(() => {
            finish();
            reject(new Error('Worker timeout'));
          }, 3000);
          w.onmessage = event => {
            finish();
            resolve(event.data);
          };
          w.onerror = error => {
            finish();
            reject(error);
          };
          w.postMessage({});
        })
    );
  const worker = await readWorker('classic');
  const moduleWorker = await readWorker('module');
  return {
    identity,
    signals: { canvas: exported, canvasPixels: pixels, audio, webgl, clientRects: geometry },
    checks: {
      canvasRepeatStable: exported === repeated,
      iframeIdentity,
      iframeCanvasMatches: exported === iframeCanvas,
      worker,
      moduleWorker,
      webdriver: navigator.webdriver ?? null,
      secureContext: isSecureContext,
    },
  };
};
