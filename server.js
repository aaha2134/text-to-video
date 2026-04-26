const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Gemini / Veo 2 ───────────────────────────────────────────────────
app.post('/api/generate/gemini', async (req, res) => {
  try {
    const { apiKey: rawKey, prompt, duration = 8, aspectRatio = '16:9' } = req.body;
    const apiKey = (rawKey || '').trim();
    if (!apiKey) return res.status(400).json({ error: 'Google AI APIキーが必要です' });
    if (!prompt) return res.status(400).json({ error: 'プロンプトを入力してください' });

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning?key=${apiKey}`,
      {
        instances: [{ prompt }],
        parameters: {
          aspectRatio,
          durationSeconds: parseInt(duration),
          sampleCount: 1,
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    console.log('[Gemini/Veo2] status:', response.status, JSON.stringify(response.data).slice(0, 300));

    if (response.status >= 400) {
      const err = response.data?.error?.message || JSON.stringify(response.data);
      return res.status(500).json({ error: `Gemini API (${response.status}): ${err}` });
    }

    // operationName形式: "operations/xxxxx"
    const operationName = response.data?.name;
    if (!operationName) return res.status(500).json({ error: 'operationNameが取得できませんでした: ' + JSON.stringify(response.data).slice(0, 200) });

    res.json({ taskId: operationName, model: 'gemini' });
  } catch (err) {
    console.error('[Gemini] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status/gemini/:taskId(*)', async (req, res) => {
  try {
    const taskId = req.params.taskId; // "operations/xxxxx"
    const { apiKey: rawKey } = req.query;
    const apiKey = (rawKey || '').trim();

    const response = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/${taskId}?key=${apiKey}`,
      { timeout: 15000, validateStatus: () => true }
    );

    const data = response.data;
    console.log('[Gemini status]', response.status, JSON.stringify(data).slice(0, 300));

    if (response.status >= 400) {
      return res.json({ status: 'FAILED', error: data?.error?.message || JSON.stringify(data) });
    }

    if (data?.done) {
      // 動画URLを取得
      const videos = data?.response?.videos || data?.response?.generatedSamples || [];
      const videoUrl = videos[0]?.video?.uri || videos[0]?.videoUri || videos[0]?.uri || null;
      if (videoUrl) {
        // Google StorageのURLにAPIキーを付与
        const signedUrl = videoUrl.includes('?') ? `${videoUrl}&key=${apiKey}` : `${videoUrl}?key=${apiKey}`;
        return res.json({ status: 'SUCCEEDED', progress: 100, videoUrl: signedUrl });
      }
      return res.json({ status: 'FAILED', error: '動画URLが取得できませんでした: ' + JSON.stringify(data?.response).slice(0, 200) });
    }

    // まだ処理中
    const pct = data?.metadata?.progressPercent || 30;
    return res.json({ status: 'RUNNING', progress: pct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── fal.ai ───────────────────────────────────────────────────────────
const FAL_MODELS = {
  animatediff: 'fal-ai/fast-animatediff/text-to-video',
  hunyuan:     'fal-ai/hunyuan-video',
  wan:         'fal-ai/wan/t2v-14b',
};

app.post('/api/generate/fal', async (req, res) => {
  try {
    const { apiKey: rawKey, prompt, model = 'animatediff', duration = 4, resolution = '512x512' } = req.body;
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
      input = { prompt, num_frames: duration * 4 };
    }

    const response = await axios.post(
      `https://queue.fal.run/${modelId}`, input,
      { headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true }
    );

    if (response.status >= 400) {
      const detail = response.data?.detail || response.data?.error || response.data?.message || JSON.stringify(response.data);
      return res.status(500).json({ error: `fal.ai (${response.status}): ${detail}` });
    }
    const requestId = response.data?.request_id;
    if (!requestId) return res.status(500).json({ error: 'タスクIDが取得できませんでした' });
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

    const statusRes = await axios.get(
      `https://queue.fal.run/${modelId}/requests/${taskId}/status`,
      { headers: { Authorization: `Key ${apiKey}` }, timeout: 15000, validateStatus: () => true }
    );
    const data = statusRes.data;

    if (data?.status === 'COMPLETED') {
      const resultRes = await axios.get(
        `https://queue.fal.run/${modelId}/requests/${taskId}`,
        { headers: { Authorization: `Key ${apiKey}` }, timeout: 15000 }
      );
      const r = resultRes.data;
      const videoUrl = r?.video?.url || r?.videos?.[0]?.url || r?.video_url || null;
      return res.json({ status: 'SUCCEEDED', progress: 100, videoUrl });
    } else if (data?.status === 'IN_PROGRESS') {
      return res.json({ status: 'RUNNING', progress: data.progress_percentage || 50 });
    } else if (data?.status === 'IN_QUEUE') {
      return res.json({ status: 'PENDING', progress: 5, queuePos: data.queue_position ?? '?' });
    } else {
      return res.json({ status: 'FAILED', error: data?.error || JSON.stringify(data) });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Text-to-Video: http://localhost:${PORT}`));
