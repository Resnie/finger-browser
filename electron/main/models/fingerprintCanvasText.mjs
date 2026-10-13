import { getFingerprintFontAssets } from './fingerprintFontAssets.mjs';

// Identical outlines rendered by Chromium's CPU path rasterizer avoid the host
// font rasterizer. The canvas remains real drawing: text, transforms, colours,
// clipping, shadows, alignment and maxWidth all affect the exported pixels.
export function buildStableCanvasTextScript() {
  const { parser, font } = getFingerprintFontAssets();
  return `(function() {
    if (typeof Path2D === 'undefined') return;
    ${parser}
    const encoded = ${JSON.stringify(font)};
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const table = new Int16Array(128).fill(-1);
    for (let i=0;i<alphabet.length;i++) table[alphabet.charCodeAt(i)]=i;
    const bytes = new Uint8Array(encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0));
    for(let i=0,j=0;i<encoded.length;i+=4) {
      const n=(table[encoded.charCodeAt(i)]<<18)|(table[encoded.charCodeAt(i+1)]<<12)|((table[encoded.charCodeAt(i+2)]&63)<<6)|(table[encoded.charCodeAt(i+3)]&63);
      if(j<bytes.length)bytes[j++]=n>>>16;
      if(j<bytes.length)bytes[j++]=(n>>>8)&255;
      if(j<bytes.length)bytes[j++]=n&255;
    }
    const face = opentype.parse(bytes.buffer, { lowMemory: true });
    const prototypes = [
      typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype,
      typeof OffscreenCanvasRenderingContext2D !== 'undefined' && OffscreenCanvasRenderingContext2D.prototype,
    ].filter(Boolean);
    function layout(ctx, value) {
      const text = String(value);
      const match = ctx.font.match(/([\\d.]+)px\\s+(.+)$/);
      if (!match || /(?:italic|oblique|bold|bolder|lighter|[1-9]00)\\s/.test(ctx.font) || text.length > 4096 || (ctx.wordSpacing && parseFloat(ctx.wordSpacing))) return null;
      // Keep website-provided fonts and unsupported glyphs on the native path.
      if (typeof document !== 'undefined') {
        const families = match[2].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
        for (const loaded of document.fonts || []) {
          if (loaded.status === 'loaded' && families.includes(loaded.family.replace(/^['"]|['"]$/g, '').toLowerCase())) return null;
        }
      }
      if ([...text].some(c => c !== '\\n' && !face.charToGlyphIndex(c))) return null;
      const size = Number(match[1]);
      const options = { hinting: false, kerning: ctx.fontKerning !== 'none', letterSpacing: (parseFloat(ctx.letterSpacing) || 0) / size };
      const path = face.getPath(text, 0, 0, size, options);
      return { path, box: path.getBoundingBox(), width: face.getAdvanceWidth(text, size, options), size };
    }
    function alignment(ctx, width) {
      const rtl = ctx.direction === 'rtl';
      return ctx.textAlign === 'center' ? width/2 : ctx.textAlign === 'right' || ctx.textAlign === (rtl ? 'start' : 'end') ? width : 0;
    }
    function baseline(ctx, size) {
      const asc = face.ascender * size / face.unitsPerEm, desc = face.descender * size / face.unitsPerEm;
      return ctx.textBaseline === 'top' ? asc : ctx.textBaseline === 'hanging' ? asc*0.8 : ctx.textBaseline === 'middle' ? (asc+desc)/2 : ['bottom','ideographic'].includes(ctx.textBaseline) ? desc : 0;
    }
    for (const proto of prototypes) {
      for (const method of ['fillText', 'strokeText']) {
        const original = proto[method];
        proto[method] = function(text, x, y, maxWidth) {
          if (arguments.length < 3) return original.apply(this, arguments);
          const data = layout(this, text);
          if (!data) return original.apply(this, arguments);
          x = Number(x); y = Number(y);
          if (!Number.isFinite(x) || !Number.isFinite(y) || (arguments.length > 3 && (!Number.isFinite(Number(maxWidth)) || Number(maxWidth) <= 0))) return;
          const scale = arguments.length > 3 && data.width > Number(maxWidth) ? Number(maxWidth)/data.width : 1;
          const dx = alignment(this, data.width), dy = baseline(this, data.size);
          const p = new Path2D();
          const px = v => x + (v-dx)*scale, py = v => y+v+dy;
          for (const c of data.path.commands) {
            if(c.type==='M')p.moveTo(px(c.x),py(c.y));
            else if(c.type==='L')p.lineTo(px(c.x),py(c.y));
            else if(c.type==='C')p.bezierCurveTo(px(c.x1),py(c.y1),px(c.x2),py(c.y2),px(c.x),py(c.y));
            else if(c.type==='Q')p.quadraticCurveTo(px(c.x1),py(c.y1),px(c.x),py(c.y));
            else if(c.type==='Z')p.closePath();
          }
          this[method === 'fillText' ? 'fill' : 'stroke'](p);
        };
      }
      const originalMeasure = proto.measureText;
      proto.measureText = function(text) {
        const original = originalMeasure.apply(this, arguments), data = layout(this, text);
        if (!data) return original;
        const dx=alignment(this,data.width), dy=baseline(this,data.size), asc=face.ascender*data.size/face.unitsPerEm, desc=face.descender*data.size/face.unitsPerEm;
        const result=Object.create(Object.getPrototypeOf(original));
        const metrics={width:data.width,actualBoundingBoxLeft:dx-data.box.x1,actualBoundingBoxRight:data.box.x2-dx,actualBoundingBoxAscent:-data.box.y1-dy,actualBoundingBoxDescent:data.box.y2+dy,fontBoundingBoxAscent:asc-dy,fontBoundingBoxDescent:-desc+dy,emHeightAscent:asc-dy,emHeightDescent:-desc+dy,alphabeticBaseline:dy,hangingBaseline:dy-asc*0.8,ideographicBaseline:dy-desc};
        for(const key of Object.keys(metrics))Object.defineProperty(result,key,{value:metrics[key],enumerable:true});
        return result;
      };
    }
  })();`;
}
