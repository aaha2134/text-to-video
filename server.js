const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── 無料: HuggingFace公開Space（認証不要）──────────────────────────
// ModelScope Text-to-Video (damo-vilab)
const FREE_SPACES = {
  modelscope: 'https://damo-vilab-modelscope-text-to-video-synthesis.hf.space',
};

app.post('/api/generate/free', async (req, res) => {
  try {
    const { prompt, spaceId = 'modelscope' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'プロンプトを入力してください' });

    const spaceUrl = FREE_SPACES[spaceId];
    const sessionHash = Math.random().toString(36).slice(2, 12);

    // Gradio queue/join
    const joinRes = await axios.post(
      `${spaceUrl}/queue/join`,
      { fn_index: 0, data: [prompt], session_hash: sessionHash },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true }
    );

    console.log('[free/join] status:', joinRes.status, JSON.stringify(joinRes.data).slice(0, 200));

    if (joinRes.status >= 400) {
      const err = joinRes.data?.detail || JSON.stringify(joinRes.data);
      return res.status(500).json({ error: `Space (${joinRes.status}): ${err}` });
    }

    res.json({ taskId: sessionHash, spaceId });
  } catch (err) {
    console.error('[free/generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// SSEストリームからイベントを1件読み取る
async function readGradioStatus(spaceUrl, sessionHash) {
  return new Promise((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) { done = true; resolve({ status: 'RUNNING', progress: 30 }); }
    }, 8000);

    axios.get(`${spaceUrl}/queue/data?session_hash=${sessionHash}`, {
      responseType: 'stream',
      timeout: 10000,
      validateStatus: () => true,
    }).then(response => {
      let buf = '';
      response.data.on('data', chunk => {
        if (done) return;
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.msg === 'process_completed') {
              clearTimeout(timeout);
              done = true;
              const out = ev.output?.data?.[0];
              const videoUrl = out?.url || (typeof out === 'string' && out.startsWith('http') ? out : null);
              const videoName = out?.name || out?.orig_name || null;
              resolve({ status: 'SUCCEEDED', progress: 100, videoUrl, videoName, spaceUrl });
            } else if (ev.msg === 'process_starts') {
              // keep going
            } else if (ev.msg === 'estimation') {
              const rank = ev.rank ?? ev.queue_size ?? '?';
              clearTimeout(timeout);
              done = true;
              resolve({ status: 'PENDING', progress: 5, queuePos: rank });
            } else if (ev.msg === 'queue_full') {
              clearTimeout(timeout);
              done = true;
              resolve({ status: 'FAILED', error: 'キューが満杯です。しばらくしてから再試行してください' });
            }
          } catch (_) {}
        }
      });
      response.data.on('error', () => {
        if (!done) { done = true; clearTimeout(timeout); resolve({ status: 'RUNNING', progress: 20 }); }
      });
      response.data.on('end', () => {
        if (!done) { done = true; clearTimeout(timeout); resolve({ status: 'RUNNING', progress: 40 }); }
      });
    }).catch(() => {
      if (!done) { done = true; clearTimeout(timeout); resolve({ status: 'RUNNING', progress: 20 }); }
    });
  });
}

app.get('/api/status/free', async (req, res) => {
  try {
    const { taskId: sessionHash, spaceId = 'modelscope' } = req.query;
    if (!sessionHash) return res.status(400).json({ error: 'session_hashが必要です' });

    const spaceUrl = FREE_SPACES[spaceId];
    const result = await readGradioStatus(spaceUrl, sessionHash);

    // SUCCEEDEDだがvideoUrlがない場合 → spaceのファイルURLを構築
    if (result.status === 'SUCCEEDED' && !result.videoUrl && result.videoName) {
      result.videoUrl = `${spaceUrl}/file=${result.videoName}`;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── fal.ai（有料・残高あれば使用可） ─────────────────────────────────
const FAL_MODELS = {
  animatediff: 'fal-ai/fast-animatediff/text-to-video',
  hunyuan:     'fal-ai/hunyuan-video',
  wan:         'fal-ai/wan/t2v-14b',
};

app.post('/api/generate/fal', async (req, res) => {
  try {
    const { apiKey: rawKey, prompt, model = 'animatediff', duration = 4, resolution = '768x512' } = req.body;
    const apiKey = (rawKey || '').trim();
    if (!apiKey) return res.status(400).json({ error: 'fal.ai APIキーが必要です' });
    if (!prompt) return res.status(400).json({ error: 'プロンプトを入力してください' });

    const modelId = FAL_MODELS[model] || FAL_MODELS.animatediff;
    let input;
    if (model === 'animatediff') {
      const [w, h] = resolution.split('x').map(Number);
      input = { prompt, num_frames: Math.min(duration * 8, 64), width: w, height: h, num_inference_steps: 8 };
    } else if (model === 'hunyuan') {
      input = { prompt, duration: String(duration), resolution };
    } else {
      input = { prompt, num_frames: parseInt(duration) * 4 };
    }

    const response = await axios.post(
      `https://queue.fal.run/${modelId}`, input,
      { headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true }
    );

    if (response.status >= 400) {
      const d = response.data?.detail || response.data?.error || response.data?.message || JSON.stringify(response.data);
      return res.status(500).json({ error: `fal.ai (${response.status}): ${d}` });
    }
    const requestId = response.data?.request_id;
    if (!requestId) return res.status(500).json({ error: 'request_idが取得できませんでした' });
    res.json({ taskId: requestId, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status/fal/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { apiKey: rawKey, model = 'animatediff' } = req.query;
    const apiKey = (rawKey || '').trim();
    const modelId = FAL_MODELS[model] || FAL_MODELS.animatediff;

    const s = await axios.get(
      `https://queue.fal.run/${modelId}/requests/${taskId}/status`,
      { headers: { Authorization: `Key ${apiKey}` }, timeout: 15000, validateStatus: () => true }
    );
    const d = s.data;

    if (d?.status === 'COMPLETED') {
      const r = await axios.get(`https://queue.fal.run/${modelId}/requests/${taskId}`, { headers: { Authorization: `Key ${apiKey}` }, timeout: 15000 });
      const videoUrl = r.data?.video?.url || r.data?.videos?.[0]?.url || null;
      return res.json({ status: 'SUCCEEDED', progress: 100, videoUrl });
    } else if (d?.status === 'IN_PROGRESS') {
      return res.json({ status: 'RUNNING', progress: d.progress_percentage || 50 });
    } else if (d?.status === 'IN_QUEUE') {
      return res.json({ status: 'PENDING', progress: 5, queuePos: d.queue_position ?? '?' });
    } else {
      return res.json({ status: 'FAILED', error: d?.error || JSON.stringify(d) });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Text-to-Video: http://localhost:${PORT}`));
