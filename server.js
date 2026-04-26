const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const FAL_MODELS = {
  animatediff: 'fal-ai/fast-animatediff/text-to-video',
  hunyuan:     'fal-ai/hunyuan-video',
  wan:         'fal-ai/wan/t2v-14b',
};

// 生成リクエスト
app.post('/api/generate', async (req, res) => {
  try {
    const { apiKey: rawKey, prompt, model = 'animatediff', duration = 4, resolution = '512x512' } = req.body;
    const apiKey = (rawKey || '').trim();
    if (!apiKey) return res.status(400).json({ error: 'fal.ai APIキーが必要です' });
    if (!prompt) return res.status(400).json({ error: 'プロンプトを入力してください' });

    const modelId = FAL_MODELS[model] || FAL_MODELS.animatediff;

    // モデル別の入力パラメータ
    let input;
    if (model === 'animatediff') {
      const [w, h] = resolution.split('x').map(Number);
      input = { prompt, num_frames: Math.min(duration * 8, 64), width: w, height: h, num_inference_steps: 8 };
    } else if (model === 'hunyuan') {
      input = { prompt, duration: String(duration), resolution };
    } else if (model === 'wan') {
      input = { prompt, num_frames: duration * 4 };
    }

    const response = await axios.post(
      `https://queue.fal.run/${modelId}`,
      input,
      {
        headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    console.log(`[${model}] status:`, response.status, JSON.stringify(response.data).slice(0, 200));

    if (response.status >= 400) {
      const detail = response.data?.detail || response.data?.error || response.data?.message || JSON.stringify(response.data);
      return res.status(500).json({ error: `fal.ai (${response.status}): ${detail}` });
    }

    const requestId = response.data?.request_id;
    if (!requestId) return res.status(500).json({ error: 'タスクIDが取得できませんでした: ' + JSON.stringify(response.data).slice(0, 100) });

    res.json({ taskId: requestId, model });
  } catch (err) {
    console.error('generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ステータス確認
app.get('/api/status/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { apiKey: rawKey, model = 'animatediff' } = req.query;
    const apiKey = (rawKey || '').trim();
    if (!apiKey) return res.status(400).json({ error: 'APIキーが必要です' });

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
