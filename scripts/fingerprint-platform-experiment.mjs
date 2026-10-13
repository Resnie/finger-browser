import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const control = 'http://192.168.50.221:19092';
const meta = await fetch(control + '/runtime-config.json').then(r => r.json());
const rows = [];
for (const version of ['140.0.7259', '144.0.7500']) {
  const executablePath = process.env.FINGER_KERNEL_EXEC.replace(/140\.0\.7259/g, version);
  for (const profile of meta.profiles) {
    const script = await fetch(control + '/' + profile.id + '.js').then(r => r.text());
    const workerScript = await fetch(control + '/' + profile.id + '-worker.js').then(r => r.text());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-fingerprint-runtime-'));
    const [width, height] = profile.config.screenResolution.split('x').map(Number);
    const context = await chromium.launchPersistentContext(dir, {
      executablePath, headless: false, viewport: { width, height }, locale: 'zh-CN',
      timezoneId: profile.config.timezone,
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split('.')[0]}.0.0.0 Safari/537.36`,
      args: ['--disable-gpu', '--force-color-profile=srgb'],
    });
    try {
      await context.addInitScript(script);
      const installer = eval('({' + meta.workerInstaller + '})');
      installer.getWorkerInjectionScript = () => workerScript;
      await installer.installWorkerFingerprints(context, console);
      const page = context.pages()[0] || await context.newPage();
      await page.goto('http://192.168.50.221:19090/');
      const output = await page.evaluate(() => collectFingerprint());
      const apiChecks = await page.evaluate(async () => {
        const draw = x => { x.fillStyle='rgb(50,100,150)';x.fillRect(0,0,128,32);x.font='14px Arial';x.fillStyle='#edec57';x.fillText('Browser 0123 Ω 中文',4,25); };
        const canvas=document.createElement('canvas');canvas.width=128;canvas.height=32;const ctx=canvas.getContext('2d');draw(ctx);
        const full=ctx.getImageData(0,0,128,32).data,crop=ctx.getImageData(1,1,2,2).data;
        const cropMatches=[...crop].every((v,i)=>v===full[4*((1+Math.floor(i/4/2))*128+1+(Math.floor(i/4)%2))+i%4]);
        const offscreen=new OffscreenCanvas(128,32);draw(offscreen.getContext('2d'));
        const encoded=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);offscreen.convertToBlob({type:'image/png'}).then(blob=>reader.readAsDataURL(blob));});
        const sameExport=encoded===canvas.toDataURL();
        let missingArgumentsRejected=false;try{ctx.fillText('x')}catch{missingArgumentsRejected=true}
        return {cropMatches,sameExport,missingArgumentsRejected};
      });
      if (!Object.values(apiChecks).every(Boolean)) throw Error('Canvas API consistency failed: '+JSON.stringify(apiChecks));
      const canonical = JSON.stringify({ identity: output.identity, signals: output.signals });
      rows.push({ id: profile.id, version, ...output, apiChecks, hash: createHash('sha256').update(canonical).digest('hex') });
    } finally { await context.close(); await fs.rm(dir, { recursive: true, force: true }); }
  }
}
const response = await fetch(control + '/result/' + process.platform, { method: 'POST', body: JSON.stringify({ platform: process.platform, rows }) });
if (response.status !== 201) throw Error('Report post failed');
console.log(JSON.stringify(rows.map(r => ({ id: r.id, version: r.version, hash: r.hash, checks: r.checks }))));
