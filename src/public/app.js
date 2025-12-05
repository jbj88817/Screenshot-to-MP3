(() => {
  const file = document.getElementById('file');
  const runOcr = document.getElementById('runOcr');
  const pasteZone = document.getElementById('pasteZone');
  const list = document.getElementById('list');
  const downloadBtn = document.getElementById('download');
  const addRowBtn = document.getElementById('addRow');
  const statusEl = document.getElementById('status');
  const { ocrEndpoint } = window.__APP_CONFIG__;

  const rows = [];

  const urlPattern = /^https?:\/\/\S+/i;
  const makeTrackPayload = (value) => {
    const trimmed = (value || '').trim();
    if (!trimmed) return {};
    return urlPattern.test(trimmed) ? { url: trimmed } : { query: trimmed };
  };

  function render() {
    list.innerHTML = '';
    rows.forEach((value, idx) => {
      const row = document.createElement('div');
      row.className = 'row';
      const input = document.createElement('input');
      input.value = value;
      input.placeholder = 'Song title or YouTube/HTTP link';
      input.addEventListener('input', () => {
        rows[idx] = input.value;
        updateDownloadState();
      });
      const right = document.createElement('div');
      right.style.display = 'grid';
      right.style.gap = '6px';
      const status = document.createElement('div');
      status.className = 'status';
      status.id = `status-${idx}`;
      const bar = document.createElement('div');
      bar.className = 'progress';
      const barInner = document.createElement('span');
      barInner.id = `bar-${idx}`;
      bar.appendChild(barInner);
      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '6px';
      const remove = document.createElement('button');
      remove.className = 'btn secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        rows.splice(idx, 1);
        render();
        updateDownloadState();
      });
      const dl = document.createElement('button');
      dl.className = 'btn';
      dl.textContent = 'Download';
      dl.addEventListener('click', async () => {
        const query = (rows[idx] || '').trim();
        if (!query) return;
        const payload = makeTrackPayload(query);
        if (!payload.query && !payload.url) return;
        dl.disabled = true;
        dl.textContent = 'Stop';
        try {
          const start = await fetch('/api/track-jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (!start.ok) {
            let errMsg = 'Failed to start track job';
            try {
              const body = await start.json();
              if (body?.error) errMsg = body.error;
            } catch (_) { /* ignore */ }
            throw new Error(errMsg);
          }
          const { id } = await start.json();
          // Allow stopping
          let cancelled = false;
          const onStop = async () => { if (cancelled) return; cancelled = true; await fetch(`/api/track-jobs/${id}`, { method: 'DELETE' }); };
          dl.onclick = onStop;
          await new Promise((resolve, reject) => {
            const poll = async () => {
              try {
                const r = await fetch(`/api/track-jobs/${id}`);
                if (!r.ok) throw new Error('Polling failed');
                const info = await r.json();
                (info.updates || []).forEach((u) => {
                  const status = document.getElementById(`status-${idx}`);
                  const bar = document.getElementById(`bar-${idx}`);
                  if (status) status.textContent = u.phase + (u.percent != null ? ` ${u.percent}%` : '');
                  if (bar && u.percent != null) bar.style.width = `${u.percent}%`;
                });
                if (info.done) {
                  if (info.error) return reject(new Error(info.error));
                  const a = document.createElement('a');
                  a.href = `/api/track-jobs/${id}/download`;
                  a.download = '';
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  resolve();
                  return;
                }
                setTimeout(poll, 800);
              } catch (err) { reject(err); }
            };
            poll();
          });
        } catch (e) {
          console.error(e);
          statusEl.textContent = 'Download error';
        } finally {
          dl.disabled = false;
          dl.textContent = 'Download';
          dl.onclick = null;
        }
      });
      actions.appendChild(dl);
      actions.appendChild(remove);
      right.appendChild(input);
      right.appendChild(status);
      right.appendChild(bar);
      row.appendChild(right);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function updateDownloadState() {
    const usable = rows.map((r) => (r || '').trim()).filter((r) => r.length > 0);
    downloadBtn.disabled = usable.length === 0;
    return usable;
  }

  addRowBtn.addEventListener('click', () => {
    rows.push('');
    render();
    updateDownloadState();
  });

  // Clipboard paste and drag-drop support
  function setImageFromBlob(blob) {
    const dt = new DataTransfer();
    const fileObj = new File([blob], 'pasted.png', { type: blob.type || 'image/png' });
    dt.items.add(fileObj);
    file.files = dt.files;
    statusEl.textContent = 'Image ready from paste/drop';
  }

  document.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) setImageFromBlob(blob);
        break;
      }
    }
  });

  ;['dragenter','dragover'].forEach((ev) => pasteZone.addEventListener(ev, (e) => { e.preventDefault(); pasteZone.classList.add('dragover'); }));
  ;['dragleave','drop'].forEach((ev) => pasteZone.addEventListener(ev, (e) => { e.preventDefault(); pasteZone.classList.remove('dragover'); }));
  pasteZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files[0]) return;
    const blob = files[0];
    if (blob && blob.type && blob.type.startsWith('image/')) setImageFromBlob(blob);
  });

  runOcr.addEventListener('click', async () => {
    if (!file.files || !file.files[0]) { alert('Choose an image first'); return; }
    const form = new FormData();
    form.append('image', file.files[0]);
    statusEl.textContent = 'Extracting...';
    try {
      const resp = await fetch(ocrEndpoint, { method: 'POST', body: form });
      if (!resp.ok) throw new Error('OCR failed');
      const data = await resp.json();
      rows.length = 0;
      (data.tracks || []).forEach((t) => rows.push(t));
      render();
      updateDownloadState();
      statusEl.textContent = `Found ${rows.length} lines`;
    } catch (e) {
      console.error(e);
      statusEl.textContent = 'OCR error';
    }
  });

  downloadBtn.addEventListener('click', async () => {
    const usable = updateDownloadState();
    if (usable.length === 0) return;
    downloadBtn.disabled = true;
    statusEl.textContent = 'Downloading sequentially...';
    try {
      for (let i = 0; i < usable.length; i++) {
        const line = usable[i];
        const payload = makeTrackPayload(line);
        if (!payload.query && !payload.url) continue;
        const start = await fetch('/api/track-jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!start.ok) {
          let errMsg = 'Failed to start track job';
          try {
            const body = await start.json();
            if (body?.error) errMsg = body.error;
          } catch (_) { /* ignore */ }
          throw new Error(errMsg);
        }
        const { id } = await start.json();
        await new Promise((resolve, reject) => {
          const poll = async () => {
            try {
              const r = await fetch(`/api/track-jobs/${id}`);
              if (!r.ok) throw new Error('Polling failed');
              const info = await r.json();
              (info.updates || []).forEach((u) => {
                const status = document.getElementById(`status-${i}`);
                const bar = document.getElementById(`bar-${i}`);
                if (status) status.textContent = u.phase + (u.percent != null ? ` ${u.percent}%` : '');
                if (bar && u.percent != null) bar.style.width = `${u.percent}%`;
              });
              if (info.done) {
                if (info.error) return reject(new Error(info.error));
                const a = document.createElement('a');
                a.href = `/api/track-jobs/${id}/download`;
                a.download = '';
                document.body.appendChild(a);
                a.click();
                a.remove();
                resolve();
                return;
              }
              setTimeout(poll, 800);
            } catch (err) { reject(err); }
          };
          poll();
        });
      }
      statusEl.textContent = 'All downloads finished';
    } catch (e) {
      console.error(e);
      statusEl.textContent = 'Download error';
    } finally {
      downloadBtn.disabled = false;
    }
  });

  // Start with one row so users can paste a link immediately
  rows.push('');
  render();
  updateDownloadState();
})();


