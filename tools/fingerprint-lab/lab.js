const params = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
$('run').value = params.get('run') || 'manual';
$('label').value = params.get('label') || '';
let result;
const cell = (row, text) => {
  const td = document.createElement('td');
  td.textContent = text;
  row.append(td);
  return td;
};
const kernel = identity =>
  identity.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1] || 'unknown';
async function refresh() {
  const response = await fetch(`/api/observations?run=${encodeURIComponent($('run').value)}`);
  if (!response.ok) throw new Error('无法读取对照结果');
  result = await response.json();
  $('count').textContent = result.samples.length;
  $('unique').textContent = result.uniqueBrowsers;
  $('signals').textContent = result.uniqueSignals;
  $('groups').replaceChildren();
  $('samples').replaceChildren();
  for (const group of result.groups) {
    const tr = document.createElement('tr');
    cell(tr, group.label);
    cell(tr, group.samples);
    const state = cell(tr, group.samples < 2 ? '待复采' : group.stable ? '稳定' : '发生变化');
    state.className = group.stable ? 'pass' : 'fail';
    cell(tr, group.fingerprintIds.map(id => id.slice(0, 20)).join(' / '));
    $('groups').append(tr);
  }
  for (const sample of result.samples.slice().reverse()) {
    const tr = document.createElement('tr');
    cell(tr, `${sample.label} / ${sample.phase}`);
    cell(tr, `${kernel(sample.identity)} · ${sample.identity.platform}`);
    cell(tr, sample.componentHashes.canvas.slice(0, 16));
    cell(tr, sample.componentHashes.audio.slice(0, 16));
    const peer = sample.request.peer || '未知';
    cell(tr, sample.request.proxy ? `${peer} / 测试标记：${sample.request.proxy}` : peer);
    $('samples').append(tr);
  }
  return result;
}
async function collect() {
  $('collect').disabled = true;
  $('status').textContent = '正在读取 Canvas、WebGL、Audio、布局及 iframe / Worker…';
  try {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test($('run').value))
      throw new Error('批次仅允许字母、数字、下划线和短横线');
    if (!$('label').value.trim()) throw new Error('请填写窗口标签');
    const probe = await collectFingerprint();
    const response = await fetch('/api/observations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        run: $('run').value,
        label: $('label').value.trim(),
        phase: params.get('phase') || 'manual',
        probe,
      }),
    });
    const sample = await response.json();
    if (!response.ok) throw new Error(sample.error);
    globalThis.lastFingerprintObservation = sample;
    $('id').textContent = sample.fingerprintId;
    $('identity').textContent =
      `${kernel(sample.identity)} · ${sample.identity.platform} · ${sample.identity.language} · ${sample.identity.timezone} · ${sample.identity.hardwareConcurrency} CPU · ${sample.identity.deviceMemory} GB`;
    $('details').textContent = JSON.stringify(
      { components: sample.componentHashes, checks: sample.checks, request: sample.request },
      null,
      2
    );
    await refresh();
    $('status').textContent = '采集完成。可打开另一个窗口，或重开当前窗口后再采集。';
    document.title = `指纹验证 ${sample.fingerprintId.slice(0, 12)}`;
  } catch (error) {
    $('status').textContent = `采集失败：${error.message}`;
    globalThis.fingerprintError = error.message;
  } finally {
    $('collect').disabled = false;
  }
}
$('collect').onclick = collect;
$('refresh').onclick = () =>
  refresh().catch(error => {
    $('status').textContent = error.message;
  });
$('export').onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(result || {}, null, 2)], { type: 'application/json' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `fingerprint-${$('run').value}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
refresh().catch(error => {
  $('status').textContent = error.message;
});
if (params.get('auto') === '1') collect();
